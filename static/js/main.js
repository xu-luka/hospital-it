/* 根组件 + 应用挂载 */
(function () {
  const V = window.HisViews;
  const can = function (c) { return !!(window.HisPerm && window.HisPerm.can(c)); };

  // 侧边栏菜单：perm 决定可见性。菜单定义集中在这里，新增模块时只改这一处。
  // 图标沿用原来的 emoji，避免这次改造顺手动到视觉。
  const MENU = [
    { title: '概览', items: [
      { path: 'dashboard', icon: '📊', label: '工作台', perm: 'dashboard.view' },
    ] },
    { title: '合同管理', items: [
      { path: 'contracts', icon: '📄', label: '合同台账', perm: 'contracts.view' },
      { path: 'remind', icon: '⏰', label: '到期提醒', perm: 'remind.view' },
    ] },
    { title: '系统问题管理', items: [
      { path: 'issues', icon: '🗂️', label: '问题记录', perm: 'issues.view', activeAlso: ['issue'] },
      { path: 'issue/new', icon: '➕', label: '新建问题', perm: 'issues.create', activePath: 'issue', activeId: 'new' },
    ] },
    { title: '技术文档库', items: [
      { path: 'docs', icon: '📚', label: '技术文档', perm: 'docs.view' },
    ] },
    { title: '机房巡检', items: [
      { path: 'bigscreen', icon: '📺', label: '监控大屏', perm: 'screen.view' },
      { path: 'devices', icon: '🖥️', label: '设备台账', perm: 'devices.view' },
      { path: 'reports', icon: '📑', label: '巡检报告', perm: 'inspection.view' },
      { path: 'netflow', icon: '🌐', label: '流量监控', perm: 'netflow.view' },
    ] },
    { title: '系统管理', items: [
      { path: 'users', icon: '👥', label: '用户管理', perm: 'users.manage' },
      { path: 'roles', icon: '🔑', label: '角色权限', perm: 'roles.manage' },
      { path: 'logs', icon: '📜', label: '操作日志', perm: 'logs.view' },
    ] },
  ];

  // 每个可访问页面所需的查看权限。直接改地址栏 / 收藏夹旧链接进来时按这个守卫。
  const VIEW_PERM = {
    dashboard: 'dashboard.view',
    contracts: 'contracts.view',
    remind: 'remind.view',
    issues: 'issues.view',
    issue: 'issues.view',
    docs: 'docs.view',
    doc: 'docs.view',
    bigscreen: 'screen.view',
    devices: 'devices.view',
    reports: 'inspection.view',
    netflow: 'netflow.view',
    users: 'users.manage',
    roles: 'roles.manage',
    logs: 'logs.view',
  };

  // 全局响应式：登录用户、路由
  const userState = Vue.reactive({ user: api.user });
  const routeState = Vue.reactive({ path: '', id: null });
  // 暴露给视图组件使用（比 $root 更可靠）
  window.HisUser = userState;

  // 某个地址当前需要的权限。#/issue/new 是「新建」页，要的是提交权限而不是查看权限
  function needPermFor(p) {
    if (p === 'issue' && routeState.id === 'new') return 'issues.create';
    return VIEW_PERM[p];
  }

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    const parts = h.split('/');
    routeState.path = parts[0] || 'dashboard';
    routeState.id = parts[1] ? decodeURIComponent(parts[1]) : null;
  }
  window.addEventListener('hashchange', parseHash);
  parseHash();

  // 包装 setUser 让登录态响应式
  const origSetUser = api.setUser.bind(api);
  api.setUser = function (u, t) {
    origSetUser(u, t);
    userState.user = u;
  };

  const App = {
    template: `
    <div>
      <div v-if="!u" class="login-wrap">
        <login-view></login-view>
      </div>
      <div v-else class="layout">
        <aside class="sidebar">
          <div class="sidebar-logo">
            <div class="logo-icon">医信</div>
            <div>
              <div class="logo-text">医院信息科</div>
              <div class="logo-sub">日常管理系统</div>
            </div>
          </div>
          <nav class="sidebar-menu">
            <template v-for="g in menuGroups" :key="g.title">
              <div class="nav-group-title">{{ g.title }}</div>
              <div v-for="it in g.items" :key="it.path" class="menu-item sub"
                   :class="{active: isActive(it)}" @click="go(it.path)">
                <span class="menu-icon">{{ it.icon }}</span>{{ it.label }}
              </div>
            </template>

            <div class="nav-group-title">账号</div>
            <div class="menu-item sub" @click="openPwd">
              <span class="menu-icon">🔒</span>修改密码
            </div>
          </nav>
          <div class="sidebar-user">
            <div class="user-row">
              <div class="avatar">{{ (u.real_name || u.username).slice(0,1) }}</div>
              <div class="user-info">
                <div class="uname">{{ u.real_name || u.username }}</div>
                <div class="urole">{{ roleName }}</div>
              </div>
              <button class="logout-btn" title="退出登录" @click="logout">⏻</button>
            </div>
          </div>
        </aside>
        <main class="main">
          <component :is="curView"></component>
        </main>
      </div>

      <div class="modal-mask" v-if="showPwd">
        <div class="modal" style="width:420px">
          <div class="modal-head">修改密码 <span class="x" @click="showPwd=false">✕</span></div>
          <div class="modal-body">
            <div class="form-item"><label>原密码</label><input type="password" v-model="pf.old"></div>
            <div class="form-item"><label>新密码（至少 6 位）</label><input type="password" v-model="pf.next"></div>
            <div class="form-item"><label>确认新密码</label><input type="password" v-model="pf.next2"></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="showPwd=false">取消</button>
            <button class="btn btn-primary" @click="savePwd">保存</button>
          </div>
        </div>
      </div>

      <div class="toast-wrap">
        <div v-for="t in toasts" :key="t.id" :class="'toast ' + (t.type || '')">{{ t.msg }}</div>
      </div>
    </div>`,

    data() {
      return { toasts: [], showPwd: false, pf: { old: '', next: '', next2: '' } };
    },

    computed: {
      u() { return userState.user; },
      isAdmin() { const u = userState.user; return !!(u && String(u.role_code || u.roleCode || '') === 'admin'); },
      // 角色名直接用后端返回的（角色已经可以自由新增/改名，写死的对照表必然对不上）
      roleName() {
        const u = userState.user;
        return u ? (u.role_name || u.roleName || u.username || '') : '';
      },
      route() { return routeState; },
      // 按权限过滤菜单：没有权限的分组整组隐藏，不留空标题
      menuGroups() {
        return MENU.map((g) => ({
          title: g.title,
          items: g.items.filter((it) => can(it.perm)),
        })).filter((g) => g.items.length > 0);
      },
      curView() {
        if (!userState.user) return 'login-view';
        const p = routeState.path;
        // 权限守位：无权限时不静默跳到别的页面（用户会以为点错了），
        // 而是显示明确的「没有权限」提示，并说明去哪儿开权限
        const need = needPermFor(p);
        if (need && !can(need)) return 'no-perm-view';
        if (p === 'dashboard') return 'dashboard-view';
        if (p === 'contracts') return 'contracts-view';
        if (p === 'remind') return 'remind-view';
        if (p === 'issues') return 'issues-view';
        if (p === 'issue') return routeState.id === 'new' ? 'new-issue-view' : 'issue-detail-view';
        if (p === 'users') return 'users-view';
        if (p === 'roles') return 'perm-view';
        if (p === 'logs') return 'logs-view';
        if (p === 'devices') return 'devices-view';
        // 组件名必须能与注册名 BigScreenView 对应：Vue 的 resolveAsset 只会尝试
        // 「原样 / camelize / capitalize(camelize)」三种写法。若写成 'bigscreen-view'，
        // camelize 只能得到 bigscreenView、capitalize 得到 BigscreenView，
        // 永远还原不出 BigScreen —— 解析失败后 Vue 会把它当未知原生标签渲染，
        // 大屏整块空白且 prod 构建不打任何警告。此处用 'big-screen-view' 才能命中。
        if (p === 'bigscreen') return 'big-screen-view';
        if (p === 'reports') return 'reports-view';
        if (p === 'netflow') return 'netflow-view';
        if (p === 'docs') return 'docs-view';
        if (p === 'doc') return 'doc-page-view';
        return 'dashboard-view';
      },
    },

    methods: {
      isActive(it) {
        if (it.activePath) return routeState.path === it.activePath && routeState.id === it.activeId;
        const paths = [it.path].concat(it.activeAlso || []);
        return paths.indexOf(routeState.path) >= 0;
      },
      // 当前角色能进的第一个页面：登录后若停在无权页面，就落到这里
      firstAllowedPath() {
        for (const g of MENU) {
          for (const it of g.items) {
            if (can(it.perm)) return it.path.split('/')[0];
          }
        }
        return 'dashboard';
      },
      go(p) { location.hash = '#/' + p; },
      ensureRouteAllowed() {
        const p = routeState.path;
        if (!p || p === 'login') return;
        const need = needPermFor(p);
        if (!need || can(need)) return;
        const fallback = this.firstAllowedPath();
        if (fallback !== p) location.hash = '#/' + fallback;
      },
      openPwd() {
        this.pf = { old: '', next: '', next2: '' };
        this.showPwd = true;
      },
      logout() {
        api.setUser(null, null);
        location.hash = '#/login';
      },
      toast(msg, type) {
        const id = Date.now() + Math.random();
        this.toasts.push({ id, msg, type: type === 'err' ? 'err' : type === 'ok' ? 'ok' : '' });
        setTimeout(() => {
          const i = this.toasts.findIndex((t) => t.id === id);
          if (i >= 0) this.toasts.splice(i, 1);
        }, 3000);
      },
      async savePwd() {
        if (!this.pf.old || !this.pf.next) return this.toast('请填写完整', 'err');
        if (this.pf.next !== this.pf.next2) return this.toast('两次输入的新密码不一致', 'err');
        if (this.pf.next.length < 6) return this.toast('新密码至少 6 位', 'err');
        try {
          await api.put('/auth/password', { oldPassword: this.pf.old, newPassword: this.pf.next });
          this.showPwd = false;
          this.toast('密码修改成功，请重新登录', 'ok');
          this.logout();
        } catch (e) { this.toast(e.message, 'err'); }
      },
    },

    watch: {
      // 登录后 / 切换账号后，如果当前地址栏停在无权页面，落到第一个有权限的页面
      u(nu) {
        if (!nu) return;
        this.ensureRouteAllowed();
      },
    },

    mounted() {
      // 已登录（localStorage 恢复）时拉取最新分类/模块清单（含自定义项）
      if (api.user && window.loadHisModules) window.loadHisModules();
      if (api.user && window.HisPerm) {
        // 老会话（浏览器里缓存的用户信息还没有 perms 字段）自动补拉一次真实权限。
        // 不做这一步的话，升级后所有已登录用户会看到空菜单 —— 会被当成"系统坏了"。
        window.HisPerm.refresh().then(() => this.ensureRouteAllowed());
      }
    },
  };

  const app = Vue.createApp(App);
  app.config.globalProperties.$api = api;
  app.config.globalProperties.$route = routeState;
  app.config.globalProperties.$toast = function (msg, type) {
    if (app._instance) app._instance.proxy.toast(msg, type);
  };

  // 全局工具函数（模板经运行时编译不继承闭包作用域，须注册为全局方法）
  const HU = window.HisUtils || {};
  app.mixin({
    methods: {
      fmtMoney: HU.fmtMoney, statusTag: HU.statusTag, daysLeft: HU.daysLeft,
      todayStr: HU.todayStr, fmtDate: HU.fmtDate, fmtSize: HU.fmtSize,
    },
  });

  app.component('LoginView', V.LoginView);
  app.component('DashboardView', V.DashboardView);
  app.component('IssuesView', V.IssuesView);
  app.component('IssueDetailView', V.IssueDetailView);
  app.component('NewIssueView', V.NewIssueView);
  app.component('UsersView', V.UsersView);
  app.component('LogsView', V.LogsView);
  // 技术文档库：DocsView(列表) + DocPageView(独立预览页 #/doc/:id)
  // 同样禁止「有就注册、没有静默跳过」：解析失败会渲染成空白标签且 prod 构建不打警告
  ['DocsView', 'DocPageView'].forEach((n) => {
    if (V[n]) {
      app.component(n, V[n]);
    } else {
      console.error('[main.js] 文档库组件缺失，未注册：' + n + '（对应页面会显示空白）');
    }
  });
  // 角色权限配置页 + 无权限提示页（同样禁止「有就注册、没有静默跳过」）
  ['PermView', 'NoPermView'].forEach((n) => {
    if (V[n]) {
      app.component(n, V[n]);
    } else {
      console.error('[main.js] 权限组件缺失，未注册：' + n + '（角色权限页或无权限提示页会显示空白）');
    }
  });
  app.component('ContractsView', V.ContractsView);
  app.component('RemindView', V.RemindView);
  app.component('ContractDetailModal', V.ContractDetailModal);
  app.component('ContractEditModal', V.ContractEditModal);
  // 机房巡检（阶段 3 起逐步补齐：设备台账 → 大屏 → 报告）
  // 不要再用「有就注册、没有就静默跳过」的写法：一旦组件改名或文件缺失，
  // 动态组件解析不到就会渲染成空的自定义标签，页面整块空白却没有任何报错。
  // 这里强制校验并在控制台点名，避免同类问题再次无声发生。
  ['DevicesView', 'BigScreenView', 'ReportsView'].forEach((n) => {
    if (V[n]) {
      app.component(n, V[n]);
    } else {
      console.error('[main.js] 巡检组件缺失，未注册：' + n + '（对应页面会显示空白）');
    }
  });
  if (V.NetflowView) {
    app.component('NetflowView', V.NetflowView);
  } else {
    console.error('[main.js] 流量监控组件缺失（netflow-view.js 未加载），流量监控页会显示空白');
  }

  // 登录后同步 userState（视图组件经 window.HisUser 读取）
  const origSetUser2 = api.setUser;
  api.setUser = function (u, t) {
    origSetUser2(u, t);
    userState.user = u;
  };

  app.mount('#app');
})();