'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;

function init() {
  if (!fs.existsSync(config.DATA_DIR)) fs.mkdirSync(config.DATA_DIR, { recursive: true });
  if (!fs.existsSync(config.UPLOAD_DIR)) fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });

  const { DatabaseSync } = require('node:sqlite');
  db = new DatabaseSync(config.DB_FILE);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  createTables();
  migrate();
  backfillCategory();
  backfillReportTime();
  backfillAssignee();
  seed();
  fixLegacyFilenames();
  return db;
}

function createTables() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS roles (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    real_name TEXT NOT NULL DEFAULT '',
    role_id INTEGER NOT NULL DEFAULT 3,
    phone TEXT NOT NULL DEFAULT '',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    no TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '日常软件',
    module TEXT NOT NULL DEFAULT '',
    urgency TEXT NOT NULL DEFAULT '中',
    content TEXT NOT NULL DEFAULT '',
    department TEXT NOT NULL DEFAULT '',
    reporter TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    assignee_id INTEGER,
    assignee_name TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL DEFAULT '',
    report_time TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    closed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS issue_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    from_status TEXT NOT NULL DEFAULT '',
    to_status TEXT NOT NULL DEFAULT '',
    operator_id INTEGER,
    operator_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT '',
    uploader_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    username TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    ip TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS custom_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE TABLE IF NOT EXISTS custom_modules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(category, name)
  );
  CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status);
  CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at);
  CREATE INDEX IF NOT EXISTS idx_logs_issue ON issue_logs(issue_id);
  CREATE INDEX IF NOT EXISTS idx_files_issue ON files(issue_id);
  `);
}

// 幂等迁移：只加列，不改列
function migrate() {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const issueCols = cols('issues');
  const fileCols = cols('files');
  const addCol = (table, sql) => {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${sql};`);
    console.log(`[migrate] ${table} + ${sql.split(' ')[0]}`);
  };
  if (!issueCols.includes('closed_at')) addCol('issues', 'closed_at TEXT');
  if (!issueCols.includes('assignee_id')) addCol('issues', 'assignee_id INTEGER');
  if (!issueCols.includes('assignee_name')) addCol('issues', "assignee_name TEXT NOT NULL DEFAULT ''");
  if (!issueCols.includes('created_by')) addCol('issues', "created_by TEXT NOT NULL DEFAULT ''");
  if (!issueCols.includes('category')) addCol('issues', 'category TEXT'); // 一级分类，NULL=待回填
  if (!issueCols.includes('report_time')) addCol('issues', "report_time TEXT NOT NULL DEFAULT ''");
  if (!fileCols.includes('mime')) addCol('files', "mime TEXT NOT NULL DEFAULT ''");
}

// 一级分类回填：老数据按描述中的【来源：xxx表】标注归类；无标注的按模块名推断
function backfillCategory() {
  const rows = db.prepare('SELECT id, module, content FROM issues WHERE category IS NULL').all();
  if (!rows.length) return;
  const upd = db.prepare('UPDATE issues SET category = ?, module = ? WHERE id = ?');
  let n = 0;
  for (const r of rows) {
    const c = String(r.content || '');
    let category = '';
    if (c.includes('【来源：日常软件问题表')) category = '日常软件';
    else if (c.includes('【来源：日常硬件问题表')) category = '日常硬件';
    else if (c.includes('【来源：政策性接口表')) category = '政策性接口';
    else {
      // 无来源标注（手工新建的旧数据），按原模块名推断
      if (r.module === '日常硬件') category = '日常硬件';
      else if (r.module === '政策性接口' || r.module === '医保接口' || r.module === '传染病接口') category = '政策性接口';
      else category = '日常软件';
    }
    // 模块归一化：原值等于分类名本身说明无二级细分，置空
    let module = String(r.module || '');
    if (module === category || ['日常软件', '日常硬件', '政策性接口'].includes(module)) module = '';
    upd.run(category, module, r.id);
    n++;
  }
  console.log(`[migrate] 一级分类回填 ${n} 条`);
}

// 问题记录时间回填：老数据无 report_time 时，用创建时间日期兜底（幂等）
function backfillReportTime() {
  try {
    const rows = db.prepare("SELECT id, created_at FROM issues WHERE report_time IS NULL OR report_time = ''").all();
    if (!rows.length) return;
    const upd = db.prepare("UPDATE issues SET report_time = date(?) WHERE id = ?");
    let n = 0;
    for (const r of rows) {
      const rt = (r.created_at || '').slice(0, 10);
      if (rt) { upd.run(rt, r.id); n++; }
    }
    if (n > 0) console.log(`[migrate] 问题记录时间回填 ${n} 条`);
  } catch (e) {
    console.error('[migrate] 问题记录时间回填失败：', e.message);
  }
}

