'use strict';
/**
 * 巡检报告的网页访问（列表 + 详情）
 *
 * 安全设计（这是本模块的重点，报告目录与 config.json 同级，穿越成功即泄露全部设备凭据）：
 *  1. 白名单文件名格式：只接受「巡检报告_YYYYMMDD_HHMMSS.html」这一种形态，正则严格锚定
 *  2. 拒绝一切路径分隔符与上跳片段：/ \ .. %2e %2f %5c 空字节等，在解码前就拦掉
 *  3. 二次物理校验：resolve 后必须仍位于报告根目录内（realpath 比对，防符号链接逃逸）
 *  4. 只读打开，禁止写入；限制响应大小
 *  5. 列表不暴露绝对路径，只给文件名
 */
const fs = require('fs');
const path = require('path');

// 严格的报告文件名白名单：(巡检报告|巡检周报)_8位日期_6位时间.html
// 用「非捕获组」加入周报前缀，使 m[1]/m[2] 仍是日期与时间，
// safeReportPath 与 prettyStamp 的取值索引保持不变，安全约束也完全不放松。
const REPORT_NAME_RE = /^(?:巡检报告|巡检周报)_(\d{8})_(\d{6})\.html$/;

// 单份报告响应上限（实测均值约 29KB、最大约 114KB，留足余量）
const MAX_REPORT_BYTES = 8 * 1024 * 1024;

/**
 * 解析报告目录：支持相对路径（基于程序目录）、绝对路径、UNC。
 *
 * 回退规则必须与 inspect.writeReport() 保持一致：
 * writeReport 在配置目录不可写/不可达时会自动回退到 <程序目录>\reports，
 * 若本函数不做同样的回退，就会出现「周报/报告已成功写入本地 reports，
 * 但网页去读配置里那个不存在的盘符（如 NAS 未挂载、盘符在本机不存在），
 * 列表恒为空」的现象——文件在，却看不见。
 */
function resolveReportDir(configuredDir, baseDir, fallbackDir) {
  const base = baseDir || process.cwd();
  // 回退目录必须与写入端 inspect.writeReport() 完全一致，否则报告写进 A 目录、
  // 网页去读 B 目录，出现「文件存在但列表为空」。合并后统一由 paths.reportsDir()
  // 提供；传缺省值时沿用旧的 <base>/reports 行为，保持向后兼容。
  const localFallback = fallbackDir || path.join(base, 'reports');
  const raw = String(configuredDir || '').trim();
  if (!raw) return localFallback;
  const target = path.isAbsolute(raw) ? raw : path.join(base, raw);

  // 配置目录可读则优先使用（NAS 正常挂载、绝对路径有效）

  // 目标与回退目录相同时无需检查，直接使用
  if (target === localFallback) return target;

  // 配置目录可读则优先使用（NAS 正常挂载、绝对路径有效）
  try {
    fs.accessSync(target, fs.constants.R_OK);
    return target;
  } catch (e) {
    // 不可读（盘符不存在 / NAS 未挂载 / 权限不足）→ 回退到本地 reports，
    // 与写入端的回退目标一致，保证已生成的报告在网页上可见
    return localFallback;
  }
}

/**
 * 校验并解析报告文件名 → 绝对路径。
 * 任何不合规输入返回 null（不抛异常，由调用方统一回 400/404）。
 */
function safeReportPath(reportsDir, name) {
  const raw = String(name === null || name === undefined ? '' : name);

  // 1) 原始输入里就不允许出现任何路径成分
  if (raw.length === 0 || raw.length > 80) return null;
  if (raw.indexOf('\0') >= 0) return null;                 // 空字节截断
  if (/[\/\\]/.test(raw)) return null;                      // 路径分隔符
  if (raw.indexOf('..') >= 0) return null;                  // 上跳片段
  if (/^\.+$/.test(raw)) return null;                       // "." ".." 等
  if (/[\x00-\x1f\x7f]/.test(raw)) return null;             // 控制字符
  if (raw !== raw.trim()) return null;                      // 首尾空白（可能用于绕过）

  // 2) 百分号编码痕迹一律拒绝（交给上层先解码，这里不应再见到 %xx）
  if (/%[0-9a-fA-F]{2}/.test(raw)) return null;

  // 3) 严格匹配白名单文件名
  const m = REPORT_NAME_RE.exec(raw);
  if (!m) return null;

  // 4) 校验日期时间的数值合理性（防止 20261399 之类畸形但仍匹配 \d 的输入）
  const d = m[1], t = m[2];
  const mm = parseInt(d.slice(4, 6), 10), dd = parseInt(d.slice(6, 8), 10);
  const hh = parseInt(t.slice(0, 2), 10), mi = parseInt(t.slice(2, 4), 10), ss = parseInt(t.slice(4, 6), 10);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  if (hh > 23 || mi > 59 || ss > 59) return null;

  // 5) 拼接后必须仍在报告根目录内
  const base = path.resolve(reportsDir);
  const full = path.resolve(base, raw);
  if (full !== path.join(base, raw)) return null;
  if (path.dirname(full) !== base) return null;             // 必须直接位于根目录下
  if (!full.startsWith(base + path.sep)) return null;       // 双保险

  return full;
}

