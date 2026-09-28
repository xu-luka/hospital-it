'use strict';
/**
 * device-repo.js —— 阶段 3：设备台账仓储层
 *
 * 设计要点：
 *
 * 1) 表名为什么是 it_devices 而不是 devices
 *    contract.db 里已经有一张 devices 表（合同下的设备明细：型号/数量/单价），
 *    那是合同业务的资产清单。这里建的是「巡检纳管对象」，两者概念不同，
 *    同名会直接撞车，故加 it_ 前缀区分。
 *
 * 2) 密文永远以密文形态落地
 *    页面上输入的明文口令，在这里就地用现有主密钥（KeyVault.exe + master.key）
 *    加密成 enc:v1:... 再写库，走的是与 C# GUI 完全相同的算法（lib/secret.js）。
 *    数据库里不出现明文，也不依赖备份文件本身的保密性。
 *
 * 3) 密文永不出库
 *    publicView() 不返回 auth_password/auth_passphrase 原文，只给 has_password /
 *    password_encrypted 两个布尔位。前端据此显示「已设置 / 未设置」，
 *    编辑时留空即代表「不修改」。这样口令连.dbf 文件的读权限都不需要就能保护住了——
 *    拿到接口响应的人最多知道"这台设备配了口令"，拿不到口令本身。
 *
 * 4) 主密钥不可用时拒绝保存口令，而不是存明文降级
 *    宁可让管理员先修好 KeyVault，也不要悄悄落一份明文口令到磁盘。
 */
const { db } = require('../db-contract');
const secret = require('./lib/secret');

const PREFIX = 'enc:v1:';

const OS_TYPES = ['linux', 'windows', 'bmc', 'switch', 'database', 'esxi'];
const OS_LABELS = {
  linux: 'Linux 服务器',
  windows: 'Windows 服务器',
  bmc: '服务器管理口',
  switch: '网络交换机',
  database: '数据库',
  esxi: 'ESXi 虚拟化'
};

/* ---------------- 建表（幂等） ---------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS it_devices (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT NOT NULL,
  host                   TEXT NOT NULL,
  os                     TEXT NOT NULL,
  port                   INTEGER,
  protocol               TEXT DEFAULT '',
  enabled                INTEGER NOT NULL DEFAULT 1,
  location               TEXT DEFAULT '',
  auth_type              TEXT DEFAULT '',
  auth_username          TEXT DEFAULT '',
  auth_password          TEXT DEFAULT '',
  auth_private_key_path  TEXT DEFAULT '',
  auth_passphrase        TEXT DEFAULT '',
  db_engine              TEXT DEFAULT '',
  db_version_hint        TEXT DEFAULT '',
  services_json          TEXT DEFAULT '[]',
  custom_commands_json   TEXT DEFAULT '[]',
  thresholds_json        TEXT DEFAULT '{}',
  timeout_ms             INTEGER,
  remark                 TEXT DEFAULT '',
  sort_order             INTEGER NOT NULL DEFAULT 100,
  last_status            TEXT DEFAULT '',
  last_checked_at        TEXT DEFAULT '',
  created_by             INTEGER REFERENCES users(id),
  updated_by             INTEGER REFERENCES users(id),
  created_at             TEXT DEFAULT (datetime('now','localtime')),
  updated_at             TEXT DEFAULT (datetime('now','localtime')),
  is_deleted             INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_it_devices
  ON it_devices(name, host, os) WHERE is_deleted = 0;
CREATE INDEX IF NOT EXISTS idx_it_devices_enabled ON it_devices(enabled, os);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS it_inspect_settings (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  concurrency      INTEGER NOT NULL DEFAULT 5,
  timeout_ms       INTEGER NOT NULL DEFAULT 90000,
  ssh_port_default INTEGER NOT NULL DEFAULT 22,
  interval_sec     INTEGER NOT NULL DEFAULT 60,
  report_dir       TEXT NOT NULL DEFAULT '',
  thresholds_json  TEXT NOT NULL DEFAULT '{}',
  config_version   INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT DEFAULT (datetime('now','localtime')),
  updated_by       INTEGER REFERENCES users(id)
);
`);

/* ---------------- 小工具 ---------------- */

