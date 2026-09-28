'use strict';
/**
 * doctor.js —— 部署自检（npm run check）
 *
 * 存在的理由很直接：搬迁到新服务器时，前几期踩过的坑——依赖没装全、secrets 目录位置、
 * 主密钥不可用、报告目录不存在——全都是「服务能起来、但功能悄悄残废」的类型。
 * 靠人翻日志逐个核对既不现实也不可靠，所以把检查固化成一条命令。
 *
 * 检查分两级：
 *   FAIL —— 会导致核心功能不可用，必须处理
 *   WARN —— 不影响主流程，但某项能力会退化（例如 WMI 工具缺失 → Windows 采集降级）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const rows = [];

function check(label, fn) {
  try {
    const r = fn();
    if (r && r.ok === false) rows.push({ label: label, level: 'FAIL', msg: r.msg });
    else if (r && r.warn) rows.push({ label: label, level: 'WARN', msg: r.warn });
    else rows.push({ label: label, level: 'PASS', msg: (r && r.msg) || '' });
  } catch (e) {
    rows.push({ label: label, level: 'FAIL', msg: String((e && e.message) || e) });
  }
}

const p = (...a) => path.join(ROOT, ...a);
const rel = (abs) => path.relative(ROOT, abs) || abs;

/* ---------------- 1. 运行时 ---------------- */

check('Node 运行时', () => {
  const exe = p('runtime', 'node.exe');
  if (!fs.existsSync(exe)) return { warn: '未随包携带 runtime/node.exe，将使用系统 Node —— ' + process.version };
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (!(major >= 22)) return { ok: false, msg: 'Node 版本 ' + process.version + ' 过低，node:sqlite 需要 22.5+' };
  return { msg: process.version + '（' + rel(exe) + '）' };
});

/* ---------------- 2. 依赖 ---------------- */

const DEPS = ['express', 'multer', 'xlsx', 'iconv-lite', 'oracledb', 'ssh2', 'tedious'];
check('依赖完整性', () => {
  const miss = [];
  const vers = [];
  for (const d of DEPS) {
    try {
      const v = require(path.join(ROOT, 'node_modules', d, 'package.json')).version;
      vers.push(d + '@' + v);
    } catch (e) { miss.push(d); }
  }
  if (miss.length) return { ok: false, msg: '缺失：' + miss.join(', ') + ' —— 请执行 npm install' };
  return { msg: vers.length + ' 个核心依赖就绪' };
});

check('oracledb 模式', () => {
  try {
    const o = require(path.join(ROOT, 'node_modules', 'oracledb'));
    return { msg: o.thick ? 'thick（需本机 Oracle Client）' : 'thin（纯 JS，无需客户端）' };
  } catch (e) { return { ok: false, msg: String((e && e.message) || e) }; }
});

/* ---------------- 3. 目录可写 ---------------- */

for (const [name, dir] of [['数据目录', p('data')], ['日志目录', p('logs')], ['附件目录', p('uploads')]]) {
  check(name + '可写', () => {
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, '.write-test-' + Date.now());
    fs.writeFileSync(t, 'x');
    fs.unlinkSync(t);
    return { msg: rel(dir) };
  });
}

/* ---------------- 4. 业务库 ---------------- */

check('业务数据库', () => {
  const config = require(p('config.js'));
  for (const [n, f] of [['合同库', config.CONTRACT_DB_FILE], ['问题库', config.DB_FILE]]) {
    if (!fs.existsSync(f)) return { ok: false, msg: n + '不存在：' + rel(f) };
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(f, { readOnly: true });
    db.prepare('SELECT 1').get();
    db.close();
  }
  const { db } = require(p('src', 'db-contract.js'));
  const users = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  return { msg: '合同库 + 问题库可读，账号 ' + users + ' 个' };
});

/* ---------------- 5. 巡检资产（搬迁后最容易丢的三样） ---------------- */

check('巡检外部资产', () => {
  const paths = require(p('src', 'inspection', 'paths.js'));
  const a = paths.audit();
  const miss = a.rows.filter((r) => !r.exists).map((r) => r.label);
  return miss.length
    ? { warn: '缺失：' + miss.join('、') + '（Windows 本机采集或口令解密会受影响）。根目录：' + a.root }
    : { msg: 'secrets / wmitools 齐全，根目录 ' + a.root };
});

