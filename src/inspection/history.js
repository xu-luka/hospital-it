'use strict';
/**
 * history.js —— 巡检结果快照与趋势（阶段 5b）
 *
 * 独立库 data/inspect.db，与业务库（contract / his）分开，理由：
 *   - 26 台设备每轮一条，默认 60 秒一轮，一天约 3.7 万条。混进业务库会让
 *     备份包快速膨胀，也会拖慢合同台账的查询。
 *   - 保留策略完全不同：业务数据要永久留存，巡检快照 90 天后自动清理即可。
 *   - 单独一个文件，坏了也只是丢趋势和历史，不影响设备台账与业务数据。
 *
 * 设备名/地址/类型在这里冗余存一份，不做外键关联：
 *   设备改名或换地址后，历史记录应当仍反映「当时巡检的是谁」，
 *   而且跨库外键在 SQLite 里需要 ATTACH，收效极小。
 */
const fs = require('fs');
const path = require('path');
const config = require('../../config');

let db = null;
let ready = false;
let lastError = null;

function now() {
  const d = new Date();
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
        checked_at   TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_hist_device ON it_inspect_history(device_id, id DESC);
      CREATE INDEX IF NOT EXISTS idx_hist_time   ON it_inspect_history(checked_at);
      CREATE INDEX IF NOT EXISTS idx_round_no    ON it_inspect_rounds(round_no);
    `);
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

/**
 * 保存一轮的结果快照。
 * 写失败绝不能影响巡检主流程 —— 历史只是附加价值。
 */
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
      'INSERT INTO it_inspect_history (round_id, round_no, device_id, name, host, os, ok, status, cpu_percent, mem_percent, error, reasons, checked_at)'
      + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
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
        stmt.run(
          roundId, opt.roundNo || 0,
          Number(d.deviceId) || null,
          String(d.name || ''), String(d.host || ''), String(d.os || ''),
          ok, status, cpu, mem,
          d.error ? String(d.error).slice(0, 1000) : null,
          d.reasons && d.reasons.length ? JSON.stringify(d.reasons).slice(0, 4000) : null,
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

/**
 * 清理过期历史。按天切一刀执行，避免每轮都跑一次大批量 DELETE 拖慢写入。
 */
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

/**
 * 单台设备的趋势序列。
 * @returns {Array<{checkedAt,status,cpu,mem}>} 按时间正序
 */
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
    return { ready: true, rounds: r.c, snapshots: h.c, lastAt: h.last, file: config.INSPECT_DB_FILE };
  } catch (e) {
    return { ready: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  init, saveRound, cleanup, latestByDevice, trend, recentRounds, availability, stats, now,
  get db() { if (!ready) init(); return db; },
  available: () => ready || init()
};