function parseJson(text, fallback) {
  if (text == null || text === '') return fallback;
  try {
    const v = JSON.parse(text);
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

function isEnc(v) { return typeof v === 'string' && v.indexOf(PREFIX) === 0; }

function toInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** 把 Ninelineslimited 字段规整成字符串，null/undefined 统一为空串 */
function str(v) { return v == null ? '' : String(v); }

/* ---------------- 查询 ---------------- */

const COLUMNS = `id, name, host, os, port, protocol, enabled, location,
  auth_type, auth_username, auth_password, auth_private_key_path, auth_passphrase,
  db_engine, db_version_hint, services_json, custom_commands_json, thresholds_json,
  timeout_ms, remark, sort_order, last_status, last_checked_at,
  created_by, updated_by, created_at, updated_at`;

function listRows(opt) {
  const o = opt || {};
  const where = o.includeDeleted ? '1=1' : 'is_deleted = 0';
  let rows = db.prepare(
    `SELECT ${COLUMNS} FROM it_devices WHERE ${where} ORDER BY sort_order ASC, id ASC`
  ).all();
  if (o.enabledOnly) rows = rows.filter((r) => r.enabled === 1);
  // —— 列表过滤（设备台账页顶部三个控件，前端以 query 传入）——
  // 数据量小（几十台），用内存过滤即可，不引入 SQL LIKE 与转义问题。
  if (o.os) rows = rows.filter((r) => r.os === o.os);
  if (o.kw) {
    const k = String(o.kw).trim().toLowerCase();
    if (k) {
      rows = rows.filter((r) => [r.name, r.host, r.remark, r.location]
        .some((f) => String(f || '').toLowerCase().includes(k)));
    }
  }
  if (o.enabled === '1' || o.enabled === '0') {
    rows = rows.filter((r) => (r.enabled === 1) === (o.enabled === '1'));
  }
  return rows;
}

function getRow(id) {
  return db.prepare(`SELECT ${COLUMNS} FROM it_devices WHERE id = ? AND is_deleted = 0`).get(id) || null;
}

/**
 * 对外视图：密文不出库。
 * 前端拿到的 password 相关信息只有两个布尔值。
 */
function publicView(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    os: row.os,
    osLabel: OS_LABELS[row.os] || row.os,
    port: row.port,
    protocol: row.protocol,
    enabled: row.enabled === 1,
    location: row.location,
    auth_type: row.auth_type,
    auth_username: row.auth_username,
    has_password: !!row.auth_password,
    password_encrypted: isEnc(row.auth_password),
    auth_private_key_path: row.auth_private_key_path,
    has_passphrase: !!row.auth_passphrase,
    db_engine: row.db_engine,
    db_version_hint: row.db_version_hint,
    services: parseJson(row.services_json, []),
    custom_commands: parseJson(row.custom_commands_json, []),
    remark: row.remark,
    sort_order: row.sort_order,
    last_status: row.last_status,
    last_checked_at: row.last_checked_at,
    updated_at: row.updated_at
  };
}

function listDevices(opt) { return listRows(opt).map(publicView); }
function getDevice(id) { return publicView(getRow(id)); }

/* ---------------- 行 → 采集层设备对象 ---------------- */

/**
 * 把一行台账还原成采集层认识的 server 形状。
 * 口令此时仍是密文，由 decryptConfig() 在上层统一解开 —— 与阶段 2 读 JSON 的路径完全一致，
 * 采集层因此不需要做任何修改。
 */
function toServer(row) {
  const s = {
    _device_id: row.id,
    name: row.name,
    host: row.host,
    os: row.os
  };
  if (row.port) s.port = row.port;
  if (str(row.protocol)) s.protocol = row.protocol;

  const auth = {};
  if (str(row.auth_type)) auth.type = row.auth_type;
  if (str(row.auth_username)) auth.username = row.auth_username;
  if (str(row.auth_password)) auth.password = row.auth_password;
  if (str(row.auth_private_key_path)) auth.private_key_path = row.auth_private_key_path;
  if (str(row.auth_passphrase)) auth.passphrase = row.auth_passphrase;
  if (Object.keys(auth).length) s.auth = auth;

  const services = parseJson(row.services_json, []);
  if (Array.isArray(services) && services.length) s.services = services;

  const customs = parseJson(row.custom_commands_json, []);
  if (Array.isArray(customs) && customs.length) s.custom_commands = customs;

  if (str(row.db_engine)) {
    s.db = { engine: row.db_engine, version_hint: str(row.db_version_hint) || 'auto' };
  }
  if (row.timeout_ms) s.timeout_ms = row.timeout_ms;
  return s;
}

/* ---------------- 输入校验与规整 ---------------- */

/**
 * 校验入参并转成列字典。返回 { ok, cols?, errors? }
 *
 * 只做「形状」层面的校验；业务规则（如 database 必须给 db.engine）交给
 * inspect.validateServer —— 那是生产上已经跑了很久的那份规则，不重复实现一遍，
 * 否则两边规则迟早会漂移。
 */
function normalizeInput(p, opts) {
  const o = opts || {};
  const errors = [];
  const pStr = (v) => (v == null ? '' : String(v).trim());

  const name = pStr(p.name);
  const host = pStr(p.host);
  const os = pStr(p.os).toLowerCase();
  if (!name) errors.push('缺少设备名称');
  if (!host) errors.push('缺少主机地址');
  if (!os) errors.push('缺少设备类型');
  else if (OS_TYPES.indexOf(os) < 0) errors.push('设备类型必须是 ' + OS_TYPES.join('、'));

  const port = (p.port === '' || p.port == null) ? null : toInt(p.port, null);
  if (port !== null && (!Number.isFinite(port) || port < 1 || port > 65535)) {
    errors.push('端口必须是 1-65535 之间的整数');
  }

  const services = [];
  if (Array.isArray(p.services)) {
    for (const s of p.services) {
      const nm = pStr(s && s.name);
      if (!nm) continue;
      services.push({ type: pStr(s.type) || 'auto', name: nm });
    }
    if (services.length > 60) errors.push('自定义服务检查最多 60 条');
  }

  const customs = [];
  if (Array.isArray(p.custom_commands)) {
    for (const c of p.custom_commands) {
      const nm = pStr(c && c.name);
      const cmd = pStr(c && c.command);
      if (!nm && !cmd) continue;
      if (!cmd) { errors.push('自定义命令「' + nm + '」缺少命令内容'); continue; }
      customs.push({ name: nm || cmd.slice(0, 20), command: cmd });
    }
    if (customs.length > 30) errors.push('自定义命令最多 30 条');
  }

  if (errors.length) return { ok: false, errors };

  const cols = {
    name, host, os,
    port,
    protocol: pStr(p.protocol).toLowerCase(),
    enabled: p.enabled === false || p.enabled === 0 || p.enabled === '0' ? 0 : 1,
    location: pStr(p.location),
    auth_type: pStr(p.auth_type),
    auth_username: pStr(p.auth_username),
    auth_private_key_path: pStr(p.auth_private_key_path),
    db_engine: pStr(p.db_engine).toLowerCase(),
    db_version_hint: pStr(p.db_version_hint),
    services_json: JSON.stringify(services),
    custom_commands_json: JSON.stringify(customs),
    remark: pStr(p.remark),
    sort_order: toInt(p.sort_order, 100)
  };
  // 口令与密钥口令单独处理（涉及加密），先占位，由调用方填
  if (o.withSecrets) {
    cols.auth_password = str(p.auth_password);
    cols.auth_passphrase = str(p.auth_passphrase);
  }
  return { ok: true, cols, services, customs };
}

/** 与 inspect.validateServer 对齐：把列字典拼成设备对象再跑一遍正式规则 */
function validateWithKernel(cols) {
  try {
    const inspect = require('./inspect');
    const s = toServer(Object.assign({ id: 0 }, cols));
    const errs = inspect.validateServer(s, 0);
    // 内核返回的是「第 N 台 [xxx]: 原因」格式，台账场景下去掉序号前缀
    return errs.map((e) => String(e).replace(/^第\s*\d+\s*台\s*\[[^\]]*\]:\s*/, ''));
  } catch (e) {
    return ['校验器异常：' + ((e && e.message) || e)];
  }
}

