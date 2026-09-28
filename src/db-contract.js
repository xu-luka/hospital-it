'use strict';
// 合同数据库模块（含统一用户/角色/合同/付款/设备/附件/操作日志表）
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// 确保数据与附件目录存在
fs.mkdirSync(path.dirname(config.CONTRACT_DB_FILE), { recursive: true });
fs.mkdirSync(config.CONTRACT_UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(config.CONTRACT_DB_FILE);

// 开启外键约束 / WAL / 忙等待
db.exec('PRAGMA foreign_keys = ON;');
try { db.exec('PRAGMA journal_mode = WAL;'); } catch (e) { console.warn('[db-contract] WAL 模式未启用:', e.message); }
try { db.exec('PRAGMA busy_timeout = 5000;'); } catch (e) {}

// 建表
db.exec(`
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  real_name TEXT DEFAULT '',
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role_id INTEGER NOT NULL DEFAULT 3,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (role_id) REFERENCES roles(id)
);

CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_no TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT DEFAULT '',
  party_a TEXT DEFAULT '',
  party_b TEXT DEFAULT '',
  amount REAL DEFAULT 0,
  sign_date TEXT,
  start_date TEXT,
  end_date TEXT,
  status TEXT DEFAULT '进行中',
  remark TEXT DEFAULT '',
  device_list TEXT DEFAULT '',
  device_count INTEGER DEFAULT 0,
  delivery_req TEXT DEFAULT '',
  accept_date TEXT,
  service_start TEXT,
  service_end TEXT,
  pay_method TEXT DEFAULT '',
  invoice_date TEXT,
  invoice_no TEXT DEFAULT '',
  fund_type TEXT DEFAULT '',
  agency TEXT DEFAULT '',
  fund_source TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  updated_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  filename TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  mime TEXT DEFAULT '',
  size INTEGER DEFAULT 0,
  uploaded_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  model TEXT DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 1,
  unit_price REAL DEFAULT 0,
  remark TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  pay_date TEXT,
  method TEXT DEFAULT '',
  remark TEXT DEFAULT '',
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now','localtime'))
);
`);

// ---------- 老库升级：给已有 contracts 表补新列（幂等） ----------
function migrate() {
  const cols = new Set(db.prepare('PRAGMA table_info(contracts)').all().map(c => c.name));
  const additions = [
    ['device_list',   "TEXT DEFAULT ''"],
    ['device_count',  'INTEGER DEFAULT 0'],
    ['delivery_req',  "TEXT DEFAULT ''"],
    ['accept_date',   'TEXT'],
    ['service_start', 'TEXT'],
    ['service_end',   'TEXT'],
    ['pay_method',    "TEXT DEFAULT ''"],
    ['invoice_date',  'TEXT'],
    ['invoice_no',    "TEXT DEFAULT ''"],
    ['fund_type',     "TEXT DEFAULT ''"],
    ['agency',        "TEXT DEFAULT ''"],
    ['fund_source',   "TEXT DEFAULT ''"]
  ];
  for (const [col, def] of additions) {
    if (!cols.has(col)) db.exec(`ALTER TABLE contracts ADD COLUMN ${col} ${def}`);
  }
  const devCols = new Set(db.prepare('PRAGMA table_info(devices)').all().map(c => c.name));
  if (!devCols.has('unit_price')) db.exec("ALTER TABLE devices ADD COLUMN unit_price REAL DEFAULT 0");
  // 用户体系统一：users 表补 phone 列（兼容问题库用户），幂等
  const userCols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!userCols.has('phone')) db.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");
}
migrate();

// ---------- 密码哈希（scrypt） ----------
function hashPassword(password, salt) {
  if (!salt) salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(h, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ---------- 种子数据：角色 + 初始管理员 ----------
// 初始管理员口令：优先 ADMIN_PASSWORD；未配置时随机生成一次并在各库间复用
// （挂在 config 单例上，与 src/db.js 种出来的是同一个口令）
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
  const roleCount = db.prepare('SELECT COUNT(*) c FROM roles').get().c;
  if (roleCount === 0) {
    db.prepare('INSERT INTO roles (id,code,name) VALUES (?,?,?)').run(1, 'admin', '管理员');
    db.prepare('INSERT INTO roles (id,code,name) VALUES (?,?,?)').run(2, 'engineer', '工程师');
    db.prepare('INSERT INTO roles (id,code,name) VALUES (?,?,?)').run(3, 'user', '普通用户');
  }
  const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  if (userCount === 0) {
    const { salt, hash } = hashPassword(initialAdminPassword());
    db.prepare('INSERT INTO users (username,real_name,password_hash,salt,role_id,created_at) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'))')
      .run(config.ADMIN_USERNAME, '系统管理员', hash, salt, 1);
    if (config.__initialAdminPasswordRandom && !config.__initialAdminPasswordLogged) {
      config.__initialAdminPasswordLogged = true;
      console.log('============================================================');
      console.log('[seed] 初始管理员 ' + config.ADMIN_USERNAME + ' 已创建，随机初始口令：' + initialAdminPassword());
      console.log('[seed] 请登录后立即修改密码；想指定初始口令请设置环境变量 ADMIN_PASSWORD。');
      console.log('============================================================');
    }
  }
}
seed();

module.exports = { db, hashPassword, verifyPassword };