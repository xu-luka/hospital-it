'use strict';
/**
 * history.js —— 巡检结果快照与趋势（阶段 5b / P2 扩展）
 *
 * 独立库 data/inspect.db，与业务库（contract / his）分开，理由：
 *   - 26 台设备每轮一条，默认 60 秒一轮，一天约 3.7 万条。混进业务库会让
 *     备份包快速膨胀，也会拖慢合同台账的查询。
 *   - 保留策略完全不同：业务数据要永久留存，巡检快照定期自动清理即可。
 *   - 单独一个文件，坏了也只是丢趋势和历史，不影响设备台账与业务数据。
 *
 * P2：新增 metrics_json，把一整包数值指标（含 exporter 的 extra / textfile 自定义指标）
 * 压成一行存下来，**不给历史表拆行**（26 台 × 每轮 1 行，行数不变，磁盘只多一列文本）。
 * 趋势不再另建物化桶表：单台设备一次范围查询最多几千行，按 device_id + checked_at
 * 索引取出后在内存里做 5 分钟 / 1 小时桶，比「每轮再写几十行桶表 + 两套清理」更稳，
 * 也避免老库迁移多一张表的风险。1h 读原始点、24h 读 5m 桶、7d 读 1h 桶，效果一致。
 *
 * 设备名/地址/类型在这里冗余存一份，不做外键关联：
 *   设备改名或换地址后，历史记录应当仍反映「当时巡检的是谁」。
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');

let db = null;
let ready = false;
let lastError = null;
let dbFileOverride = null;

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function dbFile() { return dbFileOverride || config.INSPECT_DB_FILE; }

/** 测试钩子：把历史库指到临时文件，方便离线自测不碰生产 data/ */
function useDbFile(file) {
  if (ready) { try { db.close(); } catch (e) { /* ignore */ } }
  db = null; ready = false; lastError = null;
  dbFileOverride = file || null;
}

