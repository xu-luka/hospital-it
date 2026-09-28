'use strict';
// 问题记录 Excel 导入导出（模板 / 导出 / 导入）
const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const config = require('../../config');
const { getDb } = require('../db');
const { db: contractDb } = require('../db-contract');
const { authRequired } = require('../auth');
const { logAction, toSafeText, genIssueNo } = require('../utils');

router.use(authRequired);

// ---------- 列定义（模板 / 导出 / 导入三端共用） ----------
// stat: true 表示仅导出列，导入时忽略
const COLUMNS = [
  { key: 'no',            name: '单号',         stat: true },
  { key: 'title',         name: '问题标题',     required: true },
  { key: 'category',      name: '问题分类' },
  { key: 'module',        name: '二级模块' },
  { key: 'urgency',       name: '紧急程度' },
  { key: 'department',    name: '报障科室' },
  { key: 'reporter',      name: '报障人' },
  { key: 'content',       name: '问题描述' },
  { key: 'report_time',   name: '问题记录时间', date: true },
  { key: 'status',        name: '状态' },
  { key: 'assignee_name', name: '处理人' },
  { key: 'created_by',    name: '创建人',       stat: true },
];

const STATUS_MAP = { '待处理': 'pending', '处理中': 'processing', '已解决': 'resolved', '已关闭': 'closed' };

// ---------- 值清洗工具 ----------
function safeText(v) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
}
// 日期规范化：支持 Date 对象 / 2026-06-30 / 2026/6/30 / 2026.6.30
function normDate(v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = safeText(v);
  if (!s) return '';
  const m1 = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  return s;
}

// 响应 xlsx 文件
function sendWorkbook(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(filename));
  res.send(buf);
}

// 自定义分类/模块登记（幂等），与 issues.js 同逻辑
function registerCustom(db, category, module) {
  try {
    if (category && !config.CATEGORIES.includes(category)) {
      db.prepare('INSERT OR IGNORE INTO custom_categories(name) VALUES (?)').run(category);
    }
    if (category && module && !(config.SUB_MODULES[category] || []).includes(module)) {
      db.prepare('INSERT OR IGNORE INTO custom_modules(category, name) VALUES (?, ?)').run(category, module);
    }
  } catch (e) { /* ignore */ }
}

// ---------- GET /api/excel-issues/template - 下载导入模板 ----------
router.get('/template', (req, res) => {
  const header = COLUMNS.filter(c => !c.stat).map(c => c.name);

  const examples = [
    ['门诊挂号系统无法登录', '日常软件', '门诊收费系统', '高', '门诊部', '张护士',
     '每天早上8点集中报错，重启后恢复', '2026-09-20', '已解决', '王工'],
    ['三楼检验科打印机卡纸', '日常硬件', '', '低', '检验科', '李医生',
     '西侧打印机频繁卡纸，需更换搓纸轮', '2026-09-21', '处理中', ''],
  ];

  const ws = XLSX.utils.aoa_to_sheet([header, ...examples]);
  ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length * 2 + 6) }));

  const guide = [
    ['问题记录导入模板填写说明'],
    [''],
    ['1. 第一行为表头，请勿修改列名和列顺序'],
    ['2. 必填列：问题标题'],
    ['3. 问题分类可选：日常软件 / 日常硬件 / 政策性接口；留空默认「日常软件」'],
    ['4. 二级模块：可留空（不细分）'],
    ['5. 紧急程度可选：低 / 中 / 高 / 紧急；留空默认「中」'],
    ['6. 状态可选：待处理 / 处理中 / 已解决 / 已关闭；留空默认「待处理」'],
    ['7. 问题记录时间格式：2026-09-20 或 2026/9/20 均可；留空默认当天。单号按该日期自动生成'],
    ['8. 系统中已存在相同单号、或同一记录日期下相同标题的问题将被跳过，不会重复导入'],
    ['9. 导入的问题会按状态自动补全处理流程记录（开始处理 / 标记解决 / 关闭工单）'],
    ['10. 「单号」「创建人」两列为系统导出时的参考列，导入时忽略'],
    ['11. 请删除两行示例数据后再导入'],
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(guide);
  wsGuide['!cols'] = [{ wch: 100 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '问题数据');
  XLSX.utils.book_append_sheet(wb, wsGuide, '填写说明');

  logAction(req, '下载问题导入模板', '');
  sendWorkbook(res, wb, '问题导入模板.xlsx');
});