// 处理人回填：未指派但实际已处理的工单，按处理流程最近操作人回填（幂等）
// 账号唯一体系在合同库，assignee_id 按名字匹配；匹配不到只填名字
function backfillAssignee() {
  try {
    const nameToId = new Map();
    try {
      const contractDb = require('./db-contract').db;
      for (const r of contractDb.prepare('SELECT id, real_name, username FROM users WHERE is_active = 1').all()) {
        if (r.real_name) nameToId.set(r.real_name, r.id);
        nameToId.set(r.username, r.id);
      }
    } catch (e) { /* 合同库不可用时仅填名字 */ }

    const rows = db.prepare("SELECT id FROM issues WHERE assignee_id IS NULL OR assignee_name = ''").all();
    if (!rows.length) return;
    const getOperator = db.prepare(
      `SELECT operator_name FROM issue_logs
       WHERE issue_id = ? AND action IN ('开始处理','标记解决','关闭工单','退回待处理','重新打开')
       ORDER BY id DESC LIMIT 1`
    );
    const upd = db.prepare('UPDATE issues SET assignee_id = ?, assignee_name = ? WHERE id = ?');
    let n = 0;
    for (const r of rows) {
      const op = getOperator.get(r.id);
      if (!op || !op.operator_name) continue;
      upd.run(nameToId.get(op.operator_name) || null, op.operator_name, r.id);
      n++;
    }
    if (n > 0) console.log(`[migrate] 处理人回填 ${n} 条`);
  } catch (e) {
    console.error('[migrate] 处理人回填失败：', e.message);
  }
}

// 初始管理员口令：优先 ADMIN_PASSWORD；未配置时随机生成一次并在各库间复用
// （挂在 config 单例上，保证问题库与合同库种出来的是同一个口令）
function initialAdminPassword() {
  if (!config.__initialAdminPassword) {
    const fixed = String(config.ADMIN_PASSWORD || '').trim();
    config.__initialAdminPassword = fixed
      || crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, '').slice(0, 12);
    config.__initialAdminPasswordRandom = !fixed;
  }
  return config.__initialAdminPassword;
}

function seed() {
  const roleCount = db.prepare('SELECT COUNT(*) AS c FROM roles').get().c;
  if (roleCount === 0) {
    const ins = db.prepare('INSERT INTO roles(id, name) VALUES (?, ?)');
    ins.run(1, '管理员');
    ins.run(2, '工程师');
    ins.run(3, '报障人');
  }
  const admin = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
  if (!admin) {
    const { hash, salt } = hashPassword(initialAdminPassword());
    db.prepare('INSERT INTO users(username, password_hash, salt, real_name, role_id) VALUES (?, ?, ?, ?, ?)')
      .run('admin', hash, salt, '系统管理员', 1);
    if (config.__initialAdminPasswordRandom && !config.__initialAdminPasswordLogged) {
      config.__initialAdminPasswordLogged = true;
      console.log('============================================================');
      console.log('[seed] 初始管理员 admin 已创建，随机初始口令：' + initialAdminPassword());
      console.log('[seed] 请登录后立即修改密码；想指定初始口令请设置环境变量 ADMIN_PASSWORD。');
      console.log('============================================================');
    }
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  const calc = crypto.scryptSync(String(password), salt, 64).toString('hex');
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 中文附件名 latin1 乱码修复：还原为 UTF-8（无 U+FFFD 才采用）
function fixFilename(s) {
  if (!s) return '';
  if (/^[\x00-\x7F]+$/.test(s)) return s;
  try {
    const restored = Buffer.from(s, 'latin1').toString('utf8');
    if (!restored.includes('\uFFFD') && restored !== s) return restored;
  } catch (e) { /* ignore */ }
  return s;
}

function fixLegacyFilenames() {
  try {
    const rows = db.prepare('SELECT id, original_name FROM files').all();
    let n = 0;
    for (const r of rows) {
      const fixed = fixFilename(r.original_name);
      if (fixed !== r.original_name) {
        db.prepare('UPDATE files SET original_name = ? WHERE id = ?').run(fixed, r.id);
        n++;
      }
    }
    if (n > 0) console.log(`[fixFilename] 修复历史乱码附件名 ${n} 条`);
  } catch (e) {
    console.error('[fixup] 修复附件名失败：', e.message);
  }
}

function getDb() {
  if (!db) throw new Error('数据库尚未初始化');
  return db;
}

module.exports = { init, getDb, hashPassword, verifyPassword, fixFilename };