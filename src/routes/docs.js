'use strict';
/**
 * 技术文档库路由：文档类型（可自定义）+ 文档上传/检索/在线预览/下载/删除。
 * 支持 PDF 与 Word（.docx 及旧版 .doc）。
 * 预览沿用前端 docx-preview（Word）与浏览器原生（PDF）；旧版 .doc 若服务端装了
 * LibreOffice 会先转成 docx 保留排版，否则降级为"文本模式"预览（见 docpreview.js）。
 */
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const config = require('../../config');
const { raw: db } = require('../db-docs');
const { authRequired } = require('../auth');
const { fixFilename } = require('../db'); // 与问题附件同一套中文名修复
const { logAction } = require('../utils');
const docpreview = require('../docpreview');

const router = express.Router();
router.use(authRequired);

// ---------- 文件存储（随机名，原名进库，中文名做 latin1→utf8 还原） ----------
// 扩展名只作提示，真实格式以文件头嗅探结果为准（防止 .doc 改名 .docx 导致预览空白）
const ALLOWED_EXT = ['docx', 'doc', 'pdf'];
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.DOCS_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const fixed = fixFilename(file.originalname || '');
    const ext = (path.extname(fixed) || '').toLowerCase();
    cb(null, Date.now() + '-' + crypto.randomBytes(8).toString('hex') + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: config.MAX_FILE_SIZE },
});

/**
 * 预览方式：pdf 走浏览器；docx 走 docx-preview；旧版 .doc 若已转出 docx 亦走 docx-preview，
 * 否则标记为 'doc' 由前端拉取纯文本做文本模式预览。
 */
function previewKindOf(d) {
  const e = String((d.real_ext || d.ext) || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'docx';
  if (e === 'doc') return d.converted_name ? 'docx' : 'doc';
  return '';
}
const MIME_PREVIEW = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const DOCX_MIME = MIME_PREVIEW['.docx'];

/** 读取文件头若干字节，用于格式嗅探 */
function readHead(file, n = 65536) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.slice(0, read);
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignore */ }
  }
}

/** 文本模式预览的 HTML 缓存路径（避免每次预览都重新解析 .doc） */
function textCachePath(id) {
  return path.join(config.DOCS_CONVERT_DIR, 'text-' + Number(id) + '.html');
}

// ==================== 文档类型（可自定义） ====================
// GET /api/docs/categories —— 列表（含每类文档数、未分类数、总数）
router.get('/categories', (req, res) => {
  try {
    const categories = db.prepare(
      `SELECT c.id, c.name, c.sort, COUNT(d.id) AS doc_count
       FROM doc_categories c
       LEFT JOIN documents d ON d.category_id = c.id
       GROUP BY c.id
       ORDER BY c.sort ASC, c.id ASC`
    ).all();
    const uncategorized = db.prepare('SELECT COUNT(*) c FROM documents WHERE category_id IS NULL').get().c;
    const total = db.prepare('SELECT COUNT(*) c FROM documents').get().c;
    res.json({ code: 0, data: { categories, uncategorized, total } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取类型失败：' + e.message });
  }
});

// POST /api/docs/categories —— 新增类型
router.post('/categories', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ code: 400, message: '类型名称不能为空' });
  if (db.prepare('SELECT id FROM doc_categories WHERE name = ?').get(name)) {
    return res.status(400).json({ code: 400, message: '该类型已存在' });
  }
  const maxSort = db.prepare('SELECT COALESCE(MAX(sort), 0) m FROM doc_categories').get().m;
  const info = db.prepare('INSERT INTO doc_categories(name, sort) VALUES (?, ?)').run(name, maxSort + 1);
  logAction(req, '新增文档类型', name);
  res.json({ code: 0, data: { id: info.lastInsertRowid, name } });
});

// PUT /api/docs/categories/:id —— 重命名类型
router.put('/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  const name = String(req.body.name || '').trim().slice(0, 30);
  if (!name) return res.status(400).json({ code: 400, message: '类型名称不能为空' });
  if (db.prepare('SELECT id FROM doc_categories WHERE name = ? AND id <> ?').get(name, id)) {
    return res.status(400).json({ code: 400, message: '该类型已存在' });
  }
  const r = db.prepare('UPDATE doc_categories SET name = ? WHERE id = ?').run(name, id);
  if (r.changes === 0) return res.status(404).json({ code: 404, message: '类型不存在' });
  logAction(req, '重命名文档类型', name);
  res.json({ code: 0 });
});

