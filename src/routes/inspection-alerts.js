'use strict';
/**
 * routes/inspection-alerts.js —— P3 阈值告警 API
 *
 * 复用巡检模块的权限：读 = inspection.view（guardModule 已覆盖），
 * 写 = inspection.manage。不新增模块、不动 perm.js / authz.js / 菜单。
 *
 * 单独成一个 router 并在 mountInspection 里单独 try/catch 装载：
 * 规则表建在 contract.db、事件表建在 inspect.db，任一库异常时只让告警下线，
 * 绝不能把整个巡检 + 流量监控一起拖垮。
 */
const express = require('express');
const { authRequired, guardModule, hasPerm } = require('../auth');
const alerts = require('../inspection/alerts');
const { logAction } = require('../utils');

const router = express.Router();
router.use(authRequired, guardModule('inspection'));

function canOperate(u) { return hasPerm(u && u.perms, 'inspection.manage'); }
function deny(res) { return res.status(403).json({ code: 403, message: '没有权限执行该操作' }); }

/* ---------------- 规则：全局 + 按设备覆盖 ---------------- */

/** GET /api/inspection/alerts/rules */
router.get('/alerts/rules', (req, res) => {
  res.json({ code: 0, data: { items: alerts.listRules(), defaults: alerts.DEFAULT_RULES.length } });
});

/** POST /api/inspection/alerts/rules —— 新增或按 (metric_key, device_id) 覆盖 */
router.post('/alerts/rules', (req, res) => {
  if (!canOperate(req.user)) return deny(res);
  const r = alerts.upsertRule(req.body || {}, req.user);
  if (!r.ok) return res.status(400).json({ code: 400, message: r.error });
  logAction(req.user, '告警.保存规则', {
    id: r.id, key: String((req.body || {}).metric_key || '').slice(0, 120),
    deviceId: Number((req.body || {}).device_id) || 0
  });
  res.json({ code: 0, message: r.updated ? '规则已更新' : '规则已新增', data: { id: r.id } });
});

/** DELETE /api/inspection/alerts/rules/:id —— 只允许删按设备覆盖的规则 */
router.delete('/alerts/rules/:id', (req, res) => {
  if (!canOperate(req.user)) return deny(res);
  const r = alerts.deleteRule(req.params.id);
  if (!r.ok) return res.status(400).json({ code: 400, message: r.error });
  logAction(req.user, '告警.删除规则', { id: Number(req.params.id) });
  res.json({ code: 0, message: '规则已删除' });
});

/* ---------------- 事件与确认 ---------------- */

/** GET /api/inspection/alerts/events?status=unresolved&limit=50 */
router.get('/alerts/events', (req, res) => {
  res.json({ code: 0, data: alerts.listEvents({ status: req.query.status, limit: req.query.limit }) });
});

/** GET /api/inspection/alerts/summary */
router.get('/alerts/summary', (req, res) => {
  res.json({ code: 0, data: alerts.summary() });
});

/** POST /api/inspection/alerts/events/:id/ack —— 确认（不等于恢复，指标回到正常才恢复） */
router.post('/alerts/events/:id/ack', (req, res) => {
  if (!canOperate(req.user)) return deny(res);
  const r = alerts.ackEvent(req.params.id, req.user, (req.body || {}).note);
  if (!r.ok) return res.status(400).json({ code: 400, message: r.error });
  logAction(req.user, '告警.确认事件', { id: Number(req.params.id) });
  res.json({ code: 0, message: '已确认' });
});

module.exports = router;
