'use strict';
/**
 * routes/inspection-netflow.js —— 网络流量监控 API
 *
 * 挂载点 /api/inspection，路径统一以 /netflow 开头。
 *
 * 权限沿用巡检模块的约定：
 *   1 管理员 / 2 工程师 / 3 普通用户
 *   查看（快照、排行、告警、时序、配置）全员可见 —— 流量异常往往要第一时间让所有人看到；
 *   手动触发采集、确认告警限 1/2；改阈值仅 1。
 *
 * 所有查询都做了兜底：库不可用返回空集合而不是 500，
 * 免得流量模块一挂就把整个监控页面变成报错页。
 */
const express = require('express');
const { authRequired } = require('../auth');
const netmon = require('../inspection/netmon');
const store = require('../inspection/netstore');
const netflow = require('../inspection/netflow');
const deviceRepo = require('../inspection/device-repo');
const { logAction } = require('../utils');

const router = express.Router();

function canOperate(u) { return u && (u.role_id === 1 || u.role_id === 2); }
function isAdmin(u) { return u && u.role_id === 1; }

function toInt(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/* ---------------- 可监控的交换机 ---------------- */

// 台账模块未必是最新版（服务器可能只替换了部分文件），字典取不到就退回原始类型值，
// 不要因为一个显示用的标签把整个接口打挂
const OS_LABELS = (deviceRepo && deviceRepo.OS_LABELS) || {};

router.get('/netflow/devices', authRequired, (req, res) => {
  try {
    const rows = deviceRepo.listRows({ enabledOnly: true })
      .filter((r) => r.os === 'switch')
      .map((r) => ({
        id: r.id, name: r.name, host: r.host,
        osLabel: OS_LABELS[r.os] || r.os,
        location: r.location || '', remark: r.remark || ''
      }));
    res.json({ code: 0, data: { items: rows } });
  } catch (e) {
    res.json({ code: 500, message: '读取交换机列表失败：' + ((e && e.message) || e), data: { items: [] } });
  }
});

/* ---------------- 运行态 ---------------- */

router.get('/netflow/status', authRequired, (req, res) => {
  res.json({ code: 0, data: netmon.status() });
});

/* ---------------- 最新快照 ---------------- */

router.get('/netflow/latest', authRequired, (req, res) => {
  const deviceId = req.query.deviceId ? Number(req.query.deviceId) : 0;
  const limit = toInt(req.query.limit, 300, 1, 2000);
  try {
    const r = store.latest(deviceId, limit);
    res.json({ code: 0, data: { at: r.at, items: r.rows } });
  } catch (e) {
    res.json({ code: 500, message: '读取流量快照失败：' + ((e && e.message) || e), data: { at: null, items: [] } });
  }
});

/* ---------------- TopN 排行 ---------------- */

/**
 * ?type=ip   —— 按 IP 排行（只含「端口下仅一个终端」的样本，流量可归属到 IP）
 * ?type=port —— 按端口排行（含多终端端口，看的是哪个口在跑）
 */
router.get('/netflow/top', authRequired, (req, res) => {
  const type = String(req.query.type || 'ip').toLowerCase();
  const minutes = toInt(req.query.minutes, 60, 1, 60 * 24 * 7);
  const limit = toInt(req.query.limit, 20, 1, 200);
  try {
    const items = type === 'port' ? store.topPort({ minutes, limit }) : store.topIp({ minutes, limit });
    res.json({ code: 0, data: { type: type === 'port' ? 'port' : 'ip', minutes, items } });
  } catch (e) {
    res.json({ code: 500, message: '读取排行失败：' + ((e && e.message) || e), data: { items: [] } });
  }
});

/* ---------------- 单端口时序 ---------------- */

router.get('/netflow/series', authRequired, (req, res) => {
  const deviceId = Number(req.query.deviceId);
  const iface = String(req.query.iface || '');
  // 前端传的是原始端口名（GigabitEthernet0/0/1），库里存的是归一化键
  const key = netflow.normIface(iface);
  const minutes = toInt(req.query.minutes, 60, 1, 60 * 24 * 7);
  if (!deviceId || !key) {
    return res.json({ code: 400, message: '缺少 deviceId 或 iface', data: { items: [] } });
  }
  try {
    res.json({
      code: 0,
      data: { deviceId, iface, ifaceKey: key, minutes, items: store.series(deviceId, key, minutes) }
    });
  } catch (e) {
    res.json({ code: 500, message: '读取时序失败：' + ((e && e.message) || e), data: { items: [] } });
  }
});

/* ---------------- 全网趋势（大屏画图用） ---------------- */

router.get('/netflow/trend', authRequired, (req, res) => {
  const minutes = toInt(req.query.minutes, 60, 1, 60 * 24 * 7);
  try {
    res.json({ code: 0, data: { minutes, items: store.trend(minutes) } });
  } catch (e) {
    res.json({ code: 500, message: '读取趋势失败：' + ((e && e.message) || e), data: { items: [] } });
  }
});

/* ---------------- 告警 ---------------- */

router.get('/netflow/alerts', authRequired, (req, res) => {
  const limit = toInt(req.query.limit, 100, 1, 500);
  const unack = String(req.query.unack || '') === '1';
  const deviceId = req.query.deviceId ? Number(req.query.deviceId) : 0;
  try {
    res.json({ code: 0, data: { items: store.listAlerts({ limit, unack, deviceId }) } });
  } catch (e) {
    res.json({ code: 500, message: '读取告警失败：' + ((e && e.message) || e), data: { items: [] } });
  }
});

/** 确认单条 */
router.post('/netflow/alerts/:id/ack', authRequired, (req, res) => {
  if (!canOperate(req.user)) return res.json({ code: 403, message: '无权操作' });
  const r = store.ackAlert(Number(req.params.id), (req.user && req.user.username) || '');
  if (!r.ok) return res.json({ code: 500, message: r.reason || '确认失败' });
  logAction(req, '确认流量告警', { id: Number(req.params.id) });
  res.json({ code: 0, data: { changes: r.changes } });
});

/** 全部确认 */
router.post('/netflow/alerts/ack-all', authRequired, (req, res) => {
  if (!canOperate(req.user)) return res.json({ code: 403, message: '无权操作' });
  const r = store.ackAll((req.user && req.user.username) || '');
  if (!r.ok) return res.json({ code: 500, message: r.reason || '确认失败' });
  logAction(req, '确认全部流量告警', { changes: r.changes });
  res.json({ code: 0, data: { changes: r.changes } });
});

/* ---------------- 手动触发 ---------------- */

router.post('/netflow/run', authRequired, async (req, res) => {
  if (!canOperate(req.user)) return res.json({ code: 403, message: '无权操作' });
  const deviceId = req.body && req.body.deviceId ? Number(req.body.deviceId) : 0;
  const r = await netmon.runOnce({ force: true, deviceId: deviceId });
  logAction(req, '手动采集流量', { deviceId: deviceId || '全部交换机', ok: !!r.ok });
  if (!r.ok && !r.skipped) return res.json({ code: 500, message: r.error || '采集失败', data: r });
  res.json({ code: 0, data: r });
});

/* ---------------- 阈值配置 ---------------- */

router.get('/netflow/config', authRequired, (req, res) => {
  res.json({ code: 0, data: { config: store.getConfig(), defaults: store.DEFAULTS } });
});

/**
 * 只接受 DEFAULTS 里已有的键。
 * 间隔改动会立刻重排定时器，不用重启服务。
 */
router.put('/netflow/config', authRequired, (req, res) => {
  if (!isAdmin(req.user)) return res.json({ code: 403, message: '仅管理员可修改阈值' });
  const patch = (req.body && req.body.config) || req.body || {};
  const r = store.setConfig(patch);
  if (!r.ok) return res.json({ code: 500, message: r.reason || '保存失败' });
  logAction(req, '修改流量阈值', patch);
  // 间隔变了就重排下一轮，否则要等当前这一轮跑完才生效
  if (patch.interval_sec !== undefined) {
    try { netmon.reschedule(); } catch (e) { /* 重排失败不影响配置已保存 */ }
  }
  res.json({ code: 0, data: { config: r.config } });
});

module.exports = router;
