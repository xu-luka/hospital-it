'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../db-contract');
const { authRequired } = require('../auth');
const { logAction } = require('../utils');
const config = require('../../config');

router.use(authRequired);

// ---------- 输入安全工具：确保绑定到 SQLite 的值永远合法 ----------
function toSafeNum(v, fallback) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return (typeof n === 'number' && isFinite(n)) ? n : (fallback || 0);
}
function toSafeText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v);
}
function toSafeDate(v) {
  const s = toSafeText(v).trim();
  return s ? s : null;
}

// 付款统计公共子查询：LEFT JOIN 后 c.paid_amount 可用
const PAY_SUBQUERY = `(SELECT contract_id, COALESCE(SUM(amount),0) AS paid_amount FROM payments GROUP BY contract_id) p ON p.contract_id = c.id`;
// 设备数量汇总子查询
const DEVICE_COUNT_SUBQUERY = `(SELECT contract_id, COALESCE(SUM(quantity),0) AS device_total FROM devices GROUP BY contract_id) d ON d.contract_id = c.id`;

// 为合同行附加未付金额与付款进度
function attachPaymentInfo(row) {
  if (!row) return row;
  const total = parseFloat(row.amount) || 0;
  const paid = parseFloat(row.paid_amount) || 0;
  row.paid_amount = paid;
  row.unpaid_amount = Math.max(total - paid, 0);
  row.pay_percent = total > 0 ? Math.round((paid / total) * 1000) / 10 : 0;
  // 设备数量：优先用设备明细汇总，无明细时回退老字段
  if (row.device_total !== undefined) row.device_count = row.device_total;
  return row;
}

// 保存设备明细：整表替换（编辑语义简单，删除后重新插入）
function replaceDevices(contractId, devices) {
  if (!Array.isArray(devices)) return;
  db.prepare('DELETE FROM devices WHERE contract_id=?').run(contractId);
  const stmt = db.prepare('INSERT INTO devices (contract_id, name, model, quantity, unit_price, remark) VALUES (?,?,?,?,?,?)');
  for (const d of devices) {
    if (!d || typeof d !== 'object') continue; // 跳过 null/数字/字符串等异常行
    const name = toSafeText(d.name).trim();
    if (!name) continue; // 跳过空行
    const qty = Math.round(toSafeNum(d.quantity, 1));
    const price = toSafeNum(d.unit_price, 0);
    stmt.run(contractId, name, toSafeText(d.model), (qty > 0 ? qty : 1), (price > 0 ? price : 0), toSafeText(d.remark));
  }
}

// 校验合同字段
function validate(body) {
  const errors = [];
  if (!body.title || !String(body.title).trim()) errors.push('合同名称不能为空');
  if (!body.contract_no || !String(body.contract_no).trim()) errors.push('合同编号不能为空');
  return errors;
}

// GET /api/contracts - 列表 + 筛选 + 分页
router.get('/', (req, res) => {
  const { keyword, category, status, page = 1, pageSize = 10, sort = 'id_desc' } = req.query;
  const where = [];
  const params = [];

  if (keyword) {
    const k = `%${keyword}%`;
    where.push('(c.title LIKE ? OR c.contract_no LIKE ? OR c.party_a LIKE ? OR c.party_b LIKE ?)');
    params.push(k, k, k, k);
  }
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (status) { where.push('c.status = ?'); params.push(status); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderMap = {
    id_desc: 'c.id DESC',
    id_asc: 'c.id ASC',
    end_date_asc: 'c.end_date IS NULL, c.end_date ASC',
    amount_desc: 'c.amount DESC',
    start_date_desc: 'c.start_date DESC'
  };
  const orderSql = orderMap[sort] || orderMap.id_desc;

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 10));
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) c FROM contracts c ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT c.*, u.real_name AS creator_name,
       (SELECT COUNT(*) FROM files f WHERE f.contract_id=c.id) AS file_count,
       (SELECT COUNT(*) FROM devices dv WHERE dv.contract_id=c.id) AS device_kind_count,
       d.device_total,
       p.paid_amount
     FROM contracts c LEFT JOIN users u ON c.created_by=u.id
     LEFT JOIN ${PAY_SUBQUERY}
     LEFT JOIN ${DEVICE_COUNT_SUBQUERY}
     ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`
  ).all(...params, size, offset);

  res.json({ code: 0, data: { list: rows.map(attachPaymentInfo), total, page: pageNum, pageSize: size } });
});

// GET /api/contracts/categories - 分类列表
router.get('/categories', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT category FROM contracts WHERE category != \'\' ORDER BY category').all();
  res.json({ code: 0, data: rows.map(r => r.category) });
});

// GET /api/contracts/expiring - 临期 + 已到期合同（到期提醒）
router.get('/expiring', (req, res) => {
  const warnDays = config.EXPIRE_WARN_DAYS;
  const rows = db.prepare(
    `SELECT c.*, u.real_name AS creator_name,
       (SELECT COUNT(*) FROM files f WHERE f.contract_id=c.id) AS file_count,
       CAST(julianday(c.end_date) - julianday('now') AS INTEGER) AS days_left,
       d.device_total,
       p.paid_amount
     FROM contracts c LEFT JOIN users u ON c.created_by=u.id
     LEFT JOIN ${PAY_SUBQUERY}
     LEFT JOIN ${DEVICE_COUNT_SUBQUERY}
     WHERE c.end_date IS NOT NULL AND c.end_date != '' AND c.status != '已完成' AND c.status != '已终止'
       AND julianday(c.end_date) - julianday('now') <= ?
     ORDER BY c.end_date ASC`
  ).all(warnDays);
  res.json({ code: 0, data: rows.map(attachPaymentInfo) });
});

// GET /api/contracts/:id - 详情 + 附件 + 付款记录
router.get('/:id', (req, res) => {
  const row = db.prepare(
    `SELECT c.*, u.real_name AS creator_name, p.paid_amount, d.device_total
     FROM contracts c LEFT JOIN users u ON c.created_by=u.id
     LEFT JOIN ${PAY_SUBQUERY}
     LEFT JOIN ${DEVICE_COUNT_SUBQUERY}
     WHERE c.id=?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ code: 404, message: '合同不存在' });
  const files = db.prepare('SELECT * FROM files WHERE contract_id=? ORDER BY id DESC').all(row.id);
  const payments = db.prepare('SELECT * FROM payments WHERE contract_id=? ORDER BY pay_date DESC, id DESC').all(row.id);
  const devices = db.prepare('SELECT * FROM devices WHERE contract_id=? ORDER BY id ASC').all(row.id);
  res.json({ code: 0, data: { ...attachPaymentInfo(row), files, payments, devices } });
});

