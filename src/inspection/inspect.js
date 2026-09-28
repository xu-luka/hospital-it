'use strict';
/**
 * 机房设备巡检程序 - 主入口
 * 用法：
 *   node inspect.js               使用 config.json 巡检
 *   node inspect.js --config xx   指定配置文件
 *   node inspect.js --demo        生成演示报告（不连接真实服务器）
 */

const fs = require('fs');
const path = require('path');
const { collectLinux } = require('./lib/linux');
const { collectWindows } = require('./lib/windows');
const { collectBmc } = require('./lib/bmc');
const { collectSwitch } = require('./lib/switch');
const { collectDatabase } = require('./lib/database');
const { collectEsxi } = require('./lib/esxi');
const { renderReport, evaluateResult } = require('./lib/report');
const { nowHuman, nowStamp, sleep } = require('./lib/common');
const secret = require('./lib/secret');
const paths = require('./paths');

const VERSION = '3.0.0';

// 注意：原此处有顶层 process.on('uncaughtException'/'unhandledRejection') 无条件吞异常。
// 作为独立 CLI 时是合理的（网络层突发重置不至于让一次巡检中断），
// 但合并后本模块会被 Express 主进程 require —— 那个 handler 会把整个 Web 服务的
// 致命错误也一并吞掉，故障被静默掩盖。已删除，改由 server.js 统一托管：
// 记录 + 计数 + 超过阈值主动退出（交给计划任务重启），绝不静默吞。
// 单独跑 CLI（scripts/inspect-cli.js）时由该脚本自行注册局部兜底。

const DEFAULT_THRESHOLDS = {
  cpu_percent_warn: 70,
  cpu_percent_critical: 90,
  memory_percent_warn: 80,
  memory_percent_critical: 95,
  disk_percent_warn: 80,
  disk_percent_critical: 90,
  load_per_core_warn: 1.0,
  db_conn_percent_warn: 80,
  db_conn_percent_critical: 90,
  db_space_percent_warn: 90,
  db_space_percent_critical: 95,
  db_buffer_hit_warn: 95,
  db_buffer_hit_critical: 90,
  db_backup_age_warn_h: 24,
  db_backup_age_critical_h: 72,
  db_lock_wait_warn_ms: 10000,
  db_lock_wait_critical_ms: 60000,
  switch_temp_warn: 55,
  switch_temp_critical: 70,
  log_error_warn: 20,
  log_error_critical: 100
};

function parseArgs(argv) {
  const args = { config: null, demo: false, only: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--demo') args.demo = true;
    else if (argv[i] === '--config' && argv[i + 1]) args.config = argv[++i];
    else if (argv[i].startsWith('--config=')) args.config = argv[i].slice(9);
    else if (argv[i] === '--only' && argv[i + 1]) args.only = argv[++i];
    else if (argv[i].startsWith('--only=')) args.only = argv[i].slice(7);
  }
  return args;
}

function loadConfig(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const cfg = JSON.parse(raw);
  if (!Array.isArray(cfg.servers) || cfg.servers.length === 0) {
    throw new Error('配置文件 servers 为空，请先填写要巡检的服务器');
  }
  return cfg;
}

/**
 * 读取配置并解密其中的设备口令。
 * 返回 { cfg, decrypted, plaintext, keyError, errors }
 *   decrypted  已解开的加密口令条数
 *   plaintext  仍为明文的口令条数（用于提示迁移）
 *   keyError   主密钥不可用时的原因（此时加密口令的设备会巡检失败并给出明确提示）
 *   errors     逐台的解密错误明细
 *
 * 为什么单独包一层：loadConfig 是同步的（被多处直接调用），而取主密钥需要起一次
 * 子进程（DPAPI 操作只能由 KeyVault.exe 完成），必须是异步。
 * 主密钥取回后在 secret 模块内缓存，整个进程生命周期只起一次子进程。
 */
async function loadConfigDecrypted(file, log) {
  const cfg = loadConfig(file);
  const r = await secret.decryptConfig(cfg);
  if (typeof log === 'function') {
    if (r.usedEncryption > 0) {
      log('>>> 已解密设备口令 ' + r.usedEncryption + ' 条（主密钥指纹 ' + (secret.fingerprint() || '未知') + '）');
    }
    if (r.plaintext > 0) {
      log('[提示] 配置中仍有 ' + r.plaintext + ' 条口令为明文，可执行 secrets\\encrypt-config.js 批量加密');
    }
    if (r.keyError) {
      log('[严重] 主密钥不可用，加密口令的设备将无法巡检：' + r.keyError);
    }
  }
  return { cfg: r.config, decrypted: r.usedEncryption, plaintext: r.plaintext, keyError: r.keyError, errors: r.errors };
}

