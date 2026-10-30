'use strict';
/**
 * issue-sla.js —— 问题工单的响应/处理时限（SLA）定义与超期判定
 *
 * 为什么单独一个模块：
 *   1) 超期是「按紧急程度分档」的规则，散在路由 SQL 与前端各写一遍必然漂移；
 *   2) 判定涉及时间字符串解析、边界（正好到期/已解决未关闭）、本地时区，
 *      这些必须能被离线自测逐个断言（见 scripts/sla-selftest.js）；
 *   3) config.js 不进更新包（服务器配置可能不同），所以这里的默认值必须在代码内兜底，
 *      服务器没有 ISSUE_SLA_HOURS 这一项也能正常运行。
 *
 * 口径（写死在代码里，改口径请同步改本注释与自测）：
 *   · 起算点：report_time（报障时间，可手工填写）优先，为空时退回 created_at；
 *   · 截止点：起算点 + 该紧急度对应的时限小时数；
 *   · 「已解决 / 已关闭」不再计时（视为处理完毕），但会额外标出是否「超时完成」；
 *   · 监控中（pending / processing）且已过截止点 → overdue；
 *   · 监控中且剩余时间不足时限的 1/4（且不超过 24 小时）→ warning（即将超期）。
 */

/** 默认时限（小时）。紧急 4h / 高 24h / 中 72h / 低 120h（5 个工作日） */
const DEFAULT_SLA_HOURS = { '紧急': 4, '高': 24, '中': 72, '低': 120 };
/** 认不出的紧急度按「中」处理，避免自定义值导致整条记录不参与统计 */
const FALLBACK_URGENCY = '中';
/** 已完成状态：不再计时 */
const DONE_STATUS = ['resolved', 'closed'];

const HOUR_MS = 3600 * 1000;

/**
 * 合并生效的时限表：config.ISSUE_SLA_HOURS 覆盖默认值（只认正数）。
 * 传 config 是为了自测能注入，不传则现取（避免模块加载顺序问题）。
 */
function slaTable(overrides) {
  const out = Object.assign({}, DEFAULT_SLA_HOURS);
  let src = overrides;
  if (!src || typeof src !== 'object') {
    try { src = require('../config').ISSUE_SLA_HOURS; } catch (e) { src = null; }
  }
  if (src && typeof src === 'object') {
    Object.keys(src).forEach((k) => {
      const n = Number(src[k]);
      if (isFinite(n) && n > 0) out[k] = n;
    });
  }
  return out;
}

/** 某紧急度对应的时限（小时） */
function slaHoursOf(urgency, overrides) {
  const t = slaTable(overrides);
  const u = String(urgency == null ? '' : urgency);
  return t[u] || t[FALLBACK_URGENCY];
}

/**
 * 解析 SQLite 里的本地时间字符串 → 毫秒时间戳。
 *
 * ★ 不能直接交给 Date.parse：'YYYY-MM-DD HH:mm:ss'（空格分隔、无时区）在
 *   ECMAScript 里属于「实现相关格式」，不同引擎可能按 UTC 解析，同一份数据在
 *   Node 与浏览器里能差出 8 小时 —— 超期判定正好卡在边界时就会翻脸。
 *   这里显式拆字段、按本地时间构造，Node 与浏览器行为一致。
 * 同时容忍：纯日期 'YYYY-MM-DD'、ISO 串（带 T / 带时区）、空值。
 */
function parseLocalTime(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === 'number' && isFinite(v)) return v;
  const s = String(v).trim();
  if (!s) return null;
  // 纯日期：按当天 00:00:00 本地时间
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime();
  // 日期 + 时间（空格或 T 分隔，秒与毫秒可省）
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?(?:\.\d+)?$/.exec(s);
  if (m) {
    return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), 0).getTime();
  }
  // 其它（含时区的 ISO 串等）交给内置解析，失败返回 null
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

/** 取工单的计时起点（毫秒），拿不到返回 null */
function startTimeOf(issue) {
  if (!issue) return null;
  const t = parseLocalTime(issue.report_time);
  if (t !== null) return t;
  return parseLocalTime(issue.created_at);
}

/** 取工单的结束时间（仅已关闭有 closed_at），拿不到返回 null */
function endTimeOf(issue) {
  if (!issue) return null;
  return parseLocalTime(issue.closed_at);
}

/**
 * 计算单条工单的 SLA 状态。
 * @returns {{
 *   hours:number, start_ms:number|null, deadline_ms:number|null,
 *   overdue_hours:number, remaining_hours:number|null,
 *   state:'done'|'done_late'|'overdue'|'warning'|'ok'|'unknown',
 *   state_text:string
 * }}
 */
