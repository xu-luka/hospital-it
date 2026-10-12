'use strict';
/**
 * 角色权限 HTTP 端到端自测
 *
 * 用法：node scripts/perm-api-e2e.js
 *
 * 起真实服务（临时巡检库、端口 4299），然后：
 *   1) 建一个临时角色（只给「合同台账.查看」）与一个属于它的临时用户；
 *   2) 用真实登录接口拿该用户的 token，逐个打接口 ——
 *      有权限的必须 200，没权限的必须 403（而不是"菜单藏了但接口能调"）；
 *   3) 给角色补上「合同台账.管理」，不重新登录，验证写接口立刻从 403 变 400（参数校验）；
 *   4) 验证管理员不会被锁死：内置角色删不掉、有用户的角色删不掉、
 *      管理员权限无法被清空、不能删自己。
 *
 * 所有临时数据（角色 + 用户）跑完即删，不动任何既有账号与权限。
 */
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
process.env.INSPECT_DB_FILE = path.join(os.tmpdir(), 'perm-e2e-' + Date.now() + '.db');
process.env.PORT = process.env.PORT || '4299';

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra !== undefined && extra !== '' ? ' -> ' + extra : '')); }
  else { fails.push(tag + ' -> ' + extra); console.log('  [FAIL] ' + tag + (extra !== undefined ? ' -> ' + extra : '')); }
}
function skip(tag, why) { console.log('  [SKIP] ' + tag + '（' + why + '）'); }