/** 校验单台服务器配置，返回错误信息数组 */
function validateServer(s, i) {
  const errs = [];
  // 口令解密失败的设备不参与凭据校验，且不在此产生错误。
  // 原因：主流程遇到任何校验错误会直接退出，那样一台设备解密失败会中断整体巡检；
  // 期望行为是其余设备照常巡检，该设备由 inspectOne 短路并给出真实失败原因。
  if (s && s._secretError) return errs;
  if (!s.name) errs.push('缺少 name');
  if (!s.host) errs.push('缺少 host');
  const os = String(s.os || '').toLowerCase();
  if (os !== 'linux' && os !== 'windows' && os !== 'bmc' && os !== 'switch' && os !== 'database' && os !== 'esxi') errs.push('os 必须是 linux、windows、bmc、switch、database 或 esxi');
  const auth = s.auth || {};
  if (os === 'bmc') {
    if (!auth.username) errs.push('缺少 auth.username（管理口账号）');
    if (!auth.password) errs.push('缺少 auth.password（管理口密码）');
  }
  if (os === 'switch') {
    if (!auth.username) errs.push('缺少 auth.username（设备登录账号）');
    if (!auth.password) errs.push('缺少 auth.password（设备登录密码）');
  }
  if (os === 'esxi') {
    if (!auth.username) errs.push('缺少 auth.username（ESXi 账号，通常为 root）');
    if (!auth.password) errs.push('缺少 auth.password（ESXi 密码）');
  }
  if (os === 'database') {
    const engine = String((s.db || {}).engine || '');
    if (engine !== 'mssql' && engine !== 'oracle') errs.push('db.engine 必须是 mssql 或 oracle');
    if (!auth.username) errs.push('缺少 auth.username（数据库账号）');
    if (!auth.password) errs.push('缺少 auth.password（数据库密码）');
  }
  if (os === 'linux') {
    if (auth.type !== 'password' && auth.type !== 'key') errs.push('auth.type 必须是 password 或 key');
    if (!auth.username) errs.push('缺少 auth.username');
    if (auth.type === 'password' && !auth.password) errs.push('auth.type=password 时缺少 auth.password');
    if (auth.type === 'key' && !auth.private_key_path) errs.push('auth.type=key 时缺少 auth.private_key_path');
  } else if (os === 'windows') {
    if (auth.type === 'local') {
      // 本机巡检无需凭据
    } else if (auth.type === 'wmi') {
      if (!auth.username) errs.push('缺少 auth.username');
      if (!auth.password) errs.push('auth.type=wmi 时缺少 auth.password');
    } else if (auth.type === 'password') {
      if (!auth.username) errs.push('缺少 auth.username');
      if (!auth.password) errs.push('auth.type=password 时缺少 auth.password');
    } else if (auth.type === 'key') {
      if (!auth.username) errs.push('缺少 auth.username');
      if (!auth.private_key_path) errs.push('auth.type=key 时缺少 auth.private_key_path');
    } else {
      errs.push('Windows 的 auth.type 必须是 wmi、password、key 或 local');
    }
  }
  return errs.map((e) => `第 ${i + 1} 台 [${s.name || s.host || '未命名'}]: ${e}`);
}

/** 设备类型显示名（正常路径与降级路径共用，避免两边文案不一致） */
function osLabelOf(os) {
  return os === 'linux' ? 'Linux' : os === 'bmc' ? '管理口' : os === 'switch' ? '交换机'
    : os === 'database' ? '数据库' : os === 'esxi' ? 'ESXi' : 'Windows';
}

/** 连接方式显示名（同上，按设备类型 + 认证方式推导） */
function connectLabelOf(server, os) {
  const auth = server.auth || {};
  if (os === 'linux') return auth.type === 'key' ? 'SSH 密钥' : 'SSH 密码';
  if (os === 'bmc') return 'Redfish';
  if (os === 'switch') return 'SSH(设备)';
  if (os === 'database') return (server.db || {}).engine === 'oracle' ? 'Oracle连接' : 'TDS连接';
  if (os === 'esxi') return 'vSphere API';
  return auth.type === 'local' ? '本机' : auth.type === 'key' ? 'SSH 密钥' : auth.type === 'wmi' ? 'WMI' : 'SSH 密码';
}