function slaStateOf(issue, nowMs, overrides) {
  const hours = slaHoursOf(issue && issue.urgency, overrides);
  const start = startTimeOf(issue);
  const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  const unknown = { hours: hours, start_ms: null, deadline_ms: null, overdue_hours: 0, remaining_hours: null, state: 'unknown', state_text: '时间不明' };
  if (start === null) return unknown;

  const deadline = start + hours * HOUR_MS;
  const status = String((issue && issue.status) || '');
  const isDone = DONE_STATUS.indexOf(status) >= 0;

  if (isDone) {
    const end = endTimeOf(issue);
    // 已解决但未关闭没有 closed_at：无法判断是否超时完成，按「已完成」计
    const late = end !== null && end > deadline;
    const lateHours = late ? Math.round(((end - deadline) / HOUR_MS) * 10) / 10 : 0;
    return {
      hours: hours, start_ms: start, deadline_ms: deadline,
      overdue_hours: lateHours, remaining_hours: null,
      state: late ? 'done_late' : 'done',
      state_text: late ? ('超时完成 ' + fmtHours(lateHours)) : '已完成',
    };
  }

  const diff = now - deadline;           // >0 表示已过截止点
  if (diff > 0) {
    const od = Math.round((diff / HOUR_MS) * 10) / 10;
    return {
      hours: hours, start_ms: start, deadline_ms: deadline,
      overdue_hours: od, remaining_hours: -od,
      state: 'overdue', state_text: '超期 ' + fmtHours(od),
    };
  }

  const remainH = -diff / HOUR_MS;
  // 预警阈值：时限的 1/4，且最多提前 24 小时提醒（低优先级 120h 的 1/4 是 30h，太早没意义）
  const warnAt = Math.min(hours / 4, 24);
  if (remainH <= warnAt) {
    return {
      hours: hours, start_ms: start, deadline_ms: deadline,
      overdue_hours: 0, remaining_hours: Math.round(remainH * 10) / 10,
      state: 'warning', state_text: '剩 ' + fmtHours(remainH),
    };
  }
  return {
    hours: hours, start_ms: start, deadline_ms: deadline,
    overdue_hours: 0, remaining_hours: Math.round(remainH * 10) / 10,
    state: 'ok', state_text: '剩 ' + fmtHours(remainH),
  };
}

/** 小时数转人话：>48 用天，其余用小时 */
function fmtHours(h) {
  const n = Math.abs(Number(h) || 0);
  if (n >= 48) return (Math.round(n / 24 * 10) / 10) + ' 天';
  if (n >= 1) return (Math.round(n * 10) / 10) + ' 小时';
  return Math.round(n * 60) + ' 分钟';
}

/** 给列表行附加 SLA 字段（就地修改并返回） */
function attachSla(rows, nowMs, overrides) {
  const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  (rows || []).forEach((r) => {
    const s = slaStateOf(r, now, overrides);
    r.sla_hours = s.hours;
    r.sla_state = s.state;
    r.sla_text = s.state_text;
    r.overdue_hours = s.overdue_hours;
    r.remaining_hours = s.remaining_hours;
    r.sla_deadline = s.deadline_ms === null ? '' : fmtLocal(s.deadline_ms);
  });
  return rows;
}

