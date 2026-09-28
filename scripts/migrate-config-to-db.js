'use strict';
/**
 * migrate-config-to-db.js —— 阶段 3：把巡检配置一次性迁入设备台账
 *
 * 用法：
 *   node scripts/migrate-config-to-db.js                 # 正式迁移
 *   node scripts/migrate-config-to-db.js --dry-run       # 只核验不写库
 *   node scripts/migrate-config-to-db.js --force         # 台账已有数据时覆盖式重建
 *   node scripts/migrate-config-to-db.js --rollback      # 回退到文件模式（config_version=0）
 *   node scripts/migrate-config-to-db.js --config=<路径> # 指定源配置文件
 *
 * 三条不能破的规矩：
 *   1. enc:v1 密文原样搬列，绝不「解密→再加密」。密文是用本机 DPAPI 主密钥加的，
 *      解不开（本机没密钥）也搬得动；反过来如果换个密钥重加密，26 条口令会全部作废。
 *   2. 绝不触碰 secrets/master.key。重新生成主密钥等于让全部加密口令报废。
 *   3. 迁移后必须做三项计数校验：台数、密文条数、明文条数。
 *      任何一项对不上就退出非零，绝不静默丢设备。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
function arg(name, def) {
  const hit = args.find((a) => a === '--' + name || a.indexOf('--' + name + '=') === 0);
  if (!hit) return def;
  const i = hit.indexOf('=');
  return i < 0 ? true : hit.slice(i + 1);
}
const flag = (name) => args.indexOf('--' + name) >= 0;

const ROOT = path.resolve(__dirname, '..');
const inspect = require(path.join(ROOT, 'src/inspection/inspect.js'));
const secret = require(path.join(ROOT, 'src/inspection/lib/secret.js'));
const paths = require(path.join(ROOT, 'src/inspection/paths.js'));
const repo = require(path.join(ROOT, 'src/inspection/device-repo.js'));
const { db } = require(path.join(ROOT, 'src/db-contract.js'));

const CFG_FILE = arg('config', null) || process.env.INSPECTION_CONFIG
  || path.join(paths.root(), 'data', 'inspection.json');
const PREFIX = 'enc:v1:';

function readJson(file) {
  let t = fs.readFileSync(file, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
}

/** 统计配置里的口令形态 */
function audit(cfg) {
  let enc = 0, plain = 0;
  for (const s of cfg.servers || []) {
    for (const sec of ['auth', 'db']) {
      if (!s[sec] || typeof s[sec] !== 'object') continue;
      for (const f of ['password', 'passphrase']) {
        const v = s[sec][f];
        if (typeof v !== 'string' || !v) continue;
        if (v.indexOf(PREFIX) === 0) enc++; else plain++;
      }
    }
  }
  return { servers: (cfg.servers || []).length, encrypted: enc, plaintext: plain };
}

function line(n) { process.stdout.write('\n'); }
function hr(t) { process.stdout.write('\n=== ' + t + ' ===\n'); }

/* ---------------- 回退 ---------------- */

function rollback() {
  const v = repo.setDbMode(false);
  hr('回退完成');
  process.stdout.write('config_version 已置 0，调度器下一轮起改读配置文件：\n  ' + CFG_FILE + '\n');
  process.stdout.write('台账数据保留在 it_devices 表中，随时可用 --force 重新迁回来。\n');
  return v;
}

/* ---------------- 主流程 ---------------- */

