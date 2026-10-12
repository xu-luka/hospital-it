'use strict';
const express = require('express');
const router = express.Router();
const { db } = require('../db-contract');
const { authRequired, guardModule } = require('../auth');
const config = require('../../config');

// 工作台是各模块统计的汇总页，只要求「工作台.查看」；
// 卡片是否展示由前端按用户实际权限决定（没权限就不请求，也就不会返回数据）
router.use(authRequired, guardModule('dashboard'));

// GET /api/dashboard - 首页统计
router.get('/', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) c FROM contracts').get().c;
  const active = db.prepare("SELECT COUNT(*) c FROM contracts WHERE status='进行中'").get().c;
  const completed = db.prepare("SELECT COUNT(*) c FROM contracts WHERE status='已完成'").get().c;
  const totalAmount = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM contracts').get().s;
  const paidAmount = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments').get().s;
  const unpaidAmount = Math.max(totalAmount - paidAmount, 0);

  // 临期（30天内）
  const expiring = db.prepare(
    `SELECT COUNT(*) c FROM contracts WHERE end_date IS NOT NULL AND end_date != ''
       AND status NOT IN ('已完成','已终止')
       AND julianday(end_date) - julianday('now') BETWEEN 0 AND ?`
  ).get(config.EXPIRE_WARN_DAYS).c;

  // 已过期
  const overdue = db.prepare(
    `SELECT COUNT(*) c FROM contracts WHERE end_date IS NOT NULL AND end_date != ''
       AND status NOT IN ('已完成','已终止')
       AND julianday(end_date) - julianday('now') < 0`
  ).get().c;

  // 分类分布
  const categories = db.prepare(
    `SELECT category, COUNT(*) count FROM contracts WHERE category != '' GROUP BY category ORDER BY count DESC LIMIT 10`
  ).all();

  // 月度新增（近12个月）
  const monthly = db.prepare(
    `SELECT strftime('%Y-%m', created_at) ym, COUNT(*) c FROM contracts
     WHERE created_at >= date('now','-11 months') GROUP BY ym ORDER BY ym`
  ).all();

  res.json({
    code: 0,
    data: {
      total, active, completed, totalAmount, paidAmount, unpaidAmount,
      expiring, overdue,
      categories, monthly
    }
  });
});

module.exports = router;