async function inspectOne(server, timeoutMs) {
  const os = String(server.os || '').toLowerCase();
  // 口令解密失败的设备直接短路：此时凭据字段为 null，继续走采集只会得到
  // 难以理解的认证失败信息。直接给出真实原因，便于运维定位密钥问题。
  if (server._secretError) {
    // 必须带上标识字段：原实现只返回 { ok:false, error }，导致大屏 buildStatus 时
    // name/host/os/osLabel 全为 undefined —— 主密钥不可用时屏幕上是一排空白卡片，
    // 运维既看不出是哪台设备，也看不出该找谁修。这里补齐，保证退化情况下仍可读。
    return {
      ok: false,
      name: server.name || server.host || '未命名设备',
      host: server.host || '',
      os: os,
      osLabel: server.osLabel || osLabelOf(os),
      connectLabel: server.connectLabel || connectLabelOf(server, os),
      error: '设备口令解密失败：' + server._secretError
    };
  }
  let result;
  if (os === 'linux') {
    result = await collectLinux(server, timeoutMs);
  } else if (os === 'bmc') {
    result = await collectBmc(server, timeoutMs);
  } else if (os === 'switch') {
    result = await collectSwitch(server, timeoutMs);
  } else if (os === 'database') {
    result = await collectDatabase(server, timeoutMs);
  } else if (os === 'esxi') {
    result = await collectEsxi(server, timeoutMs);
  } else {
    result = await collectWindows(server, timeoutMs);
  }
  result.name = server.name;
  result.host = server.host;
  result.os = os || 'windows';
  result.osLabel = osLabelOf(os);
  result.connectLabel = connectLabelOf(server, os);
  return result;
}

/** 并发调度器 */
async function runWithConcurrency(tasks, concurrency, onDone) {
  const results = new Array(tasks.length);
  let next = 0;
  let finished = 0;
  const total = tasks.length;

  async function worker() {
    while (next < total) {
      const i = next++;
      results[i] = await tasks[i]();
      finished++;
      onDone(results[i], finished, total);
    }
  }
  const workers = [];
  const n = Math.max(1, Math.min(concurrency, total));
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * 写报告：支持相对目录（基于程序目录）、本地绝对路径、NAS 共享路径（\\server\share\...）
 * 目标目录不可写/不可达时自动回退到程序目录下的 reports
 *
 * @param {string} configuredDir 报告目录（相对/绝对/UNC 均可）
 * @param {string} html          报告正文
 * @param {string} [prefix]      文件名前缀，默认「巡检报告」；周报传「巡检周报」。
 *                               必须匹配 web/reports.js 的白名单，否则网页端不会显示。
 */
function writeReport(configuredDir, html, prefix) {
  const namePrefix = String(prefix || '巡检报告');
  if (namePrefix !== '巡检报告' && namePrefix !== '巡检周报') {
    // 白名单外的前缀会导致网页端无法列出/打开该报告，直接拒绝而不是静默产出无法访问的文件
    throw new Error('不支持的报告前缀：' + namePrefix + '（只允许 巡检报告 / 巡检周报）');
  }
  const fileName = namePrefix + '_' + nowStamp() + '.html';
  const dir = String(configuredDir || '').trim();
  const isAbsolute = path.isAbsolute(dir);
  const target = isAbsolute ? dir : paths.reportsDir();
  // 回退目录必须与读取端 report-store.resolveReportDir() 的回退目标完全一致，
  // 否则会出现「报告已成功写入，但网页列表读另一个目录 → 文件在却看不见」。
  const localFallback = paths.reportsDir();

  const candidates = [target];
  if (target !== localFallback) candidates.push(localFallback);

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    try {
      if (!fs.existsSync(c)) fs.mkdirSync(c, { recursive: true });
      const out = path.join(c, fileName);
      fs.writeFileSync(out, html, 'utf8');
      // 回退时给出提示
      if (i > 0) {
        console.log('>>> 警告：自定义报告目录不可用（' + target + '），已回退到本地目录：' + c);
      }
      return out;
    } catch (e) {
      if (i < candidates.length - 1) {
        console.log('>>> 警告：写入报告目录失败（' + c + '）：' + ((e && e.message) || e) + '，尝试回退...');
      } else {
        throw e;
      }
    }
  }
}

/** 演示模式：生成 4 台模拟服务器的巡检报告，用于验证程序与报告样式 */
async function runDemo(globalCfg) {
  console.log('>>> 演示模式：生成模拟巡检报告（不连接真实服务器）');
  const { buildDemoResults } = require('./lib/demo');
  const thresholds = Object.assign({}, DEFAULT_THRESHOLDS, (globalCfg || {}).thresholds);
  const results = buildDemoResults(thresholds).map((r) => evaluateResult(r, thresholds));
  return results;
}

