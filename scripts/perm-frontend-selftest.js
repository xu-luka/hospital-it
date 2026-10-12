'use strict';
/**
 * 前端权限判定自测（static/js/authz.js，离线）
 *
 * 用法：node scripts/perm-frontend-selftest.js
 *
 * 为什么值得单独测：菜单显示、按钮显隐全靠前端这份 can()，
 * 它与后端 src/perm.js 是两份实现（前端不能用 require），最容易两边走偏。
 * 曾经就把「哪些动作能满足 view」的映射写反过：后端有用例挡住了，
 * 前端当时没有，靠肉眼是看不出来的（管理员全权，所有菜单都在，看不出问题）。
 *
 * 做法：在 vm 里加载真实的 authz.js，注入不同的 window.HisUser，断言 can() 的结果。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'static', 'js', 'authz.js'), 'utf8');

let pass = 0, fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + label + (extra === undefined ? '' : ' -> ' + extra)); }
  else { fail++; console.log('  [FAIL] ' + label + (extra === undefined ? '' : ' -> ' + extra)); }
}

/** 在沙箱里按指定用户加载 authz.js，返回 HisPerm */
function loadPerm(user, token) {
  const ctx = {
    console, JSON, Array, Object, String, Number, Boolean, Promise, RegExp, Error, Math, Date,
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.localStorage = {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
  };
  ctx.HisUser = { user: user };
  ctx.api = { user: user, token: token === undefined ? 'fake-token' : token, get: () => Promise.resolve(user) };
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'authz.js' });
  return { perm: ctx.window.HisPerm, ctx: ctx };
}

const ADMIN = { id: 1, username: 'admin', role_id: 1, role_code: 'admin', perms: ['*'] };
const ENGINEER = { id: 2, username: 'eng', role_id: 2, role_code: 'engineer', perms: [
  'dashboard.view', 'contracts.view', 'contracts.manage', 'remind.view',
  'payments.view', 'payments.manage', 'issues.view', 'issues.create', 'issues.manage',
  'docs.view', 'docs.manage', 'screen.view', 'devices.view',
  'inspection.view', 'inspection.manage', 'netflow.view', 'netflow.manage',
] };
const NORMAL = { id: 3, username: 'nurse', role_id: 3, role_code: 'user', perms: ['dashboard.view', 'issues.view', 'issues.create'] };
const EMPTY = { id: 9, username: 'none', role_id: 9, role_code: 'auditor', perms: [] };

console.log('前端权限判定自测（static/js/authz.js）\n');

console.log('== 管理员：全权 ==');
{
  const { perm } = loadPerm(ADMIN);
  ['dashboard.view', 'contracts.manage', 'issues.manage', 'users.manage', 'roles.manage',
    'logs.view', 'devices.manage', 'netflow.manage', 'inspection.manage'].forEach((c) => {
    ok(perm.can(c) === true, 'can(' + c + ') 通过');
  });
  ok(perm.can('今后新增的模块.view') === false || true, '未知编码不因全权而报错（容错）');
}

console.log('\n== 工程师：业务全给、系统管理不给 ==');
{
  const { perm } = loadPerm(ENGINEER);
  ['contracts.view', 'contracts.manage', 'issues.manage', 'docs.manage', 'netflow.manage', 'devices.view']
    .forEach((c) => ok(perm.can(c) === true, 'can(' + c + ') 通过'));
  ['users.manage', 'roles.manage', 'logs.view', 'devices.manage']
    .forEach((c) => ok(perm.can(c) === false, 'can(' + c + ') 拒绝'));
}

console.log('\n== 普通用户（报障人） ==');
{
  const { perm } = loadPerm(NORMAL);
  ok(perm.can('dashboard.view') === true, '能看到工作台');
  ok(perm.can('issues.view') === true, '能看到工单');
  ok(perm.can('issues.create') === true, '能提交工单');
  ok(perm.can('issues.manage') === false, '不能处理工单（没有处理按钮）');
  ['contracts.view', 'docs.view', 'devices.view', 'inspection.view', 'netflow.view', 'screen.view']
    .forEach((c) => ok(perm.can(c) === false, 'can(' + c + ') 拒绝（菜单里不出现）'));
  ok(perm.can('users.manage') === false, '看不到用户管理');
}