function init() {
  if (ready) return true;
  try {
    fs.mkdirSync(path.dirname(dbFile()), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(dbFile());
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS it_inspect_rounds (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        round_no     INTEGER NOT NULL,
        source       TEXT,
        started_at   TEXT,
        finished_at  TEXT,
        duration_ms  INTEGER,
        total        INTEGER DEFAULT 0,
        normal       INTEGER DEFAULT 0,
        warning      INTEGER DEFAULT 0,
        critical     INTEGER DEFAULT 0,
        error        INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS it_inspect_history (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id     INTEGER,
        round_no     INTEGER,
        device_id    INTEGER,
        name         TEXT,
        host         TEXT,
        os           TEXT,
        ok           INTEGER DEFAULT 0,
        status       TEXT,
        cpu_percent  REAL,
        mem_percent  REAL,
        error        TEXT,
        reasons      TEXT,
        metrics_json TEXT,
        checked_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_hist_device ON it_inspect_history(device_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_hist_time   ON it_inspect_history(checked_at);
      CREATE INDEX IF NOT EXISTS idx_round_no    ON it_inspect_rounds(round_no);
    `);
    // 老库补列：必须放在建索引之外单独做。写进上面的 CREATE TABLE 段，老库不会报错，
    // 但列永远不存在，后续 INSERT 会整轮失败并被 saveRound 吃掉 —— 表现为「趋势悄悄停更」。
    try {
      const cols = db.prepare('PRAGMA table_info(it_inspect_history)').all();
      if (!cols.some((c) => c.name === 'metrics_json')) {
        db.exec('ALTER TABLE it_inspect_history ADD COLUMN metrics_json TEXT');
      }
    } catch (e) {
      console.error('>>> [巡检历史库] 补 metrics_json 列失败：' + ((e && e.message) || e));
    }
    ready = true;
    lastError = null;
    return true;
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [巡检历史库] 初始化失败，趋势功能不可用（巡检本身不受影响）：' + lastError);
    ready = false;
    return false;
  }
}

/* ---------------- 指标展平与目录 ---------------- */

/** 静态目录：key -> { label, unit, warn, crit, direction }。动态指标（textfile）在 catalog() 里补中文名 */
const METRIC_CATALOG = {
  cpu_percent:       { label: 'CPU 使用率', unit: '%', warn: 70, crit: 90 },
  mem_percent:       { label: '内存使用率', unit: '%', warn: 80, crit: 95 },
  load1:             { label: '负载 1 分钟', unit: '' },
  uptime_sec:        { label: '开机时长', unit: 's' },
  cores:             { label: 'CPU 核数', unit: '核' },
  procs:             { label: '进程数', unit: '个' },
  zombies:           { label: '僵尸进程', unit: '个' },
  log_errors:        { label: '事件日志错误数', unit: '条' },
  disk_percent_max:  { label: '磁盘最大使用率', unit: '%', warn: 80, crit: 90 },
  net_total_kbps:    { label: '网卡总速率', unit: 'KB/s' },
  net_errs:          { label: '网卡错包丢包', unit: '个' },
  'x.threads':       { label: '系统线程数', unit: '个' },
  'x.handles':       { label: '系统句柄数', unit: '个' },
  'x.context_switches_per_sec': { label: '上下文切换', unit: '/s' },
  'x.processes':     { label: '进程数（exporter）', unit: '个' },
  'x.commit_percent': { label: '提交内存占比', unit: '%' },
  'x.page_faults_per_sec': { label: '缺页率', unit: '/s' },
  'x.disk_read_iops': { label: '磁盘读 IOPS', unit: '次/s' },
  'x.disk_write_iops': { label: '磁盘写 IOPS', unit: '次/s' },
  'x.disk_read_latency_ms': { label: '磁盘读延迟', unit: 'ms' },
  'x.disk_write_latency_ms': { label: '磁盘写延迟', unit: 'ms' },
  'x.tcp_established': { label: 'TCP 已建立连接', unit: '个' },
  'x.bandwidth_used_percent': { label: '带宽利用率', unit: '%' }
};

function num(v) {
  const n = Number(v);
  return (v === null || v === undefined || v === '' || !Number.isFinite(n)) ? null : n;
}

/**
 * 把一台设备的一轮结果压成扁平指标表。
 * 只存数值：字符串/对象/数组一律不进历史，避免一条 results 把库撑到几 MB。
 * 前缀约定：x. = exporter extra.system / extra.disk_io / extra.network；tf. = textfile 自定义指标。
 */
function flattenMetrics(d) {
  const out = {};
  if (!d) return out;
  const m = d.metrics || {};
  const keys = ['cpu_percent', 'mem_percent', 'load1', 'uptime_sec', 'cores', 'procs',
    'zombies', 'log_errors', 'log_warns'];
  for (const k of keys) { const v = num(m[k]); if (v !== null) out[k] = v; }

  if (Array.isArray(m.disks)) {
    let mx = null;
    for (const dk of m.disks) {
      const v = num(dk && (dk.used_percent != null ? dk.used_percent : dk.percent));
      if (v !== null) mx = mx === null ? v : Math.max(mx, v);
    }
    if (mx !== null) out.disk_percent_max = mx;
  }
  if (Array.isArray(m.net)) {
    let rx = 0, tx = 0, errs = 0, has = false;
    for (const n of m.net) {
      const a = num(n && n.rx_kbps), b = num(n && n.tx_kbps);
      if (a !== null || b !== null) has = true;
      rx += a || 0; tx += b || 0; errs += num(n && n.errs) || 0;
    }
    if (has) { out.net_total_kbps = Math.round(rx + tx); out.net_errs = errs; }
  }

  const ex = d.extra || {};
  // extra.system 里既有标量也有对象，只取有限数值
  for (const src of [ex.system, ex.network, ex.disk_io, ex.memory]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      const n = num(v);
      if (n !== null && !k.startsWith('_')) out['x.' + k] = n;
    }
  }
  const items = (ex.textfile && Array.isArray(ex.textfile.items)) ? ex.textfile.items : [];
  for (const it of items) {
    const v = num(it && it.value);
    if (v !== null && it.key) out['tf.' + it.key] = v;
  }
  return out;
}

/** 单台设备最近一轮能出哪些指标，供大屏下拉与规则表使用 */
function catalog() {
  if (!init()) return { ready: false, items: [] };
  try {
    const r = db.prepare('SELECT MAX(round_no) AS rn FROM it_inspect_history').get();
    if (!r || !r.rn) return { ready: true, items: [] };
    const rows = db.prepare(
      'SELECT device_id, name, metrics_json FROM it_inspect_history WHERE round_no = ?'
    ).all(r.rn);
    const map = new Map();
    for (const row of rows) {
      let obj = {};
      try { obj = JSON.parse(row.metrics_json || '{}') || {}; } catch (e) { continue; }
      for (const [k, v] of Object.entries(obj)) {
        if (num(v) === null) continue;
        if (!map.has(k)) {
          const meta = METRIC_CATALOG[k] || {};
          const tf = k.startsWith('tf.') ? textfileMeta(k.slice(3), rows) : null;
          map.set(k, {
            key: k, label: meta.label || (tf && tf.name) || k.replace(/^(tf|x)\./, ''),
            unit: meta.unit || (tf && tf.unit) || '',
            warn: meta.warn == null ? null : meta.warn,
            crit: meta.crit == null ? null : meta.crit,
            devices: []
          });
        }
        map.get(k).devices.push({ id: row.device_id, name: row.name });
      }
    }
    return { ready: true, items: Array.from(map.values()).sort((a, b) => a.key.localeCompare(b.key)) };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ready: false, items: [], error: lastError };
  }
}

/** textfile 指标的中文名/单位来自 # HELP，存在 extra.textfile.items 里；这里从同轮快照里找 */
function textfileMeta(key, rows) {
  for (const row of rows) {
    // 展平后的 metrics_json 不带 HELP 元数据，名字在 labels 表里单独存
    let obj = {};
    try { obj = JSON.parse(row.metrics_json || '{}') || {}; } catch (e) { continue; }
    const meta = obj.__meta && obj.__meta['tf.' + key];
    if (meta) return meta;
  }
  return null;
}

/** 最近一轮每台的完整指标，业务指标卡 / 设备卡取数 */
function latestRound() {
  if (!init()) return { ready: false, roundNo: 0, checkedAt: null, items: [] };
  try {
    const r = db.prepare('SELECT MAX(round_no) AS rn FROM it_inspect_history').get();
    if (!r || !r.rn) return { ready: true, roundNo: 0, checkedAt: null, items: [] };
    const rows = db.prepare(
      'SELECT device_id, name, host, os, status, metrics_json, checked_at FROM it_inspect_history WHERE round_no = ?'
    ).all(r.rn);
    return {
      ready: true, roundNo: r.rn, checkedAt: rows.length ? rows[0].checked_at : null,
      items: rows.map((x) => {
        let m = {};
        try { m = JSON.parse(x.metrics_json || '{}') || {}; } catch (e) { m = {}; }
        delete m.__meta;
        return { deviceId: x.device_id, name: x.name, host: x.host, os: x.os,
          status: x.status, checkedAt: x.checked_at, metrics: m };
      })
    };
  } catch (e) {
    return { ready: false, roundNo: 0, checkedAt: null, items: [], error: String((e && e.message) || e) };
  }
}

/* ---------------- 时间桶与序列 ---------------- */

const RANGES = {
  '1h':  { ms: 3600e3,       bucketMs: 0,          label: '1 小时 · 原始点' },
  '6h':  { ms: 6 * 3600e3,  bucketMs: 60e3,       label: '6 小时 · 每 1 分钟 1 点' },
  '24h': { ms: 24 * 3600e3, bucketMs: 5 * 60e3,   label: '24 小时 · 每 5 分钟 1 点' },
  '7d':  { ms: 7 * 86400e3, bucketMs: 3600e3,     label: '7 天 · 每 1 小时 1 点' }
};

/** "2026-11-10 09:31:02" -> ms（本地时区）；解析不了返回 0 */
function tsOf(s) {
  const t = Date.parse(String(s || '').replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 单台设备、单个指标、指定时间窗的序列。
 * 桶内返回均值 + min/max（前端画 min-max 带），不做 SQL JSON 聚合：
 * SQLite 的 json_extract 对含花括号的 textfile key 转义极麻烦，单设备几千行在内存里算更快也更稳。
 */
function seriesFor(deviceId, key, range) {
  const rg = RANGES[range] || RANGES['24h'];
  const empty = { ready: false, key: key, range: range || '24h', label: rg.label,
    unit: (METRIC_CATALOG[key] || {}).unit || '', items: [], count: 0, min: null, max: null, avg: null };
  if (!init()) return empty;
  const id = Number(deviceId);
  if (!id || !key) return empty;
  try {
    const from = nowAt(Date.now() - rg.ms);
    const rows = db.prepare(
      'SELECT checked_at, metrics_json FROM it_inspect_history'
      + ' WHERE device_id = ? AND checked_at >= ? ORDER BY id ASC LIMIT 20000'
    ).all(id, from);
    const buckets = new Map();
    for (const row of rows) {
      let obj = {};
      try { obj = JSON.parse(row.metrics_json || '{}') || {}; } catch (e) { continue; }
      const v = num(obj[key]);
      if (v === null) continue;
      const t = tsOf(row.checked_at);
      if (!t) continue;
      const bk = rg.bucketMs ? Math.floor(t / rg.bucketMs) * rg.bucketMs : t;
      const b = buckets.get(bk) || { ts: bk, sum: 0, n: 0, min: v, max: v };
      b.sum += v; b.n++; b.min = Math.min(b.min, v); b.max = Math.max(b.max, v);
      buckets.set(bk, b);
    }
    const items = Array.from(buckets.values()).sort((a, b) => a.ts - b.ts).map((b) => ({
      ts: b.ts, value: +(b.sum / b.n).toFixed(3), min: b.min, max: b.max, n: b.n
    }));
    let mn = null, mx = null, sum = 0;
    for (const it of items) {
      mn = mn === null ? it.min : Math.min(mn, it.min);
      mx = mx === null ? it.max : Math.max(mx, it.max);
      sum += it.value;
    }
    const cat = (catalog().items || []).find((x) => x.key === key) || {};
    return {
      ready: true, key: key, range: range || '24h', label: rg.label,
      labelCn: cat.label || (METRIC_CATALOG[key] || {}).label || key,
      unit: cat.unit || (METRIC_CATALOG[key] || {}).unit || '',
      items: items, count: items.length, min: mn, max: mx,
      avg: items.length ? +(sum / items.length).toFixed(3) : null
    };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return Object.assign({}, empty, { error: lastError });
  }
}

function nowAt(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ---------------- 落库 ---------------- */

/** 保存一轮的结果快照。写失败绝不能影响巡检主流程 —— 历史只是附加价值。 */
function saveRound(opt) {
  if (!init()) return { ok: false, skipped: true, reason: lastError };
  const results = opt.results || [];
  const s = opt.summary || { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  let roundId = null;
  let n = 0;
  try {
    const r = db.prepare(
      'INSERT INTO it_inspect_rounds (round_no, source, started_at, finished_at, duration_ms, total, normal, warning, critical, error)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      opt.roundNo || 0, String(opt.source || ''), String(opt.startedAt || now()), now(),
      Math.round(opt.durationMs || 0),
      s.total || 0, s.normal || 0, s.warning || 0, s.critical || 0, s.error || 0
    );
    roundId = Number(r.lastInsertRowid);

    const stmt = db.prepare(
      'INSERT INTO it_inspect_history (round_id, round_no, device_id, name, host, os, ok, status, cpu_percent, mem_percent, error, reasons, metrics_json, checked_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    // 快照逐台写入，放在一个事务里，避免中途失败留下半轮数据
    db.exec('BEGIN');
    try {
      for (const d of results) {
        if (!d) continue;
        const ok = d.ok ? 1 : 0;
        const status = ok ? (d.status || 'normal') : 'error';
        const cpu = (d.metrics && d.metrics.cpu_percent != null) ? Number(d.metrics.cpu_percent) : null;
        const mem = (d.metrics && d.metrics.mem_percent != null) ? Number(d.metrics.mem_percent) : null;
        const flat = flattenMetrics(d);
        // textfile 的中文名/单位单独挂 __meta，catalog() 用它给动态指标命名。
        // 不算作指标本身（seriesFor 只对数值 key 生效），也不会被大屏画成一条线。
        const tfItems = (d.extra && d.extra.textfile && Array.isArray(d.extra.textfile.items))
          ? d.extra.textfile.items : [];
        if (tfItems.length) {
          const meta = {};
          for (const it of tfItems) meta['tf.' + it.key] = { name: it.name || it.key, unit: it.unit || '' };
          flat.__meta = meta;
        }
        stmt.run(
          roundId, opt.roundNo || 0,
          Number(d.deviceId) || null,
          String(d.name || ''), String(d.host || ''), String(d.os || ''),
          ok, status, cpu, mem,
          d.error ? String(d.error).slice(0, 1000) : null,
          d.reasons && d.reasons.length ? JSON.stringify(d.reasons).slice(0, 4000) : null,
          JSON.stringify(flat).slice(0, 16000),
          now()
        );
        n++;
      }
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ }
      throw e;
    }
    return { ok: true, roundId, saved: n };
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [巡检历史库] 写入失败（不影响本轮巡检）：' + lastError);
    return { ok: false, reason: lastError };
  }
}

/** 清理过期历史。按天切一刀执行，避免每轮都跑一次大批量 DELETE 拖慢写入。 */
function cleanup(days) {
  if (!init()) return { ok: false, deleted: 0 };
  const d = Math.max(1, Number(days || config.INSPECT_HISTORY_DAYS || 90));
  try {
    const before = db.exec(
      "DELETE FROM it_inspect_history WHERE checked_at < datetime('now','localtime','-' || " + d + " || ' days')"
    );
    db.exec(
      "DELETE FROM it_inspect_rounds WHERE finished_at < datetime('now','localtime','-' || " + d + " || ' days')"
    );
    return { ok: true, days: d, deleted: (before && before.changes) || 0 };
  } catch (e) {
    return { ok: false, deleted: 0, reason: String((e && e.message) || e) };
  }
}

/** 每台设备最近一次快照，用于台账页展示上次状态 */
function latestByDevice() {
  if (!init()) return {};
  try {
    const rows = db.prepare(
      'SELECT h.* FROM it_inspect_history h'
      + ' JOIN (SELECT device_id, MAX(id) AS mid FROM it_inspect_history WHERE device_id IS NOT NULL GROUP BY device_id) m'
      + ' ON h.id = m.mid'
    ).all();
    const map = {};
    for (const r of rows) {
      map[r.device_id] = {
        status: r.status, ok: !!r.ok, cpu: r.cpu_percent, mem: r.mem_percent,
        checkedAt: r.checked_at, error: r.error
      };
    }
    return map;
  } catch (e) {
    lastError = String((e && e.message) || e);
    return {};
  }
}

/** 单台设备的趋势序列（老接口，保持 cpu/mem 结构不变，前端老代码零回归） */
function trend(deviceId, limit) {
  if (!init()) return [];
  const n = Math.min(2000, Math.max(1, Number(limit || 200)));
  try {
    return db.prepare(
      'SELECT checked_at, status, ok, cpu_percent, mem_percent, error FROM it_inspect_history'
      + ' WHERE device_id = ? ORDER BY id DESC LIMIT ?'
    ).all(Number(deviceId), n).reverse().map((r) => ({
      checkedAt: r.checked_at, status: r.status, ok: !!r.ok,
      cpu: r.cpu_percent, mem: r.mem_percent, error: r.error
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

/** 最近 N 轮的汇总（可用率趋势） */
function recentRounds(limit) {
  if (!init()) return [];
  const n = Math.min(500, Math.max(1, Number(limit || 50)));
  try {
    return db.prepare(
      'SELECT round_no, source, finished_at, duration_ms, total, normal, warning, critical, error'
      + ' FROM it_inspect_rounds ORDER BY id DESC LIMIT ?'
    ).all(n).reverse();
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

/** 按设备统计一段时间内的可用率 */
function availability(days) {
  if (!init()) return [];
  const d = Math.max(1, Number(days || 7));
  try {
    return db.prepare(
      'SELECT device_id, name, host, COUNT(*) AS total,'
      + " SUM(CASE WHEN ok=1 AND (status='normal' OR status='warning') THEN 1 ELSE 0 END) AS good,"
      + ' MAX(mem_percent) AS mem_max, MAX(cpu_percent) AS cpu_max'
      + ' FROM it_inspect_history'
      + " WHERE device_id IS NOT NULL AND checked_at >= datetime('now','localtime','-' || " + d + " || ' days')"
      + ' GROUP BY device_id ORDER BY name'
    ).all().map((r) => ({
      deviceId: r.device_id, name: r.name, host: r.host, total: r.total, good: r.good,
      rate: r.total ? +(r.good / r.total * 100).toFixed(1) : null,
      cpuMax: r.cpu_max, memMax: r.mem_max
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

function stats() {
  if (!init()) return { ready: false, error: lastError, rounds: 0, snapshots: 0, lastAt: null };
  try {
    const r = db.prepare('SELECT COUNT(*) c FROM it_inspect_rounds').get();
    const h = db.prepare('SELECT COUNT(*) c, MAX(checked_at) last FROM it_inspect_history').get();
    return { ready: true, rounds: r.c, snapshots: h.c, lastAt: h.last, file: dbFile() };
  } catch (e) {
    return { ready: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  init, saveRound, cleanup, latestByDevice, trend, recentRounds, availability, stats, now,
  flattenMetrics, catalog, latestRound, seriesFor, METRIC_CATALOG, RANGES, useDbFile, nowAt, tsOf,
  get db() { if (!ready) init(); return db; },
  available: () => ready || init()
};