async function main() {
  if (flag('rollback')) { rollback(); return 0; }

  hr('迁移前检查');
  if (!fs.existsSync(CFG_FILE)) {
    process.stdout.write('[失败] 源配置文件不存在：' + CFG_FILE + '\n');
    return 1;
  }
  const cfg = inspect.loadConfig(CFG_FILE);
  const src = audit(cfg);
  const before = repo.stats();
  process.stdout.write('  源配置文件：' + CFG_FILE + '\n');
  process.stdout.write('  源设备台数：' + src.servers + '，其中密文口令 ' + src.encrypted
    + ' 条、明文口令 ' + src.plaintext + ' 条\n');
  process.stdout.write('  台账现状  ：' + before.total + ' 台（启用 ' + before.enabled + '），数据模式='
    + (before.dbMode ? '数据库' : '文件') + '\n');

  if (src.servers === 0) {
    process.stdout.write('[失败] 源配置里没有任何设备，拒绝迁移（可能是读错了文件）\n');
    return 1;
  }
  if (before.total > 0 && !flag('force')) {
    process.stdout.write('\n[中止] 台账里已有 ' + before.total + ' 台设备。\n');
    process.stdout.write('  首次迁移请用：node scripts/migrate-config-to-db.js\n');
    process.stdout.write('  确认要覆盖重建请用：node scripts/migrate-config-to-db.js --force\n');
    return 1;
  }

  // 不明字段预警：配置文件里若有本表未覆盖的字段，迁移会静默丢弃，必须说出来
  const KNOWN = new Set(['name', 'host', 'os', 'auth', 'port', 'services', 'db',
    'protocol', 'custom_commands', 'timeout_ms', 'thresholds', 'connectLabel']);
  const unknown = new Set();
  for (const s of cfg.servers || []) {
    for (const k of Object.keys(s)) if (!KNOWN.has(k)) unknown.add(k);
  }
  if (unknown.size) {
    process.stdout.write('  [警告] 源配置含台账未覆盖的字段，将被丢弃：' + [...unknown].join('、') + '\n');
  }

  if (flag('dry-run')) {
    hr('DRY-RUN：只核验不写库');
    const errs = [];
    (cfg.servers || []).forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
    process.stdout.write('  校验错误数：' + errs.length + '\n');
    errs.slice(0, 10).forEach((e) => process.stdout.write('    - ' + e + '\n'));
    const kr = await secret.loadMasterKeyAsync();
    process.stdout.write('  主密钥：' + (kr.ok ? '可用（指纹 ' + secret.fingerprint() + '）' : '不可用 → ' + kr.error) + '\n');
    return errs.length ? 1 : 0;
  }

  /* ---------------- 执行迁移 ---------------- */

  hr('执行迁移');
  const g = cfg.global || {};
  let imported = 0, skipped = 0;

  db.exec('BEGIN');
  try {
    if (flag('force')) {
      // 覆盖重建：软删除旧行后重新插入，保留唯一索引历史，不物理抹掉任何东西
      db.prepare('UPDATE it_devices SET is_deleted=1 WHERE is_deleted=0').run();
    }
    const stmt = db.prepare(`
      INSERT INTO it_devices (name, host, os, port, protocol, enabled, location,
        auth_type, auth_username, auth_password, auth_private_key_path, auth_passphrase,
        db_engine, db_version_hint, services_json, custom_commands_json,
        remark, sort_order, created_by)
      VALUES (@name, @host, @os, @port, @protocol, 1, '',
        @auth_type, @auth_username, @auth_password, @auth_private_key_path,
        @auth_passphrase, @db_engine, @db_version_hint, @services_json,
        @custom_commands_json, '', @sort_order, NULL)
    `);
    (cfg.servers || []).forEach((s, i) => {
      const auth = s.auth || {};
      const dbs = s.db || {};
      try {
        stmt.run({
          name: String(s.name || '').trim(),
          host: String(s.host || '').trim(),
          os: String(s.os || '').trim().toLowerCase(),
          port: s.port == null ? null : Number(s.port),
          protocol: String(s.protocol || '').trim().toLowerCase(),
          auth_type: String(auth.type || '').trim(),
          auth_username: String(auth.username || '').trim(),
          // 关键：密文原样搬运，不做任何加解密
          auth_password: auth.password == null ? '' : String(auth.password),
          auth_private_key_path: String(auth.private_key_path || '').trim(),
          auth_passphrase: auth.passphrase == null ? '' : String(auth.passphrase),
          db_engine: String(dbs.engine || '').trim().toLowerCase(),
          db_version_hint: String(dbs.version_hint || '').trim(),
          services_json: JSON.stringify(Array.isArray(s.services) ? s.services : []),
          custom_commands_json: JSON.stringify(Array.isArray(s.custom_commands) ? s.custom_commands : []),
          sort_order: (i + 1) * 10
        });
        imported++;
      } catch (e) {
        skipped++;
        process.stdout.write('  [跳过] ' + (s.name || s.host) + '：' + (e && e.message) + '\n');
      }
    });

    repo.saveSettings({
      concurrency: g.concurrency,
      timeout_ms: g.timeout_ms,
      ssh_port_default: g.ssh_port_default,
      report_dir: g.report_dir,
      thresholds: g.thresholds
    }, null);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ }
    process.stdout.write('[失败] 迁移事务回滚：' + ((e && e.message) || e) + '\n');
    return 1;
  }
  process.stdout.write('  已导入 ' + imported + ' 台，跳过 ' + skipped + ' 台\n');

  /* ---------------- 迁移后校验 ---------------- */

  hr('迁移后校验');
  const after = repo.stats();
  const checks = [
    ['设备台数', after.total, src.servers],
    ['密文口令条数', after.encrypted, src.encrypted],
    ['明文口令条数', after.plaintext, src.plaintext]
  ];
  let bad = 0;
  for (const [label, got, want] of checks) {
    const ok = got === want;
    if (!ok) bad++;
    process.stdout.write('  ' + (ok ? '[通过]' : '[不符]') + ' ' + label.padEnd(14)
      + ' 台账=' + String(got).padStart(3) + '  源文件=' + String(want).padStart(3) + '\n');
  }

  // 深度校验：真跑一遍内核规则的加载路径
  let loaded;
  try {
    loaded = await repo.buildConfig();
  } catch (e) {
    process.stdout.write('[失败] 按台账重新组装配置失败：' + ((e && e.message) || e) + '\n');
    return 1;
  }
  const errs = [];
  (loaded.servers || []).forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
  process.stdout.write('  按台账重新组装并过内核校验，错误数：' + errs.length + '\n');
  errs.slice(0, 10).forEach((e) => process.stdout.write('    - ' + e + '\n'));

  const kr = await secret.loadMasterKeyAsync();
  let decOk = 0, decFail = 0;
  if (kr.ok) {
    for (const s of loaded.servers || []) {
      const r = secret.decryptServer(s, kr.key);
      if (r.errors && r.errors.length) decFail++; else decOk++;
    }
  }
  process.stdout.write('  主密钥：' + (kr.ok ? '可用（指纹 ' + secret.fingerprint() + '）'
    : '不可用 → ' + kr.error) + '\n');
  if (kr.ok) {
    process.stdout.write('  单台解密演练：成功 ' + decOk + ' 台，失败 ' + decFail + ' 台\n');
  }

  if (skipped > 0) bad++;
  if (errs.length) bad++;

  hr(bad === 0 ? '迁移成功' : '迁移完成但存在待处理项');
  process.stdout.write('  数据模式：数据库（config_version=' + repo.getSettings().config_version + '）\n');
  process.stdout.write('  回退方法：node scripts/migrate-config-to-db.js --rollback\n');
  if (bad === 0) {
    if (!kr.ok) {
      process.stdout.write('  注意：主密钥在本机不可用，属正常現象（密钥绑定原服务器机器账户）。\n');
      process.stdout.write('        部署到原服务器后会自动恢复；届时跑本脚本复核一次即可。\n');
    }
    process.stdout.write('  下一步：重启服务后访问 #/devices 确认台账内容与大屏一致。\n');
  }
  return bad === 0 ? 0 : 1;
}

main().then((code) => process.exit(code || 0))
  .catch((e) => {
    process.stderr.write('迁移脚本异常：' + ((e && e.stack) || e) + '\n');
    process.exit(1);
  });
