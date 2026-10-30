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
const { authRequired, guardModule } = require('../auth');
const { fixFilename } = require('../db'); // 与问题附件同一套中文名修复
const { logAction } = require('../utils');
const docpreview = require('../docpreview');
// 正文提取（docx 走自写的最小 zip 解析，pdf 尽力而为，doc 复用 docpreview）
const doctext = require('../doctext');

const router = express.Router();
// 技术文档库：读要 view、上传/改名/删除要 manage
router.use(authRequired, guardModule('docs'));

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
 *
 * ★ 入参两种形态都要吃：整行记录（table row），或只给一个扩展名字符串。
 *   起因是个真实且隐蔽的 bug：列表与详情接口写的是 `previewKindOf(d.ext)`（字符串），
 *   而函数体按整行读 `d.real_ext || d.ext` —— 字符串上取 `.real_ext` 得到 undefined，
 *   `String(undefined || undefined || '')` 是空串，于是每次都掉到最后那个 `return ''`。
 *   后果是列表里**每个**文档的 preview_kind 都是空，前端一律走 `v-else`，
 *   弹窗显示「该类型暂不支持预览」—— PDF 和 Word 全都预览不了，
 *   而 /preview 接口自己是好的（它传的是整行），因此后端起服务单独测完全正常，
 *   极难往参数形状不匹配上想。这里做归一化，两种调用都对。
 */
