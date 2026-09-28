'use strict';
/**
 * check-views.js —— 校验「路由返回的组件名」能否被 Vue 正确解析到「已注册的组件名」
 *
 * 背景：static/js/main.js 里通过 <component :is="curView"> 动态切换视图。
 * Vue 解析组件名时只尝试三种写法（resolveAsset / rs()）：
 *     原样  →  big-screen-view
 *     camelize           →  bigScreenView
 *     capitalize(camelize) →  BigScreenView
 * 因此路由字符串必须与注册名在 kebab / Pascal 上严格对应，否则 Vue 会把它
 * 当成未知原生 HTML 标签渲染成一个空元素 —— 页面整块空白，且 prod 构建下
 * 控制台不会打印任何警告（warnMissing=false），排查极其困难。
 *
 * 典型事故：路由返回 'bigscreen-view'，注册名却是 'BigScreenView'。
 * 因为 bigscreen 中间没有连字符，camelize 只能得到 bigscreenView / BigscreenView，
 * 永远还原不出 BigScreen —— 监控大屏因此白屏。
 *
 * 用法：node scripts/check-views.js
 * 退出码：0 全部匹配；1 存在无法解析的组件名
 */
const fs = require('fs');
const path = require('path');

const MAIN = path.resolve(__dirname, '..', 'static', 'js', 'main.js');

const camelize = (s) => s.replace(/-\w/g, (m) => m.slice(1).toUpperCase());
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * 扫描 main.js，返回 { used, registered, bad, rows }
 * used —— 路由里出现的组件名（kebab）
 * registered —— 已注册组件名（PascalCase）
 * bad —— 无法解析到注册名的组件名（对应页面会白屏）
 */
function analyze() {
  // 先剥离注释再扫描：注释里常会引用出错的名字做说明（如 'bigscreen-view'），
  // 若一并统计会造成误报。
  const src = fs.readFileSync(MAIN, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');

  // 注册名：app.component('XxxView', ...) 与循环注册数组里出现的 'XxxView'
  const registered = new Set();
  for (const m of src.matchAll(/app\.component\(\s*'([A-Za-z0-9]+)'/g)) registered.add(m[1]);
  for (const m of src.matchAll(/'([A-Z][A-Za-z0-9]*(?:View|Modal))'/g)) registered.add(m[1]);

  // 路由返回值：curView 里所有形如 'xxx-view' 的字符串字面量
  // （含 return 'a' 与 cond ? 'a' : 'b' 两种写法，避免三元分支被漏检）
  const used = [];
  for (const m of src.matchAll(/'([a-z][a-zA-Z0-9-]*-view)'/g)) {
    if (!used.includes(m[1])) used.push(m[1]);
  }

  const rows = [];
  const bad = [];
  for (const name of used) {
    const variants = [name, camelize(name), capitalize(camelize(name))];
    const hit = variants.some((v) => registered.has(v));
    rows.push({ name: name, variants: variants, hit: hit });
    if (!hit) bad.push(name);
  }
  return { used: used, registered: Array.from(registered), bad: bad, rows: rows };
}

module.exports = { analyze: analyze };

if (require.main === module) {
  const r = analyze();
  for (const row of r.rows) {
    console.log((row.hit ? '  OK   ' : '  FAIL ') + row.name + '  →  ' + row.variants.join(' / '));
  }
  console.log('\n已注册组件 ' + r.registered.length + ' 个，路由引用 ' + r.used.length + ' 个。');
  if (r.bad.length) {
    console.error('\n[FAIL] 以下组件名无法解析到任何已注册组件（对应页面会白屏）：');
    r.bad.forEach((n) => console.error('  - ' + n
      + '  （注册名应改为 ' + capitalize(camelize(n)) + '，或把路由值改成能 camelize 回去的 kebab 形式）'));
    process.exit(1);
  }
  console.log('[OK] 全部路由组件名均可正确解析。');
}
