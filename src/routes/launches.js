'use strict';
/**
 * 上线管理路由。
 *
 * 权限：整个路由 guardModule('launches') —— 读要 view、写要 manage。
 * 全员可看是产品决定（哪个系统什么时候上线，全科都该知道），
 * 所以 view 是最低档权限；改状态 / 勾任务 / 增删改都是 manage。
 *
 * 路由顺序：/summary 必须排在 /:id 之前，否则会被当成 id="summary" 吞掉。
 * /tasks/:taskId 是两段路径，不会被 /:id 抢走，但同样放在前面更醒目。
 */
const express = require('express');
const { authRequired, guardModule } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../launches');

const router = express.Router();
router.use(authRequired, guardModule('launches'));

function fail(res, r, fallback) {
  const code = r && r.notFound ? 404 : 400;
  res.status(code).json({ code, message: (r && r.error) || fallback || '操作失败' });
}

// GET /api/launches/summary —— 工作台提醒条（30 天内计划上线 + 试运行中）
router.get('/summary', (req, res) => {
  try {
    res.json({ code: 0, data: repo.summary() });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取上线汇总失败：' + ((e && e.message) || e) });
  }
});

// GET /api/launches —— 列表 + 统计
router.get('/', (req, res) => {
  try {
    res.json({ code: 0, data: repo.list({
      page: req.query.page, pageSize: req.query.pageSize,
      keyword: req.query.keyword, status: req.query.status, year: req.query.year,
    }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取上线列表失败：' + ((e && e.message) || e) });
  }
});

// GET /api/launches/:id —— 详情（含任务清单与状态流水）
router.get('/:id', (req, res) => {
  try {
    const r = repo.get(req.params.id);
    if (r && r.error) return fail(res, r);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取上线详情失败：' + ((e && e.message) || e) });
  }
});

// POST /api/launches —— 新增
router.post('/', (req, res) => {
  try {
    const r = repo.create(req.body || {}, (req.user && req.user.username) || '');
    if (r && r.error) return fail(res, r);
    logAction(req, '新增上线档案', (r.name || '') + ' #' + r.id);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '新增失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/launches/:id —— 编辑台账字段（状态走 /status）
router.put('/:id', (req, res) => {
  try {
    const r = repo.update(req.params.id, req.body || {}, (req.user && req.user.username) || '');
    if (r && r.error) return fail(res, r);
    logAction(req, '修改上线档案', (r.name || '') + ' #' + r.id);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/launches/:id —— 删除（任务与流水一并删）
router.delete('/:id', (req, res) => {
  try {
    const r = repo.remove(req.params.id);
    if (r && r.error) return fail(res, r);
    logAction(req, '删除上线档案', (r.name || '') + ' #' + req.params.id);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

// POST /api/launches/:id/status —— 状态流转（转已回滚必须带 reason）
router.post('/:id/status', (req, res) => {
  try {
    const b = req.body || {};
    const r = repo.setStatus(req.params.id, b.status, b.reason, (req.user && req.user.username) || '');
    if (r && r.error) return fail(res, r);
    logAction(req, '上线状态流转',
      (r.name || '') + ' #' + r.id + ' → ' + (r.status_label || b.status) + (b.reason ? '（' + b.reason + '）' : ''));
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '状态更新失败：' + ((e && e.message) || e) });
  }
});

// POST /api/launches/:id/tasks —— 加一条阶段任务
router.post('/:id/tasks', (req, res) => {
  try {
    const r = repo.addTask(req.params.id, req.body || {});
    if (r && r.error) return fail(res, r);
    logAction(req, '新增上线任务', '#' + req.params.id + ' ' + ((req.body && req.body.title) || ''));
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '新增任务失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/launches/tasks/:taskId —— 改任务 / 勾完成
router.put('/tasks/:taskId', (req, res) => {
  try {
    const r = repo.updateTask(req.params.taskId, req.body || {});
    if (r && r.error) return fail(res, r);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '更新任务失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/launches/tasks/:taskId —— 删任务
router.delete('/tasks/:taskId', (req, res) => {
  try {
    const r = repo.removeTask(req.params.taskId);
    if (r && r.error) return fail(res, r);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除任务失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
