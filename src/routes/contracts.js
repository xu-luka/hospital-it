'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../db-contract');
const { authRequired, guardModule } = require('../auth');
const { logAction } = require('../utils');
const config = require('../../config');

// 读接口要 合同台账.查看，写接口要 合同台账.管理（改造前这里只校验登录，
// 也就是任何登录用户都能改合同 —— 顺带把这口子补上）
router.use(authRequired, guardModule('contracts'));

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

// GET /api/contracts/payment-summary - 付款完成率汇总（须在 /:id 之前）
//
// 单条合同的进度（paid_amount / pay_percent）列表接口早就返回了，缺的是「整体看到什么程度」：
// 全院合同一共该付多少、已经付了多少、有几份一分没付、哪几份还欠最多。
// 口径：
//   · 完成率 = 已付合计 / 合同额合计（只算 amount>0 的合同，否则 0 元合同会把分母拉歪）；
//   · 分档按单份合同的完成率：0% 未付款 / 0<x<100% 部分付款 / >=100% 已付清；
//   · 「已付清」用 >= 而不是 ==：历史数据里偶尔有多付（改造前没拦），不能因此从统计里消失。
router.get('/payment-summary', (req, res) => {
  try {
    const totals = db.prepare(
      `SELECT COUNT(*) AS contracts,
              COALESCE(SUM(CASE WHEN amount > 0 THEN amount ELSE 0 END), 0) AS total_amount,
              COALESCE(SUM(amount), 0) AS all_amount
       FROM contracts`
    ).get();

    // 每份合同的已付金额（一次聚合，避免 N+1）
    const perContract = db.prepare(
      `SELECT c.id, c.contract_no, c.title, c.category, c.status, c.amount, c.end_date,
              COALESCE(p.paid, 0) AS paid
       FROM contracts c
       LEFT JOIN (SELECT contract_id, SUM(amount) AS paid FROM payments GROUP BY contract_id) p
              ON p.contract_id = c.id`
    ).all();

    const paidTotal = perContract.reduce((s, r) => s + (Number(r.paid) || 0), 0);
    const totalAmount = Number(totals.total_amount) || 0;
    const unpaidTotal = Math.max(totalAmount - paidTotal, 0);

    const buckets = { none: 0, partial: 0, full: 0 };
    const byCategory = {};
    const byStatus = {};
    let overdueUnpaid = 0;        // 已到期但未付清的合同数（催款最该盯的）
    const topUnpaid = [];

    perContract.forEach((r) => {
      const amount = Number(r.amount) || 0;
      const paid = Number(r.paid) || 0;
      const pct = amount > 0 ? (paid / amount) * 100 : (paid > 0 ? 100 : 0);
      const unpaid = Math.max(amount - paid, 0);

      if (amount > 0 || paid > 0) {
        if (pct <= 0) buckets.none++;
        else if (pct < 100) buckets.partial++;
        else buckets.full++;
      }

      const cat = String(r.category || '').trim() || '未分类';
      const st = String(r.status || '').trim() || '进行中';
      [
        [byCategory, cat],
        [byStatus, st],
      ].forEach(([map, key]) => {
        const b = map[key] || (map[key] = { name: key, count: 0, amount: 0, paid: 0 });
        b.count++;
        b.amount += amount;
        b.paid += paid;
      });

      if (unpaid > 0) {
        // 到期日已过且没付清 → 属于「该催没催」的
        if (r.end_date) {
          const t = Date.parse(String(r.end_date).replace(/[ T]/g, 'T') + (String(r.end_date).length <= 10 ? 'T00:00:00' : ''));
          if (isFinite(t) && t < Date.now()) overdueUnpaid++;
        }
        topUnpaid.push({
          id: r.id, contract_no: r.contract_no, title: r.title, status: r.status,
          amount: amount, paid: paid, unpaid: unpaid,
          pay_percent: Math.round(pct * 10) / 10, end_date: r.end_date || '',
        });
      }
    });

    const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;
    const finish = (arr) => arr.map((b) => Object.assign({}, b, {
      amount: round1(b.amount),
      paid: round1(b.paid),
      unpaid: round1(Math.max(b.amount - b.paid, 0)),
      pay_percent: b.amount > 0 ? round1((b.paid / b.amount) * 100) : 0,
    })).sort((a, b) => b.amount - a.amount);

    // 本月回款（按 pay_date 落在本月）
    let monthPaid = 0;
    try {
      monthPaid = db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM payments
         WHERE substr(pay_date, 1, 7) = strftime('%Y-%m', 'now', 'localtime')`
      ).get().s;
    } catch (e) { monthPaid = 0; }

    res.json({
      code: 0,
      data: {
        contracts: totals.contracts,
        total_amount: round1(totalAmount),
        paid_amount: round1(paidTotal),
        unpaid_amount: round1(unpaidTotal),
        pay_percent: totalAmount > 0 ? round1((paidTotal / totalAmount) * 100) : 0,
        month_paid: round1(monthPaid),
        buckets: buckets,
        overdue_unpaid: overdueUnpaid,
        by_category: finish(Object.keys(byCategory).map((k) => byCategory[k])),
        by_status: finish(Object.keys(byStatus).map((k) => byStatus[k])),
        top_unpaid: topUnpaid.sort((a, b) => b.unpaid - a.unpaid).slice(0, 10)
          .map((r) => Object.assign({}, r, { amount: round1(r.amount), paid: round1(r.paid), unpaid: round1(r.unpaid) })),
      },
    });
  } catch (e) {
    // 汇算出错不该让合同页打不开，前端会提示但不白屏
    res.json({ code: 0, message: '付款统计失败：' + ((e && e.message) || e), data: null });
  }
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