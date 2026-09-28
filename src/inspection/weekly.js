'use strict';
/**
 * weekly.js —— 巡检报告生成（周报 / 手工导出共用）
 *
 * 用法（CLI，供 Windows 计划任务调用）：
 *   node scripts/weekly-cli.js              立即生成一次
 *   node scripts/weekly-cli.js --dry-run    只校验不连接设备
 *   node scripts/weekly-cli.js --out <目录> 覆盖输出目录
 *
 * 用法（Web）：由 routes/inspection.js 调用 generate()，servers 由主进程从台账读出并解密。
 *
 * 为什么把「生成报告」从 main() 里拆出来：
 *   合并后数据源是数据库中的设备台账，不再有 config.json 可依赖。
 *   如果把 Web 请求硬塞进读 argv + 读文件的老路径，周报就永远只能在有配置文件的
 *   老部署上跑得起来。抽出纯函数后，CLI 与 Web 共用同一套采集与渲染口径。
 */
const fs = require('fs');
const path = require('path');

const paths = require('./paths');
const LOG_DIR = paths.logsDir ? paths.logsDir() : path.join(__dirname, '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'weekly.log');
const LOG_MAX = 2 * 1024 * 1024;

const inspect = require('./inspect');
const { renderReport, evaluateResult } = require('./lib/report');
const { nowHuman, nowStamp } = require('./lib/common');

const REPORT_PREFIX = '巡检周报';   // 必须与 report-store 的白名单一致，否则网页端不显示

/* ---------------- 日志 ---------------- */

function logLine(msg) {
  const line = '[' + nowHuman() + '] ' + msg;
  console.log(line);            // 前台运行时可见
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    // 轮转：超过上限则把当前日志改名为 .1（覆盖旧的 .1），避免无限增长
    if (fs.existsSync(LOG_FILE)) {
      const st = fs.statSync(LOG_FILE);
      if (st.size > LOG_MAX) {
        const bak = LOG_FILE + '.1';
        try { if (fs.existsSync(bak)) fs.unlinkSync(bak); } catch (e) { /* 忽略 */ }
        try { fs.renameSync(LOG_FILE, bak); } catch (e) { /* 忽略，继续追加 */ }
      }
    }
    fs.appendFileSync(LOG_FILE, line + '\r\n', 'utf8');
  } catch (e) {
    // 日志写失败不应导致报告本身失败
    console.error('（写入周报日志失败：' + ((e && e.message) || e) + '）');
  }
}

/* ---------------- 参数 ---------------- */

function parseArgs(argv) {
  const a = { config: require('./config-source').DEFAULT_FILE, dryRun: false, out: null };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run' || t === '-n') a.dryRun = true;
    else if (t === '--config' && argv[i + 1]) a.config = path.resolve(argv[++i]);
    else if (t.startsWith('--config=')) a.config = path.resolve(t.slice(9));
    else if (t === '--out' && argv[i + 1]) a.out = t ? argv[++i] : null;
    else if (t.startsWith('--out=')) a.out = t.slice(6);
    else if (t === '--help' || t === '-h') a.help = true;
    else { a.unknown = t; }
  }
  return a;
}

function usage() {
  console.log([
    '用法：node weekly.js [选项]',
    '',
    '  --config <路径>   指定配置文件（默认 data/inspection.json）',
    '  --out <目录>      覆盖报告输出目录（默认取配置中的 report_dir）',
    '  --dry-run, -n     只读配置统计设备，不连接设备、不写报告',
    '  --help, -h        显示本帮助',
    '',
    '本命令通常由 Windows 计划任务在每周固定时间自动调用，也可在 Web 端「巡检报告」页手动触发。'
  ].join('\n'));
}

/* ---------------- 核心：生成一份报告 ---------------- */

/**
 * @param {{servers:Array, global:Object, outDir:string, source:string, log:Function}} opt
 *   servers —— 已完成口令解密的设备列表（主进程提供）
 * @returns {Promise<{ok:boolean, file?:string, stat?:Object, seconds?:number, error?:string}>}
 */
