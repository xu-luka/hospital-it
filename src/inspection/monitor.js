'use strict';
/**
 * 实时监控模式：按设定间隔定时轮询所有设备，起本地/内网 Web 服务供多人查看
 *
 * 用法：
 *   node monitor.js [--interval 60] [--port 8765] [--bind 127.0.0.1]
 *                   [--auth] [--https --cert <path> --key <path>]
 *                   [--no-kill-existing] [--no-watch] [--config <file>]
 *
 * 部署形态：
 *   本机自用   ：node monitor.js                        （仅 127.0.0.1，无需账号）
 *   多人访问   ：node monitor.js --bind 0.0.0.0 --auth   （必须先建账号，见下）
 *
 * 安全闸门：--bind 非本机地址时若未开 --auth，程序拒绝启动。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const inspect = require('./inspect');
const { renderBigScreen } = require('./lib/dashboard');
const { nowHuman } = require('./lib/common');
const auth = require('./web/auth');
const webServer = require('./web/server');
const { createHandler } = webServer;
const reports = require('./web/reports');

const DEFAULT_PORT = 8765;
const MIN_INTERVAL = 30;
const CONFIG_WATCH_DEBOUNCE_MS = 800;

function parseArgs(argv) {
  const args = {
    config: null, interval: null, port: DEFAULT_PORT,
    bind: '127.0.0.1', auth: false, https: false, cert: null, key: null,
    killExisting: true, watch: true, title: null, hsts: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--interval' && argv[i + 1]) args.interval = parseInt(argv[++i], 10);
    else if (a === '--port' && argv[i + 1]) args.port = parseInt(argv[++i], 10);
    else if (a === '--config' && argv[i + 1]) args.config = argv[++i];
    else if (a === '--bind' && argv[i + 1]) args.bind = String(argv[++i]).trim();
    else if (a === '--auth') args.auth = true;
    else if (a === '--https' || a === '--tls') args.https = true;
    else if (a === '--cert' && argv[i + 1]) args.cert = argv[++i];
    else if (a === '--key' && argv[i + 1]) args.key = argv[++i];
    else if (a === '--no-kill-existing') args.killExisting = false;
    else if (a === '--no-watch') args.watch = false;
    else if (a === '--hsts') args.hsts = true;
    else if (a === '--title' && argv[i + 1]) args.title = argv[++i];
  }
  return args;
}

function readPidFile(dir) {
  try { return parseInt(fs.readFileSync(path.join(dir, '.monitor.pid'), 'utf8'), 10) || null; } catch (e) { return null; }
}
function killPid(pid) {
  try { process.kill(pid); return true; } catch (e) { return false; }
}
function isRunning(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return false; }
}

/** 是否为本机回环地址（用于安全闸门判断） */
function isLoopback(bind) {
  const b = String(bind || '').toLowerCase();
  return b === '127.0.0.1' || b === 'localhost' || b === '::1' || b === '';
}

const state = {
  port: DEFAULT_PORT,
  bind: '127.0.0.1',
  interval: 60,
  lastUpdate: null,
  running: false,
  roundNo: 0,
  results: [],
  authEnabled: false,
  tlsEnabled: false,
  // 配置（支持热重载，故提升为模块级状态）
  cfg: null,
  cfgFile: null,
  thresholds: null,
  concurrency: 5,
  timeoutMs: 30000,
  reportsDir: path.join(__dirname, 'reports'),
  title: '机房设备巡检 · 监控大屏'
};

function buildStatus() {
  return {
    updatedAt: state.lastUpdate,
    interval: state.interval,
    running: state.running,
    round: state.roundNo,
    summary: summarize(state.results),
    devices: state.results.map((r) => ({
      name: r.name, host: r.host, os: r.os, osLabel: r.osLabel, connectLabel: r.connectLabel,
      ok: r.ok, status: r.ok ? r.status : 'error',
      error: r.error || null,
      reasons: r.reasons || [],
      note: (r.ok && r.note) ? r.note : '',
      cpu: r.metrics ? r.metrics.cpu_percent : null,
      mem: r.metrics ? r.metrics.mem_percent : null,
      hostname: r.metrics ? r.metrics.hostname : (r.hw ? r.hw.model : null)
    }))
  };
}

