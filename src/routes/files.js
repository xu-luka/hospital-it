'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { db } = require('../db-contract');
const { authRequired } = require('../auth');
const { logAction } = require('../utils');
const config = require('../../config');

router.use(authRequired);

// ---------- 文件名编码修复 ----------
// 某些浏览器/客户端上传时中文文件名按 UTF-8 编码，但 multer 底层按 Latin-1 解读，
// 导致存库变乱码。此函数尝试 latin1→utf8 还原：
// 仅当含非 ASCII 字符且还原后不含 U+FFFD（非法序列标记）时才采用还原值。
function fixFilename(s) {
  if (!s || typeof s !== 'string') return s || '';
  if (!/[^\x00-\x7F]/.test(s)) return s; // 纯 ASCII 无需处理
  try {
    const decoded = Buffer.from(s, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('\uFFFD')) return decoded;
  } catch (e) {}
  return s;
}

// 启动时自动修复历史乱码数据（幂等：已正确的名字不会被改动）
(function fixHistoryFilenames() {
  try {
    const rows = db.prepare('SELECT id, filename FROM files').all();
    let fixed = 0;
    for (const r of rows) {
      const repaired = fixFilename(r.filename);
      if (repaired !== r.filename) {
        db.prepare('UPDATE files SET filename=? WHERE id=?').run(repaired, r.id);
        fixed++;
      }
    }
    if (fixed > 0) console.log(`[files] 已自动修复 ${fixed} 条历史乱码文件名`);
  } catch (e) { /* 表不存在等情况忽略 */ }
})();

// 存储配置：文件名用随机串 + 原始扩展名，避免中文/特殊字符问题
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, config.CONTRACT_UPLOAD_DIR),
  filename: (req, file, cb) => {
    const fixedName = fixFilename(file.originalname || '');
    // 扩展名从修复后的名字里取，避免乱码时取不到
    const ext = path.extname(fixedName).toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 单个附件最大 50MB
});

// POST /api/files/:contractId - 上传附件
router.post('/:contractId', upload.single('file'), (req, res) => {
  const contract = db.prepare('SELECT * FROM contracts WHERE id=?').get(req.params.contractId);
  if (!contract) {
    if (req.file) { try { fs.unlinkSync(req.file.path); } catch (e) {} }
    return res.status(404).json({ code: 404, message: '合同不存在' });
  }
  if (!req.file) return res.status(400).json({ code: 400, message: '未接收到文件' });

  // 存库前修复编码，保证中文名不乱码
  const displayName = fixFilename(req.file.originalname);

  const info = db.prepare(
    'INSERT INTO files (contract_id, filename, stored_name, mime, size, uploaded_by) VALUES (?,?,?,?,?,?)'
  ).run(contract.id, displayName, req.file.filename, req.file.mimetype, req.file.size, req.user.id);

  logAction(req, '上传附件', `合同[${contract.contract_no}] ${displayName}`);
  res.json({ code: 0, data: { id: info.lastInsertRowid } });
});

// GET /api/files/:fileId/download - 下载附件
router.get('/:fileId/download', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!f) return res.status(404).json({ code: 404, message: '附件不存在' });
  const filePath = path.join(config.CONTRACT_UPLOAD_DIR, f.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ code: 404, message: '文件已丢失' });
  // 下载文件名也做编码修复（兼容历史乱码数据未修复的场景）
  res.download(filePath, fixFilename(f.filename));
});

// DELETE /api/files/:fileId - 删除附件
router.delete('/:fileId', (req, res) => {
  const f = db.prepare('SELECT * FROM files WHERE id=?').get(req.params.fileId);
  if (!f) return res.status(404).json({ code: 404, message: '附件不存在' });
  db.prepare('DELETE FROM files WHERE id=?').run(f.id);
  try { fs.unlinkSync(path.join(config.CONTRACT_UPLOAD_DIR, f.stored_name)); } catch (e) {}
  logAction(req, '删除附件', f.filename);
  res.json({ code: 0 });
});

module.exports = router;