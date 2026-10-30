'use strict';
/**
 * doctext.js —— 从 Word / PDF 里提取纯文本，供技术文档库做「正文检索」。
 *
 * 为什么自己写而不装库：
 *   部署目录是自包含的（服务器不联网、不跑 npm install），更新包也只能替换文件，
 *   新增 npm 依赖等于要求现场装包 —— 直接排除。docx 本身只是一个 zip +
 *   一份 XML，用 Node 自带的 zlib 就够；PDF 走「尽力而为」。
 *
 * 三种格式的能力边界（诚实标注，不假装都能做）：
 *   · .docx —— 完整正文（word/document.xml），保留段落换行与制表符；
 *   · .doc  —— 复用 docpreview 的 word-extractor 文本提取；
 *   · .pdf  —— 尽力提取：解压 FlateDecode 流，抓 Tj/TJ 里的字符串。
 *              用 CID 字体（Identity-H，中文 PDF 常见）且没有 ToUnicode 映射时
 *              提不出可读文字，此时返回 unsupported，由调用方在界面上如实标注，
 *              而不是给一个「索引成功但搜不到」的假象。
 *
 * 返回统一形状：{ ok, text, status, note }
 *   status: 'ok' | 'empty' | 'unsupported' | 'error'
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/** 正文入库上限：再长也搜得动，但没必要把整本手册塞进 LIKE 查询 */
const MAX_TEXT_CHARS = 200000;

// ==================== 最小 ZIP 读取（只支持 store / deflate） ====================

const SIG_EOCD = 0x06054b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;

