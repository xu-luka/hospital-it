/* 根组件 + 应用挂载
   —— 方案 A「值班台」外壳：左侧通道条导航（每项带状态 LED）+ 常驻顶栏（面包屑 /
      真实告警数 / 实时时钟 / 主题切换）+ Ctrl+K 命令面板。
   本文件只改外壳，视图组件一行未动 —— 全站 17 个视图的类名在 style.css 里全部保留，
   所以这次改版是纯前端，更新包替换后 Ctrl+F5 即可，不用重启服务。 */
(function () {
  const V = window.HisViews;
  const can = function (c) { return !!(window.HisPerm && window.HisPerm.can(c)); };
  const THEME_KEY = 'his_theme';

  /** 改密码表单「有没有改动」的比较字段 */
  const PWD_KEYS = ['old', 'next', 'next2'];

  /* ==========================================================================
     线条图标（内联 SVG）
     —— 这里刻意不用 emoji：emoji 在不同 Windows 版本上是彩色点阵字体，与
        「工业控制台」的等宽线条体系冲突，且无法跟随主题变色。
        图标一律 currentColor 描边，粗细由 CSS 的 --icon-stroke 统一控制。
     ========================================================================== */
  const ICONS = {
    gauge: '<path d="M4 15a8 8 0 1 1 16 0"/><path d="M12 15l4.6-5"/><circle cx="12" cy="15" r="1.4"/>',
    doc: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    inbox: '<path d="M5 5h14l2 7v7H3v-7z"/><path d="M3 12h5l1.6 2.6h4.8L16 12h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    book: '<path d="M4 19V5a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v14"/><path d="M4 19h14"/><path d="M8 7h7M8 11h5"/>',
    // 链接（网页书签）
    link: '<path d="M9.6 14.4 14.4 9.6"/><path d="M11.2 6.6 12.6 5.2a4.2 4.2 0 0 1 5.9 5.9l-1.4 1.4"/><path d="M12.8 17.4l-1.4 1.4a4.2 4.2 0 0 1-5.9-5.9l1.4-1.4"/>',
    // 拓扑节点（IP 管理）：三个节点互连，比「一张表格」更能表达「地址分配」
    ip: '<circle cx="12" cy="4.6" r="2.4"/><circle cx="5" cy="18.4" r="2.4"/><circle cx="19" cy="18.4" r="2.4"/><path d="M12 7v3.6M12 10.6H6.9l-1 5.2M12 10.6h5.1l1 5.2"/>',
    monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
    server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    report: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 16v-4M12 16V8M16 16v-6"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.3 2.4 3.4 5.5 3.4 9S14.3 18.6 12 21c-2.3-2.4-3.4-5.5-3.4-9S9.7 5.4 12 3z"/>',
    activity: '<path d="M3 12h4l3-7 4 14 3-7h4"/>',
    users: '<circle cx="9" cy="7.5" r="3.5"/><path d="M2.5 20v-1.2a4.5 4.5 0 0 1 4.5-4.5h4a4.5 4.5 0 0 1 4.5 4.5V20"/><path d="M17 4.6a3.5 3.5 0 0 1 0 6.6"/><path d="M18.8 20v-1.2a4.5 4.5 0 0 0-1.9-3.7"/>',
    key: '<circle cx="8" cy="12" r="4"/><path d="M12 12h9"/><path d="M18 12v3M15.2 12v2.4"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M12 14.5v2"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M16.4 16.4 21 21"/>',
    warn: '<path d="M12 3.4 22 20H2z"/><path d="M12 9.6v4.6M12 17.4h.01"/>',
    power: '<path d="M12 3v9"/><path d="M6.6 6.6a8 8 0 1 0 10.8 0"/>',
    sun: '<circle cx="12" cy="12" r="4.2"/><path d="M12 2.4v2.2M12 19.4v2.2M2.4 12h2.2M19.4 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6"/>',
    moon: '<path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    dot: '<circle cx="12" cy="12" r="2.6"/>',
  };

  // 只输出一个固定的 class="ic"（尺寸/描边粗细全部由 CSS 按上下文决定，
  // 如 .menu-icon .ic / .icon-btn .ic）。刻意不接受额外的类名参数：
  // 拼接 class 字符串会让静态类名普查脚本把拼接变量当成类名读进去。
  function ic(name) {
    const body = ICONS[name] || ICONS.dot;
    return '<svg class="ic" viewBox="0 0 24 24" fill="none"'
      + ' stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"'
      + ' aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  /* 侧边栏菜单：perm 决定可见性。菜单定义集中在这里，新增模块时只改这一处。
     icon 是上面 ICONS 的键名（不是 emoji）。 */
  const MENU = [
    { title: '概览', items: [
      { path: 'dashboard', icon: 'gauge', label: '工作台', perm: 'dashboard.view' },
    ] },
    { title: '合同管理', items: [
      { path: 'contracts', icon: 'doc', label: '合同台账', perm: 'contracts.view' },
      { path: 'remind', icon: 'clock', label: '到期提醒', perm: 'remind.view' },
    ] },
    { title: '系统问题管理', items: [
      { path: 'issues', icon: 'inbox', label: '问题记录', perm: 'issues.view', activeAlso: ['issue'] },
      { path: 'issue/new', icon: 'plus', label: '新建问题', perm: 'issues.create', activePath: 'issue', activeId: 'new' },
    ] },
    { title: '技术文档库', items: [
      { path: 'docs', icon: 'book', label: '技术文档', perm: 'docs.view' },
    ] },
    { title: '资源管理', items: [
      { path: 'bookmarks', icon: 'link', label: '网页书签', perm: 'bookmarks.view' },
      { path: 'ipam', icon: 'ip', label: 'IP 管理', perm: 'ipam.view' },
      { path: 'terminals', icon: 'server', label: '终端资产', perm: 'terminals.view' },
    ] },
    { title: '机房巡检', items: [
      { path: 'bigscreen', icon: 'monitor', label: '监控大屏', perm: 'screen.view' },
      { path: 'devices', icon: 'server', label: '设备台账', perm: 'devices.view' },
      { path: 'reports', icon: 'report', label: '巡检报告', perm: 'inspection.view' },
      { path: 'netflow', icon: 'activity', label: '流量监控', perm: 'netflow.view' },
    ] },
    { title: '系统管理', items: [
      { path: 'users', icon: 'users', label: '用户管理', perm: 'users.manage' },
      { path: 'roles', icon: 'key', label: '角色权限', perm: 'roles.manage' },
      { path: 'logs', icon: 'list', label: '操作日志', perm: 'logs.view' },
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
    bookmarks: 'bookmarks.view',
    ipam: 'ipam.view',
    terminals: 'terminals.view',
    bigscreen: 'screen.view',
    devices: 'devices.view',
    reports: 'inspection.view',
    netflow: 'netflow.view',
    users: 'users.manage',
    roles: 'roles.manage',
    logs: 'logs.view',
  };

  // 顶栏面包屑用的页面名。键与 VIEW_PERM 保持一致，漏了的走兜底文案。
  const VIEW_TITLE = {
    dashboard: '工作台',
    contracts: '合同台账',
    remind: '到期提醒',
    issues: '问题记录',
    issue: '问题详情',
    docs: '技术文档',
    doc: '文档预览',
    bookmarks: '网页书签',
    ipam: 'IP 管理',
    terminals: '终端资产',
    bigscreen: '监控大屏',
    devices: '设备台账',
    reports: '巡检报告',
    netflow: '流量监控',
    users: '用户管理',
    roles: '角色权限',
    logs: '操作日志',
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

  // 包装 setUser 让登录态响应式（只包一次 —— 老版本底部又包了一遍，属重复代码）
  const origSetUser = api.setUser.bind(api);
  api.setUser = function (u, t) {
    origSetUser(u, t);
    userState.user = u;
  };

  /* 主题：'dark' | 'light'。html 上的 data-theme 是 tokens.css 唯一认的开关。
     index.html 里已有一段内联脚本在首次绘制前把值写好（防闪白），
     这里只负责运行期切换 —— 两者读同一个 localStorage 键。 */
  function readTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      return t === 'light' ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  // 统一筛选输入：去掉首尾空格，并去掉「像空格的」控制字符
  function q1(s) { return String(s == null ? '' : s).trim(); }
  function two(n) { return (n < 10 ? '0' : '') + n; }
  const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

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
              <div class="logo-sub">IT Console</div>
            </div>
          </div>
          <nav class="sidebar-menu">
            <template v-for="g in menuGroups" :key="g.title">
              <div class="nav-group-title">{{ g.title }}</div>
              <div v-for="it in g.items" :key="it.path" class="menu-item sub"
                   :class="{active: isActive(it)}" @click="go(it.path)">
                <span class="menu-icon" v-html="ic(it.icon)"></span>
                <span class="menu-label">{{ it.label }}</span>
                <span v-if="it.badge" class="menu-badge">{{ it.badge }}</span>
              </div>
            </template>

            <div class="nav-group-title">账号</div>
            <div class="menu-item sub" @click="openPwd">
              <span class="menu-icon" v-html="ic('lock')"></span>
              <span class="menu-label">修改密码</span>
            </div>
          </nav>
          <div class="sidebar-user">
            <div class="user-row">
              <div class="avatar">{{ (u.real_name || u.username).slice(0,1) }}</div>
              <div class="user-info">
                <div class="uname">{{ u.real_name || u.username }}</div>
                <div class="urole">{{ roleName }}</div>
              </div>
              <button class="logout-btn" title="退出登录" @click="logout" v-html="ic('power')"></button>
            </div>
          </div>
        </aside>

        <main class="main">
          <div class="topbar">
            <div class="breadcrumb">
              <span>信息科</span>
              <span class="sep-i">/</span>
              <b>{{ curTitle }}</b>
            </div>
            <div class="topbar-right">
              <button class="icon-btn" title="全站检索（Ctrl+K）" @click="openPalette" v-html="ic('search')"></button>
              <button class="alarm-pill" v-if="alarmCount" @click="goAlerts"
                      :title="alarmTip">
                <span v-html="ic('warn')"></span>
                <b>{{ alarmCount }}</b>
                <span>流量突发待确认</span>
              </button>
              <div class="topbar-clock" title="本机时间">
                {{ clockTime }}<i>{{ clockDate }}</i>
              </div>
              <button class="icon-btn" :title="themeTip" @click="toggleTheme"
                      v-html="ic(theme === 'dark' ? 'sun' : 'moon')"></button>
            </div>
          </div>
          <div class="content">
            <component :is="curView"></component>
          </div>
        </main>
      </div>

      <div class="palette-mask" v-if="pal.open" @click.self="closePalette">
        <div class="palette">
          <input class="palette-input" ref="palInput" v-model="pal.q"
                 @input="onPalInput" @keydown.down.prevent="palMove(1)"
                 @keydown.up.prevent="palMove(-1)" @keydown.enter.prevent="palEnter"
                 placeholder="搜索问题标题/单号、合同名称/编号、文档标题、设备名称/IP">
          <div class="palette-list">
            <div v-for="(h, i) in palItems" :key="h.key" class="palette-item"
                 :class="{'is-on': i === pal.on}" @click="palGo(h)" @mousemove="pal.on = i">
              <span class="palette-kind">{{ h.kind }}</span>
              <span class="palette-main">
                <span class="palette-title">{{ h.title }}</span>
                <span class="palette-sub">{{ h.sub }}</span>
              </span>
            </div>
            <div v-if="pal.loading" class="palette-empty">检索中…</div>
            <div v-else-if="pal.q && !palItems.length" class="palette-empty">没有匹配的记录</div>
          </div>
          <div class="palette-hint">
            <span><kbd>↑</kbd> <kbd>↓</kbd> 选择</span>
            <span><kbd>Enter</kbd> 打开</span>
            <span><kbd>Esc</kbd> 关闭</span>
            <span>留空时列出可直达的页面</span>
          </div>
        </div>
      </div>

      <div class="modal-mask" v-if="showPwd">
        <div class="modal modal-sm">
          <div class="modal-head">修改密码 <span class="modal-close" @click="tryClosePwd" v-html="ic('x')"></span></div>
          <div class="modal-body">
            <div class="form-item"><label>原密码</label><input type="password" v-model="pf.old"></div>
            <div class="form-item"><label>新密码（至少 6 位）</label><input type="password" v-model="pf.next"></div>
            <div class="form-item"><label>确认新密码</label><input type="password" v-model="pf.next2"></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryClosePwd">取消</button>
            <button class="btn btn-primary" @click="savePwd">保存</button>
          </div>
        </div>
      </div>

      <div class="toast-wrap">
        <div v-for="t in toasts" :key="t.id" :class="'toast ' + (t.type || '')">{{ t.msg }}</div>
      </div>
    </div>`,

    data() {
      return {
        toasts: [],
        showPwd: false,
        pf: { old: '', next: '', next2: '' },
        pfBase: '',
        theme: readTheme(),
        now: Date.now(),
        alarmCount: 0,
        // 定时器句柄。★ 绝不能写成 _clockTimer 这种下划线开头：Vue 3 里
        // 「_ 前缀的 data 键」是保留给内部属性的，不会代理到实例上，
        // 于是 this._clockTimer 永远读到 undefined，定时器一次都清不掉。
        clockTimer: null,
        alarmTimer: null,
        palTimer: null,
        palSeq: 0,
        pal: { open: false, q: '', hits: [], on: 0, loading: false },
      };
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
      curTitle() {
        const p = routeState.path;
        if (p === 'issue' && routeState.id && routeState.id !== 'new') return '问题详情';
        return VIEW_TITLE[p] || '工作台';
      },
      // 按权限过滤菜单：没有权限的分组整组隐藏，不留空标题
      menuGroups() {
        const alarms = this.alarmCount;
        return MENU.map((g) => ({
          title: g.title,
          items: g.items.filter((it) => can(it.perm)).map((it) => Object.assign({}, it, {
            // 侧栏「流量监控」上挂未确认突发数：这是导航里唯一有「状态」含义的入口
            badge: (it.path === 'netflow' && alarms) ? alarms : 0,
          })),
        })).filter((g) => g.items.length > 0);
      },
      clockTime() {
        const d = new Date(this.now);
        return two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
      },
      clockDate() {
        const d = new Date(this.now);
        return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + WEEK[d.getDay()];
      },
      themeTip() { return this.theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'; },
      alarmTip() {
        return '有 ' + this.alarmCount + ' 条流量突发未确认，点击查看流量监控';
      },
      // 命令面板列表：有关键词用后端检索结果，空关键词给一份「页面直达」清单
      // —— 否则 Ctrl+K 打开是空的，用户还得先想一个关键词才知道能不能用。
      palItems() {
        if (this.pal.q) return this.pal.hits;
        const out = [];
        MENU.forEach((g) => g.items.forEach((it) => {
          if (can(it.perm)) out.push({ key: 'nav:' + it.path, kind: '页面', title: it.label, sub: g.title, go: '#/' + it.path });
        }));
        out.push({ key: 'nav:pwd', kind: '操作', title: '修改密码', sub: '账号', go: '__pwd__' });
        return out;
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
        // 资源管理：bookmark-view → camelize 得 bookmarkView → capitalize 得 BookmarkView ✓
        // （写成 bookmarkview / bookmark_view 都还原不出 BookmarkView，会渲染成空白自定义标签）
        if (p === 'bookmarks') return 'bookmark-view';
        if (p === 'ipam') return 'ipam-view';
        // 终端资产：TerminalView → terminal-view ✓（camelize 得 terminalView，capitalize 得 TerminalView）
        if (p === 'terminals') return 'terminal-view';
        return 'dashboard-view';
      },
    },

    methods: {
      ic,
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

      /* ---------- 主题 ---------- */
      applyTheme(t) {
        this.theme = t;
        document.documentElement.setAttribute('data-theme', t);
        try { localStorage.setItem(THEME_KEY, t); } catch (e) { /* 隐私模式忽略 */ }
      },
      toggleTheme() { this.applyTheme(this.theme === 'dark' ? 'light' : 'dark'); },

      /* ---------- 时钟 ---------- */
      tickClock() { this.now = Date.now(); },

      /* ---------- 顶栏告警：读已有的流量告警接口，不新增后端路由 ---------- */
      async loadAlarms() {
        if (!can('netflow.view')) { this.alarmCount = 0; return; }
        try {
          const d = await api.get('/inspection/netflow/alerts?unack=1&limit=100');
          const items = (d && d.items) || [];
          this.alarmCount = items.length;
        } catch (e) {
          // 静默：告警数拿不到不该让顶栏报错刷屏，巡检模块本身有独立的降级提示
          this.alarmCount = 0;
        }
      },
      goAlerts() {
        if (!can('netflow.view')) { this.toast('没有流量监控查看权限', 'err'); return; }
        if (routeState.path !== 'netflow') location.hash = '#/netflow';
      },

      /* ---------- 命令面板 ---------- */
      openPalette() {
        this.pal.open = true;
        this.pal.on = 0;
        const self = this;
        this.$nextTick(function () {
          const el = self.$refs.palInput;
          if (el && el.focus) el.focus();
        });
      },
      closePalette() {
        this.pal.open = false;
        this.palSeq++;              // 作废在途检索，防止关掉后结果又填回来
        if (this.palTimer) { clearTimeout(this.palTimer); this.palTimer = null; }
        this.pal.loading = false;
      },
      onKeydown(e) {
        // Ctrl+K / ⌘K 开关命令面板
        if ((e.ctrlKey || e.metaKey) && String(e.key || '').toLowerCase() === 'k') {
          e.preventDefault();
          if (this.pal.open) this.closePalette(); else this.openPalette();
          return;
        }
        if (e.key === 'Escape' && this.pal.open) this.closePalette();
      },
      onPalInput() {
        if (this.palTimer) { clearTimeout(this.palTimer); this.palTimer = null; }
        const q = q1(this.pal.q);
        if (!q) {
          // 清空输入 → 立刻回到「页面直达」清单，不用等防抖
          this.palSeq++;
          this.pal.hits = [];
          this.pal.loading = false;
          this.pal.on = 0;
          return;
        }
        this.pal.loading = true;
        const self = this;
        this.palTimer = setTimeout(function () { self.runPalSearch(); }, 280);
      },
      // 检索全部走已有接口，各自独立 catch —— 某一个模块挂了不影响其它模块出结果
      async runPalSearch() {
        const q = q1(this.pal.q);
        if (!q) return;
        const seq = ++this.palSeq;
        const kw = encodeURIComponent(q);
        const jobs = [];

        if (can('issues.view')) {
          jobs.push(api.get('/issues?keyword=' + kw + '&pageSize=6').then(function (d) {
            return (((d || {}).list) || []).map(function (r) {
              return {
                key: 'iss:' + r.id, kind: '问题',
                title: r.title || '(无标题)',
                sub: [r.no, r.department, r.reporter, r.report_time].filter(Boolean).join(' · '),
                go: '#/issue/' + r.id,
              };
            });
          }).catch(function () { return []; }));
        }
        if (can('contracts.view')) {
          jobs.push(api.get('/contracts?keyword=' + kw + '&pageSize=5').then(function (d) {
            return (((d || {}).list) || []).map(function (r) {
              return {
                key: 'con:' + r.id, kind: '合同',
                title: r.title || '(无标题)',
                sub: [r.contract_no, r.party_b, r.end_date ? ('到期 ' + r.end_date) : ''].filter(Boolean).join(' · '),
                // 合同详情是列表页内的弹窗（没有 #/contract/:id 路由），
                // 所以这里落到台账页，由用户在列表里继续操作
                go: '#/contracts',
              };
            });
          }).catch(function () { return []; }));
        }
        if (can('docs.view')) {
          jobs.push(api.get('/docs?keyword=' + kw + '&pageSize=5').then(function (d) {
            return (((d || {}).list) || []).map(function (r) {
              return {
                key: 'doc:' + r.id, kind: '文档',
                title: r.title || r.original_name || '(无标题)',
                sub: [r.ext, r.category_name, r.uploader_name, r.created_at].filter(Boolean).join(' · '),
                go: '#/doc/' + r.id,
              };
            });
          }).catch(function () { return []; }));
        }
        if (can('devices.view')) {
          jobs.push(api.get('/inspection/devices?kw=' + kw).then(function (d) {
            return (((d || {}).items) || []).map(function (r) {
              return {
                key: 'dev:' + r.id, kind: '设备',
                title: r.name || '(未命名)',
                sub: [r.host, r.os, r.location].filter(Boolean).join(' · '),
                go: '#/devices',
              };
            });
          }).catch(function () { return []; }));
        }

        const out = await Promise.all(jobs);
        // ★ 旧轮次的结果必须丢弃：用户连打几个字时，先发的请求可能后到，
        //   不做这个判断的话，列表会停在「上一个关键词」的结果上。
        if (seq !== this.palSeq) return;
        let hits = [];
        out.forEach(function (arr) { hits = hits.concat(arr); });
        this.pal.hits = hits.slice(0, 24);
        this.pal.on = 0;
        this.pal.loading = false;
      },
      palMove(step) {
        const n = this.palItems.length;
        if (!n) return;
        let i = this.pal.on + step;
        if (i < 0) i = n - 1;
        if (i >= n) i = 0;
        this.pal.on = i;
      },
      palEnter() {
        const h = this.palItems[this.pal.on];
        if (h) this.palGo(h);
      },
      palGo(h) {
        if (!h) return;
        this.closePalette();
        if (h.go === '__pwd__') { this.openPwd(); return; }
        if (h.go && location.hash !== h.go) location.hash = h.go;
      },

      /* ---------- 账号 ---------- */
      openPwd() {
        this.pf = { old: '', next: '', next2: '' };
        this.showPwd = true;
        this.pfBase = HisUI.snap(this.pf, PWD_KEYS);
      },
      /** 关闭改密码窗口：密码已填了一两个框时提醒一句，别让人白敲一遍 */
      tryClosePwd() {
        if (HisUI.dirty(this.pf, this.pfBase, PWD_KEYS) && !HisUI.confirmDiscard()) return;
        this.showPwd = false;
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
        this.loadAlarms();
      },
    },

    mounted() {
      this.tickClock();
      this.clockTimer = setInterval(() => this.tickClock(), 1000);
      // 告警数 60s 拉一次。巡检大屏是 15s、流量监控是 5 分钟 ——
      // 顶栏只是个提示位，跟着最慢的那个节奏走就够了，不必更勤。
      this.loadAlarms();
      this.alarmTimer = setInterval(() => this.loadAlarms(), 60000);
      document.addEventListener('keydown', this.onKeydown);

      // 已登录（localStorage 恢复）时拉取最新分类/模块清单（含自定义项）
      if (api.user && window.loadHisModules) window.loadHisModules();
      if (api.user && window.HisPerm) {
        // 老会话（浏览器里缓存的用户信息还没有 perms 字段）自动补拉一次真实权限。
        // 不做这一步的话，升级后所有已登录用户会看到空菜单 —— 会被当成"系统坏了"。
        window.HisPerm.refresh().then(() => this.ensureRouteAllowed());
      }
    },

    beforeUnmount() {
      if (this.clockTimer) clearInterval(this.clockTimer);
      if (this.alarmTimer) clearInterval(this.alarmTimer);
      if (this.palTimer) clearTimeout(this.palTimer);
      document.removeEventListener('keydown', this.onKeydown);
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
  // 资源管理：网页书签 + IP 管理 + 终端资产。同样禁止「有就注册、没有静默跳过」——
  // 少一个文件时页面会整块空白，而 prod 构建不会有任何提示。
  ['BookmarkView', 'IpamView', 'TerminalView'].forEach((n) => {
    if (V[n]) {
      app.component(n, V[n]);
    } else {
      console.error('[main.js] 资源管理组件缺失，未注册：' + n + '（对应页面会显示空白）');
    }
  });

  app.mount('#app');
})();
