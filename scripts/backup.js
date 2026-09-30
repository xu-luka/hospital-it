'use strict';
/*
 * 备份脚本（合并版）：双库 VACUUM INTO 一致快照 -> 快照+uploads 打 zip -> 校验 -> 轮转保留 N 份
 * 用法：node backup.js [目标目录] [保留份数]
 * 默认：backups/ 保留 30 份
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const config = require('../config');

const args = process.argv.slice(2);
const targetDir = path.resolve(args[0] || path.join(config.ROOT, 'backups'));
const keep = Math.max(1, parseInt(args[1], 10) || 30);

function fail(msg) {
  console.error('[BACKUP ERROR] ' + msg);
  process.exit(1);
}

// 1) VACUUM INTO 一致快照（零锁冲突）—— 双库
const { DatabaseSync } = require('node:sqlite');
const snapContract = path.join(os.tmpdir(), `contract-snap-${Date.now()}.db`);
const snapIssue = path.join(os.tmpdir(), `issue-snap-${Date.now()}.db`);
const snapInspect = path.join(os.tmpdir(), `inspect-snap-${Date.now()}.db`);
try {
  const c = new DatabaseSync(config.CONTRACT_DB_FILE, { readOnly: true });
  c.exec(`VACUUM INTO '${snapContract.replace(/'/g, "''")}'`);
  c.close();
  const h = new DatabaseSync(config.DB_FILE, { readOnly: true });
  h.exec(`VACUUM INTO '${snapIssue.replace(/'/g, "''")}'`);
  h.close();
} catch (e) {
  return fail('VACUUM INTO 失败：' + e.message);
}

// 巡检历史库：设备台账本身在 contract.db 里（it_devices / it_inspect_settings），
// 这里另有一份 data/inspect.db 存每轮快照。它是可再生的（重跑巡检就会累积），
// 因此缺失或打快照失败只告警，不让整次备份失败。
let haveInspect = false;
if (fs.existsSync(config.INSPECT_DB_FILE)) {
  try {
    const i = new DatabaseSync(config.INSPECT_DB_FILE, { readOnly: true });
    i.exec(`VACUUM INTO '${snapInspect.replace(/'/g, "''")}'`);
    i.close();
    haveInspect = true;
  } catch (e) {
    console.warn('[BACKUP WARN] 巡检历史库快照失败（备份将继续，趋势数据缺失）：' + e.message);
  }
}

// 技术文档库：docs.db（索引/标签/分类）+ uploads/docs（Word/PDF 原文件）。
// 这是不可再生的业务数据 —— 以前漏了它，意味着一次重装就丢全部文档；
// 快照失败同样只告警不失败，但要是它存在而没进备份，必须醒目提示。
const snapDocs = path.join(os.tmpdir(), `docs-snap-${Date.now()}.db`);
let haveDocs = false;
if (fs.existsSync(config.DOCS_DB_FILE)) {
  try {
    const d = new DatabaseSync(config.DOCS_DB_FILE, { readOnly: true });
    d.exec(`VACUUM INTO '${snapDocs.replace(/'/g, "''")}'`);
    d.close();
    haveDocs = true;
  } catch (e) {
    console.error('[BACKUP WARN] 文档库 docs.db 快照失败（备份将继续，但文档索引缺失！）：' + e.message);
  }
}

// 主密钥：secrets/master.key 是 26 条加密设备凭据的唯一解密钥，
// 走的是 Windows DPAPI LocalMachine，换机器即失效且无法找回 —— 必须进备份，
// 否则一次重装就把整份机房设备清单变成一堆解不开的密文。
const paths = require('../src/inspection/paths');
const secretsDir = path.join(paths.root(), 'secrets');
let haveSecrets = false;

// 2) 组装暂存目录（双库快照 + .secret + 双附件目录）
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'hosp-bak-'));
fs.copyFileSync(snapContract, path.join(staging, 'contract.db'));
fs.copyFileSync(snapIssue, path.join(staging, 'his.db'));
if (haveInspect) fs.copyFileSync(snapInspect, path.join(staging, 'inspect.db'));
if (haveDocs) fs.copyFileSync(snapDocs, path.join(staging, 'docs.db'));
if (fs.existsSync(config.SECRET_FILE)) fs.copyFileSync(config.SECRET_FILE, path.join(staging, '.secret'));
if (fs.existsSync(secretsDir)) {
  try {
    fs.cpSync(secretsDir, path.join(staging, 'secrets'), { recursive: true });
    haveSecrets = true;
  } catch (e) {
    console.warn('[BACKUP WARN] 主密钥目录复制失败：' + e.message);
  }
}
if (!haveSecrets) {
  console.error('[BACKUP WARN] 未能备份 secrets/ —— 设备口令凭据的解密钥不在备份中！');
}
const upStaging = path.join(staging, 'uploads');
fs.mkdirSync(upStaging, { recursive: true });
if (fs.existsSync(config.CONTRACT_UPLOAD_DIR)) fs.cpSync(config.CONTRACT_UPLOAD_DIR, path.join(upStaging, 'contract'), { recursive: true });
if (fs.existsSync(config.UPLOAD_DIR)) fs.cpSync(config.UPLOAD_DIR, path.join(upStaging, 'issue'), { recursive: true });
// 技术文档原文件；.converted 是预览转换缓存（可再生产物，量大），不随备份打包
let haveDocsFiles = false;
if (fs.existsSync(config.DOCS_UPLOAD_DIR)) {
  fs.cpSync(config.DOCS_UPLOAD_DIR, path.join(upStaging, 'docs'), {
    recursive: true,
    filter: (src) => path.basename(src) !== '.converted'
  });
  haveDocsFiles = true;
}

// 3) 打 zip
const tag = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const zipPath = path.join(targetDir, `hosp-backup-${tag}-${Date.now()}.zip`);
try {
  fs.mkdirSync(targetDir, { recursive: true });
  if (process.platform === 'win32') {
    const script = `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zipPath}' -Force`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
  } else {
    execFileSync('zip', ['-rq', zipPath, '.'], { cwd: staging, stdio: 'pipe' });
  }
} catch (e) {
  return fail('打包失败：' + e.message);
}

// 4) 校验 zip 存在且 >1KB（杜绝“假成功”）
let ok = false;
try { ok = fs.statSync(zipPath).size > 1024; } catch (e) { ok = false; }
if (!ok) {
  try { fs.unlinkSync(zipPath); } catch (e) { /* ignore */ }
  return fail('备份文件校验未通过（不存在或小于 1KB），已删除异常文件');
}

