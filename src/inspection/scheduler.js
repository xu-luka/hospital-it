'use strict';
/**
 * scheduler.js —— 巡检调度器（由原 monitor.js 拆分而来）
 *
 * 与原 monitor.js 的区别：
 *   1) 不再自己开 HTTP 服务 —— 端口、路由、TLS 全部归 Express 主壳（server.js）
 *   2) 不再管 PID 文件与「杀掉旧进程」—— 单进程由独占端口天然保证唯一
 *   3) 不再用 setInterval —— 改递归 setTimeout，避免单轮耗时超过间隔时任务堆叠
 *   4) 不再 fs.watch 配置文件 —— 阶段 3 起数据源为数据库，改为显式 applyConfig 触发
 *      加 config_version 轮询兜底
 *
 * 数据源：通过 setDeviceSource() 注入，返回一个 { servers, global } 形状的对象。
 *   阶段 2 注入 config.json 读取器；阶段 3 注入设备台账 DB 读取器。
 *   这样调度逻辑与数据来源解耦，两个阶段共用同一份调度器代码。
 */
const fs = require('fs');
const path = require('path');
const inspect = require('./inspect');
const paths = require('./paths');
const store = require('./report-store');
const { nowHuman } = require('./lib/common');
const collector = require('./collector');
const history = require('./history');
const config = require('../../config');

const MIN_INTERVAL = 30;

const state = {
  interval: 60,
  lastUpdate: null,
  running: false,        // 是否正在跑某一轮（防重入）
  roundNo: 0,
  results: [],
  started: false,        // 调度是否已启动
  // 配置（支持热重载，故提升为模块级状态）
  cfg: null,
  thresholds: null,
  concurrency: 5,
  timeoutMs: 30000,
  reportsDir: paths.reportsDir(),
  title: '机房设备巡检 · 监控大屏',
  // 当前数据源：'json' = 配置文件，'db' = 设备台账（阶段 3 起）
  sourceMode: 'json',
  // 阶段 5：采集子进程健康状态（主进程据此暂停自动调度并在大屏顶栏告警）
  workerHealthy: true,
  lastError: null,
  keyError: null,
  // 数据源与副作用挂钩
  deviceSource: null,
  onRoundDone: null
};

/** 注入设备数据源：async () => { servers: [...], global: {...} } */
function setDeviceSource(fn) { state.deviceSource = fn; }

/** 注入每轮完成后的回调：({ roundNo, results, summary, durationMs }) => void */
function setOnRoundDone(fn) { state.onRoundDone = fn; }

/**
 * 子进程健康视图。
 * workerHealthy 保持单一的布尔语义（"能不能用"），细节放 worker 里透出，
 * 大屏据此显示降级提示，health 接口据此定位问题。
 */
function workerHealth() {
  const h = collector.health();
  state.workerHealthy = h.enabled ? (h.alive && !h.degraded) : true;
  return Object.assign({ runs: workerRuns, fallbacks: workerFallbacks }, h);
}

/** 历史库概况（供 health 观察入库是否正常） */
function historyStats() {
  try {
    const s = history.stats();
    return { ready: s.ready, rounds: s.rounds, snapshots: s.snapshots, lastAt: s.lastAt };
  } catch (e) { return { ready: false, error: String((e && e.message) || e) }; }
}

/* ---------------- 状态查询（供 API 使用） ---------------- */

