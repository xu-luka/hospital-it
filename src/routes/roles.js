'use strict';
const express = require('express');
const { db } = require('../db-contract');
const { authRequired, requireRole } = require('../auth');
const { logAction } = require('../utils');

const router = express.Router();
router.use(authRequired);

// GET /api/roles - 角色列表
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM roles ORDER BY id').all();
  res.json({ code: 0, data: rows });
});

// 修改角色名称仅管理员
router.use(requireRole(1));
router.put('/:id', (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ code: 400, message: '角色名称不能为空' });
  const existing = db.prepare('SELECT * FROM roles WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ code: 404, message: '角色不存在' });
  db.prepare('UPDATE roles SET name=? WHERE id=?').run(name, existing.id);
  logAction(req.user, '修改角色', `角色 ${existing.name} -> ${name}`, req.ip);
  res.json({ code: 0 });
});

module.exports = router;