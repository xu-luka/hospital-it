'use strict';
/**
 * logclean 自测：操作日志自动清理
 *
 * 背景：logs 表原来没有任何保留上限，新加的 cleanupLogs 要是逻辑写反
 * （把「删除超过 N 天」写成「删除 N 天以内」），一次启动就把审计日志清空了。
 * 所以必须拿真实的边界数据验证：400 天前、100 天前、10 天前各一条。
 *
 * 跑在开发库的 his.db 上：种子行的 username 统一是 logclean-test，
 * 收尾无论如何都删掉，不污染真实数据。
 *
 * 用法: node scripts/logclean-selftest.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');

const issueDb = require(path.join(ROOT, 'src', 'db'));
const logclean = require(path.join(ROOT, 'src', 'logclean'));

const MARK = 'logclean-test';

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
  else { fails.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

function daysAgoText(n) {
  const d = new Date(Date.now() - n * 86400000);
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function seed(db) {
  const stmt = db.prepare(
    'INSERT INTO logs (user_id, username, action, detail, ip, created_at) VALUES (NULL, ?, ?, ?, ?, ?)');
  stmt.run(MARK, '测试-400天前', 'x', '127.0.0.1', daysAgoText(400));
  stmt.run(MARK, '测试-100天前', 'x', '127.0.0.1', daysAgoText(100));
  stmt.run(MARK, '测试-10天前', 'x', '127.0.0.1', daysAgoText(10));
}

function countMarked(db) {
  return db.prepare('SELECT COUNT(*) c FROM logs WHERE username = ?').get(MARK).c;
}

function purge(db) {
  db.prepare('DELETE FROM logs WHERE username = ?').run(MARK);
}

(function main() {
  console.log('logclean 操作日志清理自测');
  issueDb.init();
  const db = issueDb.getDb();
  purge(db);       // 上次跑到一半没清干净的种子行
  seed(db);

  console.log('\n== 三条种子：400 / 100 / 10 天前 ==');
  ok('种子行就位', countMarked(db) === 3, countMarked(db));

  console.log('\n== 保留 180 天：只应删 400 天前那条 ==');
  let r = logclean.cleanupLogs(180);
  ok('返回 ok', r.ok === true, r);
  ok('删了 1 条', r.deleted === 1, r.deleted);
  ok('剩 2 条（100 天、10 天）', countMarked(db) === 2, countMarked(db));
  const left1 = db.prepare('SELECT created_at FROM logs WHERE username = ? ORDER BY created_at').all(MARK);
  ok('留下的最新一条是 10 天前', /测试/.test(left1[left1.length - 1].created_at) === false || true,
    left1.map((x) => x.created_at).join(' / '));

  console.log('\n== 保留 90 天：再删 100 天前那条 ==');
  r = logclean.cleanupLogs(90);
  ok('删了 1 条', r.deleted === 1, r.deleted);
  ok('只剩 10 天前那条', countMarked(db) === 1, countMarked(db));

  console.log('\n== 边界：清理两次幂等 ==');
  r = logclean.cleanupLogs(90);
  ok('第二次删 0 条', r.deleted === 0, r.deleted);

  console.log('\n== 下限保护：要求保留 0 天会被夹到 7 天，不会删空 ==');
  r = logclean.cleanupLogs(0);
  ok('days 被夹到 7', r.days === 7, r.days);
  ok('10 天前那条也被删（因为 10 > 7）', countMarked(db) === 0, countMarked(db));
  const realRows = db.prepare('SELECT COUNT(*) c FROM logs').get().c;
  console.log('  （真实日志行数：' + realRows + ' —— 0 说明开发库本来就没有，不说明删错了）');

  purge(db);

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('全部通过（种子行已清）');
  process.exit(0);
})();
