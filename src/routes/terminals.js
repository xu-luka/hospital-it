'use strict';
/**
 * 终端资产台账路由。
 *
 * 权限：整个路由 guardModule('terminals') —— 读要 view、写要 manage（要处理报障的人本来就要能查设备）。
 * 刻意不设「看序列号」之类的独立权限点：终端台账里没有凭据，SN/资产号是找人修机器必需的，
 * 拆开只会造出「能看到设备但看不到是哪台」的角色。
 *
 * 路由顺序：/meta、/options 必须排在 /:id 之前，否则会被当成 id="meta" 吞掉。
 */
const express = require('express');
const { authRequired, guardModule } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../terminals');

const router = express.Router();
router.use(authRequired, guardModule('terminals'));

function fail(res, r, fallback) {
  const code = r && r.notFound ? 404 : 400;
  res.status(code).json({ code, message: (r && r.error) || fallback || '操作失败' });
}

// GET /api/terminals/meta —— 类型/状态/科室清单（新建设备、筛选下拉用）
router.get('/meta', (req, res) => {
  try {
    res.json({ code: 0, data: repo.meta() });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取台账元数据失败：' + ((e && e.message) || e) });
  }
});

// GET /api/terminals/options —— 工单表单的设备下拉（只给非报废，最多 300 条）
router.get('/options', (req, res) => {
  try {
    res.json({ code: 0, data: repo.options({ keyword: req.query.keyword, department: req.query.department }) });
  } catch (e) {
    // 台账不可用不该挡住报修：返回空清单 + 原因，前端会退回「手动填写」
    res.json({ code: 0, message: '设备清单读取失败：' + ((e && e.message) || e), data: { list: [], total: 0 } });
  }
});

// GET /api/terminals —— 列表（关键词/科室/类型/状态/保修/排序/分页）
router.get('/', (req, res) => {
  try {
    res.json({ code: 0, data: repo.list({
      keyword: req.query.keyword,
      department: req.query.department,
      kind: req.query.kind,
      status: req.query.status,
      warranty: req.query.warranty,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取终端台账失败：' + ((e && e.message) || e) });
  }
});

// GET /api/terminals/:id —— 详情（含这台设备的全部历史工单）
router.get('/:id', (req, res) => {
  try {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ code: 404, message: '设备不存在' });
    res.json({ code: 0, data: Object.assign({}, t, { issues: repo.issuesOf(t.id, 200) }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取设备详情失败：' + ((e && e.message) || e) });
  }
});

// POST /api/terminals —— 新增
router.post('/', (req, res) => {
  try {
    const r = repo.create(req.body || {}, req.user);
    if (!r.ok) return fail(res, r);
    logAction(req, '新增终端设备', String((req.body || {}).name || '') + ' #' + r.id);
    res.json({ code: 0, data: { id: r.id } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/terminals/:id —— 编辑（未传的字段保持原值）
router.put('/:id', (req, res) => {
  try {
    const r = repo.update(req.params.id, req.body || {});
    if (!r.ok) return fail(res, r);
    logAction(req, '修改终端设备', String((req.body || {}).name || '') + ' #' + req.params.id);
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/terminals/:id —— 删除（关联工单只解绑，不删）
router.delete('/:id', (req, res) => {
  try {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ code: 404, message: '设备不存在' });
    const r = repo.remove(req.params.id);
    if (!r.ok) return fail(res, r);
    logAction(req, '删除终端设备', String(t.name || '') + ' #' + t.id
      + (r.detached_issues ? '（解绑 ' + r.detached_issues + ' 张工单）' : ''));
    res.json({ code: 0, data: { detached_issues: r.detached_issues || 0 } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
