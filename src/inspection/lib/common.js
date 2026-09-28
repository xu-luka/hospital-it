'use strict';
/**
 * 通用工具函数：状态等级、阈值判断、格式化、转义等
 */

const LEVEL_RANK = { normal: 0, warning: 1, critical: 2, error: 3 };
const LEVEL_LABEL = { normal: '正常', warning: '警告', critical: '严重', error: '失败' };

function levelRank(status) {
  return LEVEL_RANK[status] === undefined ? 0 : LEVEL_RANK[status];
}

function worst(...statuses) {
  let w = 'normal';
  for (const s of statuses) {
    if (levelRank(s) > levelRank(w)) w = s;
  }
  return w;
}

/** 值越大越严重时使用：>=crit 为严重，>=warn 为警告 */
function levelOf(value, warn, crit) {
  if (value === null || value === undefined) return 'normal';
  const v = Number(value);
  if (isNaN(v)) return 'normal';
  if (crit !== undefined && crit !== null && v >= crit) return 'critical';
  if (warn !== undefined && warn !== null && v >= warn) return 'warning';
  return 'normal';
}

function round1(n) { return Math.round(Number(n) * 10) / 10; }
function round2(n) { return Math.round(Number(n) * 100) / 100; }

function pad2(n) { return String(n).padStart(2, '0'); }

function formatDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

function nowHuman() { return formatDate(new Date()); }

function nowStamp() {
  const d = new Date();
  return String(d.getFullYear()) + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' +
    pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds());
}

function formatUptime(sec) {
  if (sec === null || sec === undefined || isNaN(sec)) return '—';
  sec = Math.floor(sec);
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  let s = '';
  if (days > 0) s += days + '天 ';
  return s + hours + '小时 ' + mins + '分';
}

function formatMB(mb) {
  if (mb === null || mb === undefined || isNaN(mb)) return '—';
  return mb >= 1024 ? round1(mb / 1024) + ' GB' : Math.round(mb) + ' MB';
}

function escapeHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(s, n) {
  const str = String(s === null || s === undefined ? '' : s);
  return str.length > n ? str.slice(0, n) + '…(已截断)' : str;
}

/** 从可能混杂其他输出的文本中提取第一个 JSON 对象 */
function extractJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}

/** Shell 单引号转义 */
function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

/** PowerShell 单引号字符串内容转义 */
function psSingle(s) {
  return String(s).replace(/'/g, "''");
}

/** PowerShell 双引号字符串内容转义 */
function psDouble(s) {
  return String(s).replace(/`/g, '``').replace(/"/g, '`"').replace(/\$/g, '`$');
}

function normArray(v) {
  return Array.isArray(v) ? v : (v === null || v === undefined ? [] : [v]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  LEVEL_LABEL,
  levelRank,
  worst,
  levelOf,
  round1,
  round2,
  formatDate,
  nowHuman,
  nowStamp,
  formatUptime,
  formatMB,
  escapeHtml,
  truncate,
  extractJson,
  shq,
  psSingle,
  psDouble,
  normArray,
  sleep
};
