/* 视图组件集合（挂载到 window.HisViews） */
(function () {
  // 一级分类 + 二级模块（默认预置，登录后从 /api/issues/modules 拉取「预置+自定义」合并清单）
  const DEFAULT_CATEGORIES = ['日常软件', '日常硬件', '政策性接口'];
  const DEFAULT_SUB = {
    '日常软件': [
      'HIS系统', 'HIS系统/PACS系统', '自助机/HIS系统', 'LIS系统',
      '门诊医生系统', '门诊医生工作站', '门诊收费系统', '门诊收费系统/PACS系统', '门诊药房系统',
      '住院系统', '住院医生系统', '住院护士系统', '药库系统',
      '职检系统', '体检系统', '手麻系统', '物资系统', '健康通',
      '报卡系统', '报卡更新', '传染病接口', '医保接口',
      '基础数据', '报表系统', '新增报表', '格式调整', '其他',
    ],
    '日常硬件': ['其他'],
    '政策性接口': ['医保接口', '传染病接口', '其他'],
  };
  const moduleStore = Vue.reactive({
    categories: [...DEFAULT_CATEGORIES],
    sub: JSON.parse(JSON.stringify(DEFAULT_SUB)),
  });
  window.HisModules = moduleStore;
  window.loadHisModules = async function () {
    try {
      const d = await api.get('/issues/modules');
      if (d && Array.isArray(d.categories) && d.categories.length) moduleStore.categories = d.categories;
      if (d && d.subModules) {
        // 合并而非整体替换，保留本会话临时新增
        const merged = {};
        for (const c of moduleStore.categories) {
          merged[c] = Array.from(new Set([...(moduleStore.sub[c] || []), ...(d.subModules[c] || [])]));
        }
        moduleStore.sub = merged;
      }
    } catch (e) { /* 未登录或网络异常时静默，沿用默认 */ }
  };
  const moduleListOf = (cat) => moduleStore.sub[cat] || [];
  const URGENCY = ['低', '中', '高', '紧急'];
  const STATUS = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
  const STATUS_TAG = { pending: 'tag-pending', processing: 'tag-processing', resolved: 'tag-resolved', closed: 'tag-closed' };
  const URGENCY_TAG = { 低: 'tag-u0', 中: 'tag-u1', 高: 'tag-u2', 紧急: 'tag-u3' };
  const ROLE = { 1: '管理员', 2: '工程师', 3: '报障人' };
  const V = {};

  const fmtDate = (s) => {
    if (!s) return '';
    return String(s).replace('T', ' ').slice(0, 16);
  };
  const todayStr = () => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const fmtSize = (n) => {
    n = Number(n) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  };

  /* ---- 合同模块工具 ---- */
  const fmtMoney = (n) => {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return Number(n).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  };
  const statusTag = (s) => {
    const map = { '进行中': 'tag-run', '已完成': 'tag-done', '已终止': 'tag-stop', '草稿': 'tag-draft' };
    return map[s] || 'tag-draft';
  };
  const daysLeft = (d) => {
    if (!d) return null;
    const t = new Date(d + 'T00:00:00').getTime();
    const now = new Date().setHours(0, 0, 0, 0);
    return Math.round((t - now) / 86400000);
  };

  /* ============ 登录 ============ */
  V.LoginView = {
    template: `
    <div class="login-wrap">
      <div class="login-card">
        <div class="login-logo">医信</div>
        <div class="login-title">医院信息科日常管理系统</div>
        <div class="login-sub">合同台账 · 问题记录 · 统一管理</div>
        <div class="form-item">
          <label>用户名</label>
          <input v-model="username" placeholder="请输入用户名" @keyup.enter="doLogin">
        </div>
        <div class="form-item">
          <label>密码</label>
          <input type="password" v-model="password" placeholder="请输入密码" @keyup.enter="doLogin">
        </div>
        <button class="btn btn-primary btn-block" :disabled="loading" @click="doLogin">
          {{ loading ? '登录中...' : '登 录' }}
        </button>
      </div>
    </div>`,
    data() {
      return { username: '', password: '', loading: false };
    },
    methods: {
      async doLogin() {
        if (!this.username || !this.password) return this.$toast('请输入用户名和密码', 'err');
        this.loading = true;
        try {
          const d = await this.$api.post('/auth/login', { username: this.username, password: this.password });
          this.$api.setUser(d.user, d.token);
          if (window.loadHisModules) window.loadHisModules();
          this.$toast('登录成功', 'ok');
          location.hash = '#/dashboard';
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
      },
    },
  };

/* ==================== 仪表盘（合同 + 问题双标签） ==================== */
  V.DashboardView = {
    template: `
    <div>
      <div class="page-title">工作台</div>
      <div class="page-sub">医院信息科日常管理总览 · {{ todayStr }}</div>
      <div class="dash-tabs">
        <button class="dash-tab" :class="{active: tab==='contract'}" @click="switchTab('contract')">📄 合同台账</button>
        <button class="dash-tab" :class="{active: tab==='issue'}" @click="switchTab('issue')">🗂️ 问题记录</button>
      </div>

      <!-- ===== 合同面板 ===== -->
      <div v-if="tab==='contract'">
        <div class="remind-bar" v-if="cd && (cd.overdue + cd.expiring) > 0">
          <strong>到期提醒：</strong>
          <span v-if="cd.overdue > 0">{{ cd.overdue }} 份合同已过期，</span>
          <span>{{ cd.expiring }} 份合同将在 30 天内到期。</span>
          <a @click="goRemind" style="margin-left:8px;cursor:pointer">查看明细 →</a>
        </div>
        <div class="stat-grid">
          <div class="stat-card"><div class="num">{{ cd ? cd.total : '-' }}</div><div class="lbl">合同总数</div><div class="bar bar-blue"></div></div>
          <div class="stat-card"><div class="num">{{ cd ? cd.active : '-' }}</div><div class="lbl">进行中</div><div class="bar bar-amber"></div></div>
          <div class="stat-card"><div class="num">￥{{ cd ? fmtMoney(cd.totalAmount) : '-' }}</div><div class="lbl">合同总额</div><div class="bar bar-blue"></div></div>
          <div class="stat-card"><div class="num" style="color:#16a34a">￥{{ cd ? fmtMoney(cd.paidAmount) : '-' }}</div><div class="lbl">已付款</div><div class="bar bar-green"></div></div>
          <div class="stat-card"><div class="num" style="color:var(--danger)">￥{{ cd ? fmtMoney(cd.unpaidAmount) : '-' }}</div><div class="lbl">未付款</div><div class="bar bar-red"></div></div>
          <div class="stat-card warn"><div class="num">{{ cd ? (cd.overdue + cd.expiring) : '-' }}</div><div class="lbl">30天内到期/已过期</div><div class="bar bar-amber"></div></div>
        </div>
        <div class="detail-grid">
          <div>
            <div class="card">
              <div class="card-title">近 12 个月新增合同</div>
              <div v-if="!cd || !cd.monthly || !cd.monthly.length" class="file-empty">暂无数据</div>
              <div v-else style="display:flex;align-items:flex-end;gap:6px;height:150px;overflow-x:auto">
                <div v-for="m in cd.monthly" :key="m.ym" style="text-align:center;min-width:48px">
                  <div style="font-size:11px;color:#475569;margin-bottom:3px">{{ m.c }}</div>
                  <div :style="{height:Math.max(2,(m.c / cMonthlyMax * 110))+'px',background:'#2563eb',borderRadius:'3px 3px 0 0'}"></div>
                  <div style="font-size:10px;color:#94a3b8;margin-top:3px">{{ m.ym.slice(2) }}</div>
                </div>
              </div>
            </div>
          </div>
          <div>
            <div class="card">
              <div class="card-title">合同分类分布</div>
              <div v-if="!cd || !cd.categories || !cd.categories.length" class="file-empty">暂无分类数据</div>
              <div class="dist-row" v-for="c in (cd ? cd.categories : [])" :key="c.category">
                <div class="nm" :title="c.category">{{ c.category }}</div>
                <div class="dist-track"><div class="dist-fill" :style="{ width: pctC(c.count, cd.total) }"></div></div>
                <div class="dist-cnt">{{ c.count }} 份</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ===== 问题面板 ===== -->
      <div v-if="tab==='issue'">
        <div class="stat-grid">
          <div class="stat-card"><div class="num">{{ d.total }}</div><div class="lbl">问题总数</div><div class="bar bar-blue"></div></div>
          <div class="stat-card"><div class="num">{{ d.today }}</div><div class="lbl">今日新增</div><div class="bar bar-red"></div></div>
          <div class="stat-card"><div class="num">{{ d.pending }}</div><div class="lbl">待处理</div><div class="bar bar-amber"></div></div>
          <div class="stat-card"><div class="num">{{ d.processing }}</div><div class="lbl">处理中</div><div class="bar bar-blue"></div></div>
          <div class="stat-card"><div class="num">{{ d.resolved + d.closed }}</div><div class="lbl">已解决 / 已关闭</div><div class="bar bar-green"></div></div>
        </div>
        <div class="card" style="margin-bottom:16px">
          <div class="card-title">近 1 个月每日问题数量（按问题记录时间）</div>
          <div class="trend-wrap">
            <div class="trend-col" v-for="t in d.daily" :key="t.d" :title="t.d + ' 记录 ' + t.c + ' 条'">
              <div class="trend-num" v-if="t.c">{{ t.c }}</div>
              <div class="trend-bar" :style="{ height: trendH(t.c) }"></div>
              <div class="trend-day" :class="{ lit: t.c > 0 }">{{ (t.d || '').slice(5) }}</div>
            </div>
          </div>
        </div>
        <div class="detail-grid">
          <div>
            <div class="card">
              <div class="card-title">最近动态</div>
              <div class="timeline">
                <div class="tl-item tl-main" v-for="r in d.recent" :key="r.id">
                  <div class="tl-dot"></div>
                  <div class="tl-head">
                    <span class="link" @click="goIssue(r.issue_id)">{{ r.no }}</span>
                    · {{ r.action }}
                  </div>
                  <div class="tl-meta">{{ r.operator_name }} · {{ fmt(r.created_at) }}</div>
                  <div class="tl-body" v-if="r.content">{{ r.content }}</div>
                </div>
                <div class="file-empty" v-if="!d.recent || !d.recent.length">暂无动态</div>
              </div>
            </div>
          </div>
          <div>
            <div class="card">
              <div class="card-title">按分类分布</div>
              <div class="dist-row" v-for="m in d.byCategory" :key="m.category">
                <div class="nm" :title="m.category">{{ m.category }}</div>
                <div class="dist-track"><div class="dist-fill" :style="{ width: pct(m.c) }"></div></div>
                <div class="dist-cnt">{{ m.c }}</div>
              </div>
              <div class="file-empty" v-if="!d.byCategory || !d.byCategory.length">暂无数据</div>
            </div>
            <div class="card">
              <div class="card-title">按紧急程度</div>
              <div class="dist-row" v-for="u in d.byUrgency" :key="u.urgency">
                <div class="nm"><span :class="URGENCY_TAG[u.urgency]" class="tag">{{ u.urgency }}</span></div>
                <div class="dist-track"><div class="dist-fill" :style="{ width: pct(u.c), background: ucolor(u.urgency) }"></div></div>
                <div class="dist-cnt">{{ u.c }}</div>
              </div>
              <div class="file-empty" v-if="!d.byUrgency || !d.byUrgency.length">暂无数据</div>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return { d: {}, cd: null, tab: 'contract', URGENCY_TAG, maxCnt: 1, cMonthlyMax: 1 };
    },
    computed: {
      todayStr() {
        const x = new Date();
        return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
      },
    },
    methods: {
      fmt: (s) => fmtDate(s),
      fmtMoney,
      pct(c) {
        c = Number(c) || 0;
        const max = Math.max(this.maxCnt, 1);
        return Math.max(2, Math.round((c / max) * 100)) + '%';
      },
      pctC(c, total) {
        c = Number(c) || 0;
        total = Number(total) || 1;
        return Math.max(2, Math.min(100, Math.round((c / total) * 100))) + '%';
      },
      trendH(c) {
        c = Number(c) || 0;
        const max = Math.max(...(this.d.daily || []).map((t) => t.c), 1);
        return Math.max(3, Math.round((c / max) * 100)) + '%';
      },
      ucolor(u) {
        return { 低: '#94a3b8', 中: '#0e7490', 高: '#d97706', 紧急: '#dc2626' }[u] || '#1f6de8';
      },
      goIssue(id) { location.hash = '#/issue/' + id; },
      goRemind() { location.hash = '#/remind'; },
      switchTab(t) {
        this.tab = t;
        if (t === 'contract' && !this.cd) this.loadContract();
        if (t === 'issue' && (!this.d || !this.d.total)) this.loadIssue();
      },
      async loadContract() {
        try {
          const cd = await this.$api.get('/api/dashboard/contracts');
          this.cd = cd;
          this.cMonthlyMax = Math.max(...(cd.monthly || []).map((m) => m.c), 1);
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async loadIssue() {
        try {
          const d = await this.$api.get('/api/dashboard/issues');
          this.maxCnt = Math.max(...(d.byCategory || []).map((m) => m.c), 1);
          this.d = d;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
    },
    async mounted() {
      this.tab = 'contract';
      await this.loadContract();
      await this.loadIssue();
    },
  };

  /* ==================== 问题列表 ==================== */
  V.IssuesView = {
    template: `
    <div>
      <div class="page-title">问题记录</div>
      <div class="page-sub">全部 HIS 系统问题工单 · 共 {{ total }} 条</div>
      <div class="filter-bar">
        <input class="grow" v-model="f.kw" placeholder="搜索标题 / 单号 / 科室 / 报障人 / 内容" @keyup.enter="goPage(1)">
        <select v-model="f.status" @change="goPage(1)">
          <option value="">全部状态</option>
          <option v-for="(t, k) in STATUS" :value="k">{{ t }}</option>
        </select>
        <select v-model="f.urgency" @change="goPage(1)">
          <option value="">全部紧急度</option>
          <option v-for="u in URGENCY" :value="u">{{ u }}</option>
        </select>
        <select v-model="f.module" @change="goPage(1)">
          <option value="">全部模块</option>
          <option v-if="f.category" value="__none__">（不细分）</option>
          <option v-for="m in moduleListOf(f.category)" :value="m">{{ m }}</option>
        </select>
        <select v-model="f.year" @change="goPage(1)">
          <option value="">全部年份</option>
          <option v-for="y in years" :key="y" :value="y">{{ y }} 年</option>
        </select>
        <select v-model="f.month" @change="goPage(1)">
          <option value="">全部月份</option>
          <option v-for="m in months" :key="m" :value="m">{{ Number(m) }} 月</option>
        </select>
        <button class="btn btn-primary" @click="goPage(1)">查 询</button>
        <button class="btn btn-outline" @click="exportExcel" :disabled="exporting">{{ exporting ? '导出中…' : '导出Excel' }}</button>
        <button class="btn btn-outline" @click="openImport">导入</button>
        <button class="btn btn-outline" @click="newIssue">+ 新建问题</button>
      </div>
      <div class="cat-bar">
        <button class="cat-btn" :class="{active: !f.category}" @click="setCat('')">全部</button>
        <button class="cat-btn" v-for="c in mods.categories" :key="c" :class="{active: f.category === c}" @click="setCat(c)">{{ c }}</button>
      </div>
      <div class="batch-bar card" v-if="canBatch" style="padding:12px 16px;margin-bottom:12px;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
        <span style="font-size:13px;color:var(--text)">已选 <b>{{ selectedIds.length }}</b> 条</span>
        <select v-model="batchStatus" style="min-width:110px">
          <option value="">选择目标状态…</option>
          <option value="processing">→ 处理中</option>
          <option value="resolved">→ 已解决</option>
          <option value="closed">→ 已关闭</option>
          <option value="pending">→ 待处理（退回/重开）</option>
        </select>
        <input v-model="batchNote" placeholder="批量备注（可选，写入每条处理流程）" style="flex:1;min-width:180px;padding:8px 10px;border:1px solid var(--border);border-radius:8px">
        <button class="btn btn-primary btn-sm" :disabled="!selectedIds.length || !batchStatus || batchSaving" @click="doBatch">{{ batchSaving ? '提交中…' : '批量修改状态' }}</button>
        <button class="btn btn-ghost btn-sm" @click="clearSel">取消选择</button>
      </div>
      <div class="card">
        <div class="table-wrap">
          <table class="tbl iss-table">
            <thead>
              <tr>
                <th class="c-chk"><input type="checkbox" :checked="allChecked" @change="toggleAll" title="全选本页"></th>
                <th class="c-no">单号</th><th>标题</th><th class="c-cat">分类 / 模块</th>
                <th class="c-urg">紧急程度</th><th class="c-st">状态</th>
                <th class="c-user">报障科室 / 人</th><th class="c-assign">处理人</th>
                <th class="c-time">记录时间</th><th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="it in list" :key="it.id">
                <td><input type="checkbox" :value="it.id" v-model="selectedIds"></td>
                <td class="mono link" @click="open(it.id)">{{ it.no }}</td>
                <td><div class="iss-title link" :title="it.title" @click="open(it.id)">{{ it.title }}</div></td>
                <td><span class="cell-strong">{{ it.category }}</span><span class="cell-sub">{{ it.module || '-' }}</span></td>
                <td><span :class="URGENCY_TAG[it.urgency]" class="tag">{{ it.urgency }}</span></td>
                <td><span :class="STATUS_TAG[it.status]" class="tag">{{ it.status_text }}</span></td>
                <td><span class="cell-strong iss-dept">{{ it.department }}</span><span class="cell-sub">{{ it.reporter }}</span></td>
                <td>{{ it.assignee_name || '-' }}</td>
                <td class="mono">{{ fmt(it.report_time) }}</td>
                <td class="ops">
                  <div class="row-actions"><button class="btn btn-ghost btn-sm" @click="open(it.id)">详情</button></div>
                </td>
              </tr>
              <tr v-if="!list.length"><td colspan="10" class="empty-row">暂无问题记录</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span class="btn-info">第 {{ page }} / {{ pageCount }} 页，共 {{ total }} 条</span>
          <select v-model.number="pageSize" @change="goPage(1)" title="每页显示条数">
            <option :value="10">10 条/页</option>
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
          </select>
          <button :disabled="page<=1" @click="goPage(page-1)">上一页</button>
          <button v-for="p in pages" :key="p" :class="{active:p===page}" @click="goPage(p)">{{ p }}</button>
          <button :disabled="page>=pageCount" @click="goPage(page+1)">下一页</button>
        </div>
      </div>

      <!-- Excel 导入弹窗 -->
      <div class="modal-mask" v-if="importOpen" @click.self="importOpen=false">
        <div class="modal" style="width:520px">
          <div class="modal-head"><h3>Excel 导入</h3><span class="x" @click="importOpen=false">✕</span></div>
          <div class="modal-body">
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e40af">
              第一次使用？请先 <a @click="downloadTemplate" style="cursor:pointer;text-decoration:underline;font-weight:600">下载导入模板</a>
              ，按模板列填写后上传。重复的问题（单号已存在或同记录日期同标题）会自动跳过，不会重复导入。
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <input type="file" accept=".xlsx,.xls" @change="onImportFile" style="font-size:13px;flex:1;min-width:180px">
              <button class="btn btn-primary btn-sm" :disabled="importing || !importFile" @click="doImport">{{ importing ? '导入中…' : '开始导入' }}</button>
            </div>
            <div v-if="importResult" style="margin-top:16px">
              <div style="padding:10px 14px;border-radius:8px;font-size:13px" :class="importResult.failed.length ? 'imp-warn' : 'imp-ok'">
                导入完成：成功 <b>{{ importResult.success }}</b> 条，跳过 <b>{{ importResult.skipped.length }}</b> 条，失败 <b>{{ importResult.failed.length }}</b> 条（共 {{ importResult.total }} 行）
              </div>
              <div v-if="importResult.failed.length || importResult.skipped.length" style="max-height:220px;overflow-y:auto;margin-top:10px">
                <table class="tbl">
                  <thead><tr><th>行号</th><th>标题</th><th>结果</th></tr></thead>
                  <tbody>
                    <tr v-for="f in importResult.failed" :key="'f'+f.row+String(f.title)"><td>{{ f.row }}</td><td>{{ f.title || '-' }}</td><td style="color:var(--danger)">失败：{{ f.reason }}</td></tr>
                    <tr v-for="s in importResult.skipped" :key="'s'+s.row+String(s.title)"><td>{{ s.row }}</td><td>{{ s.title }}</td><td class="muted">跳过：{{ s.reason }}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="importOpen=false">关闭</button>
          </div>
        </div>
      </div>
    </div>`,
      data() {
      return {
        STATUS, STATUS_TAG, URGENCY_TAG, URGENCY, mods: moduleStore,
        list: [], total: 0, page: 1, pageSize: 10,
        f: { status: '', urgency: '', category: '', module: '', kw: '', year: '', month: '' },
        years: [], months: ['01','02','03','04','05','06','07','08','09','10','11','12'],
        selectedIds: [], batchStatus: '', batchNote: '', batchSaving: false, batchResult: null,
        importOpen: false, importFile: null, importing: false, importResult: null, exporting: false,
      };
    },
    computed: {
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
      canBatch() { const u = window.HisUser && window.HisUser.user; return u && (u.role_id === 1 || u.role_id === 2); },
      allChecked() { return this.list.length > 0 && this.list.every((it) => this.selectedIds.includes(it.id)); },
      pages() {
        const pc = this.pageCount, p = this.page, arr = [];
        const s = Math.max(1, p - 2), e = Math.min(pc, p + 2);
        for (let i = s; i <= e; i++) arr.push(i);
        return arr;
      },
    },
    methods: {
      async load() {
        try {
          const q = new URLSearchParams({ page: this.page, pageSize: this.pageSize });
          if (this.f.kw) q.set('keyword', this.f.kw);
          if (this.f.status) q.set('status', this.f.status);
          if (this.f.category) q.set('category', this.f.category);
          if (this.f.module) q.set('module', this.f.module);
          if (this.f.urgency) q.set('urgency', this.f.urgency);
          if (this.f.year) q.set('year', this.f.year);
          if (this.f.month) q.set('month', this.f.month);
          const d = await this.$api.get('/issues?' + q.toString());
          this.list = d.list; this.total = d.total;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async loadYears() {
        try { this.years = await this.$api.get('/issues/meta/years'); } catch (e) {}
      },
      goPage(p) {
        if (p < 1 || p > this.pageCount) return;
        this.page = p; this.load();
      },
      open(id) { location.hash = '#/issue/' + id; },
      newIssue() { location.hash = '#/issue/new'; },
      // ---- Excel 导入导出 ----
      async exportExcel() {
        if (this.exporting) return;
        this.exporting = true;
        this.$toast('正在生成 Excel，请稍候…');
        try {
          const q = new URLSearchParams();
          if (this.f.kw) q.set('keyword', this.f.kw);
          if (this.f.status) q.set('status', this.f.status);
          if (this.f.urgency) q.set('urgency', this.f.urgency);
          if (this.f.category) q.set('category', this.f.category);
          if (this.f.module) q.set('module', this.f.module);
          if (this.f.year) q.set('year', this.f.year);
          if (this.f.month) q.set('month', this.f.month);
          const d = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const name = `问题记录_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.xlsx`;
          await this.$api.download('/excel-issues/export?' + q, name);
          this.$toast('导出完成，文件已开始下载');
        } catch (e) { this.$toast(e.message, 'err'); }
        this.exporting = false;
      },
      openImport() { this.importOpen = true; this.importFile = null; this.importResult = null; },
      async downloadTemplate() {
        this.$toast('正在生成模板，请稍候…');
        try {
          await this.$api.download('/excel-issues/template', '问题导入模板.xlsx');
          this.$toast('模板下载完成，请查看浏览器下载记录');
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      onImportFile(e) { this.importFile = e.target.files[0] || null; this.importResult = null; },
      async doImport() {
        if (!this.importFile) { this.$toast('请先选择 Excel 文件', 'err'); return; }
        this.importing = true;
        const fd = new FormData();
        fd.append('file', this.importFile);
        try {
          const token = localStorage.getItem('his_token');
          const resp = await fetch('/api/excel-issues/import', {
            method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd
          });
          const r = await resp.json();
          if (r.code !== 0) throw new Error(r.message);
          this.importResult = r.data;
          if (r.data.success) this.goPage(1);
        } catch (e) { this.$toast('导入失败：' + e.message, 'err'); }
        this.importing = false;
      },
      moduleListOf,
      setCat(c) {
        // 分类按钮：点击即筛选该分类；「全部」清空分类。切换时重置二级模块选择
        this.f.category = c || '';
        this.f.module = '';
        this.goPage(1);
      },
      toggleAll(ev) {
        if (ev.target.checked) {
          const ids = new Set(this.selectedIds);
          this.list.forEach((it) => ids.add(it.id));
          this.selectedIds = Array.from(ids);
        } else {
          const pageIds = this.list.map((it) => it.id);
          this.selectedIds = this.selectedIds.filter((x) => !pageIds.includes(x));
        }
      },
      clearSel() { this.selectedIds = []; this.batchStatus = ''; this.batchNote = ''; },
      async doBatch() {
        const target = { processing: '处理中', resolved: '已解决', closed: '已关闭', pending: '待处理' }[this.batchStatus];
        if (!confirm(`确认将选中的 ${this.selectedIds.length} 条问题批量变更为「${target}」？\n（状态不允许跳转的条目会自动跳过）`)) return;
        this.batchSaving = true;
        try {
          const r = await this.$api.post('/issues/batch/status', { ids: this.selectedIds, status: this.batchStatus, content: this.batchNote });
          let msg = r.message;
          if (r.skippedCount) {
            msg += '\n跳过明细：' + r.skipped.slice(0, 5).map((s) => `${s.no}（${s.reason}）`).join('；') + (r.skipped.length > 5 ? ` 等 ${r.skipped.length} 条` : '');
          }
          this.$toast(msg, r.okCount ? 'ok' : 'err');
          this.clearSel();
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); } finally { this.batchSaving = false; }
      },
      fmt: (s) => fmtDate(s),
    },
    mounted() { this.loadYears(); this.load(); },
  };

  /* ==================== 问题详情 ==================== */
  V.IssueDetailView = {
    template: `
    <div>
      <div style="margin-bottom:12px">
        <button class="btn btn-outline btn-sm" @click="goBack">← 返回列表</button>
        <button class="btn btn-outline btn-sm" style="margin-left:8px" @click="printPage">打印工单</button>
      </div>
      <div class="loading" v-if="!d">加载中...</div>
      <div class="detail-grid" v-else>
        <div class="detail-main">
          <div class="card">
            <div class="issue-head">
              <span class="page-title" style="font-size:18px">{{ d.issue.title }}</span>
              <span class="no">{{ d.issue.no }}</span>
              <span :class="STATUS_TAG[d.issue.status]" class="tag">{{ d.issue.status_text }}</span>
              <span :class="URGENCY_TAG[d.issue.urgency]" class="tag">{{ d.issue.urgency }}</span>
            </div>
            <div class="info-list">
              <div class="info-item"><div class="k">问题分类</div><div class="v">{{ d.issue.category || '日常软件' }}</div></div>
              <div class="info-item"><div class="k">二级模块</div><div class="v">{{ d.issue.module || '（不细分）' }}</div></div>
              <div class="info-item"><div class="k">报障科室</div><div class="v">{{ d.issue.department || '-' }}</div></div>
              <div class="info-item"><div class="k">报障人</div><div class="v">{{ d.issue.reporter || '-' }}</div></div>
              <div class="info-item"><div class="k">创建人</div><div class="v">{{ d.issue.created_by || '-' }}</div></div>
              <div class="info-item"><div class="k">问题记录时间</div><div class="v">{{ fmt(d.issue.report_time) }}</div></div>
              <div class="info-item"><div class="k">创建时间</div><div class="v">{{ fmt(d.issue.created_at) }}</div></div>
              <div class="info-item"><div class="k">处理人</div><div class="v">{{ d.issue.assignee_name || '未指派' }}</div></div>
            </div>
            <div class="section-block">
              <div class="sec-title">问题描述</div>
              <div class="sep">{{ d.issue.content || '（无描述）' }}</div>
            </div>
          </div>

          <div class="card">
            <div class="card-title">处理流程（{{ d.logs.length }} 条）</div>
            <div class="timeline">
              <div class="tl-item" v-for="(l, i) in d.logs" :key="l.id" :class="{ 'tl-main': i === d.logs.length - 1 }">
                <div class="tl-dot"></div>
                <div class="tl-head">{{ l.action }}
                  <span v-if="l.from_status && l.to_status" style="font-weight:400;color:var(--gray)">
                    （{{ STATUS[l.from_status] }} → {{ STATUS[l.to_status] }}）
                  </span>
                </div>
                <div class="tl-meta">{{ l.operator_name }} · {{ fmt(l.created_at) }}</div>
                <div class="tl-body" v-if="l.content">{{ l.content }}</div>
              </div>
              <div class="file-empty" v-if="!d.logs.length">暂无处理记录</div>
            </div>
            <div class="section-block" style="margin-top:8px">
              <div class="form-item" style="margin-bottom:8px">
                <textarea v-model="logContent" placeholder="追加一条处理记录（不改变状态）"></textarea>
              </div>
              <button class="btn btn-primary" :disabled="!logContent.trim()" @click="addLog">添加记录</button>
            </div>
          </div>

          <div class="card">
            <div class="card-title">相关附件（{{ d.files.length }} 个）</div>
            <div class="file-row" v-for="f in d.files" :key="f.id">
              <div class="file-icon">{{ fileIcon(f) }}</div>
              <div class="file-info">
                <div class="fn" :title="f.original_name">
                  <a v-if="f.preview_kind" href="javascript:void(0)" class="link" @click="preview(f)">{{ f.original_name }}</a>
                  <template v-else>{{ f.original_name }}</template>
                </div>
                <div class="fm">{{ fmtSize(f.size) }} · {{ f.uploader_name }} · {{ fmt(f.created_at) }}</div>
              </div>
              <button v-if="f.preview_kind" class="btn btn-outline btn-sm" @click="preview(f)">预览</button>
              <button class="btn btn-outline btn-sm" @click="download(f)">下载</button>
              <button class="btn btn-danger btn-sm" @click="removeFile(f)">删除</button>
            </div>
            <div class="file-empty" v-if="!d.files.length">暂无附件</div>
            <div class="upload-zone" @click="pickFiles">＋ 点击选择附件上传（支持多选，单个 ≤ 50MB）</div>
            <input type="file" multiple ref="fileInput" style="display:none" @change="uploadFiles">
          </div>

          <!-- 附件预览灯箱（图片/PDF/视频/Word/Excel） -->
          <div class="lightbox-mask" v-if="previewing" @click.self="closePreview">
            <div class="lightbox">
              <div class="lightbox-head">
                <div class="lightbox-name" :title="previewing.original_name">{{ previewing.original_name }}</div>
                <div class="lightbox-tools">
                  <template v-if="previewing.preview_kind === 'image'">
                    <button class="lb-btn" @click="zoomPreview(-0.2)" title="缩小">－</button>
                    <span class="lb-scale">{{ Math.round(previewScale * 100) }}%</span>
                    <button class="lb-btn" @click="zoomPreview(0.2)" title="放大">＋</button>
                    <button class="lb-btn" @click="resetPreview" title="原始大小">1:1</button>
                  </template>
                  <button class="lb-btn" @click="download(previewing)" title="下载">⭳</button>
                  <button class="lb-btn" @click="stepPreview(-1)" v-if="previewableFiles.length > 1" title="上一个">‹</button>
                  <button class="lb-btn" @click="stepPreview(1)" v-if="previewableFiles.length > 1" title="下一个">›</button>
                  <button class="lb-btn lb-close" @click="closePreview" title="关闭">✕</button>
                </div>
              </div>
              <div class="lightbox-body" :class="{ 'lb-doc': previewing.preview_kind === 'docx' || previewing.preview_kind === 'sheet' }" @wheel.prevent="previewing.preview_kind === 'image' ? wheelZoom($event) : null">
                <img v-if="previewing.preview_kind === 'image'" :src="previewUrl" :style="{ transform: 'scale(' + previewScale + ')' }" @error="onPreviewError">
                <iframe v-else-if="previewing.preview_kind === 'pdf'" :src="previewUrl" class="lb-iframe"></iframe>
                <video v-else-if="previewing.preview_kind === 'video' && previewing.preview_supported !== false" :src="previewUrl" controls autoplay class="lb-video"></video>
                <div v-else-if="previewing.preview_kind === 'video'" class="lb-unsupported lb-video-warn">
                  <div style="font-size:30px;margin-bottom:10px">🎬</div>
                  <div style="font-size:15px;font-weight:600;color:#b45309">该视频为 H.265 (HEVC) 编码，浏览器无法直接预览</div>
                  <div style="margin-top:8px;font-size:13px">请点击右上角「下载」按钮，用系统播放器（如 PotPlayer / VLC / 视频播放器）打开查看</div>
                </div>
                <div v-else-if="previewing.preview_kind === 'docx'" class="lb-docx-wrap"><div ref="docxBox" class="lb-docx"></div></div>
                <div v-else-if="previewing.preview_kind === 'sheet'" class="lb-sheet-wrap">
                  <div class="lb-sheet-tabs" v-if="sheetNames.length > 1">
                    <button v-for="(n, i) in sheetNames" :key="i" :class="['lb-tab', { active: i === sheetIndex }]" @click="showSheet(i)">{{ n }}</button>
                  </div>
                  <div class="lb-sheet-scroll" v-html="sheetHtml"></div>
                </div>
                <div v-else class="lb-unsupported">该类型暂不支持预览</div>
              </div>
              <div class="lightbox-foot">{{ previewIndex + 1 }} / {{ previewableFiles.length }}<template v-if="previewing.preview_kind === 'image'"> · 滚轮缩放</template><template v-if="previewing.preview_kind === 'video'"> · 视频自动播放</template> · ESC 关闭</div>
            </div>
          </div>
        </div>

        <div class="action-panel">
          <div class="card">
            <div class="card-title">操作</div>
            <div class="action-btns">
              <button v-if="canOperate && d.issue.status==='pending'" class="btn btn-primary" @click="doStatus('processing')">开始处理</button>
              <button v-if="canOperate && d.issue.status==='processing'" class="btn btn-primary" @click="doStatus('resolved')">标记解决</button>
              <button v-if="canOperate && d.issue.status==='resolved'" class="btn btn-primary" @click="doStatus('closed')">关闭工单</button>
              <button v-if="canOperate && d.issue.status==='processing'" class="btn btn-outline" @click="doStatus('pending')">退回待处理</button>
              <button v-if="canOperate && (d.issue.status==='resolved'||d.issue.status==='closed')" class="btn btn-outline" @click="doStatus('pending')">重新打开</button>
              <button v-if="canAssign" class="btn btn-outline" @click="openAssign">指派处理人</button>
              <button class="btn btn-outline" @click="openEdit">编辑基本信息</button>
              <button v-if="isAdmin" class="btn btn-danger" @click="removeIssue">删除问题</button>
            </div>
          </div>
          <div class="card" style="font-size:12px;color:var(--gray)">
            <div>创建：{{ fmt(d.issue.created_at) }}</div>
            <div style="margin-top:4px">最后更新：{{ fmt(d.issue.updated_at) }}</div>
            <div v-if="d.issue.closed_at" style="margin-top:4px">关闭时间：{{ fmt(d.issue.closed_at) }}</div>
          </div>
        </div>
      </div>

      <div class="modal-mask" v-if="showAssign">
        <div class="modal" style="width:420px">
          <div class="modal-head">指派处理人 <span class="x" @click="showAssign=false">✕</span></div>
          <div class="modal-body">
            <div class="form-item">
              <label>处理人（工程师/管理员）</label>
              <select v-model="assignId">
                <option :value="0">取消指派</option>
                <option v-for="u in engineers" :key="u.id" :value="u.id">{{ u.real_name || u.username }}（{{ ROLE[u.role_id] }}）</option>
              </select>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="showAssign=false">取消</button>
            <button class="btn btn-primary" @click="saveAssign">保存</button>
          </div>
        </div>
      </div>

      <div class="modal-mask" v-if="showEdit">
        <div class="modal">
          <div class="modal-head">编辑问题信息 <span class="x" @click="showEdit=false">✕</span></div>
          <div class="modal-body">
            <div class="form-item"><label>标题 *</label><input v-model="ef.title"></div>
            <div class="form-row">
              <div class="form-item"><label>问题分类</label>
                <select v-model="ef.category" @change="onEfCatChange">
                  <option v-for="c in mods.categories" :value="c">{{ c }}</option>
                  <option value="__add__">+ 新增分类…</option>
                </select>
              </div>
              <div class="form-item"><label>二级模块</label>
                <select v-model="ef.module" @change="onEfModChange">
                  <option value="">（不细分）</option>
                  <option v-for="m in moduleListOf(ef.category)" :value="m">{{ m }}</option>
                  <option value="__add__">+ 新增模块…</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>紧急程度</label>
                <select v-model="ef.urgency"><option v-for="u in URGENCY" :value="u">{{ u }}</option></select>
              </div>
              <div class="form-item"><label>问题记录时间</label><input type="date" v-model="ef.reportTime"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>报障人</label><input v-model="ef.reporter"></div>
              <div class="form-item"><label>报障科室</label><input v-model="ef.department"></div>
            </div>
            <div class="form-item"><label>问题描述</label><textarea v-model="ef.content"></textarea></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="showEdit=false">取消</button>
            <button class="btn btn-primary" @click="saveEdit">保存</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        STATUS, STATUS_TAG, URGENCY_TAG, URGENCY, mods: moduleStore, ROLE,
        d: null, logContent: '', showAssign: false, assignId: 0,
        engineers: [], showEdit: false, ef: {}, uploading: false,
        previewing: null, previewIndex: 0, previewScale: 1, previewUrl: '',
        sheetNames: [], sheetIndex: 0, sheetHtml: '', previewBlob: null,
      };
    },
    computed: {
      isAdmin() { const u = window.HisUser && window.HisUser.user; return u && u.role_id === 1; },
      canOperate() { const u = window.HisUser && window.HisUser.user; return u && (u.role_id === 1 || u.role_id === 2); },
      canAssign() { return this.canOperate; },
      imageFiles() { return (this.d && this.d.files || []).filter((f) => f.is_image); },
      previewableFiles() { return (this.d && this.d.files || []).filter((f) => f.preview_kind); },
    },
    methods: {
      fmt: (s) => fmtDate(s),
      fmtSize: (s) => fmtSize(s),
      moduleListOf,
      goBack() { location.hash = '#/issues'; },
      async load() {
        try {
          const id = this.$route.id;
          this.d = await this.$api.get('/issues/' + id);
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async doStatus(to) {
        if (!confirm('确认执行该状态操作？')) return;
        try {
          await this.$api.post('/issues/' + this.d.issue.id + '/status', { status: to });
          this.$toast('操作成功', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async addLog() {
        try {
          await this.$api.post('/issues/' + this.d.issue.id + '/logs', { content: this.logContent });
          this.logContent = '';
          this.$toast('已添加记录', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async openAssign() {
        try {
          this.engineers = await this.$api.get('/users/options');
          this.assignId = this.d.issue.assignee_id || 0;
          this.showAssign = true;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async saveAssign() {
        try {
          await this.$api.put('/issues/' + this.d.issue.id + '/assignee', { assigneeId: this.assignId });
          this.showAssign = false;
          this.$toast('已指派', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      openEdit() {
        const i = this.d.issue;
        this.ef = {
          title: i.title,
          category: i.category || '日常软件',
          module: i.module || '',
          urgency: i.urgency,
          reportTime: (i.report_time || '').slice(0, 10),
          department: i.department,
          reporter: i.reporter,
          content: i.content,
        };
        this.showEdit = true;
      },
      onEfCatChange() {
        if (this.ef.category === '__add__') {
          const name = prompt('请输入新分类名称（不超过10字）：');
          const v = name ? name.trim().slice(0, 10) : '';
          if (v && !this.mods.categories.includes(v)) {
            this.mods.categories.push(v);
            this.mods.sub[v] = this.mods.sub[v] || [];
          }
          this.ef.category = v || this.mods.categories[0];
        }
        this.ef.module = '';
      },
      onEfModChange() {
        if (this.ef.module === '__add__') {
          const name = prompt('请输入新模块名称（不超过40字）：');
          const v = name ? name.trim().slice(0, 40) : '';
          if (v) {
            const cat = this.ef.category;
            this.mods.sub[cat] = this.mods.sub[cat] || [];
            if (!this.mods.sub[cat].includes(v)) this.mods.sub[cat].push(v);
          }
          this.ef.module = v || '';
        }
      },
      async saveEdit() {
        if (!this.ef.title.trim()) return this.$toast('标题不能为空', 'err');
        try {
          await this.$api.put('/issues/' + this.d.issue.id, this.ef);
          this.showEdit = false;
          this.$toast('已保存', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      pickFiles() { const el = this.$refs.fileInput; if (el) el.click(); },
      async uploadFiles(ev) {
        const files = Array.from(ev.target.files || []);
        if (!files.length) return;
        this.uploading = true;
        try {
          const fd = new FormData();
          files.forEach((f) => fd.append('files', f));
          await this.$api.upload('/issues/' + this.d.issue.id + '/files', fd);
          this.$toast('上传成功', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); } finally {
          this.uploading = false;
          ev.target.value = '';
        }
      },
      download(f) {
        this.$api.download('/issues/' + this.d.issue.id + '/files/download/' + f.id, f.original_name)
          .catch((e) => this.$toast(e.message, 'err'));
      },
      fileIcon(f) {
        return { image: '🖼️', pdf: '📄', video: '🎬', docx: '📝', sheet: '📊' }[f.preview_kind] || '📎';
      },
      async preview(f) {
        const idx = this.previewableFiles.findIndex((x) => x.id === f.id);
        this.previewIndex = idx >= 0 ? idx : 0;
        await this.loadPreview();
      },
      async loadPreview() {
        const f = this.previewableFiles[this.previewIndex];
        if (!f) return;
        // H.265(HEVC) 视频浏览器无法解码（黑屏），直接显示提示层
        if (f.preview_kind === 'video' && f.preview_supported === false) {
          this.cleanupPreview();
          this.previewing = f;
          this.previewUrl = '';
          return;
        }
        try {
          const kind = f.preview_kind;
          if (kind === 'docx' || kind === 'sheet') {
            // Word/Excel：拉原始 blob 由前端库渲染
            const blob = await this.$api.previewBlob('/issues/' + this.d.issue.id + '/files/preview/' + f.id);
            this.cleanupPreview();
            this.previewBlob = blob;
            this.previewScale = 1;
            this.previewing = f;
            if (kind === 'docx') await this.renderDocx(blob);
            else await this.renderSheet(blob);
          } else {
            // 图片/PDF/视频：objectURL 直接渲染
            const url = await this.$api.previewUrl('/issues/' + this.d.issue.id + '/files/preview/' + f.id);
            this.cleanupPreview();
            this.previewUrl = url;
            this.previewScale = 1;
            this.previewing = f;
            this.sheetHtml = ''; this.sheetNames = []; this.sheetIndex = 0;
          }
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async renderDocx(blob) {
        await this.$nextTick();
        try {
          if (!window.docx) throw new Error('预览组件未加载，请刷新页面重试');
          const box = this.$refs.docxBox;
          if (!box) throw new Error('渲染容器未就绪');
          box.innerHTML = '';
          await window.docx.renderAsync(blob, box, null, { inWrapper: true, ignoreWidth: false });
        } catch (e) {
          this.$toast('Word 渲染失败：' + e.message + '，请下载查看', 'err');
        }
      },
      async renderSheet(blob) {
        try {
          if (!window.XLSX) throw new Error('预览组件未加载，请刷新页面重试');
          const buf = await blob.arrayBuffer();
          const wb = window.XLSX.read(buf, { type: 'array' });
          this._workbook = wb;
          this.sheetNames = wb.SheetNames || [];
          this.sheetIndex = 0;
          this.showSheet(0);
        } catch (e) {
          this.$toast('Excel 解析失败：' + e.message + '，请下载查看', 'err');
        }
      },
      showSheet(i) {
        if (!this._workbook || !this.sheetNames[i]) return;
        this.sheetIndex = i;
        const ws = this._workbook.Sheets[this.sheetNames[i]];
        this.sheetHtml = window.XLSX.utils.sheet_to_html(ws, { editable: false });
      },
      stepPreview(dir) {
        const n = this.previewableFiles.length;
        if (!n) return;
        this.previewIndex = (this.previewIndex + dir + n) % n;
        this.loadPreview();
      },
      zoomPreview(delta) {
        this.previewScale = Math.min(5, Math.max(0.2, +(this.previewScale + delta).toFixed(2)));
      },
      wheelZoom(ev) { this.zoomPreview(ev.deltaY < 0 ? 0.1 : -0.1); },
      resetPreview() { this.previewScale = 1; },
      closePreview() {
        this.cleanupPreview();
        this.previewing = null;
        this.previewScale = 1;
        this.sheetHtml = ''; this.sheetNames = []; this.sheetIndex = 0;
        this._workbook = null;
      },
      cleanupPreview() {
        if (this.previewUrl) { URL.revokeObjectURL(this.previewUrl); this.previewUrl = ''; }
        this.previewBlob = null;
      },
      onPreviewError() {
        this.$toast('图片加载失败，请尝试下载查看', 'err');
        this.closePreview();
      },
      onKeydown(ev) {
        if (!this.previewing) return;
        if (ev.key === 'Escape') this.closePreview();
        else if (ev.key === 'ArrowLeft') this.stepPreview(-1);
        else if (ev.key === 'ArrowRight') this.stepPreview(1);
      },
      async removeFile(f) {
        if (!confirm('确认删除附件「' + f.original_name + '」？')) return;
        try {
          await this.$api.del('/issues/' + this.d.issue.id + '/files/' + f.id);
          this.$toast('已删除', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async removeIssue() {
        if (!confirm('确认删除该问题及其全部处理记录与附件？此操作不可恢复！')) return;
        try {
          await this.$api.del('/issues/' + this.d.issue.id);
          this.$toast('问题已删除', 'ok');
          location.hash = '#/issues';
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      submit() { window.print(); },
    },
    mounted() {
      this.load();
      this._kb = (ev) => this.onKeydown(ev);
      window.addEventListener('keydown', this._kb);
    },
    beforeUnmount() {
      if (this._kb) window.removeEventListener('keydown', this._kb);
      this.cleanupPreview();
    },
  };

  /* ==================== 新建问题 ==================== */
  V.NewIssueView = {
    template: `
    <div>
      <div class="page-title">新建问题工单</div>
      <div class="page-sub">登记 HIS 系统使用过程中遇到的问题</div>
      <div class="card" style="max-width:760px">
        <div class="form-item"><label>问题标题 *</label><input v-model="f.title" placeholder="简要描述问题，如：门诊挂号系统无法登录"></div>
        <div class="form-row">
          <div class="form-item"><label>问题分类 *</label>
            <select v-model="f.category" @change="onCatChange">
              <option v-for="c in mods.categories" :value="c">{{ c }}</option>
              <option value="__add__">+ 新增分类…</option>
            </select>
          </div>
          <div class="form-item"><label>二级模块（可选）</label>
            <select v-model="f.module" @change="onModChange">
              <option value="">（不细分）</option>
              <option v-for="m in moduleListOf(f.category)" :value="m">{{ m }}</option>
              <option value="__add__">+ 新增模块…</option>
            </select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>问题记录时间 *</label><input type="date" v-model="f.reportTime"></div>
          <div class="form-item"><label>紧急程度 *</label>
            <select v-model="f.urgency"><option v-for="u in URGENCY" :value="u">{{ u }}</option></select>
          </div>
        </div>
        <div class="form-row">
          <div class="form-item"><label>报障科室</label><input v-model="f.department" placeholder="如：门诊部"></div>
          <div class="form-item"><label>报障人</label><input v-model="f.reporter" placeholder="如：张护士"></div>
        </div>
        <div class="form-item"><label>问题描述 *</label>
          <textarea v-model="f.content" style="min-height:120px" placeholder="请描述问题现象、影响范围、发生时间等详细信息"></textarea>
        </div>
        <div class="upload-zone" @click="pickFiles">点击选择附件（可选，支持多选）</div>
        <input type="file" multiple ref="fileInput" style="display:none" @change="onPick">
        <div class="file-row" v-for="(x, i) in pendFiles" :key="i">
          <div class="file-icon">📎</div>
          <div class="file-info"><div class="fn">{{ x.name }}</div><div class="fm">{{ fmtSize(x.size) }}</div></div>
          <button class="btn btn-danger btn-sm" @click="pendFiles.splice(i,1)">移除</button>
        </div>
        <div class="modal-foot" style="padding:12px 0 0;border-top:none">
          <button class="btn btn-outline" @click="goList">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '提交中…' : '提交工单' }}</button>
        </div>
      </div>
    </div>`,
    data() {
      return {
        mods: moduleStore, URGENCY,
        f: { title: '', category: '日常软件', module: '', urgency: '中', reportTime: todayStr(), department: '', reporter: '', content: '' },
        pendFiles: [], saving: false,
      };
    },
    methods: {
      fmtSize: (s) => fmtSize(s),
      moduleListOf,
      onCatChange() {
        if (this.f.category === '__add__') {
          const name = prompt('请输入新分类名称（不超过10字）：');
          const v = name ? name.trim().slice(0, 10) : '';
          if (v && !this.mods.categories.includes(v)) {
            this.mods.categories.push(v);
            this.mods.sub[v] = this.mods.sub[v] || [];
          }
          this.f.category = v || this.mods.categories[0];
        }
        this.f.module = '';
      },
      onModChange() {
        if (this.f.module === '__add__') {
          const name = prompt('请输入新模块名称（不超过40字）：');
          const v = name ? name.trim().slice(0, 40) : '';
          if (v) {
            const cat = this.f.category;
            this.mods.sub[cat] = this.mods.sub[cat] || [];
            if (!this.mods.sub[cat].includes(v)) this.mods.sub[cat].push(v);
          }
          this.f.module = v || '';
        }
      },
      pickFiles() { this.$refs.fileInput.click(); },
      onPick(ev) {
        const fs = Array.from(ev.target.files || []);
        fs.forEach((x) => this.pendFiles.push(x));
        ev.target.value = '';
      },
      goList() { location.hash = '#/issues'; },
      async save() {
        if (!this.f.title.trim()) return this.$toast('请填写问题标题', 'err');
        if (!this.f.content.trim()) return this.$toast('请填写问题描述', 'err');
        this.saving = true;
        try {
          const r = await this.$api.post('/issues', this.f);
          if (this.pendFiles.length) {
            const fd = new FormData();
            this.pendFiles.forEach((x) => fd.append('files', x));
            await this.$api.upload('/issues/' + r.id + '/files', fd);
          }
          this.$toast('问题已提交', 'ok');
          location.hash = '#/issue/' + r.id;
        } catch (e) { this.$toast(e.message, 'err'); } finally { this.saving = false; }
      },
    },
  };

  /* ==================== 用户管理 ==================== */
  // 注意：这份 UsersView 会被后加载的 contract-views.js 同名注册覆盖
  // （index.html 里 contract-views.js 排在 app.js 之后）。
  // 页面上实际生效的是 contract-views.js 那份，改这个文件不会有效果，保留仅为兼容旧路由。
  V.UsersView = {
    template: `
    <div>
      <div class="page-title">用户管理</div>
      <div class="page-sub">管理员专属 · 维护系统账号与角色</div>
      <div class="card">
        <div class="card-title">账号列表
          <button class="btn btn-primary btn-sm" @click="showNew">+ 新建用户</button>
        </div>
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>ID</th><th>用户名</th><th>姓名</th><th>角色</th><th>联系电话</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="u in list" :key="u.id">
                <td>{{ u.id }}</td><td>{{ u.username }}</td><td>{{ u.real_name }}</td>
                <td><span :class="tagRole(u.role_id)" class="tag">{{ u.role_name }}</span></td>
                <td>{{ u.phone || '-' }}</td>
                <td><span :class="u.active ? 'tag tag-resolved' : 'tag tag-closed'">{{ u.active ? '启用' : '停用' }}</span></td>
                <td>{{ fmt(u.created_at) }}</td>
                <td>
                  <button class="btn btn-outline btn-sm" @click="edit(u)">编辑</button>
                  <button class="btn btn-outline btn-sm" @click="resetPwd(u)">重置密码</button>
                  <button v-if="u.id!==me.id" class="btn btn-outline btn-sm" @click="toggleActive(u)">{{ u.active ? '停用' : '启用' }}</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="modal-mask" v-if="showModal">
        <div class="modal" style="width:460px">
          <div class="modal-head">{{ ef.id ? '编辑用户' : '新建用户' }} <span class="x" @click="showModal=false">✕</span></div>
          <div class="modal-body">
            <div class="form-item"><label>用户名 *</label><input v-model="ef.username" :disabled="!!ef.id"></div>
            <div class="form-item" v-if="!ef.id"><label>初始密码 *（至少 6 位）</label><input v-model="ef.password"></div>
            <div class="form-item"><label>姓名</label><input v-model="ef.real_name"></div>
            <div class="form-item"><label>角色</label>
              <select v-model="ef.role_id"><option v-for="(n, k) in ROLE" :value="Number(k)">{{ n }}</option></select>
            </div>
            <div class="form-item"><label>联系电话</label><input v-model="ef.phone"></div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="showModal=false">取消</button>
            <button class="btn btn-primary" @click="saveUser">保存</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return { list: [], ROLE, showModal: false, ef: {} };
    },
    computed: {
      me() { const u = window.HisUser && window.HisUser.user; return u || {}; },
    },
    methods: {
      fmt: (s) => fmtDate(s),
      tagRole(r) { return { 1: 'tag-processing', 2: 'tag-pending', 3: 'tag-closed' }[r] || 'tag-closed'; },
      async load() { try { this.list = await this.$api.get('/users'); } catch (e) { this.$toast(e.message, 'err'); } },
      showNew() { this.ef = { id: 0, username: '', password: '', real_name: '', role_id: 3, phone: '' }; this.showModal = true; },
      edit(u) { this.ef = { id: u.id, username: u.username, real_name: u.real_name, role_id: u.role_id, phone: u.phone }; this.showModal = true; },
      async saveUser() {
        if (!this.ef.id && !this.ef.username.trim()) return this.$toast('请填写用户名', 'err');
        if (!this.ef.id && (!this.ef.password || this.ef.password.length < 6)) return this.$toast('初始密码至少 6 位', 'err');
        try {
          if (this.ef.id) await this.$api.put('/users/' + this.ef.id, { real_name: this.ef.real_name, roleId: this.ef.role_id, phone: this.ef.phone });
          else await this.$api.post('/users', {
            username: this.ef.username, password: this.ef.password,
            realName: this.ef.real_name, roleId: this.ef.role_id, phone: this.ef.phone,
          });
          this.showModal = false;
          this.$toast('已保存', 'ok');
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      resetPwd(u) {
        const p = prompt('输入新密码（至少 6 位）给用户「' + (u.real_name || u.username) + '」');
        if (!p) return;
        this.$api.put('/users/' + u.id + '/password', { password: p }).then(() => this.$toast('密码已重置', 'ok')).catch((e) => this.$toast(e.message, 'err'));
      },
      toggleActive(u) {
        const action = u.active ? '停用' : '启用';
        if (!confirm('确认' + action + '用户「' + (u.real_name || u.username) + '」？')) return;
        this.$api.put('/users/' + u.id, { active: u.active ? 0 : 1 }).then(() => { this.$toast('已' + action, 'ok'); this.load(); }).catch((e) => this.$toast(e.message, 'err'));
      },
    },
    mounted() { this.load(); },
  };

  /* ==================== 操作日志 ==================== */
  // 同上：实际生效的是 contract-views.js 里的 LogsView（本文件这份被覆盖）
  V.LogsView = {
    template: `
    <div>
      <div class="page-title">操作日志</div>
      <div class="page-sub">管理员专属 · 系统操作审计记录</div>
      <div class="card">
        <div class="table-wrap">
          <table class="tbl">
            <thead><tr><th>ID</th><th>时间</th><th>用户</th><th>操作</th><th>详情</th><th>IP</th></tr></thead>
            <tbody>
              <tr v-for="l in list" :key="l.id">
                <td>{{ l.id }}</td><td>{{ fmt(l.created_at) }}</td>
                <td>{{ l.username }}</td><td>{{ l.action }}</td><td>{{ l.detail }}</td><td>{{ l.ip }}</td>
              </tr>
              <tr v-if="!list.length"><td colspan="6" class="empty-row">暂无日志</td></tr>
            </tbody>
          </table>
        </div>
        <div class="pager">
          <span class="btn-info">第 {{ page }} / {{ pageCount }} 页，共 {{ total }} 条</span>
          <button :disabled="page<=1" @click="goPage(page-1)">上一页</button>
          <button v-for="p in pages" :key="p" :class="{active:p===page}" @click="goPage(p)">{{ p }}</button>
          <button :disabled="page>=pageCount" @click="goPage(page+1)">下一页</button>
        </div>
      </div>
    </div>`,
    data: () => ({ list: [], total: 0, page: 1, pageSize: 20 }),
    computed: {
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
      pages() {
        const pc = this.pageCount, p = this.page, arr = [];
        for (let i = Math.max(1, p - 2); i <= Math.min(pc, p + 2); i++) arr.push(i);
        return arr;
      },
    },
    methods: {
      fmt: (s) => fmtDate(s),
      async load() {
        try {
          const d = await this.$api.get('/logs?page=' + this.page + '&pageSize=' + this.pageSize);
          this.list = d.list; this.total = d.total;
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      goPage(p) { if (p < 1 || p > this.pageCount) return; this.page = p; this.load(); },
    },
    mounted() { this.load(); },
  };

  window.HisViews = V;
  // 暴露通用工具函数（contract-views.js 等后续脚本复用）
  window.HisUtils = { fmtDate, todayStr, fmtSize, fmtMoney, statusTag, daysLeft };
})();