// ---------- GET /api/excel-issues/export - 按当前筛选导出 ----------
router.get('/export', (req, res) => {
  const db = getDb();
  const where = [];
  const params = [];

  if (req.query.keyword) {
    const k = '%' + String(req.query.keyword).trim() + '%';
    where.push('(i.title LIKE ? OR i.no LIKE ? OR i.department LIKE ? OR i.reporter LIKE ? OR i.content LIKE ?)');
    params.push(k, k, k, k, k);
  }
  if (req.query.status) { where.push('i.status = ?'); params.push(String(req.query.status)); }
  if (req.query.urgency) { where.push('i.urgency = ?'); params.push(String(req.query.urgency)); }
  if (req.query.category) { where.push('i.category = ?'); params.push(String(req.query.category)); }
  if (req.query.module === '__none__') {
    where.push("(i.module = '' OR i.module IS NULL)");
  } else if (req.query.module) {
    where.push('i.module = ?'); params.push(String(req.query.module));
  }
  if (req.query.year) { where.push("strftime('%Y', i.report_time) = ?"); params.push(String(req.query.year)); }
  if (req.query.month) { where.push("strftime('%m', i.report_time) = ?"); params.push(String(req.query.month).padStart(2, '0')); }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`
    SELECT i.* FROM issues i ${whereSql}
    ORDER BY i.report_time DESC, i.id DESC
  `).all(...params);

  const header = COLUMNS.map(c => c.name);
  const data = [header];
  for (const it of rows) {
    data.push([
      it.no, it.title, it.category || '', it.module || '', it.urgency,
      it.department || '', it.reporter || '', it.content || '',
      it.report_time, config.STATUS[it.status] || it.status,
      it.assignee_name || '', it.created_by || '',
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(data);
  ws['!cols'] = header.map(h => ({ wch: Math.max(12, h.length * 2 + 6) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '问题记录');

  logAction(req, '导出问题Excel', `共 ${rows.length} 条（筛选：${whereSql ? '有' : '全部'}）`);
  sendWorkbook(res, wb, `问题记录_${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ---------- POST /api/excel-issues/import - 上传 Excel 导入 ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, message: '未接收到文件' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return res.status(400).json({ code: 400, message: '无法识别的 Excel 文件，请使用系统提供的模板' });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ code: 400, message: 'Excel 中没有工作表' });

  const headerRow = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(h => safeText(h));
  if (!headerRow.includes('问题标题')) {
    return res.status(400).json({ code: 400, message: '表头缺少「问题标题」列，请使用系统提供的模板' });
  }

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) return res.status(400).json({ code: 400, message: '表格中没有数据行（请删除示例后填写真实数据）' });

  const db = getDb();
  const now = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
  const today = now.slice(0, 10);
  const operatorName = req.user.real_name || req.user.username;

  // 处理人姓名 → 合同库用户 id（统一账号体系）
  const userMap = new Map();
  for (const u of contractDb.prepare('SELECT id, real_name, username FROM users WHERE is_active = 1').all()) {
    if (u.real_name) userMap.set(u.real_name, u.id);
    userMap.set(u.username, u.id);
  }

  const insertIssue = db.prepare(`
    INSERT INTO issues(no, title, category, module, urgency, content, department, reporter,
      status, assignee_id, assignee_name, created_by, report_time, created_at, updated_at, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertLog = db.prepare(
    'INSERT INTO issue_logs(issue_id, action, content, from_status, to_status, operator_id, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );

  let success = 0;
  const skipped = [];
  const failed = [];

  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // Excel 实际行号（第 1 行是表头）
    const title = safeText(r['问题标题']);
    if (!title) {
      const hasContent = Object.values(r).some(v => safeText(v));
      if (hasContent) failed.push({ row: rowNo, title: '', reason: '问题标题为空' });
      return;
    }

    // 单号列（从系统导出的文件再导入时）已存在则跳过
    const noIn = safeText(r['单号']);
    if (noIn && db.prepare('SELECT id FROM issues WHERE no = ?').get(noIn)) {
      skipped.push({ row: rowNo, title, reason: '单号已存在' });
      return;
    }

    // 问题记录时间：规范化，空/非法回退当天
    let reportTime = normDate(r['问题记录时间']);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportTime)) reportTime = today;

    // 同记录日期下同标题判重
    if (db.prepare('SELECT id FROM issues WHERE title = ? AND report_time = ?').get(title, reportTime)) {
      skipped.push({ row: rowNo, title, reason: '该记录日期已存在同标题问题' });
      return;
    }

    const category = safeText(r['问题分类']) || '日常软件';
    const module = safeText(r['二级模块']);
    const urgencyRaw = safeText(r['紧急程度']);
    const urgency = config.URGENCY.includes(urgencyRaw) ? urgencyRaw : '中';
    const status = STATUS_MAP[safeText(r['状态'])] || 'pending';
    const assignee = safeText(r['处理人']);
    const assigneeId = assignee ? (userMap.get(assignee) || null) : null;
    const content = safeText(r['问题描述']) || title;

    const no = genIssueNo(db, reportTime);
    try {
      const info = insertIssue.run(
        no, title, category, module, urgency, content,
        safeText(r['报障科室']), safeText(r['报障人']),
        status, assigneeId, assignee, req.user.username,
        reportTime, now, now, status === 'closed' ? now : null
      );
      const id = Number(info.lastInsertRowid);

      // 按状态补全处理流程时间线
      insertLog.run(id, '创建问题', '创建问题：' + title, '', 'pending', req.user.id, operatorName, now);
      if (status === 'processing' || status === 'resolved' || status === 'closed') {
        insertLog.run(id, '开始处理', '（Excel 导入）', 'pending', 'processing', req.user.id, operatorName, now);
      }
      if (status === 'resolved' || status === 'closed') {
        insertLog.run(id, '标记解决', '（Excel 导入）', 'processing', 'resolved', req.user.id, operatorName, now);
      }
      if (status === 'closed') {
        insertLog.run(id, '关闭工单', '（Excel 导入）', 'resolved', 'closed', req.user.id, operatorName, now);
      }
      if (assignee) {
        insertLog.run(id, '指派处理', '指派给：' + assignee, '', '', req.user.id, operatorName, now);
      }

      registerCustom(db, category, module);
      success++;
    } catch (e) {
      failed.push({ row: rowNo, title, reason: e.message.slice(0, 100) });
    }
  });

  logAction(req, '导入问题Excel', `成功 ${success} 条，跳过 ${skipped.length} 条，失败 ${failed.length} 条（文件：${req.file.originalname}）`);
  res.json({ code: 0, data: { success, skipped, failed, total: rows.length } });
});

module.exports = router;