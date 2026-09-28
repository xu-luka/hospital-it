'use strict';
// 统一工具模块：操作日志统一写入合同库 logs 表
const { db } = require('./db-contract');

// ---- 防御性清洗 ----
function toSafeNum(v, def) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : (def === undefined ? 0 : def);
}

function toSafeText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return '';
  return String(v).trim();
}

function toSafeDate(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  return s ? s : null;
}

// ---- 统一操作日志（写合同库 logs 表，写失败不影响主流程）----
/**
 * detail 归一化。
 *
 * node:sqlite 只能绑定 number/string/bigint/Buffer/null，传对象会直接抛
 * "Provided value cannot be bound to SQLite parameter 4" —— 结果是整个 try 块跳出、
 * 日志静默丢失，连报错都只在控制台一闪而过。台账这类涉及凭据的操作如果漏记，
 * 事后根本查不出谁动过设备，所以这里统一转成 JSON 字符串，而不是要求每个调用方记得 stringify。
 */
function stringifyDetail(detail) {
  if (detail === null || detail === undefined) return '';
  if (typeof detail === 'string') return detail;
  try { return JSON.stringify(detail); } catch (e) { return String(detail); }
}
// 兼容两种调用方式：
//   合同系：logAction(req, action, detail)              —— 第一参为 express req（含 user/ip）
//   问题系：logAction(user, action, detail, ip)          —— 第一参为用户对象
function logAction(u, action, detail, ip) {
  try {
    let userId = null;
    let username = '';
    let ipStr = ip || '';
    if (u && u.user) { // 传入的是 req
      userId = u.user.id || null;
      username = u.user.username || '';
      ipStr = u.ip || ipStr;
    } else if (u) { // 传入的是用户对象
      userId = u.id || null;
      username = u.username || '';
    }
    db.prepare("INSERT INTO logs(user_id, username, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, datetime('now','localtime'))")
      .run(userId, username, action || '', stringifyDetail(detail), ipStr || '');
  } catch (e) {
    console.warn('[log] 写入操作日志失败：', e.message);
  }
}

// 生成问题单号：HIS-YYYYMMDD-NNNN（YYYYMMDD 取自问题记录时间；同记录日期递增，跨日自动从 1 续）
function issueNo(db, reportTime) {
  let dateStr = '';
  if (reportTime) {
    const m = String(reportTime).trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) dateStr = m[1] + m[2] + m[3];
  }
  if (!dateStr) {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    dateStr = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  }
  const prefix = 'HIS-' + dateStr + '-';
  const row = db.prepare('SELECT COUNT(*) AS c FROM issues WHERE no LIKE ?').get(prefix + '%');
  const seq = (row ? row.c : 0) + 1;
  return prefix + String(seq).padStart(4, '0');
}

module.exports = { toSafeNum, toSafeText, toSafeDate, logAction, genIssueNo: issueNo };