'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../db-contract');
const { authRequired, requireRole } = require('../auth');

// 操作日志仅管理员可查
router.use(authRequired, requireRole(1));

// GET /api/logs - 日志列表（分页 + 可选按用户/动作筛选）
router.get('/', (req, res) => {
  const { keyword, action, page = 1, pageSize = 20 } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    const k = `%${keyword}%`;
    where.push('(l.username LIKE ? OR l.detail LIKE ?)');
    params.push(k, k);
  }
  if (action) { where.push('l.action = ?'); params.push(action); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) c FROM logs l ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT l.* FROM logs l ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, offset);
  res.json({ code: 0, data: { list: rows, total, page: pageNum, pageSize: size } });
});

// GET /api/logs/actions - 动作去重列表
router.get('/actions', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM logs ORDER BY action').all();
  res.json({ code: 0, data: rows.map(r => r.action) });
});

module.exports = router;