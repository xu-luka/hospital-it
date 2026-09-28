'use strict';
const express = require('express');
const { db, verifyPassword, hashPassword } = require('../db-contract');
const { signJwt, authRequired } = require('../auth');
const { logAction } = require('../utils');

const router = express.Router();

// 用户信息序列化（兼容合同系 camelCase 与问题系 snake_case 前端字段）
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

// 登录（统一账号体系：合同库 users）
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const name = String(username || '').trim();
  const pwd = String(password || '');
  if (!name || !pwd) return res.status(400).json({ code: 400, message: '请输入用户名和密码' });

  const row = db.prepare(
    `SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.username = ?`
  ).get(name);
  if (!row || !verifyPassword(pwd, row.salt, row.password_hash)) {
    logAction({ id: null, username: name }, '登录', `用户名 ${name} 登录失败`, req.ip);
    return res.status(401).json({ code: 401, message: '用户名或密码错误' });
  }
  if (row.is_active !== 1) return res.status(403).json({ code: 403, message: '账号已停用，请联系管理员' });

  const token = signJwt({ id: row.id, username: row.username, roleId: row.role_id });
  logAction({ id: row.id, username: row.username }, '登录', `用户 ${name} 登录成功`, req.ip);
  res.json({ code: 0, data: { token, user: publicUser(row) } });
});

// 当前用户信息
router.get('/me', authRequired, (req, res) => {
  const row = db.prepare(
    `SELECT u.*, r.name AS role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?`
  ).get(req.user.id);
  if (!row) return res.status(404).json({ code: 404, message: '用户不存在' });
  res.json({ code: 0, data: publicUser(row) });
});

// 修改自己的密码
router.put('/password', authRequired, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return res.status(400).json({ code: 400, message: '请填写原密码和新密码' });
  if (String(newPassword).length < 6) return res.status(400).json({ code: 400, message: '新密码至少 6 位' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user || !verifyPassword(String(oldPassword), user.salt, user.password_hash)) {
    return res.status(400).json({ code: 400, message: '原密码不正确' });
  }
  const { salt, hash } = hashPassword(String(newPassword));
  db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').run(hash, salt, req.user.id);
  logAction({ id: req.user.id, username: req.user.username }, '修改密码', '用户 ' + req.user.username + ' 修改了自己的密码', req.ip);
  res.json({ code: 0, message: '密码修改成功' });
});

module.exports = router;