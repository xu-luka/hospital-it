'use strict';
/**
 * 老库升级自测 —— terminals 表已存在但缺新列时，能不能平安补齐。
 *
 * 为什么单独写：e2e 每次都从空库开始建表，永远走「CREATE TABLE 全新建」这条路，
 * 而真实服务器上已经有上一版建好的表。两者的差别正是最容易翻车的地方 ——
 * 2026-10-30 就踩到一次：新列的索引被写进 CREATE 那一段，老库上执行时
 * 表里还没有 src_key 列，直接抛「no such column: src_key」，
 * 被 ensure() 的 catch 吃掉后整个终端台账模块对外表现为「未就绪」。
 *
 * 用法：node scripts/terminals-migrate-selftest.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'term-mig-'));
const config = require(path.join(ROOT, 'config'));
config.CONTRACT_DB_FILE = path.join(TMP, 'contract.db');
config.DB_FILE = path.join(TMP, 'his.db');
config.INSPECT_DB_FILE = path.join(TMP, 'inspect.db');
config.DOCS_DB_FILE = path.join(TMP, 'docs.db');

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}
function eq(tag, a, b) { ok(tag + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a)); }

/** 上一版（2026-10-30 之前）的建表语句，故意少了全部新列 */
const LEGACY_SQL = `
CREATE TABLE terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'PC',
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sn TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '在用',
  purchase_date TEXT NOT NULL DEFAULT '',
  warranty_end TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  creator_name TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
`;

const NEW_COLS = ['campus', 'area', 'floor', 'stat_category', 'nature', 'ip_extra',
  'produce_date', 'hostname', 'os', 'cpu', 'disk', 'ram', 'monitor',
  'consumable', 'src_key', 'src_sheet', 'import_at'];

(async () => {
  // ---- 1) 先把库文件造成「上一版」的样子 ----
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(TMP, { recursive: true });
  const raw = new DatabaseSync(config.DB_FILE);
  raw.exec(LEGACY_SQL);
  raw.prepare("INSERT INTO terminals(asset_no, name, kind, department, location, mac, status, note)"
    + " VALUES ('OLD-001', '历史遗留工作站', 'PC', '老科室', '一楼东', 'AA-BB-CC-DD-EE-FF', '在用', '升级前就有的记录')")
    .run();
  raw.close();

  console.log('== 准备：库里的 terminals 表是上一版结构（缺 ' + NEW_COLS.length + ' 列），且已有 1 条记录 ==');

  const repo = require(path.join(ROOT, 'src', 'terminals'));
  const { init, getDb } = require(path.join(ROOT, 'src', 'db'));
  init();    // 让 his.db 走一遍正常初始化（建 issues 等表），模拟服务启动
  getDb();

  // ---- 2) ensure() 必须成功 ----
  const r = repo.ensure();
  ok('★ 老库上 ensure() 返回成功（不是「未就绪」）', r === true);

  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name);
  NEW_COLS.forEach((c) => ok('新列已补上：' + c, cols.indexOf(c) >= 0));

  // ---- 3) 老数据必须原样还在 ----
  const old = db.prepare("SELECT * FROM terminals WHERE asset_no = 'OLD-001'").get();
  ok('★ 老记录还在', !!old);
  eq('老记录的备注没被动过', old.note, '升级前就有的记录');
  eq('新列在老记录上是空串（不是 null）', old.campus, '');

  // ---- 4) 升级后照常能用：列表 / 导入 ----
  const list = repo.list({ keyword: '历史遗留' });
  eq('升级后能查到老记录', list.total, 1);
  ok('查出的是整形后的对象（含保修派生字段）', typeof list.list[0].warranty_text === 'string');

  const imp = repo.importRows([{
    __sheet: '计算机', __row: 2,
    department: '儿科', location: '护士站（一）', stat_category: '台式计算机',
    mac: '内网：11-22-33-44-55-66', asset_no: '-', name: '',
  }], { dryRun: false });
  ok('★ 升级后能正常导入', imp.ok === true, JSON.stringify({ created: imp.created }));
  eq('导入新增 1 条', imp.created, 1);
  eq('「-」按空处理', db.prepare("SELECT asset_no FROM terminals WHERE department = '儿科'").get().asset_no, '');
  eq('MAC 前缀被剥掉', db.prepare("SELECT mac FROM terminals WHERE department = '儿科'").get().mac, '11-22-33-44-55-66');

  // ---- 5) 再 ensure() 一次必须幂等（每次请求都会调用） ----
  eq('重复 ensure() 不再改结构', repo.ensure(), true);
  eq('列数没变（没重复加）', db.prepare('PRAGMA table_info(terminals)').all().length, cols.length);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) { console.log('\n失败明细：'); fails.forEach((f) => console.log('  · ' + f)); }
  console.log('========================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('自测异常中断：' + ((e && e.stack) || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
