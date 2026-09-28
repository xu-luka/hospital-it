'use strict';
// 技术文档库数据库模块（独立库，与合同库/问题库解耦）
const fs = require('fs');
const path = require('path');
const config = require('../config');

let db = null;

function init() {
  fs.mkdirSync(config.DOCS_UPLOAD_DIR, { recursive: true });
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(config.DATA_DIR, 'docs.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
  CREATE TABLE IF NOT EXISTS doc_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    category_id INTEGER,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL,
    mime TEXT DEFAULT '',
    size INTEGER DEFAULT 0,
    ext TEXT DEFAULT '',
    tags TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    uploaded_by INTEGER,
    uploader_name TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (category_id) REFERENCES doc_categories(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_documents_category ON documents(category_id);
  CREATE INDEX IF NOT EXISTS idx_documents_created ON documents(created_at);
  `);

  migrate();
  seed();
  return db;
}

// 平滑加列：老库缺字段时补上（node:sqlite 无 IF NOT EXISTS 语法，需先查 schema）
function migrate() {
  const addCol = (table, col, def) => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some((c) => c.name === col)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
      }
    } catch (e) {
      console.error(`[db-docs] 补列 ${table}.${col} 失败：`, e.message);
    }
  };
  // real_ext：按文件头嗅探出的真实格式（防 .doc 改名 .docx 导致预览空白）
  addCol('documents', 'real_ext', "TEXT DEFAULT ''");
  // converted_name：旧版 .doc 转出的 docx 文件名（有则按完整排版预览）
  addCol('documents', 'converted_name', "TEXT DEFAULT ''");
}

// 首次运行注入医院信息科常用文档类型（用户可随时增删改）
function seed() {
  try {
    const c = db.prepare('SELECT COUNT(*) AS n FROM doc_categories').get().n;
    if (c === 0) {
      const defaults = ['操作手册', '故障处理', '网络拓扑', '规章制度', '培训材料', '其他'];
      const ins = db.prepare('INSERT INTO doc_categories(name, sort) VALUES (?, ?)');
      defaults.forEach((n, i) => ins.run(n, i));
      console.log('[db-docs] 已初始化默认文档类型 ' + defaults.length + ' 项');
    }
  } catch (e) {
    console.error('[db-docs] 种子数据失败：', e.message);
  }
}

init();

module.exports = { getDb: () => db, raw: db };
