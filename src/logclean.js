'use strict';
/**
 * logclean.js —— 操作日志自动清理
 *
 * 背景：logs 表（his.db）没有保留上限，登录失败、流量告警、每步操作都往里写，
 * 表会无限增长 —— 不是「会不会出事」而是「什么时候出事」：库变大、
 * 日志页翻不动、备份也越来越重。
 *
 * 策略与流量采样、巡检历史对齐：保留 N 天（默认 180，可用 LOG_KEEP_DAYS 环境变量调整），
 * 启动时清一次，之后每 12 小时补一次。日志是审计数据，宁可保守，
 * 但「留 180 天」与「永远留」之间，前者已经覆盖了医院内部的绝大多数追溯需求。
 */

const config = require('../config');
const issueDb = require('./db');

function cutoffText(days) {
  // 注意：不能用 days || 180，0 是合法入参（会被夹到 7 天），必须显式判 null/undefined
  const n = (days == null) ? 180 : Number(days);
  const d = new Date(Date.now() - n * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
    + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 清理超过保留期的操作日志。返回 { ok, deleted, days } */
function cleanupLogs(days) {
  // days == null 才取默认值；显式传 0 必须生效（用于「夹到 7 天下限」的自测与运维场景）
  const raw = (days == null) ? Number(config.LOG_KEEP_DAYS || 180) : Number(days);
  const keep = Math.max(7, Number.isFinite(raw) ? raw : 180);
  try {
    const db = issueDb.getDb();
    const res = db.prepare('DELETE FROM logs WHERE created_at < ?').run(cutoffText(keep));
    return { ok: true, deleted: res.changes || 0, days: keep };
  } catch (e) {
    return { ok: false, deleted: 0, days: keep, error: String((e && e.message) || e) };
  }
}

/** 启动时清一次，之后每 12 小时补一次；任何一步失败都只告警，绝不拖垮服务 */
function scheduleLogCleanup() {
  const run = () => {
    try {
      const r = cleanupLogs();
      if (r.ok && r.deleted) console.log('>>> 已清理 ' + r.deleted + ' 条超过 ' + r.days + ' 天的操作日志');
      else if (!r.ok) console.warn('>>> 操作日志清理失败（忽略）：' + (r.error || '未知原因'));
    } catch (e) {
      console.warn('>>> 操作日志清理异常（忽略）：' + ((e && e.message) || e));
    }
  };
  run();
  const timer = setInterval(run, 12 * 3600 * 1000);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { cleanupLogs, scheduleLogCleanup, cutoffText };