/* ---------------- 凭据加密 ---------------- */

/**
 * 用现有主密钥加密明文口令。
 * 主密钥不可用时返回错误 —— 调用方应当中止保存，绝不退回明文。
 */
async function seal(plain) {
  if (plain === '' || plain == null) return { ok: true, value: '' };
  const kr = await secret.loadMasterKeyAsync();
  if (!kr || !kr.ok) {
    return { ok: false, error: '主密钥不可用，无法加密保存口令：' + ((kr && kr.error) || '未知原因') };
  }
  try {
    return { ok: true, value: secret.encryptValue(plain, kr.key) };
  } catch (e) {
    return { ok: false, error: '口令加密失败：' + ((e && e.message) || e) };
  }
}

/* ---------------- 写操作 ---------------- */

async function createDevice(payload, userId) {
  const n = normalizeInput(payload, { withSecrets: true });
  if (!n.ok) return { ok: false, errors: n.errors };

  // 口令处理：留空表示不设置（部分类型如 Windows local 本就不需要）
  const existing = { auth_password: '', auth_passphrase: '' };
  const sealed = await sealInputs(payload, existing);
  if (!sealed.ok) return { ok: false, errors: [sealed.error] };
  Object.assign(n.cols, sealed.cols);

  const kernelErrors = validateWithKernel(n.cols);
  if (kernelErrors.length) return { ok: false, errors: kernelErrors };

  // 唯一性：同一 (name, host, os) 不允许重复
  const dup = db.prepare(
    'SELECT id FROM it_devices WHERE name=? AND host=? AND os=? AND is_deleted=0'
  ).get(n.cols.name, n.cols.host, n.cols.os);
  if (dup) return { ok: false, errors: ['已存在同名同地址的设备（' + n.cols.name + ' / ' + n.cols.host + '）'] };

  const res = db.prepare(`
    INSERT INTO it_devices (name, host, os, port, protocol, enabled, location,
      auth_type, auth_username, auth_password, auth_private_key_path, auth_passphrase,
      db_engine, db_version_hint, services_json, custom_commands_json,
      remark, sort_order, created_by, updated_by)
    VALUES (@name, @host, @os, @port, @protocol, @enabled, @location,
      @auth_type, @auth_username, @auth_password, @auth_private_key_path, @auth_passphrase,
      @db_engine, @db_version_hint, @services_json, @custom_commands_json,
      @remark, @sort_order, @by, @by)
  `).run(Object.assign({ by: userId || null }, n.cols));

  const id = Number(res.lastInsertRowid);
  return { ok: true, id, device: getDevice(id) };
}