function summarize(results) {
  const s = { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  for (const r of results) {
    if (!r.ok) s.error++;
    else if (s[r.status] !== undefined) s[r.status]++;
  }
  return s;
}

function buildStatus() {
  return {
    updatedAt: state.lastUpdate,
    interval: state.interval,
    running: state.running,
    round: state.roundNo,
    summary: summarize(state.results),
    devices: state.results.map((r) => ({
      id: r.deviceId || null,
      name: r.name,
      host: r.host,
      os: r.os,
      osLabel: r.osLabel,
      connectLabel: r.connectLabel,
      ok: r.ok,
      status: r.ok ? r.status : 'error',
      error: r.error || null,
      reasons: r.reasons || [],
      note: (r.ok && r.note) ? r.note : '',
      cpu: r.metrics ? r.metrics.cpu_percent : null,
      mem: r.metrics ? r.metrics.mem_percent : null,
      hostname: r.metrics ? r.metrics.hostname : (r.hw ? r.hw.model : null)
    })),
    // 阶段 5 新增字段，旧消费者忽略即可（向后兼容）
    workerHealthy: state.workerHealthy,
    lastError: state.lastError,
    reportsDir: state.reportsDir,
    keyError: state.keyError,
    sourceMode: state.sourceMode,
    worker: workerHealth()
  };
}

function health() {
  return {
    started: state.started,
    running: state.running,
    round: state.roundNo,
    lastUpdate: state.lastUpdate,
    interval: state.interval,
    devices: (state.cfg && state.cfg.servers ? state.cfg.servers.length : 0),
    workerHealthy: state.workerHealthy,
    lastError: state.lastError,
    keyError: state.keyError,
    sourceMode: state.sourceMode,
    worker: workerHealth(),
    history: historyStats()
  };
}

function isRunning() { return state.running; }

/* ---------------- 配置装载 ---------------- */

/**
 * 从数据源读取并校验配置。
 * 返回 { ok, cfg, message, devices, keyError }
 */
async function loadAndValidate() {
  if (!state.deviceSource) {
    return { ok: false, message: '未配置设备数据源（scheduler.setDeviceSource）' };
  }
  let cfg;
  try {
    cfg = await state.deviceSource();
  } catch (e) {
    return { ok: false, message: '设备数据源读取失败：' + ((e && e.message) || e) };
  }
  const errs = [];
  const servers = cfg.servers || [];
  servers.forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
  if (errs.length) {
    return {
      ok: false,
      message: '配置校验未通过：\n  - ' + errs.slice(0, 8).join('\n  - ')
        + (errs.length > 8 ? '\n  - ...（共 ' + errs.length + ' 项）' : '')
    };
  }
  state.sourceMode = cfg.__source === 'db' ? 'db' : 'json';
  return { ok: true, cfg: cfg, devices: servers.length };
}

/**
 * 剔除已被停用/删除的设备在上一轮里的残留结果。
 *
 * 为什么必须做：大屏读的是 state.results，而不是 state.cfg。
 * 若管理员停用了某台设备却不去重跑一轮，那张卡片会继续留在屏上，
 * 最长要等一个采集间隔（默认 60 秒，实际一轮可能几分钟）才消失 ——
 * 运维看着大屏以为它还在被巡检，实际上早就不采了。
 *
 * 文件模式下结果没有 deviceId，无法判定归属，原样保留（该模式本来也不支持停用）。
 */
function pruneResults(cfg) {
  if (!Array.isArray(state.results) || !state.results.length) return;
  const ids = new Set();
  let haveIds = false;
  for (const s of cfg.servers || []) {
    const id = Number(s && s._device_id) || 0;
    if (id) { ids.add(id); haveIds = true; }
  }
  if (!haveIds) return;
  const before = state.results.length;
  state.results = state.results.filter((r) => {
    const id = Number(r && r.deviceId) || 0;
    return id === 0 || ids.has(id);
  });
  if (state.results.length !== before) {
    console.log('>>> 已剔除 ' + (before - state.results.length) + " 台不再纳管的设备的残留结果");
  }
}

/** 应用配置到运行时状态 */
function applyConfig(cfg) {
  const globalCfg = cfg.global || {};
  state.cfg = cfg;
  pruneResults(cfg);
  state.thresholds = Object.assign({}, inspect.DEFAULT_THRESHOLDS, globalCfg.thresholds);
  state.concurrency = Math.max(1, globalCfg.concurrency || 5);
  state.timeoutMs = Math.max(10000, globalCfg.timeout_ms || 30000);
  // 巡检间隔：DB 里改了 interval_sec 必须落到 state.interval，否则永远按启动时的
  // 旧值跑（原 bug——保存设置后间隔不生效）。DB 值为准，env/默认仅作兜底。
  const iv = Number(globalCfg.interval_sec);
  if (Number.isFinite(iv) && iv >= MIN_INTERVAL) {
    state.interval = iv;
  } else if (globalCfg.interval_sec !== undefined && globalCfg.interval_sec !== null) {
    console.warn('>>> [配置] interval_sec 非法（' + globalCfg.interval_sec + '），保留当前 ' + state.interval + ' 秒');
  }
  // 解析报告目录时以部署根下的 data/reports 为基准，
  // 保证与 inspect.writeReport() 的回退目标一致（不一致会出现「报告写了但列表没有」）
  state.reportsDir = store.resolveReportDir(globalCfg.report_dir || '', paths.root(), paths.reportsDir());
  const applied = {
    devices: (cfg.servers || []).length,
    concurrency: state.concurrency,
    timeoutMs: state.timeoutMs,
    interval: state.interval,
    reportsDir: state.reportsDir
  };
  // 间隔热更新：调度已运行且当前正排着下一轮时，立即按新间隔重排，
  // 避免再傻等一个旧间隔才生效。startup 首装时 state.started 尚未置 true、
  // timer 也为 null，不会抢跑，不会与 start() 后续的 scheduleNext 形成双定时器。
  if (state.started && timer && Number.isFinite(state.interval)) {
    scheduleNext();
  }
  return applied;
}

/**
 * 重载配置。失败时保留旧配置，不影响正在运行的巡检 —— 这是原设计就有的行为，必须保持。
 */
async function reloadConfig() {
  const r = await loadAndValidate();
  if (!r.ok) {
    console.error('>>> 配置重载失败，继续使用当前配置：' + r.message);
    return { ok: false, message: r.message };
  }
  const info = applyConfig(r.cfg);
  console.log('>>> 配置已重载：' + info.devices + ' 台设备，并发 ' + info.concurrency
    + '，超时 ' + Math.round(info.timeoutMs / 1000) + ' 秒');
  return { ok: true, message: '配置已重载', devices: info.devices, reportsDir: info.reportsDir };
}

/* ---------------- 巡检轮次 ---------------- */

/**
 * 跑一轮完整巡检。
 * 阶段 2：主进程内直接跑（沿用原 runWithConcurrency）
 * 阶段 5：改为下发到 fork 的采集子进程（见 collector-pool.js）
 */
let runImpl = null;
/** 注入执行实现：async ({ servers, thresholds, concurrency, timeoutMs }) => results */
function setRunner(fn) { runImpl = fn; }

async function defaultRunner(opt) {
  const tasks = opt.servers.map((s) => () =>
    inspect.inspectOne(s, opt.timeoutMs).then((r) => inspect.evaluateResult(r, opt.thresholds)));
  return inspect.runWithConcurrency(tasks, opt.concurrency, () => { });
}

/**
 * 子进程优先、失败降级。
 *
 * 降级而非直接报错：隔离是为了保护 Web 服务，但若子进程因为某种环境问题不可用，
 * 让巡检彻底停摆显然更糟 —— 运维会失去监控。因此退回到主进程直跑（阶段 2 的行为），
 * 并在日志里明确警告。这样最坏情况是"采集慢了点"，而不是"没人看设备了"。
 */
async function runnerOrDefault(opt) {
  try {
    // fork 是异步的：启动首轮往往跑在子进程 ready 之前。
    // 若不等待就直接降级，那第一轮（设备最多、最容易碰到失联机的一轮）会落在主进程里，
    // 恰好违背了隔离的初衷 —— 因此这里给子进程一点就绪时间。
    if (collector.state.enabled && !collector.available()) {
      await collector.untilReady(15000);
    }
    if (collector.available()) {
      workerRuns++;
      return await collector.run(opt);
    }
    if (collector.state.enabled) {
      const h = collector.health();
      console.warn('>>> [巡检] 采集子进程不可用，本轮降级为主进程直跑：'
        + (h.lastError || (h.degraded ? '短时间内反复崩溃，已停止自愈' : '尚未就绪')));
    }
  } catch (e) {
    workerFallbacks++;
    console.error('>>> [巡检] 采集子进程执行失败，降级为主进程直跑：' + ((e && e.message) || e));
  }
  return defaultRunner(opt);
}
let workerRuns = 0;
let workerFallbacks = 0;

async function round(source) {
  if (state.running) return { skipped: true, reason: '上一轮尚未结束' };
  state.running = true;
  const t0 = Date.now();
  const startedAt = nowHuman();
  try {
    const servers = (state.cfg && state.cfg.servers) || [];
    const thresholds = state.thresholds;
    const runner = runImpl || runnerOrDefault;
    const results = await runner({
      servers: servers, thresholds: thresholds,
      concurrency: state.concurrency, timeoutMs: state.timeoutMs
    }) || [];
    // 把台账 ID 贴回结果：结果对象里带着设备名和地址，但没有数据库主键，
    // 台账页要显示"上次巡检状态"就必须靠它把两者对上。
    // runWithConcurrency 保证结果顺序与 tasks 顺序一致，按下标回填是安全的。
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (!r) continue;
      const sid = servers[i] && Number(servers[i]._device_id);
      if (sid) r.deviceId = sid;
    }
    state.results = results;
    state.roundNo++;
    state.lastUpdate = nowHuman();
    state.lastError = null;
    const s = summarize(state.results);
    const durationMs = Date.now() - t0;
    console.log('>>> 第 ' + state.roundNo + ' 轮完成（' + source + '，耗时 '
      + (durationMs / 1000).toFixed(1) + ' 秒）：正常 ' + s.normal
      + ' · 警告 ' + s.warning + ' · 严重 ' + s.critical + ' · 失败 ' + s.error);
    // 快照入库：趋势与可用率的数据来源。失败不影响本轮结果早已返回给调用方。
    try {
      const hr = history.saveRound({
        roundNo: state.roundNo, source: source, startedAt: startedAt,
        results: state.results, summary: s, durationMs: durationMs
      });
      if (hr.ok && state.roundNo % 10 === 1) {
        const cl = history.cleanup(config.INSPECT_HISTORY_DAYS);
        if (cl.ok && cl.deleted) console.log('>>> 已清理 ' + cl.deleted + ' 条超过 '
          + cl.days + ' 天的巡检历史快照');
      }
    } catch (e) {
      console.error('>>> 巡检历史写入异常（忽略）：' + ((e && e.message) || e));
    }
    if (typeof state.onRoundDone === 'function') {
      try {
        await state.onRoundDone({ source: source, roundNo: state.roundNo, results: state.results, summary: s, durationMs: durationMs });
      } catch (e) {
        console.error('>>> 轮次后置处理失败（不影响本轮结果）：' + ((e && e.message) || e));
      }
    }
    return { ok: true, roundNo: state.roundNo, summary: s, durationMs: durationMs };
  } catch (e) {
    state.lastError = String((e && e.message) || e);
    console.error('>>> 本轮巡检异常（' + source + '）：' + state.lastError);
    return { ok: false, error: state.lastError };
  } finally {
    state.running = false;
  }
}

