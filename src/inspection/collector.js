'use strict';
/**
 * collector.js —— 采集子进程池（阶段 5）
 *
 * 管理 worker.js 的生命周期：启动、下发任务、超时 kill、崩溃重启、优雅退出。
 *
 * 三条保命设计：
 *   1) 超时守卫：一轮的最坏耗时可以估算（批次 × 单台超时），超过预算 + 余量就杀掉重启。
 *      没有它，一台失联设备上挂着的长连接会让整轮永远不返回，大屏停更但毫无报错。
 *   2) 自愈：子进程 crash / exit 后立即重建。业务侧完全不受影响，
 *      最坏表现是这一轮巡检失败、下一轮恢复。
 *   3) 一键回退：INSPECTION_NO_WORKER=1 时不下发子进程，改在主进程内直跑
 *      （即阶段 2 的行为）。出现说不清的子进程问题时，这是最短止血路径。
 */
const path = require('path');
const { fork } = require('child_process');

const WORKER = path.join(__dirname, 'worker.js');

// 连续崩溃超过这个次数就放弃自愈，改为常驻失败态，避免「反复 fork / 反复崩」刷爆进程表
const RESTART_LIMIT = 5;
// 崩溃计数在多长时间内累计（毫秒）。超过该时间没再崩就清零，避免历史故障永久拖累
const RESTART_WINDOW_MS = 10 * 60 * 1000;
// 任务预算的余量系数：估算值之上留的缓冲，用于 cover 进程启动与数据回传开销
const BUDGET_SLACK = 1.5;
const MIN_BUDGET_MS = 90 * 1000;

const state = {
  enabled: String(process.env.INSPECTION_NO_WORKER || '').toLowerCase() !== '1',
  child: null,
  ready: false,
  busy: false,
  roundSeq: 0,          // 下发轮次序号，用于丢弃属于被 kill 的那一轮的迟到回包
  pending: null,        // { resolve, reject, roundId, timer }
  restarts: [],         // 崩溃时间戳，用于窗口内限流
  lastError: null,
  lastRestartAt: null,
  restartCount: 0,
  stopped: false
};

/** 估算一轮的耗时预算：批次数 × 单台超时，再留余量 */
function budgetMs(opt) {
  const n = (opt.servers || []).length;
  const c = Math.max(1, opt.concurrency || 5);
  const t = Math.max(1000, opt.timeoutMs || 30000);
  const batches = Math.ceil(n / c);
  return Math.max(MIN_BUDGET_MS, Math.round(batches * t * BUDGET_SLACK));
}

function noteCrash() {
  const now = Date.now();
  state.restarts = state.restarts.filter((ts) => now - ts < RESTART_WINDOW_MS);
  state.restarts.push(now);
  state.lastRestartAt = new Date().toISOString();
  state.restartCount++;
}

function tooManyCrashes() {
  const now = Date.now();
  state.restarts = state.restarts.filter((ts) => now - ts < RESTART_WINDOW_MS);
  return state.restarts.length > RESTART_LIMIT;
}

/** 杀掉当前子进程（若存在） */
function killChild(reason) {
  const c = state.child;
  if (!c) return;
  state.child = null;
  state.ready = false;
  try { c.removeAllListeners(); } catch (e) { /* 忽略 */ }
  try {
    if (!c.killed) c.kill('SIGKILL'); // Windows 下无 SIGTERM 语义，直接强杀
  } catch (e) { /* 已退出 */ }
  if (reason) console.error('>>> [采集子进程] 已终止：' + reason);
}

/** 立刻拒绝挂起的那一轮，避免前端请求永久悬挂 */
function rejectPending(err) {
  const p = state.pending;
  if (!p) return;
  state.pending = null;
  state.busy = false;
  if (p.timer) clearTimeout(p.timer);
  p.reject(err instanceof Error ? err : new Error(String(err)));
}

function spawn() {
  if (!state.enabled || state.stopped) return null;
  if (state.child) return state.child;

  const child = fork(WORKER, [], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true
  });
  state.child = child;
  state.ready = false;

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      state.ready = true;
      console.log('>>> [采集子进程] 就绪（pid ' + msg.pid + '，' + msg.node + '）');
      return;
    }
    if (msg.type === 'progress') return; // 暂不消费，保留协议位
    if (msg.type === 'log') {
      // 报告生成过程的逐行日志，实时转给调用方（Web 端据此显示进度）
      const lp = state.pending;
      if (lp && typeof lp.onLog === 'function') {
        try { lp.onLog(String(msg.text || '')); } catch (e) { /* 回调用异常不影响任务 */ }
      }
      return;
    }

    const p = state.pending;
    if (!p) return;                       // 迟到回包（属于已被 kill 的轮次），丢弃
    if (msg.roundId !== p.roundId) return;

    state.pending = null;
    state.busy = false;
    if (p.timer) clearTimeout(p.timer);

    if (msg.type === 'done') {
      state.lastError = null;
      p.resolve(msg.results || []);
    } else if (msg.type === 'weekly-done') {
      state.lastError = null;
      p.resolve(msg.result || { ok: false, error: '子进程未返回结果' });
    } else if (msg.type === 'error') {
      state.lastError = msg.message;
      console.error('>>> [采集子进程] 采集失败：' + msg.message
        + (msg.stack ? '\n' + msg.stack : ''));
      p.reject(new Error(msg.message));
    }
  });

  child.on('error', (err) => {
    state.lastError = String((err && err.message) || err);
    console.error('>>> [采集子进程] 启动失败：' + state.lastError);
    rejectPending(state.lastError);
    killChild();
  });

  child.on('exit', (code, signal) => {
    const wasOurs = state.child === child;
    state.child = null;
    state.ready = false;
    if (state.stopped) return;

    if (code !== 0) {
      noteCrash();
      console.error('>>> [采集子进程] 意外退出（code=' + code + ' signal=' + (signal || '-')
        + '）—— 10 分钟内第 ' + state.restarts.length + ' 次');
    }
    // 无论如何先把挂起的轮次失败掉，避免请求悬挂
    rejectPending('采集子进程意外退出（code=' + code + '）');

    if (wasOurs && state.enabled && !state.stopped) {
      if (tooManyCrashes()) {
        state.lastError = '采集子进程在短时间内反复崩溃（' + RESTART_LIMIT
          + ' 次以上），已停止自愈。请查看本服务的错误日志定位原因。';
        console.error('>>> [严重] ' + state.lastError);
        return;
      }
      setTimeout(() => { if (!state.stopped && !state.child) spawn(); }, 2000);
    }
  });

  return child;
}

