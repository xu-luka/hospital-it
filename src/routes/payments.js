'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../db-contract');
const { authRequired } = require('../auth');
const { logAction } = require('../utils');

router.use(authRequired);

// 数字安全化：非有限数字一律归为 0
function safeNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return (typeof n === 'number' && isFinite(n)) ? n : 0;
}
function safeText(v) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v);
}

// GET /api/payments/contract/:contractId - 某合同的付款记录
router.get('/contract/:contractId', (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.contractId);
  if (!contract) return res.status(404).json({ code: 404, message: '合同不存在' });
  const rows = db.prepare(
    'SELECT p.*, u.real_name AS creator_name FROM payments p LEFT JOIN users u ON p.created_by=u.id WHERE p.contract_id=? ORDER BY p.pay_date DESC, p.id DESC'
  ).all(contract.id);
  res.json({ code: 0, data: rows });
});

// POST /api/payments - 新增付款记录
router.post('/', (req, res) => {
  const b = req.body || {};
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(b.contract_id);
  if (!contract) return res.status(404).json({ code: 404, message: '合同不存在' });

  const amount = safeNum(b.amount);
  if (amount <= 0) return res.status(400).json({ code: 400, message: '付款金额必须大于 0' });
  if (!b.pay_date) return res.status(400).json({ code: 400, message: '请选择付款日期' });

  // 校验：累计付款不能超过合同金额
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE contract_id=?').get(contract.id).s;
  const total = safeNum(contract.amount);
  if (amount > Math.max(total - paid, 0) && total > 0) {
    return res.status(400).json({ code: 400, message: `付款金额超出未付款余额（剩余未付 ${Math.max(total - paid, 0).toFixed(2)} 元）` });
  }

  const info = db.prepare(
    'INSERT INTO payments (contract_id, amount, pay_date, method, remark, created_by) VALUES (?,?,?,?,?,?)'
  ).run(contract.id, amount, safeText(b.pay_date), safeText(b.method), safeText(b.remark), req.user.id);

  logAction(req, '新增付款', `合同[${contract.contract_no}] ￥${amount} ${b.pay_date || ''}`);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// PUT /api/payments/:id - 修改付款记录
router.put('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ code: 404, message: '付款记录不存在' });

  const b = req.body || {};
  const amount = b.amount !== undefined ? safeNum(b.amount) : safeNum(p.amount);
  if (amount <= 0) return res.status(400).json({ code: 400, message: '付款金额必须大于 0' });

  // 校验：修改后累计不能超合同总额
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(p.contract_id);
  const total = safeNum(contract.amount);
  if (total > 0) {
    const other = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE contract_id=? AND id!=?').get(p.contract_id, p.id).s;
    if (amount > Math.max(total - other, 0)) {
      return res.status(400).json({ code: 400, message: `修改后付款金额超出合同未付余额（剩余未付 ${Math.max(total - other, 0).toFixed(2)} 元）` });
    }
  }

  db.prepare('UPDATE payments SET amount=?, pay_date=?, method=?, remark=? WHERE id=?').run(
    amount,
    safeText(b.pay_date !== undefined ? b.pay_date : p.pay_date),
    safeText(b.method !== undefined ? b.method : p.method),
    safeText(b.remark !== undefined ? b.remark : p.remark),
    p.id
  );
  logAction(req, '修改付款', `合同ID ${p.contract_id} 付款记录 #${p.id}`);
  res.json({ code: 0 });
});

// DELETE /api/payments/:id - 删除付款记录
router.delete('/:id', (req, res) => {
  const p = db.prepare('SELECT * FROM payments WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ code: 404, message: '付款记录不存在' });
  db.prepare('DELETE FROM payments WHERE id=?').run(p.id);
  logAction(req, '删除付款', `合同ID ${p.contract_id} 付款记录 #${p.id} ￥${p.amount}`);
  res.json({ code: 0 });
});

module.exports = router;