async function updateDevice(id, payload, userId) {
  const row = getRow(id);
  if (!row) return { ok: false, errors: ['设备不存在或已被删除'] };

  const merged = Object.assign({}, row, payload);
  const n = normalizeInput(merged, { withSecrets: true });
  if (!n.ok) return { ok: false, errors: n.errors };

  // 口令留空 = 保持原值（这点必须在服务端强制，不能信前端）
  const sealed = await sealInputs(payload, row);
  if (!sealed.ok) return { ok: false, errors: [sealed.error] };
  Object.assign(n.cols, sealed.cols);

  const kernelErrors = validateWithKernel(n.cols);
  if (kernelErrors.length) return { ok: false, errors: kernelErrors };

  const dup = db.prepare(
    'SELECT id FROM it_devices WHERE name=? AND host=? AND os=? AND is_deleted=0 AND id<>?'
  ).get(n.cols.name, n.cols.host, n.cols.os, id);
  if (dup) return { ok: false, errors: ['已存在同名同地址的设备（' + n.cols.name + ' / ' + n.cols.host + '）'] };

  db.prepare(`
    UPDATE it_devices SET
      name=@name, host=@host, os=@os, port=@port, protocol=@protocol,
      enabled=@enabled, location=@location,
      auth_type=@auth_type, auth_username=@auth_username, auth_password=@auth_password,
      auth_private_key_path=@auth_private_key_path, auth_passphrase=@auth_passphrase,
      db_engine=@db_engine, db_version_hint=@db_version_hint,
      services_json=@services_json, custom_commands_json=@custom_commands_json,
      remark=@remark, sort_order=@sort_order,
      updated_by=@by, updated_at=datetime('now','localtime')
    WHERE id=@id AND is_deleted=0
  `).run(Object.assign({ by: userId || null, id }, n.cols));

  return { ok: true, id, device: getDevice(id) };
}