// 新增/修改共用的扩展字段定义：[字段名, 是否文本(非文本为数字)]
const EXT_TEXT_FIELDS = ['delivery_req','pay_method','invoice_no','fund_type','agency','fund_source'];
const EXT_DATE_FIELDS = ['accept_date','service_start','service_end','invoice_date'];

// 从请求体安全取扩展字段值
function pickExt(body) {
  const vals = {};
  for (const f of EXT_TEXT_FIELDS) vals[f] = toSafeText(body[f]);
  for (const f of EXT_DATE_FIELDS) vals[f] = toSafeDate(body[f]);
  return vals;
}

// POST /api/contracts - 新增
router.post('/', (req, res) => {
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ code: 400, message: errors.join('；') });

  const b = req.body;
  const e = pickExt(b);
  const info = db.prepare(
    `INSERT INTO contracts (contract_no,title,category,party_a,party_b,amount,sign_date,start_date,end_date,status,remark,
       delivery_req,accept_date,service_start,service_end,pay_method,invoice_date,invoice_no,fund_type,agency,fund_source,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(b.contract_no).trim(), String(b.title).trim(),
    toSafeText(b.category), toSafeText(b.party_a), toSafeText(b.party_b),
    toSafeNum(b.amount, 0), toSafeDate(b.sign_date), toSafeDate(b.start_date), toSafeDate(b.end_date),
    toSafeText(b.status) || '进行中', toSafeText(b.remark),
    e.delivery_req, e.accept_date, e.service_start, e.service_end,
    e.pay_method, e.invoice_date, e.invoice_no, e.fund_type, e.agency, e.fund_source,
    req.user.id
  );
  // 设备明细逐条插入
  replaceDevices(info.lastInsertRowid, b.devices);
  logAction(req, '新增合同', `合同编号 ${b.contract_no} - ${b.title}`);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// PUT /api/contracts/:id - 修改
router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ code: 404, message: '合同不存在' });
  const errors = validate(req.body);
  if (errors.length) return res.status(400).json({ code: 400, message: errors.join('；') });

  // 校验：合同金额不能小于已付款金额
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE contract_id=?').get(existing.id).s;
  const newAmount = toSafeNum(req.body.amount, 0);
  if (newAmount > 0 && paid > newAmount) {
    return res.status(400).json({ code: 400, message: `合同金额不能小于已付款金额（已付 ${paid.toFixed(2)} 元）` });
  }

  const b = req.body;
  const e = pickExt(b);
  db.prepare(
    `UPDATE contracts SET contract_no=?, title=?, category=?, party_a=?, party_b=?, amount=?,
       sign_date=?, start_date=?, end_date=?, status=?, remark=?,
       delivery_req=?, accept_date=?, service_start=?, service_end=?,
       pay_method=?, invoice_date=?, invoice_no=?, fund_type=?, agency=?, fund_source=?,
       updated_at=datetime('now','localtime')
     WHERE id=?`
  ).run(
    String(b.contract_no).trim(), String(b.title).trim(),
    toSafeText(b.category), toSafeText(b.party_a), toSafeText(b.party_b),
    toSafeNum(b.amount, 0), toSafeDate(b.sign_date), toSafeDate(b.start_date), toSafeDate(b.end_date),
    toSafeText(b.status) || '进行中', toSafeText(b.remark),
    e.delivery_req, e.accept_date, e.service_start, e.service_end,
    e.pay_method, e.invoice_date, e.invoice_no, e.fund_type, e.agency, e.fund_source,
    req.params.id
  );
  // 设备明细整表替换
  if (Array.isArray(b.devices)) replaceDevices(existing.id, b.devices);
  logAction(req, '修改合同', `合同编号 ${b.contract_no} - ${b.title}`);
  res.json({ code: 0 });
});

// DELETE /api/contracts/:id - 删除
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ code: 404, message: '合同不存在' });
  // 删除附件文件
  const files = db.prepare('SELECT stored_name FROM files WHERE contract_id=?').all(existing.id);
  db.prepare('DELETE FROM contracts WHERE id=?').run(existing.id); // 附件记录级联删除
  const fs = require('fs');
  const path = require('path');
  for (const f of files) {
    try { fs.unlinkSync(path.join(config.CONTRACT_UPLOAD_DIR, f.stored_name)); } catch (e) {}
  }
  logAction(req, '删除合同', `合同编号 ${existing.contract_no} - ${existing.title}`);
  res.json({ code: 0 });
});

module.exports = router;