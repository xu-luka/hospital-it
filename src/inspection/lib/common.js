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

/**
 * 采集通道的显示名 —— 全系统唯一事实来源。
 *
 * ★ 曾经有三份实现：inspect.js 的 connectLabelOf、compare.js 的 CHANNEL_LABELS、
 *   前端 AUTH_HINT。三份文案已经漂了（「SSH 密钥」和「SSH 私钥」并存），
 *   所以台账列表、巡检详情、通道对比、编辑弹窗下拉里的同一个通道会显示成两个名字。
 *   新增通道时只改这里，其余全部 follow。
 *
 * 参数用「扁平三元组」而不是 server 对象：调用方有 db row（平铺 auth_type）、
 * 有采集配置（server.auth.type）、有前端传上来的裸字符串，包一层反而各自写适配。
 *
 * 「未设置」是真实存在的状态（老数据、或者只建了台账没填凭据），
 * 不能兜底成「SSH 密码」——那会让一台根本采不到数的设备看起来配置正常。
 */
function connectLabelOf(os, authType, dbEngine) {
  const t = String(authType || '');
  if (os === 'linux') return !t ? '未设置' : (t === 'key' ? 'SSH 密钥' : 'SSH 密码');
  if (os === 'bmc') return 'Redfish';
  if (os === 'switch') return 'SSH(设备)';
  if (os === 'database') return dbEngine === 'oracle' ? 'Oracle连接' : 'TDS连接';
  if (os === 'esxi') return 'vSphere API';
  if (t === 'exporter') return 'exporter';
  if (t === 'local') return '本机';
  if (t === 'key') return 'SSH 密钥';
  if (t === 'wmi') return 'WMI';
  if (!t) return '未设置';
  return 'SSH 密码';
}

/**
 * evaluateResult 产出的 reasons 是 [{level,text}]，**不是字符串数组**。
 * 任何要拼接 / 渲染它的地方都必须先过这里，否则直接 join 会得到
 * "[object Object]；[object Object]" —— 2026-11-10 自检弹窗就是这么坏的：
 * 明明连得上（ok=true），却因为两条阈值告警被塞进 error，红色错误框盖掉了
 * 主机名 / CPU / 内存 / 扩展采集摘要，运维完全看不到 textfile 有没有生效。
 */
function reasonList(reasons) {
  if (!Array.isArray(reasons)) return [];
  const out = [];
  for (const x of reasons) {
    if (x === null || x === undefined || x === '') continue;
    if (typeof x === 'string') { out.push({ level: 'warning', text: x }); continue; }
    if (typeof x === 'object') {
      const text = String(x.text || x.message || x.name || '');
      if (!text) continue;
      out.push({ level: x.level === 'critical' ? 'critical' : 'warning', text: text });
      continue;
    }
    out.push({ level: 'warning', text: String(x) });
  }
  return out;
}

/** 把任意形态的 error 变成可读文本，杜绝 [object Object] 出现在界面上 */
function errorText(v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'string') return v;
  if (v instanceof Error) return String(v.message || v.name || '未知错误');
  if (typeof v === 'object') {
    if (v.message) return String(v.message);
    if (v.text) return String(v.text);
    try { return JSON.stringify(v); } catch (e) { return '未知错误'; }
  }
  return String(v);
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
  sleep,
  connectLabelOf,
  reasonList,
  errorText
};
