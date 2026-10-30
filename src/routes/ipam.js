'use strict';
/**
 * IP 管理路由（网段 + 已用 IP 登记）。
 *
 * 权限：guardModule('ipam') —— 读要 ipam.view、写要 ipam.manage。
 *
 * 三种「算错会很难发现」的情况都在这里给出明确答复而不是默默写下：
 *   · 地址不属于所选网段 → 400，并把网段范围一起说出来
 *   · 同一网段内重复登记 → 400，并指出已登记的那一条
 *   · 地址同时落在另一个网段里 → 允许，但在响应里带一句 warn（全院 /16 与科室 /24 并存很常见）
 */
const express = require('express');
const { authRequired, guardModule } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../ipam');

const router = express.Router();
router.use(authRequired, guardModule('ipam'));

function fail(res, r) {
  const code = r.notFound ? 404 : 400;
  return res.status(code).json({ code, message: r.error });
}

/** 只取白名单字段，避免 body 里塞 ip_num / id 直接落库 */
function pickSeg(b) {
  return {
    name: b.name, cidr: b.cidr, gateway: b.gateway,
    vlan: b.vlan, location: b.location, note: b.note,
  };
}
function pickIp(b) {
  return {
    segment_id: b.segment_id, ip: b.ip, status: b.status, hostname: b.hostname,
    mac: b.mac, owner: b.owner, device_type: b.device_type, note: b.note,
  };
}

/* ==================== 网段 ==================== */

// GET /api/ipam/segments —— 网段列表（含各网段用量统计与重叠提示）
router.get('/segments', (req, res) => {
  try {
    res.json({ code: 0, data: repo.listSegments() });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取网段失败：' + ((e && e.message) || e) });
  }
});

// POST /api/ipam/segments —— 新增网段
router.post('/segments', (req, res) => {
  try {
    const d = pickSeg(req.body || {});
    const r = repo.createSegment(d);
    if (!r.ok) return fail(res, r);
    logAction(req, '新增 IP 网段', String(d.name || '') + ' ' + r.cidr);
    res.json({ code: 0, data: { id: r.id, cidr: r.cidr } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/ipam/segments/:id —— 编辑网段
router.put('/segments/:id', (req, res) => {
  try {
    const d = pickSeg(req.body || {});
    const r = repo.updateSegment(req.params.id, d);
    if (!r.ok) return fail(res, r);
    logAction(req, '修改 IP 网段', String(d.name || '') + ' → ' + r.cidr + ' (#' + req.params.id + ')');
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/ipam/segments/:id —— 删除网段（下面还有登记时禁止）
router.delete('/segments/:id', (req, res) => {
  try {
    const seg = repo.getSegment(req.params.id);
    if (!seg) return res.status(404).json({ code: 404, message: '网段不存在' });
    const r = repo.removeSegment(req.params.id);
    if (!r.ok) return fail(res, r);
    logAction(req, '删除 IP 网段', (seg.name || '') + ' ' + (seg.cidr || ''));
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

// GET /api/ipam/segments/:id/free —— 该网段还能用的地址（前 N 个）
router.get('/segments/:id/free', (req, res) => {
  try {
    const r = repo.freeIpsOfSegment(req.params.id, req.query.limit || 100);
    if (!r.ok) return fail(res, r);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '计算空闲地址失败：' + ((e && e.message) || e) });
  }
});

// GET /api/ipam/segments/:id/map —— 地址分布图所需的格子
// 只读接口，与 /free 同级权限即可（guardModule 已保证 ipam.view）。
// 返回的 cells 是可以直接渲染的成品：state 用 STATUS 的 code（另加 net / bcast
// 两个「不可登记」的边角），前端不需要懂 CIDR、也不需要做 32 位运算。
router.get('/segments/:id/map', (req, res) => {
  try {
    const r = repo.segmentMap(req.params.id);
    if (!r.ok) return fail(res, r);
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '生成地址分布失败：' + ((e && e.message) || e) });
  }
});

/* ==================== IP 登记 ==================== */

// GET /api/ipam/ips —— 登记列表（网段 / 状态 / 关键词 / 来源 / 分页）
// source=all（默认，手工登记 + 终端资产）｜manual｜terminal
router.get('/ips', (req, res) => {
  try {
    res.json({ code: 0, data: repo.listIps({
      segment_id: req.query.segment_id,
      status: req.query.status,
      keyword: req.query.keyword,
      source: req.query.source,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取登记失败：' + ((e && e.message) || e) });
  }
});

// POST /api/ipam/ips —— 登记一条
router.post('/ips', (req, res) => {
  try {
    const d = pickIp(req.body || {});
    const r = repo.createIp(d);
    if (!r.ok) return fail(res, r);
    logAction(req, '登记 IP', r.ip + (d.hostname ? ' ' + d.hostname : ''));
    res.json({ code: 0, data: { id: r.id, ip: r.ip }, message: r.warn || '' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '登记失败：' + ((e && e.message) || e) });
  }
});

// POST /api/ipam/ips/bulk —— 批量登记（粘贴多行 / 区间 / 小网段）
// dry_run=1 时只回预览不落库，方便前端先让用户确认再提交
router.post('/ips/bulk', (req, res) => {
  try {
    const b = req.body || {};
    const segId = Number(b.segment_id) || 0;
    const seg = repo.getSegment(segId);
    if (!seg) return res.status(400).json({ code: 400, message: '请选择网段' });

    const parsed = repo.parseBulk(b.text, { max: b.max });
    const preview = parsed.items.map((it) => ({
      ip: it.ip,
      in_segment: repo.ipInCidr(it.ip, seg.cidr),
      note: it.note,
    }));

    if (b.dry_run) {
      const outside = preview.filter((x) => !x.in_segment).map((x) => x.ip);
      return res.json({
        code: 0,
        data: {
          dry_run: true, total: preview.length, invalid: parsed.invalid,
          outside, valid: preview.filter((x) => x.in_segment).length,
          sample: preview.slice(0, 50),
        },
      });
    }

    const r = repo.bulkCreate(segId, b.text, {
      status: b.status, hostname: b.hostname, owner: b.owner,
      device_type: b.device_type, note: b.note,
    });
    if (!r.ok) return fail(res, r);
    logAction(req, '批量登记 IP', (seg.name || seg.cidr) + '：新增 ' + r.added + ' 条，失败 ' + r.failed.length + ' 条');
    res.json({ code: 0, data: r });
  } catch (e) {
    res.status(500).json({ code: 500, message: '批量登记失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/ipam/ips/:id —— 编辑 / 换网段
router.put('/ips/:id', (req, res) => {
  try {
    const d = pickIp(req.body || {});
    const r = repo.updateIp(req.params.id, d);
    if (!r.ok) return fail(res, r);
    logAction(req, '修改 IP 登记', r.ip + ' (#' + req.params.id + ')');
    res.json({ code: 0, message: r.warn || '' });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/ipam/ips/:id —— 删除登记
router.delete('/ips/:id', (req, res) => {
  try {
    const r = repo.removeIp(req.params.id);
    if (!r.ok) return fail(res, r);
    logAction(req, '删除 IP 登记', '#' + req.params.id);
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