// 5) 轮转保留 N 份
const files = fs.readdirSync(targetDir)
  .filter((f) => /^hosp-backup-.*\.zip$/.test(f))
  .map((f) => ({ f, t: fs.statSync(path.join(targetDir, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
for (let i = keep; i < files.length; i++) {
  fs.unlinkSync(path.join(targetDir, files[i].f));
  console.log('[BACKUP] 轮转删除：' + files[i].f);
}

// 6) 清理临时文件
try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }
try { fs.unlinkSync(snapContract); } catch (e) { /* ignore */ }
try { fs.unlinkSync(snapIssue); } catch (e) { /* ignore */ }
if (haveInspect) { try { fs.unlinkSync(snapInspect); } catch (e) { /* ignore */ } }
if (haveDocs) { try { fs.unlinkSync(snapDocs); } catch (e) { /* ignore */ } }

const sizeKB = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log('[BACKUP OK] ' + zipPath + '（' + sizeKB + ' KB）');
console.log('  含 contract.db / his.db / .secret'
  + (haveInspect ? ' / inspect.db（巡检历史）' : '')
  + (haveDocs ? ' / docs.db（文档索引）' : '')
  + (haveDocsFiles ? ' / uploads\\docs（文档原件）' : '')
  + (haveSecrets ? ' / secrets（设备凭据解密钥）' : ''));
console.log('  巡检报告 HTML 不随备份打包（data/reports，属可再生产物，量大且随时可重新生成）；');
console.log('  文档预览缓存 uploads\\docs\\.converted 同理（重开文档会自动重建）。');