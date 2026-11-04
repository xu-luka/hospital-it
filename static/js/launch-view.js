/* 上线管理
 *
 * 一条记录 = 一次新系统上线：谁家的系统、给哪个科室用、计划/实际/验收三个日期、
 * 切换方案与回滚预案，外加一份阶段任务清单（准备/培训/数据迁移/试运行/切换/验收）。
 *
 * 三个刻意的交互决定：
 * 1) 状态流转不藏在编辑表单里：编辑只改台账字段，状态走详情页那几个显式按钮，
 *    每次流转都写一条流水（谁、什么时候、从什么状态到什么状态、为什么）——
 *    否则「这系统到底上没上线」只能靠最后修改时间猜。
 * 2) 转「已回滚」必须就地填原因（不是弹 toast 拦一下）：回滚是事故复盘的第一手材料，
 *    弹窗里那个输入框就是唯一的入口，漏填提交不了。
 * 3) 详情弹窗是**只读**的，保留 @click.self（找信息时不用先找关闭按钮）；
 *    新增/编辑是**表单**，不写 @click.self，关闭走 tryCloseForm（有改动才确认）。
 *    阶段任务的增删勾选会立刻写库，属于详情弹窗里的操作，不影响关闭行为。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  /** 参与「有没有改动」比较的字段（状态不在这里：它走单独的流转接口） */
  const FORM_KEYS = [
    'name', 'vendor', 'dept', 'it_owner', 'contact',
    'plan_date', 'live_date', 'accept_date',
    'switch_plan', 'rollback_plan', 'note',
  ];

  const STATUS_OPTIONS = [
    { key: 'planned', name: '筹备中', tag: 'tag-pending' },
    { key: 'testing', name: '试运行', tag: 'tag-processing' },
    { key: 'live', name: '已上线', tag: 'tag-resolved' },
    { key: 'accepted', name: '已验收', tag: 'tag-closed' },
    { key: 'rolledback', name: '已回滚', tag: 'tag-stop' },
  ];
  const STATUS_TAG = {};
  const STATUS_NAME = {};
  STATUS_OPTIONS.forEach((s) => { STATUS_TAG[s.key] = s.tag; STATUS_NAME[s.key] = s.name; });

  const PHASES = [
    { key: 'prep', name: '准备' },
    { key: 'train', name: '培训' },
    { key: 'migrate', name: '数据迁移' },
    { key: 'trial', name: '试运行' },
    { key: 'switch', name: '切换' },
    { key: 'accept', name: '验收' },
  ];

  function todayStr() {
    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function emptyForm() {
    return {
      id: 0, name: '', vendor: '', dept: '', it_owner: '', contact: '',
      plan_date: '', live_date: '', accept_date: '',
      switch_plan: '', rollback_plan: '', note: '',
    };
  }

  V.LaunchView = {
    template: `
    <div>
      <div class="page-head">
        <div>
          <h2>上线管理</h2>
          <div class="muted">
            每个新系统的上线档案：计划与实际日期、阶段任务、状态流转都留痕。
            状态流转与任务勾选需要「管理」权限，其余人可看。
          </div>
        </div>
        <div class="page-actions">
          <span class="dev-badge muted">共 {{ stats.total }} 个系统</span>
          <button v-if="canManage" class="btn btn-primary" @click="openForm(null)">新增上线</button>
        </div>
      </div>

      <div class="stat-strip">
        <div class="stat-cell"><div class="k">筹备中</div><div class="v">{{ stats.planned }}</div></div>
        <div class="stat-cell"><div class="k">试运行</div><div class="v warn">{{ stats.testing }}</div></div>
        <div class="stat-cell"><div class="k">已上线待验收</div><div class="v warn">{{ stats.live }}</div></div>
        <div class="stat-cell"><div class="k">30 天内计划上线</div><div class="v warn">{{ stats.upcoming }}</div></div>
        <div class="stat-cell"><div class="k">今年已上线</div><div class="v ok">{{ stats.year_live }}</div></div>
      </div>

      <div class="filter-bar">
        <input class="ipt grow" v-model="kw" @keyup.enter="search"
               placeholder="搜索系统名称 / 厂商 / 科室 / 负责人 / 联系人 / 备注">
        <select class="ipt" v-model="fStatus" @change="search">
          <option value="">全部状态</option>
          <option v-for="s in statusOptions" :key="s.key" :value="s.key">{{ s.name }}</option>
        </select>
        <select class="ipt" v-model="fYear" @change="search">
          <option value="">全部年份</option>
          <option v-for="y in yearOptions" :key="y" :value="y">{{ y }} 年计划</option>
        </select>
        <button class="btn btn-outline" @click="search">查询</button>
        <button class="btn btn-outline" @click="reset">重置</button>
      </div>

      <div class="card card-flush">
        <div class="table-wrap">
          <table class="tbl launch-table">
            <thead>
              <tr>
                <th class="c-sys">系统 / 厂商</th>
                <th class="c-dept">使用科室</th>
                <th class="c-status">状态</th>
                <th class="c-plan">计划上线</th>
                <th class="c-live">实际 / 验收</th>
                <th class="c-prog">阶段进度</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loading"><td colspan="7" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!list.length">
                <td colspan="7" class="empty-row">
                  还没有上线档案。{{ canManage ? '点右上角「新增上线」建第一条。' : '请联系管理员录入。' }}
                </td>
              </tr>
              <tr v-for="r in list" :key="r.id">
                <td>
                  <span class="cell-strong launch-name" @click="openDetail(r)" :title="r.name">{{ r.name }}</span>
                  <span class="cell-sub" :title="r.vendor">{{ r.vendor || '未填厂商' }}</span>
                </td>
                <td>
                  <span class="cell-strong">{{ r.dept || '未填科室' }}</span>
                  <span class="cell-sub">{{ r.it_owner ? '负责 ' + r.it_owner : (r.contact || '') }}</span>
                </td>
                <td><span class="tag" :class="statusTag(r.status)">{{ r.status_label }}</span></td>
                <td>
                  <span class="mono">{{ r.plan_date || '—' }}</span>
                  <span class="cell-sub" :class="planClass(r)">{{ planHint(r) }}</span>
                </td>
                <td>
                  <span class="mono">{{ r.live_date || '—' }}</span>
                  <span class="cell-sub" v-if="r.accept_date">验收 {{ r.accept_date }}</span>
                </td>
                <td>
                  <template v-if="r.task_n">
                    <span class="cell-strong">{{ r.task_done }} / {{ r.task_n }}</span>
                    <div class="prog-track"><div class="prog-fill" :style="{ width: progPct(r) + '%' }"></div></div>
                  </template>
                  <span v-else class="muted">未建清单</span>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="openDetail(r)">详情</button>
                  <button v-if="canManage" class="btn btn-sm btn-outline" @click="openForm(r)">编辑</button>
                  <button v-if="canManage" class="btn btn-sm btn-outline btn-danger" @click="del(r)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          点系统名看详情与阶段任务。列表排序：进行中的在前，同档按计划上线日期。
          <b>状态流转不藏在编辑里</b>—— 在详情页点按钮改，系统会记下谁在什么时候改的、为什么改。
        </div>
      </div>

      <div class="pager" v-if="total > pageSize">
        <button class="btn btn-sm btn-outline" :disabled="page<=1" @click="go(page-1)">上一页</button>
        <span class="muted">第 {{ page }} / {{ pageCount }} 页 · 共 {{ total }} 个系统</span>
        <button class="btn btn-sm btn-outline" :disabled="page>=pageCount" @click="go(page+1)">下一页</button>
      </div>

      <!-- 详情（只读，点外面可以关；任务勾选/状态流转会立即写库） -->
      <div class="modal-mask" v-if="detail" @click.self="closeDetail">
        <div class="modal modal-launch">
          <div class="modal-head">
            {{ detail.name }}
            <span class="tag" :class="statusTag(detail.status)" style="margin-left:8px">{{ detail.status_label }}</span>
            <span class="modal-close" @click="closeDetail">✕</span>
          </div>
          <div class="modal-body">
            <div class="section-block">
              <div class="sec-title">基本信息</div>
              <div class="term-info">
                <div class="ti"><div class="k">厂商</div><div class="v">{{ detail.vendor || '—' }}</div></div>
                <div class="ti"><div class="k">使用科室</div><div class="v">{{ detail.dept || '—' }}</div></div>
                <div class="ti"><div class="k">信息科负责人</div><div class="v">{{ detail.it_owner || '—' }}</div></div>
                <div class="ti"><div class="k">联系人</div><div class="v">{{ detail.contact || '—' }}</div></div>
                <div class="ti"><div class="k">计划上线</div><div class="v mono">{{ detail.plan_date || '—' }}</div></div>
                <div class="ti"><div class="k">实际上线</div><div class="v mono">{{ detail.live_date || '—' }}</div></div>
                <div class="ti"><div class="k">验收日期</div><div class="v mono">{{ detail.accept_date || '—' }}</div></div>
                <div class="ti"><div class="k">登记 / 更新</div><div class="v">{{ detail.created_by || '—' }} · {{ (detail.updated_at || '').slice(0, 16) }}</div></div>
              </div>
            </div>

            <div class="section-block" v-if="detail.switch_plan || detail.rollback_plan || detail.note">
              <div class="sec-title">方案与备注</div>
              <div class="plan-box" v-if="detail.switch_plan"><div class="pk">切换方案</div><div class="pv">{{ detail.switch_plan }}</div></div>
              <div class="plan-box" v-if="detail.rollback_plan"><div class="pk">回滚预案</div><div class="pv">{{ detail.rollback_plan }}</div></div>
              <div class="plan-box" v-if="detail.note"><div class="pk">备注</div><div class="pv">{{ detail.note }}</div></div>
            </div>

            <div class="section-block">
              <div class="sec-title">
                阶段任务（{{ detail.task_done }} / {{ detail.task_n }} 完成）
                <span class="muted" style="font-weight:400;font-size:12px">
                  勾选即刻保存，不需要点「保存」
                </span>
              </div>
              <div class="phase-row" v-for="p in detailPhases" :key="p.key">
                <div class="phase-name">{{ p.name }}</div>
                <div class="phase-bar">
                  <div class="prog-track"><div class="prog-fill" :style="{ width: p.pct + '%' }"></div></div>
                  <span class="phase-num">{{ p.done }} / {{ p.total }}</span>
                </div>
                <div class="phase-tasks">
                  <div class="task-row" v-for="t in tasksOf(detail.tasks, p.key)" :key="t.id"
                       :class="{ 'is-done': t.done }">
                    <label class="task-check">
                      <input type="checkbox" :checked="t.done" :disabled="!canManage" @change="toggleTask(t)">
                      <span class="task-title">{{ t.title }}</span>
                    </label>
                    <span class="task-meta" :class="{ 'is-over': isOverdue(t) }">
                      {{ t.owner || '未指定' }}<template v-if="t.due_date"> · {{ t.due_date }}</template>
                      <template v-if="isOverdue(t)"> · 已逾期</template>
                    </span>
                    <button v-if="canManage" class="btn btn-sm btn-outline btn-danger task-del"
                            @click="rmTask(t)">移除</button>
                  </div>
                  <div class="muted task-empty" v-if="!tasksOf(detail.tasks, p.key).length">—</div>
                </div>
              </div>
              <!-- 没建任务时不要把六个阶段各渲染成一行「—」：新档案打开是一整屏空白，
                   看着像加载失败。一句话说明 + 下面的添加行就够了。 -->
              <div class="muted" style="font-size:12px" v-if="!detail.task_n">
                还没有阶段任务。在下面选阶段、填任务名即可开始跟踪进度。
              </div>

              <div class="task-add" v-if="canManage">
                <select class="ipt" v-model="taskForm.phase">
                  <option v-for="p in phases" :key="p.key" :value="p.key">{{ p.name }}</option>
                </select>
                <input class="ipt grow" v-model="taskForm.title" @keyup.enter="addTask"
                       placeholder="任务名，如「住院护士站培训」">
                <input class="ipt" v-model="taskForm.owner" placeholder="负责人">
                <input class="ipt" type="date" v-model="taskForm.due_date">
                <button class="btn btn-outline" :disabled="taskBusy || !taskForm.title.trim()" @click="addTask">添加</button>
              </div>
            </div>

            <div class="section-block">
              <div class="sec-title">状态流转</div>
              <div class="status-bar" v-if="canManage">
                <button v-for="s in nextStatuses" :key="s.key"
                        class="btn btn-sm btn-outline" @click="askStatus(s.key)">转「{{ s.name }}」</button>
                <span class="muted" v-if="!nextStatuses.length">已经是终态</span>
              </div>
              <div class="muted" v-else>只有具备「管理」权限的人可以改状态。</div>

              <div class="rb-box" v-if="rbOpen">
                <div class="rb-tip">回滚原因（必填，会写进流转记录）：</div>
                <textarea class="ipt" v-model="rbReason" rows="2"
                          placeholder="如：核心接口超时率超标，厂商回退到上一版本"></textarea>
                <div class="rb-actions">
                  <button class="btn btn-sm btn-outline" @click="rbOpen = false">取消</button>
                  <button class="btn btn-sm btn-primary" :disabled="!rbReason.trim()" @click="doRollback">确认回滚</button>
                </div>
              </div>
            </div>

            <div class="section-block">
              <div class="sec-title">流转记录（{{ detail.events.length }} 条）</div>
              <div class="ev-list">
                <div class="ev-item" v-for="e in detail.events" :key="e.id">
                  <span class="ev-time mono">{{ (e.created_at || '').slice(0, 16) }}</span>
                  <span class="ev-flow">{{ e.from_label }} → <b>{{ e.to_label }}</b></span>
                  <span class="ev-user">{{ e.username || '—' }}</span>
                  <span class="ev-reason" v-if="e.reason">{{ e.reason }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button v-if="canManage" class="btn btn-outline btn-danger" @click="del(detail)">删除档案</button>
            <button v-if="canManage" class="btn btn-outline" @click="openForm(detail)">编辑</button>
            <button class="btn btn-outline" @click="closeDetail">关闭</button>
          </div>
        </div>
      </div>

      <!-- 新增 / 编辑
           ★ 表单弹窗不写 @click.self：点到遮罩不该把填了一半的内容清掉。 -->
      <div class="modal-mask" v-if="form">
        <div class="modal" style="width:720px">
          <div class="modal-head">{{ form.id ? '编辑上线档案' : '新增上线' }}<span class="modal-close" @click="tryCloseForm">✕</span></div>
          <div class="modal-body">
            <div class="form-alert" v-if="badField === 'name'">
              系统名称必填 —— 至少让人一眼知道是哪个系统（如「LIS 检验系统」「互联网医院小程序」）。
            </div>

            <div class="form-item"><label>系统名称 <span class="req">*</span></label>
              <input class="ipt" v-model="form.name" @input="badField = ''" placeholder="如 LIS 检验系统 / 互联网医院小程序">
            </div>
            <div class="form-row">
              <div class="form-item"><label>厂商</label><input class="ipt" v-model="form.vendor" placeholder="如 卫宁健康"></div>
              <div class="form-item"><label>使用科室</label><input class="ipt" v-model="form.dept" placeholder="如 检验科 / 全院"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>信息科负责人</label><input class="ipt" v-model="form.it_owner" placeholder="科内谁牵头"></div>
              <div class="form-item"><label>联系人</label><input class="ipt" v-model="form.contact" placeholder="厂商实施 / 科室对接人及电话"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>计划上线日期</label><input class="ipt" type="date" v-model="form.plan_date"></div>
              <div class="form-item"><label>实际上线日期</label><input class="ipt" type="date" v-model="form.live_date"></div>
            </div>
            <div class="form-item" style="max-width:50%"><label>验收日期</label><input class="ipt" type="date" v-model="form.accept_date"></div>
            <div class="form-item"><label>切换方案摘要</label>
              <textarea class="ipt" v-model="form.switch_plan" rows="2"
                        placeholder="如：周五 22:00 停旧系统 → 数据同步 → 新系统验证 → 次日 6:00 开诊前完成"></textarea>
            </div>
            <div class="form-item"><label>回滚预案摘要</label>
              <textarea class="ipt" v-model="form.rollback_plan" rows="2"
                        placeholder="如：保留旧系统只读 7 天；新系统连续 30 分钟不可用即回退"></textarea>
            </div>
            <div class="form-item"><label>备注</label>
              <textarea class="ipt" v-model="form.note" rows="2" placeholder="其他需要记住的事"></textarea>
            </div>
            <div class="muted" style="font-size:12px">
              状态不在这里改：保存后在详情页点「转试运行 / 转已上线」等按钮，会留下流转记录。
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="tryCloseForm">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        list: [], total: 0, page: 1, pageSize: 20,
        kw: '', fStatus: '', fYear: '',
        stats: { total: 0, planned: 0, testing: 0, live: 0, accepted: 0, rolledback: 0, year_live: 0, upcoming: 0 },
        loading: false,
        detail: null,
        form: null, formBase: '', saving: false, badField: '',
        statusOptions: STATUS_OPTIONS,
        phases: PHASES,
        taskForm: { phase: 'prep', title: '', owner: '', due_date: '' },
        taskBusy: false,
        rbOpen: false, rbReason: '',
        today: todayStr(),
      };
    },
    computed: {
      canManage() { return !!(window.HisPerm && window.HisPerm.can('launches.manage')); },
      pageCount() { return Math.max(1, Math.ceil(this.total / this.pageSize)); },
      yearOptions() {
        const y = new Date().getFullYear();
        const out = [];
        for (let i = y - 2; i <= y + 2; i++) out.push(String(i));
        return out;
      },
      /** 详情页可转的状态：排除当前状态；已回滚是终态，不再给按钮（要重来就编辑后重新上线） */
      nextStatuses() {
        if (!this.detail) return [];
        if (this.detail.status === 'rolledback') return [];
        return STATUS_OPTIONS.filter((s) => s.key !== this.detail.status);
      },
      /** 只渲染「真的挂了任务」的阶段，避免新档案一屏全是 0 / 0 */
      detailPhases() {
        if (!this.detail) return [];
        return this.phaseStats(this.detail.tasks).filter((p) => p.total > 0);
      },
    },
    mounted() { this.load(); },
    methods: {
      statusTag(s) { return STATUS_TAG[s] || 'tag-pending'; },
      statusName(s) { return STATUS_NAME[s] || s; },
      progPct(r) {
        const n = Number(r.task_n) || 0;
        if (!n) return 0;
        return Math.round((Number(r.task_done) || 0) / n * 100);
      },
      /** 计划日期的副行：已上线/已验收的看实际，进行中的看倒计时 */
      planHint(r) {
        if (!r.plan_date) return '未定日期';
        if (r.status === 'accepted') return '已验收';
        if (r.status === 'rolledback') return '已回滚';
        if (r.status === 'live') return '已上线';
        const d = this.daysLeft(r.plan_date);
        if (d === null) return '';
        if (d < 0) return '已逾期 ' + (-d) + ' 天';
        if (d === 0) return '就是今天';
        return '还有 ' + d + ' 天';
      },
      planClass(r) {
        if (r.status !== 'planned' && r.status !== 'testing') return '';
        const d = this.daysLeft(r.plan_date);
        if (d === null) return '';
        if (d < 0) return 'is-over';
        if (d <= 7) return 'is-soon';
        return '';
      },
      daysLeft(dateStr) {
        if (!dateStr) return null;
        const a = new Date(dateStr + 'T00:00:00');
        if (isNaN(a.getTime())) return null;
        const b = new Date(this.today + 'T00:00:00');
        return Math.round((a - b) / 86400000);
      },
      isOverdue(t) {
        if (!t || t.done || !t.due_date) return false;
        return t.due_date < this.today;
      },

      async load() {
        this.loading = true;
        try {
          const q = [];
          if (this.kw.trim()) q.push('keyword=' + encodeURIComponent(this.kw.trim()));
          if (this.fStatus) q.push('status=' + encodeURIComponent(this.fStatus));
          if (this.fYear) q.push('year=' + encodeURIComponent(this.fYear));
          q.push('page=' + this.page, 'pageSize=' + this.pageSize);
          const d = await this.$api.get('/launches?' + q.join('&'));
          this.list = d.list || [];
          this.total = d.total || 0;
          this.stats = d.stats || this.stats;
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
      },
      search() { this.page = 1; this.load(); },
      reset() {
        this.kw = ''; this.fStatus = ''; this.fYear = '';
        this.page = 1; this.load();
      },
      go(p) { this.page = p; this.load(); },

      async openDetail(r) {
        if (!r || !r.id) return;
        try {
          this.detail = await this.$api.get('/launches/' + r.id);
          this.rbOpen = false;
          this.rbReason = '';
          this.taskForm = { phase: 'prep', title: '', owner: '', due_date: '' };
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      /** 详情里改了任务/状态后就地刷新：只重拉详情，不动列表页码 */
      async reloadDetail() {
        if (!this.detail) return;
        try {
          this.detail = await this.$api.get('/launches/' + this.detail.id);
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      closeDetail() { this.detail = null; this.rbOpen = false; this.rbReason = ''; },

      openForm(r) {
        const f = emptyForm();
        if (r) FORM_KEYS.forEach((k) => { f[k] = r[k] || ''; });
        if (r) f.id = r.id;
        this.form = f;
        this.badField = '';
        this.formBase = HisUI.snap(this.form, FORM_KEYS);
      },
      tryCloseForm() {
        if (HisUI.dirty(this.form, this.formBase, FORM_KEYS) && !HisUI.confirmDiscard()) return;
        this.form = null;
      },
      async save() {
        if (!this.form.name.trim()) {
          this.badField = 'name';
          return;
        }
        this.saving = true;
        try {
          const body = {};
          FORM_KEYS.forEach((k) => { body[k] = this.form[k]; });
          if (this.form.id) await this.$api.put('/launches/' + this.form.id, body);
          else await this.$api.post('/launches', body);
          this.$toast('已保存', 'ok');
          const keepId = this.form.id;
          this.form = null;
          await this.load();
          if (keepId && this.detail) await this.reloadDetail();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async del(r) {
        if (!r || !r.id) return;
        const msg = '删除「' + r.name + '」的上线档案？\n阶段任务与流转记录会一并删除，不可恢复。';
        if (!window.confirm(msg)) return;
        try {
          await this.$api.del('/launches/' + r.id);
          this.$toast('已删除', 'ok');
          if (this.detail && this.detail.id === r.id) this.detail = null;
          await this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      phaseStats(tasks) {
        const arr = tasks || [];
        return PHASES.map((p) => {
          const sub = arr.filter((t) => t.phase === p.key);
          const done = sub.filter((t) => t.done).length;
          return {
            key: p.key, name: p.name, total: sub.length, done,
            pct: sub.length ? Math.round(done / sub.length * 100) : 0,
          };
        });
      },
      tasksOf(tasks, phase) {
        return (tasks || []).filter((t) => t.phase === phase);
      },
      async addTask() {
        if (!this.detail || !this.taskForm.title.trim()) return;
        this.taskBusy = true;
        try {
          await this.$api.post('/launches/' + this.detail.id + '/tasks', {
            phase: this.taskForm.phase,
            title: this.taskForm.title,
            owner: this.taskForm.owner,
            due_date: this.taskForm.due_date,
          });
          this.taskForm = { phase: this.taskForm.phase, title: '', owner: '', due_date: '' };
          await this.reloadDetail();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.taskBusy = false;
        }
      },
      async toggleTask(t) {
        if (!this.canManage) return;
        try {
          await this.$api.put('/launches/tasks/' + t.id, { done: t.done ? 0 : 1 });
          await this.reloadDetail();
        } catch (e) {
          this.$toast(e.message, 'err');
        }
      },
      async rmTask(t) {
        if (!window.confirm('删除任务「' + t.title + '」？')) return;
        try {
          await this.$api.del('/launches/tasks/' + t.id);
          await this.reloadDetail();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      askStatus(key) {
        if (key === 'rolledback') { this.rbOpen = true; this.rbReason = ''; return; }
        const extra = key === 'live' ? '\n实际上线日期为空时会自动记为今天。' : '';
        if (!window.confirm('确认把「' + this.detail.name + '」转为「' + this.statusName(key) + '」？' + extra)) return;
        this.changeStatus(key, '');
      },
      doRollback() {
        if (!this.rbReason.trim()) return;
        this.changeStatus('rolledback', this.rbReason.trim());
      },
      async changeStatus(key, reason) {
        try {
          await this.$api.post('/launches/' + this.detail.id + '/status', { status: key, reason: reason || '' });
          this.$toast('状态已更新', 'ok');
          this.rbOpen = false;
          this.rbReason = '';
          await this.reloadDetail();
          await this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
    },
  };
})();
