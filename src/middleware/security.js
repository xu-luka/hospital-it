'use strict';
/**
 * security.js —— 安全响应头与 CSP
 *
 * 这套东西来自原巡检系统的 web/server.js。原「医院信息科日常管理系统」
 * 完全没有下发任何安全头，而巡检系统有一套写得不错的防御，必须搬过来而不是丢掉。
 *
 * 关键取舍：SPA 的 CSP 必须放行 'unsafe-eval'。
 *   前端用的是 Vue 3 的 vue.global.prod.js（浏览器内运行时编译模板版本），
 *   渲染组件模板时内部用 new Function 构造渲染函数。若 CSP 禁掉 eval，
 *   页面会直接白屏 —— 这是上线前最容易踩的一个坑。
 *
 *   真正的 XSS 防线是逐处输出转义，CSP 在这里的定位是「纵深防御」：
 *   限制外联与外部资源加载，阻断数据向外部域名回传。
 */
const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-XSS-Protection': '0',                       // 已废弃且会引入漏洞，显式关闭
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()'
};

/**
 * SPA 页面 CSP。
 * img-src / frame-src 需要 blob: —— 巡检报告是在浏览器里用 blob URL 预览的。
 */
const CSP_PAGE = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'"
].join('; ');

/** API 响应 CSP：最严格，不需要任何资源加载能力 */
const CSP_API = "default-src 'none'; frame-ancestors 'none'";

function applyBase(res) {
  for (const k of Object.keys(BASE_HEADERS)) res.setHeader(k, BASE_HEADERS[k]);
}

/**
 * 给页面响应套安全头。静态资源不套 no-store（否则每次全量重拉 vue/vendors）。
 * @param {boolean} isApi 是否 API 响应
 */
function applyHeaders(req, res, next) {
  const isApi = req.path.startsWith('/api/');
  applyBase(res);
  res.setHeader('Content-Security-Policy', isApi ? CSP_API : CSP_PAGE);
  if (isApi) res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = { applyHeaders, BASE_HEADERS, CSP_PAGE, CSP_API };
