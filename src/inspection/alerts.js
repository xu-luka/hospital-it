'use strict';
/**
 * alerts.js —— P3：独立于 evaluateResult() 的阈值告警层
 *
 * 为什么不改 evaluateResult()：
 *   它产出的是「这一轮巡检结果的状态和 reasons」，报告、通道对比、自检弹窗都按这个结构读，
 *   动它会让全部历史行为突变。告警是另一件事：要跨轮次记忆（连续 N 轮 / 冷却 / 确认 / 恢复留痕），
 *   必须自己有状态。所以这里另起一层，只读每轮结果，不改结果本身。
 *
 * 库归属：
 *   - it_alert_rules（规则，contract.db）：属于配置，要跟台账一起进每日备份；条数极少。
 *   - it_alert_events / it_alert_state（事件与跨轮状态，inspect.db）：跟历史快照同库同生命周期，
 *     量随轮次增长，不进业务备份，坏了也不影响巡检。
 *
 * 权限：读走 inspection.view，写走 inspection.manage（在路由层判定），不新增模块、不动 perm.js。
 */
const { db: cdb } = require('../db-contract');
const history = require('./history');

let ready = false;
let eventsReady = false;
let lastError = null;
let testCdb = null;
let testHdb = null;
let testMode = false;

/**
 * 测试钩子：把规则库/事件库指到临时 SQLite，离线自测不碰 data/ 下的真实库。
 * testMode 必须单独记：显式传 null 表示「事件库不可用」的降级场景，
 * 不能因为 fallback 又去初始化生产 inspect.db。
 */
function useDb(contractDb, inspectDb) {
  testCdb = contractDb || null;
  testHdb = inspectDb || null;
  testMode = !!(contractDb || inspectDb);
  ready = false;
  eventsReady = false;
  lastError = null;
}
function C() { return (testMode && testCdb) || cdb; }
function H() { return testMode ? testHdb : (history.available() ? history.db : null); }

/* ---------------- 默认规则 ---------------- */
/* device_id = 0 表示全局；为某台设备单独建一条同 metric_key、device_id != 0 的规则即「按设备覆盖」。 */
const DEFAULT_RULES = [
  { metric_key: 'cpu_percent', label: 'CPU 使用率', unit: '%', direction: 'up', warn: 70, crit: 90, consecutive: 2, cooldown_min: 30 },
  { metric_key: 'mem_percent', label: '内存使用率', unit: '%', direction: 'up', warn: 80, crit: 95, consecutive: 2, cooldown_min: 30 },
  { metric_key: 'disk_percent_max', label: '磁盘最大使用率', unit: '%', direction: 'up', warn: 80, crit: 90, consecutive: 2, cooldown_min: 60 },
  { metric_key: 'log_errors', label: '事件日志错误数', unit: '条', direction: 'up', warn: 20, crit: 100, consecutive: 1, cooldown_min: 60 },
  { metric_key: 'x.commit_percent', label: '提交内存占比', unit: '%', direction: 'up', warn: 80, crit: 95, consecutive: 2, cooldown_min: 30 },
  { metric_key: 'tf.his_collector_up', label: '业务指标采集存活', unit: '', direction: 'down', warn: 1, crit: 0.5, consecutive: 2, cooldown_min: 10 },
  { metric_key: 'tf.his_collector_timestamp_seconds', label: '业务指标数据年龄', unit: 's', direction: 'up', warn: 300, crit: 900, consecutive: 2, cooldown_min: 30, mode: 'age_seconds' },
  { metric_key: 'tf.his_backup_age_hours', label: '上次备份距今', unit: 'h', direction: 'up', warn: 24, crit: 48, consecutive: 1, cooldown_min: 120 },
  { metric_key: 'tf.his_cert_days_left', label: '证书剩余天数', unit: '天', direction: 'down', warn: 30, crit: 7, consecutive: 1, cooldown_min: 720 }
];

/* ---------------- 建表（幂等） ---------------- */

