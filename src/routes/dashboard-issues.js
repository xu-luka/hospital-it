'use strict';
const express = require('express');
const { getDb } = require('../db');
const { authRequired } = require('../auth');

const router = express.Router();
router.use(authRequired);

// 统计总览
router.get('/', (req, res) => {
  const db = getDb();

  const total = db.prepare('SELECT COUNT(*) AS c FROM issues').get().c;
  const today = db.prepare("SELECT COUNT(*) AS c FROM issues WHERE date(created_at) = date('now','localtime')").get().c;
  const byStatus = db.prepare('SELECT status, COUNT(*) AS c FROM issues GROUP BY status').all();
  const byCategory = db.prepare("SELECT COALESCE(category, '日常软件') AS category, COUNT(*) AS c FROM issues GROUP BY COALESCE(category, '日常软件') ORDER BY c DESC").all();
  const byUrgency = db.prepare('SELECT urgency, COUNT(*) AS c FROM issues GROUP BY urgency ORDER BY c DESC').all();

  // 近 30 天每日问题数量（按问题记录时间，缺数日补 0；report_time 为空时兜底取创建日期）
  const dailyRows = db.prepare(`
    SELECT date(COALESCE(NULLIF(report_time, ''), created_at)) AS d, COUNT(*) AS c
    FROM issues
    WHERE date(COALESCE(NULLIF(report_time, ''), created_at)) >= date('now', 'localtime', '-29 day')
    GROUP BY date(COALESCE(NULLIF(report_time, ''), created_at))
  `).all();
  const dailyMap = {};
  dailyRows.forEach((r) => { dailyMap[r.d] = r.c; });
  const daily = [];
  for (let i = 29; i >= 0; i--) {
    const d = db.prepare("SELECT date('now','localtime', ?) AS d").get('-' + i + ' day').d;
    daily.push({ d, c: dailyMap[d] || 0 });
  }

  // 最近动态（合并处理记录与问题创建）
  const recent = db.prepare(`
    SELECT l.id, l.issue_id, i.no, i.title, l.action, l.content, l.operator_name, l.created_at
    FROM issue_logs l JOIN issues i ON i.id = l.issue_id
    ORDER BY l.id DESC LIMIT 8
  `).all();

  const statusMap = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
  res.json({
    code: 0,
    data: {
      total,
      today,
      pending: byStatus.find((s) => s.status === 'pending')?.c || 0,
      processing: byStatus.find((s) => s.status === 'processing')?.c || 0,
      resolved: byStatus.find((s) => s.status === 'resolved')?.c || 0,
      closed: byStatus.find((s) => s.status === 'closed')?.c || 0,
      byCategory,
      byUrgency,
      daily,
      recent,
      statusMap,
    },
  });
});

module.exports = router;