/** 毫秒 → 'YYYY-MM-DD HH:mm'（本地时间） */
function fmtLocal(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/**
 * 汇总统计。
 * @param {Array} issues 全部工单（至少含 status/urgency/report_time/created_at/closed_at/assignee_name/department/title/no/id）
 * @returns 统计对象（见下方字段）
 */
function summarize(issues, nowMs, overrides) {
  const now = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
  const list = Array.isArray(issues) ? issues : [];
  const t = slaTable(overrides);

  const out = {
    total: list.length,
    open: 0, overdue: 0, warning: 0,
    done: 0, done_late: 0, on_time_rate: null,
    avg_close_hours: null, max_overdue_hours: 0,
    by_urgency: [], by_assignee: [], top_overdue: [],
    sla_table: t,
    generated_at: fmtLocal(now),
  };

  const urgMap = {};
  Object.keys(t).forEach((u) => {
    urgMap[u] = { urgency: u, sla_hours: t[u], total: 0, open: 0, overdue: 0, done: 0, done_late: 0 };
  });
  const asgMap = {};
  const closeDurations = [];
  let onTime = 0, onTimeBase = 0;   // 按时完成率的分母：有 closed_at 的已完成工单

  list.forEach((it) => {
    const s = slaStateOf(it, now, overrides);
    const u = String(it.urgency == null ? '' : it.urgency);
    const bucket = urgMap[u] || (urgMap[u] = { urgency: u, sla_hours: s.hours, total: 0, open: 0, overdue: 0, done: 0, done_late: 0 });
    bucket.total++;

    const isDone = DONE_STATUS.indexOf(String(it.status || '')) >= 0;
    if (isDone) {
      out.done++;
      bucket.done++;
      if (s.state === 'done_late') { out.done_late++; bucket.done_late++; }
      const end = endTimeOf(it);
      const start = startTimeOf(it);
      if (end !== null && start !== null && end >= start) {
        closeDurations.push((end - start) / HOUR_MS);
        onTimeBase++;
        if (s.state !== 'done_late') onTime++;
      }
    } else {
      out.open++;
      bucket.open++;
      if (s.state === 'overdue') {
        out.overdue++;
        bucket.overdue++;
        if (s.overdue_hours > out.max_overdue_hours) out.max_overdue_hours = s.overdue_hours;
      } else if (s.state === 'warning') {
        out.warning++;
      }
    }

    // 处理人维度只统计未完成的工单（谁手上压着超期的活）
    if (!isDone) {
      const name = String(it.assignee_name || '').trim() || '未指派';
      const a = asgMap[name] || (asgMap[name] = { name: name, open: 0, overdue: 0, max_overdue_hours: 0 });
      a.open++;
      if (s.state === 'overdue') {
        a.overdue++;
        if (s.overdue_hours > a.max_overdue_hours) a.max_overdue_hours = s.overdue_hours;
      }
    }

    if (s.state === 'overdue' || s.state === 'done_late') {
      out.top_overdue.push({
        id: it.id, no: it.no || '', title: it.title || '',
        urgency: it.urgency || '', department: it.department || '',
        assignee_name: it.assignee_name || '',
        status: it.status, status_text: it.status === 'resolved' ? '已解决' : (it.status === 'closed' ? '已关闭' : (it.status === 'processing' ? '处理中' : '待处理')),
        overdue_hours: s.overdue_hours, sla_hours: s.hours,
        // 带上状态与中文说明：这份排行里既有「还没做完的」也有「做完但迟了的」，
        // 前端若只拿 overdue_hours 去渲染，两种性质完全不同的工单会看起来一样
        sla_state: s.state, sla_text: s.state_text,
      });
    }
  });

  if (onTimeBase > 0) out.on_time_rate = Math.round((onTime / onTimeBase) * 1000) / 10;
  if (closeDurations.length) {
    const sum = closeDurations.reduce((a, b) => a + b, 0);
    out.avg_close_hours = Math.round((sum / closeDurations.length) * 10) / 10;
  }

  out.by_urgency = Object.keys(urgMap).map((k) => urgMap[k]).sort((a, b) => a.sla_hours - b.sla_hours);
  out.by_assignee = Object.keys(asgMap).map((k) => asgMap[k])
    .sort((a, b) => (b.overdue - a.overdue) || (b.open - a.open) || a.name.localeCompare(b.name))
    .slice(0, 10);
  out.top_overdue = out.top_overdue
    .sort((a, b) => b.overdue_hours - a.overdue_hours)
    .slice(0, 10);

  return out;
}

/**
 * 生成「在 SQL 里判超期」的 CASE 表达式与参数，供列表筛选 overdue=1 使用。
 *
 * 为什么要下推到 SQL：分页在 SQL 里做，如果先取一页再过滤，会出现
 * 「第 1 页只剩 2 条、总数却写着 137」这种自相矛盾的分页。
 * 紧急度取值来自内置配置表（固定几种中文），仍按 SQL 字面量安全转义（单引号翻倍）。
 *
 * @returns {{sql:string, params:Array}} sql 形如
 *   "(julianday('now','localtime') - julianday(COALESCE(NULLIF(i.report_time,''), i.created_at))) * 24 > CASE i.urgency WHEN '紧急' THEN ? ... ELSE ? END"
 */
function overdueSql(overrides) {
  const t = slaTable(overrides);
  const keys = Object.keys(t);
  const params = [];
  let sql = 'CASE i.urgency';
  keys.forEach((k) => {
    sql += " WHEN '" + String(k).replace(/'/g, "''") + "' THEN ?";
    params.push(t[k]);
  });
  sql += ' ELSE ? END';
  params.push(t[FALLBACK_URGENCY]);
  return {
    sql: "(julianday('now','localtime') - julianday(COALESCE(NULLIF(i.report_time,''), i.created_at))) * 24 > " + sql,
    params: params,
  };
}

/** 只看「正在计时且已超期」的 SQL 条件（不含 CASE，便于与 overdueSql 组合） */
const OPEN_STATUS_SQL = "i.status NOT IN ('resolved','closed')";

module.exports = {
  DEFAULT_SLA_HOURS, FALLBACK_URGENCY, DONE_STATUS, HOUR_MS, OPEN_STATUS_SQL,
  slaTable, slaHoursOf, parseLocalTime, startTimeOf, endTimeOf,
  slaStateOf, attachSla, summarize, overdueSql, fmtHours, fmtLocal,
};