/** 列出报告（新的在前），不暴露绝对路径 */
function listReports(reportsDir) {
  let names = [];
  try {
    names = fs.readdirSync(reportsDir);
  } catch (e) {
    return { ok: false, error: '报告目录不可读：' + (e.code || e.message), items: [] };
  }
  const items = [];
  for (const n of names) {
    if (!REPORT_NAME_RE.test(n)) continue;      // 只列白名单文件，忽略其他任何文件
    const full = path.join(reportsDir, n);
    let st;
    try { st = fs.statSync(full); } catch (e) { continue; }
    if (!st.isFile()) continue;
    if (st.size > MAX_REPORT_BYTES) continue;   // 异常大文件不列入
    items.push({
      name: n,
      size: st.size,
      mtime: st.mtimeMs,
      mtimeText: formatTime(st.mtime),
      // 从文件名解析展示用的时间
      stamp: prettyStamp(n),
      // 是否周报：列表里用徽章区分「每周自动生成」与「手动巡检」
      weekly: n.indexOf('巡检周报_') === 0
    });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return { ok: true, items: items, dir: reportsDir };
}

function prettyStamp(name) {
  const m = REPORT_NAME_RE.exec(name);
  if (!m) return '';
  const d = m[1], t = m[2];
  return d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + ' '
    + t.slice(0, 2) + ':' + t.slice(2, 4) + ':' + t.slice(4, 6);
}

function formatTime(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 读取报告内容（校验后），失败返回 { ok:false, code, message } */
function readReport(reportsDir, name) {
  const full = safeReportPath(reportsDir, name);
  if (!full) return { ok: false, code: 400, message: '非法的报告名称' };

  // realpath 二次校验：防符号链接/junction 把文件指到目录外
  let real;
  try { real = fs.realpathSync(full); } catch (e) {
    return { ok: false, code: 404, message: '报告不存在' };
  }
  let realBase;
  try { realBase = fs.realpathSync(path.resolve(reportsDir)); } catch (e) {
    return { ok: false, code: 500, message: '报告目录不可用' };
  }
  if (path.dirname(real) !== realBase) {
    return { ok: false, code: 400, message: '非法的报告路径' };
  }

  let st;
  try { st = fs.statSync(real); } catch (e) {
    return { ok: false, code: 404, message: '报告不存在' };
  }
  if (!st.isFile()) return { ok: false, code: 404, message: '报告不存在' };
  if (st.size > MAX_REPORT_BYTES) return { ok: false, code: 413, message: '报告文件过大' };

  let html;
  try { html = fs.readFileSync(real, 'utf8'); } catch (e) {
    return { ok: false, code: 500, message: '报告读取失败' };
  }
  return { ok: true, html: html, name: path.basename(full), size: st.size, mtime: st.mtime };
}


/**
 * 注意：原 renderReportList（HTML 列表页）已移除 —— 合并后列表由 Vue 组件渲染，
 * 数据经 /api/inspection/reports 以 JSON 提供。安全相关的四个函数原样保留。
 */

// ==================== 打印 / 导出 PDF 增强 ====================

/**
 * 打印版样式。
 *
 * 关键点（都是实测踩出来的）：
 *  1. 报告卡片默认是折叠的（.card-body{display:none}），打印必须强制展开，
 *     否则导出的 PDF 只有一排标题、没有任何巡检数据；
 *  2. 用户可能在页面上点过「只看严重」，那次点击会把其它卡片写成
 *     style="display:none"（内联样式），CSS 覆盖不掉 —— 所以脚本里还要在
 *     beforeprint 时把内联 display 清掉；
 *  3. 浏览器默认不打印背景色，不加 print-color-adjust 的话「正常/严重」的红绿
 *     色块全变白，报告在纸面上就失去意义了；
 *  4. @page 设成 A4 + 12mm 边距，页眉页脚由浏览器自带（页码它自己会加）。
 */
const PRINT_CSS = `
@page { size: A4; margin: 12mm 10mm; }
.print-toolbar {
  position: fixed; top: 12px; right: 12px; z-index: 9999;
  display: flex; align-items: center; gap: 10px;
  background: #ffffff; border: 1px solid #d1d5db; border-radius: 10px;
  padding: 10px 14px; box-shadow: 0 6px 20px rgba(15,23,42,.14);
  font: 13px/1.4 "Segoe UI","Microsoft YaHei",Arial,sans-serif;
}
.print-toolbar .hint { color: #6b7280; max-width: 260px; }
.print-toolbar button {
  border: 0; border-radius: 7px; padding: 8px 14px; font-size: 13px;
  font-weight: 600; cursor: pointer; background: #2563eb; color: #fff;
}
.print-toolbar button.ghost { background: #f3f4f6; color: #374151; }
.print-toolbar button:hover { filter: brightness(1.06); }
@media print {
  .print-toolbar { display: none !important; }
  body { background: #fff !important; padding: 0 !important; }
  .wrap { max-width: none !important; }
  .filters { display: none !important; }
  .card { border: 1px solid #c7cdd6 !important; break-inside: auto; page-break-inside: auto; }
  .card-head { background: #f3f4f6 !important; break-after: avoid; page-break-after: avoid; }
  .card-body { display: block !important; }
  .card.open .card-body { display: block !important; }
  .arrow { display: none !important; }
  .summary { grid-template-columns: repeat(5, 1fr) !important; gap: 8px !important; }
  .stat { border: 1px solid #c7cdd6 !important; break-inside: avoid; padding: 10px 12px !important; }
  .stat .num { font-size: 20px !important; }
  h1 { font-size: 17pt !important; }
  .meta { margin-bottom: 10px !important; }
  table { font-size: 10.5pt !important; }
  th, td { padding: 4px 6px !important; }
  thead { display: table-header-group; }   /* 表格跨页时重复表头 */
  pre { max-height: none !important; border: 1px solid #334155 !important; }
  .kv { grid-template-columns: repeat(3, 1fr) !important; gap: 6px !important; }
  .kv .item { break-inside: avoid; padding: 6px 8px !important; }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}
`;

/** HTML 属性/文本转义（报告名来自文件名，仍按不可信处理） */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 给任意一份巡检报告 HTML 注入「打印 / 导出 PDF」能力。
 * 对**已经生成的历史报告**同样有效 —— 不改生成器、不需要重新巡检。
 * @param {string} html 报告原文
 * @param {{name?:string}} opts
 * @returns {string}
 */
function enhanceForPrint(html, opts) {
  const src = String(html || '');
  // 报告文件名只用来在工具条上标一下「你在打哪一份」，仍按不可信文本转义
  const name = esc((opts && opts.name) || '巡检报告');

  const toolbar = `
<div class="print-toolbar" id="print-toolbar">
  <span class="hint"><b>${name}</b><br>在打印对话框里把「目标打印机」选成「另存为 PDF」即可导出文件；纸张选 A4、勾选「背景图形」效果最佳。</span>
  <button type="button" onclick="window.print()">打印 / 另存为 PDF</button>
  <button type="button" class="ghost" onclick="window.close()">关闭</button>
</div>
<script>
(function () {
  // 用户在页面上点过筛选按钮会留下 style="display:none"，打印时必须还原，
  // 否则 PDF 里会缺掉被筛掉的设备（而且看起来像是「报告本身没数据」）。
  function expandAll() {
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      cards[i].style.display = '';
      cards[i].classList.add('open');
    }
  }
  expandAll();
  window.addEventListener('beforeprint', expandAll);
  window.addEventListener('afterprint', function () {});
})();
</script>`;

  let out = src;
  const styleTag = '<style id="print-enhance">' + PRINT_CSS + '</style>';
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, styleTag + '\n</head>');
  else out = styleTag + out;

  // 工具条放在 body 开头，否则被超长报告推到页面最底部，用户根本看不到
  if (/<body[^>]*>/i.test(out)) out = out.replace(/<body([^>]*)>/i, (m) => m + toolbar);
  else out = toolbar + out;

  return out;
}

module.exports = {
  REPORT_NAME_RE, MAX_REPORT_BYTES,
  resolveReportDir, safeReportPath, listReports, readReport, prettyStamp,
  enhanceForPrint, PRINT_CSS,
};