const ROLE_CODE = 'perm_e2e_role';   // 注意：角色标识必须字母开头，不能用下划线开头
const ROLE_NAME = '自测只读角色';
const USERNAME = '__perm_e2e_user__';
const PASSWORD = 'E2e#Test12345';

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const { db } = require(path.join(ROOT, 'src', 'db-contract'));
  const perm = require(path.join(ROOT, 'src', 'perm'));
  require(path.join(ROOT, 'server'));
  getSecret();

  const base = 'http://127.0.0.1:' + process.env.PORT;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/roles', { method: 'OPTIONS' }); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  async function call(method, url, body, token) {
    const opt = { method: method, headers: {} };
    if (token) opt.headers['Authorization'] = 'Bearer ' + token;
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opt);
    let json = null;
    try { json = await res.json(); } catch (e) { /* ignore */ }
    return { status: res.status, json: json };
  }

  // ---- 管理员身份：直接签一个 id=管理员 的 token（authRequired 会回查库，取真实角色）----
  const adminRow = db.prepare(
    "SELECT u.id, u.username, COUNT(*) OVER () AS n FROM users u JOIN roles r ON u.role_id = r.id WHERE r.code = 'admin' AND u.is_active = 1 ORDER BY u.id LIMIT 1"
  ).get();
  if (!adminRow) { console.error('开发库里没有启用的管理员账号，无法自测'); process.exit(1); }
  const adminId = Number(adminRow.id);
  const adminActiveCount = db.prepare(
    "SELECT COUNT(*) c FROM users u JOIN roles r ON u.role_id = r.id WHERE r.code = 'admin' AND u.is_active = 1"
  ).get().c;
  const adminToken = signJwt({ id: adminId, username: adminRow.username, roleId: 1 });
  const adminRoleId = Number(db.prepare("SELECT id FROM roles WHERE code = 'admin'").get().id);

  console.log('perm 角色权限 HTTP 端到端自测');
  console.log('（开发库当前启用管理员 ' + adminActiveCount + ' 个，id=' + adminId + '）\n');

  let roleId = 0, userId = 0;
  // 清理必须「按 id + 按标识 + 按名字」三重兜底：中途失败时 id 可能还没拿到，
  // 只按标识清会漏掉自动生成 code 的角色，给开发库留孤儿数据
  const cleanup = () => {
    try { if (userId) db.prepare('DELETE FROM users WHERE id = ?').run(userId); } catch (e) { /* ignore */ }
    try { db.prepare('DELETE FROM users WHERE username = ?').run(USERNAME); } catch (e) { /* ignore */ }
    try { db.prepare('DELETE FROM users WHERE username = ?').run(USERNAME + '_x'); } catch (e) { /* ignore */ }
    const junk = [];
    try { junk.push(...db.prepare('SELECT id FROM roles WHERE code = ? OR name = ?').all(ROLE_CODE, ROLE_NAME)); } catch (e) { /* ignore */ }
    junk.forEach((r) => {
      try { perm.removeRolePerms(r.id); db.prepare('DELETE FROM roles WHERE id = ?').run(r.id); } catch (e) { /* ignore */ }
    });
  };
  cleanup();

  try {
    console.log('== 角色权限管理接口（管理员） ==');
    const metaRes = await call('GET', '/api/roles/meta', undefined, adminToken);
    ok('GET /api/roles/meta 返回模块清单', metaRes.status === 200 && metaRes.json.data.modules.length >= 10,
      metaRes.json && metaRes.json.data ? metaRes.json.data.modules.length + ' 个模块' : metaRes.status);

    const newRole = await call('POST', '/api/roles', { name: ROLE_NAME, code: ROLE_CODE }, adminToken);
    ok('新建角色成功', newRole.status === 200 && newRole.json.data.id > 0, newRole.json && newRole.json.message);
    roleId = newRole.json && newRole.json.data ? Number(newRole.json.data.id) : 0;

    const badCode = await call('POST', '/api/roles', { name: '自测非法标识', code: '__bad__' }, adminToken);
    ok('非法角色标识被拒绝', badCode.status === 400, badCode.json && badCode.json.message);

    const dupName = await call('POST', '/api/roles', { name: ROLE_NAME }, adminToken);
    ok('同名角色被拒绝', dupName.status === 400, dupName.json && dupName.json.message);

    const badName = await call('POST', '/api/roles', { name: 'x' }, adminToken);
    ok('名称过短被拒绝', badName.status === 400, badName.json && badName.json.message);

    const setPerms = await call('PUT', '/api/roles/' + roleId + '/perms', { perms: ['contracts.view', 'bogus.perm'] }, adminToken);
    ok('保存角色权限（非法编码被丢弃）', setPerms.status === 200 && setPerms.json.data.perms.length === 1,
      JSON.stringify(setPerms.json && setPerms.json.data));
    const badPerms = await call('PUT', '/api/roles/' + roleId + '/perms', { perms: 'contracts.view' }, adminToken);
    ok('perms 非数组被拒绝', badPerms.status === 400, badPerms.json && badPerms.json.message);

    console.log('\n== 建一个属于该角色的用户并用它真实登录 ==');
    const newUser = await call('POST', '/api/users', {
      username: USERNAME, password: PASSWORD, realName: '自测只读用户', roleId: roleId,
    }, adminToken);
    ok('新建用户指向自定义角色成功（角色校验已改为查表）', newUser.status === 200, newUser.json && newUser.json.message);
    userId = (() => { try { const r = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME); return r ? Number(r.id) : 0; } catch (e) { return 0; } })();

    const bogusRole = await call('POST', '/api/users', { username: USERNAME + '_x', password: PASSWORD, roleId: 999999 }, adminToken);
    ok('不存在的角色 id 被拒绝', bogusRole.status === 400, bogusRole.json && bogusRole.json.message);

    const login = await call('POST', '/api/auth/login', { username: USERNAME, password: PASSWORD });
    ok('该用户能正常登录', login.status === 200, login.status);
    const token = login.json && login.json.data ? login.json.data.token : '';
    const loginPerms = (login.json && login.json.data && login.json.data.user.perms) || [];
    ok('登录响应带回权限清单', loginPerms.indexOf('contracts.view') >= 0, JSON.stringify(loginPerms));
    ok('登录响应含自定义角色名', login.json.data.user.role_name === ROLE_NAME, login.json.data.user.role_name);

    console.log('\n== 该用户（只有 合同台账.查看）的访问边界 ==');
    ok('GET /api/contracts → 200（有查看权限）', (await call('GET', '/api/contracts', undefined, token)).status === 200);
    ok('POST /api/contracts → 403（没有管理权限）', (await call('POST', '/api/contracts', {}, token)).status === 403);
    ok('DELETE /api/contracts/1 → 403', (await call('DELETE', '/api/contracts/1', undefined, token)).status === 403);
    ok('GET /api/issues → 403（未分配工单模块）', (await call('GET', '/api/issues', undefined, token)).status === 403);
    ok('GET /api/docs → 403', (await call('GET', '/api/docs?page=1', undefined, token)).status === 403);
    ok('GET /api/users → 403', (await call('GET', '/api/users', undefined, token)).status === 403);
    ok('GET /api/roles → 403', (await call('GET', '/api/roles', undefined, token)).status === 403);
    ok('GET /api/logs → 403', (await call('GET', '/api/logs?page=1', undefined, token)).status === 403);
    ok('GET /api/dashboard/contracts → 403（没给工作台权限）', (await call('GET', '/api/dashboard/contracts', undefined, token)).status === 403);

    console.log('\n== 授权后立刻生效（不需要重新登录） ==');
    await call('PUT', '/api/roles/' + roleId + '/perms', { perms: ['contracts.view', 'contracts.manage'] }, adminToken);
    const meAfter = await call('GET', '/api/auth/me', undefined, token);
    ok('/auth/me 立刻反映新权限', meAfter.status === 200 && (meAfter.json.data.perms || []).indexOf('contracts.manage') >= 0,
      JSON.stringify(meAfter.json && meAfter.json.data && meAfter.json.data.perms));
    const postAfter = await call('POST', '/api/contracts', {}, token);
    ok('写接口从 403 变为 400（通过权限关，卡在参数校验）', postAfter.status === 400, postAfter.status);

    console.log('\n== 管理权限的回收同样立刻生效 ==');
    await call('PUT', '/api/roles/' + roleId + '/perms', { perms: ['contracts.view'] }, adminToken);
    ok('回收后写接口重新变 403', (await call('POST', '/api/contracts', {}, token)).status === 403);

    console.log('\n== 内置管理员的保护（锁不死） ==');
    const delBuiltin = await call('DELETE', '/api/roles/' + adminRoleId, undefined, adminToken);
    ok('内置管理员角色不能删除', delBuiltin.status === 400, delBuiltin.json && delBuiltin.json.message);

    const forceAdmin = await call('PUT', '/api/roles/' + adminRoleId + '/perms', { perms: [] }, adminToken);
    ok('清空管理员权限被强制改写', forceAdmin.status === 200 && forceAdmin.json.data.forced === true,
      forceAdmin.json && forceAdmin.json.message);
    const afterForce = await call('GET', '/api/roles', undefined, adminToken);
    const adminRow2 = (afterForce.json.data || []).filter((r) => r.id === adminRoleId)[0];
    ok('管理员权限仍为全部', !!adminRow2 && adminRow2.locked === true && adminRow2.permCount === perm.ALL_PERMS.length,
      adminRow2 ? 'permCount=' + adminRow2.permCount : '未取到');

    const delSelf = await call('DELETE', '/api/users/' + adminId, undefined, adminToken);
    ok('不能删除当前登录账号', delSelf.status === 400, delSelf.json && delSelf.json.message);

    if (adminActiveCount === 1) {
      const demoteLast = await call('PUT', '/api/users/' + adminId, { role_id: roleId }, adminToken);
      ok('最后一个启用的管理员不能被降级', demoteLast.status === 400, demoteLast.json && demoteLast.json.message);
    } else {
      skip('最后一个启用管理员不能被降级', '开发库里有 ' + adminActiveCount + ' 个启用管理员，改了会破坏数据');
    }

    console.log('\n== 角色删除的保护与级联 ==');
    const delInUse = await call('DELETE', '/api/roles/' + roleId, undefined, adminToken);
    ok('仍被用户使用的角色不能删除', delInUse.status === 400, delInUse.json && delInUse.json.message);

    const delUser = await call('DELETE', '/api/users/' + userId, undefined, adminToken);
    ok('删除临时用户成功', delUser.status === 200, delUser.json && delUser.json.message);
    userId = 0;

    const delRole = await call('DELETE', '/api/roles/' + roleId, undefined, adminToken);
    ok('无用户占用的自定义角色可删除', delRole.status === 200, delRole.json && delRole.json.message);
    const leftPerms = db.prepare('SELECT COUNT(*) c FROM role_permissions WHERE role_id = ?').get(roleId).c;
    ok('删除角色时级联清理了权限行', leftPerms === 0, leftPerms);
    roleId = 0;

    console.log('\n== 管理员自身仍然畅通（没有被自己的权限系统挡住） ==');
    for (const [m, u] of [['GET', '/api/contracts'], ['GET', '/api/issues'], ['GET', '/api/users'],
      ['GET', '/api/roles'], ['GET', '/api/logs?page=1'], ['GET', '/api/dashboard/contracts'],
      ['GET', '/api/dashboard/issues'], ['GET', '/api/docs?page=1'], ['GET', '/api/inspection/status'],
      ['GET', '/api/inspection/netflow/status']]) {
      const r = await call(m, u, undefined, adminToken);
      ok('管理员 ' + m + ' ' + u + ' → 200', r.status === 200, r.status);
    }
  } finally {
    cleanup();
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  [FAIL] ' + f));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('自测异常：', e); process.exit(1); });