function previewKindOf(d) {
  const row = (d && typeof d === 'object') ? d : { ext: d };
  const e = String((row.real_ext || row.ext) || '').toLowerCase().replace(/^\./, '');
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'docx';
  if (e === 'doc') return row.converted_name ? 'docx' : 'doc';
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

/**
 * 建/重建某篇文档的正文索引。
 *
 * 设计取舍：
 *   · 同步 await —— 一篇几 MB 的 docx 提取是几十毫秒级，比「后台异步 + 状态轮询」
 *     简单得多，也不会出现「刚上传完搜不到，过一会儿又搜到了」的困惑。
 *   · 失败不影响上传 —— 索引是增强能力，提不出正文不该让文档存不进来；
 *     失败原因落进 content_status / indexed_at，界面上照实标注。
 *   · 永不抛异常，只返回结果，调用方无需 try/catch。
 */
async function indexDocument(id, row) {
  const d = row || db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id));
  if (!d) return { id: id, status: 'error', note: '文档不存在' };
  const kind = String(d.real_ext || d.ext || '').toLowerCase().replace(/^\./, '');
  const full = path.join(config.DOCS_UPLOAD_DIR, d.stored_name);
  let r;
  try {
    r = await doctext.extract(full, kind);
  } catch (e) {
    r = { ok: false, text: '', status: 'error', note: '提取异常：' + ((e && e.message) || e) };
  }
  try {
    db.prepare('UPDATE documents SET content_text = ?, content_status = ?, indexed_at = datetime(\'now\',\'localtime\') WHERE id = ?')
      .run(r.ok ? r.text : '', r.status || 'error', d.id);
  } catch (e) {
    return { id: d.id, status: 'error', note: '写库失败：' + ((e && e.message) || e) };
  }
  return { id: d.id, status: r.status, note: r.note || '', chars: r.ok ? r.text.length : 0 };
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
    // 索引概况：并进这个已有的汇总接口，前端一次请求就够了（不为它单开路由）
    // pending 的口径与 /reindex 的补索条件严格一致，否则按钮上写着「还有 3 篇」点进去却说没有
    const idxRows = db.prepare(
      `SELECT content_status AS s, COUNT(*) AS c FROM documents GROUP BY content_status`
    ).all();
    const index = { ok: 0, empty: 0, unsupported: 0, error: 0, pending: 0, total: total };
    for (const r of idxRows) {
      const k = r.s || 'pending';   // 空状态 = 从未索引过
      if (index[k] === undefined) index[k] = 0;
      index[k] += r.c;
    }
    // pending 用与 /reindex 完全相同的条件再点一次，两个数字必须对得上
    const pendRow = db.prepare(
      "SELECT COUNT(*) c FROM documents WHERE content_status = '' OR indexed_at = ''"
    ).get();
    index.pending = pendRow ? pendRow.c : 0;
    res.json({ code: 0, data: { categories, uncategorized, total, index } });
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
      // 正文也参与检索：文档库最有价值的内容恰恰在正文里（如「这台交换机的默认口令」
      // 只写在操作手册第 3 页），只搜标题/tags 等于把大部分内容挡在门外。
      where.push('(d.title LIKE ? OR d.original_name LIKE ? OR d.tags LIKE ? OR d.remark LIKE ? OR d.content_text LIKE ?)');
      params.push(lk, lk, lk, lk, lk);
    }
    if (cat === 'none') where.push('d.category_id IS NULL');
    else if (cat) { where.push('d.category_id = ?'); params.push(Number(cat)); }
    const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';

    const total = db.prepare('SELECT COUNT(*) c FROM documents d ' + w).get(...params).c;
    const rows = db.prepare(
      `SELECT d.id, d.title, d.original_name, d.ext, d.real_ext, d.converted_name, d.size, d.tags, d.remark,
              d.uploader_name, d.created_at, d.category_id, d.content_status, d.indexed_at,
              CASE WHEN d.content_text IS NULL OR d.content_text = '' THEN 0 ELSE length(d.content_text) END AS content_len,
              c.name AS category_name
       FROM documents d
       LEFT JOIN doc_categories c ON d.category_id = c.id
       ${w}
       ORDER BY d.created_at DESC
       LIMIT ? OFFSET ?`
    ).all(...params, pageSize, (page - 1) * pageSize);

    const list = rows.map((d) => Object.assign({}, d, { preview_kind: previewKindOf(d) }));
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
            d.uploader_name, d.created_at, d.category_id, d.content_status, d.indexed_at,
            CASE WHEN d.content_text IS NULL OR d.content_text = '' THEN 0 ELSE length(d.content_text) END AS content_len,
            c.name AS category_name
     FROM documents d
     LEFT JOIN doc_categories c ON d.category_id = c.id
     WHERE d.id = ?`
  ).get(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '文档不存在' });
  res.json({ code: 0, data: Object.assign({}, d, { preview_kind: previewKindOf(d) }) });
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

    // 建正文索引（失败不影响上传成功，只把状态与原因带回去）
    const idx = await indexDocument(info.lastInsertRowid);
    const idxNote = idx.status === 'ok'
      ? ''
      : ('正文索引：' + ((doctext.STATUS_LABEL || {})[idx.status] || idx.status) + (idx.note ? '（' + idx.note + '）' : ''));

    res.json({
      code: 0,
      data: {
        id: info.lastInsertRowid,
        real_ext: kind.ext,
        preview_kind: convertedName ? 'docx' : kind.kind,
        content_status: idx.status,
        content_len: idx.chars || 0,
      },
      message: [kind.note, convertNotice, idxNote].filter(Boolean).join('；'),
    });
  })().catch((e) => {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (er) { /* ignore */ }
    res.status(500).json({ code: 500, message: '上传处理失败：' + e.message });
  });
});

// POST /api/docs/reindex —— 重建正文索引
//
// 三种用法：
//   {}                    只补「从未索引过」的（升级后第一次用，把历史文档补上）
//   { force: true }       全部重建（换了提取逻辑、或发现索引不准时）
//   { ids: [1,2,3] }      指定若干篇
// 单次处理上限默认 200 篇：几百份文档一次跑完要几十秒，HTTP 容易超时，
// 返回 remaining 让前端提示「还有 N 篇，再点一次」——比偷偷截断诚实。
router.post('/reindex', async (req, res) => {
  try {
    const b = req.body || {};
    const limit = Math.min(1000, Math.max(1, Number(b.limit) || 200));

    let rows;
    if (Array.isArray(b.ids) && b.ids.length) {
      const ids = b.ids.map((x) => Number(x)).filter((x) => isFinite(x) && x > 0);
      if (!ids.length) return res.status(400).json({ code: 400, message: 'ids 里没有合法的文档编号' });
      rows = db.prepare(`SELECT * FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    } else if (b.force) {
      rows = db.prepare("SELECT * FROM documents ORDER BY id ASC LIMIT ?").all(limit);
    } else {
      rows = db.prepare(
        "SELECT * FROM documents WHERE content_status = '' OR indexed_at = '' ORDER BY id ASC LIMIT ?"
      ).all(limit);
    }

    const stat = { ok: 0, empty: 0, unsupported: 0, error: 0, total: rows.length };
    const failed = [];
    for (const r of rows) {
      const out = await indexDocument(r.id, r);
      if (stat[out.status] === undefined) stat[out.status] = 0;
      stat[out.status]++;
      if (out.status === 'error') failed.push({ id: r.id, title: r.title, note: out.note });
    }

    const remainRow = db.prepare(
      "SELECT COUNT(*) c FROM documents WHERE content_status = '' OR indexed_at = ''"
    ).get();
    const remaining = remainRow ? remainRow.c : 0;

    logAction(req, '重建文档索引', {
      total: stat.total, ok: stat.ok, unsupported: stat.unsupported, error: stat.error, force: !!b.force,
    });

    const parts = [`本次处理 ${stat.total} 篇`, `成功 ${stat.ok} 篇`];
    if (stat.unsupported) parts.push(`不支持 ${stat.unsupported} 篇`);
    if (stat.empty) parts.push(`无正文 ${stat.empty} 篇`);
    if (stat.error) parts.push(`失败 ${stat.error} 篇`);
    if (remaining) parts.push(`仍有 ${remaining} 篇未索引，可再次执行`);

    res.json({ code: 0, message: parts.join('，'), data: Object.assign({ remaining: remaining, failed: failed.slice(0, 20) }, stat) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '重建索引失败：' + ((e && e.message) || e) });
  }
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
// 仅供 scripts/docs-preview-selftest.js 做离线断言（运行时没人读这个属性）。
// 之所以要把它掏出来单测：这个函数曾经因为「入参形状」和「函数体读法」不一致，
// 让列表接口的 preview_kind 恒为空串 —— 而接口能返回 200、后端单独测也正常，
// 只有把「传进去的东西长什么样」写进断言里才拦得住。挂一个属性比改导出结构安全。
module.exports.previewKindOf = previewKindOf;

