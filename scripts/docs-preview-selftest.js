#!/usr/bin/env node
'use strict';
/**
 * docs-preview-selftest.js —— 技术文档库「预览方式判定」的离线自测。
 *
 * 为什么单测这个函数：
 *   它出过一次非常隐蔽的线上问题 —— 列表与详情接口写的是 `previewKindOf(d.ext)`
 *   （只传扩展名字符串），而函数体按整行记录读 `d.real_ext || d.ext`。
 *   在字符串上取 `.real_ext` 是 undefined，`String(undefined || undefined || '')`
 *   得到空串，于是**每个**文档的 preview_kind 都是 ''，
 *   前端一律走 `v-else` 分支，弹窗写「该类型暂不支持预览」——
 *   PDF 和 Word 全预览不了。
 *
 *   为什么以前没被发现：
 *     · 接口照样 200，没有任何报错；
 *     · /preview 接口自己是好的（它传的是整行），所以「起服务直接拉 PDF」完全正常；
 *     · 前端只在点了「预览」之后才显形，而那时已经进入了兜底分支。
 *   所以要拦住它，断言里必须写清「传进去的东西长什么样」，只测 happy path 没用。
 *
 * 用法：node scripts/docs-preview-selftest.js
 */
const path = require('path');
const { previewKindOf } = require(path.join(__dirname, '..', 'src', 'routes', 'docs.js'));

let pass = 0;
let fail = 0;
function eq(title, got, want) {
  if (got === want) { pass++; console.log('  [OK]   ' + title + ' → ' + JSON.stringify(got)); }
  else { fail++; console.log('  [失败] ' + title + ' → 得到 ' + JSON.stringify(got) + '，期望 ' + JSON.stringify(want)); }
}

console.log('== 整行记录（table row）形态 —— 这是接口现在的调用方式 ==');
eq('纯 PDF', previewKindOf({ ext: 'pdf' }), 'pdf');
eq('扩展名带点 .pdf', previewKindOf({ ext: '.pdf' }), 'pdf');
eq('大写 PDF', previewKindOf({ ext: 'PDF' }), 'pdf');
eq('docx', previewKindOf({ ext: 'docx' }), 'docx');
eq('旧版 .doc 未转换 → 走文本预览', previewKindOf({ ext: 'doc' }), 'doc');
eq('旧版 .doc 已转换出 docx → 走 docx-preview', previewKindOf({ ext: 'doc', converted_name: 'a.docx' }), 'docx');
eq('real_ext 优先于 ext（.doc 改名成 .docx 的场景）',
  previewKindOf({ ext: 'docx', real_ext: 'doc' }), 'doc');
eq('real_ext 优先于 ext（.doc 改名成 .pdf 的场景）',
  previewKindOf({ ext: 'pdf', real_ext: 'doc', converted_name: '' }), 'doc');
eq('xlsx 不支持预览', previewKindOf({ ext: 'xlsx' }), '');
eq('空行', previewKindOf({}), '');
eq('传 null', previewKindOf(null), '');

console.log('');
console.log('== 兼容形态：只给一个扩展名字符串 ==');
// 这一组就是历史 bug 的形状。归一化之后必须仍然给出正确答案，
// 否则将来有人又写成 previewKindOf(d.ext) 时会静默退化。
eq('字符串 pdf', previewKindOf('pdf'), 'pdf');
eq('字符串 .pdf', previewKindOf('.pdf'), 'pdf');
eq('字符串 docx', previewKindOf('docx'), 'docx');
eq('字符串 doc（拿不到 converted_name，只能保守判成 doc）', previewKindOf('doc'), 'doc');
eq('字符串 xlsx', previewKindOf('xlsx'), '');
eq('空字符串', previewKindOf(''), '');

console.log('');
console.log('== 回归护栏：两种形态在「普通文件」上必须给出同一个答案 ==');
// 这是当初失效的那条路径的核心断言：行 vs 字符串 必须一致。
// 只要有人把归一化删掉，传字符串就会变成 '' —— 这里立刻红。
['pdf', 'docx', 'doc', 'xlsx'].forEach(function (e) {
  const byRow = previewKindOf({ ext: e });
  const byStr = previewKindOf(e);
  eq('ext=' + e + ' 时 行与字符串结果一致（行=' + JSON.stringify(byRow) + '）', byStr, byRow);
});

console.log('');
console.log('== 反向验证：把历史错法模拟一遍，必须得到空串（证明这组断言有判别力）==');
// 复刻旧函数体：只读 d.real_ext || d.ext，不做归一化。
// 用它去解「只传扩展名字符串」的场景，必然得到空串 ——
// 如果这里不是空串，说明我上面那组一致性断言其实没在测什么。
function legacyPreviewKindOf(d) {
  const e = String((d.real_ext || d.ext) || '').toLowerCase();
  if (e === 'pdf') return 'pdf';
  if (e === 'docx') return 'docx';
  if (e === 'doc') return d.converted_name ? 'docx' : 'doc';
  return '';
}
eq('旧函数体解字符串 "pdf" 得到空串（即历史 bug 的成因）', legacyPreviewKindOf('pdf'), '');
eq('新函数解同样的字符串则正常', previewKindOf('pdf'), 'pdf');

console.log('');
console.log('='.repeat(58));
if (fail) { console.log('失败 ' + fail + ' 项 / 共 ' + (pass + fail) + ' 项'); process.exit(1); }
console.log('全部通过（' + pass + ' 项）');