function ensure() {
  if (ready) return true;
  try {
    C().exec(`
      CREATE TABLE IF NOT EXISTS it_alert_rules (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_key    TEXT NOT NULL,
        device_id     INTEGER NOT NULL DEFAULT 0,
        label         TEXT DEFAULT '',
        unit          TEXT DEFAULT '',
        direction     TEXT NOT NULL DEFAULT 'up',
        mode          TEXT NOT NULL DEFAULT 'value',
        warn          REAL,
        crit          REAL,
        consecutive   INTEGER NOT NULL DEFAULT 1,
        cooldown_min  INTEGER NOT NULL DEFAULT 30,
        enabled       INTEGER NOT NULL DEFAULT 1,
        updated_at    TEXT,
        updated_by    INTEGER,
        UNIQUE(metric_key, device_id)
      );
    `);
    // 老库补列（新表一般不会有，但保留与项目其它模块一致的幂等迁移习惯）
    const cols = C().prepare('PRAGMA table_info(it_alert_rules)').all().map((c) => c.name);
    for (const [name, ddl] of [['mode', "TEXT NOT NULL DEFAULT 'value'"], ['label', "TEXT DEFAULT ''"], ['unit', "TEXT DEFAULT ''"]]) {
      if (!cols.includes(name)) {
        try { C().exec('ALTER TABLE it_alert_rules ADD COLUMN ' + name + ' ' + ddl); } catch (e) { /* 并发建表 */ }
      }
    }
    const ins = C().prepare(
      'INSERT OR IGNORE INTO it_alert_rules'
      + ' (metric_key, device_id, label, unit, direction, mode, warn, crit, consecutive, cooldown_min, enabled, updated_at)'
      + ' VALUES (?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)'
    );
    for (const r of DEFAULT_RULES) {
      ins.run(r.metric_key, r.label, r.unit, r.direction, r.mode || 'value',
        r.warn, r.crit, r.consecutive, r.cooldown_min, history.now());
    }
    ready = true;
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [告警] 规则表初始化失败：' + lastError);
    return false;
  }
  // 事件库单独降级：历史库不可用时规则照样能读能改，只是本轮不产生事件。
  try {
    const hdb = H();
    if (hdb) {
      hdb.exec(`
        CREATE TABLE IF NOT EXISTS it_alert_events (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id      INTEGER NOT NULL,
          device_id    INTEGER NOT NULL,
          device_name  TEXT DEFAULT '',
          metric_key   TEXT NOT NULL,
          label        TEXT DEFAULT '',
          unit         TEXT DEFAULT '',
          level        TEXT NOT NULL,
          value        REAL,
          threshold    REAL,
          message      TEXT DEFAULT '',
          status       TEXT NOT NULL DEFAULT 'open',
          hits         INTEGER NOT NULL DEFAULT 1,
          first_at     TEXT,
          last_at      TEXT,
          resolved_at  TEXT,
          acked_by     TEXT DEFAULT '',
          acked_at     TEXT DEFAULT '',
          ack_note     TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_alert_ev_status ON it_alert_events(status, id DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS ux_alert_open
          ON it_alert_events(rule_id, device_id, metric_key) WHERE status IN ('open','acked');

        CREATE TABLE IF NOT EXISTS it_alert_state (
          rule_key       TEXT PRIMARY KEY,
          hits           INTEGER NOT NULL DEFAULT 0,
          last_level     TEXT DEFAULT 'normal',
          last_fired_at  TEXT DEFAULT '',
          last_value     REAL
        );
      `);
      eventsReady = true;
    }
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [告警] 事件表初始化失败（不影响巡检）：' + lastError);
    eventsReady = false;
  }
  return true;
}

/* ---------------- 纯函数：可离线自测 ---------------- */

