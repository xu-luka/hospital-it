'use strict';
/**
 * 网页书签路由。
 *
 * 权限：整个路由 guardModule('bookmarks')（读要 view、写要 manage），
 * 外加一个**独立**的密码查看点 bookmarks.secret —— 它刻意不被 manage 隐含，
 * 否则「不给某人看密码」根本做不到（能改的人自动就能看）。
 *
 * 明文密码只从 GET /:id/secret 出来，且每次都写一条操作日志。
 * 列表与详情接口一律只给 has_password 布尔值。
 */
const express = require('express');
const { authRequired, guardModule, requirePerm } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../bookmarks');

const router = express.Router();
router.use(authRequired, guardModule('bookmarks'));

/** 从请求体里取允许的字段（白名单，防止 body 里塞 password_enc 直接落库） */
function pick(b) {
  return {
    name: b.name, url: b.url, group_name: b.group_name,
    username: b.username, note: b.note,
  };
}

// GET /api/bookmarks —— 列表（关键词 / 分组筛选 / 分页）
router.get('/', (req, res) => {
  try {
    res.json({ code: 0, data: repo.list({
      keyword: req.query.keyword,
      group: req.query.group,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取书签失败：' + ((e && e.message) || e) });
  }
});

// GET /api/bookmarks/audit —— 凭据查看记录（谁 / 何时 / 看了哪条 / 从哪个 IP）
//
// 为什么不直接让前端查 /api/logs：那个路由要求 logs.view，工程师默认没有这一档，
// 而「能看密码的人」理应能看到这批凭据被谁查看过。这里只按 action 过滤统一 logs 表，
// 不新建表、不改 schema、不复制日志；权限复用 bookmarks.secret。
// ★ 定值路径必须排在 /:id 之前（本项目路由顺序老坑）。
router.get('/audit', requirePerm('bookmarks.secret'), (req, res) => {
  try {
    const { db } = require('../db-contract');
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const where = ["l.action = '查看书签凭据'"];
    const params = [];
    const kw = String(req.query.keyword || '').trim();
    if (kw) {
      where.push('(l.username LIKE ? OR l.detail LIKE ? OR l.ip LIKE ?)');
      const k = '%' + kw + '%';
      params.push(k, k, k);
    }
    const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
    if (isDate(req.query.from)) { where.push('date(l.created_at) >= date(?)'); params.push(String(req.query.from)); }
    if (isDate(req.query.to)) { where.push('date(l.created_at) <= date(?)'); params.push(String(req.query.to)); }
    const w = 'WHERE ' + where.join(' AND ');
    const total = db.prepare('SELECT COUNT(*) c FROM logs l ' + w).get(...params).c;
    const rows = db.prepare(
      'SELECT l.id, l.created_at, l.username, l.action, l.detail, l.ip FROM logs l '
      + w + ' ORDER BY l.id DESC LIMIT ? OFFSET ?'
    ).all(...params, pageSize, (page - 1) * pageSize);
    res.json({ code: 0, data: { list: rows, total, page, pageSize } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取凭据查看记录失败：' + ((e && e.message) || e) });
  }
});

// GET /api/bookmarks/:id/secret —— 查看账号密码（独立权限点 + 操作日志）
// ★ 二次验证（step-up）后续接在这个入口：校验 TOTP 通过后才解密返回，
//   前端相应地在调用前弹一次验证码输入框。本次按约定先不做。
router.get('/:id/secret', requirePerm('bookmarks.secret'), (req, res) => {
  (async () => {
    const row = repo.get(req.params.id);
    if (!row) return res.status(404).json({ code: 404, message: '书签不存在' });
    const pwd = await repo.decryptSecret(row.password_enc);
    if (!pwd.ok) {
      // 解密失败（换了机器的主密钥、密文被改）要说清原因，绝不能回一个空口令 —— 那会被当成真实密码
      return res.status(422).json({ code: 422, message: '无法读取该密码：' + pwd.error });
    }
    logAction(req, '查看书签凭据', (row.name || '') + ' ' + (row.url || ''));
    res.json({
      code: 0,
      data: {
        id: row.id, name: row.name || '', url: row.url || '',
        username: row.username || '', password: pwd.value,
        // false 表示这条存的是历史明文（加密改造前留下的），前端可据此提示
        encrypted: !!pwd.encrypted,
        has_password: row.password_enc ? 1 : 0,
      },
    });
  })().catch((e) => {
    res.status(500).json({ code: 500, message: '读取密码失败：' + ((e && e.message) || e) });
  });
});

// POST /api/bookmarks —— 新增
router.post('/', (req, res) => {
  (async () => {
    const b = req.body || {};
    const enc = await repo.encryptSecret(b.password);
    if (!enc.ok) return res.status(400).json({ code: 400, message: enc.error });
    const data = pick(b);
    data.password_enc = enc.value;
    const r = repo.create(data, req.user);
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error });
    logAction(req, '新增书签', String(data.name || '') + ' ' + String(data.url || ''));
    res.json({ code: 0, data: { id: r.id } });
  })().catch((e) => {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  });
});

// PUT /api/bookmarks/:id —— 编辑
// 密码语义：body 里没有 password 字段 = 不动原密码；传空串 = 清空；传值 = 覆盖。
// 前端编辑弹窗默认不回显密码，靠的就是这条约定 —— 否则「只改备注」会把密码抹掉。
router.put('/:id', (req, res) => {
  (async () => {
    const b = req.body || {};
    const patch = {};
    if (b.password !== undefined) {
      const enc = await repo.encryptSecret(b.password);
      if (!enc.ok) return res.status(400).json({ code: 400, message: enc.error });
      patch.password = b.password;
      patch.password_enc = enc.value;
    }
    const r = repo.update(req.params.id, pick(b), patch);
    if (!r.ok) return res.status(r.notFound ? 404 : 400).json({ code: r.notFound ? 404 : 400, message: r.error });
    logAction(req, '修改书签', String(b.name || '') + ' #' + req.params.id);
    res.json({ code: 0 });
  })().catch((e) => {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  });
});

// DELETE /api/bookmarks/:id —— 删除
router.delete('/:id', (req, res) => {
  try {
    const row = repo.get(req.params.id);
    if (!row) return res.status(404).json({ code: 404, message: '书签不存在' });
    const r = repo.remove(req.params.id);
    if (!r.ok) return res.status(404).json({ code: 404, message: '书签不存在' });
    logAction(req, '删除书签', (row.name || '') + ' ' + (row.url || ''));
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
