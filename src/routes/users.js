'use strict';
const express = require('express');
const { db, hashPassword } = require('../db-contract');
const { authRequired, requirePerm } = require('../auth');
const { logAction, toSafeText, toSafeNum } = require('../utils');
const perm = require('../perm');

const router = express.Router();

// ---- 角色相关的两个小工具（角色从此是数据，不再是写死的 1/2/3）----

// 内置管理员角色 id。找不到就返回 0，此时所有「保留管理员」的保护自动放行，
// 宁可少拦也不要把正常操作挡住。
function adminRoleId() {
  try {
    const r = db.prepare("SELECT id FROM roles WHERE code = 'admin'").get();
    return r ? Number(r.id) : 0;
  } catch (e) { return 0; }
}

// 还有几个「启用的管理员」？exceptId 为要排除的用户（正在被降级/停用/删除的那个）
function otherActiveAdmins(exceptId) {
  const aid = adminRoleId();
  if (!aid) return 1;
  const row = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ? AND is_active = 1 AND id <> ?')
    .get(aid, Number(exceptId) || 0);
  return row.c;
}

function roleExists(roleId) {
  const r = db.prepare('SELECT id FROM roles WHERE id = ?').get(Number(roleId));
  return !!r;
}

// 某角色是否具备指定权限（走 perm.js，未配置过的角色会拿到内置默认值，
// 与后端鉴权结果完全一致 —— 不能用 SQL 直接查表，否则「没配过权限的角色」两边判定会打架）
function roleHasPerm(roleId, roleCode, code) {
  return perm.hasPerm(perm.getRolePerms(roleId, roleCode).perms, code);
}

// 只读用户选项（指派处理人下拉等）：凡「能处理工单」的角色下的启用用户都在列。
// 判断依据从写死的 role_id IN (1,2) 改成 issues.manage 权限 —— 以后新建一个
// 「值班工程师」角色，只要有处理权限，就自动出现在指派下拉里。
// 注意：必须注册在下方 router.use(requirePerm('users.manage')) 之前
router.get('/options', authRequired, requirePerm('issues.manage', 'issues.create'), (req, res) => {
  const roles = db.prepare('SELECT id, code, name FROM roles ORDER BY id').all();
  const operable = roles.filter((r) => roleHasPerm(r.id, r.code, 'issues.manage')).map((r) => Number(r.id));
  if (!operable.length) return res.json({ code: 0, data: [] });
  const holes = operable.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT u.id, u.username, u.real_name, u.role_id, r.name AS role_name, r.code AS role_code
     FROM users u LEFT JOIN roles r ON u.role_id = r.id
     WHERE u.is_active = 1 AND u.role_id IN (${holes}) ORDER BY u.id`
  ).all(operable);
  res.json({ code: 0, data: rows });
});

// 之后的用户管理操作一律要求「用户管理」权限
router.use(authRequired, requirePerm('users.manage'));

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
    role_code: row.role_code || '',
    roleCode: row.role_code || '',
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
    `SELECT u.*, r.name AS role_name, r.code AS role_code FROM users u LEFT JOIN roles r ON u.role_id = r.id ORDER BY u.id`
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
  const defRole = db.prepare("SELECT id FROM roles WHERE code = 'user'").get();
  const roleId = toSafeNum(b.roleId !== undefined ? b.roleId : b.role_id, defRole ? defRole.id : 0);
  if (!roleExists(roleId)) return res.status(400).json({ code: 400, message: '角色不合法，请重新选择角色' });
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

  const realName = b.real_name !== undefined ? toSafeText(b.real_name) : user.real_name;
  const phone = b.phone !== undefined ? toSafeText(b.phone) : (user.phone || '');
  const roleId = b.role_id !== undefined ? toSafeNum(b.role_id, user.role_id) : user.role_id;
  const isActive = b.is_active !== undefined ? (b.is_active ? 1 : 0) : user.is_active;
  if (!roleExists(roleId)) return res.status(400).json({ code: 400, message: '角色不合法，请重新选择角色' });

  // 防锁死：不允许把最后一个「启用的管理员」改成别的角色或停用，
  // 否则谁也没法再进「角色权限」页面，只能去改数据库
  const aid = adminRoleId();
  const wasActiveAdmin = aid && Number(user.role_id) === aid && user.is_active === 1;
  const willBeActiveAdmin = aid && Number(roleId) === aid && isActive === 1;
  if (wasActiveAdmin && !willBeActiveAdmin && otherActiveAdmins(id) === 0) {
    return res.status(400).json({ code: 400, message: '这是最后一个启用的管理员，不能停用或改成其他角色' });
  }

  if (b.password) {
    if (String(b.password).length < 6) return res.status(400).json({ code: 400, message: '新密码至少 6 位' });
    const { salt, hash } = hashPassword(String(b.password));
    db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, id);
    logAction(req.user, '重置密码', `用户 ${user.username}`, req.ip);
  }

  db.prepare('UPDATE users SET real_name=?, role_id=?, phone=?, is_active=? WHERE id=?')
    .run(realName, roleId, phone, isActive, id);
  logAction(req.user, '编辑用户', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '已保存' });
});

// PUT /api/users/:id/password - 重置密码（问题系前端兼容）
router.put('/:id/password', (req, res) => {
  const id = toSafeNum(req.params.id);
  const user = db.prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
  const pwd = toSafeText(req.body && req.body.password);
  if (pwd.length < 6) return res.status(400).json({ code: 400, message: '新密码至少 6 位' });
  const { salt, hash } = hashPassword(pwd);
  db.prepare('UPDATE users SET password_hash=?, salt=? WHERE id=?').run(hash, salt, id);
  logAction(req.user, '重置密码', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '密码已重置' });
});

// DELETE /api/users/:id - 删除用户（禁止删除自己，禁止删掉最后一个管理员）
router.delete('/:id', (req, res) => {
  const id = toSafeNum(req.params.id);
  if (id === req.user.id) return res.status(400).json({ code: 400, message: '不能删除当前登录账号' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!user) return res.status(404).json({ code: 404, message: '用户不存在' });
  const aid = adminRoleId();
  if (aid && Number(user.role_id) === aid && user.is_active === 1 && otherActiveAdmins(id) === 0) {
    return res.status(400).json({ code: 400, message: '这是最后一个启用的管理员，不能删除' });
  }
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  logAction(req.user, '删除用户', `用户名：${user.username}`, req.ip);
  res.json({ code: 0, message: '已删除' });
});

module.exports = router;
