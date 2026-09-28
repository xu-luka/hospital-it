/* 合同台账视图 + 统一用户管理/日志视图（合并系统）
   依赖：api（全局）、V（window.HisViews） */
(function () {
  const V = window.HisViews || {};
  const api = window.api; // 全局 API 封装（api.js）
  // 工具函数来自 app.js（window.HisUtils）
  const { fmtMoney, statusTag, daysLeft, todayStr, fmtDate, fmtSize } = window.HisUtils || {};

  /* ==================== 到期提醒 ==================== */
  V.RemindView = {
    data() { return { rows: [], loading: true }; },
    async mounted() { await this.load(); },
    methods: {
      async load() {
        this.loading = true;
        try { this.rows = await api.get('/api/contracts/expiring'); } catch (e) { this.$toast(e.message, 'err'); }
        this.loading = false;
      },
      goDetail(r) { location.hash = '#/contracts'; }
    },
    computed: {
      overdue() { return (this.rows || []).filter(r => r.days_left < 0); },
      soon() { return (this.rows || []).filter(r => r.days_left >= 0); }
    },
    template: `
    <div class="cm-root">
      <div class="page-title">到期提醒</div>
      <div class="page-sub">已过期与 30 天内到期的合同</div>
      <div class="panel" style="margin-bottom:20px">
        <div class="panel-head"><h3>已过期（{{ overdue.length }}）</h3></div>
        <table v-if="overdue.length">
          <tr><th>合同编号</th><th>合同名称</th><th>乙方</th><th>到期日期</th><th>逾期情况</th><th>状态</th><th>操作</th></tr>
          <tr v-for="r in overdue" :key="r.id">
            <td>{{ r.contract_no }}</td><td>{{ r.title }}</td><td>{{ r.party_b }}</td>
            <td>{{ r.end_date }}</td>
            <td><span class="tag tag-over">已过期 {{ Math.abs(r.days_left) }} 天</span></td>
            <td><span class="tag" :class="statusTag(r.status)">{{ r.status }}</span></td>
            <td><a @click="goDetail(r.id)" style="cursor:pointer">详情</a></td>
          </tr>
        </table>
        <div v-else class="empty">暂无已过期合同</div>
      </div>
      <div class="panel">
        <div class="panel-head"><h3>临期合同（{{ soon.length }}）</h3></div>
        <table v-if="soon.length">
          <tr><th>合同编号</th><th>合同名称</th><th>乙方</th><th>到期日期</th><th>剩余天数</th><th>状态</th><th>操作</th></tr>
          <tr v-for="r in soon" :key="r.id">
            <td>{{ r.contract_no }}</td><td>{{ r.title }}</td><td>{{ r.party_b }}</td>
            <td>{{ r.end_date }}</td>
            <td><span class="tag" :class="r.days_left <= 7 ? 'tag-over' : 'tag-warn'">剩 {{ r.days_left }} 天</span></td>
            <td><span class="tag" :class="statusTag(r.status)">{{ r.status }}</span></td>
            <td><a @click="goDetail(r.id)" style="cursor:pointer">详情</a></td>
          </tr>
        </table>
        <div v-else class="empty">近 30 天无到期合同</div>
      </div>
    </div>`
  };

  /* ==================== 合同台账（含 Excel 导入导出 + 详情/编辑弹窗） ==================== */
  V.ContractsView = {
    data() { return {
      keyword: '', category: '', status: '', sort: 'id_desc',
      rows: [], total: 0, page: 1, pageSize: 10, categories: [],
      importOpen: false, importFile: null, importing: false, importResult: null, exporting: false,
      detailId: null, editData: null
    }; },
    async mounted() { await this.loadCategories(); await this.load(); },
    methods: {
      async load() {
        const q = new URLSearchParams({ page: this.page, pageSize: this.pageSize, sort: this.sort });
        if (this.keyword) q.set('keyword', this.keyword);
        if (this.category) q.set('category', this.category);
        if (this.status) q.set('status', this.status);
        try { const r = await api.get('/api/contracts?' + q); this.rows = r.list; this.total = r.total; } catch (e) { this.$toast(e.message, 'err'); }
      },
      async loadCategories() { try { this.categories = await api.get('/api/contracts/categories'); } catch (e) {} },
      search() { this.page = 1; this.load(); },
      reset() { this.keyword=''; this.category=''; this.status=''; this.sort='id_desc'; this.page=1; this.load(); },
      setPage(p) { if (p < 1 || p > this.totalPages) return; this.page = p; this.load(); },
      // ---- Excel 导入导出 ----
      async exportExcel() {
        if (this.exporting) return;
        this.exporting = true;
        try {
          const q = new URLSearchParams();
          if (this.keyword) q.set('keyword', this.keyword);
          if (this.category) q.set('category', this.category);
          if (this.status) q.set('status', this.status);
          await api.download('/api/excel/export?' + q, '合同台账_' + todayStr() + '.xlsx');
        } catch (e) { alert(e.message); }
        this.exporting = false;
      },
      async downloadTemplate() {
        try { await api.download('/api/excel/template', '合同导入模板.xlsx'); }
        catch (e) { alert(e.message); }
      },
      openImport() { this.importOpen = true; this.importFile = null; this.importResult = null; },
      onImportFile(e) { this.importFile = e.target.files[0] || null; this.importResult = null; },
      async doImport() {
        if (!this.importFile) { alert('请先选择 Excel 文件'); return; }
        this.importing = true;
        const fd = new FormData();
        fd.append('file', this.importFile);
        try {
          const resp = await fetch('/api/excel/import', {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + api.token() }, body: fd
          });
          const r = await resp.json();
          if (r.code !== 0) throw new Error(r.message);
          this.importResult = r.data;
          await this.loadCategories();
          await this.load();
        } catch (e) { alert('导入失败：' + e.message); }
        this.importing = false;
      },
      // ---- 详情/编辑弹窗 ----
      openDetail(row) { this.detailId = row.id; },
      createContract() { this.editData = { isNew: true }; },
      editContract(row) { this.editData = { isNew: false, ...row }; },
      editFromDetail(c) { this.detailId = null; this.editData = { isNew: false, ...c }; },
      closeDetail() { this.detailId = null; },
      closeEdit() { this.editData = null; },
      afterContractChange() {
        this.detailId = null; this.editData = null;
        this.load();
      },
      goRemind() { location.hash = '#/remind'; },
    },
    computed: { totalPages() { return Math.max(1, Math.ceil(this.total / this.pageSize)); } },
    template: `
    <div class="cm-root">
      <div class="page-title">合同台账</div>
      <div class="page-sub">全部合同记录，共 {{ total }} 份</div>
      <div class="panel">
        <div class="toolbar">
          <input v-model="keyword" placeholder="搜索名称/编号/甲乙方" @keyup.enter="search" style="width:200px">
          <select v-model="category"><option value="">全部分类</option><option v-for="c in categories" :value="c">{{ c }}</option></select>
          <select v-model="status"><option value="">全部状态</option><option>进行中</option><option>已完成</option><option>已终止</option><option>草稿</option></select>
          <select v-model="sort"><option value="id_desc">最新优先</option><option value="end_date_asc">到期临近</option><option value="amount_desc">金额从高</option></select>
          <button class="btn btn-ghost" @click="search">查询</button>
          <button class="btn btn-ghost" @click="reset">重置</button>
          <div class="grow"></div>
          <button class="btn btn-ghost" @click="exportExcel" :disabled="exporting">{{ exporting ? '导出中…' : '导出Excel' }}</button>
          <button class="btn btn-ghost" @click="openImport">导入</button>
          <button class="btn btn-primary" @click="createContract">+ 新增合同</button>
        </div>
        <table class="cm-table">
          <thead>
            <tr><th>合同编号</th><th>名称</th><th>分类</th><th>乙方</th><th class="num">金额(元)</th><th class="num">已付/未付</th><th>到期日期</th><th>状态</th><th class="ops">操作</th></tr>
          </thead>
          <tbody>
            <tr v-if="!rows.length"><td colspan="9" class="empty">暂无数据，点击右上角新增</td></tr>
            <tr v-for="r in rows" :key="r.id">
              <td class="mono">{{ r.contract_no }}</td><td class="title-cell">{{ r.title }}</td>
              <td><span class="chip">{{ r.category || '-' }}</span></td>
              <td>{{ r.party_b || '-' }}</td><td class="num">{{ fmtMoney(r.amount) }}</td>
              <td class="num"><span style="color:#16a34a">{{ fmtMoney(r.paid_amount) }}</span> / <span style="color:var(--danger)">{{ fmtMoney(r.unpaid_amount) }}</span></td>
              <td class="mono">{{ r.end_date || '-' }}</td>
              <td><span class="tag" :class="statusTag(r.status)">{{ r.status }}</span></td>
              <td class="ops"><a @click="openDetail(r)" style="cursor:pointer">详情</a> <a @click="editContract(r)" style="cursor:pointer;margin-left:8px">编辑</a></td>
            </tr>
          </tbody>
        </table>
        <div class="pagination">
          <span>第 {{ page }} / {{ totalPages }} 页，共 {{ total }} 份</span>
          <select v-model.number="pageSize" @change="setPage(1)" title="每页显示条数">
            <option :value="10">10 条/页</option>
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
          </select>
          <button :disabled="page<=1" @click="setPage(page-1)">上一页</button>
          <button :disabled="page>=totalPages" @click="setPage(page+1)">下一页</button>
        </div>
      </div>

      <!-- Excel 导入弹窗 -->
      <div class="modal-mask" v-if="importOpen">
        <div class="modal modal-sm">
          <div class="modal-head"><h3>Excel 导入</h3><span class="modal-close" @click="importOpen=false">×</span></div>
          <div class="modal-body">
            <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:12px 14px;margin-bottom:14px;font-size:13px;color:#1e40af">
              第一次使用？请先 <a @click="downloadTemplate" style="cursor:pointer;text-decoration:underline;font-weight:600">下载导入模板</a>
              ，按模板列填写后上传。同一合同有多台设备时：填多行并保持合同编号一致，每行填一台设备。
            </div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <input type="file" accept=".xlsx,.xls" @change="onImportFile" style="font-size:13px;flex:1;min-width:180px">
              <button class="btn btn-primary btn-sm" :disabled="importing || !importFile" @click="doImport">{{ importing ? '导入中…' : '开始导入' }}</button>
            </div>
            <div v-if="importResult" style="margin-top:16px">
              <div style="padding:10px 14px;border-radius:8px;font-size:13px" :class="importResult.failed.length ? 'imp-warn' : 'imp-ok'">
                导入完成：成功 <b>{{ importResult.success }}</b> 份，跳过 <b>{{ importResult.skipped.length }}</b> 份（编号已存在），失败 <b>{{ importResult.failed.length }}</b> 条
              </div>
              <table v-if="importResult.failed.length || importResult.skipped.length" style="margin-top:10px">
                <tr><th>行号</th><th>合同编号</th><th>结果</th></tr>
                <tr v-for="f in importResult.failed" :key="'f'+f.row+String(f.contract_no)"><td>{{ f.row }}</td><td>{{ f.contract_no || '-' }}</td><td style="color:var(--danger)">失败：{{ f.reason }}</td></tr>
                <tr v-for="s in importResult.skipped" :key="'s'+s.row+String(s.contract_no)"><td>{{ s.row }}</td><td>{{ s.contract_no }}</td><td class="muted">跳过：{{ s.reason }}</td></tr>
              </table>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="importOpen=false">关闭</button>
          </div>
        </div>
      </div>

      <!-- 合同详情 / 编辑 -->
      <contract-detail-modal v-if="detailId" :id="detailId" @close="closeDetail" @edit="editFromDetail" @deleted="afterContractChange" @changed="afterContractChange"></contract-detail-modal>
      <contract-edit-modal v-if="editData" :edit="editData.isNew ? null : editData" @close="closeEdit" @saved="afterContractChange"></contract-edit-modal>
    </div>`
  };

  /* ==================== 合同详情（弹窗） ==================== */
  V.ContractDetailModal = {
    props: ['id'],
    data() { return { c: null, pickFile: null, uploading: false, payForm: { amount: 0, pay_date: todayStr(), method: '', remark: '' } }; },
    async mounted() { await this.load(); },
    methods: {
      async load() { try { this.c = await api.get('/api/contracts/' + this.id); } catch (e) { this.$toast(e.message, 'err'); } },
      onFileSelected(e) { this.pickFile = e.target.files[0] || null; },
      async onUpload() {
        if (!this.pickFile) { alert('请先选择文件'); return; }
        this.uploading = true;
        const fd = new FormData();
        fd.append('file', this.pickFile);
        try {
          const resp = await fetch('/api/files/' + this.c.id, {
            method: 'POST', headers: { 'Authorization': 'Bearer ' + api.token() }, body: fd
          });
          const r = await resp.json();
          if (r.code !== 0) throw new Error(r.message);
          this.pickFile = null;
          await this.load();
        } catch (e) { alert('上传失败：' + e.message); }
        this.uploading = false;
      },
      async delFile(f) {
        if (!confirm('确定删除附件「' + f.filename + '」？')) return;
        try { await api.del('/api/files/' + f.id); await this.load(); } catch (e) { alert(e.message); }
      },
      async downloadFile(f) {
        try { await api.download('/api/files/' + f.id + '/download', f.filename); }
        catch (e) { alert(e.message); }
      },
      async del() {
        if (!confirm('确定删除该合同及其所有附件？此操作不可恢复。')) return;
        try { await api.del('/api/contracts/' + this.c.id); this.$emit('deleted'); } catch (e) { alert(e.message); }
      },
      async addPayment() {
        const amt = parseFloat(this.payForm.amount);
        if (!amt || amt <= 0) { alert('请输入大于 0 的付款金额'); return; }
        if (!this.payForm.pay_date) { alert('请选择付款日期'); return; }
        try {
          await api.post('/api/payments', {
            contract_id: this.c.id, amount: amt, pay_date: this.payForm.pay_date,
            method: this.payForm.method, remark: this.payForm.remark
          });
          this.payForm = { amount: 0, pay_date: todayStr(), method: '', remark: '' };
          await this.load();
          this.$emit('changed');
        } catch (e) { alert(e.message); }
      },
      async delPayment(p) {
        if (!confirm('确定删除这笔付款记录（￥' + fmtMoney(p.amount) + '）？')) return;
        try { await api.del('/api/payments/' + p.id); await this.load(); this.$emit('changed'); } catch (e) { alert(e.message); }
      },
      deviceAmount(devices) {
        if (!Array.isArray(devices)) return 0;
        return devices.reduce((s, d) => s + (parseFloat(d.unit_price) || 0) * (parseInt(d.quantity, 10) || 0), 0);
      }
    },
    computed: {
      dl() { return this.c ? daysLeft(this.c.end_date) : null; }
    },
    template: `
    <div class="modal-mask" @click.self="$emit('close')">
      <div class="modal" style="width:720px">
        <div class="modal-head"><h3>合同详情</h3><span class="modal-close" @click="$emit('close')">×</span></div>
        <div class="modal-body" v-if="c">
          <div class="cm-grid">
            <div class="item"><b>合同编号</b><span>{{ c.contract_no }}</span></div>
            <div class="item"><b>状态</b><span><span class="tag" :class="statusTag(c.status)">{{ c.status }}</span></span></div>
            <div class="item full"><b>合同名称</b><span>{{ c.title }}</span></div>
            <div class="item"><b>甲方</b><span>{{ c.party_a || '-' }}</span></div>
            <div class="item"><b>乙方</b><span>{{ c.party_b || '-' }}</span></div>
            <div class="item"><b>分类</b><span>{{ c.category || '-' }}</span></div>
            <div class="item"><b>金额</b><span>￥{{ fmtMoney(c.amount) }}</span></div>
            <div class="item"><b>签订日期</b><span>{{ fmtDate(c.sign_date) }}</span></div>
            <div class="item"><b>开始日期</b><span>{{ fmtDate(c.start_date) }}</span></div>
            <div class="item"><b>到期日期</b><span>{{ fmtDate(c.end_date) }}</span></div>
            <div class="item"><b>到期提醒</b><span v-if="c.end_date">
              <span v-if="dl < 0" class="tag tag-over">已过期</span>
              <span v-else-if="dl <= 30" class="tag tag-warn">剩 {{ dl }} 天</span>
              <span v-else class="tag tag-ok">正常</span>
            </span><span v-else>-</span></div>
            <div class="item"><b>创建人</b><span>{{ c.creator_name || '-' }}</span></div>
            <div class="item full"><b>备注</b><span>{{ c.remark || '-' }}</span></div>
          </div>
          <template v-if="(c.devices && c.devices.length) || c.delivery_req || c.accept_date">
            <div class="detail-sec">设备与交付</div>
            <table v-if="c.devices && c.devices.length" style="margin-bottom:10px">
              <tr><th>#</th><th>设备名称</th><th>型号规格</th><th>数量</th><th>单价(元)</th><th>总价(元)</th><th>备注</th></tr>
              <tr v-for="(dv, i) in c.devices" :key="dv.id">
                <td>{{ i + 1 }}</td><td>{{ dv.name }}</td><td>{{ dv.model || '-' }}</td>
                <td>{{ dv.quantity }}</td><td>{{ dv.unit_price > 0 ? fmtMoney(dv.unit_price) : '-' }}</td>
                <td>{{ dv.unit_price > 0 ? fmtMoney(dv.unit_price * dv.quantity) : '-' }}</td><td>{{ dv.remark || '-' }}</td>
              </tr>
              <tr>
                <td colspan="5" style="text-align:right;font-weight:600;color:#475569">合计（{{ c.devices.length }} 种，{{ c.device_count }} 台/件）</td>
                <td style="font-weight:700;color:var(--primary)">￥{{ fmtMoney(deviceAmount(c.devices)) }}</td><td></td>
              </tr>
            </table>
            <div class="cm-grid">
              <div class="item"><b>验收日期</b><span>{{ fmtDate(c.accept_date) }}</span></div>
              <div class="item full" v-if="c.delivery_req"><b>交货要求</b><span>{{ c.delivery_req }}</span></div>
            </div>
          </template>
          <template v-if="c.service_start || c.service_end || c.pay_method">
            <div class="detail-sec">服务与付款</div>
            <div class="cm-grid">
              <div class="item"><b>服务生效日期</b><span>{{ fmtDate(c.service_start) }}</span></div>
              <div class="item"><b>服务结束日期</b><span>{{ fmtDate(c.service_end) }}</span></div>
              <div class="item full" v-if="c.pay_method"><b>付款方式</b><span>{{ c.pay_method }}</span></div>
            </div>
          </template>
          <template v-if="c.invoice_date || c.invoice_no || c.fund_type || c.agency || c.fund_source">
            <div class="detail-sec">发票与资金</div>
            <div class="cm-grid">
              <div class="item"><b>发票日期</b><span>{{ fmtDate(c.invoice_date) }}</span></div>
              <div class="item"><b>发票编号</b><span>{{ c.invoice_no || '-' }}</span></div>
              <div class="item"><b>资金性质</b><span>{{ c.fund_type || '-' }}</span></div>
              <div class="item"><b>代理公司</b><span>{{ c.agency || '-' }}</span></div>
              <div class="item"><b>资金来源</b><span>{{ c.fund_source || '-' }}</span></div>
            </div>
          </template>
          <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:4px">
            <h4 style="font-size:14px;margin-bottom:8px">付款进度</h4>
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:6px">
              <div style="flex:1">
                <div style="height:10px;background:#e2e8f0;border-radius:5px;overflow:hidden">
                  <div :style="{width: c.pay_percent + '%', height:'10px', background: c.pay_percent >= 100 ? '#16a34a' : '#2563eb', borderRadius:'5px'}"></div>
                </div>
              </div>
              <span style="font-size:14px;font-weight:600;color:#475569">{{ c.pay_percent }}%</span>
            </div>
            <div class="kv" style="margin-bottom:12px">
              <b style="color:#16a34a">已付 ￥{{ fmtMoney(c.paid_amount) }}</b>
              <span style="margin:0 10px;color:#cbd5e1">|</span>
              <b style="color:var(--danger)">未付 ￥{{ fmtMoney(c.unpaid_amount) }}</b>
              <span style="margin:0 10px;color:#cbd5e1">|</span>
              <span class="muted">总额 ￥{{ fmtMoney(c.amount) }}（{{ (c.payments || []).length }} 笔）</span>
            </div>
            <table v-if="c.payments && c.payments.length" style="margin-bottom:10px">
              <tr><th>日期</th><th>金额(元)</th><th>方式</th><th>备注</th><th>操作</th></tr>
              <tr v-for="p in c.payments" :key="p.id">
                <td>{{ p.pay_date }}</td><td>￥{{ fmtMoney(p.amount) }}</td>
                <td>{{ p.method || '-' }}</td><td>{{ p.remark || '-' }}</td>
                <td><a style="color:var(--danger);cursor:pointer" @click="delPayment(p)">删除</a></td>
              </tr>
            </table>
            <div class="empty" v-else style="padding:10px;margin-bottom:10px">暂无付款记录</div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;background:#f8fafc;border:1px dashed var(--border);border-radius:8px;padding:10px">
              <input v-model.number="payForm.amount" type="number" min="0" placeholder="金额" style="width:110px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <input v-model="payForm.pay_date" type="date" style="padding:6px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <select v-model="payForm.method" style="padding:7px 8px;border:1px solid var(--border);border-radius:6px;font-size:13px">
                <option value="">付款方式</option><option>银行转账</option><option>现金</option><option>支票</option><option>承兑汇票</option><option>其他</option>
              </select>
              <input v-model="payForm.remark" placeholder="备注" style="width:150px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;font-size:13px">
              <button class="btn btn-primary btn-sm" @click="addPayment">添加付款</button>
            </div>
          </div>
          <div style="border-top:1px solid var(--border);padding-top:14px;margin-top:14px">
            <h4 style="font-size:14px;margin-bottom:10px">附件（{{ (c.files || []).length }}）</h4>
            <ul class="file-list" v-if="c.files && c.files.length">
              <li v-for="f in c.files" :key="f.id">
                <span class="fname"><span>{{ f.filename }}</span><span class="fsize">{{ fmtSize(f.size) }}</span></span>
                <span>
                  <a @click="downloadFile(f)" style="margin-right:12px;cursor:pointer">下载</a>
                  <a style="color:var(--danger);cursor:pointer" @click="delFile(f)">删除</a>
                </span>
              </li>
            </ul>
            <div v-else class="empty" style="padding:14px">暂无附件</div>
            <div style="display:flex;gap:10px;margin-top:12px;align-items:center">
              <input type="file" @change="onFileSelected" style="font-size:13px">
              <button class="btn btn-primary btn-sm" :disabled="uploading" @click="onUpload">{{ uploading ? '上传中…' : '上传附件' }}</button>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn btn-ghost" @click="$emit('close')">关闭</button>
          <button class="btn btn-primary btn-sm" @click="$emit('edit', c)">编辑</button>
          <button class="btn btn-danger btn-sm" style="margin-left:auto" @click="del">删除合同</button>
        </div>
      </div>
    </div>`
  };

  /* ==================== 新增 / 编辑合同（弹窗 + 草稿缓存） ==================== */
  const CONTRACT_DRAFT_KEY = 'contract_draft_v1';
  V.ContractEditModal = {
    props: ['edit'],
    data() { return {
      f: { contract_no:'', title:'', category:'', party_a:'', party_b:'', amount:0, sign_date:'', start_date:'', end_date:'', status:'进行中', remark:'',
           delivery_req:'', accept_date:'', service_start:'', service_end:'', pay_method:'', invoice_date:'', invoice_no:'', fund_type:'', agency:'', fund_source:'' },
      devices: [], categories: [], saving: false
    }; },
    async mounted() {
      if (this.edit) {
        const src = this.edit;
        this.f = { contract_no:src.contract_no||'', title:src.title||'', category:src.category||'', party_a:src.party_a||'', party_b:src.party_b||'', amount:src.amount||0, sign_date:src.sign_date||'', start_date:src.start_date||'', end_date:src.end_date||'', status:src.status||'进行中', remark:src.remark||'',
          delivery_req:src.delivery_req||'', accept_date:src.accept_date||'', service_start:src.service_start||'', service_end:src.service_end||'', pay_method:src.pay_method||'', invoice_date:src.invoice_date||'', invoice_no:src.invoice_no||'', fund_type:src.fund_type||'', agency:src.agency||'', fund_source:src.fund_source||'' };
        try {
          const d = await api.get('/api/contracts/' + this.edit.id);
          this.devices = (d.devices || []).map(x => ({ name:x.name, model:x.model||'', quantity:x.quantity, unit_price:x.unit_price||0, remark:x.remark||'' }));
        } catch (e) {}
      } else {
        const draft = this.loadDraft();
        if (draft && this.draftHasContent(draft)) {
          const when = draft.savedAt ? new Date(draft.savedAt).toLocaleString('zh-CN') : '上次';
          if (confirm('检测到 ' + when + ' 录入未保存的草稿，是否恢复？\n\n【确定】恢复草稿继续填写\n【取消】丢弃草稿重新开始')) {
            this.f = Object.assign({}, this.f, draft.f);
            this.devices = draft.devices && draft.devices.length ? draft.devices : [this.newDeviceRow()];
          } else {
            this.clearDraft();
          }
        }
      }
      if (!this.devices.length) this.devices = [this.newDeviceRow()];
      try { this.categories = await api.get('/api/contracts/categories'); } catch (e) {}
    },
    watch: {
      f: { handler() { this.saveDraft(); }, deep: true },
      devices: { handler() { this.saveDraft(); }, deep: true }
    },
    methods: {
      loadDraft() {
        try { return JSON.parse(localStorage.getItem(CONTRACT_DRAFT_KEY)); } catch (e) { return null; }
      },
      saveDraft() {
        if (this.edit) return;
        try { localStorage.setItem(CONTRACT_DRAFT_KEY, JSON.stringify({ f: this.f, devices: this.devices, savedAt: Date.now() })); } catch (e) {}
      },
      clearDraft() {
        try { localStorage.removeItem(CONTRACT_DRAFT_KEY); } catch (e) {}
      },
      draftHasContent(draft) {
        if (!draft) return false;
        const emptyF = { contract_no:'', title:'', category:'', party_a:'', party_b:'', amount:0, sign_date:'', start_date:'', end_date:'', status:'进行中', remark:'', delivery_req:'', accept_date:'', service_start:'', service_end:'', pay_method:'', invoice_date:'', invoice_no:'', fund_type:'', agency:'', fund_source:'' };
        const fChanged = JSON.stringify(Object.assign({}, emptyF, draft.f)) !== JSON.stringify(emptyF);
        const devFilled = Array.isArray(draft.devices) && draft.devices.some(d => d && String(d.name||'').trim());
        return fChanged || devFilled;
      },
      newDeviceRow() { return { name: '', model: '', quantity: 1, unit_price: 0, remark: '' }; },
      addDeviceRow() { this.devices.push(this.newDeviceRow()); },
      removeDeviceRow(i) {
        this.devices.splice(i, 1);
        if (!this.devices.length) this.devices.push(this.newDeviceRow());
      },
      deviceTotalQty() {
        return this.devices.reduce((s, d) => s + (parseInt(d.quantity, 10) || 0), 0);
      },
      deviceTotalAmount() {
        return this.devices.reduce((s, d) => s + (parseFloat(d.unit_price) || 0) * (parseInt(d.quantity, 10) || 0), 0);
      },
      rowTotal(d) {
        return (parseFloat(d.unit_price) || 0) * (parseInt(d.quantity, 10) || 0);
      },
      async save() {
        this.saving = true;
        try {
          const devices = (this.devices || []).filter(d => d && typeof d === 'object');
          const payload = Object.assign({}, this.f, { devices });
          if (this.edit) await api.put('/api/contracts/' + this.edit.id, payload);
          else await api.post('/api/contracts', payload);
          this.clearDraft();
          this.$emit('saved');
          this.$emit('close');
        } catch (e) { alert(e.message); }
        this.saving = false;
      }
    },
    template: `
    <div class="modal-mask">
      <div class="modal">
        <div class="modal-head"><h3>{{ edit ? '编辑合同' : '新增合同' }}</h3><span class="modal-close" @click="$emit('close')">×</span></div>
        <div class="modal-body">
          <div class="form-sec">基本信息</div>
          <div class="form-grid">
            <div><label>合同编号 *</label><input v-model="f.contract_no" placeholder="如 HT-2026-001"></div>
            <div><label>状态</label><select v-model="f.status"><option>进行中</option><option>已完成</option><option>已终止</option><option>草稿</option></select></div>
            <div class="full"><label>合同名称 *</label><input v-model="f.title"></div>
            <div><label>分类</label><input v-model="f.category" list="catList" placeholder="采购/服务/工程…"><datalist id="catList"><option v-for="c in categories" :value="c"></option></datalist></div>
            <div><label>合同金额(元)</label><input v-model.number="f.amount" type="number" min="0"></div>
            <div><label>甲方</label><input v-model="f.party_a"></div>
            <div><label>乙方</label><input v-model="f.party_b"></div>
            <div><label>签订日期</label><input v-model="f.sign_date" type="date"></div>
            <div><label>开始日期</label><input v-model="f.start_date" type="date"></div>
            <div><label>到期日期</label><input v-model="f.end_date" type="date"></div>
          </div>
          <div class="form-sec">设备与交付</div>
          <div class="device-table">
            <div class="device-row device-head">
              <span>设备名称 *</span><span>型号规格</span><span>数量</span><span>单价(元)</span><span>总价(元)</span><span>备注</span><span></span>
            </div>
            <div class="device-row" v-for="(d, i) in devices" :key="i">
              <input v-model="d.name" placeholder="如：机架服务器">
              <input v-model="d.model" placeholder="如：ThinkSystem SR650">
              <input v-model.number="d.quantity" type="number" min="1" style="width:64px">
              <input v-model.number="d.unit_price" type="number" min="0" step="0.01" placeholder="0.00" style="width:100px">
              <span class="dev-total">{{ fmtMoney(rowTotal(d)) }}</span>
              <input v-model="d.remark" placeholder="选填">
              <a class="dev-del" @click="removeDeviceRow(i)">删</a>
            </div>
            <div class="device-foot">
              <button type="button" class="btn btn-ghost btn-sm" @click="addDeviceRow">+ 添加设备</button>
              <span class="muted" style="font-size:13px">共 {{ devices.filter(d=>d.name).length }} 种设备，合计 {{ deviceTotalQty() }} 台/件，金额 ￥{{ fmtMoney(deviceTotalAmount()) }}</span>
            </div>
          </div>
          <div class="form-grid" style="margin-top:12px">
            <div><label>交货要求</label><input v-model="f.delivery_req" placeholder="如：分两批交货，验收合格后交付"></div>
            <div><label>验收日期</label><input v-model="f.accept_date" type="date"></div>
          </div>
          <div class="form-sec">服务与付款</div>
          <div class="form-grid">
            <div><label>服务生效日期</label><input v-model="f.service_start" type="date"></div>
            <div><label>服务结束日期</label><input v-model="f.service_end" type="date"></div>
            <div class="full"><label>付款方式</label><input v-model="f.pay_method" list="pmList" placeholder="选择或输入自定义付款方式"><datalist id="pmList"><option>一次性付款</option><option>分期付款</option><option>验收后付款</option><option>货到付款</option><option>预付款</option><option>银行转账</option><option>承兑汇票</option><option>其他</option></datalist></div>
          </div>
          <div class="form-sec">发票与资金</div>
          <div class="form-grid">
            <div><label>发票日期</label><input v-model="f.invoice_date" type="date"></div>
            <div><label>发票编号</label><input v-model="f.invoice_no" placeholder="如 FP-2026-001"></div>
            <div><label>资金性质</label><input v-model="f.fund_type" list="ftList" placeholder="如：财政资金/自有资金"><datalist id="ftList"><option>财政资金</option><option>自有资金</option><option>专项经费</option><option>其他</option></datalist></div>
            <div><label>代理公司</label><input v-model="f.agency"></div>
            <div><label>资金来源</label><input v-model="f.fund_source" list="fsList" placeholder="如：上级拨付"><datalist id="fsList"><option>上级拨付</option><option>单位自筹</option><option>项目预算</option><option>其他</option></datalist></div>
          </div>
          <div class="form-sec">其他</div>
          <div class="form-grid">
            <div class="full"><label>备注</label><textarea v-model="f.remark"></textarea></div>
          </div>
        </div>
        <div class="modal-foot">
          <span v-if="!edit" class="muted" style="font-size:12px;margin-right:auto">内容已自动缓存，关闭后下次可恢复</span>
          <button class="btn btn-ghost" @click="$emit('close')">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
        </div>
      </div>
    </div>`
  };

  /* ==================== 用户管理（统一账号体系） ==================== */
  V.UsersView = {
    data() { return { users: [], roles: [], form: null, saving: false }; },
    async mounted() { await this.load(); },
    methods: {
      async load() {
        try { this.users = await api.get('/api/users'); } catch (e) { this.$toast(e.message, 'err'); }
        try { this.roles = await api.get('/api/roles'); } catch (e) {}
      },
      roleName(id) { const r = this.roles.find(x => x.id === id); return r ? r.name : '-'; },
      openAdd() { this.form = { isAdd: true, username: '', real_name: '', password: '', role_id: 3 }; },
      openEdit(u) { this.form = { isAdd: false, id: u.id, username: u.username, real_name: u.realName, password: '', role_id: u.roleId, is_active: u.isActive }; },
      async save() {
        if (!this.form) return;
        this.saving = true;
        try {
          if (this.form.isAdd) {
            await api.post('/api/users', { username: this.form.username, real_name: this.form.real_name, password: this.form.password, role_id: this.form.role_id });
          } else {
            const body = { real_name: this.form.real_name, role_id: this.form.role_id, is_active: this.form.is_active };
            if (this.form.password) body.password = this.form.password;
            await api.put('/api/users/' + this.form.id, body);
          }
          this.form = null; await this.load();
          this.$toast('已保存', 'ok');
        } catch (e) { alert(e.message); }
        this.saving = false;
      },
      async toggle(u) {
        try { await api.put('/api/users/' + u.id, { is_active: u.isActive ? 0 : 1 }); await this.load(); } catch (e) { alert(e.message); }
      },
      async del(u) {
        if (!confirm('确定删除用户「' + u.username + '」？')) return;
        try { await api.del('/api/users/' + u.id); await this.load(); } catch (e) { alert(e.message); }
      }
    },
    template: `
    <div>
      <div class="page-title">用户管理</div>
      <div class="page-sub">维护系统账号、角色与启用状态</div>
      <div class="panel">
        <div class="panel-head"><h3>用户列表</h3><button class="btn btn-primary btn-sm" @click="openAdd">+ 新增用户</button></div>
        <table>
          <tr><th>用户名</th><th>姓名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
          <tr v-if="!users.length"><td colspan="6" class="empty">暂无用户</td></tr>
          <tr v-for="u in users" :key="u.id">
            <td>{{ u.username }}</td><td>{{ u.realName || '-' }}</td><td>{{ roleName(u.roleId) }}</td>
            <td><span class="tag" :class="u.isActive ? 'tag-ok' : 'tag-stop'">{{ u.isActive ? '启用' : '停用' }}</span></td>
            <td>{{ u.createdAt || u.created_at || '-' }}</td>
            <td class="actions-cell">
              <button class="btn btn-ghost btn-sm" @click="openEdit(u)">编辑</button>
              <button class="btn btn-ghost btn-sm" @click="toggle(u)">{{ u.isActive ? '停用' : '启用' }}</button>
              <button class="btn btn-danger btn-sm" @click="del(u)">删除</button>
            </td>
          </tr>
        </table>
      </div>
      <div class="modal-mask" v-if="form" @click.self="form=null">
        <div class="modal modal-sm">
          <div class="modal-head"><h3>{{ form.isAdd ? '新增用户' : '编辑用户' }}</h3><span class="modal-close" @click="form=null">×</span></div>
          <div class="modal-body">
            <div class="form-grid">
              <div><label>用户名</label><input v-model="form.username" :disabled="!form.isAdd"></div>
              <div><label>姓名</label><input v-model="form.real_name"></div>
              <div><label>角色</label><select v-model="form.role_id"><option v-for="r in roles" :value="r.id">{{ r.name }}</option></select></div>
              <div><label>{{ form.isAdd ? '初始密码' : '重置密码(留空不改)' }}</label><input v-model="form.password" type="password"></div>
              <div class="full" v-if="!form.isAdd"><label><input type="checkbox" v-model="form.is_active" style="width:auto;margin-right:6px">启用账号</label></div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-ghost" @click="form=null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">{{ saving ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>`
  };

  /* ==================== 操作日志（统一日志） ==================== */
  V.LogsView = {
    data() { return { rows: [], actions: [], keyword: '', action: '', page: 1, pageSize: 20, total: 0 }; },
    async mounted() { await this.loadActions(); await this.load(); },
    methods: {
      async load() {
        const q = new URLSearchParams({ page: this.page, pageSize: this.pageSize });
        if (this.keyword) q.set('keyword', this.keyword);
        if (this.action) q.set('action', this.action);
        try { const r = await api.get('/api/logs?' + q); this.rows = r.list; this.total = r.total; } catch (e) { this.$toast(e.message, 'err'); }
      },
      async loadActions() { try { this.actions = await api.get('/api/logs/actions'); } catch (e) {} },
      search() { this.page = 1; this.load(); },
      setPage(p) { if (p < 1 || p > this.totalPages) return; this.page = p; this.load(); }
    },
    computed: { totalPages() { return Math.max(1, Math.ceil(this.total / this.pageSize)); } },
    template: `
    <div>
      <div class="page-title">操作日志</div>
      <div class="page-sub">系统关键操作审计记录</div>
      <div class="panel">
        <div class="toolbar">
          <input v-model="keyword" placeholder="搜索用户/详情" style="width:180px" @keyup.enter="search">
          <select v-model="action"><option value="">全部操作</option><option v-for="a in actions" :value="a">{{ a }}</option></select>
          <button class="btn btn-ghost" @click="search">查询</button>
        </div>
        <table>
          <tr><th>时间</th><th>用户</th><th>操作</th><th>详情</th><th>IP</th></tr>
          <tr v-if="!rows.length"><td colspan="5" class="empty">暂无日志</td></tr>
          <tr v-for="r in rows" :key="r.id">
            <td>{{ r.created_at }}</td><td>{{ r.username }}</td><td>{{ r.action }}</td><td>{{ r.detail }}</td><td>{{ r.ip }}</td>
          </tr>
        </table>
        <div class="pagination">
          <span>第 {{ page }} / {{ totalPages }} 页，共 {{ total }} 条</span>
          <select v-model.number="pageSize" @change="setPage(1)" title="每页显示条数">
            <option :value="10">10 条/页</option>
            <option :value="20">20 条/页</option>
            <option :value="50">50 条/页</option>
            <option :value="100">100 条/页</option>
          </select>
          <button :disabled="page<=1" @click="setPage(page-1)">上一页</button>
          <button :disabled="page>=totalPages" @click="setPage(page+1)">下一页</button>
        </div>
      </div>
    </div>`
  };

  window.HisViews = V;
})();