/* ---------------- 调度生命周期 ---------------- */

let timer = null;
let stopped = false;

/** 递归 setTimeout：本轮超时自动顺延下一轮，避免任务堆叠 */
function scheduleNext() {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      await round('auto');
    } catch (e) {
      console.error('>>> 定时巡检异常：' + ((e && e.message) || e));
    }
    scheduleNext();
  }, Math.max(MIN_INTERVAL, state.interval) * 1000);
  // 允许服务在等待期间正常退出
  if (timer.unref) timer.unref();
}

/**
 * 启动调度器。由 server.js 在 app.listen 回调里调用。
 * 会先装载配置并立即跑一轮（第一轮数据用于填充大屏，否则打开页面是空的）。
 */
async function start(opt) {
  const o = opt || {};
  stopped = false;
  state.interval = Math.max(MIN_INTERVAL, o.interval || 60);

  const loaded = await loadAndValidate();
  if (!loaded.ok) {
    // 装载失败不阻塞 Web 启动：业务模块（合同/问题）必须仍然可用，
    // 大屏显示错误原因即可。这是合并后比原系统更健壮的地方。
    state.lastError = loaded.message;
    console.error('>>> 巡检配置装载失败，巡检暂不可用：' + loaded.message);
    return { ok: false, message: loaded.message };
  }
  applyConfig(loaded.cfg);
  await secretWarmup();
  const wk = collector.warmup();
  if (wk.enabled) console.log('>>> 采集隔离：启用子进程模式（pid ' + wk.pid + '）');

  state.started = true;
  const info = { devices: loaded.devices, interval: state.interval, concurrency: state.concurrency };
  console.log('>>> 巡检调度已启动：' + loaded.devices + ' 台设备，每 ' + state.interval
    + ' 秒一轮，并发 ' + state.concurrency + '，报告目录 ' + state.reportsDir);
  if (!fs.existsSync(state.reportsDir)) {
    try { fs.mkdirSync(state.reportsDir, { recursive: true }); } catch (e) { /* 首轮写报告时会再尝试 */ }
  }

  if (history.init()) console.log('>>> 巡检历史库就绪：' + config.INSPECT_DB_FILE
    + '（保留 ' + config.INSPECT_HISTORY_DAYS + ' 天）');

  await round('startup');
  if (o.auto !== false) scheduleNext();
  return { ok: true, ...info };
}

