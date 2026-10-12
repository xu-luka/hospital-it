'use strict';
const express = require('express');
const { db } = require('../db-contract');
const { authRequired, requirePerm } = require('../auth');
const { logAction, toSafeText } = require('../utils');
const perm = require('../perm');

const router = express.Router();
router.use(authRequired);

// 内置角色不允许删除（它们的 code 被默认权限矩阵、用户管理的历史逻辑引用）
const BUILTIN_CODES = ['admin', 'engineer', 'user'];

function roleRows() {
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const permMap = perm.getAllRolePerms();
  const counts = {};
  db.prepare('SELECT role_id, COUNT(*) c FROM users GROUP BY role_id').all().forEach((r) => {
    counts[String(r.role_id)] = r.c;
  });
  return roles.map((r) => {
    const isAdmin = String(r.code) === 'admin';
    const perms = isAdmin ? ['*'] : (permMap[String(r.id)] || []);
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      builtin: BUILTIN_CODES.indexOf(String(r.code)) >= 0,
      // 内置管理员权限固定全权，前端把这一行的勾选框置灰
      locked: isAdmin,
      perms: perms,
      permCount: isAdmin ? perm.ALL_PERMS.length : perms.length,
      userCount: counts[String(r.id)] || 0,
    };
  });
}

// GET /api/roles —— 角色列表（用户管理页的角色下拉、角色权限页左侧列表都用它）
// 放宽给 users.manage：没有「角色权限」权限但能管用户的人，也需要选角色
router.get('/', requirePerm('roles.manage', 'users.manage'), (req, res) => {
  res.json({ code: 0, data: roleRows() });
});

// GET /api/roles/meta —— 权限矩阵定义（模块/分组/动作中文名 + 全部合法编码）
router.get('/meta', requirePerm('roles.manage', 'users.manage'), (req, res) => {
  res.json({ code: 0, data: { modules: perm.describeModules(), allPerms: perm.ALL_PERMS } });
});

// 之后的写操作一律要求「角色权限」的管理权限
router.use(requirePerm('roles.manage'));

// POST /api/roles —— 新增角色
router.post('/', (req, res) => {
  const b = req.body || {};
  const name = toSafeText(b.name).slice(0, 40);
  if (name.length < 2) return res.status(400).json({ code: 400, message: '角色名称至少 2 个字' });

  let code = toSafeText(b.code).trim().toLowerCase();
  if (code && !/^[a-z][a-z0-9_]{1,30}$/.test(code)) {
    return res.status(400).json({ code: 400, message: '角色标识只能用英文小写字母、数字、下划线，且以字母开头' });
  }
  if (!code) code = 'custom_' + Date.now().toString(36);
  if (db.prepare('SELECT id FROM roles WHERE code = ?').get(code)) {
    return res.status(400).json({ code: 400, message: '角色标识已存在，换一个' });
  }
  const existName = db.prepare('SELECT id FROM roles WHERE name = ?').get(name);
  if (existName) return res.status(400).json({ code: 400, message: '同名角色已存在' });

  // 新角色默认不含任何权限：由管理员在权限矩阵里勾，避免"建完就能进一堆模块"
  const info = db.prepare('INSERT INTO roles (code, name) VALUES (?, ?)').run(code, name);
  const newId = Number(info.lastInsertRowid);
  const perms = Array.isArray(b.perms) ? b.perms : [];
  if (perms.length) perm.setRolePerms(newId, code, perms);
  logAction(req.user, '新增角色', `角色 ${name}（${code}）`, req.ip);
  res.json({ code: 0, message: '角色已创建', data: { id: newId, code: code, name: name } });
});

// PUT /api/roles/:id —— 改名
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ code: 404, message: '角色不存在' });
  const name = toSafeText((req.body || {}).name).slice(0, 40);
  if (name.length < 2) return res.status(400).json({ code: 400, message: '角色名称至少 2 个字' });
  const dup = db.prepare('SELECT id FROM roles WHERE name = ? AND id <> ?').get(name, id);
  if (dup) return res.status(400).json({ code: 400, message: '同名角色已存在' });
  db.prepare('UPDATE roles SET name = ? WHERE id = ?').run(name, id);
  logAction(req.user, '修改角色', `角色 ${existing.name} -> ${name}`, req.ip);
  res.json({ code: 0, message: '已保存' });
});

// DELETE /api/roles/:id —— 删除角色
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ code: 404, message: '角色不存在' });
  if (BUILTIN_CODES.indexOf(String(existing.code)) >= 0) {
    return res.status(400).json({ code: 400, message: '内置角色（管理员 / 工程师 / 普通用户）不能删除，可以改名' });
  }
  const used = db.prepare('SELECT COUNT(*) c FROM users WHERE role_id = ?').get(id).c;
  if (used > 0) {
    return res.status(400).json({ code: 400, message: '还有 ' + used + ' 个用户属于该角色，请先把他们改到其他角色' });
  }
  db.prepare('DELETE FROM roles WHERE id = ?').run(id);
  perm.removeRolePerms(id); // 级联清理权限行，别留孤儿
  logAction(req.user, '删除角色', `角色 ${existing.name}（${existing.code}）`, req.ip);
  res.json({ code: 0, message: '角色已删除' });
});

// GET /api/roles/:id/perms —— 单角色权限
router.get('/:id/perms', (req, res) => {
  const id = Number(req.params.id);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ code: 404, message: '角色不存在' });
  const info = perm.getRolePerms(role.id, role.code);
  res.json({ code: 0, data: { roleId: role.id, code: role.code, perms: info.perms, source: info.source } });
});

// PUT /api/roles/:id/perms —— 保存角色权限
router.put('/:id/perms', (req, res) => {
  const id = Number(req.params.id);
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  if (!role) return res.status(404).json({ code: 404, message: '角色不存在' });
  const list = (req.body || {}).perms;
  if (!Array.isArray(list)) return res.status(400).json({ code: 400, message: 'perms 必须是数组' });

  const r = perm.setRolePerms(role.id, role.code, list);
  if (!r.ok) return res.status(500).json({ code: 500, message: '保存失败：' + (r.error || '未知原因') });

  // 内置管理员的权限被强制为全权，明确告知，避免用户以为自己没保存上
  logAction(req.user, '修改角色权限', `角色 ${role.name}：共 ${r.perms.length ? (r.perms[0] === '*' ? perm.ALL_PERMS.length : r.perms.length) : 0} 项权限`, req.ip);
  res.json({
    code: 0,
    message: r.forced ? '管理员角色固定拥有全部权限，已忽略本次调整' : '权限已保存',
    data: { perms: r.perms, forced: !!r.forced },
  });
});

module.exports = router;
