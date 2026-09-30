'use strict';
/**
 * loginlock 登录失败锁定自测（纯内存模块，不碰数据库、不起服务）
 * 用法：node scripts/loginlock-selftest.js
 */
const lock = require('../src/loginlock');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [OK]  ', label, extra === undefined ? '' : '->', extra); }
  else { fail++; console.log('  [FAIL]', label, extra === undefined ? '' : '->', extra); }
}

const T0 = 1700000000000; // 固定时间基准，全程注入 now，不靠 sleep
const OPTS = { maxFails: 3, lockMs: 10000 }; // 测试用小窗口：3 次锁 10 秒

console.log('loginlock 登录失败锁定自测\n');

console.log('== 默认值与初始状态 ==');
ok(lock.MAX_FAILS === 5, '默认阈值 5 次', lock.MAX_FAILS);
ok(lock.LOCK_MS === 600000, '默认锁定 10 分钟', lock.LOCK_MS);
lock._reset();
ok(lock.lockedRemainingMs('alice', T0) === 0, '初始未锁定');

console.log('\n== 未达阈值：只计数不锁定 ==');
let r = lock.recordFailure('alice', T0, OPTS);
ok(r.locked === false && r.fails === 1, '第 1 次失败', JSON.stringify(r));
r = lock.recordFailure('alice', T0 + 1000, OPTS);
ok(r.locked === false && r.fails === 2, '第 2 次失败', JSON.stringify(r));
ok(lock.lockedRemainingMs('alice', T0 + 1000) === 0, '此时仍未锁定');

console.log('\n== 达到阈值：第 3 次失败触发锁定 ==');
r = lock.recordFailure('alice', T0 + 2000, OPTS);
ok(r.locked === true, '第 3 次失败返回 locked=true');
ok(r.remainingMs === 10000, '锁定时长 10 秒', r.remainingMs);
const rem = lock.lockedRemainingMs('alice', T0 + 3000);
ok(rem > 8000 && rem <= 10000, '锁定中查询剩余时间', rem);

console.log('\n== 锁定期间：继续失败不延长、不重复触发 ==');
r = lock.recordFailure('alice', T0 + 5000, OPTS);
ok(r.locked === false, '锁定期间的失败不返回 locked=true（不重复记日志）');
ok(r.remainingMs > 0 && r.remainingMs <= 10000, '但仍在锁定中', r.remainingMs);
ok(lock.lockedRemainingMs('alice', T0 + 11999) > 0, '到期前 1ms 仍锁定');
ok(lock.lockedRemainingMs('alice', T0 + 12001) === 0, '到期后自动解锁（计数同时清零）');

console.log('\n== 登录成功清零 ==');
lock._reset();
lock.recordFailure('bob', T0, OPTS);
lock.recordFailure('bob', T0, OPTS);
lock.recordSuccess('bob');
ok(lock.lockedRemainingMs('bob', T0) === 0, '成功后无锁定');
r = lock.recordFailure('bob', T0, OPTS);
ok(r.fails === 1 && r.locked === false, '成功后计数从头开始', JSON.stringify(r));

console.log('\n== 用户名互相独立 / 边界 ==');
lock._reset();
lock.recordFailure('carol', T0, OPTS);
ok(lock.lockedRemainingMs('dave', T0) === 0, 'carol 的失败不影响 dave');
ok(lock.lockedRemainingMs('', T0) === 0, '空用户名不报错');
r = lock.recordFailure('', T0, OPTS);
ok(r.fails === 1, '空用户名也能计数（不崩）');

console.log('\n== 锁定到期后重新累计 ==');
lock._reset();
for (let i = 0; i < 3; i++) lock.recordFailure('eve', T0, OPTS);
ok(lock.lockedRemainingMs('eve', T0 + 1) > 0, 'eve 已锁定');
ok(lock.lockedRemainingMs('eve', T0 + 10001) === 0, '到期解锁');
r = lock.recordFailure('eve', T0 + 10002, OPTS);
ok(r.locked === false && r.fails === 1, '解锁后失败重新从 1 计', JSON.stringify(r));

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail ? 1 : 0);
