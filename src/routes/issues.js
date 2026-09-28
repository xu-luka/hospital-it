'use strict';
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../../config');
const { getDb, fixFilename } = require('../db');
// 统一账号体系在合同库（contract.db users）；问题库 users 仅历史遗留，不再用于业务查询
const { db: contractDb } = require('../db-contract');
const { authRequired, requireRole } = require('../auth');
const { toSafeNum, toSafeText, logAction, genIssueNo } = require('../utils');

const router = express.Router();
router.use(authRequired);

// ---- 附件存储：随机文件名，原名进库 ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 12);
    cb(null, Date.now() + '-' + crypto.randomBytes(6).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE },
});

// ---- 状态流转规则 ----
// pending -> processing -> resolved -> closed；任何状态可退回 pending（重新打开）
const STATUS_TRANSITIONS = {
  pending: ['processing'],
  processing: ['resolved', 'pending'],
  resolved: ['closed', 'pending'],
  closed: ['pending'],
};
const STATUS_ACTIONS = {
  pending_to_processing: '开始处理',
  processing_to_resolved: '标记解决',
  resolved_to_closed: '关闭工单',
  any_to_pending: '重新打开',
  processing_to_pending: '退回待处理',
  resolved_to_pending: '重新打开',
  closed_to_pending: '重新打开',
};

function statusAction(from, to) {
  if (from === 'pending' && to === 'processing') return '开始处理';
  if (from === 'processing' && to === 'resolved') return '标记解决';
  if (from === 'resolved' && to === 'closed') return '关闭工单';
  if (from === 'processing' && to === 'pending') return '退回待处理';
  if (from === 'resolved' && to === 'pending') return '重新打开';
  if (from === 'closed' && to === 'pending') return '重新打开';
  return '状态变更';
}

// 分类与模块校验：预置清单内的用预置；不在清单内的允许自定义（限长度），由调用方登记持久化
function normCategory(v, fallback) {
  const c = toSafeText(v);
  if (!c) return fallback || '日常软件';
  if (config.CATEGORIES.includes(c)) return c;
  return c.length <= 10 ? c : (fallback || '日常软件'); // 自定义分类
}

function normModule(v, category) {
  const m = toSafeText(v);
  if (!m) return '';
  return m.length <= 40 ? m : ''; // 预置或自定义模块
}

// 自定义分类/模块登记（幂等，INSERT OR IGNORE）
function registerCustom(db, category, module) {
  if (category && !config.CATEGORIES.includes(category)) {
    db.prepare('INSERT OR IGNORE INTO custom_categories(name) VALUES (?)').run(category);
  }
  if (category && module && !(config.SUB_MODULES[category] || []).includes(module)) {
    db.prepare('INSERT OR IGNORE INTO custom_modules(category, name) VALUES (?, ?)').run(category, module);
  }
}

function publicIssue(r) {
  const o = Object.assign({}, r, { status_text: config.STATUS[r.status] || r.status });
  if (o.category == null) o.category = '日常软件'; // 老数据兼容，正常已在启动时回填
  if (o.module == null) o.module = '';
  return o;
}

// ---- 分类与模块清单（预置 + 自定义合并，供前端下拉）----
router.get('/modules', (req, res) => {
  const db = getDb();
  const customCats = db.prepare('SELECT name FROM custom_categories ORDER BY id').all().map((r) => r.name);
  const customMods = db.prepare('SELECT category, name FROM custom_modules ORDER BY id').all();
  const subModules = {};
  for (const c of config.CATEGORIES) subModules[c] = [...(config.SUB_MODULES[c] || [])];
  for (const c of customCats) if (!subModules[c]) subModules[c] = [];
  for (const m of customMods) {
    if (!subModules[m.category]) subModules[m.category] = [];
    if (!subModules[m.category].includes(m.name)) subModules[m.category].push(m.name);
  }
  res.json({ code: 0, data: { categories: [...config.CATEGORIES, ...customCats], subModules } });
});

