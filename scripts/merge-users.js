'use strict';
// 合并用户：把问题库（his.db）的非管理员用户并入合同库（contract.db）
// 幂等：用户名已存在则跳过；密码哈希格式两库一致（scrypt），可直接复用
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require(path.join(__dirname, '..', 'config'));

const his = new DatabaseSync(config.DB_FILE);
const ctr = new DatabaseSync(config.CONTRACT_DB_FILE);

// 合同库幂等补 phone 列（若没有）
const userCols = new Set(ctr.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
if (!userCols.has('phone')) ctr.exec("ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''");

// 合同库现有用户名
const exist = new Set(ctr.prepare('SELECT username FROM users').all().map((r) => r.username));
const users = his.prepare('SELECT * FROM users').all();

let added = 0, skipped = 0;
const ins = ctr.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, phone, created_at) VALUES (?,?,?,?,?,?,?)");
for (const u of users) {
  if (u.username === 'admin' || exist.has(u.username)) { skipped++; continue; }
  const roleId = (u.role_id && [1, 2, 3].includes(u.role_id)) ? u.role_id : 3;
  ins.run(u.username, u.real_name || '', u.password_hash, u.salt, roleId, u.phone || '', u.created_at);
  added++;
}
console.log(`用户合并完成：新增 ${added}，跳过 ${skipped}（admin/已存在）`);
console.log('合并后账号列表：');
for (const r of ctr.prepare('SELECT id, username, real_name, role_id FROM users ORDER BY id').all()) {
  console.log(`  #${r.id} ${r.username}（${r.real_name || ''}）角色 ${r.role_id}`);
}
his.close();
ctr.close();