check('设备台账', () => {
  const repo = require(p('src', 'inspection', 'device-repo.js'));
  const s = repo.stats();
  if (!s.total) return { warn: '台账为空 —— 若尚未迁移请执行 npm run migrate:config' };
  return {
    msg: s.total + ' 台设备，启用 ' + s.enabled + '，密文凭据 ' + s.encrypted
      + ' 条' + (s.plaintext ? '，明文 ' + s.plaintext + ' 条' : '')
      + '（数据源：' + (s.dbMode ? '台账' : '配置文件') + '）'
  };
});

// 主密钥要起 KeyVault 子进程，只能异步核实，故不进上面的同步检查队列
async function secretCheck() {
  try {
    const secret = require(p('src', 'inspection', 'lib', 'secret.js'));
    const r = await secret.loadMasterKeyAsync();
    if (r && r.ok) return { level: 'PASS', msg: '可用（指纹 ' + (secret.fingerprint() || '未知') + '）' };
    return { level: 'FAIL', msg: (r && r.error) || '未知原因 —— 加密口令的设备将无法巡检' };
  } catch (e) {
    return { level: 'FAIL', msg: String((e && e.message) || e) };
  }
}

/* ---------------- 6. 报告目录 ---------------- */

check('报告目录', () => {
  const store = require(p('src', 'inspection', 'report-store.js'));
  const paths = require(p('src', 'inspection', 'paths.js'));
  let configured = '';
  try {
    const repo = require(p('src', 'inspection', 'device-repo.js'));
    configured = repo.getSettings().report_dir || '';
  } catch (e) { /* 台账不可用时退回配置文件里的值 */ }
  const dir = store.resolveReportDir(configured, paths.root(), paths.reportsDir());
  fs.mkdirSync(dir, { recursive: true });
  const t = path.join(dir, '.write-test-' + Date.now());
  fs.writeFileSync(t, 'x');
  fs.unlinkSync(t);
  const list = store.listReports(dir);
  return { msg: dir + '（' + (list.ok ? list.items.length : 0) + ' 份报告）' };
});

/* ---------------- 7. 前端视图注册 ---------------- */

check('前端视图注册', () => {
  const r = require(p('scripts', 'check-views.js')).analyze();
  if (r.bad.length) {
    return {
      ok: false,
      msg: r.bad.length + ' 个组件名解析不到注册组件，对应页面会白屏：' + r.bad.join('、')
        + ' —— 详见 node scripts/check-views.js'
    };
  }
  return { msg: r.used.length + ' 个视图名与 ' + r.registered.length + ' 个注册组件一一对应' };
});

/* ---------------- 8. 巡检历史库 ---------------- */

check('巡检历史库', () => {
  const config = require(p('config.js'));
  const f = config.INSPECT_DB_FILE;
  if (!fs.existsSync(f)) return { warn: '尚未生成（服务首次启动后自动创建）' };
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(f, { readOnly: true });
  const r = db.prepare('SELECT COUNT(*) c FROM it_inspect_history').get().c;
  db.close();
  return { msg: rel(f) + '，快照 ' + r + ' 条' };
});

/* ---------------- 输出 ---------------- */

(async () => {
  const sec = await secretCheck();
  console.log('');
  console.log('============ 部署自检 · 医院信息科一体化系统 ============');
  console.log('根目录：' + ROOT);
  console.log('');
  for (const r of rows) {
    console.log('  [' + r.level + '] ' + r.label.padEnd(12, '　') + (r.msg ? ' ' + r.msg : ''));
  }
  console.log('  [' + sec.level + '] 主密钥可用性 ' + sec.msg);
  console.log('');
  const fails = rows.filter((r) => r.level === 'FAIL').length + (sec.level === 'FAIL' ? 1 : 0);
  const warns = rows.filter((r) => r.level === 'WARN').length + (sec.level === 'WARN' ? 1 : 0);
  console.log('------------------------------------------------------');
  console.log(fails === 0 ? '  结论：可以启动服务。' : '  结论：存在 ' + fails + ' 项必须处理的问题。');
  if (warns) console.log('  另有 ' + warns + ' 项告警，对应功能会降级但不影响启动。');
  console.log('');
  process.exit(fails ? 1 : 0);
})();