// DELETE /api/docs/categories/:id —— 删除类型（有文档时禁止，需先移走）
router.delete('/categories/:id', (req, res) => {
  const id = Number(req.params.id);
  const n = db.prepare('SELECT COUNT(*) c FROM documents WHERE category_id = ?').get(id).c;
  if (n > 0) return res.status(400).json({ code: 400, message: '该类型下还有 ' + n + ' 篇文档，请先移走或删除后再操作' });
  const r = db.prepare('DELETE FROM doc_categories WHERE id = ?').run(id);
  if (r.changes === 0) return res.status(404).json({ code: 404, message: '类型不存在' });
  logAction(req, '删除文档类型', '#' + id);
  res.json({ code: 0 });
});

// ==================== 文档 ====================
// GET /api/docs —— 列表（关键词 / 类型筛选 / 分页）
router.get('/', (req, res) => {
  try {
    const kw = String(req.query.keyword || '').trim();
    const cat = req.query.category_id; // 'none' 或 数字
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 12));
    const where = [];
    const params = [];
    if (kw) {
      const lk = '%' + kw + '%';
      where.push('(d.title LIKE ? OR d.original_name LIKE ? OR d.tags LIKE ? OR d.remark LIKE ?)');
      params.push(lk, lk, lk, lk);
    }
    if (cat === 'none') where.push('d.category_id IS NULL');
    else if (cat) { where.push('d.category_id = ?'); params.push(Number(cat)); }
    const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const total = db.prepare('SELECT COUNT(*) c FROM documents d ' + w).get(...params).c;
    const rows = db.prepare(
      `SELECT d.id, d.title, d.original_name, d.ext, d.real_ext, d.converted_name, d.size, d.tags, d.remark,
              d.uploader_name, d.created_at, d.category_id, c.name AS category_name
       FROM documents d
       LEFT JOIN doc_categories c ON d.category_id = c.id
       ${w}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, pageSize, (page - 1) * pageSize);

    const list = rows.map((d) => Object.assign({}, d, { preview_kind: previewKindOf(d.ext) }));
    res.json({ code: 0, data: { list, total, page, pageSize } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取文档失败：' + e.message });
  }
});

// GET /api/docs/:id —— 文档详情（供独立预览页按 id 直达）
// 注意：静态前缀路由（/categories）必须声明在 /:id 之前，否则会被 :id 拦截
router.get('/:id', (req, res) => {
  const d = db.prepare(
    `SELECT d.id, d.title, d.original_name, d.ext, d.real_ext, d.converted_name, d.size, d.tags, d.remark,
            d.uploader_name, d.created_at, d.category_id, c.name AS category_name
     FROM documents d
     LEFT JOIN doc_categories c ON d.category_id = c.id
     WHERE d.id = ?`
  ).get(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });
  res.json({ code: 0, data: Object.assign({}, d, { preview_kind: previewKindOf(d.ext) }) });
});

// POST /api/docs —— 上传文档（pdf / docx / doc）
// 真实格式按文件头判定：扩展名不可信（常见 .doc 改名 .docx，会导致预览空白）
router.post('/', upload.single('file'), (req, res) => {
  (async () => {
    if (!req.file) return res.status(400).json({ code: 400, message: '未接收到文件' });
    const fixedName = fixFilename(req.file.originalname);
    const extHint = (path.extname(fixedName) || '').toLowerCase().replace('.', '');
    if (!ALLOWED_EXT.includes(extHint)) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      return res.status(400).json({ code: 400, message: '暂支持 Word(.docx/.doc) 与 PDF 文档' });
    }

    const categoryId = req.body.category_id ? Number(req.body.category_id) : null;
    if (categoryId) {
      const cat = db.prepare('SELECT id FROM doc_categories WHERE id = ?').get(categoryId);
      if (!cat) {
        try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
        return res.status(400).json({ code: 400, message: '文档类型不存在' });
      }
    }

    // 格式嗅探：以真实格式为准
    const head = readHead(req.file.path);
    const kind = docpreview.resolveKind(head, extHint);
    if (!kind.kind) {
      try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
      return res.status(400).json({ code: 400, message: kind.note || '不支持的文件格式' });
    }

    // 旧版 .doc：尝试转 docx（装了 LibreOffice 才行），转不了则留待文本模式预览
    let convertedName = '';
    let convertNotice = '';
    if (kind.kind === 'doc') {
      try {
        const base = path.basename(req.file.filename, path.extname(req.file.filename));
        const r = await docpreview.previewDocPayload(req.file.path, config.DOCS_CONVERT_DIR, base);
        if (r.mode === 'docx' && r.docxPath) {
          convertedName = path.basename(r.docxPath);
        } else {
          convertNotice = r.notice || '该 .doc 将以文本模式预览';
        }
      } catch (e) {
        convertNotice = '该 .doc 将以文本模式预览（' + e.message + '）';
      }
    }

    const title = String(req.body.title || '').trim() || path.basename(fixedName, path.extname(fixedName));
    const tags = String(req.body.tags || '').slice(0, 200);
    const remark = String(req.body.remark || '').slice(0, 500);

    const info = db.prepare(
      `INSERT INTO documents(title, category_id, original_name, stored_name, mime, size, ext, real_ext, converted_name,
                             tags, remark, uploaded_by, uploader_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      title, categoryId, fixedName, req.file.filename, req.file.mimetype, req.file.size,
      kind.ext, kind.ext, convertedName,
      tags, remark, req.user.id, req.user.username || ''
    );

    logAction(req, '上传技术文档', title + (categoryId ? ' [类型#' + categoryId + ']' : ' [未分类]'));
    res.json({
      code: 0,
      data: {
        id: info.lastInsertRowid,
        real_ext: kind.ext,
        preview_kind: convertedName ? 'docx' : kind.kind,
      },
      message: [kind.note, convertNotice].filter(Boolean).join('；'),
    });
  })().catch((e) => {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (er) { /* ignore */ }
    res.status(500).json({ code: 500, message: '上传处理失败：' + e.message });
  });
});