/**
 * 统一处理两个密文字段。
 * 约定：payload 里该字段为空字符串/undefined → 保持库中旧值；有值 → 视为明文，加密后覆盖。
 * 例外：payload 值本身就是 enc:v1: 密文（内部导入用），原样接受。
 */
async function sealInputs(payload, existing) {
  const out = {
    auth_password: str(existing.auth_password),
    auth_passphrase: str(existing.auth_passphrase)
  };
  for (const f of ['auth_password', 'auth_passphrase']) {
    const v = payload[f];
    if (v === undefined || v === null || String(v) === '') continue; // 留空＝不改
    if (isEnc(v)) { out[f] = String(v); continue; }                  // 已是密文，原样保留
    const r = await seal(String(v));
    if (!r.ok) return r;
    out[f] = r.value;
  }
  return { ok: true, cols: out };
}

function deleteDevice(id) {
  // 软删除：巡检历史与后续趋势分析仍要能追溯设备身份，
  // 物理删除会让历史结果里的 device_id 变成悬空引用。
  const res = db.prepare(
    "UPDATE it_devices SET is_deleted=1, enabled=0, updated_at=datetime('now','localtime') WHERE id=? AND is_deleted=0"
  ).run(id);
  return { ok: res.changes > 0 };
}

function setEnabled(id, enabled) {
  const res = db.prepare(
    "UPDATE it_devices SET enabled=?, updated_at=datetime('now','localtime') WHERE id=? AND is_deleted=0"
  ).run(enabled ? 1 : 0, id);
  return { ok: res.changes > 0 };
}

/** 每轮结束后回写 last_status，让台账页能显示"上次巡检结果" */
function updateLastStatus(results) {
  if (!Array.isArray(results) || !results.length) return 0;
  const stmt = db.prepare(
    "UPDATE it_devices SET last_status=?, last_checked_at=datetime('now','localtime') WHERE id=? AND is_deleted=0"
  );
  let begun = false;
  try { db.exec('BEGIN'); begun = true; } catch (e) { /* 已在事务中则沿用外层 */ }
  try {
    let n = 0;
    for (const r of results) {
      const id = Number(r && (r.deviceId || r._device_id || (r.server && r.server._device_id)));
      if (!id) continue;
      const st = !r.ok ? 'error' : (r.status || 'normal');
      if (stmt.run(st, id).changes > 0) n++;
    }
    if (begun) db.exec('COMMIT');
    return n;
  } catch (e) {
    if (begun) { try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ } }
    console.error('>>> 回写设备巡检状态失败：' + ((e && e.message) || e));
    return 0;
  }
}

/* ---------------- 全局设置 ---------------- */

const DEFAULT_THRESHOLDS = require('./inspect').DEFAULT_THRESHOLDS;

function getSettings() {
  const row = db.prepare('SELECT * FROM it_inspect_settings WHERE id=1').get();
  if (!row) {
    return {
      ready: false,
      concurrency: 5, timeout_ms: 90000, ssh_port_default: 22, interval_sec: 60,
      report_dir: '', thresholds: Object.assign({}, DEFAULT_THRESHOLDS), config_version: 0
    };
  }
  return {
    ready: (row.config_version || 0) > 0,
    concurrency: row.concurrency,
    timeout_ms: row.timeout_ms,
    ssh_port_default: row.ssh_port_default,
    interval_sec: row.interval_sec,
    report_dir: row.report_dir,
    thresholds: Object.assign({}, DEFAULT_THRESHOLDS, parseJson(row.thresholds_json, {})),
    config_version: row.config_version,
    updated_at: row.updated_at
  };
}

