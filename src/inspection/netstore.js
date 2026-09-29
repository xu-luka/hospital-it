'use strict';
/**
 * netstore.js —— 端口流量时序存储与「突发大流量」判定
 *
 * 落在巡检库 data/inspect.db 里（与 it_inspect_* 同库不同表），理由：
 *   - 同一类运维数据，一起备份、一起被巡检库的健康检查覆盖；
 *   - 保留策略完全不同（默认 7 天 vs 巡检历史 90 天），用独立的表分别清理即可，
 *     没必要为一个新功能再开一个库文件。
 *
 * 判定思路（不引入任何新协议，只用 netflow.js 采来的端口速率）：
 *   1) 基线 = 该端口「过去一段时间」吞吐的**中位数**。
 *      为什么用中位数而不是平均值：一次突发会把平均值整体抬高，
 *      导致突发结束后基线虚高、真正的第二次突发反而判不出来；中位数不受单点污染。
 *   2) 阈值 = max(基线 × 倍数, 绝对下限)。
 *      绝对下限是为了避免「基线 0.1 Mbps → 涨到 1 Mbps 就报 10 倍」这种噪声，
 *      没到绝对下限的一律不算突发。
 *   3) 冷却期：同一端口在冷却期内已有未确认告警就不再重复告警，避免刷屏。
 *   4) 样本不足（刚上线/刚加设备）不判定 —— 第一天就刷一屏告警没人会看。
 *
 * 一个端口挂多个终端时 ip 为空：那时「这个端口的流量」不等于「某个 IP 的流量」，
 * 宁可只报端口，也不把总量摊到每个 IP 上编造假数字。
 */

const fs = require('fs');
const path = require('path');
const config = require('../../config');

let db = null;
let ready = false;
let lastError = null;

/** 默认阈值配置。改这里的值要先想清楚：宁可漏报，也不要每天刷屏。 */
const DEFAULTS = {
  enabled: 1,          // 0 = 关闭自动采集（接口仍可手动触发）
  interval_sec: 300,   // 采集间隔，与交换机「5 分钟均值」对齐
  window_min: 60,      // 基线回看窗口
  ratio: 5,            // 相对基线的倍数
  min_bps: 50 * 1000 * 1000,   // 绝对下限 50 Mbps
  min_samples: 3,      // 窗口内少于这个样本数不判定
  cool_down_min: 30,   // 同端口告警冷却
  keep_days: 7,        // 采样保留天数
  save_idle: 0,        // 0 = 丢弃空闲/DOWN 端口的采样（省空间）
  top_n: 20            // TopN 默认条数
};

