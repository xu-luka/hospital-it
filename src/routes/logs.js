'use strict';
const express = require('express');
const router = express.Router();
const XLSX = require('xlsx');
const { db } = require('../db-contract');
const { authRequired, requirePerm } = require('../auth');
const { logAction } = require('../utils');

// 操作日志仅管理员可查
// 操作日志：只读页面，要求「操作日志.查看」（原为仅管理员，现由角色权限决定）
router.use(authRequired, requirePerm('logs.view'));

/**
 * 组装筛选条件（列表与导出共用）。
 *
 * ★ 必须共用：导出与列表如果各写一份 WHERE，早晚会出现「页面上筛出 37 条、
 *   导出却是全量 5 万条」这种一眼看不出对错的偏差。改条件只改这一处。
 */
function buildWhere(q) {
  const where = [];
  const params = [];
  if (q.keyword) {
    const k = `%${q.keyword}%`;
    where.push('(l.username LIKE ? OR l.detail LIKE ? OR l.action LIKE ?)');
    params.push(k, k, k);
  }
  if (q.action) { where.push('l.action = ?'); params.push(q.action); }
  // 日期范围：只认 YYYY-MM-DD，其余一律忽略（不报错，避免一个笔误让整页查询失败）
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (isDate(q.from)) { where.push('date(l.created_at) >= date(?)'); params.push(String(q.from)); }
  if (isDate(q.to)) { where.push('date(l.created_at) <= date(?)'); params.push(String(q.to)); }
  return { whereSql: where.length ? 'WHERE ' + where.join(' AND ') : '', params: params };
}

// GET /api/logs - 日志列表（分页 + 可选按用户/动作/日期筛选）
router.get('/', (req, res) => {
  const { page = 1, pageSize = 20 } = req.query;
  const { whereSql, params } = buildWhere(req.query);

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const size = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 20));
  const offset = (pageNum - 1) * size;

  const total = db.prepare(`SELECT COUNT(*) c FROM logs l ${whereSql}`).get(...params).c;
  const rows = db.prepare(
    `SELECT l.* FROM logs l ${whereSql} ORDER BY l.id DESC LIMIT ? OFFSET ?`
  ).all(...params, size, offset);
  res.json({ code: 0, data: { list: rows, total, page: pageNum, pageSize: size } });
});

// GET /api/logs/actions - 动作去重列表
router.get('/actions', (req, res) => {
  const rows = db.prepare('SELECT DISTINCT action FROM logs ORDER BY action').all();
  res.json({ code: 0, data: rows.map(r => r.action) });
});

/**
 * GET /api/logs/export - 导出操作日志（Excel）
 *
 * 为什么用 Excel 而不是 CSV：导出的直接用途是给院方 / 审计做台账，
 * CSV 的编码（UTF-8 无 BOM 时 Excel 一片乱码）与分隔符问题足够写一篇血泪史；
 * xlsx 本来就是项目依赖（问题记录导出已在用），不需要新增任何包。
 *
 * 安全与稳定性：
 *   · 行数上限 MAX_ROWS，避免有人点一下导出把几十万行捞进内存；
 *   · 命中上限时在响应头与被导出的最后一页写明「已截断」，不静默截胡；
 *   · 导出本身写一条操作日志 —— 批量把日志拉走是有审计意义的行为。
 */
const MAX_ROWS = 50000;

router.get('/export', (req, res) => {
  try {
    const { whereSql, params } = buildWhere(req.query);
    const total = db.prepare(`SELECT COUNT(*) c FROM logs l ${whereSql}`).get(...params).c;
    const rows = db.prepare(
      `SELECT l.id, l.created_at, l.username, l.action, l.detail, l.ip
       FROM logs l ${whereSql} ORDER BY l.id DESC LIMIT ?`
    ).all(...params, MAX_ROWS);

    const header = ['序号', '操作时间', '操作人', '动作', '详情', 'IP'];
    const data = [header].concat(rows.map((r, i) => {
      let detail = r.detail;
      // detail 有两种形态：纯文本，以及巡检台账那批的 JSON 字符串。
      // 导出成 Excel 时 JSON 会被一格塞爆（还带花括号），这里摊平成「k: v; k2: v2」。
      const s = String(detail == null ? '' : detail);
      if (s.trim().startsWith('{')) {
        try {
          const o = JSON.parse(s);
          detail = Object.keys(o).map((k) => k + ': ' + o[k]).join('; ');
        } catch (e) { detail = s; }
      }
      return [rows.length - i, r.created_at || '', r.username || '', r.action || '', String(detail == null ? '' : detail), r.ip || ''];
    }));

    if (rows.length >= MAX_ROWS) {
      data.push(['', '', '', '', '（已截断：本次仅导出最近 ' + MAX_ROWS + ' 条，请用日期范围缩小后再导）', '']);
    }

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = [
      { wch: 7 }, { wch: 20 }, { wch: 12 }, { wch: 16 }, { wch: 64 }, { wch: 16 },
    ];
    // 冻结表头，几百行往下翻时还知道每列是什么
    ws['!freeze'] = { xSplit: '0', ySplit: '1' };
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '操作日志');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
    const filename = `操作日志_${stamp}.xlsx`;

    logAction(req, '导出操作日志', {
      total: total, exported: rows.length, truncated: rows.length >= MAX_ROWS,
      range: [req.query.from || '', req.query.to || ''].join('~'),
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(filename));
    res.setHeader('X-Total-Count', String(total));
    res.setHeader('X-Exported-Count', String(rows.length));
    res.send(buf);
  } catch (e) {
    res.status(500).json({ code: 500, message: '导出失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