function saveSettings(p, userId) {
  const cur = getSettings();
  const thresholds = Object.assign({}, cur.thresholds, p.thresholds || {});
  const val = {
    concurrency: Math.max(1, toInt(p.concurrency, cur.concurrency)),
    timeout_ms: Math.max(10000, toInt(p.timeout_ms, cur.timeout_ms)),
    ssh_port_default: Math.max(1, toInt(p.ssh_port_default, cur.ssh_port_default)),
    interval_sec: Math.max(30, toInt(p.interval_sec, cur.interval_sec)),
    report_dir: p.report_dir === undefined ? cur.report_dir : str(p.report_dir),
    thresholds_json: JSON.stringify(thresholds),
    config_version: (cur.config_version || 0) + 1
  };
  db.prepare(`
    INSERT INTO it_inspect_settings (id, concurrency, timeout_ms, ssh_port_default,
      interval_sec, report_dir, thresholds_json, config_version, updated_by,
      updated_at)
    VALUES (1, @concurrency, @timeout_ms, @ssh_port_default, @interval_sec,
      @report_dir, @thresholds_json, @config_version, @by, datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET
      concurrency=@concurrency, timeout_ms=@timeout_ms, ssh_port_default=@ssh_port_default,
      interval_sec=@interval_sec, report_dir=@report_dir, thresholds_json=@thresholds_json,
      config_version=@config_version, updated_by=@by, updated_at=datetime('now','localtime')
  `).run(Object.assign({ by: userId || null }, val));
  return getSettings();
}

/**
 * 回退开关：把 config_version 归零即回到「读 config.json」模式。
 * 这是 plan 里定下的回滚手段，出问题不需要删数据。
 */
function setDbMode(on) {
  const cur = getSettings();
  if (cur.config_version === 0 && !on) return cur;
  const version = on ? Math.max(1, cur.config_version) : 0;
  db.prepare(`
    INSERT INTO it_inspect_settings (id, concurrency, timeout_ms, ssh_port_default,
      interval_sec, report_dir, thresholds_json, config_version, updated_at)
    VALUES (1, @concurrency, @timeout_ms, @ssh_port_default, @interval_sec,
      @report_dir, @thresholds_json, @version, datetime('now','localtime'))
    ON CONFLICT(id) DO UPDATE SET config_version=@version, updated_at=datetime('now','localtime')
  `).run({
    concurrency: cur.concurrency, timeout_ms: cur.timeout_ms,
    ssh_port_default: cur.ssh_port_default, interval_sec: cur.interval_sec,
    report_dir: cur.report_dir,
    thresholds_json: JSON.stringify(cur.thresholds),
    version
  });
  return getSettings().config_version;
}

/** DB 模式是否生效：settings 行存在且 config_version > 0 */
function dbModeReady() { return (getSettings().config_version || 0) > 0; }

/* ---------------- 组装供调度器消费的配置 ---------------- */

async function buildConfig() {
  const rows = listRows({ enabledOnly: true });
  const st = getSettings();
  if (!Array.isArray(rows) || !rows.length) {
    return { servers: [], global: toGlobal(st), __source: 'db' };
  }
  const servers = rows.map(toServer);
  const cfg = { servers, global: toGlobal(st) };
  // 解密走原路径：password 字段此时是密文，解开后才是真口令
  const r = await secret.decryptConfig(cfg);
  const out = r.config;
  out.__source = 'db';
  out.__keyError = r.keyError || null;
  return out;
}

function toGlobal(st) {
  return {
    concurrency: st.concurrency,
    timeout_ms: st.timeout_ms,
    ssh_port_default: st.ssh_port_default,
    interval_sec: st.interval_sec,
    report_dir: st.report_dir,
    thresholds: st.thresholds
  };
}

/** 统计：用于迁移校验与健康检查 */
function stats() {
  const total = db.prepare('SELECT COUNT(*) c FROM it_devices WHERE is_deleted=0').get().c;
  const enabled = db.prepare('SELECT COUNT(*) c FROM it_devices WHERE is_deleted=0 AND enabled=1').get().c;
  const rows = db.prepare('SELECT auth_password, auth_passphrase FROM it_devices WHERE is_deleted=0').all();
  let enc = 0, plain = 0;
  for (const r of rows) {
    for (const f of ['auth_password', 'auth_passphrase']) {
      const v = r[f];
      if (typeof v !== 'string' || !v) continue;
      if (isEnc(v)) enc++; else plain++;
    }
  }
  return { total, enabled, encrypted: enc, plaintext: plain, dbMode: dbModeReady() };
}

module.exports = {
  OS_TYPES, OS_LABELS,
  listDevices, getDevice, getRow, listRows, publicView, toServer,
  createDevice, updateDevice, deleteDevice, setEnabled,
  getSettings, saveSettings, setDbMode, dbModeReady,
  buildConfig, updateLastStatus, stats,
  normalizeInput, validateWithKernel
};
