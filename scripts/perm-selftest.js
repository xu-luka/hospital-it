'use strict';
/**
 * perm 权限核心自测（离线，不启服务）
 *
 * 用法：node scripts/perm-selftest.js
 *
 * 会在开发库里临时建一个角色（code=__perm_selftest__）用于验证读写往返，
 * 跑完即删；不碰任何已有角色的权限配置。
 */
const path = require('path');
const ROOT = path.join(__dirname, '..');
const perm = require(path.join(ROOT, 'src', 'perm'));
const { db } = require(path.join(ROOT, 'src', 'db-contract'));

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + label + (extra === undefined ? '' : ' -> ' + extra)); }
  else { fail++; console.log('  [FAIL] ' + label + (extra === undefined ? '' : ' -> ' + extra)); }
}
function eq(label, a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
	ok(x === y, label, x === y ? x : ('期望 ' + y + '，实际 ' + x));
}

const TEST_CODE = '__perm_selftest__';
function cleanup() {
  try {
    const r = db.prepare('SELECT id FROM roles WHERE code = ?').get(TEST_CODE);
    if (r) {
      perm.removeRolePerms(r.id);
      db.prepare('DELETE FROM roles WHERE id = ?').run(r.id);
    }
  } catch (e) { /* ignore */ }
}

console.log('perm 权限核心自测\n');
cleanup();

console.log('== 模块清单与编码规范 ==');
ok(perm.MODULES.length >= 10, '模块数量', perm.MODULES.length);
const codes = perm.ALL_PERMS;
eq('编码无重复', codes.length, new Set(codes).size);
ok(codes.every((c) => /^[a-z][a-z0-9]*\.(view|create|manage)$/.test(c)), '全部编码符合 模块.动作 规范',
  codes.filter((c) => !/^[a-z][a-z0-9]*\.(view|create|manage)$/.test(c)).join(',') || '无例外');
ok(codes.indexOf('issues.create') >= 0, '工单有独立的「提交」档（报障人要用）');
ok(codes.indexOf('roles.manage') >= 0, '存在 角色权限.管理');
const mods = perm.describeModules();
ok(mods.every((m) => m.name && m.group && m.acts.length && m.acts.every((a) => a.label && a.code)),
  'describeModules 每项都有名称/分组/动作/中文标签');
eq('describeModules 展开的动作数与 ALL_PERMS 一致',
  mods.reduce((n, m) => n + m.acts.length, 0), codes.length);

console.log('\n== isKnownPerm ==');
ok(perm.isKnownPerm('contracts.view') === true, 'contracts.view 合法');
ok(perm.isKnownPerm('contracts.fly') === false, 'contracts.fly 非法');
ok(perm.isKnownPerm('contracts') === false, '缺少动作的编码非法');
ok(perm.isKnownPerm('') === false, '空串非法');
ok(perm.isKnownPerm('__proto__.view') === false, '原型链式编码非法');

console.log('\n== hasPerm：manage ⊃ create ⊃ view ==');
ok(perm.hasPerm(['*'], 'anything.view') === true, "'*' 全权：任意编码都通过");
ok(perm.hasPerm(['issues.manage'], 'issues.view') === true, 'manage 隐含 view');
ok(perm.hasPerm(['issues.manage'], 'issues.create') === true, 'manage 隐含 create');
ok(perm.hasPerm(['issues.create'], 'issues.view') === true, 'create 隐含 view');
ok(perm.hasPerm(['issues.create'], 'issues.manage') === false, 'create 不隐含 manage');
ok(perm.hasPerm(['issues.view'], 'issues.create') === false, 'view 不隐含 create');
ok(perm.hasPerm([], 'issues.view') === false, '空权限全部拒绝');
ok(perm.hasPerm(['contracts.manage'], 'issues.view') === false, '不跨模块串权');
ok(perm.hasPerm(['contracts.manage'], 'contracts.manage') === true, '自身命中');
ok(perm.hasPerm(['issues.manage'], undefined) === true, '空编码视为不需要权限');
ok(perm.hasPerm(null, 'issues.view') === false, 'null 权限集合不崩且拒绝');

console.log('\n== normalizePerms ==');
eq('去重并按固定顺序', perm.normalizePerms(['issues.view', 'dashboard.view', 'issues.view']),
  ['dashboard.view', 'issues.view']);
eq('过滤非法编码', perm.normalizePerms(['issues.view', 'bogus.perm', '', null]), ['issues.view']);
eq("含 '*' 时只保留 '*'", perm.normalizePerms(['issues.view', '*']), ['*']);
eq('非数组 → 空', perm.normalizePerms('issues.view'), []);
eq('全是非法 → 空', perm.normalizePerms([1, {}, 'x']), []);

console.log('\n== 内置默认矩阵 ==');
const eng = perm.DEFAULT_ROLE_PERMS.engineer;
const usr = perm.DEFAULT_ROLE_PERMS.user;
ok(eng.every(perm.isKnownPerm), '工程师默认值全部合法',
  eng.filter((c) => !perm.isKnownPerm(c)).join(',') || '无例外');