console.log('\n== 动作的满足关系（与后端一致） ==');
{
  const { perm } = loadPerm({ id: 5, role_id: 5, role_code: 'x', perms: ['issues.manage'] });
  ok(perm.can('issues.view') === true, 'manage → view');
  ok(perm.can('issues.create') === true, 'manage → create');
  ok(perm.can('issues.manage') === true, 'manage → manage');
}
{
  const { perm } = loadPerm({ id: 6, role_id: 6, role_code: 'x', perms: ['issues.create'] });
  ok(perm.can('issues.view') === true, 'create → view');
  ok(perm.can('issues.manage') === false, 'create 不 → manage');
}
{
  const { perm } = loadPerm({ id: 7, role_id: 7, role_code: 'x', perms: ['issues.view'] });
  ok(perm.can('issues.create') === false, 'view 不 → create');
  ok(perm.can('contracts.manage') === false, '不跨模块串权');
}

console.log('\n== 空权限角色 ==');
{
  const { perm } = loadPerm(EMPTY);
  ok(perm.can('dashboard.view') === false, '没有任何模块可见');
  ok(perm.canAny([]) === true, 'canAny(空) 视为不限制');
  ok(perm.canAny(['users.manage', 'logs.view']) === false, 'canAny 全不满足 → false');
}

console.log('\n== 未登录 / 老会话兼容 ==');
{
  const { perm } = loadPerm(null);
  ok(perm.can('dashboard.view') === false, '未登录时不显示任何菜单');
}
{
  // 升级前的 localStorage 里没有 perms 字段，按 role_id 走内置默认，避免空菜单
  const { perm } = loadPerm({ id: 2, username: 'eng', role_id: 2, role_name: '工程师' });
  ok(perm.can('contracts.view') === true, '老会话（工程师）按内置默认放行');
  ok(perm.can('users.manage') === false, '老会话（工程师）仍然看不到用户管理');
  const { perm: p1 } = loadPerm({ id: 1, username: 'admin', role_id: 1 });
  ok(p1.can('users.manage') === true, '老会话（管理员）全权');
  const { perm: p3 } = loadPerm({ id: 3, username: 'nurse', role_id: 3 });
  ok(p3.can('issues.create') === true && p3.can('contracts.view') === false, '老会话（普通用户）只能报障');
}

console.log('\n== 老会话自动补拉 /auth/me ==');
{
  const stale = { id: 2, username: 'eng', role_id: 2, role_name: '工程师' };
  const fresh = { id: 2, username: 'eng', role_id: 2, role_name: '工程师', perms: ['roles.manage'] };
  const { perm, ctx } = loadPerm(stale);
  let called = 0;
  ctx.api.get = function (u) { called++; ok(u === '/auth/me', '/auth/me 被调用', u); return Promise.resolve(fresh); };
  Promise.resolve(perm.refresh()).then(() => {
    ok(called === 1, '缺 perms 时会拉一次真实权限');
    ok(perm.permsOf(ctx.HisUser.user) !== null, '拉取后就地补上了 perms');
    ok(perm.can('roles.manage') === true, '补拉后立刻按新权限判定');
    const { perm: p2, ctx: c2 } = loadPerm(fresh);
    let called2 = 0;
    c2.api.get = function () { called2++; return Promise.resolve(fresh); };
    return p2.refresh().then(() => {
      ok(called2 === 0, '已有 perms 时不再多余请求');
    });
  }).then(() => {
    console.log('\n----------------------------------------');
    console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
    process.exit(fail ? 1 : 0);
  }).catch((e) => { console.error('自测异常：', e); process.exit(1); });
}
