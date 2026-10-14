'use strict';
/**
 * bookmarks.js —— 网页书签存储
 *
 * 定位：信息科手上有一堆「内部系统入口 + 对应账号」，散在便签和 Excel 里。
 * 这里把它们收进系统，并且**密码可以按角色单独授权是否可见**：
 * 能看这个模块（bookmarks.view）不等于能看密码（bookmarks.secret）。
 *
 * 三个刻意的设计：
 * 1) **表由本模块自建**，而不是写进 src/db-contract.js。
 *    原因同 perm.js：db-contract.js 是带 schema 的模块、按项目约定不进更新包，
 *    把建表放在这里，书签功能就能自带存储、只替换自己这几个文件就能上线。
 *    表建在 contract.db（= db-contract 的库）→ 自动纳入 scripts/backup.js 的每日备份，不用改备份脚本。
 * 2) **密码列只存密文**，复用设备口令那一套（src/inspection/lib/secret.js，
 *    主密钥由 secrets/KeyVault.exe 用 Windows DPAPI(LocalMachine) 封装，仅驻内存）。
 *    列表/详情接口一律不带密码，明文只从 GET /bookmarks/:id/secret 出来，且要过权限点 + 写操作日志。
 * 3) **加密组件不可用时降级而不是崩**：secret.js 属于巡检那一批文件，
 *    服务器上若只替换了部分文件，它可能装载失败。这里用延迟 require + 缓存失败结果，
 *    保证「书签模块能用（只是存不了密码）」而不是整个路由装载失败。
 */

