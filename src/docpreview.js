'use strict';
/**
 * 文档预览支持层
 *
 * 解决两类真实问题：
 *  1) 扩展名不可信：用户常把旧版 .doc 直接改名成 .docx（或反过来），
 *     浏览器端 docx-preview 解析不了二进制 .doc，结果就是"预览空白"。
 *     → 上传时按文件头（magic bytes）嗅探真实格式，以真实格式为准。
 *  2) 旧版 .doc（Word 97-2003，OLE2 复合文档）需要单独处理：
 *     优先用 LibreOffice（若部署机装了）转成 .docx，保留排版；
 *     没装则用 word-extractor（纯 JS，无原生依赖）提取正文，前端走"文本模式"预览，
 *     至少保证内容可读，而不是一片空白。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');

// ---------------------------------------------------------------- 格式嗅探
/** 依据文件头判定真实格式；认不出返回 '' */
function sniff(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return '';
  // PDF：%PDF-
  if (buf.slice(0, 5).toString('latin1') === '%PDF-') return 'pdf';

  // ZIP 系（OOXML）：docx / xlsx / pptx / odt 都以此开头，需再看内部条目名
  if (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) {
    // 前 64KB 足够命中 [Content_Types].xml 的特征串
    const head = buf.slice(0, Math.min(buf.length, 65536)).toString('latin1');
    if (head.includes('wordprocessingml')) return 'docx';
    if (head.includes('spreadsheetml')) return 'xlsx';
    if (head.includes('presentationml')) return 'pptx';
    return 'zip';
  }

  // OLE2 复合文档（Word97-2003 / Excel97 / PPT97 共用）：D0CF11E0A1B11AE1
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) {
    return 'ole2';
  }

  // RTF
  if (buf.slice(0, 5).toString('latin1') === '{\\rtf') return 'rtf';
  return '';
}

/**
 * 判定最终可预览类型：
 *  @returns {{kind:'pdf'|'docx'|'doc'|'', ext:string, note:string}}
 *   kind='' 表示不支持预览（xlsx/pptx/未知等）
 */
function resolveKind(buf, extHint) {
  const real = sniff(buf);
  const ext = String(extHint || '').toLowerCase().replace('.', '');
  if (real === 'pdf') return { kind: 'pdf', ext: 'pdf', note: '' };
  if (real === 'docx') return { kind: 'docx', ext: 'docx', note: ext && ext !== 'docx' ? '实际为 .docx 文档' : '' };
  if (real === 'ole2') {
    // OLE2 容器里可能是 Word/Excel/PPT，按扩展名提示区分；无法细分时当作 Word
    if (ext === 'xls') return { kind: '', ext: 'xls', note: 'Excel 97-2003(.xls) 暂不支持在线预览' };
    if (ext === 'ppt') return { kind: '', ext: 'ppt', note: 'PPT 97-2003(.ppt) 暂不支持在线预览' };
    return { kind: 'doc', ext: 'doc', note: ext && ext !== 'doc' ? '实际为旧版 Word(.doc) 文档' : '' };
  }
  if (real === 'xlsx' || real === 'pptx' || real === 'zip') {
    return { kind: '', ext: real === 'zip' ? ext || 'zip' : real, note: '暂不支持该格式的在线预览' };
  }
  if (real === 'rtf') return { kind: '', ext: 'rtf', note: 'RTF 暂不支持在线预览' };
  return { kind: '', ext: ext || '', note: '无法识别的文件格式' };
}

// ------------------------------------------------- LibreOffice 转换（可选）
let sofficeCache;
/** 探测 LibreOffice 可执行文件；找不到返回 ''（有缓存，只探测一次） */
function findSoffice() {
  if (sofficeCache !== undefined) return sofficeCache;
  const candidates = [];
  if (config.DOC_SOFFICE_PATH) candidates.push(config.DOC_SOFFICE_PATH);
  const pf = process.env['ProgramFiles'] || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  candidates.push(
    path.join(pf, 'LibreOffice', 'program', 'soffice.exe'),
    path.join(pf86, 'LibreOffice', 'program', 'soffice.exe'),
    path.join(pf, 'LibreOffice', 'program', 'soffice.com'),
    path.join(pf, 'OpenOffice 4', 'program', 'soffice.exe'),
    'soffice'
  );
  for (const c of candidates) {
    try {
      if (c === 'soffice') { execFileSyncSafe('soffice', ['--version']); sofficeCache = 'soffice'; return sofficeCache; }
      if (fs.existsSync(c)) { sofficeCache = c; return sofficeCache; }
    } catch (e) { /* 继续下一个候选 */ }
  }
  sofficeCache = '';
  return sofficeCache;
}

