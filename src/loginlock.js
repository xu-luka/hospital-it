'use strict';
/**
 * loginlock.js —— 登录失败锁定
 *
 * 背景：/login 对同一用户名可以无限次试密码。系统在内网，但内网不等于没有
 * 暴力尝试（中毒终端、离职账号、弱口令探测），需要一个最低成本的闸门。
 *
 * 策略：同一用户名连续失败 N 次（默认 5），锁定 M 分钟（默认 10）。
 * 锁定期间直接 429，不校验密码（连正确密码也不放行 —— 否则锁定形同虚设，
 * 攻击者只要蒙对一次就能绕过）；登录成功清零计数。
 *
 * 说明：
 * - 纯内存实现：服务重启计数清零，可以接受（锁定的目的是拖慢尝试速度，
 *   重启本身就起到了同样的效果）。
 * - 只按用户名计，不按 IP：内网科室共用出口 IP 很常见，按 IP 锁会误伤一片。
 * - 不存在的用户名也计数：避免通过「这个用户名根本不锁定」探测账号是否存在。
 */

const config = require('../config');

const MAX_FAILS = Math.max(1, Number(config.LOGIN_LOCK_MAX || 5));
const LOCK_MS = Math.max(1, Number(config.LOGIN_LOCK_MINUTES || 10)) * 60000;

// username -> { fails: number, lockedUntil: number(0=未锁定) }
const state = new Map();

function entryOf(name) {
  let e = state.get(name);
  if (!e) { e = { fails: 0, lockedUntil: 0 }; state.set(name, e); }
  return e;
}

/** 当前是否锁定中。返回剩余毫秒数，未锁定返回 0。 */
function lockedRemainingMs(name, now) {
  const e = state.get(String(name || ''));
  if (!e || !e.lockedUntil) return 0;
  const t = (now == null) ? Date.now() : now;
  const remain = e.lockedUntil - t;
  if (remain <= 0) { e.lockedUntil = 0; e.fails = 0; return 0; }
  return remain;
}

/**
 * 记一次失败。返回 { locked, remainingMs, fails }：
 * 本次失败导致新锁定时 locked=true（此时应写一条操作日志）。
 */
function recordFailure(name, now, opts) {
  const o = opts || {};
  const maxFails = Math.max(1, Number(o.maxFails || MAX_FAILS));
  const lockMs = Math.max(1, Number(o.lockMs || LOCK_MS));
  const t = (now == null) ? Date.now() : now;
  const e = entryOf(String(name || ''));
  if (e.lockedUntil && e.lockedUntil > t) {
    return { locked: false, remainingMs: e.lockedUntil - t, fails: e.fails };
  }
  e.lockedUntil = 0;
  e.fails += 1;
  if (e.fails >= maxFails) {
    e.lockedUntil = t + lockMs;
    e.fails = 0;
    return { locked: true, remainingMs: lockMs, fails: maxFails };
  }
  return { locked: false, remainingMs: 0, fails: e.fails };
}

/** 登录成功：清零该用户名的计数与锁定。 */
function recordSuccess(name) {
  state.delete(String(name || ''));
}

/** 测试用：清空全部状态。 */
function _reset() { state.clear(); }

module.exports = { lockedRemainingMs, recordFailure, recordSuccess, _reset, MAX_FAILS, LOCK_MS };