// ---- 列表（分页 + 筛选）----
router.get('/', (req, res) => {
  const db = getDb();
  const page = Math.max(1, toSafeNum(req.query.page, 1));
  const pageSize = Math.min(100, Math.max(1, toSafeNum(req.query.pageSize, 10)));
  const where = [];
  const params = [];

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
  if (req.query.keyword) {
    where.push('(i.title LIKE ? OR i.no LIKE ? OR i.department LIKE ? OR i.reporter LIKE ? OR i.content LIKE ?)');
    const kw = '%' + String(req.query.keyword).trim() + '%';
    params.push(kw, kw, kw, kw, kw);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) AS c FROM issues i ${whereSql}`).get(...params).c;
  const rows = db.prepare(`
    SELECT i.*
    FROM issues i
    ${whereSql}
    ORDER BY i.report_time DESC, i.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (page - 1) * pageSize);

  res.json({ code: 0, data: { total, page, pageSize, list: rows.map(publicIssue) } });
});

// 有数据的年份清单（按年月筛选下拉用）；须注册在 /:id 之前
router.get('/meta/years', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT DISTINCT strftime('%Y', report_time) AS y FROM issues
     WHERE report_time IS NOT NULL AND report_time != '' ORDER BY y DESC`
  ).all();
  res.json({ code: 0, data: rows.map((r) => r.y) });
});

// 批量状态流转（工程师/管理员）：逐条校验合法流转，不合法的跳过并回报
// 注意：必须在 /:id 系列路由之前注册，否则 /batch 会被当作 :id 吞掉
router.post('/batch/status', requireRole(1, 2), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids.map((x) => toSafeNum(x)).filter((x) => x > 0) : [];
  const to = String(b.status || '');
  const note = toSafeText(b.content);

  if (!ids.length) return res.status(400).json({ code: 400, message: '请先勾选要操作的问题' });
  if (ids.length > 200) return res.status(400).json({ code: 400, message: '单次最多批量操作 200 条' });
  if (!Object.keys(config.STATUS).includes(to)) return res.status(400).json({ code: 400, message: '目标状态不合法' });

  const getIssue = db.prepare('SELECT * FROM issues WHERE id = ?');
  const upd = db.prepare("UPDATE issues SET status=?, updated_at=?, closed_at=? WHERE id=?");
  const insLog = db.prepare('INSERT INTO issue_logs(issue_id, action, content, from_status, to_status, operator_id, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const now = db.prepare("SELECT datetime('now','localtime') AS t").get().t;

  const ok = [];
  const skipped = [];
  db.exec('BEGIN');
  try {
    for (const id of ids) {
      const issue = getIssue.get(id);
      if (!issue) { skipped.push({ no: '#' + id, reason: '问题不存在' }); continue; }
      const allowed = STATUS_TRANSITIONS[issue.status] || [];
      if (!allowed.includes(to)) {
        skipped.push({ no: issue.no, reason: `当前「${config.STATUS[issue.status]}」不允许变更为「${config.STATUS[to]}」` });
        continue;
      }
      const action = statusAction(issue.status, to);
      upd.run(to, now, to === 'closed' ? now : issue.closed_at, id);
      insLog.run(id, action, note, issue.status, to, req.user.id, req.user.real_name || req.user.username, now);
      ok.push(issue.no);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return res.status(500).json({ code: 500, message: '批量操作失败：' + e.message });
  }

  if (ok.length) {
    logAction(req.user, '批量状态变更', `${ok.length} 条 → ${config.STATUS[to]}（${ok.join('、')}）`, req.ip);
  }
  res.json({
    code: 0,
    data: { okCount: ok.length, okNos: ok, skippedCount: skipped.length, skipped },
    message: `成功 ${ok.length} 条` + (skipped.length ? `，跳过 ${skipped.length} 条（状态不允许）` : ''),
  });
});

// ---- 新建问题 ----
router.post('/', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const title = toSafeText(b.title);
  if (!title) return res.status(400).json({ code: 400, message: '请填写问题标题' });
  const category = normCategory(b.category);
  const module = normModule(b.module, category);
  const urgency = config.URGENCY.includes(toSafeText(b.urgency)) ? toSafeText(b.urgency) : '中';
  const content = toSafeText(b.content) || title;

  // 问题记录时间：默认今天；单号按该记录时间的日期生成（支持补录历史问题）
  let reportTime = toSafeText(b.reportTime).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(reportTime)) {
    reportTime = db.prepare("SELECT date('now','localtime') AS d").get().d;
  }
  const no = genIssueNo(db, reportTime);
  const now = db.prepare("SELECT datetime('now','localtime') AS t").get().t;
  const info = db.prepare(`
    INSERT INTO issues(no, title, category, module, urgency, content, department, reporter, status, created_by, report_time, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(no, title, category, module, urgency, content, toSafeText(b.department), toSafeText(b.reporter), req.user.username, reportTime, now, now);
  registerCustom(db, category, module); // 自定义分类/模块持久化，下次下拉可见
  const id = Number(info.lastInsertRowid);

  db.prepare('INSERT INTO issue_logs(issue_id, action, content, to_status, operator_id, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, '创建问题', '创建问题：' + title, 'pending', req.user.id, req.user.real_name || req.user.username, now);
  logAction(req.user, '新建问题', `单号 ${no}：${title}`, req.ip);
  res.json({ code: 0, data: { id, no } });
});

// 详情（含处理流程 + 附件）
router.get('/:id', (req, res) => {
  const db = getDb();
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(toSafeNum(req.params.id));
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });
  const logs = db.prepare('SELECT * FROM issue_logs WHERE issue_id = ? ORDER BY id ASC').all(issue.id);
  const files = db.prepare('SELECT * FROM files WHERE issue_id = ? ORDER BY id DESC').all(issue.id).map((f) => {
    const kind = previewKind(f);
    const isVideo = kind === 'video';
    // 浏览器只支持 H.264/VP9/AV1；H.265(HEVC) 会黑屏，标记为不支持预览
    let preview_supported = true;
    if (isVideo) preview_supported = videoCodecSupported(path.join(config.UPLOAD_DIR, f.stored_name));
    return {
      id: f.id, issue_id: f.issue_id, original_name: f.original_name, size: f.size,
      mime: f.mime || '', uploader_name: f.uploader_name, created_at: f.created_at,
      is_image: isImageFile(f),
      preview_kind: kind, // image / pdf / video / docx / sheet / ''
      preview_supported,
    };
  });
  res.json({ code: 0, data: { issue: publicIssue(issue), logs, files } });
});

