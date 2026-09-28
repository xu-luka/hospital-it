'use strict';
/**
 * routes/inspection.js —— 巡检相关 API（替代原巡检系统的 web/server.js）
 *
 * 认证统一走业务系统的 JWT（req.user 由 src/auth.js 的 authRequired 中间件填充）。
 * 原巡检系统的 Session Cookie 与 CSRF 双重提交一并退役 —— Bearer token 由前端
 * 显式带在 Authorization 头，浏览器不会自动附加，CSRF 攻击面不存在。
 *
 * 权限映射（原巡检只有 admin/viewer 两级）：
 *   role 1 管理员 / 2 工程师 / 3 普通用户
 *   查看类（大屏、报告）全员可见；触发巡检限 1/2；重载配置与审计仅 1
 */
const express = require('express');
const { authRequired } = require('../auth');
const scheduler = require('../inspection/scheduler');
const store = require('../inspection/report-store');
const { logAction } = require('../utils');

const router = express.Router();

/**
 * 解析报告名。
 *
 * 只做一件事：decodeURIComponent 遇到畸形百分号序列（如 '%E4%'、'%zz'）会抛
 * URIError，若不捕获会冒泡到 Express 错误处理返回 500，把参数异常变成服务端异常。
 * 这里拦下来，后续交给文件名白名单按 400 处理。
 *
 * 关于中文与 latin1：Node 的 http 层本身会拒绝含未转义字符的请求路径
 * （ERR_UNESCAPED_CHARACTERS），因此不符合规范的请求到不了这里，无需额外兜底。
 */
function normalizeName(raw) {
  const s = String(raw || '');
  try { return decodeURIComponent(s); } catch (e) { return s; }
}

/** 是否允许写操作（1 管理员 / 2 工程师） */
function canOperate(u) { return u && (u.role_id === 1 || u.role_id === 2); }
function isAdmin(u) { return u && u.role_id === 1; }

/* ---------------- 只读：大屏状态 ---------------- */

router.get('/status', authRequired, (req, res) => {
  res.json({ code: 0, data: scheduler.buildStatus() });
});

/* ---------------- 只读：报告列表 ---------------- */

router.get('/reports', authRequired, (req, res) => {
  const r = store.listReports(scheduler.state.reportsDir);
  if (!r.ok) return res.json({ code: 500, message: r.error, data: { items: [] } });
  res.json({
    code: 0,
    data: {
      items: r.items.map((it) => ({
        name: it.name, size: it.size, stamp: it.stamp, weekly: it.weekly
      })),
      dir: scheduler.state.reportsDir
    }
  });
});

/**
 * 报告原文（在线预览 / 下载）。
 *
 * 安全要点：文件名即使来自内部列表，也仍要走 safeReportPath 严格校验。
 *   报告目录与存放 26 条设备凭据的配置文件同级 —— 一旦路径穿越成功，
 *   等于把整份机房资产清单和加密凭据交出去。不能因为「值是自家生成的」就跳过校验。
 *
 * CSP 处理：报告是自带内联 style/script 的单文件 HTML，若套用 default-src 'none'
 *   会全部失效渲染成白板，故此路由单独下发宽松策略。
 */
/** 报告原文（在线预览 / 下载）。 */
router.get('/reports/:name/raw', authRequired, (req, res) => {
  const name = normalizeName(req.params.name);
  const r = store.readReport(scheduler.state.reportsDir, name);
  if (!r.ok) {
    if (r.code === 400) logAction(req.user, '报告.路径拒绝', { name: String(name).slice(0, 120) });
    return res.status(r.code).json({ code: r.code, message: r.message });
  }
  logAction(req.user, '报告.下载', { name: r.name, size: r.size });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data:");
  res.setHeader('Content-Disposition',
    "inline; filename*=UTF-8''" + encodeURIComponent(r.name));
  res.end(r.html);
});

/* ---------------- 手动触发巡检 ---------------- */

router.post('/run', authRequired, async (req, res) => {
  if (!canOperate(req.user)) return res.status(403).json({ code: 403, message: '没有权限执行该操作' });
  if (scheduler.isRunning()) {
    return res.status(409).json({ code: 409, message: '上一轮巡检仍在进行中' });
  }
  logAction(req.user, '巡检.触发', {});
  const r = await scheduler.round('manual');
  if (r.skipped) return res.status(409).json({ code: 409, message: r.reason });
  if (!r.ok) return res.json({ code: 500, message: '巡检执行失败：' + (r.error || '未知'), data: null });
  res.json({ code: 0, message: '第 ' + r.roundNo + ' 轮巡检完成', data: scheduler.buildStatus() });
});

/* ---------------- 重载配置（仅管理员） ---------------- */

router.post('/reload', authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return res.status(403).json({ code: 403, message: '没有权限执行该操作' });
  const r = await scheduler.reloadConfig();
  logAction(req.user, '巡检.重载配置', { ok: r.ok, message: (r.message || '').slice(0, 200) });
  if (!r.ok) return res.json({ code: 400, message: r.message });
  res.json({ code: 0, message: r.message, data: { devices: r.devices } });
});

/* ---------------- 健康状态 ---------------- */

router.get('/health', authRequired, (req, res) => {
  res.json({ code: 0, data: scheduler.health() });
});

module.exports = router;
