'use strict';
/**
 * doctext 自测：文档正文提取（docx / pdf 两条路径）
 *
 * 为什么要自测：正文索引是「静默失效」的重灾区 —— 提取器返回空串时，
 * 上传依旧成功、界面一切正常，只是搜不到任何正文内容，没有任何报错。
 * 所以这里既验证「能提出字」，也验证「垃圾输入要老实说不行」。
 *
 * 覆盖：
 *   · 真实 docx（仓库里的部署手册）—— 端到端；
 *   · 现场拼一个最小 docx zip —— 验证 zip 解析不依赖某个特定生成器；
 *   · 现场拼 PDF（FlateDecode + Tj）—— 验证解压与文本操作符识别；
 *   · 坏输入（非 zip / 非 PDF / 扫描件式无文本）—— 必须返回 unsupported 而不是抛异常。
 *
 * 用法: node scripts/doctext-selftest.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const ROOT = path.join(__dirname, '..');
const doctext = require(path.join(ROOT, 'src', 'doctext'));

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
  else { fails.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctext-selftest-'));
const tmp = (name) => path.join(tmpDir, name);

/** 拼一个最小可用 zip（store 方式），用来造 docx 夹具 */
function buildZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach((f) => {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);       // store
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(0, 10);        // store
    cen.writeUInt32LE(0, 12);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    centrals.push(cen, nameBuf);

    offset += local.length + nameBuf.length + data.length;
  });
  const cenBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cenBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([Buffer.concat(locals), cenBuf, eocd]);
}

/** 最小 CRC32（zip 条目校验用） */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

console.log('\n=== 1. 纯函数：XML → 文本 ===');
{
  const xml = '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>第二段 &amp; 转义 &lt;标签&gt;</w:t></w:r><w:r><w:tab/><w:t>制表后</w:t></w:r></w:p>'
    + '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元格</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
  const text = doctext.docxXmlToText(xml);
  ok('段落之间换行', text.indexOf('第一段\n第二段') >= 0, text.split('\n').slice(0, 2));
  ok('实体被还原（& 与尖括号）', text.indexOf('第二段 & 转义 <标签>') >= 0, text);
  ok('表格里的文字也保留', text.indexOf('表格单元格') >= 0);
  ok('制表符保留', text.indexOf('\t') >= 0);
  ok('标签全部去掉（不留 <w: 这类标记）', text.indexOf('<w:') < 0, text);
}

console.log('\n=== 2. normalizeText ===');
{
  ok('连续空行压成一个', doctext.normalizeText('a\n\n\n\nb') === 'a\n\nb', doctext.normalizeText('a\n\n\n\nb'));
  ok('行内多余空格压缩', doctext.normalizeText('a    b') === 'a b');
  ok('CRLF 归一', doctext.normalizeText('a\r\nb') === 'a\nb');
}

console.log('\n=== 3. 真实 docx（仓库里的部署手册）===');
{
  const real = path.join(ROOT, '医院信息科日常管理系统-部署与使用手册.docx');
  if (!fs.existsSync(real)) {
    console.log('  [SKIP] 仓库里没有部署手册 docx，跳过端到端用例');
  } else {
    const buf = fs.readFileSync(real);
    const entries = doctext.listZipEntries(buf);
    ok('能列出 zip 条目', Array.isArray(entries) && entries.length > 3, entries && entries.length);
    ok('含 word/document.xml', !!doctext.readZipEntry(buf, entries, 'word/document.xml'));
  }
}

console.log('\n=== 4. 现场拼一个 docx（store 方式）===');
{
  const docXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + '<w:p><w:r><w:t>交换机默认口令是 admin</w:t></w:r></w:p>'
    + '<w:p><w:r><w:t>核心机房在门诊楼三层</w:t></w:r></w:p>'
    + '</w:body></w:document>';
  const file = tmp('sample.docx');
  fs.writeFileSync(file, buildZip([
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types/>' },
    { name: 'word/document.xml', data: docXml },
  ]));
  const r = doctext.extract(file, 'docx');
  r.then((res) => {
    ok('异步提取成功', res.ok === true, res.status);
    ok('正文含关键句', res.text.indexOf('交换机默认口令是 admin') >= 0, res.text.slice(0, 40));
    ok('两段都保留', res.text.indexOf('核心机房') >= 0);
    ok('状态为 ok', res.status === 'ok', res.status);
    runPdfTests();
  });
}

function runPdfTests() {
  console.log('\n=== 5. PDF（FlateDecode + Tj）===');
  const content = 'BT /F1 12 Tf 72 720 Td (Hello Hospital IT Report) Tj 0 -20 Td (Second line of text) Tj ET';
  const compressed = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const head = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1');
  const mid = Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1');
  const pdfFile = tmp('sample.pdf');
  fs.writeFileSync(pdfFile, Buffer.concat([head, compressed, mid]));

  const r = doctext.extractPdfText(pdfFile);
  ok('解压后能提取文本', r.ok === true, r.status + ' ' + (r.note || ''));
  ok('抓到第一行', r.text.indexOf('Hello Hospital IT Report') >= 0, r.text.slice(0, 60));
  ok('抓到第二行', r.text.indexOf('Second line of text') >= 0);

  console.log('\n=== 6. 坏输入必须老实说不行 ===');
  const fakePdf = tmp('fake.pdf');
  fs.writeFileSync(fakePdf, Buffer.from('%PDF-1.4\nno streams here\n%%EOF', 'latin1'));
  const bad = doctext.extractPdfText(fakePdf);
  ok('无文本层 PDF → unsupported（不抛异常）', bad.ok === false && bad.status === 'unsupported', bad.status);

  const notPdf = tmp('not.pdf');
  fs.writeFileSync(notPdf, Buffer.from('this is not a pdf at all', 'latin1'));
  const bad2 = doctext.extractPdfText(notPdf);
  ok('不是 PDF → unsupported', bad2.ok === false && bad2.status === 'unsupported', bad2.status);

  doctext.extract(notPdf, 'docx').then((r3) => {
    ok('拿 pdf 冒充 docx → unsupported（不崩）', r3.ok === false, r3.status);
    ok('乱码不算可读', doctext.looksReadable('\u0001\u0002\u0003abc') === false);
    ok('正常中文算可读', doctext.looksReadable('这是一段正常的中文巡检报告内容，用于验证可读性判定逻辑是否工作正常。') === true);

    console.log('\n=== 7. PDF 字符串转义 ===');
    ok('转义括号', doctext.decodePdfString('a\\(b\\)c') === 'a(b)c');
    ok('八进制', doctext.decodePdfString('\\101\\102') === 'AB');
    ok('换行转义', doctext.decodePdfString('a\\nb') === 'a\nb');

    finish();
  });
}

function finish() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
}
