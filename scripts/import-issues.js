'use strict';
/*
 * 批量导入脚本：读取 import-data.json -> 写入 issues + issue_logs
 * 用法：node scripts/import-issues.js <json路径> [--force]
 * - 为 Excel 负责人自动创建工程师账号（初始口令可用 IMPORT_USER_PASSWORD 指定，登录后请修改）
 * - 生成与系统一致的单号 HIS-YYYYMMDD-NNNN
 * - 按状态生成处理时间线（创建 -> 开始处理 -> 处理记录(解决方法) -> 标记解决）
 * - 幂等保护：库中已有工单时拒绝执行（--force 跳过）
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('../src/db');

const jsonPath = process.argv[2];
const force = process.argv.includes('--force');
if (!jsonPath || !fs.existsSync(jsonPath)) {
  console.error('用法: node scripts/import-issues.js <json路径> [--force]');
  process.exit(1);
}

const dbFile = path.join(__dirname, '..', 'data', 'his.db');
const db = new DatabaseSync(dbFile);
db.exec('PRAGMA foreign_keys = ON;');

const existing = db.prepare('SELECT COUNT(*) AS c FROM issues').get().c;
if (existing > 0 && !force) {
  console.error(`[ABORT] 库中已有 ${existing} 条工单，为避免重复导入已中止。确认重导请加 --force（建议先备份）。`);
  process.exit(1);
}

const rows = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
console.log(`[import] 读取 ${rows.length} 条记录`);

// 1) 为负责人建工程师账号
// 姓名 -> 登录名 映射：需要固定登录名就写在这里，例如 { 张三: 'zhangsan' }；
// 未列出的负责人自动分配 engineerN。初始口令取 IMPORT_USER_PASSWORD，缺省为 ChangeMe@123。
const ACC = {};
const INITIAL_PASSWORD = process.env.IMPORT_USER_PASSWORD || 'ChangeMe@123';
[...new Set(rows.map((r) => r.assignee).filter(Boolean))]
  .forEach((name, i) => { if (!ACC[name]) ACC[name] = 'engineer' + (i + 1); });

const uidMap = {};
const getUser = db.prepare('SELECT id, real_name FROM users WHERE username = ? OR real_name = ?');
const insUser = db.prepare('INSERT INTO users(username, password_hash, salt, real_name, role_id) VALUES (?, ?, ?, ?, 2)');
for (const name of Object.keys(ACC)) {
  let u = getUser.get(ACC[name], name);
  if (!u) {
    const { hash, salt } = hashPassword(INITIAL_PASSWORD);
    const r = insUser.run(ACC[name], hash, salt, name);
    u = { id: Number(r.lastInsertRowid), real_name: name };
    console.log(`[import] 新建工程师账号：${name}（${ACC[name]}）初始口令见 IMPORT_USER_PASSWORD / ChangeMe@123，请登录后修改`);
  } else {
    console.log(`[import] 复用已有账号：${name}（id=${u.id}）`);
  }
  uidMap[name] = u.id;
}

// 2) 导入工单与时间线
const insIssue = db.prepare(`
  INSERT INTO issues(no, title, module, urgency, content, department, reporter, status, assignee_id, assignee_name, created_by, created_at, updated_at)
  VALUES (?, ?, ?, '中', ?, '', ?, ?, ?, ?, 'admin', ?, ?)`);
const insLog = db.prepare(`
  INSERT INTO issue_logs(issue_id, action, content, from_status, to_status, operator_id, operator_name, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const insOpLog = db.prepare('INSERT INTO logs(user_id, username, action, detail, ip) VALUES (1, \'admin\', ?, ?, \'127.0.0.1\')');

const dayCount = {}; // 单号按日期递增
let n = 0;
db.exec('BEGIN');
try {
  for (const r of rows) {
    const d = r.date.replace(/-/g, '');
    dayCount[d] = (dayCount[d] || 0) + 1;
    const no = 'HIS-' + d + '-' + String(dayCount[d]).padStart(4, '0');
    const ts = r.date + ' 00:00:00';
    const assigneeId = r.assignee && uidMap[r.assignee] ? uidMap[r.assignee] : null;
    const operator = r.assignee || '批量导入';
    const opId = assigneeId || null;

    const info = insIssue.run(no, r.title, r.module, r.content, '', r.status, assigneeId, r.assignee, ts, ts);
    const issueId = Number(info.lastInsertRowid);

    // 时间线：创建
    insLog.run(issueId, '创建问题', '创建问题：' + r.title, '', 'pending', opId, operator, ts);
    // 处理中/已解决 -> 开始处理
    if (r.status === 'processing' || r.status === 'resolved') {
      insLog.run(issueId, '开始处理', '（Excel 历史记录导入）', 'pending', 'processing', opId, operator, ts);
    }
    // 解决方法 -> 处理记录
    if (r.solution) {
      insLog.run(issueId, '处理记录', '解决方法：' + r.solution, '', '', opId, operator, ts);
    }
    // 已解决 -> 标记解决
    if (r.status === 'resolved') {
      insLog.run(issueId, '标记解决', '（Excel 历史记录导入：原表状态“已完成”）', 'processing', 'resolved', opId, operator, ts);
    }
    n++;
  }
  const detail = `从 Excel 批量导入历史问题记录：共 ${n} 条`;
  insOpLog.run('批量导入问题', detail);
  db.exec('COMMIT');
  console.log(`[import OK] 已导入 ${n} 条工单`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('[import FAILED]', e.message);
  process.exit(1);
}

// 3) 结果统计
const st = db.prepare('SELECT status, COUNT(*) c FROM issues GROUP BY status').all();
const logs = db.prepare('SELECT COUNT(*) c FROM issue_logs').get().c;
console.log('[verify] issues:', db.prepare('SELECT COUNT(*) c FROM issues').get().c, 'byStatus:', JSON.stringify(st), 'issue_logs:', logs);
db.close();