function execFileSyncSafe(cmd, args) {
  const { execFileSync } = require('child_process');
  execFileSync(cmd, args, { windowsHide: true, timeout: 8000, stdio: 'ignore' });
}

/**
 * 用 LibreOffice 把 .doc 转成 .docx（保留排版）。
 *  @returns {Promise<string|null>} 生成的 docx 绝对路径；失败返回 null
 */
function convertDocToDocx(srcPath, outDir) {
  return new Promise((resolve) => {
    const exe = findSoffice();
    if (!exe) return resolve(null);
    fs.mkdirSync(outDir, { recursive: true });
    const args = [
      '--headless', '--nologo', '--nofirststartwizard', '--invisible',
      '--convert-to', 'docx', '--outdir', outDir, srcPath,
    ];
    execFile(exe, args, { windowsHide: true, timeout: 90000, maxBuffer: 4 * 1024 * 1024 }, (err) => {
      if (err) return resolve(null);
      const out = path.join(outDir, path.basename(srcPath, path.extname(srcPath)) + '.docx');
      resolve(fs.existsSync(out) ? out : null);
    });
  });
}

// ------------------------------------------------------ .doc 正文提取兜底
/** word-extractor 懒加载（未安装时不影响其它功能） */
function loadExtractor() {
  try { return require('word-extractor'); } catch (e) { return null; }
}

/**
 * 提取 .doc 正文；失败抛出带中文原因的 Error
 *  @returns {Promise<string>} 纯文本
 */
async function extractDocText(filePath) {
  const WordExtractor = loadExtractor();
  if (!WordExtractor) throw new Error('服务端未安装 .doc 解析组件（word-extractor），无法提取内容');
  const stat = fs.statSync(filePath);
  if (stat.size > 30 * 1024 * 1024) throw new Error('文档过大（>30MB），无法提取正文');
  const ex = new WordExtractor();
  let doc;
  try {
    doc = await ex.extract(filePath);
  } catch (e) {
    // 底层可能抛 "Attempt to access memory outside buffer bounds" 之类的原始错误，
    // 统一转成用户看得懂的原因
    throw new Error('无法解析该 .doc 文件（可能已损坏、加密，或并非真正的 Word 文档）');
  }
  let text = '';
  try {
    text = doc.getBody({ includeHeadersAndFooters: true }) || '';
  } catch (e) {
    try { text = doc.getBody ? doc.getBody() : ''; } catch (e2) { text = ''; }
  }
  // 清理 Word 二进制残留的控制字符，保留换行与制表
  text = String(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/\u0007/g, '')
    .trim();
  if (!text) throw new Error('未能从该 .doc 中提取到文字（可能是扫描版图片文档或加密文档）');
  return text;
}

/** 纯文本 → 安全 HTML（分段 + 转义） */
function textToHtml(text) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const paras = String(text).split(/\n{1,}/).map((p) => p.trim()).filter(Boolean);
  return paras.map((p) => '<p>' + esc(p).replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;') + '</p>').join('');
}

/**
 * 取得 .doc 的可预览内容：先尝试转 docx，再退回文本。
 *  @returns {Promise<{mode:'docx'|'text', docxPath?:string, html?:string, notice:string}>}
 */
async function previewDocPayload(srcPath, outDir, baseName) {
  const converted = await convertDocToDocx(srcPath, outDir);
  if (converted) {
    // 转成统一的随机名，避免同名覆盖（stored_name 已含时间戳+随机串，理论上唯一，仍兜底）
    const target = path.join(outDir, baseName + '.docx');
    if (converted !== target) {
      try { fs.copyFileSync(converted, target); fs.unlinkSync(converted); } catch (e) { /* 保留原转换结果 */ }
    }
    if (fs.existsSync(target)) {
      return { mode: 'docx', docxPath: target, html: '', notice: '' };
    }
    return { mode: 'docx', docxPath: converted, html: '', notice: '' };
  }
  const text = await extractDocText(srcPath);
  return { mode: 'text', docxPath: '', html: textToHtml(text), notice: '当前为文本模式预览（服务端未安装 LibreOffice，.doc 已提取正文，表格与图片排版不保留）' };
}

module.exports = {
  sniff, resolveKind, findSoffice, convertDocToDocx,
  extractDocText, textToHtml, previewDocPayload,
};