ok(usr.every(perm.isKnownPerm), '普通用户默认值全部合法');
ok(eng.every((c) => c.indexOf('users.') < 0 && c.indexOf('roles.') < 0 && c.indexOf('logs.') < 0),
  '工程师默认不含 用户管理/角色权限/操作日志');
eq('普通用户默认 = 工作台 + 工单', usr, ['dashboard.view', 'issues.view', 'issues.create']);
ok(eng.indexOf('devices.manage') < 0, '工程师默认不给设备台账写权限（保持改造前的行为）');
ok(eng.indexOf('inspection.manage') >= 0 && eng.indexOf('netflow.manage') >= 0,
  '工程师默认能触发巡检、能管流量（保持改造前能力）');
ok(perm.DEFAULT_ROLE_PERMS.admin.indexOf('*') >= 0, "管理员默认 '*'");
// 老问题库内置的是「审批人」（code=approver），合同库统一账号后两套命名都可能出现；
// 少写一个，那批角色升级后就是零权限、菜单空白
ok(!!perm.DEFAULT_ROLE_PERMS.approver, '兼容 approver（审批人）命名的内置角色');
eq('approver 默认与 engineer 一致',
  perm.DEFAULT_ROLE_PERMS.approver.length, perm.DEFAULT_ROLE_PERMS.engineer.length);

console.log('\n== 角色权限读写往返（临时角色） ==');
const ins = db.prepare('INSERT INTO roles (code, name) VALUES (?, ?)').run(TEST_CODE, '自测临时角色');
const rid = Number(ins.lastInsertRowid);
try {
  eq('新角色无权限时读到空', perm.getRolePerms(rid, TEST_CODE).perms, []);
  eq('新角色 source=empty', perm.getRolePerms(rid, TEST_CODE).source, 'empty');

  const w = perm.setRolePerms(rid, TEST_CODE, ['contracts.view', 'bogus.x', 'contracts.view']);
  ok(w.ok, '写入成功');
  eq('写入后过滤+去重', w.perms, ['contracts.view']);
  eq('读回一致', perm.getRolePerms(rid, TEST_CODE).perms, ['contracts.view']);
  eq('source=db', perm.getRolePerms(rid, TEST_CODE).source, 'db');

  perm.setRolePerms(rid, TEST_CODE, ['issues.view', 'issues.create']);
  eq('覆盖写不留旧值', perm.getRolePerms(rid, TEST_CODE).perms, ['issues.view', 'issues.create']);

  perm.setRolePerms(rid, TEST_CODE, []);
  eq('清空后为空数组', perm.getRolePerms(rid, TEST_CODE).perms, []);
  eq('清空后 source=db（不再退回默认）', perm.getRolePerms(rid, TEST_CODE).source, 'db');
  eq('清空留了标记行（区别于"从没配过"）', perm.getAllRolePerms()[String(rid)], []);

  perm.setRolePerms(rid, TEST_CODE, ['issues.manage']);
  const all = perm.getAllRolePerms();
  eq('getAllRolePerms 含该角色', all[String(rid)], ['issues.manage']);

  perm.removeRolePerms(rid);
  eq('删除权限行后回到 empty', perm.getAllRolePerms()[String(rid)], undefined);
} finally {
  perm.removeRolePerms(rid);
  db.prepare('DELETE FROM roles WHERE id = ?').run(rid);
}
eq('临时角色已清理', db.prepare('SELECT id FROM roles WHERE code = ?').get(TEST_CODE), undefined);

console.log('\n== 内置管理员的写法保护（锁不死） ==');
const adminRole = db.prepare("SELECT * FROM roles WHERE code = 'admin'").get();
ok(!!adminRole, '存在内置管理员角色');
{
  const before = perm.getRolePerms(adminRole.id, 'admin').perms.slice();
  const r = perm.setRolePerms(adminRole.id, 'admin', []);
  ok(r.forced === true, '尝试清空管理员权限被强制改写');
  eq("落库后仍是 '*'", perm.getRolePerms(adminRole.id, 'admin').perms, ['*']);
  eq('原始配置未被破坏', before.indexOf('*') >= 0 ? ['*'] : before, ['*']);
}

console.log('\n== 读取失败时的降级（不能让所有人变 403） ==');
{
  const fake = perm.getRolePerms(999999, 'engineer');
  eq('不存在的角色 id + 已知 code → 退回内置默认', fake.perms.length, perm.DEFAULT_ROLE_PERMS.engineer.length);
  eq('source=default', fake.source, 'default');
  const unknown = perm.getRolePerms(999999, 'no_such_code');
  eq('未知 code 且无配置 → 空（不给任何权限）', unknown.perms, []);
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
cleanup();
process.exit(fail ? 1 : 0);