// 更新基本信息（标题/模块/紧急程度/内容/科室/报障人）
router.put('/:id', (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });

  const b = req.body || {};
  const title = b.title !== undefined ? toSafeText(b.title) : issue.title;
  if (!title) return res.status(400).json({ code: 400, message: '标题不能为空' });
  const category = b.category !== undefined ? normCategory(b.category, issue.category) : (issue.category || '日常软件');
  const module = b.module !== undefined ? normModule(b.module, category) : (issue.module || '');
  const urgency = b.urgency !== undefined ? (config.URGENCY.includes(toSafeText(b.urgency)) ? toSafeText(b.urgency) : issue.urgency) : issue.urgency;
  const content = b.content !== undefined ? toSafeText(b.content) : issue.content;
  const department = b.department !== undefined ? toSafeText(b.department) : issue.department;
  const reporter = b.reporter !== undefined ? toSafeText(b.reporter) : issue.reporter;
  // 问题记录时间可改，但单号保持不变（单号以首次创建时生成值为准）
  let reportTime = issue.report_time || '';
  if (b.reportTime !== undefined) {
    const r = toSafeText(b.reportTime).slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(r)) reportTime = r;
  }

  db.prepare("UPDATE issues SET title=?, category=?, module=?, urgency=?, content=?, department=?, reporter=?, report_time=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(title, category, module, urgency, content, department, reporter, reportTime, id);
  registerCustom(db, category, module);
  logAction(req.user, '编辑问题', `单号 ${issue.no}` + (title !== issue.title ? '：' + title : ''), req.ip);
  res.json({ code: 0, message: '已保存' });
});

// 指派处理人（工程师/管理员）
router.put('/:id/assignee', requireRole(1, 2), (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });

  const assigneeId = toSafeNum(req.body && req.body.assigneeId, 0);
  // 查统一账号体系（合同库 users），非问题库旧表
  const user = assigneeId ? contractDb.prepare('SELECT id, real_name, username FROM users WHERE id = ?').get(assigneeId) : null;
  const assigneeName = user ? (user.real_name || user.username) : '';
  if (assigneeId && !user) return res.status(400).json({ code: 400, message: '处理人不存在' });

  db.prepare("UPDATE issues SET assignee_id=?, assignee_name=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(user ? user.id : null, assigneeName, id);
  db.prepare('INSERT INTO issue_logs(issue_id, action, content, operator_id, operator_name) VALUES (?, ?, ?, ?, ?)')
    .run(id, '指派处理', (assigneeName ? '指派给：' + assigneeName : '取消指派'), req.user.id, req.user.real_name || req.user.username);
  logAction(req.user, '指派问题', `单号 ${issue.no} → ${assigneeName || '未指派'}`, req.ip);
  res.json({ code: 0, message: '指派成功' });
});