function summarize(results) {
  const s = { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  for (const r of results) {
    if (!r.ok) s.error++;
    else if (s[r.status] !== undefined) s[r.status]++;
  }
  return s;
}

/** 读取并校验配置，返回 { ok, cfg, message, devices, decrypted, plaintext, keyError } */
async function loadAndValidate(cfgFile) {
  let cfg, dec;
  try {
    dec = await inspect.loadConfigDecrypted(cfgFile, (m) => console.log(m));
    cfg = dec.cfg;
  } catch (e) {
    return { ok: false, message: '配置文件读取/解析失败：' + ((e && e.message) || e) };
  }
  const errs = [];
  (cfg.servers || []).forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
  if (errs.length) {
    return { ok: false, message: '配置校验未通过：\n  - ' + errs.slice(0, 8).join('\n  - ') + (errs.length > 8 ? '\n  - ...（共 ' + errs.length + ' 项）' : '') };
  }
  return {
    ok: true, cfg: cfg, devices: (cfg.servers || []).length,
    decrypted: dec.decrypted, plaintext: dec.plaintext, keyError: dec.keyError, secretErrors: dec.errors
  };
}

/** 应用配置到运行时状态 */
function applyConfig(cfg) {
  const globalCfg = cfg.global || {};
  state.cfg = cfg;
  state.thresholds = Object.assign({}, inspect.DEFAULT_THRESHOLDS, globalCfg.thresholds);
  state.concurrency = Math.max(1, globalCfg.concurrency || 5);
  state.timeoutMs = Math.max(10000, globalCfg.timeout_ms || 30000);
  state.reportsDir = reports.resolveReportDir(globalCfg.report_dir, __dirname);
}

/** 重载配置（供 Web 管理员按钮与文件监听调用）。失败时保留旧配置，不影响运行。 */
async function reloadConfig() {
  const r = await loadAndValidate(state.cfgFile);
  if (!r.ok) {
    console.error('>>> 配置重载失败，继续使用当前配置：' + r.message);
    return { ok: false, message: r.message };
  }
  applyConfig(r.cfg);
  console.log('>>> 配置已重载：' + r.devices + ' 台设备，并发 ' + state.concurrency + '，超时 ' + Math.round(state.timeoutMs / 1000) + ' 秒');
  if (r.keyError) {
    console.error('>>> [严重] 主密钥不可用，加密口令的设备将无法巡检：' + r.keyError);
  }
  return { ok: true, message: '配置已重载', devices: r.devices, keyError: r.keyError || null };
}

/** 监听 config.json 变化，自动热重载（防抖 + 失败保留旧配置） */
function watchConfig(cfgFile) {
  let timer = null;
  try {
    const watcher = fs.watch(cfgFile, () => {
      if (timer) clearTimeout(timer);
      // 防抖：编辑器保存常触发多次事件，且可能读到半截文件
      timer = setTimeout(() => {
        timer = null;
        // reloadConfig 现为异步：必须捕获，否则内部意外抛错会成为未处理的 Promise rejection
        Promise.resolve()
          .then(() => reloadConfig())
          .catch((e) => console.error('>>> 配置热重载异常（继续使用当前配置）：' + ((e && e.message) || e)));
      }, CONFIG_WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (e) => {
      console.error('>>> 配置监听失效（不影响运行）：' + ((e && e.message) || e));
    });
    console.log('>>> 已启用配置热重载（修改 config.json 后约 ' + (CONFIG_WATCH_DEBOUNCE_MS / 1000) + ' 秒自动生效）');
    return watcher;
  } catch (e) {
    console.error('>>> 配置监听启动失败（不影响运行）：' + ((e && e.message) || e));
    return null;
  }
}

function startServer(opt) {
  const handler = createHandler({
    getStatus: buildStatus,
    reloadConfig: state.authEnabled ? reloadConfig : null,
    reportsDir: () => state.reportsDir,
    title: state.title,
    // 仅监听回环地址且未加 --auth 时进入本机免登录模式（GUI 双击启动即属此情形），
    // 保持与加入认证之前一致的使用方式；对外监听由启动闸门强制要求 --auth。
    authRequired: !!opt.authEnabled
  });
  // reportsDir 需要动态读取（热重载后可能变化），用 getter 包装
  const wrapped = async (req, res) => handler(req, res);

  let server;
  if (opt.tls) {
    let cert, key;
    try {
      cert = fs.readFileSync(opt.cert);
      key = fs.readFileSync(opt.key);
    } catch (e) {
      console.error('>>> 无法读取 TLS 证书/私钥：' + ((e && e.message) || e));
      process.exit(1);
    }
    server = https.createServer({ cert: cert, key: key, minVersion: 'TLSv1.2' }, wrapped);
  } else {
    server = http.createServer(wrapped);
  }

  server.listen(opt.port, opt.bind, () => {
    const scheme = opt.tls ? 'https' : 'http';
    const shown = isLoopback(opt.bind) ? '127.0.0.1' : opt.bind;
    console.log('>>> 监控服务已就绪: ' + scheme + '://' + shown + ':' + opt.port + '/');
    if (!isLoopback(opt.bind)) {
      console.log('>>> 监听 ' + opt.bind + '，同网段可通过本机 IP 访问: ' + scheme + '://<本机IP>:' + opt.port + '/');
    }
    if (opt.authEnabled) {
      console.log('>>> 已启用登录认证（账号管理：node deploy/init-accounts.js list）');
    } else {
      console.log('>>> 未启用认证（仅本机访问）');
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error('>>> 端口 ' + opt.port + ' 被占用，请换端口（--port 8766）或关闭占用程序');
      process.exit(1);
    }
    if (e.code === 'EADDRNOTAVAIL') {
      console.error('>>> 无法绑定地址 ' + opt.bind + '，请确认该地址属于本机网卡');
      process.exit(1);
    }
    console.error('>>> 服务错误：' + ((e && e.message) || e));
  });
  return server;
}

async function main() {
  const args = parseArgs(process.argv);
  state.cfgFile = args.config || path.join(__dirname, 'config.json');
  const intervalSec = Math.max(MIN_INTERVAL, args.interval || 60);
  state.port = args.port || DEFAULT_PORT;
  state.bind = args.bind || '127.0.0.1';
  state.authEnabled = !!args.auth;
  state.tlsEnabled = !!args.https;
  state.interval = intervalSec;
  if (args.title) state.title = String(args.title);

  // ===== 安全闸门 1：对外监听必须启用认证 =====
  if (!isLoopback(state.bind) && !state.authEnabled) {
    console.error('');
    console.error('>>> 拒绝启动：--bind ' + state.bind + ' 会让内网其他人访问本服务，但未启用认证。');
    console.error('    大屏数据包含全部设备的名称、IP、型号与故障详情，等同于机房资产清单。');
    console.error('');
    console.error('    请加 --auth 启用登录认证，并先创建账号：');
    console.error('      node deploy/init-accounts.js create <用户名> admin <显示名>');
    console.error('      node monitor.js --bind ' + state.bind + ' --port ' + state.port + ' --auth');
    console.error('');
    console.error('    若只想本机自用，去掉 --bind 参数即可（默认仅监听 127.0.0.1）。');
    console.error('');
    process.exit(1);
  }

  // ===== 安全闸门 2：启用认证但没有任何账号 → 会把所有人锁在外面 =====
  if (state.authEnabled && auth.accountCount() === 0) {
    console.error('');
    console.error('>>> 拒绝启动：已启用认证（--auth）但尚无任何账号，任何人都无法登录。');
    console.error('    请先在服务器上创建账号：');
    console.error('      node deploy/init-accounts.js create admin admin 系统管理员');
    console.error('');
    process.exit(1);
  }

  // ===== TLS 参数校验 =====
  if (state.tlsEnabled) {
    if (!args.cert || !args.key) {
      console.error('>>> 拒绝启动：--https 需要同时提供 --cert 与 --key');
      process.exit(1);
    }
    for (const f of [args.cert, args.key]) {
      if (!fs.existsSync(f)) { console.error('>>> 拒绝启动：文件不存在 → ' + f); process.exit(1); }
    }
    auth.setSecureCookie(true);   // HTTPS 下 Cookie 追加 Secure
    webServer.setTls(true);       // 标记 TLS，使 HSTS 等仅 TLS 生效的头可下发
    if (args.hsts) {
      webServer.setHsts(true);
      console.log('>>> 已启用 HSTS（Strict-Transport-Security）。请确认证书由正规 CA 签发且轮换可靠，');
      console.log('    否则证书过期时浏览器会在有效期内拒绝访问且无法绕过。');
    }
  }

  // ===== 处理已有监控进程 =====
  const pidFile = path.join(__dirname, '.monitor.pid');
  const pid = readPidFile(__dirname);
  if (pid && isRunning(pid) && pid !== process.pid) {
    if (args.killExisting) {
      console.log('>>> 检测到已有监控进程 (PID ' + pid + ')，正在替换...');
      killPid(pid);
      // 给旧进程一点时间释放端口
      await new Promise((r) => setTimeout(r, 600));
    } else {
      console.log('>>> 检测到已有监控进程 (PID ' + pid + ')，按 --no-kill-existing 要求不替换。');
      console.log('    若该进程正占用端口 ' + state.port + '，本进程将启动失败；请换端口或先停止它。');
    }
  }
  if (args.killExisting) {
    try { fs.writeFileSync(pidFile, String(process.pid)); } catch (e) { /* 忽略 */ }
    const cleanup = () => { try { fs.unlinkSync(pidFile); } catch (e) { } };
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  }

  // ===== 加载配置 =====
  const loaded = await loadAndValidate(state.cfgFile);
  if (!loaded.ok) {
    console.error('配置错误: ' + loaded.message);
    process.exit(1);
  }
  applyConfig(loaded.cfg);
  if (loaded.keyError) {
    // 主密钥不可用时不中止服务：大屏仍可展示设备清单与历史状态，
    // 但加密口令的设备会巡检失败，需明确告知运维原因。
    console.error('[严重] 主密钥不可用，加密口令的设备将无法巡检：' + loaded.keyError);
  }

  // ===== 启动服务 =====
  startServer({
    port: state.port,
    bind: state.bind,
    tls: state.tlsEnabled,
    cert: args.cert,
    key: args.key,
    authEnabled: state.authEnabled
  });

  console.log('>>> 实时监控已启动：' + loaded.devices + ' 台设备，每 ' + intervalSec + ' 秒刷新一次，并发 ' + state.concurrency);
  console.log('>>> 报告目录：' + state.reportsDir);
  if (!fs.existsSync(state.reportsDir)) {
    console.log('>>> 提示：报告目录当前不存在，首次巡检时会自动创建；若 report_dir 指向网络盘，请确认服务账户有权限');
  }

  // ===== 配置热重载 =====
  if (args.watch) watchConfig(state.cfgFile);

  // ===== 巡检轮次 =====
  let running = false;
  async function round() {
    if (running) return;
    running = true;
    state.running = true;
    const t0 = Date.now();
    try {
      // 每轮都从 state 读取最新配置（热重载后自动生效）
      const servers = (state.cfg && state.cfg.servers) || [];
      const thresholds = state.thresholds;
      const tasks = servers.map((s) => () =>
        inspect.inspectOne(s, state.timeoutMs).then((r) => inspect.evaluateResult(r, thresholds)));
      state.results = await inspect.runWithConcurrency(tasks, state.concurrency, () => { });
      state.roundNo++;
      state.lastUpdate = nowHuman();
      const s = summarize(state.results);
      console.log('>>> 第 ' + state.roundNo + ' 轮完成（耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）：正常 ' + s.normal + ' · 警告 ' + s.warning + ' · 严重 ' + s.critical + ' · 失败 ' + s.error);
    } catch (e) {
      console.error('本轮巡检异常: ' + ((e && e.message) || e));
    } finally {
      running = false;
      state.running = false;
    }
  }

  await round();
  setInterval(round, intervalSec * 1000);
}

if (require.main === module) {
  main().catch((e) => { console.error('监控异常: ' + ((e && e.stack) || e)); process.exit(1); });
}

module.exports = { buildStatus, summarize, reloadConfig, loadAndValidate, parseArgs, isLoopback };