/** 停止调度（优雅退出时调用） */
function stop() {
  stopped = true;
  state.started = false;
  collector.shutdown();
  if (timer) { clearTimeout(timer); timer = null; }
  console.log('>>> 巡检调度已停止');
}

/**
 * 主密钥预热：进程启动时取一次并缓存，避免第一轮巡检时才失败。
 * 失败不中断启动 —— 台账里明文口令的设备仍可巡检，加密的会明确报错。
 */
async function secretWarmup() {
  try {
    const secret = require('./lib/secret');
    const r = await secret.loadMasterKeyAsync();
    if (r && r.ok) {
      state.keyError = null;
      console.log('>>> 主密钥就绪（指纹 ' + (secret.fingerprint() || '未知') + '）');
    } else {
      state.keyError = (r && r.error) || '未知原因';
      console.error('>>> [严重] 主密钥不可用，加密口令的设备将无法巡检：' + state.keyError);
    }
  } catch (e) {
    state.keyError = String((e && e.message) || e);
    console.error('>>> [严重] 主密钥预热异常：' + state.keyError);
  }
}

module.exports = {
  start, stop, round, runOnce: round,
  buildStatus, summarize, reloadConfig, loadAndValidate, applyConfig,
  health, isRunning,
  setDeviceSource, setOnRoundDone, setRunner,
  collector, history, workerHealth, historyStats,
  state
};
