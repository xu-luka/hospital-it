'use strict';
const express = require('express');
const { db, hashPassword } = require('../db-contract');
const { authRequired, requireRole } = require('../auth');
const { logAction, toSafeText, toSafeNum } = require('../utils');

const router = express.Router();

// 只读用户选项（指派处理人下拉等）：管理员/工程师均可访问
// 注意：必须注册在下方 router.use(requireRole(1)) 之前
router.get('/options', authRequired, requireRole(1, 2), (req, res) => {
  // 仅管理员/工程师可作为处理人（普通用户即报障人，不作为指派对象）
  const rows = db.prepare(
    `SELECT u.id, u.username, u.real_name, u.role_id, r.name AS role_name
     FROM users u LEFT JOIN roles r ON u.role_id = r.id
     WHERE u.is_active = 1 AND u.role_id IN (1, 2) ORDER BY u.id`
  ).all();
  res.json({ code: 0, data: rows });
});
router.use(authRequired, requireRole(1));

function publicUser(row) {
  return {
    id: row.id,
    username: row.username,
    real_name: row.real_name || '',
    realName: row.real_name || '',
    role_id: row.role_id,
    roleId: row.role_id,
    role_name: row.role_name || '',
    roleName: row.role_name || '',
    is_active: row.is_active,
    isActive: row.is_active === 1,
    active: row.is_active,
    phone: row.phone || '',
    created_at: row.created_at,
  };
}

// GET /api/users - 用户列表
router.get('/', (req, res) => {
  const rows = db.prepare(
    `SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id ORDER BY u.id`
  ).all();
  res.json({ code: 0, data: rows.map(publicUser) });
});

// POST /api/users - 新增用户
router.post('/', (req, res) => {
  const b = req.body || {};
  const username = toSafeText(b.username);
  const password = toSafeText(b.password);
  if (username.length < 2) return res.status(400).json({ code: 400, message: '用户名至少 2 位' });
  if (password.length < 6) return res.status(400).json({ code: 400, message: '初始密码至少 6 位' });
  const roleId = toSafeNum(b.roleId !== undefined ? b.roleId : b.role_id, 3);
  if (![1, 2, 3].includes(roleId)) return res.status(400).json({ code: 400, message: '角色不合法' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
    return res.status(400).json({ code: 400, message: '用户名已存在' });
  }
  const { salt, hash } = hashPassword(password);
  const realName = toSafeText(b.realName !== undefined ? b.realName : b.real_name);
  const phone = toSafeText(b.phone);
  db.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, phone, created_at) VALUES (?,?,?,?,?,?,datetime('now','localtime'))")
    .run(username, realName, hash, salt, roleId, phone);
  logAction(req.user, '新建用户', `用户名：${username}（${realName || '未填姓名'}）`, req.ip);
  res.json({ code: 0, message: '用户已创建' });
});

// PUT /api/users/:id - 编辑用户（角色/姓名/电话/启停用/重置密码）
router.put('/:id', (req, res) => {
  const id = toSafeNum(req.params.id);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });

  const b = req.body || {};
  if (id === req.user.id && b.is_active === 0) {
    return res.status(400).json({ code: 400, message: '不能停用自己的账号' });
  }

  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ code: 400, message: '新密码至少 6 位' });
    const { salt, hash } = hashPassword(String(b.password));
    db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, id);
    logAction(req.user, '重置密码', `用户 ${user.username}`, req.ip);
  }
  const realName = b.real_name !== undefined ? toSafeText(b.real_name) : user.real_name;
  const phone = b.phone !== undefined ? toSafeText(b.phone) : (user.phone || '');
  const roleId = b.role_id !== undefined ? toSafeNum(b.role_id, user.role_id) : user.role_id;
  const isActive = b.is_active !== undefined ? (b.is_active ? 1 : 0) : user.is_active;
  if (![1, 2, 3].includes(roleId)) return res.status(400).json({ code: 400, message: '角色不合法' });

  db.prepare('UPDATE users SET real_name=?, role_id=?, phone=?, is_active=? WHERE id=?')
    .run(realName, roleId, phone, isActive, id);
  logAction(req.user, '编辑用户', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '已保存' });
});

// PUT /api/users/:id/password - 重置密码（问题系前端兼容）
router.put('/:id/password', (req, res) => {
  const id = toSafeNum(req.params.id);
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
  const pwd = toSafeText(req.body && req.body.password);
  if (pwd.length < 6) return res.status(400).json({ code: 400, message: '新密码至少 6 位' });
  const { salt, hash } = hashPassword(pwd);
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, id);
  logAction(req.user, '重置密码', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '密码已重置' });
});

// DELETE /api/users/:id - 删除用户（禁止删除自己）
router.delete('/:id', (req, res) => {
  const id = toSafeNum(req.params.id);
  if (id === req.user.id) return res.status(400).json({ code: 400, message: '不能删除当前登录账号' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  logAction(req.user, '删除用户', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '已删除' });
});

module.exports = router;