// GET /api/docs/:id/download —— 下载
router.get('/:id/download', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });
  const full = path.join(config.DOCS_UPLOAD_DIR, d.stored_name);
  if (!fs.existsSync(full)) return res.status(404).json({ code: 404, message: '文件已丢失' });
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.original_name)}`);
  res.sendFile(full);
});

// GET /api/docs/:id/preview —— 在线预览（inline）
// 旧版 .doc 若已转出 docx，这里直接吐转换后的 docx，前端照常走 docx-preview
router.get('/:id/preview', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });

  let full = path.join(config.DOCS_UPLOAD_DIR, d.stored_name);
  let mime = '';
  const kind = previewKindOf(d);
  if (kind === 'pdf') {
    mime = MIME_PREVIEW['.pdf'];
  } else if (kind === 'docx') {
    mime = DOCX_MIME;
    if (String((d.real_ext || d.ext)).toLowerCase() === 'doc' && d.converted_name) {
      full = path.join(config.DOCS_CONVERT_DIR, d.converted_name);
    }
  } else {
    // 'doc'（未转换成功）走 /text；其它不支持格式
    return res.status(415).json({
      code: 415,
      message: kind === 'doc' ? '该 .doc 需走文本预览' : '该格式暂不支持在线预览，请下载查看',
    });
  }
  if (!fs.existsSync(full)) return res.status(404).json({ code: 404, message: '文件已丢失' });
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', 'inline');
  res.sendFile(full);
});

// GET /api/docs/:id/text —— 旧版 .doc 的文本模式预览（提取正文，带缓存）
router.get('/:id/text', (req, res) => {
  (async () => {
    const id = Number(req.params.id);
    const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
    if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });
    if (previewKindOf(d) !== 'doc') {
      return res.status(400).json({ code: 400, message: '该文档无需文本预览' });
    }
    const cache = textCachePath(id);
    if (fs.existsSync(cache)) {
      return res.json({ code: 0, data: { html: fs.readFileSync(cache, 'utf8'), notice: '当前为文本模式预览（.doc 已提取正文，表格与图片排版不保留）' } });
    }
    const full = path.join(config.DOCS_UPLOAD_DIR, d.stored_name);
    if (!fs.existsSync(full)) return res.status(404).json({ code: 404, message: '文件已丢失' });

    const text = await docpreview.extractDocText(full);
    const html = docpreview.textToHtml(text);
    try {
      fs.mkdirSync(config.DOCS_CONVERT_DIR, { recursive: true });
      fs.writeFileSync(cache, html, 'utf8');
    } catch (e) { /* 缓存失败不影响预览 */ }
    res.json({ code: 0, data: { html, notice: '当前为文本模式预览（.doc 已提取正文，表格与图片排版不保留）' } });
  })().catch((e) => {
    res.status(422).json({ code: 422, message: e.message || '无法提取该文档内容' });
  });
});

// DELETE /api/docs/:id —— 删除文档
router.delete('/:id', (req, res) => {
  const d = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });
  db.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
  const junk = [
    path.join(config.DOCS_UPLOAD_DIR, d.stored_name),
    d.converted_name ? path.join(config.DOCS_CONVERT_DIR, d.converted_name) : '',
    textCachePath(d.id),
  ].filter(Boolean);
  for (const f of junk) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { /* ignore */ }
  }
  logAction(req, '删除技术文档', d.title);
  res.json({ code: 0 });
});

module.exports = router;