async function generate(opt) {
  const o = opt || {};
  const say = typeof o.log === 'function' ? o.log : logLine;
  const t0 = Date.now();
  const servers = o.servers || [];
  const globalCfg = o.global || {};

  say('===== 开始生成巡检报告（来源：' + (o.source || 'manual') + '）=====');

  // 与命令行巡检同一套校验规则，校验不过不生成报告。
  // 解密失败的设备已被主进程标记，validateServer 会跳过其凭据校验，不会中断整体。
  const errs = [];
  servers.forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
  if (errs.length) {
    say('[失败] 设备校验未通过，未生成报告：');
    errs.slice(0, 10).forEach((e) => say('  - ' + e));
    if (errs.length > 10) say('  - ...（共 ' + errs.length + ' 项）');
    return { ok: false, error: '设备校验未通过：' + errs.slice(0, 3).join('；') };
  }
  if (!servers.length) return { ok: false, error: '没有可巡检的设备' };

  const thresholds = Object.assign({}, inspect.DEFAULT_THRESHOLDS, globalCfg.thresholds);
  const concurrency = Math.max(1, globalCfg.concurrency || 5);
  const timeoutMs = Math.max(10000, globalCfg.timeout_ms || 30000);

  say('设备 ' + servers.length + ' 台，并发 ' + concurrency + '，单台超时 ' + Math.round(timeoutMs / 1000) + ' 秒');

  let results;
  try {
    const tasks = servers.map((s) => () =>
      inspect.inspectOne(s, timeoutMs).then((r) => evaluateResult(r, thresholds)));
    results = await inspect.runWithConcurrency(tasks, concurrency, (r, done, total) => {
      const mark = !r.ok ? '✗ 失败'
        : { normal: '✓ 正常', warning: '△ 警告', critical: '✗ 严重', error: '✗ 失败' }[r.status];
      say('  [' + done + '/' + total + '] ' + r.name + ' (' + r.host + ') → ' + mark);
    });
  } catch (e) {
    const msg = '[失败] 巡检过程异常：' + ((e && e.message) || e);
    say(msg);
    return { ok: false, error: msg };
  }

  let outFile;
  try {
    const html = renderReport(results, {
      date: nowHuman(), version: inspect.VERSION || '3.0.0', thresholds: thresholds
    });
    outFile = inspect.writeReport(o.outDir || globalCfg.report_dir, html, REPORT_PREFIX);
  } catch (e) {
    const msg = '[失败] 报告写入失败：' + ((e && e.message) || e);
    say(msg);
    return { ok: false, error: msg };
  }

  const stat = { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  for (const r of results) {
    if (!r.ok) stat.error++;
    else if (stat[r.status] !== undefined) stat[r.status]++;
  }
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1));
  say('报告生成完成，耗时 ' + secs + ' 秒');
  say('  正常 ' + stat.normal + ' · 警告 ' + stat.warning + ' · 严重 ' + stat.critical
    + ' · 失败 ' + stat.error + '（共 ' + stat.total + ' 台）');
  say('  报告文件：' + outFile);
  say('===== 报告生成结束 =====');
  return { ok: true, file: outFile, stat: stat, seconds: secs };
}

/* ---------------- CLI 入口 ---------------- */

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return 0; }
  if (args.unknown) {
    logLine('未知参数：' + args.unknown + '（用 --help 查看用法）');
    return 2;
  }

  logLine('配置文件：' + args.config);
  if (!fs.existsSync(args.config)) {
    logLine('[失败] 配置文件不存在：' + args.config);
    return 1;
  }

  let loaded;
  try {
    loaded = await inspect.loadConfigDecrypted(args.config, (m) => logLine(m));
  } catch (e) {
    logLine('[失败] 配置读取/解析失败：' + ((e && e.message) || e));
    return 1;
  }
  const cfg = loaded.cfg;

  if (args.dryRun) {
    const errs = [];
    (cfg.servers || []).forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
    logLine('[dry-run] 设备 ' + (cfg.servers || []).length + ' 台，校验错误 ' + errs.length + ' 项，未生成报告。');
    errs.slice(0, 5).forEach((e) => logLine('  - ' + e));
    return 0;
  }

  const r = await generate({
    servers: cfg.servers || [], global: cfg.global || {}, outDir: args.out, source: 'cli'
  });
  return r.ok ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code || 0))
    .catch((e) => {
      logLine('[异常] ' + ((e && e.stack) || e));
      process.exit(1);
    });
}

module.exports = { main, generate, parseArgs, logLine, REPORT_PREFIX };