// 状态流转
router.post('/:id/status', requireRole(1, 2), (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });

  const to = String((req.body || {}).status || '');
  const allowed = STATUS_TRANSITIONS[issue.status] || [];
  if (!allowed.includes(to)) {
    return res.status(400).json({ code: 400, message: `不允许从「${config.STATUS[issue.status]}」变更为「${config.STATUS[to] || to}」` });
  }
  const note = toSafeText(req.body && req.body.content);
  const action = statusAction(issue.status, to);
  const now = db.prepare("SELECT datetime('now','localtime') AS t").get().t;

  // 开始处理时若尚未指派处理人，自动将操作人记为处理人（手动指派过则不覆盖）
  const autoAssign = (to === 'processing' && !issue.assignee_id && req.user.id);
  const updateSql = autoAssign
    ? "UPDATE issues SET status=?, updated_at=?, closed_at=?, assignee_id=?, assignee_name=? WHERE id=?"
    : "UPDATE issues SET status=?, updated_at=?, closed_at=? WHERE id=?";
  const updParams = autoAssign
    ? [to, now, to === 'closed' ? now : issue.closed_at, req.user.id, req.user.real_name || req.user.username, id]
    : [to, now, to === 'closed' ? now : issue.closed_at, id];
  db.prepare(updateSql).run(...updParams);
  db.prepare('INSERT INTO issue_logs(issue_id, action, content, from_status, to_status, operator_id, operator_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, action, note || '', issue.status, to, req.user.id, req.user.real_name || req.user.username, now);
  logAction(req.user, '状态变更', `单号 ${issue.no}：${issue.status} → ${to}（${action}）`, req.ip);
  res.json({ code: 0, message: '操作成功' });
});

// 追加处理记录（不改变状态）
router.post('/:id/logs', (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });
  const content = toSafeText(req.body && req.body.content);
  if (!content) return res.status(400).json({ code: 400, message: '请填写处理记录内容' });

  db.prepare("INSERT INTO issue_logs(issue_id, action, content, operator_id, operator_name) VALUES (?, '处理记录', ?, ?, ?)")
    .run(id, content, req.user.id, req.user.real_name || req.user.username);
  db.prepare("UPDATE issues SET updated_at=datetime('now','localtime') WHERE id=?").run(id);
  logAction(req.user, '追加处理记录', `单号 ${issue.no}`, req.ip);
  res.json({ code: 0, message: '记录已添加' });
});

// ---- 附件上传（单次可多文件）----
router.post('/:id/files', upload.array('files', 10), (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });

  const ins = db.prepare('INSERT INTO files(issue_id, original_name, stored_name, size, mime, uploader_name) VALUES (?, ?, ?, ?, ?, ?)');
  const saved = [];
  for (const f of req.files || []) {
    const original = fixFilename(f.originalname || f.filename);
    const info = ins.run(id, original, f.filename, f.size, String(f.mimetype || ''), req.user.real_name || req.user.username);
    saved.push({ id: Number(info.lastInsertRowid), original_name: original, size: f.size });
  }
  db.prepare("UPDATE issues SET updated_at=datetime('now','localtime') WHERE id=?").run(id);
  logAction(req.user, '上传附件', `单号 ${issue.no}，共 ${saved.length} 个文件`, req.ip);
  res.json({ code: 0, data: saved, message: `已上传 ${saved.length} 个附件` });
});

// 删除附件
router.delete('/:id/files/:fileId', (req, res) => {
  const db = getDb();
  const fileId = toSafeNum(req.params.fileId);
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  if (!file) return res.status(404).json({ code: 404, message: '附件不存在' });

  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  try { fs.unlinkSync(path.join(config.UPLOAD_DIR, file.stored_name)); } catch (e) { /* 文件可能已不存在 */ }
  db.prepare("UPDATE issues SET updated_at=datetime('now','localtime') WHERE id=?").run(file.issue_id);
  logAction(req.user, '删除附件', `附件：${file.original_name}`, req.ip);
  res.json({ code: 0, message: '附件已删除' });
});

// 图片判定：按 mime 或扩展名（兼容老数据无 mime）
function isImageFile(file) {
  const mime = String(file.mime || '');
  if (mime.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|bmp|webp|svg)$/i.test(file.original_name || '');
}