/** 从尾部找中央目录结束记录（EOCD 之后最多 65535 字节注释） */
function findEocd(buf) {
  const min = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 列出 zip 内所有条目：{ name, method, compSize, uncompSize, localOffset }
 * 解析失败返回 null（不是 zip 就当不支持，不抛异常给上层）
 */
function listZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (!count || p <= 0 || p >= buf.length) return null;

  const out = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== SIG_CEN) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    // 0xFFFFFFFF 表示 ZIP64 扩展字段，本项目不处理（Word 生成的 docx 不会这么大）
    if (compSize === 0xffffffff || localOffset === 0xffffffff) { p += 46 + nameLen + extraLen + commentLen; continue; }
    out.push({ name, method, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 读取 zip 内某条目的原始内容（Buffer），不存在/解压失败返回 null */
function readZipEntry(buf, entries, name) {
  const e = (entries || []).find((x) => x.name === name);
  if (!e) return null;
  const lo = e.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== SIG_LOC) return null;
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const raw = buf.slice(start, start + e.compSize);
  if (e.method === 0) return raw;            // store
  if (e.method === 8) {                       // deflate
    try { return zlib.inflateRawSync(raw); } catch (err) { return null; }
  }
  return null;                                // 其它压缩方式（如 bzip2）不支持
}

// ==================== XML → 纯文本 ====================

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    const v = XML_ENTITIES[g.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/**
 * docx 正文 XML → 文本。
 * 只关心段落与制表符，其余标签一律去掉：表格里的文字也在 <w:t> 里，
 * 所以表格内容会以「一格一行」的形式保留下来，够搜索用了。
 */
function docxXmlToText(xml) {
  let s = String(xml);
  s = s.replace(/<w:tab\b[^>]*\/>/g, '\t');
  s = s.replace(/<w:br\b[^>]*\/>/g, '\n');
  s = s.replace(/<\/w:p>/g, '\n');           // 段落结束换行
  s = s.replace(/<\/w:tr>/g, '\n');          // 表格行结束换行
  s = s.replace(/<[^>]+>/g, '');             // 去掉全部标签
  s = decodeEntities(s);
  return normalizeText(s);
}

/** 统一空白：行内连续空白压成一个空格，最多留一个空行 */
function normalizeText(s) {
  return String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+/g, (m) => (m.indexOf('\t') >= 0 ? '\t' : ' '))
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ==================== PDF 尽力提取 ====================

/** 解 PDF 字符串转义：\( \) \\ \n \r \t \b \f \ooo */
function decodePdfString(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') { out += c; continue; }
    const n = raw[++i];
    if (n === undefined) break;
    if (n === 'n') out += '\n';
    else if (n === 'r') out += '\r';
    else if (n === 't') out += '\t';
    else if (n === 'b') out += '\b';
    else if (n === 'f') out += '\f';
    else if (n >= '0' && n <= '7') {
      let oct = n;
      while (oct.length < 3 && raw[i + 1] >= '0' && raw[i + 1] <= '7') oct += raw[++i];
      out += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (n === '\n') { /* 续行：忽略 */ }
    else out += n;   // \( \) \\ 以及未知转义都取字面
  }
  return out;
}

/** 把 PDF 文本片段转成 JS 字符串：优先认 UTF-16BE BOM，否则按 latin1 */
function pdfFragmentToString(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) {
      s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return s;
  }
  // 无 BOM 但呈 UTF-16BE 特征（高位多为 0 或 4E-9F 区间的中文）时按 UTF-16BE 解
  if (bytes.length >= 4 && bytes.length % 2 === 0) {
    let high = 0;
    for (let i = 0; i + 1 < bytes.length; i += 2) if (bytes[i] === 0) high++;
    if (high >= bytes.length / 2 - 1) {
      let s = '';
      for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
      return s;
    }
  }
  return Buffer.from(bytes).toString('latin1');
}

/** 把 latin1 字符串按字节还原后，若是 UTF-16BE 文本则转成正常字符串 */
function utf16IfNeeded(s) {
  if (String(s).indexOf('\u0000') < 0) return s;
  const bytes = [];
  for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
  return pdfFragmentToString(bytes);
}

/** 从一段已解压的内容流里抓文本：(...)Tj / [...]TJ / ' / " */
function extractFromContentStream(text) {
  const parts = [];
  // 字符串字面量（考虑括号嵌套与转义）
  let i = 0;
  const ops = [];
  while (i < text.length) {
    const c = text[i];
    if (c === '(') {
      let depth = 1;
      let j = i + 1;
      let raw = '';
      while (j < text.length && depth > 0) {
        const ch = text[j];
        if (ch === '\\') { raw += ch + (text[j + 1] === undefined ? '' : text[j + 1]); j += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
        raw += ch;
        j++;
      }
      // 看这个字符串后面跟的操作符
      // ★ 窗口要留够：只截 2 个字符时，' Tj' 里的 'T' 后面的 'j' 会被切掉，
      //   正则永远匹配不上，结果就是「PDF 明明有文本却一条都提不出来」。
      const after = text.slice(j + 1, j + 8);
      const isTextOp = /^\s*(Tj|TJ|'|")/.test(after);
      if (isTextOp) ops.push(utf16IfNeeded(decodePdfString(raw)));
      i = j + 1;
      continue;
    }
    if (c === '<' && text[i + 1] !== '<') {   // 十六进制字符串 <00480065>
      const end = text.indexOf('>', i);
      if (end > i) {
        const hex = text.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
        if (hex.length >= 4 && hex.length % 4 === 0) {
          const bytes = [];
          for (let k = 0; k + 1 < hex.length; k += 2) bytes.push(parseInt(hex.substr(k, 2), 16));
          const after = text.slice(end + 1, end + 8);
          if (/^\s*(Tj|TJ)/.test(after)) ops.push(pdfFragmentToString(bytes));
        }
        i = end + 1;
        continue;
      }
    }
    if (c === 'T' && (text[i + 1] === 'd' || text[i + 1] === 'D')) { ops.push('\n'); i += 2; continue; }
    i++;
  }
  return ops.join('');
}

/** 判断提取结果是否「像人话」：可读字符占比够高才算成功 */
function looksReadable(s) {
  const t = String(s || '').trim();
  if (t.length < 20) return false;
  let good = 0;
  const n = Math.min(t.length, 20000);
  for (let i = 0; i < n; i++) {
    const c = t.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3000 && c <= 0x303f) || (c >= 0x20 && c <= 0x7e) || c === 0x0a || c === 0x0d || c === 0x09) good++;
  }
  return good / n >= 0.6;
}

function extractPdfText(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.slice(0, 5).toString('latin1') !== '%PDF-') {
    return { ok: false, text: '', status: 'unsupported', note: '不是有效的 PDF 文件' };
  }
  const chunks = [];
  // 逐个 stream 处理：字典里含 FlateDecode 就先解压，否则按明文读
  const re = /stream\r?\n/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    const start = m.index + m[0].length;
    const end = buf.indexOf('endstream', start);
    if (end < 0) break;
    let raw = buf.slice(start, end);
    // 尾部可能跟一个换行
    if (raw.length && raw[raw.length - 1] === 0x0a) raw = raw.slice(0, raw.length - 1);
    if (raw.length && raw[raw.length - 1] === 0x0d) raw = raw.slice(0, raw.length - 1);

    // 往前找字典，判断是否 FlateDecode
    const dictStart = Math.max(0, m.index - 800);
    const dict = buf.slice(dictStart, m.index).toString('latin1');
    let content = null;
    if (/\/FlateDecode/.test(dict)) {
      try { content = zlib.inflateSync(raw); } catch (e) { content = null; }
    } else if (!/\/Filter/.test(dict)) {
      content = raw;
    }
    if (content) {
      const txt = extractFromContentStream(content.toString('latin1'));
      if (txt && txt.trim()) chunks.push(txt);
    }
    re.lastIndex = end + 9;
  }

  const text = normalizeText(chunks.join('\n'));
  if (!text) {
    return { ok: false, text: '', status: 'unsupported', note: 'PDF 未包含可直接提取的文本层（可能是扫描件或使用 CID 字体）' };
  }
  if (!looksReadable(text)) {
    return { ok: false, text: '', status: 'unsupported', note: 'PDF 使用了不可直读的字体编码（常见于中文 PDF），正文未能建索引' };
  }
  return { ok: true, text: text.slice(0, MAX_TEXT_CHARS), status: 'ok', note: '' };
}

