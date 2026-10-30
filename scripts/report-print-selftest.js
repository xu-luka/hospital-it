'use strict';
/**
 * 巡检报告「打印 / 导出 PDF」转换自测（纯函数，不需要起服务、不需要浏览器）
 *
 * 用法：node scripts/report-print-selftest.js
 *
 * 为什么单独测：本机 data/inspection.json 的 servers 是空的，整套巡检路由不会挂载
 * （server.js 里 mountInspection 是一个大 try/catch，装不上就整块下线 —— 这是设计如此），
 * 所以「导出 PDF」的 HTTP 通路在开发机上打不通。但真正容易出错的是这层 HTML 转换：
 * 少一条 CSS，PDF 里就只剩标题没有数据，而页面上看不出任何异常。
 */
const path = require('path');
const store = require(path.join(__dirname, '..', 'src', 'inspection', 'report-store'));

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra !== undefined && extra !== '' ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra !== undefined ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra !== undefined ? ' -> ' + extra : '')); }
}

// 造一份和真实报告同构的 HTML：有 head/body、有折叠卡片、有表格、有彩色状态徽标
const MARK = 'REPORT_BODY_MARKER_9527';
const SRC = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<title>巡检报告 2026-10-30</title>
<style>.card-body{display:none}</style>
</head><body>
<h1>医院信息科日常巡检报告</h1>
<div class="wrap">
  <div class="card" id="c1">
    <div class="card-head">服务器状态 <span class="arrow">▼</span></div>
    <div class="card-body"><table><thead><tr><th>设备</th><th>状态</th></tr></thead>
      <tbody><tr><td>HIS-DB01</td><td class="bad">严重</td></tr></tbody></table></div>
  </div>
  <div class="card collapsed" id="c2" style="display:none">
    <div class="card-head">网络设备</div>
    <div class="card-body">${MARK}</div>
  </div>
</div>
</body></html>`;

console.log('== 打印版转换 ==');
const out = store.enhanceForPrint(SRC, { name: '巡检报告-20261030.html' });

ok('返回字符串且非空', typeof out === 'string' && out.length > SRC.length, out.length + ' 字符');
ok('含 A4 页面规则', out.indexOf('@page') >= 0 && /size:\s*A4/.test(out));
ok('页边距已设置', /@page[^}]*margin:\s*12mm 10mm/.test(out));
ok('★ 强制展开 .card-body（否则 PDF 只有标题没数据）', /\.card-body\s*\{\s*display:\s*block\s*!important/.test(out));
ok('★ 也覆盖 .card.open 变体', /\.card\.open\s+\.card-body\s*\{\s*display:\s*block\s*!important/.test(out));
ok('★ 打印颜色保真（否则红/绿徽标印成白底）', out.indexOf('print-color-adjust: exact') >= 0);
ok('表格跨页重复表头', /thead\s*\{\s*display:\s*table-header-group/.test(out));
ok('工具条打印时不出现', /@media print[\s\S]*\.print-toolbar\s*\{\s*display:\s*none\s*!important/.test(out));
ok('仪表盘统计块改为 5 列', /\.summary\s*\{[^}]*repeat\(5,\s*1fr\)/.test(out));

console.log('\n== 注入位置 ==');
const bodyAt = out.indexOf('<body>');
const tbAt = out.indexOf('id="print-toolbar"');   // 不能搜 'print-toolbar'：CSS 里也有这个选择器，会先命中 head 里的样式
ok('工具条紧跟 <body> 之后（不会被长报告推到最底部）', bodyAt >= 0 && tbAt > bodyAt && tbAt - bodyAt < 60, '距离 ' + (tbAt - bodyAt) + ' 字符');
const headAt = out.indexOf('</head>');
const styleAt = out.indexOf('id="print-enhance"');
ok('打印样式注入在 </head> 之前', styleAt > 0 && styleAt < headAt);
ok('原有 <style> 未被破坏', out.indexOf('.card-body{display:none}') >= 0);
ok('原有正文完整保留', out.indexOf(MARK) >= 0);
ok('<title> 没有重复注入', (out.match(/<title/gi) || []).length === 1, (out.match(/<title/gi) || []).length + ' 个');

console.log('\n== 卡片展开脚本 ==');
ok('注入 expandAll', out.indexOf('function expandAll') >= 0);
ok('加载即展开（不用等用户点打印）', /expandAll\(\);\s*\n\s*window\.addEventListener\('beforeprint'/.test(out));
ok('监听 beforeprint 再展开一次', out.indexOf("addEventListener('beforeprint', expandAll)") >= 0);
ok('清除内联 display:none（筛选留下的残留）', /style\.display\s*=\s*''/.test(out));

console.log('\n== 报告名转义 ==');
const evil = store.enhanceForPrint(SRC, { name: '<img src=x onerror=alert(1)>.html' });
ok('文件名里的尖括号被转义', evil.indexOf('<img src=x') < 0 && evil.indexOf('&lt;img src=x') >= 0);
const dflt = store.enhanceForPrint(SRC, {});
ok('不传名字时用默认标题', dflt.indexOf('<b>巡检报告</b>') >= 0);

console.log('\n== 边界输入不炸 ==');
[['空串', ''], ['null', null], ['undefined', undefined]].forEach(function (pair) {
  let r = null, err = null;
  try { r = store.enhanceForPrint(pair[1], {}); } catch (e) { err = e; }
  ok('输入为 ' + pair[0] + ' 时不抛异常且返回 CSS', !err && typeof r === 'string' && r.indexOf('@page') >= 0, err ? String(err.message) : (r || '').length + ' 字符');
});
// 没有 head/body 的片段（历史报告里可能有）
const frag = store.enhanceForPrint('<div class="card"><div class="card-body">只有片段</div></div>', { name: 'frag' });
ok('无 head/body 的片段也能注入样式', frag.indexOf('id="print-enhance"') >= 0 && frag.indexOf('只有片段') >= 0);
ok('片段模式下工具条仍在最前', frag.indexOf('id="print-toolbar"') < frag.indexOf('只有片段'));

console.log('\n== 路由挂接（静态检查）==');
const fs = require('fs');
const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'inspection.js'), 'utf8');
ok('存在 /reports/:name/print 路由', routeSrc.indexOf("'/reports/:name/print'") >= 0);
ok('打印路由走 readReport（复用同一套路径校验）', /reports\/:name\/print'[\s\S]{0,400}store\.readReport\(/.test(routeSrc));
ok('打印路由调用 enhanceForPrint', /reports\/:name\/print'[\s\S]{0,600}enhanceForPrint\(/.test(routeSrc));
ok('打印路由需要登录', /reports\/:name\/print',\s*authRequired/.test(routeSrc));
ok('打印响应带 CSP 头', /reports\/:name\/print'[\s\S]{0,900}Content-Security-Policy/.test(routeSrc));

const cssSrc = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'inspect-screen.js'), 'utf8');
ok('前端调的是 /print 而不是 /raw', cssSrc.indexOf("'/print'") >= 0);
ok('前端用 token 取打印版（不能用 window.open）', /reports\/' \+ encodeURIComponent\(item\.name\) \+ '\/print'/.test(cssSrc));
ok('前端用隐藏 iframe 调 print()', cssSrc.indexOf('contentWindow') >= 0 && cssSrc.indexOf('.print()') >= 0);

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
console.log('全部通过');