// 预览类型判定：image / pdf / video / docx / sheet；不支持返回 ''
const EXT_PREVIEW = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', bmp: 'image', webp: 'image', svg: 'image',
  pdf: 'pdf',
  mp4: 'video', webm: 'video', ogg: 'video', mov: 'video', m4v: 'video',
  docx: 'docx',
  xlsx: 'sheet', xls: 'sheet', csv: 'sheet',
};
const MIME_PREVIEW = {
  'application/pdf': 'pdf',
  'video/mp4': 'video', 'video/webm': 'video', 'video/ogg': 'video', 'video/quicktime': 'video',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'sheet',
  'application/vnd.ms-excel': 'sheet', 'text/csv': 'sheet',
};
function previewKind(file) {
  const ext = path.extname(file.original_name || '').toLowerCase().replace('.', '');
  if (EXT_PREVIEW[ext]) return EXT_PREVIEW[ext];
  const mime = String(file.mime || '');
  if (mime.startsWith('image/')) return 'image';
  return MIME_PREVIEW[mime] || '';
}

// 视频编码检测：H.265(HEVC) 浏览器无法解码会黑屏；H.264/VP9/AV1 可正常预览
const codecCache = new Map(); // 文件路径+大小+修改时间 → 是否可预览
function videoCodecSupported(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    const key = `${fullPath}:${st.size}:${st.mtimeMs}`;
    if (codecCache.has(key)) return codecCache.get(key);
    if (st.size > 300 * 1024 * 1024) { codecCache.set(key, false); return false; }
    const buf = fs.readFileSync(fullPath);
    const isHevc = buf.includes(Buffer.from('hvc1')) || buf.includes(Buffer.from('hev1'));
    const ok = !isHevc;
    codecCache.set(key, ok);
    return ok;
  } catch (e) { return true; }
}

// 附件下载（需带 token，前端 fetch blob）
router.get('/:id/files/download/:fileId', (req, res) => {
  const db = getDb();
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(toSafeNum(req.params.fileId));
  if (!file) return res.status(404).json({ code: 404, message: '附件不存在' });
  const full = path.join(config.UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(full)) return res.status(404).json({ code: 404, message: '附件文件已丢失' });
  const name = file.original_name;
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.sendFile(full);
});

// 附件预览（图片/PDF/视频 inline 直显；Word/Excel 由前端拉取 blob 后本地渲染）
router.get('/:id/files/preview/:fileId', (req, res) => {
  const db = getDb();
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(toSafeNum(req.params.fileId));
  if (!file) return res.status(404).json({ code: 404, message: '附件不存在' });
  const kind = previewKind(file);
  if (!kind) return res.status(400).json({ code: 400, message: '该附件类型不支持预览，请下载查看' });
  const full = path.join(config.UPLOAD_DIR, file.stored_name);
  if (!fs.existsSync(full)) return res.status(404).json({ code: 404, message: '附件文件已丢失' });
  const ext = path.extname(file.original_name || '').toLowerCase();
  const mimeMap = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogg': 'video/ogg', '.mov': 'video/quicktime', '.m4v': 'video/mp4',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.xls': 'application/vnd.ms-excel', '.csv': 'text/csv',
  };
  const mime = file.mime && (file.mime.startsWith('image/') || MIME_PREVIEW[file.mime]) ? file.mime : (mimeMap[ext] || 'application/octet-stream');
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(full);
});

// 删除问题（仅管理员，级联删除处理记录与附件）
router.delete('/:id', requireRole(1), (req, res) => {
  const db = getDb();
  const id = toSafeNum(req.params.id);
  const issue = db.prepare('SELECT * FROM issues WHERE id = ?').get(id);
  if (!issue) return res.status(404).json({ code: 404, message: '问题不存在' });

  const files = db.prepare('SELECT stored_name FROM files WHERE issue_id = ?').all(id);
  db.prepare('DELETE FROM issues WHERE id = ?').run(id); // 级联删 issue_logs / files
  for (const f of files) {
    try { fs.unlinkSync(path.join(config.UPLOAD_DIR, f.stored_name)); } catch (e) { /* ignore */ }
  }
  logAction(req.user, '删除问题', `单号 ${issue.no}：${issue.title}`, req.ip);
  res.json({ code: 0, message: '问题已删除' });
});

module.exports = router;