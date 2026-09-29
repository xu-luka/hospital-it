'use strict';
/**
 * 启动降级自测：依赖模块「版本偏旧」时，巡检不应整个挂掉
 *
 * 用法：
 *   node scripts/startup-degrade-selftest.js
 *
 * 为什么需要它（真实事故）：
 *   更新包只替换了 server.js，没替换它依赖的 src/inspection/lib/secret.js，
 *   而服务器上那份是旧版、没有 ensureKeyFileAsync。结果 mountInspection 里
 *   那句「全新部署自愈」抛出 TypeError，被最外层 catch 当成
 *   「巡检模块装载失败」—— 巡检 + 流量监控整个不可用，只因为少了一条提示。
 *
 *   这类缺陷的共性：**可选功能抛错，把核心功能拖下水**。
 *   本脚本用 require.cache 注入一个「缺函数的旧版 secret 模块」来复现，
 *   断言巡检依然挂载成功、接口依然可用。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), 'degrade-selftest-' + Date.now() + '.db');
process.env.INSPECT_DB_FILE = TMP_DB;
process.env.PORT = process.env.PORT || '3998';

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}
function eq(tag, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log('  [OK]   ' + tag + ' = ' + JSON.stringify(a)); }
  else { fails.push(tag + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); console.log('  [FAIL] ' + tag + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }
}

(async () => {
  // 拦截启动日志，用于断言「降级提示确实打了出来」
  const logs = [];
  const origWarn = console.warn;
  const origError = console.error;
  const origLog = console.log;
  function grab(sink) {
    return function () {
      const line = Array.prototype.map.call(arguments, (a) => String(a)).join(' ');
      logs.push(line);
      return sink.apply(console, arguments);
    };
  }

  /* ---------- 注入「旧版 secret 模块」：有 keyFilePath，没有 ensureKeyFileAsync ---------- */
  const secretPath = require.resolve(path.join(ROOT, 'src', 'inspection', 'lib', 'secret'));
  const legacySecret = {
    // 旧版常见的导出集合：能取密钥，但还没有「首次自动生成本机密钥」这个能力
    hasKeyFile: () => false,
    keyFilePath: () => path.join(ROOT, 'secrets', 'master.key'),
    keyVaultPath: () => path.join(ROOT, 'secrets', 'KeyVault.exe'),
    fingerprint: () => '',
    loadMasterKeyAsync: async () => ({ ok: false, error: 'stub: 旧版模块' }),
    decryptValue: (v) => v,
    encryptValue: (v) => v,
    decryptServer: (s) => s,
    decryptConfig: async (c) => c,
    redactConfig: (c) => c,
    auditConfig: () => ({ ok: true, rows: [], missing: [] }),
    resetCache: () => { }
  };
  require.cache[secretPath] = {
    id: secretPath, filename: secretPath, loaded: true,
    exports: legacySecret, children: [], paths: []
  };
  ok('已注入缺少 ensureKeyFileAsync 的旧版 secret 模块',
    typeof require(secretPath).ensureKeyFileAsync === 'undefined');

  console.warn = grab(origWarn);
  console.error = grab(origError);
  console.log = grab(origLog);

  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  require(path.join(ROOT, 'server'));
  getSecret();
  const token = signJwt({ id: 1, username: 'e2e', role_id: 1 }, 3600);
  const base = 'http://127.0.0.1:' + process.env.PORT;

  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/inspection/netflow/status'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  console.warn = origWarn;
  console.error = origError;
  console.log = origLog;

  async function call(method, url, body) {
    const opt = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opt);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json: json };
  }

  console.log('\n== 核心判据：巡检模块不该被拖垮 ==');
  const mounted = !logs.some((l) => l.indexOf('巡检模块装载失败') >= 0);
  ok('启动日志里没有「巡检模块装载失败」', mounted,
    mounted ? '' : logs.filter((l) => l.indexOf('巡检模块装载失败') >= 0)[0]);

  // 路由没挂载的话，/api/inspection/status 会 404（catch-all 只兜非 api 路径）
  const st = await call('GET', '/api/inspection/status');
  eq('巡检状态接口可用（路由已挂载）', st.status, 200);
  ok('返回体是巡检状态', !!(st.json && st.json.data && 'interval' in (st.json.data || {})),
    st.json && st.json.code === 0 ? 'code=0' : JSON.stringify(st.json).slice(0, 120));

  console.log('\n== 降级提示确实打了出来（便于下次定位）==');
  const warned = logs.some((l) => l.indexOf('密钥模块版本不匹配') >= 0);
  ok('日志提示缺少 ensureKeyFileAsync', warned,
    warned ? logs.filter((l) => l.indexOf('版本不匹配') >= 0)[0].slice(0, 160) : '未找到');

  console.log('\n== 新增的流量监控也不该被连累 ==');
  const nf = await call('GET', '/api/inspection/netflow/status');
  eq('流量监控状态接口可用', nf.status, 200);
  const nfd = await call('GET', '/api/inspection/netflow/devices');
  eq('交换机列表接口可用', nfd.json && nfd.json.code, 0);

  console.log('\n== 其它巡检接口仍然正常 ==');
  const dv = await call('GET', '/api/inspection/devices');
  ok('设备台账接口可用', dv.status === 200, 'status=' + dv.status);

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  try { fs.unlinkSync(TMP_DB); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(TMP_DB + '-wal'); } catch (e) { /* 忽略 */ }
  try { fs.unlinkSync(TMP_DB + '-shm'); } catch (e) { /* 忽略 */ }
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('自测异常：', e);
  process.exit(1);
});
