'use strict';
/**
 * perm.js —— 角色权限核心
 *
 * 权限模型（刻意做得很朴素，够用且能一眼看懂）：
 *   权限编码 = 模块.动作，例如 contracts.view / contracts.manage
 *   角色是权限的载体，用户挂角色（users.role_id）→ 查 role_permissions 得到权限集合。
 *
 * 设计要点：
 * 1) **manage 隐含 view/create**：能处理的人当然能看、能提交，不然每次都得勾两下。
 * 2) **内置 admin 角色永久全权**（权限值 '*'）：任何接口、任何配置都不能把管理员
 *    的权限清空 —— 否则一次误操作就能让系统再也没人能进「角色权限」页面，只能改库救火。
 * 3) **读权限失败时降级为「内置默认值」而不是「无权限」**：数据库异常不该让所有人
 *    都变成 403（那是把可用性问题升级成故障）。
 * 4) 模块清单是唯一事实来源，前端菜单 / 权限矩阵 / 默认矩阵都从这里派生，
 *    新增模块只需在这里加一行。
 */

const { db } = require('./db-contract');

/**
 * 权限表由本模块自己建，而不是写进 src/db-contract.js。
 *
 * 原因很实际：db-contract.js 是「带 schema 的模块」，按本项目的交付约定不进更新包
 * （服务器上可能还有别的列差异，替换它风险高）。把建表放在 perm.js 里，
 * 这个功能就自带存储、只需替换自己这一批文件就能上线：
 * 老库上第一次启动时 CREATE TABLE IF NOT EXISTS 自动补建，不动任何既有表结构。
 */
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id INTEGER NOT NULL,
      perm TEXT NOT NULL,
      PRIMARY KEY (role_id, perm)
    );
  `);
} catch (e) {
  console.warn('[perm] 创建 role_permissions 表失败：' + ((e && e.message) || e));
}

// 动作中文名（矩阵表头用）；个别模块可在 MODULES 里用 actLabels 覆盖
const ACT_LABELS = { view: '查看', create: '提交', manage: '管理' };

/**
 * 模块清单（顺序即页面展示顺序）。
 * acts 里的动作决定该模块在权限矩阵里有几个勾。
 */
const MODULES = [
  { code: 'dashboard', name: '工作台', group: '概览', acts: ['view'] },
  { code: 'contracts', name: '合同台账', group: '合同管理', acts: ['view', 'manage'] },
  { code: 'remind', name: '到期提醒', group: '合同管理', acts: ['view'] },
  { code: 'payments', name: '收付款', group: '合同管理', acts: ['view', 'manage'] },
  // 问题工单天然有「报障人 / 处理人」两种身份，所以多一档「提交」：
  // 普通用户要能提交工单，但不该能动别人的工单状态
  { code: 'issues', name: '问题工单', group: '系统问题管理', acts: ['view', 'create', 'manage'], actLabels: { manage: '处理' } },
  { code: 'docs', name: '技术文档库', group: '技术文档库', acts: ['view', 'manage'] },
  // 网页书签：密码单独一档「看密码」。
  // 刻意不让 manage 隐含它 —— 能改书签的人不一定该看到口令，
  // 否则「按角色授予是否可查看密码」这个需求根本落不了地（勾了管理就等于勾了看密码）。
  { code: 'bookmarks', name: '网页书签', group: '资源管理', acts: ['view', 'manage', 'secret'], actLabels: { secret: '看密码' } },
  { code: 'ipam', name: 'IP 管理', group: '资源管理', acts: ['view', 'manage'] },
  { code: 'screen', name: '监控大屏', group: '机房巡检', acts: ['view'] },
  { code: 'devices', name: '设备台账', group: '机房巡检', acts: ['view', 'manage'] },
  { code: 'inspection', name: '巡检报告', group: '机房巡检', acts: ['view', 'manage'] },
  { code: 'netflow', name: '流量监控', group: '机房巡检', acts: ['view', 'manage'] },
  { code: 'users', name: '用户管理', group: '系统管理', acts: ['manage'] },
  { code: 'roles', name: '角色权限', group: '系统管理', acts: ['manage'] },
  { code: 'logs', name: '操作日志', group: '系统管理', acts: ['view'] },
];

// 全部合法权限编码
const ALL_PERMS = (() => {
  const out = [];
  MODULES.forEach((m) => m.acts.forEach((a) => out.push(m.code + '.' + a)));
  return out;
})();

// 动作的满足关系：要「拥有 X」，可以持有哪些动作。
// 注意方向 —— 是「哪些动作能满足 X」，不是「X 能推出哪些动作」。
// （写反过一次：结果持有 manage 的角色读不到 view 接口，因为管理员是 '*' 把问题盖住了）
const SATISFIED_BY = {
  // 能提交/能处理的人当然能看；另外「能看密码」的人也当然能看列表 ——
  // 否则管理员单独勾「看密码」会造出一个「有权限点却打不开页面」的角色
  // （列表接口要 view、接口又要先过 view），在界面上完全看不出问题。
  view: ['view', 'create', 'manage', 'secret'],
  create: ['create', 'manage'],         // 能处理的人当然能提交
  manage: ['manage'],
  // ★ 例外：secret 只由自己满足，不被 manage 隐含。
  //   它是「能不能看到别人的口令」这种敏感动作，必须能单独开关；
  //   若写成 ['manage']，管理员把 manage 勾给某角色时会连带把看密码也送出去，
  //   而这个后果在权限页上完全看不出来（勾了「管理」，实际多拿到了「看密码」）。
  secret: ['secret'],
};

// 内置角色的默认权限（仅在该角色「一条权限行都没有」时写入，之后以库里的为准）
//
// 注意 engineer 与 approver 两套写法都要有：问题工单时代内置的角色是
// 「管理员 / 审批人 / 普通用户」（code=approver），合同库统一账号后
// 有的库是 engineer、有的是 approver —— 少写一个，那批用户升级后就是零权限、菜单空白。
const OPERATOR_PERMS = [
  'dashboard.view',
  'contracts.view', 'contracts.manage',
  'remind.view',
  'payments.view', 'payments.manage',
  'issues.view', 'issues.create', 'issues.manage',
  'docs.view', 'docs.manage',
  // 网页书签 / IP 管理：默认把业务权限给到工程师（含看密码），
  // 不想让某人看密码就在【角色权限】页把「看密码」取消勾选即可 ——
  // 这一档独立于「管理」，取消它不会连带影响编辑权限。
  'bookmarks.view', 'bookmarks.manage', 'bookmarks.secret',
  'ipam.view', 'ipam.manage',
  'screen.view',
  // 设备台账刻意只给查看：改造前只有管理员能新增/编辑设备、测试连接，
  // 这里保持原样，需要时管理员在权限页勾上即可（避免"升级完工程师权限变大了"）
  'devices.view',
  'inspection.view', 'inspection.manage',
  'netflow.view', 'netflow.manage',
];

const DEFAULT_ROLE_PERMS = {
  // '*' = 全权，且今后新增模块自动拥有
  admin: ['*'],
  engineer: OPERATOR_PERMS,
  approver: OPERATOR_PERMS,
  // 普通用户 = 报障人：能进工作台、能提交和查看工单，其余模块不进菜单
  user: ['dashboard.view', 'issues.view', 'issues.create'],
};

function actLabel(mod, act) {
  return (mod.actLabels && mod.actLabels[act]) || ACT_LABELS[act] || act;
}

/** 供前端渲染权限矩阵：模块 + 中文动作名 + 完整编码 */
function describeModules() {
  return MODULES.map((m) => ({
    code: m.code,
    name: m.name,
    group: m.group,
    acts: m.acts.map((a) => ({ act: a, label: actLabel(m, a), code: m.code + '.' + a })),
  }));
}

function isKnownPerm(code) {
  return ALL_PERMS.indexOf(String(code)) >= 0;
}

/** 过滤非法编码、去重、按固定顺序排列（保证存库与回显稳定）；含 '*' 时只留 '*' */
function normalizePerms(list) {
  if (!Array.isArray(list)) return [];
  const set = new Set();
  list.forEach((p) => {
    const v = String(p == null ? '' : p).trim();
    if (v === '*') { set.add('*'); return; }
    if (isKnownPerm(v)) set.add(v);
  });
  if (set.has('*')) return ['*'];
  return ALL_PERMS.filter((p) => set.has(p));
}

/** 判定：权限集合 perms 是否满足编码 code。perms 可以是数组或 'admin' 全权标记。 */
function hasPerm(perms, code) {
  if (!code) return true;
  const list = Array.isArray(perms) ? perms : (perms == null ? [] : [perms]);
  if (list.indexOf('*') >= 0) return true;
  const target = String(code);
  const dot = target.lastIndexOf('.');
  if (dot <= 0) return false;
  const mod = target.slice(0, dot);
  const act = target.slice(dot + 1);
  const satisfiedBy = SATISFIED_BY[act] || [act];
  // 同模块下持有任一「更强」的动作，即视为具备该权限
  return satisfiedBy.some((need) => list.indexOf(mod + '.' + need) >= 0);
}

// 「已配置，但一项权限都不给」的标记。
// 没有它就分不清「这个角色从没配过权限」和「管理员故意把它清空了」——
// 后者会被 getRolePerms 的默认值兜底悄悄填回来，管理员的清空操作等于白做。
const EMPTY_MARK = '-';

function isBuiltinAdmin(role) {
  return !!role && String(role.code) === 'admin';
}

/**
 * 取某角色的权限集合。
 * 返回 { perms, source }，source: db | default | admin | empty | error
 * 只有「一条记录都没有」才退回内置默认值（多见于刚升级、还没跑过初始化）；
 * 一旦写过一个标记行，就说明这个角色被配置过，空就是空。
 */
function getRolePerms(roleId, roleCode) {
  const id = Number(roleId);
  const code = String(roleCode || '');
  if (code === 'admin') return { perms: ['*'], source: 'admin' };
  try {
    const rows = db.prepare('SELECT perm FROM role_permissions WHERE role_id = ?').all(id);
    if (!rows.length) {
      const def = DEFAULT_ROLE_PERMS[code];
      return { perms: def ? def.slice() : [], source: def ? 'default' : 'empty' };
    }
    return { perms: normalizePerms(rows.map((r) => r.perm)), source: 'db' };
  } catch (e) {
    const def = DEFAULT_ROLE_PERMS[code];
    console.warn('[perm] 读取角色权限失败，退回内置默认值：' + ((e && e.message) || e));
    return { perms: def ? def.slice() : [], source: 'error' };
  }
}

/** 一次取回所有角色的权限（角色权限页用），避免 N+1。值为归一化后的数组。 */
function getAllRolePerms() {
  const map = {};
  try {
    db.prepare('SELECT role_id, perm FROM role_permissions ORDER BY role_id').all().forEach((r) => {
      const k = String(r.role_id);
      if (!map[k]) map[k] = [];
      map[k].push(r.perm);
    });
  } catch (e) {
    console.warn('[perm] 读取角色权限表失败：' + ((e && e.message) || e));
  }
  const out = {};
  Object.keys(map).forEach((k) => { out[k] = normalizePerms(map[k]); });
  return out;
}

/**
 * 写入某角色的权限。
 * 内置 admin 角色（roles.code='admin'）永远强制为 '*'，传入什么都会被忽略并提示。
 */
function setRolePerms(roleId, roleCode, list) {
  const id = Number(roleId);
  let role = null;
  try { role = db.prepare('SELECT * FROM roles WHERE id = ?').get(id); } catch (e) { role = null; }
  const builtinAdmin = isBuiltinAdmin(role) || String(roleCode || '') === 'admin';
  const perms = builtinAdmin ? ['*'] : normalizePerms(list);
  try {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    const stmt = db.prepare('INSERT INTO role_permissions (role_id, perm) VALUES (?, ?)');
    // 空权限也要留一条标记行，见 EMPTY_MARK 的说明
    (perms.length ? perms : [EMPTY_MARK]).forEach((p) => stmt.run(id, p));
    return { ok: true, perms, forced: builtinAdmin };
  } catch (e) {
    return { ok: false, perms, error: String((e && e.message) || e) };
  }
}

/** 删除角色时清理其权限行 */
function removeRolePerms(roleId) {
  try {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(Number(roleId));
    return true;
  } catch (e) { return false; }
}

/**
 * 启动时给「一条权限行都没有」的内置角色写入默认权限。
 * 已经有配置的角色一律不动 —— 管理员改过的权限不能被重启冲掉。
 * 同时把「没有权限行、也没有内置默认值」的角色列出来（unconfigured）：
 * 这类角色如果不提示，管理员只会看到"某某登录后菜单是空的"，不知道从哪查。
 */
function ensureSeed() {
  const result = { seeded: [], skipped: [], unconfigured: [] };
  const seededIds = new Set(
    (() => { try { return db.prepare('SELECT DISTINCT role_id FROM role_permissions').all().map((r) => Number(r.role_id)); } catch (e) { return []; } })()
  );
  let roles = [];
  try { roles = db.prepare('SELECT * FROM roles').all(); } catch (e) { roles = []; }
  roles.forEach((r) => {
    if (seededIds.has(Number(r.id))) { result.skipped.push(r.code); return; }
    const def = DEFAULT_ROLE_PERMS[r.code];
    if (!def) { result.unconfigured.push(r.name + '(' + r.code + ')'); return; }
    const r2 = setRolePerms(r.id, r.code, def);
    if (r2.ok) result.seeded.push(r.code + '(' + r2.perms.length + ')');
  });
  return result;
}

/** 中间件：要求具备 codes 中任意一个权限 */
function requirePerm(...codes) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
    const perms = req.user.perms || [];
    const okAll = codes.length === 0 || codes.some((c) => hasPerm(perms, c));
    if (!okAll) {
      return res.status(403).json({ code: 403, message: '没有权限执行该操作（需要：' + codes.join(' 或 ') + '）' });
    }
    next();
  };
}

/**
 * 整个路由模块的通用守卫：读接口要 模块.view，写接口要 模块.manage。
 * 这正是「查看 / 处理」两档模型的直接落地，一个模块一行搞定，
 * 不必给每个接口单独挂中间件（漏挂一个就是一个越权口子）。
 * 需要例外的接口（如工单的「提交」）在 router.use 之前单独注册即可。
 */
function guardModule(mod) {
  return (req, res, next) => {
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].indexOf(req.method) >= 0;
    return requirePerm(isWrite ? String(mod) + '.manage' : String(mod) + '.view')(req, res, next);
  };
}

module.exports = {
  MODULES, ALL_PERMS, ACT_LABELS, DEFAULT_ROLE_PERMS,
  describeModules, isKnownPerm, normalizePerms, hasPerm,
  getRolePerms, getAllRolePerms, setRolePerms, removeRolePerms, ensureSeed,
  requirePerm, guardModule,
};