const { db } = require('./db-contract');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      group_name TEXT NOT NULL DEFAULT '',
      username TEXT NOT NULL DEFAULT '',
      password_enc TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_by INTEGER,
      creator_name TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bookmarks_group ON bookmarks(group_name);
  `);
} catch (e) {
  console.warn('[bookmarks] 创建 bookmarks 表失败：' + ((e && e.message) || e));
}

/**
 * 老库补列：表可能是更早的版本建的（列比现在少）。
 * CREATE TABLE IF NOT EXISTS 对已存在的表不做任何事，缺列会一路走到
 * 「no such column: xxx」这种运行时错误，而且只在某个具体操作上才炸。
 * 这里开机对一遍 PRAGMA，缺谁补谁，比事后现场排查便宜得多。
 */
function ensureColumns(table, spec) {
  const added = [];
  try {
    const have = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
    Object.keys(spec).forEach((col) => {
      if (have.has(col)) return;
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + spec[col]);
      added.push(col);
    });
  } catch (e) {
    console.warn('[bookmarks] 补列失败（不影响已有数据）：' + ((e && e.message) || e));
  }
  if (added.length) console.log('[bookmarks] ' + table + ' 已补列：' + added.join('、'));
  return added;
}

ensureColumns('bookmarks', {
  group_name: "TEXT NOT NULL DEFAULT ''",
  username: "TEXT NOT NULL DEFAULT ''",
  password_enc: "TEXT NOT NULL DEFAULT ''",
  note: "TEXT NOT NULL DEFAULT ''",
  created_by: 'INTEGER',
  creator_name: "TEXT NOT NULL DEFAULT ''",
  created_at: 'TEXT',
  updated_at: 'TEXT',
});

/* ==================== 凭据加解密 ==================== */

// 延迟加载 + 缓存（含失败）：secret.js 属于巡检那批文件，
// 部分替换的部署上它可能缺文件或版本不匹配，不能让它把书签模块连同服务一起拖下去。
let secretLib;
let secretLibTried = false;

function loadSecretLib() {
  if (secretLibTried) return secretLib;
  secretLibTried = true;
  try {
    secretLib = require('./inspection/lib/secret');
  } catch (e) {
    secretLib = null;
    console.warn('[bookmarks] 凭据加密组件不可用，书签将无法保存/查看密码：' + ((e && e.message) || e));
  }
  return secretLib;
}

const NO_LIB = '凭据加密组件不可用（src/inspection/lib/secret.js 未装载），无法保存或查看密码。'
  + '请确认服务器上的 secrets/KeyVault.exe 与 src/inspection/lib/ 完整。';

/** 明文 → enc:v1: 密文。空串表示「这条书签没有密码」，原样存空、不去取密钥。 */
async function encryptSecret(plain) {
  const s = String(plain == null ? '' : plain);
  if (!s) return { ok: true, value: '' };
  const lib = loadSecretLib();
  if (!lib) return { ok: false, error: NO_LIB };
  const kr = await lib.loadMasterKeyAsync();
  if (!kr.ok) return { ok: false, error: kr.error };
  try {
    return { ok: true, value: lib.encryptValue(s, kr.key) };
  } catch (e) {
    return { ok: false, error: '加密失败：' + ((e && e.message) || e) };
  }
}

/** enc:v1: 密文（或历史明文）→ 明文。非 enc:v1: 前缀的值原样返回，不会让老数据立刻失效。 */
async function decryptSecret(value) {
  const v = String(value == null ? '' : value);
  if (!v) return { ok: true, value: '', encrypted: false };
  const lib = loadSecretLib();
  if (!lib) {
    // 没有加密组件时：明文（历史数据）仍然读得出来，密文读不出来（要说清原因，别返回空口令）
    if (!/^enc:v1:/.test(v)) return { ok: true, value: v, encrypted: false };
    return { ok: false, error: NO_LIB };
  }
  if (v.indexOf(lib.PREFIX) !== 0) return { ok: true, value: v, encrypted: false };
  const kr = await lib.loadMasterKeyAsync();
  if (!kr.ok) return { ok: false, error: kr.error };
  return lib.decryptValue(v, kr.key);
}

/* ==================== 工具 ==================== */

function nowLocal() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function trim(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/**
 * 打开用的地址：用户常常只写 `10.1.1.5:8080` 或 `his.hospital.local`。
 * 展示仍用原样的 url（那是他自己写的，改了反而认不出），
 * 只在返回里多给一个补过协议的 open_url 供前端生成链接。
 */
function openUrlOf(url) {
  const u = trim(url);
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return u;
  // //host/path 形式留给浏览器自己按当前协议补
  if (u.indexOf('//') === 0) return u;
  return 'http://' + u;
}

/** 出库统一整形：绝不带 password_enc */
function shape(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name || '',
    url: row.url || '',
    open_url: openUrlOf(row.url),
    group_name: row.group_name || '',
    username: row.username || '',
    has_password: row.password_enc ? 1 : 0,
    note: row.note || '',
    creator_name: row.creator_name || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

/* ==================== 查询 ==================== */

function list(opts) {
  const o = opts || {};
  const kw = trim(o.keyword);
  const group = trim(o.group);
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(o.pageSize) || 50));
  const where = [];
  const params = [];
  if (kw) {
    const lk = '%' + kw + '%';
    where.push('(name LIKE ? OR url LIKE ? OR username LIKE ? OR note LIKE ? OR group_name LIKE ?)');
    params.push(lk, lk, lk, lk, lk);
  }
  if (group) { where.push('group_name = ?'); params.push(group); }
  const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  const total = db.prepare('SELECT COUNT(*) c FROM bookmarks ' + w).get(...params).c;
  const rows = db.prepare(
    'SELECT * FROM bookmarks ' + w
    + ' ORDER BY (group_name = \'\') ASC, group_name ASC, name ASC, id ASC LIMIT ? OFFSET ?'
  ).all(...params, pageSize, (page - 1) * pageSize);

  // 分组清单随列表一起给（省一次往返，且筛选后仍能看到全部分组）
  const groups = db.prepare(
    "SELECT group_name AS name, COUNT(*) AS cnt FROM bookmarks GROUP BY group_name"
    + " ORDER BY (group_name = '') ASC, group_name ASC"
  ).all().map((g) => ({ name: g.name, cnt: g.cnt }));

  return { list: rows.map(shape), total, page, pageSize, groups };
}

function get(id) {
  return db.prepare('SELECT * FROM bookmarks WHERE id = ?').get(Number(id)) || null;
}

/* ==================== 写 ==================== */

function create(data, user) {
  const name = trim(data.name, 80);
  if (!name) return { ok: false, error: '名称不能为空' };
  const url = trim(data.url, 500);
  const info = db.prepare(
    `INSERT INTO bookmarks(name, url, group_name, username, password_enc, note, created_by, creator_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    name, url, trim(data.group_name, 40), trim(data.username, 120),
    String(data.password_enc == null ? '' : data.password_enc), trim(data.note, 500),
    (user && user.id) || null, (user && (user.real_name || user.username)) || '',
    nowLocal(), nowLocal()
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

/**
 * 更新。密码字段的约定（前端据此实现，别改语义）：
 *   password 未传(undefined) → 保持原值不动
 *   password 传空串          → 清空密码
 *   password 传真值          → 覆盖
 * 这样「只改备注」不会把密码抹掉，也不会因为前端没回显密码而丢失。
 */
function update(id, data, patch) {
  const row = get(id);
  if (!row) return { ok: false, error: '书签不存在', notFound: true };
  const name = data.name === undefined ? row.name : trim(data.name, 80);
  if (!name) return { ok: false, error: '名称不能为空' };
  const pwd = (patch && patch.password === undefined) ? row.password_enc
    : String(patch && patch.password_enc != null ? patch.password_enc : '');
  db.prepare(
    `UPDATE bookmarks SET name = ?, url = ?, group_name = ?, username = ?, password_enc = ?,
            note = ?, updated_at = ? WHERE id = ?`
  ).run(
    name,
    data.url === undefined ? row.url : trim(data.url, 500),
    data.group_name === undefined ? row.group_name : trim(data.group_name, 40),
    data.username === undefined ? row.username : trim(data.username, 120),
    pwd,
    data.note === undefined ? row.note : trim(data.note, 500),
    nowLocal(), Number(id)
  );
  return { ok: true, id: Number(id) };
}

function remove(id) {
  const r = db.prepare('DELETE FROM bookmarks WHERE id = ?').run(Number(id));
  return { ok: r.changes > 0 };
}

module.exports = {
  list, get, create, update, remove,
  encryptSecret, decryptSecret, openUrlOf, shape, ensureColumns,
};
