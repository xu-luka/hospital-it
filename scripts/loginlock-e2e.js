'use strict';
/**
 * 登录失败锁定 HTTP 冒烟自测
 *
 * 用法：node scripts/loginlock-e2e.js
 *
 * 起真实服务（临时巡检库、端口 4199、阈值调到 3 次），
 * 用一个确定不存在的用户名连续打 /login，验证：
 *   前 3 次 401 → 第 4 次开始 429（锁定期不校验密码）→ 响应带分钟提示。
 * 用不存在的用户名是故意的：loginlock 对不存在的用户名同样计数，
 * 既不需要真实账号，也顺带验证了「不泄露账号是否存在」这条设计。
 * 会在开发库 logs 表留几行登录失败日志，与真实用户操作无异，无需清理。
 */

const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
process.env.INSPECT_DB_FILE = path.join(os.tmpdir(), 'loginlock-e2e-' + Date.now() + '.db');
process.env.PORT = process.env.PORT || '4199';
process.env.LOGIN_LOCK_MAX = '3';
process.env.LOGIN_LOCK_MINUTES = '10';

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}

(async () => {
  require(path.join(ROOT, 'server'));
  const base = 'http://127.0.0.1:' + process.env.PORT;
  // 等服务起来
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/auth/login', { method: 'OPTIONS' }); break; }
    catch (e) { await new Promise(r => setTimeout(r, 200)); }
  }

  async function login(name, pwd) {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: name, password: pwd }),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json: json };
  }

  console.log('loginlock 登录锁定 HTTP 冒烟自测\n');
  const ghost = 'e2e-no-such-user-' + Date.now();

  console.log('== 连续失败达到阈值（LOGIN_LOCK_MAX=3） ==');
  for (let i = 1; i <= 3; i++) {
    const r = await login(ghost, 'wrong-password');
    ok('第 ' + i + ' 次失败返回 401', r.status === 401, String(r.status));
  }
  const r4 = await login(ghost, 'wrong-password');
  ok('第 4 次（锁定后）返回 429', r4.status === 429, String(r4.status));
  ok('429 提示含分钟数', !!(r4.json && /分钟/.test(r4.json.message || '')), r4.json && r4.json.message);

  console.log('\n== 锁定期不校验密码：即使密码「可能对」也 429 ==');
  const r5 = await login(ghost, 'maybe-right-password');
  ok('锁定期任意密码都 429', r5.status === 429, String(r5.status));

  console.log('\n== 其他用户名不受牵连 ==');
  const r6 = await login('e2e-another-' + Date.now(), 'wrong');
  ok('新用户名仍是 401 而非 429', r6.status === 401, String(r6.status));

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error('自测异常：', e); process.exit(1); });