/** 是否可用（外部据此决定走子进程还是主进程直跑） */
function available() {
  return state.enabled && !state.stopped && ready();
}
function ready() {
  return !!(state.child && state.ready);
}

/**
 * 跑一轮采集。
 * @param {{servers,thresholds,concurrency,timeoutMs}} opt
 * @returns {Promise<Array>} 与 servers 顺序一致的结果数组
 */
async function run(opt) {
  return dispatch(opt, (child, roundId) => ({
    mtype: 'run',
    payload: {
      type: 'run', roundId, servers: opt.servers, thresholds: opt.thresholds,
      concurrency: opt.concurrency, timeoutMs: opt.timeoutMs
    }
  }));
}

/**
 * 生成巡检报告（周报 / 手工导出）。
 * @param {{servers,global,outDir,source}} opt
 * @param {Function} [onLog] 逐行接收子进程日志
 * @returns {Promise<{ok,file,stat,seconds,error}>}
 */
async function generateReport(opt, onLog) {
  // 预算要按周报自己的并发/超时参数算 —— 这些值在 global 里，不在顶层
  const g = opt.global || {};
  return dispatch(
    { servers: opt.servers, concurrency: g.concurrency, timeoutMs: g.timeout_ms },
    (child, roundId) => ({
      mtype: 'weekly',
      payload: {
        type: 'weekly', roundId, servers: opt.servers,
        global: g, outDir: opt.outDir || '', source: opt.source || 'web'
      }
    }),
    onLog
  );
}

/** 下发任务的公共流程：取进程 → 等就绪 → 预算计时 → 发消息 → 等回包 */
async function dispatch(opt, build, onLog) {
  if (!state.enabled) throw new Error('已禁用采集子进程（INSPECTION_NO_WORKER=1）');
  if (state.stopped) throw new Error('采集子进程池已停止');
  if (tooManyCrashes()) throw new Error(state.lastError || '采集子进程反复崩溃，已停止自愈');

  let child = state.child;
  if (!child) child = spawn();
  if (!child) throw new Error('采集子进程未能启动');
  if (!state.ready) {
    // 首次下发前等子进程 ready，否则会因为 IPC 未建立而丢消息
    await waitReady(10000);
  }
  if (state.busy) throw new Error('采集子进程正忙（上一轮尚未返回）');

  const roundId = ++state.roundSeq;
  // 报告比常规巡检多一步渲染与写盘，预算在采集基础上再放宽
  const budget = budgetMs(opt);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const msg = '子进程任务超时（超过预算 ' + Math.round(budget / 1000)
        + ' 秒），已终止并重建子进程';
      console.error('>>> [采集子进程] ' + msg);
      state.lastError = msg;
      rejectPending(msg);
      killChild(msg);
      setTimeout(() => { if (!state.stopped) spawn(); }, 1000);
    }, budget);
    // 计时器不能让进程等待它退出
    if (timer.unref) timer.unref();

    state.pending = { resolve, reject, roundId, timer, onLog: onLog };
    state.busy = true;

    try {
      child.send(build(child, roundId).payload);
    } catch (e) {
      rejectPending(e);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function waitReady(ms) {
  return new Promise((resolve) => {
    if (state.ready) return resolve(true);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (state.ready || Date.now() - t0 > ms) {
        clearInterval(iv);
        resolve(state.ready);
      }
    }, 100);
    if (iv.unref) iv.unref();
  });
}

/** 服务优雅退出时调用 */
function shutdown() {
  state.stopped = true;
  rejectPending('服务正在关闭');
  killChild();
  console.log('>>> [采集子进程] 已停止');
}

/** 预热：启动时 fork 出来备好，避免第一轮巡检时才临时拉起 */
function warmup() {
  if (!state.enabled) {
    console.log('>>> [采集子进程] 已禁用（INSPECTION_NO_WORKER=1），采集将在主进程内进行');
    return { enabled: false };
  }
  spawn();
  return { enabled: true, pid: state.child ? state.child.pid : null };
}

/** 供 /health 与启动横幅使用 */
function health() {
  return {
    enabled: state.enabled,
    alive: ready(),
    busy: state.busy,
    pid: state.child ? state.child.pid : null,
    restartCount: state.restartCount,
    lastRestartAt: state.lastRestartAt,
    lastError: state.lastError,
    // 连续崩溃到什么程度算不可用了
    degraded: tooManyCrashes()
  };
}

module.exports = {
  warmup, run, generateReport, available, ready, shutdown, health, budgetMs,
  untilReady: waitReady, state
};
