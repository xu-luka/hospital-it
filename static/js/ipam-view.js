/* IP 管理（网段 + 已用 IP 登记）
 *
 * 用户诉求：自己登记院内已使用的 IP，先设网段，再按网段登记。
 *
 * 页面刻意分成两页签：
 *   ·「网段」看的是**容量**（这个段有多少地址、还剩几个、跟哪个段重叠）；
 *   ·「IP 登记」看的是**明细**（哪个地址给了谁）。
 * 混在一张表里会出现「一行是网段、一行是 IP」这种扫视灾难。
 *
 * 校验一律以后端为准（归属判断、判重都在服务端做一遍），前端这里只做
 * 明显的即时提示（比如批量登记先 dry_run 预览），避免「前端说没问题、提交后被拒」。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  const STATUS_BADGE = { used: 'ok', reserved: 'warn', free: 'muted', conflict: 'err' };

  V.IpamView = {
    template: `
    <div>
      <div class="page-head">
        <div>
          <h2>IP 管理</h2>
          <div class="muted">先建立网段，再按网段登记已使用的地址；系统负责判断归属、判重与统计剩余可用地址。</div>
        </div>
        <div class="page-actions">
          <button v-if="canManage" class="btn btn-outline" @click="openBulk">批量登记</button>
          <button v-if="canManage" class="btn btn-outline" @click="openSegForm(null)">新增网段</button>
          <button v-if="canManage" class="btn btn-primary" :disabled="!segs.length" @click="openIpForm(null)">登记 IP</button>
        </div>
      </div>

      <div class="stat-grid">
        <div class="stat-card">
          <div class="bar bar-blue"></div>
          <div class="num">{{ summary.segments || 0 }}</div>
          <div class="lbl">已建网段</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-gray"></div>
          <div class="num">{{ summary.host_count || 0 }}</div>
          <div class="lbl">地址容量（各段合计）</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-blue"></div>
          <div class="num">{{ summary.registered || 0 }}</div>
          <div class="lbl">已登记</div>
        </div>
        <div class="stat-card">
          <div class="bar bar-green"></div>
          <div class="num">{{ summary.used || 0 }}</div>
          <div class="lbl">标记为已使用</div>
        </div>
        <div class="stat-card" :class="{ warn: (summary.conflict || 0) > 0 }">
          <div class="bar bar-red"></div>
          <div class="num">{{ summary.conflict || 0 }}</div>
          <div class="lbl">冲突待处理</div>
        </div>
      </div>

      <div class="filter-bar">
        <div class="seg">
          <button class="seg-btn" :class="{ on: tab === 'seg' }" @click="tab = 'seg'">网段（{{ segs.length }}）</button>
          <button class="seg-btn" :class="{ on: tab === 'ip' }" @click="tab = 'ip'; loadIps()">IP 登记（{{ ipTotal }}）</button>
        </div>
        <div class="grow"></div>
        <button class="btn btn-outline" @click="refreshAll">刷新</button>
      </div>

      <!-- ============ 网段 ============ -->
      <div class="card card-flush" v-if="tab === 'seg'">
        <div class="table-wrap">
          <table class="tbl ip-table">
            <thead>
              <tr>
                <th class="c-name">网段名称</th>
                <th class="c-cidr">CIDR</th>
                <th class="c-gw">网关</th>
                <th class="c-vlan">VLAN</th>
                <th class="c-loc">位置</th>
                <th class="c-cap">地址容量</th>
                <th class="c-use">使用情况</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="loadingSeg"><td colspan="8" class="empty-row">加载中…</td></tr>
              <tr v-else-if="!segs.length">
                <td colspan="8" class="empty-row">
                  还没有网段。{{ canManage ? '点右上角「新增网段」先建一个（如 192.168.10.0/24）。' : '请联系管理员建立网段。' }}
                </td>
              </tr>
              <tr v-for="s in segs" :key="s.id">
                <td>
                  <span class="cell-strong">{{ s.name }}</span>
                  <span class="cell-sub" v-if="s.note">{{ s.note }}</span>
                  <span class="cell-sub warn-text" v-if="s.overlaps && s.overlaps.length">
                    与「{{ s.overlaps.join('、') }}」范围重叠
                  </span>
                </td>
                <td>
                  <span class="mono cell-strong">{{ s.cidr }}</span>
                  <span class="cell-sub mono">{{ s.first_host }} ~ {{ s.last_host }}</span>
                </td>
                <td><span class="mono" v-if="s.gateway">{{ s.gateway }}</span><span v-else class="muted">—</span></td>
                <td><span v-if="s.vlan" class="chip">{{ s.vlan }}</span><span v-else class="muted">—</span></td>
                <td><span class="cell-sub">{{ s.location || '—' }}</span></td>
                <td class="num">
                  {{ s.host_count }}
                  <span class="cell-sub">可用地址</span>
                </td>
                <td>
                  <div class="ip-usage">
                    <div class="ip-track"><div :class="usageClass(s)" :style="usageStyle(s)"></div></div>
                    <span class="ip-pct">{{ pct(s) }}%</span>
                  </div>
                  <span class="cell-sub">
                    已登记 {{ s.registered }} · 剩余 {{ s.free_count }}
                    <template v-if="s.conflict"> · <b class="err-text">冲突 {{ s.conflict }}</b></template>
                  </span>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="openFree(s)">空闲地址</button>
                  <template v-if="canManage">
                    <button class="btn btn-sm btn-outline" @click="openSegForm(s)">编辑</button>
                    <button class="btn btn-sm btn-outline btn-danger" @click="delSeg(s)">删除</button>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="hint">
          使用率 = 标记为「已使用」的条数 ÷ 该网段可用地址数（/31 与 /32 不扣网络/广播地址）。
          「范围重叠」只作提示不拦：全院 /16 与科室 /24 并存时，同一个地址在两层都登记是合理的。
        </div>
      </div>

      <!-- ============ IP 登记 ============ -->
      <div v-show="tab === 'ip'">
        <div class="filter-bar">
          <select class="ipt" v-model="fSeg" @change="page = 1; loadIps()">
            <option :value="0">全部网段</option>
            <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
          </select>
          <select class="ipt" v-model="fStatus" @change="page = 1; loadIps()">
            <option value="">全部状态</option>
            <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
          </select>
          <input class="ipt grow" v-model="kw" placeholder="搜索 IP / 主机名 / 使用人 / MAC / 备注" @keyup.enter="page = 1; loadIps()">
          <button class="btn btn-outline" @click="page = 1; loadIps()">查询</button>
          <button class="btn btn-outline" @click="resetIp">重置</button>
        </div>

        <div class="card card-flush">
          <div class="table-wrap">
            <table class="tbl ip-table">
              <thead>
                <tr>
                  <th class="c-ip">IP 地址</th>
                  <th class="c-st">状态</th>
                  <th class="c-host">主机名 / 用途</th>
                  <th class="c-owner">使用人 / 科室</th>
                  <th class="c-type">设备类型</th>
                  <th class="c-mac">MAC</th>
                  <th class="c-note">备注</th>
                  <th class="c-ops">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loadingIp"><td colspan="8" class="empty-row">加载中…</td></tr>
                <tr v-else-if="!ips.length">
                  <td colspan="8" class="empty-row">
                    没有匹配的登记。{{ canManage && segs.length ? '可点右上角「登记 IP」或「批量登记」。' : '' }}
                  </td>
                </tr>
                <tr v-for="r in ips" :key="r.id">
                  <td>
                    <span class="mono cell-strong">{{ r.ip }}</span>
                    <span class="cell-sub">{{ segmentLabel(r.segment_id) }}</span>
                  </td>
                  <td><span class="dev-badge" :class="badgeOf(r.status)">{{ r.status_label }}</span></td>
                  <td><span class="cell-strong">{{ r.hostname || '—' }}</span></td>
                  <td><span class="cell-sub">{{ r.owner || '—' }}</span></td>
                  <td><span class="cell-sub">{{ r.device_type || '—' }}</span></td>
                  <td><span class="mono">{{ r.mac || '—' }}</span></td>
                  <td><span class="cell-sub">{{ r.note || '—' }}</span></td>
                  <td class="ops">
                    <template v-if="canManage">
                      <button class="btn btn-sm btn-outline" @click="openIpForm(r)">编辑</button>
                      <button class="btn btn-sm btn-outline btn-danger" @click="delIp(r)">删除</button>
                    </template>
                    <span v-else class="muted">—</span>
                  </td>
                </tr>
              </tbody>
              <tfoot v-if="ips.length">
                <tr>
                  <td colspan="2">本页 {{ ips.length }} 条</td>
                  <td colspan="6">全部 {{ ipTotal }} 条</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <div class="hint">
            登记时会校验：地址格式 → 是否属于所选网段 → 同一网段内是否已登记。
            同一地址若同时落在另一个网段内，会给出提示但不拦截。
          </div>
        </div>

        <div class="pager" v-if="ipTotal > pageSize">
          <span class="muted">第 {{ page }} / {{ pageCount }} 页</span>
          <button class="btn btn-sm btn-outline" :disabled="page <= 1" @click="goto(page - 1)">上一页</button>
          <button class="btn btn-sm btn-outline" :disabled="page >= pageCount" @click="goto(page + 1)">下一页</button>
        </div>
      </div>

      <!-- ============ 网段表单 ============ -->
      <div class="modal-mask" v-if="segForm" @click.self="segForm = null">
        <div class="modal" style="width:560px">
          <div class="modal-head">{{ segForm.id ? '编辑网段' : '新增网段' }}<span class="modal-close" @click="segForm = null">✕</span></div>
          <div class="modal-body">
            <div class="form-item">
              <label>网段名称 *</label>
              <input v-model="segForm.name" placeholder="如：门诊内网 / 住院楼无线">
            </div>
            <div class="form-item">
              <label>CIDR *</label>
              <input class="mono" v-model="segForm.cidr" placeholder="192.168.10.0/24">
              <div class="muted" v-if="segForm.id">缩小掩码会把已登记的地址甩出网段，这种情况会被拒绝并列出是哪几条。</div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>网关</label>
                <input class="mono" v-model="segForm.gateway" placeholder="192.168.10.1">
              </div>
              <div class="form-item">
                <label>VLAN</label>
                <input v-model="segForm.vlan" placeholder="如 10">
              </div>
            </div>
            <div class="form-item">
              <label>位置 / 归属</label>
              <input v-model="segForm.location" placeholder="如：门诊楼 3F 弱电间">
            </div>
            <div class="form-item">
              <label>备注</label>
              <textarea rows="2" v-model="segForm.note"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="segForm = null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveSeg">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- ============ IP 表单 ============ -->
      <div class="modal-mask" v-if="ipForm" @click.self="ipForm = null">
        <div class="modal" style="width:600px">
          <div class="modal-head">{{ ipForm.id ? '编辑登记' : '登记 IP' }}<span class="modal-close" @click="ipForm = null">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item">
                <label>所属网段 *</label>
                <select v-model="ipForm.segment_id">
                  <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
                </select>
              </div>
              <div class="form-item">
                <label>IP 地址 *</label>
                <input class="mono" v-model="ipForm.ip" placeholder="192.168.10.20">
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>状态</label>
                <select v-model="ipForm.status">
                  <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
                </select>
              </div>
              <div class="form-item">
                <label>设备类型</label>
                <input v-model="ipForm.device_type" placeholder="如：打印机 / 摄像头 / PC">
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>主机名 / 用途</label>
                <input v-model="ipForm.hostname" placeholder="如：门诊自助机 3 号">
              </div>
              <div class="form-item">
                <label>使用人 / 科室</label>
                <input v-model="ipForm.owner" placeholder="如：门诊办 张工">
              </div>
            </div>
            <div class="form-item">
              <label>MAC 地址</label>
              <input class="mono" v-model="ipForm.mac" placeholder="00-1A-2B-3C-4D-5E（可留空）">
            </div>
            <div class="form-item">
              <label>备注</label>
              <textarea rows="2" v-model="ipForm.note"></textarea>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="ipForm = null">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="saveIp">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- ============ 批量登记 ============ -->
      <div class="modal-mask" v-if="bulkForm" @click.self="bulkForm = null">
        <div class="modal" style="width:680px">
          <div class="modal-head">批量登记 IP<span class="modal-close" @click="bulkForm = null">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item">
                <label>所属网段 *</label>
                <select v-model="bulkForm.segment_id">
                  <option v-for="s in segs" :key="s.id" :value="s.id">{{ s.name }}（{{ s.cidr }}）</option>
                </select>
              </div>
              <div class="form-item">
                <label>统一状态</label>
                <select v-model="bulkForm.status">
                  <option v-for="st in statuses" :key="st.code" :value="st.code">{{ st.label }}</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-item">
                <label>统一使用人 / 科室</label>
                <input v-model="bulkForm.owner" placeholder="可留空，逐条在备注里写">
              </div>
              <div class="form-item">
                <label>统一设备类型</label>
                <input v-model="bulkForm.device_type">
              </div>
            </div>
            <div class="form-item">
              <label>地址清单（每行一条）</label>
              <textarea rows="7" v-model="bulkForm.text"
                placeholder="192.168.10.20 门诊自助机3号&#10;192.168.10.21-192.168.10.30 诊室 PC&#10;192.168.10.128/28 摄像头段&#10;支持逗号/顿号分隔；# 开头的行是注释"></textarea>
            </div>

            <div v-if="bulkForm.preview" class="bulk-preview">
              <div class="bulk-line">
                解析出 <b>{{ bulkForm.preview.total }}</b> 个地址，其中
                <b class="ok-text">{{ bulkForm.preview.valid }}</b> 个属于本网段
                <template v-if="bulkForm.preview.outside.length">
                  ，<b class="err-text">{{ bulkForm.preview.outside.length }}</b> 个不在本网段
                </template>
                <template v-if="bulkForm.preview.invalid.length">
                  ，<b class="err-text">{{ bulkForm.preview.invalid.length }}</b> 行无法识别
                </template>
              </div>
              <div class="bulk-chips">
                <span v-for="x in bulkForm.preview.sample" :key="x.ip"
                      :class="{ outside: !x.in_segment }">{{ x.ip }}</span>
                <span v-if="bulkForm.preview.total > bulkForm.preview.sample.length" class="muted">
                  …（仅显示前 {{ bulkForm.preview.sample.length }} 个）
                </span>
              </div>
              <div class="hint" v-if="bulkForm.preview.invalid.length">
                无法识别的行：{{ bulkForm.preview.invalid.slice(0, 5).map(i => i.text + '（' + i.reason + '）').join('；') }}
              </div>
            </div>
            <div v-else-if="bulkForm.result" class="bulk-preview">
              <div class="bulk-line">
                新增 <b class="ok-text">{{ bulkForm.result.added }}</b> 条，
                失败 <b class="err-text">{{ bulkForm.result.failed.length }}</b> 条
              </div>
              <div class="hint" v-if="bulkForm.result.failed.length">
                失败明细：{{ bulkForm.result.failed.slice(0, 8).map(f => f.ip + '（' + f.error + '）').join('；') }}
              </div>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="bulkForm = null">关闭</button>
            <button class="btn btn-outline" :disabled="saving" @click="doBulk(true)">预览</button>
            <button class="btn btn-primary" :disabled="saving || !bulkForm.text.trim()" @click="doBulk(false)">
              {{ saving ? '处理中' : '确认登记' }}
            </button>
          </div>
        </div>
      </div>

      <!-- ============ 空闲地址 ============ -->
      <div class="modal-mask" v-if="freeView" @click.self="freeView = null">
        <div class="modal" style="width:640px">
          <div class="modal-head">空闲地址 · {{ freeView.name }}<span class="modal-close" @click="freeView = null">✕</span></div>
          <div class="modal-body">
            <div class="bulk-line">
              {{ freeView.cidr }} · 可用 {{ freeView.host_count }} · 已登记 {{ freeView.registered }} ·
              剩余 <b class="ok-text">{{ freeView.free_count }}</b>
            </div>
            <div class="bulk-chips" v-if="freeView.ips.length">
              <span v-for="ip in freeView.ips" :key="ip">{{ ip }}</span>
            </div>
            <div v-else class="muted">该网段已没有未登记的地址。</div>
            <div class="hint" v-if="freeView.truncated">列表只显示前 {{ freeView.ips.length }} 个（按地址顺序）。</div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="freeView = null">关闭</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        tab: 'seg',
        segs: [], summary: {}, statuses: [],
        ips: [], ipTotal: 0, page: 1, pageSize: 100,
        fSeg: 0, fStatus: '', kw: '',
        loadingSeg: false, loadingIp: false, saving: false,
        segForm: null, ipForm: null, bulkForm: null, freeView: null,
      };
    },

    computed: {
      canManage() { return !!(window.HisPerm && window.HisPerm.can('ipam.manage')); },
      pageCount() { return Math.max(1, Math.ceil(this.ipTotal / this.pageSize)); },
    },

    mounted() { this.refreshAll(); },

    methods: {
      refreshAll() { this.loadSegments(); if (this.tab === 'ip') this.loadIps(); },

      async loadSegments() {
        this.loadingSeg = true;
        try {
          const d = await api.get('/ipam/segments');
          this.segs = (d && d.list) || [];
          this.summary = (d && d.summary) || {};
          this.statuses = (d && d.statuses) || [];
          if (!this.segForm && !this.ipForm && !this.bulkForm) this.loadIps();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loadingSeg = false;
        }
      },

      async loadIps() {
        this.loadingIp = true;
        try {
          const q = '?segment_id=' + (this.fSeg || 0)
            + '&status=' + encodeURIComponent(this.fStatus || '')
            + '&keyword=' + encodeURIComponent(this.kw || '')
            + '&page=' + this.page + '&pageSize=' + this.pageSize;
          const d = await api.get('/ipam/ips' + q);
          this.ips = (d && d.list) || [];
          this.ipTotal = (d && d.total) || 0;
          if (d && d.statuses && d.statuses.length) this.statuses = d.statuses;
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loadingIp = false;
        }
      },
      goto(p) { this.page = Math.min(Math.max(1, p), this.pageCount); this.loadIps(); },
      resetIp() { this.fSeg = 0; this.fStatus = ''; this.kw = ''; this.page = 1; this.loadIps(); },

      /* ---------- 展示辅助 ---------- */
      pct(s) {
        if (!s || !s.host_count) return '0.0';
        return Math.round(s.used / s.host_count * 1000) / 10;
      },
      usageStyle(s) {
        const p = Number(this.pct(s));
        return { width: Math.min(100, Math.max(p > 0 ? 1.5 : 0, p)) + '%' };
      },
      // 使用率超 70% 转警示、超 90% 转危险：颜色只是加强，旁边永远有具体数字
      usageClass(s) {
        const p = Number(this.pct(s));
        if (p >= 90) return 'ip-fill high';
        if (p >= 70) return 'ip-fill mid';
        return 'ip-fill';
      },
      badgeOf(status) { return STATUS_BADGE[status] || 'muted'; },
      segmentLabel(id) {
        const s = this.segs.filter((x) => x.id === id)[0];
        return s ? s.name + '（' + s.cidr + '）' : '网段 #' + id;
      },

      /* ---------- 网段 ---------- */
      openSegForm(s) {
        this.segForm = s
          ? { id: s.id, name: s.name, cidr: s.cidr, gateway: s.gateway, vlan: s.vlan, location: s.location, note: s.note }
          : { id: 0, name: '', cidr: '', gateway: '', vlan: '', location: '', note: '' };
      },
      async saveSeg() {
        const f = this.segForm;
        if (!f) return;
        if (!String(f.name || '').trim()) return this.$toast('请填写网段名称', 'err');
        if (!String(f.cidr || '').trim()) return this.$toast('请填写 CIDR，如 192.168.10.0/24', 'err');
        this.saving = true;
        try {
          const body = { name: f.name, cidr: f.cidr, gateway: f.gateway, vlan: f.vlan, location: f.location, note: f.note };
          if (f.id) await api.put('/ipam/segments/' + f.id, body);
          else await api.post('/ipam/segments', body);
          this.$toast('已保存', 'ok');
          this.segForm = null;
          this.loadSegments();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async delSeg(s) {
        if (!confirm('确定删除网段「' + s.name + '」（' + s.cidr + '）？\n网段下还有 IP 登记时无法删除。')) return;
        try {
          await api.del('/ipam/segments/' + s.id);
          this.$toast('已删除', 'ok');
          this.loadSegments();
        } catch (e) { this.$toast(e.message, 'err'); }
      },
      async openFree(s) {
        try {
          const d = await api.get('/ipam/segments/' + s.id + '/free?limit=200');
          this.freeView = Object.assign({ name: s.name }, d);
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      /* ---------- IP 登记 ---------- */
      openIpForm(r) {
        if (r) {
          this.ipForm = {
            id: r.id, segment_id: r.segment_id, ip: r.ip, status: r.status,
            hostname: r.hostname, owner: r.owner, device_type: r.device_type,
            mac: r.mac, note: r.note,
          };
        } else {
          this.ipForm = {
            id: 0, segment_id: (this.fSeg || (this.segs[0] && this.segs[0].id) || 0),
            ip: '', status: 'used', hostname: '', owner: '', device_type: '', mac: '', note: '',
          };
        }
      },
      async saveIp() {
        const f = this.ipForm;
        if (!f) return;
        if (!f.segment_id) return this.$toast('请选择网段', 'err');
        if (!String(f.ip || '').trim()) return this.$toast('请填写 IP 地址', 'err');
        this.saving = true;
        try {
          const body = {
            segment_id: f.segment_id, ip: f.ip, status: f.status, hostname: f.hostname,
            owner: f.owner, device_type: f.device_type, mac: f.mac, note: f.note,
          };
          let r;
          if (f.id) r = await api.put('/ipam/ips/' + f.id, body);
          else r = await api.post('/ipam/ips', body);
          verifyMsg(this, r);
          this.$toast('已保存', 'ok');
          this.ipForm = null;
          this.loadSegments();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
      async delIp(r) {
        if (!confirm('确定删除 ' + r.ip + ' 的登记？')) return;
        try {
          await api.del('/ipam/ips/' + r.id);
          this.$toast('已删除', 'ok');
          this.loadSegments();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      /* ---------- 批量 ---------- */
      openBulk() {
        this.bulkForm = {
          segment_id: (this.fSeg || (this.segs[0] && this.segs[0].id) || 0),
          status: 'used', owner: '', device_type: '', text: '', preview: null, result: null,
        };
      },
      async doBulk(dry) {
        const f = this.bulkForm;
        if (!f) return;
        if (!f.segment_id) return this.$toast('请选择网段', 'err');
        if (!String(f.text || '').trim()) return this.$toast('请粘贴地址清单', 'err');
        this.saving = true;
        try {
          const body = {
            segment_id: f.segment_id, text: f.text, status: f.status,
            owner: f.owner, device_type: f.device_type, dry_run: dry ? 1 : 0,
          };
          const d = await api.post('/ipam/ips/bulk', body);
          if (dry) {
            f.preview = d;
          } else {
            f.preview = null;
            f.result = d;
            this.$toast('新增 ' + d.added + ' 条，失败 ' + d.failed.length + ' 条',
              d.failed.length ? '' : 'ok');
            this.loadSegments();
          }
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.saving = false;
        }
      },
    },
  };

  /** 接口可能带一句 warn（地址同时落在别的网段里），单独提示一下，别混进「已保存」 */
  function verifyMsg(vm, r) {
    const msg = (r && r.__msg) || '';
    if (msg) vm.$toast(msg, '');
  }
})();