function num(v) {
  const n = Number(v);
  return (v === null || v === undefined || v === '' || !Number.isFinite(n)) ? null : n;
}
function ts(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

/** 全局 + 按设备覆盖：同一 metric_key 优先取该设备专属规则，否则退回 device_id=0 */
function pickRules(rules, deviceId) {
  const byKey = new Map();
  for (const r of (rules || [])) {
    if (!r || !r.enabled || !r.metric_key) continue;
    const did = Number(r.device_id) || 0;
    if (did !== 0 && did !== Number(deviceId)) continue;
    const cur = byKey.get(r.metric_key);
    if (!cur || (did !== 0 && (Number(cur.device_id) || 0) === 0)) byKey.set(r.metric_key, r);
  }
  return Array.from(byKey.values());
}

function levelOf(value, rule) {
  const w = num(rule.warn), c = num(rule.crit);
  if (rule.direction === 'down') {
    // 必须是严格小于：his_collector_up 的 warn=1 / crit=0.5，正常值恰好等于 1，
    // 用 <= 会把「一切正常」判成 warning。
    if (c !== null && value < c) return 'critical';
    if (w !== null && value < w) return 'warning';
  } else {
    if (c !== null && value >= c) return 'critical';
    if (w !== null && value >= w) return 'warning';
  }
  return 'normal';
}

/** 规则取值：普通值直接读；age_seconds 把「采集时间戳」换算成「距今秒数」 */
function valueOf(flat, rule, nowMs) {
  const raw = num(flat[rule.metric_key]);
  if (raw === null) return null;
  if (rule.mode === 'age_seconds') return Math.max(0, Math.round(nowMs / 1000 - raw));
  return raw;
}

/**
 * 评估一轮，纯函数，不碰数据库。
 * @param {Array} results 巡检结果（需含 deviceId / name / metrics / extra）
 * @param {Array} rules   全部规则
 * @param {Object} states 上轮状态 { [ruleId:deviceId]: {hits,lastLevel,lastFiredAt} }
 * @param {Object} open   现有未解决事件 { [ruleId:deviceId]: {id,status,level,hits} }
 * @param {number} nowMs
 * @returns {{ decisions:Array, nextStates:Object }}
 */
function evaluateRound(results, rules, states, open, nowMs) {
  const decisions = [];
  const nextStates = Object.assign({}, states || {});
  const o = open || {};
  const nowT = Number(nowMs) || Date.now();
  for (const d of (results || [])) {
    if (!d || !d.ok) continue;               // 采集失败不算「指标异常」，evaluateResult 已经管了
    const did = Number(d.deviceId) || 0;
    if (!did) continue;
    const flat = history.flattenMetrics(d);
    for (const rule of pickRules(rules, did)) {
      const skey = rule.id + ':' + did;
      const v = valueOf(flat, rule, nowT);
      if (v === null) continue;              // 该设备没有这个指标（例如非 exporter 机器）
      const level = levelOf(v, rule);
      const prev = nextStates[skey] || { hits: 0, lastLevel: 'normal', lastFiredAt: '', lastValue: null };
      const need = Math.max(1, Number(rule.consecutive) || 1);
      const hits = level === 'normal' ? 0 : prev.hits + 1;
      const st = { hits: hits, lastLevel: level, lastFiredAt: prev.lastFiredAt, lastValue: v };
      nextStates[skey] = st;

      const active = o[skey] || null;
      if (level === 'normal') {
        if (active) decisions.push({ action: 'resolve', rule: rule, device: d, value: v, level: 'normal', eventId: active.id });
        continue;
      }
      if (hits < need) {
        decisions.push({ action: 'none', rule: rule, device: d, value: v, level: level,
          reason: '连续 ' + hits + '/' + need + ' 轮，暂不告警' });
        continue;
      }
      const coolMs = Math.max(0, Number(rule.cooldown_min) || 0) * 60000;
      const last = ts(prev.lastFiredAt);
      if (active && coolMs && last && nowT - last < coolMs) {
        decisions.push({ action: 'none', rule: rule, device: d, value: v, level: level,
          reason: '冷却中（' + rule.cooldown_min + ' 分钟）' });
        continue;
      }
      const threshold = level === 'critical' ? num(rule.crit) : num(rule.warn);
      const cmp = rule.direction === 'down' ? '低于' : '超过';
      const dirLabel = level === 'critical' ? '严重' : '警告';
      const message = d.name + ' · ' + (rule.label || rule.metric_key) + ' 当前 ' + v + (rule.unit || '')
        + '，' + cmp + dirLabel + '线 ' + threshold + (rule.unit || '')
        + '（已连续 ' + hits + ' 轮）';
      st.lastFiredAt = history.nowAt ? history.nowAt(nowT) : new Date(nowT).toISOString();
      decisions.push({
        action: active ? 'update' : 'open', rule: rule, device: d, value: v,
        level: level, threshold: threshold, message: message,
        eventId: active ? active.id : null, prevLevel: active ? active.level : '',
        hits: hits
      });
    }
  }
  return { decisions: decisions, nextStates: nextStates };
}

/* ---------------- 持久化 ---------------- */

function listRules() {
  if (!ensure()) return [];
  try {
    return C().prepare(
      'SELECT r.*, d.name AS device_name FROM it_alert_rules r'
      + ' LEFT JOIN it_devices d ON d.id = r.device_id'
      + ' ORDER BY r.device_id ASC, r.metric_key ASC'
    ).all();
  } catch (e) {
    // 规则表是新的，但离线自测/极简库里可能没有 it_devices：设备名只是显示用的点缀，
    // 不能因为 JOIN 失败就把整张规则表读空。
    try {
      return C().prepare(
        "SELECT r.*, '' AS device_name FROM it_alert_rules r ORDER BY r.device_id ASC, r.metric_key ASC"
      ).all();
    } catch (e2) { lastError = String((e2 && e2.message) || e2); return []; }
  }
}

const RULE_FIELDS = ['metric_key', 'device_id', 'label', 'unit', 'direction', 'mode',
  'warn', 'crit', 'consecutive', 'cooldown_min', 'enabled'];

function upsertRule(input, user) {
  if (!ensure()) return { ok: false, error: lastError };
  const o = input || {};
  const key = String(o.metric_key || '').trim().slice(0, 200);
  if (!key) return { ok: false, error: '缺少指标 key' };
  const did = Math.max(0, Number(o.device_id) || 0);
  const warn = num(o.warn), crit = num(o.crit);
  if (warn === null || crit === null) return { ok: false, error: '警告线与严重线必须是数字' };
  if ((o.direction === 'up' && crit < warn) || (o.direction === 'down' && crit > warn)) {
    return { ok: false, error: '严重线不能比警告线更宽松' };
  }
  const direction = o.direction === 'down' ? 'down' : 'up';
  const mode = o.mode === 'age_seconds' ? 'age_seconds' : 'value';
  const consecutive = Math.min(20, Math.max(1, Number(o.consecutive) || 1));
  const cooldown = Math.min(10080, Math.max(0, Number(o.cooldown_min) || 0));
  const vals = [key, did, String(o.label || '').slice(0, 100), String(o.unit || '').slice(0, 20),
    direction, mode, warn, crit, consecutive, cooldown, o.enabled === false ? 0 : 1,
    history.now(), Number(user && user.id) || null];
  try {
    const old = C().prepare('SELECT id FROM it_alert_rules WHERE metric_key = ? AND device_id = ?').get(key, did);
    if (old) {
      C().prepare('UPDATE it_alert_rules SET label=?, unit=?, direction=?, mode=?, warn=?, crit=?,'
        + ' consecutive=?, cooldown_min=?, enabled=?, updated_at=?, updated_by=? WHERE id=?')
        .run(vals[2], vals[3], vals[4], vals[5], vals[6], vals[7], vals[8], vals[9], vals[10], vals[11], vals[12], old.id);
      return { ok: true, id: old.id, updated: true };
    }
    const r = C().prepare('INSERT INTO it_alert_rules'
      + ' (metric_key, device_id, label, unit, direction, mode, warn, crit, consecutive, cooldown_min, enabled, updated_at, updated_by)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(...vals);
    return { ok: true, id: Number(r.lastInsertRowid), updated: false };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

/** 全局默认规则不允许删（删了就没兜底了），只允许删「按设备覆盖」的规则 */
function deleteRule(id) {
  if (!ensure()) return { ok: false, error: lastError };
  try {
    const r = C().prepare('SELECT device_id FROM it_alert_rules WHERE id = ?').get(Number(id));
    if (!r) return { ok: false, error: '规则不存在' };
    if (!r.device_id) return { ok: false, error: '全局规则不能删除，可改为停用' };
    C().prepare('DELETE FROM it_alert_rules WHERE id = ?').run(Number(id));
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

function readState() {
  const out = {};
  if (!eventsReady) return out;
  try {
    for (const r of H().prepare('SELECT * FROM it_alert_state').all()) {
      out[r.rule_key] = { hits: r.hits, lastLevel: r.last_level, lastFiredAt: r.last_fired_at, lastValue: r.last_value };
    }
  } catch (e) { /* 状态丢了最多重算一次连续轮次，不致命 */ }
  return out;
}
function readOpen() {
  const out = {};
  if (!eventsReady) return out;
  try {
    for (const r of H().prepare(
      "SELECT id, rule_id, device_id, status, level, hits FROM it_alert_events WHERE status IN ('open','acked')"
    ).all()) {
      out[r.rule_id + ':' + r.device_id] = r;
    }
  } catch (e) { /* ignore */ }
  return out;
}

/** 每轮结束后调用；整段自己兜异常，绝不能拖垮巡检 */
function applyRound(results, nowMs) {
  if (!ensure() || !eventsReady) return { ok: false, skipped: true, reason: lastError || '事件库不可用' };
  const hdb = H();
  if (!hdb) return { ok: false, skipped: true, reason: '事件库不可用' };
  try {
    const evaluated = evaluateRound(results, listRules(), readState(), readOpen(), nowMs);
    let opened = 0, updated = 0, resolved = 0;
    const at = history.now();
    hdb.exec('BEGIN');
    try {
      const insert = hdb.prepare('INSERT INTO it_alert_events'
        + ' (rule_id, device_id, device_name, metric_key, label, unit, level, value, threshold, message, status, hits, first_at, last_at)'
        + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      // status 用 CASE 在 SQL 内改，不要从 JS 传 undefined —— SQLite 绑定 undefined 会直接抛错
      const update = hdb.prepare('UPDATE it_alert_events SET level=?, value=?, threshold=?, message=?,'
        + ' hits=hits+1, last_at=?,'
        + " status=CASE WHEN ?=1 THEN 'open' ELSE status END,"
        + " acked_by=CASE WHEN ?=1 THEN '' ELSE acked_by END,"
        + " acked_at=CASE WHEN ?=1 THEN '' ELSE acked_at END WHERE id=?");
      const resolve = hdb.prepare("UPDATE it_alert_events SET status='resolved', resolved_at=?, last_at=? WHERE id=?");
      const putState = hdb.prepare('INSERT OR REPLACE INTO it_alert_state'
        + ' (rule_key, hits, last_level, last_fired_at, last_value) VALUES (?,?,?,?,?)');

      for (const d of evaluated.decisions) {
        const r = d.rule;
        if (d.action === 'open') {
          insert.run(r.id, Number(d.device.deviceId), String(d.device.name || ''), r.metric_key,
            r.label || '', r.unit || '', d.level, d.value, d.threshold, d.message,
            'open', d.hits, at, at);
          opened++;
        } else if (d.action === 'update') {
          // 告警升级（warning -> critical）要重新确认，不能沿用之前的 ack
          const escalate = d.prevLevel === 'warning' && d.level === 'critical' ? 1 : 0;
          update.run(d.level, d.value, d.threshold, d.message, at,
            escalate, escalate, escalate, d.eventId);
          updated++;
        } else if (d.action === 'resolve') {
          resolve.run(at, at, d.eventId);
          resolved++;
        }
      }
      for (const [k, st] of Object.entries(evaluated.nextStates)) {
        putState.run(k, st.hits || 0, st.lastLevel || 'normal', st.lastFiredAt || '', st.lastValue);
      }
      hdb.exec('COMMIT');
    } catch (e) {
      try { hdb.exec('ROLLBACK'); } catch (e2) { /* ignore */ }
      throw e;
    }
    return { ok: true, opened: opened, updated: updated, resolved: resolved,
      decisions: evaluated.decisions.length };
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [告警] 本轮评估失败（不影响巡检）：' + lastError);
    return { ok: false, error: lastError };
  }
}

function listEvents(opt) {
  if (!ensure() || !eventsReady) return { ready: false, items: [] };
  const o = opt || {};
  const status = String(o.status || 'unresolved');
  const limit = Math.min(200, Math.max(1, Number(o.limit) || 50));
  let where = '1=1';
  if (status === 'unresolved') where = "status IN ('open','acked')";
  else if (['open', 'acked', 'resolved'].includes(status)) where = "status = '" + status + "'";
  try {
    const items = H().prepare(
      'SELECT * FROM it_alert_events WHERE ' + where + ' ORDER BY'
      + " CASE level WHEN 'critical' THEN 0 ELSE 1 END, id DESC LIMIT ?"
    ).all(limit);
    return { ready: true, items: items };
  } catch (e) { return { ready: false, items: [], error: String((e && e.message) || e) }; }
}

function summary() {
  if (!ensure() || !eventsReady) return { ready: false, open: 0, unacked: 0, critical: 0, rules: 0 };
  try {
    const rows = H().prepare(
      "SELECT status, level, COUNT(*) c FROM it_alert_events WHERE status IN ('open','acked') GROUP BY status, level"
    ).all();
    let open = 0, unacked = 0, critical = 0;
    for (const r of rows) {
      open += r.c;
      if (r.status === 'open') unacked += r.c;
      if (r.level === 'critical') critical += r.c;
    }
    return { ready: true, open: open, unacked: unacked, critical: critical, rules: listRules().filter((r) => r.enabled).length };
  } catch (e) { return { ready: false, open: 0, unacked: 0, critical: 0, rules: 0 }; }
}

function ackEvent(id, user, note) {
  if (!ensure() || !eventsReady) return { ok: false, error: '事件库不可用' };
  try {
    const r = H().prepare('SELECT id, status FROM it_alert_events WHERE id = ?').get(Number(id));
    if (!r) return { ok: false, error: '事件不存在' };
    if (r.status === 'resolved') return { ok: false, error: '事件已恢复，无需确认' };
    H().prepare("UPDATE it_alert_events SET status='acked', acked_by=?, acked_at=?, ack_note=? WHERE id=?")
      .run(String((user && user.username) || ''), history.now(), String(note || '').slice(0, 200), Number(id));
    return { ok: true };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}

module.exports = {
  ensure, listRules, upsertRule, deleteRule, listEvents, summary, ackEvent, applyRound, useDb,
  evaluateRound, pickRules, levelOf, valueOf, DEFAULT_RULES,
  status: () => ({ ready: ready, eventsReady: eventsReady, lastError: lastError })
};