function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 本地时间往前推 n 分钟，格式与 now() 一致（SQLite 字符串比较可直接用） */
function agoText(min) {
  const d = new Date(Date.now() - Number(min || 0) * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function init() {
  if (ready) return true;
  try {
    fs.mkdirSync(path.dirname(config.INSPECT_DB_FILE), { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    db = new DatabaseSync(config.INSPECT_DB_FILE);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA busy_timeout = 5000;');
    db.exec(`
      CREATE TABLE IF NOT EXISTS it_net_sample (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id   INTEGER,
        device      TEXT,
        host        TEXT,
        iface       TEXT,
        iface_key   TEXT,
        ip          TEXT,
        ip_count    INTEGER DEFAULT 0,
        link_up     INTEGER DEFAULT 0,
        in_bps      INTEGER DEFAULT 0,
        out_bps     INTEGER DEFAULT 0,
        total_bps   INTEGER DEFAULT 0,
        sampled_at  TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_net_s_dev_if ON it_net_sample(device_id, iface_key, id DESC);
      CREATE INDEX IF NOT EXISTS idx_net_s_time   ON it_net_sample(sampled_at);
      CREATE INDEX IF NOT EXISTS idx_net_s_ip     ON it_net_sample(ip, sampled_at);

      CREATE TABLE IF NOT EXISTS it_net_alert (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id  INTEGER,
        device     TEXT,
        host       TEXT,
        iface      TEXT,
        iface_key  TEXT,
        ip         TEXT,
        ip_count   INTEGER DEFAULT 0,
        kind       TEXT,
        peak_bps   INTEGER DEFAULT 0,
        base_bps   INTEGER DEFAULT 0,
        ratio      REAL,
        detail     TEXT,
        raised_at  TEXT,
        ack        INTEGER DEFAULT 0,
        ack_at     TEXT,
        ack_by     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_net_a_time ON it_net_alert(raised_at);
      CREATE INDEX IF NOT EXISTS idx_net_a_ack  ON it_net_alert(ack, id DESC);
      CREATE INDEX IF NOT EXISTS idx_net_a_dev_if ON it_net_alert(device_id, iface_key, id DESC);

      CREATE TABLE IF NOT EXISTS it_net_config (
        key        TEXT PRIMARY KEY,
        value      TEXT,
        updated_at TEXT
      );
    `);
    ready = true;
    lastError = null;
    return true;
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [流量库] 初始化失败，流量监控不可用（巡检不受影响）：' + lastError);
    ready = false;
    return false;
  }
}

/* ---------------- 配置 ---------------- */

function getConfig() {
  const out = Object.assign({}, DEFAULTS);
  if (!init()) return out;
  try {
    const rows = db.prepare('SELECT key, value FROM it_net_config').all();
    for (const r of rows) {
      if (!(r.key in DEFAULTS)) continue;
      const d = DEFAULTS[r.key];
      if (typeof d === 'number') {
        const n = Number(r.value);
        if (Number.isFinite(n)) out[r.key] = n;
      } else {
        out[r.key] = r.value;
      }
    }
  } catch (e) { lastError = String((e && e.message) || e); }
  return out;
}

/** 只接受 DEFAULTS 里已有的键，避免写进垃圾键把配置表撑乱 */
function setConfig(patch) {
  if (!init()) return { ok: false, reason: lastError };
  const p = patch || {};
  let n = 0;
  try {
    const stmt = db.prepare(
      'INSERT INTO it_net_config (key, value, updated_at) VALUES (?, ?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    );
    db.exec('BEGIN');
    try {
      for (const k of Object.keys(p)) {
        if (!(k in DEFAULTS)) continue;
        const d = DEFAULTS[k];
        let v = p[k];
        if (typeof d === 'number') {
          v = Number(v);
          if (!Number.isFinite(v)) continue;
        }
        stmt.run(k, String(v), now());
        n++;
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ } throw e; }
    return { ok: true, updated: n, config: getConfig() };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, reason: lastError };
  }
}

/* ---------------- 采样写入 ---------------- */

/**
 * 写入一台交换机一轮的端口采样。
 * @param {object} o { deviceId, device, host, rows, at, cfg }
 * @returns {{ok, saved, skipped}}
 */
function saveSamples(o) {
  const opt = o || {};
  if (!init()) return { ok: false, skipped: true, reason: lastError };
  const cfg = opt.cfg || getConfig();
  const rows = Array.isArray(opt.rows) ? opt.rows : [];
  const at = opt.at || now();
  let n = 0;
  try {
    const stmt = db.prepare(
      'INSERT INTO it_net_sample (device_id, device, host, iface, iface_key, ip, ip_count, link_up, in_bps, out_bps, total_bps, sampled_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    db.exec('BEGIN');
    try {
      for (const r of rows) {
        if (!r) continue;
        // 空闲口与 DOWN 口默认不入库：几十个空口 × 每 5 分钟，几天就能撑到百万行，
        // 而对「谁在跑大流量」这个问题毫无贡献。
        if (!cfg.save_idle && (!r.linkUp || !(r.totalBps > 0))) continue;
        stmt.run(
          Number(opt.deviceId) || null,
          String(opt.device || ''), String(opt.host || ''),
          String(r.iface || ''), String(r.ifaceKey || r.iface || ''),
          String(r.ip || ''), Number(r.ipCount) || 0,
          r.linkUp ? 1 : 0,
          Math.round(r.inBps || 0), Math.round(r.outBps || 0), Math.round(r.totalBps || 0),
          at
        );
        n++;
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ } throw e; }
    return { ok: true, saved: n, at: at };
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [流量库] 采样写入失败（不影响采集本身）：' + lastError);
    return { ok: false, reason: lastError };
  }
}

/** 中位数：偶数个取中间两个的均值 */
function median(list) {
  const a = list.slice().sort((x, y) => x - y);
  if (!a.length) return null;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 某端口在回看窗口内的基线（中位数）。
 * 排除最新一条之后取值，避免把「正在判定的这个点」算进自己的基线里。
 */
function baseline(deviceId, ifaceKey, windowMin) {
  if (!init()) return { samples: [], median: null };
  const since = agoText(windowMin);
  try {
    const rows = db.prepare(
      'SELECT total_bps FROM it_net_sample'
      + ' WHERE device_id = ? AND iface_key = ? AND sampled_at >= ?'
      + ' ORDER BY id DESC LIMIT 500'
    ).all(Number(deviceId), String(ifaceKey), since);
    const all = rows.map((r) => Number(r.total_bps) || 0);
    const hist = all.slice(1); // 丢掉最新一条
    return { samples: hist, median: median(hist), latest: all.length ? all[0] : null };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { samples: [], median: null };
  }
}

/* ---------------- 突发判定 ---------------- */

/**
 * 对一台交换机本轮的端口行做突发判定。
 * @returns {Array} 告警对象数组（未落库）
 */
function detectBursts(o) {
  const opt = o || {};
  const cfg = opt.cfg || getConfig();
  const rows = Array.isArray(opt.rows) ? opt.rows : [];
  const out = [];
  const deviceId = Number(opt.deviceId) || 0;
  for (const r of rows) {
    if (!r || !r.linkUp) continue;
    const cur = Number(r.totalBps) || 0;
    if (cur <= 0) continue;
    const key = String(r.ifaceKey || r.iface || '');
    if (!key) continue;
    const b = baseline(deviceId, key, cfg.window_min);
    // 冷启动/样本不足：不判定，宁可不报也不要一上线刷一屏
    if (!b.samples.length || b.samples.length < cfg.min_samples) continue;
    const base = Number(b.median) || 0;
    const floor = Math.max(cfg.min_bps, 1);
    const threshold = Math.max(base * cfg.ratio, floor);
    if (cur < threshold) continue;
    // 主导方向：入站还是出站，运维处置方向完全不同
    const kind = (Number(r.inBps) || 0) >= (Number(r.outBps) || 0) ? 'in' : 'out';
    out.push({
      deviceId: deviceId,
      device: String(opt.device || ''),
      host: String(opt.host || ''),
      iface: String(r.iface || ''),
      ifaceKey: key,
      ip: String(r.ip || ''),
      ipCount: Number(r.ipCount) || 0,
      kind: kind,
      peakBps: cur,
      baseBps: base,
      ratio: base > 0 ? +(cur / base).toFixed(2) : null,
      inBps: Math.round(r.inBps || 0),
      outBps: Math.round(r.outBps || 0),
      samples: b.samples.length,
      detail: describeBurst(r, base, cur, cfg)
    });
  }
  return out;
}

function fmtBps(bps) {
  const v = Number(bps) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Gbps';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(2) + ' Kbps';
  return v + ' bps';
}

function describeBurst(r, base, cur, cfg) {
  const who = r.ip ? ('IP ' + r.ip) : ('端口下有 ' + (r.ipCount || 0) + ' 个终端');
  const x = base > 0 ? (cur / base).toFixed(1) + ' 倍' : '无基线';
  return '端口 ' + r.iface + '（' + who + '）吞吐 ' + fmtBps(cur)
    + '，基线 ' + fmtBps(base) + '，约为 ' + x
    + '；入 ' + fmtBps(r.inBps) + ' / 出 ' + fmtBps(r.outBps)
    + '（阈值 ' + fmtBps(Math.max(base * cfg.ratio, cfg.min_bps)) + '）';
}

/**
 * 落库告警，带冷却：同端口在冷却期内已有未确认告警则跳过。
 * @returns {{ok, saved, cooled}}
 */
function saveAlerts(o) {
  const opt = o || {};
  if (!init()) return { ok: false, reason: lastError };
  const list = Array.isArray(opt.alerts) ? opt.alerts : [];
  if (!list.length) return { ok: true, saved: 0, cooled: 0 };
  const cfg = opt.cfg || getConfig();
  const since = agoText(cfg.cool_down_min);
  let saved = 0;
  let cooled = 0;
  try {
    const recent = db.prepare(
      'SELECT device_id, iface_key FROM it_net_alert WHERE ack = 0 AND raised_at >= ?'
    ).all(since);
    const hot = new Set(recent.map((r) => Number(r.device_id) + '|' + String(r.iface_key)));

    const stmt = db.prepare(
      'INSERT INTO it_net_alert (device_id, device, host, iface, iface_key, ip, ip_count, kind, peak_bps, base_bps, ratio, detail, raised_at, ack)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)'
    );
    const at = opt.at || now();
    db.exec('BEGIN');
    try {
      for (const a of list) {
        const k = Number(a.deviceId) + '|' + String(a.ifaceKey);
        if (hot.has(k)) { cooled++; continue; }
        stmt.run(
          Number(a.deviceId) || null, String(a.device || ''), String(a.host || ''),
          String(a.iface || ''), String(a.ifaceKey || ''), String(a.ip || ''),
          Number(a.ipCount) || 0, String(a.kind || 'total'),
          Math.round(a.peakBps || 0), Math.round(a.baseBps || 0),
          a.ratio == null ? null : Number(a.ratio),
          String(a.detail || '').slice(0, 1000), at
        );
        hot.add(k); // 同一批里也只报一次
        saved++;
      }
      db.exec('COMMIT');
    } catch (e) { try { db.exec('ROLLBACK'); } catch (e2) { /* 忽略 */ } throw e; }
    return { ok: true, saved: saved, cooled: cooled, at: at };
  } catch (e) {
    lastError = String((e && e.message) || e);
    console.error('>>> [流量库] 告警写入失败：' + lastError);
    return { ok: false, reason: lastError };
  }
}

/* ---------------- 查询 ---------------- */

/** 最新一轮的全部端口行（按吞吐倒序） */
function latest(deviceId, limit) {
  if (!init()) return { at: null, rows: [] };
  const n = Math.min(2000, Math.max(1, Number(limit || 500)));
  try {
    let at = null;
    if (deviceId) {
      const r = db.prepare('SELECT MAX(sampled_at) m FROM it_net_sample WHERE device_id = ?').get(Number(deviceId));
      at = r ? r.m : null;
    } else {
      const r = db.prepare('SELECT MAX(sampled_at) m FROM it_net_sample').get();
      at = r ? r.m : null;
    }
    if (!at) return { at: null, rows: [] };
    const sql = 'SELECT device_id, device, host, iface, ip, ip_count, link_up, in_bps, out_bps, total_bps, sampled_at'
      + ' FROM it_net_sample WHERE sampled_at = ?'
      + (deviceId ? ' AND device_id = ?' : '')
      + ' ORDER BY total_bps DESC LIMIT ?';
    const args = deviceId ? [at, Number(deviceId), n] : [at, n];
    return {
      at: at,
      rows: db.prepare(sql).all(...args).map(mapSample)
    };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { at: null, rows: [] };
  }
}

function mapSample(r) {
  return {
    deviceId: r.device_id, device: r.device, host: r.host,
    iface: r.iface, ip: r.ip, ipCount: r.ip_count, linkUp: !!r.link_up,
    inBps: r.in_bps, outBps: r.out_bps, totalBps: r.total_bps,
    at: r.sampled_at,
    inText: fmtBps(r.in_bps), outText: fmtBps(r.out_bps), totalText: fmtBps(r.total_bps)
  };
}

/**
 * TopN：按 IP 聚合最近一段时间的峰值吞吐。
 * 只统计「端口下只有一个终端」的样本 —— 多终端端口的流量无法归属到具体 IP，
 * 混入排行会得到一份看着精确、实际是假的名单。
 */
function topIp(o) {
  const opt = o || {};
  if (!init()) return [];
  const cfg = opt.cfg || getConfig();
  const minutes = Math.max(1, Number(opt.minutes || 60));
  const limit = Math.min(200, Math.max(1, Number(opt.limit || cfg.top_n || 20)));
  const since = agoText(minutes);
  try {
    return db.prepare(
      "SELECT ip, device, MAX(device_id) device_id, MAX(host) host, MAX(iface) iface,"
      + ' MAX(total_bps) peak_bps, AVG(total_bps) avg_bps, COUNT(*) n'
      + " FROM it_net_sample WHERE sampled_at >= ? AND ip <> ''"
      + ' GROUP BY ip, device ORDER BY peak_bps DESC LIMIT ?'
    ).all(since, limit).map((r) => ({
      ip: r.ip, device: r.device, deviceId: r.device_id, host: r.host, iface: r.iface,
      peakBps: r.peak_bps, avgBps: Math.round(r.avg_bps || 0), samples: r.n,
      peakText: fmtBps(r.peak_bps), avgText: fmtBps(r.avg_bps)
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

/** TopN：按端口聚合（含多终端端口，用于看「哪个口在跑」） */
function topPort(o) {
  const opt = o || {};
  if (!init()) return [];
  const cfg = opt.cfg || getConfig();
  const minutes = Math.max(1, Number(opt.minutes || 60));
  const limit = Math.min(500, Math.max(1, Number(opt.limit || cfg.top_n || 20)));
  const since = agoText(minutes);
  try {
    return db.prepare(
      'SELECT device_id, device, host, iface, MAX(ip) ip, MAX(ip_count) ip_count,'
      + ' MAX(total_bps) peak_bps, AVG(total_bps) avg_bps, COUNT(*) n'
      + ' FROM it_net_sample WHERE sampled_at >= ?'
      + ' GROUP BY device_id, iface ORDER BY peak_bps DESC LIMIT ?'
    ).all(since, limit).map((r) => ({
      deviceId: r.device_id, device: r.device, host: r.host, iface: r.iface,
      ip: r.ip || '', ipCount: r.ip_count || 0,
      peakBps: r.peak_bps, avgBps: Math.round(r.avg_bps || 0), samples: r.n,
      peakText: fmtBps(r.peak_bps), avgText: fmtBps(r.avg_bps)
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

/** 单端口时序（画图用），按时间正序 */
function series(deviceId, ifaceKey, minutes) {
  if (!init()) return [];
  const since = agoText(Math.max(1, Number(minutes || 60)));
  try {
    return db.prepare(
      'SELECT sampled_at, in_bps, out_bps, total_bps FROM it_net_sample'
      // 按时间排序而不是自增 id：补采、重试、手动触发都可能让入库顺序与发生顺序不一致
      + ' WHERE device_id = ? AND iface_key = ? AND sampled_at >= ?'
      + ' ORDER BY sampled_at ASC, id ASC LIMIT 2000'
    ).all(Number(deviceId), String(ifaceKey), since).map((r) => ({
      at: r.sampled_at, inBps: r.in_bps, outBps: r.out_bps, totalBps: r.total_bps
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

function listAlerts(o) {
  const opt = o || {};
  if (!init()) return [];
  const limit = Math.min(500, Math.max(1, Number(opt.limit || 100)));
  const unack = opt.unack ? ' AND ack = 0' : '';
  const dev = opt.deviceId ? ' AND device_id = ' + (Number(opt.deviceId) || 0) : '';
  try {
    return db.prepare(
      'SELECT * FROM it_net_alert WHERE 1 = 1' + unack + dev + ' ORDER BY id DESC LIMIT ?'
    ).all(limit).map((r) => ({
      id: r.id, deviceId: r.device_id, device: r.device, host: r.host,
      iface: r.iface, ip: r.ip, ipCount: r.ip_count, kind: r.kind,
      peakBps: r.peak_bps, baseBps: r.base_bps, ratio: r.ratio,
      peakText: fmtBps(r.peak_bps), baseText: fmtBps(r.base_bps),
      detail: r.detail, raisedAt: r.raised_at, ack: !!r.ack, ackAt: r.ack_at, ackBy: r.ack_by
    }));
  } catch (e) {
    lastError = String((e && e.message) || e);
    return [];
  }
}

function ackAlert(id, by) {
  if (!init()) return { ok: false, reason: lastError };
  try {
    const r = db.prepare('UPDATE it_net_alert SET ack = 1, ack_at = ?, ack_by = ? WHERE id = ?')
      .run(now(), String(by || ''), Number(id));
    return { ok: true, changes: r.changes || 0 };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, reason: lastError };
  }
}

function ackAll(by) {
  if (!init()) return { ok: false, reason: lastError };
  try {
    const r = db.prepare('UPDATE it_net_alert SET ack = 1, ack_at = ?, ack_by = ? WHERE ack = 0')
      .run(now(), String(by || ''));
    return { ok: true, changes: r.changes || 0 };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, reason: lastError };
  }
}

/**
 * 清理过期采样。告警表不跟着删 —— 告警是「发生过的事情」，
 * 要留着复盘，运维自己确认完才该消失。
 */
function cleanup(days) {
  if (!init()) return { ok: false, deleted: 0 };
  const d = Math.max(1, Number(days || getConfig().keep_days || 7));
  try {
    const r = db.prepare('DELETE FROM it_net_sample WHERE sampled_at < ?').run(agoText(d * 1440));
    return { ok: true, days: d, deleted: r.changes || 0 };
  } catch (e) {
    lastError = String((e && e.message) || e);
    return { ok: false, deleted: 0, reason: lastError };
  }
}

function stats() {
  if (!init()) return { ready: false, error: lastError };
  try {
    const s = db.prepare('SELECT COUNT(*) c, MAX(sampled_at) last FROM it_net_sample').get();
    const a = db.prepare('SELECT COUNT(*) c FROM it_net_alert').get();
    const u = db.prepare('SELECT COUNT(*) c FROM it_net_alert WHERE ack = 0').get();
    const d = db.prepare('SELECT COUNT(DISTINCT device_id) c FROM it_net_sample').get();
    return {
      ready: true, samples: s.c, lastAt: s.last, alerts: a.c, unack: u.c,
      devices: d.c, file: config.INSPECT_DB_FILE, config: getConfig()
    };
  } catch (e) {
    return { ready: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  DEFAULTS, init, now, agoText, fmtBps, median,
  getConfig, setConfig,
  saveSamples, baseline, detectBursts, saveAlerts,
  latest, topIp, topPort, series, listAlerts, ackAlert, ackAll,
  cleanup, stats,
  available: () => ready || init()
};