// ==================== 对外入口 ====================

/**
 * 提取文档正文。
 * @param {string} filePath 磁盘绝对路径
 * @param {string} kind     真实格式：'docx' | 'doc' | 'pdf'
 * @returns {Promise<{ok:boolean,text:string,status:string,note:string}>}
 */
async function extract(filePath, kind) {
  const ext = String(kind || '').toLowerCase().replace(/^\./, '');
  try {
    if (!fs.existsSync(filePath)) {
      return { ok: false, text: '', status: 'error', note: '文件不存在' };
    }
    if (ext === 'docx') {
      const buf = fs.readFileSync(filePath);
      const entries = listZipEntries(buf);
      if (!entries) return { ok: false, text: '', status: 'unsupported', note: '不是有效的 docx（zip 结构异常）' };
      const xml = readZipEntry(buf, entries, 'word/document.xml');
      if (!xml) return { ok: false, text: '', status: 'unsupported', note: 'docx 内未找到正文部件' };
      const text = docxXmlToText(xml.toString('utf8'));
      if (!text) return { ok: false, text: '', status: 'empty', note: '文档没有可提取的文字（可能全是图片）' };
      return { ok: true, text: text.slice(0, MAX_TEXT_CHARS), status: 'ok', note: '' };
    }
    if (ext === 'pdf') {
      return extractPdfText(filePath);
    }
    if (ext === 'doc') {
      const docpreview = require('./docpreview');
      const text = normalizeText(await docpreview.extractDocText(filePath));
      if (!text) return { ok: false, text: '', status: 'empty', note: '旧版 Word 未提取到文字' };
      return { ok: true, text: text.slice(0, MAX_TEXT_CHARS), status: 'ok', note: '' };
    }
    return { ok: false, text: '', status: 'unsupported', note: '该格式不支持正文提取' };
  } catch (e) {
    return { ok: false, text: '', status: 'error', note: '提取失败：' + ((e && e.message) || e) };
  }
}

/** 状态的中文说明（列表与提示用，前端不自己拼） */
const STATUS_LABEL = {
  ok: '正文已索引',
  empty: '无可提取正文',
  unsupported: '暂不支持索引',
  error: '索引失败',
  '': '未索引',
};

module.exports = {
  MAX_TEXT_CHARS,
  extract,
  STATUS_LABEL,
  // 下面几个导出只为离线自测（运行时没人直接调用）
  listZipEntries,
  readZipEntry,
  docxXmlToText,
  decodePdfString,
  extractFromContentStream,
  looksReadable,
  normalizeText,
  extractPdfText,
};
