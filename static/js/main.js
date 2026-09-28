/* 根组件 + 应用挂载 */
(function () {
  const V = window.HisViews;
  const ROLE_NAME = { 1: '管理员', 2: '工程师', 3: '普通用户' };

  // 全局响应式：登录用户、路由
  const userState = Vue.reactive({ user: api.user });
  const routeState = Vue.reactive({ path: '', id: null });
  // 暴露给视图组件使用（比 $root 更可靠）
  window.HisUser = userState;

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
            <div class="menu-item" :class="{active: route.path==='dashboard'}" @click="go('dashboard')">
              <span class="menu-icon">📊</span>工作台
            </div>

            <div class="nav-group-title">合同管理</div>
            <div class="menu-item sub" :class="{active: route.path==='contracts'}" @click="go('contracts')">
              <span class="menu-icon">📄</span>合同台账
            </div>
            <div class="menu-item sub" :class="{active: route.path==='remind'}" @click="go('remind')">
              <span class="menu-icon">⏰</span>到期提醒
            </div>

            <div class="nav-group-title">系统问题管理</div>
            <div class="menu-item sub" :class="{active: route.path==='issues' || route.path==='issue'}" @click="go('issues')">
              <span class="menu-icon">🗂️</span>问题记录
            </div>
            <div class="menu-item sub" :class="{active: route.path==='issue' && route.id==='new'}" @click="go('issue/new')">
              <span class="menu-icon">➕</span>新建问题
            </div>

            <div class="nav-group-title">技术文档库</div>
            <div class="menu-item sub" :class="{active: route.path==='docs'}" @click="go('docs')">
              <span class="menu-icon">📚</span>技术文档
            </div>

            <div class="nav-group-title">机房巡检</div>
            <div class="menu-item sub" :class="{active: route.path==='bigscreen'}" @click="go('bigscreen')">
              <span class="menu-icon">📺</span>监控大屏
            </div>
            <div class="menu-item sub" :class="{active: route.path==='devices'}" @click="go('devices')">
              <span class="menu-icon">🖥️</span>设备台账
            </div>
            <div class="menu-item sub" :class="{active: route.path==='reports'}" @click="go('reports')">
              <span class="menu-icon">📑</span>巡检报告
            </div>

            <div class="nav-group-title">系统管理</div>
            <div v-if="isAdmin" class="menu-item sub" :class="{active: route.path==='users'}" @click="go('users')">
              <span class="menu-icon">👥</span>用户管理
            </div>
            <div v-if="isAdmin" class="menu-item sub" :class="{active: route.path==='logs'}" @click="go('logs')">
              <span class="menu-icon">📜</span>操作日志
            </div>
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
      isAdmin() { const u = userState.user; return u && u.role_id === 1; },
      roleName() {
        const u = userState.user;
        return u ? (ROLE_NAME[u.role_id] || '') : '';
      },
      route() { return routeState; },
      curView() {
        if (!userState.user) return 'login-view';
        const p = routeState.path;
        if (p === 'dashboard') return 'dashboard-view';
        if (p === 'contracts') return 'contracts-view';
        if (p === 'remind') return 'remind-view';
        if (p === 'issues') return 'issues-view';
        if (p === 'issue') return routeState.id === 'new' ? 'new-issue-view' : 'issue-detail-view';
        if (p === 'users') return this.isAdmin ? 'users-view' : 'issues-view';
        if (p === 'logs') return this.isAdmin ? 'logs-view' : 'issues-view';
        if (p === 'devices') return 'devices-view';
        // 组件名必须能与注册名 BigScreenView 对应：Vue 的 resolveAsset 只会尝试
        // 「原样 / camelize / capitalize(camelize)」三种写法。若写成 'bigscreen-view'，
        // camelize 只能得到 bigscreenView、capitalize 得到 BigscreenView，
        // 永远还原不出 BigScreen —— 解析失败后 Vue 会把它当未知原生标签渲染，
        // 大屏整块空白且 prod 构建不打任何警告。此处用 'big-screen-view' 才能命中。
        if (p === 'bigscreen') return 'big-screen-view';
        if (p === 'reports') return 'reports-view';
        if (p === 'docs') return 'docs-view';
        if (p === 'doc') return 'doc-page-view';
        return 'dashboard-view';
      },
    },

    methods: {
      go(p) { location.hash = '#/' + p; },
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

    mounted() {
      // 已登录（localStorage 恢复）时拉取最新分类/模块清单（含自定义项）
      if (api.user && window.loadHisModules) window.loadHisModules();
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

  // 登录后同步 userState（视图组件经 window.HisUser 读取）
  const origSetUser2 = api.setUser;
  api.setUser = function (u, t) {
    origSetUser2(u, t);
    userState.user = u;
  };

  app.mount('#app');
})();