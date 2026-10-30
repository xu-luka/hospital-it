/* 前端权限判定：window.HisPerm.can('模块.动作')
 *
 * 与后端 src/perm.js 一一对应（动作隐含关系：管理 ⊃ 提交 ⊃ 查看）。
 * 前端判定只决定「菜单显示不显示、按钮显示不显示」，真正的拦截在后端 ——
 * 前端藏起来只是省事，绝不是安全边界。
 */
(function () {
  // 与后端 SATISFIED_BY 保持一致：要拥有 X，可以持有哪些动作
  // （方向别写反：manage 能满足 view，反之不然）
  const SATISFIED_BY = {
    // 与后端一致：看密码（secret）内含查看 —— 单独勾「看密码」的人也要能打开列表，
    // 否则就是一个「有权限点却打不开页面」的角色
    view: ['view', 'create', 'manage', 'secret'],
    create: ['create', 'manage'],
    manage: ['manage'],
    // 与后端一致：看密码（bookmarks.secret）刻意不被 manage 隐含，
    // 必须能单独授予/取消 —— 否则勾了「管理」等于顺带送出「看密码」。
    secret: ['secret'],
  };

  // 兜底：浏览器 localStorage 里存的还是升级前的用户信息（没有 perms 字段）时，
  // 按内置角色的默认权限推算 —— 否则升级后所有老会话会看到空白菜单，
  // 用户会以为"系统坏了"。正常情况下 refresh() 会立刻把真实权限拉回来。
  const LEGACY_BY_ROLE_ID = {
    1: ['*'],
    2: [
      'dashboard.view',
      'contracts.view', 'contracts.manage', 'remind.view',
      'payments.view', 'payments.manage',
      'issues.view', 'issues.create', 'issues.manage',
      'docs.view', 'docs.manage',
      'bookmarks.view', 'bookmarks.manage', 'bookmarks.secret',
      'ipam.view', 'ipam.manage',
      'terminals.view', 'terminals.manage',
      'screen.view', 'devices.view',
      'inspection.view', 'inspection.manage',
      'netflow.view', 'netflow.manage',
    ],
    3: ['dashboard.view', 'issues.view', 'issues.create'],
  };

  function currentUser() {
    return (window.HisUser && window.HisUser.user) || (window.api && window.api.user) || null;
  }

  /** 返回权限数组；返回 null 表示"这份用户信息没有权限字段"（老会话） */
  function permsOf(u) {
    if (!u) return [];
    if (Array.isArray(u.perms)) return u.perms;
    return null;
  }

  function canByLegacy(code, roleId) {
    const list = LEGACY_BY_ROLE_ID[Number(roleId)];
    if (!list) return false;
    if (list.indexOf('*') >= 0) return true;
    const dot = code.lastIndexOf('.');
    const mod = code.slice(0, dot);
    const act = code.slice(dot + 1);
    return (SATISFIED_BY[act] || [act]).some(function (n) { return list.indexOf(mod + '.' + n) >= 0; });
  }

  function can(code) {
    if (!code) return true;
    const u = currentUser();
    if (!u) return false;
    const list = permsOf(u);
    if (list === null) return canByLegacy(code, u.role_id !== undefined ? u.role_id : u.roleId);
    if (list.indexOf('*') >= 0) return true;
    const dot = code.lastIndexOf('.');
    if (dot <= 0) return false;
    const mod = code.slice(0, dot);
    const act = code.slice(dot + 1);
    return (SATISFIED_BY[act] || [act]).some(function (n) { return list.indexOf(mod + '.' + n) >= 0; });
  }

  function canAny(codes) {
    if (!codes || !codes.length) return true;
    return codes.some(function (c) { return can(c); });
  }

  /** 就地更新用户信息（刷新 localStorage + 响应式状态）
   *  注意：不能用 api.setUser(u) —— 它第二个参数为空时会顺手把 token 删掉，
   *  登出逻辑正是靠这个特性，这里借用会把自己踢下线。 */
  function applyUser(u) {
    localStorage.setItem('his_user', JSON.stringify(u));
    if (window.HisUser) window.HisUser.user = u;
  }

  /** 老会话（本地存的信息里没有 perms）自动补拉一次 /auth/me */
  function refresh() {
    const u = currentUser();
    if (!u || Array.isArray(u.perms)) return Promise.resolve(u);
    if (!window.api || !window.api.token) return Promise.resolve(u);
    return window.api.get('/auth/me').then(function (fresh) {
      if (fresh && typeof fresh === 'object') applyUser(fresh);
      return fresh;
    }).catch(function () { return u; });
  }

  window.HisPerm = {
    can: can,
    canAny: canAny,
    permsOf: permsOf,
    applyUser: applyUser,
    refresh: refresh,
    // 便捷写法，模板里更短
    isAdminRole: function () {
      const u = currentUser();
      return !!(u && String(u.role_code || u.roleCode || '') === 'admin');
    },
  };
})();