async function main() {
  const args = parseArgs(process.argv);
  const startTime = Date.now();

  let cfg;
  let results;

  if (args.demo) {
    let g = {};
    try {
      const cfgFile = args.config || require('./config-source').DEFAULT_FILE;
      g = (JSON.parse(fs.readFileSync(cfgFile, 'utf8')).global) || {};
    } catch (e) { /* 演示模式配置缺失也能跑 */ }
    results = await runDemo(g);
  } else {
    const cfgFile = args.config || require('./config-source').DEFAULT_FILE;
    console.log('>>> 读取配置文件: ' + cfgFile);
    let loadedCfg;
    try {
      loadedCfg = await loadConfigDecrypted(cfgFile, (m) => console.log(m));
      cfg = loadedCfg.cfg;
    } catch (e) {
      console.error('配置错误: ' + e.message);
      process.exit(1);
    }
    // 解密失败的设备已由 secret.decryptConfig 就地打上 _secretError 标记：
    // validateServer 会跳过其凭据校验，inspectOne 会短路并给出真实原因。
    // 这里只负责把汇总告警打给命令行用户，不再重复映射（避免同 IP 多设备错配）。
    if (loadedCfg.errors && loadedCfg.errors.length) {
      console.error('[警告] ' + loadedCfg.errors.length + ' 台设备的口令解密失败，这些设备将标记为失败：');
      loadedCfg.errors.slice(0, 10).forEach((e) => {
        console.error('  - ' + e.server + (e.host ? ' (' + e.host + ')' : '') + ' ' + e.field + ': ' + e.error);
      });
      if (loadedCfg.errors.length > 10) console.error('  - ...（共 ' + loadedCfg.errors.length + ' 项）');
    }

    // 按序号过滤（--only 1,3,5，序号从 1 开始）
    if (args.only) {
      const idxs = args.only.split(',').map((x) => parseInt(x, 10)).filter((x) => !isNaN(x));
      const picked = idxs.map((n) => cfg.servers[n - 1]).filter(Boolean);
      if (picked.length === 0) {
        console.error('--only 指定的序号无效，未选中任何服务器');
        process.exit(1);
      }
      cfg.servers = picked;
    }

    // 配置校验
    const allErrs = [];
    cfg.servers.forEach((s, i) => allErrs.push(...validateServer(s, i)));
    if (allErrs.length) {
      console.error('配置校验未通过，请修正以下问题后重试：');
      allErrs.forEach((e) => console.error('  - ' + e));
      process.exit(1);
    }

    const globalCfg = cfg.global || {};
    const thresholds = Object.assign({}, DEFAULT_THRESHOLDS, globalCfg.thresholds);
    const concurrency = Math.max(1, globalCfg.concurrency || 5);
    const timeoutMs = Math.max(10000, globalCfg.timeout_ms || 30000);

    console.log(`>>> 开始巡检：共 ${cfg.servers.length} 台，并发 ${concurrency}，单台超时 ${Math.round(timeoutMs / 1000)} 秒`);
    const tasks = cfg.servers.map((s) => () => inspectOne(s, timeoutMs).then((r) => evaluateResult(r, thresholds)));
    results = await runWithConcurrency(tasks, concurrency, (r, done, total) => {
      const mark = !r.ok ? '✗ 失败' : { normal: '✓ 正常', warning: '△ 警告', critical: '✗ 严重', error: '✗ 失败' }[r.status];
      console.log(`  [${done}/${total}] ${r.name} (${r.host}) → ${mark}`);
      if (r.note) console.log(`        提示：${r.note}`);
    });
    cfg._thresholds = thresholds;
    cfg._reportDir = globalCfg.report_dir;
  }

  // 生成报告（支持自定义目录与 NAS 共享路径，失败自动回退本地）
  const thresholds = cfg ? cfg._thresholds : undefined;
  const html = renderReport(results, {
    date: nowHuman(),
    version: VERSION,
    thresholds: thresholds || DEFAULT_THRESHOLDS
  });
  const outFile = writeReport((cfg && cfg._reportDir) || 'reports', html);

  // 汇总
  const stat = { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  for (const r of results) { if (!r.ok) stat.error++; else if (stat[r.status] !== undefined) stat[r.status]++; }
  const secs = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('');
  console.log('>>> 巡检完成，耗时 ' + secs + ' 秒');
  console.log(`    正常 ${stat.normal} 台 · 警告 ${stat.warning} 台 · 严重 ${stat.critical} 台 · 失败 ${stat.error} 台`);
  console.log('>>> 报告已生成: ' + outFile);
  return outFile;
}

if (require.main === module) {
  main().catch((e) => {
    console.error('程序异常: ' + (e && e.stack || e));
    process.exit(1);
  });
}

module.exports = { main, validateServer, inspectOne, loadConfig, loadConfigDecrypted, writeReport, runWithConcurrency, evaluateResult: require('./lib/report').evaluateResult, DEFAULT_THRESHOLDS, VERSION };
