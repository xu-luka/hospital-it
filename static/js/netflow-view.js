/* 网络流量监控（端口级）
 *
 * 与巡检大屏的关系：巡检看"设备活着没有"，这里看"谁在跑大流量"。
 *
 * 页面上刻意区分两种口径，避免误导：
 *   · TopN（按 IP）——只统计「端口下只有一个终端」的样本，流量确实是该 IP 的；
 *   · TopN（按端口）——含多终端端口，看的是哪个口在跑，不代表某个 IP。
 * 交换机只能告诉我们"这个口有多少流量"，口下挂了三台机器时，
 * 谁占多少它不知道；所以多终端端口在按 IP 排行里一律不出现，
 * 宁可少几行，也不给一份看着精确、实际是编的名单。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  const WINDOWS = [
    { v: 15, label: '最近 15 分钟' },
    { v: 60, label: '最近 1 小时' },
    { v: 240, label: '最近 4 小时' },
    { v: 1440, label: '最近 24 小时' }
  ];

  V.NetflowView = {
    template: `
    <div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <div style="font-size:16px;font-weight:600">网络流量监控</div>
          <span class="dev-badge" :class="status.started ? 'ok' : 'muted'">
            {{ status.started ? '自动采集中' : '未启动' }}
          </span>
          <span v-if="status.config && !status.config.enabled" class="dev-badge warn">已关闭自动采集</span>
          <span v-if="status.lastRunAt" class="dev-badge muted">最近采集 {{ status.lastRunAt }}</span>
          <span v-if="status.interval" class="dev-badge muted">每 {{ status.interval }} 秒一轮</span>
          <span v-if="status.lastSummary" class="dev-badge muted">
            上轮 {{ status.lastSummary.ok }}/{{ status.lastSummary.devices }} 台 · {{ status.lastSummary.ports }} 端口
          </span>
          <span v-if="status.store && status.store.unack" class="dev-badge err">
            {{ status.store.unack }} 条未确认告警
          </span>
          <div style="flex:1"></div>
          <button class="btn btn-outline btn-sm" @click="refresh" :disabled="loading">刷新</button>
          <button v-if="canOperate" class="btn btn-outline btn-sm" @click="runNow" :disabled="running">
            {{ running ? '采集中…' : '立即采集' }}
          </button>
          <button v-if="isAdmin" class="btn btn-primary btn-sm" @click="openConfig">阈值设置</button>
        </div>
        <div v-if="status.lastError" class="net-tip err">采集提示：{{ status.lastError }}</div>
        <div v-else-if="!devices.length" class="net-tip">
          还没有可采集的交换机。请到「机房巡检 → 设备台账」添加类型为「网络交换机」的设备并启用。
        </div>
      </div>

      <div class="filter-bar">
        <div class="seg">
          <button class="seg-btn" :class="{on: tab==='top'}" @click="tab='top';load()">TopN 排行</button>
          <button class="seg-btn" :class="{on: tab==='latest'}" @click="tab='latest';load()">最新快照</button>
          <button class="seg-btn" :class="{on: tab==='alerts'}" @click="tab='alerts';load()">突发告警</button>
        </div>
        <div style="width:8px"></div>
        <select v-if="tab==='top'" class="ipt" style="width:130px" v-model="topType" @change="load">
          <option value="ip">按 IP</option>
          <option value="port">按端口</option>
        </select>
        <select v-if="tab!=='alerts'" class="ipt" style="width:140px" v-model="minutes" @change="load">
          <option v-for="w in windows" :key="w.v" :value="w.v">{{ w.label }}</option>
        </select>
        <select v-if="tab!=='top'" class="ipt" style="width:180px" v-model="deviceId" @change="load">
          <option :value="0">全部交换机</option>
          <option v-for="d in devices" :key="d.id" :value="d.id">{{ d.name }}</option>
        </select>
        <label v-if="tab==='alerts'" class="ck">
          <input type="checkbox" v-model="unackOnly" @change="load"> 只看未确认
        </label>
        <div style="flex:1"></div>
        <button v-if="tab==='alerts' && canOperate && alerts.length" class="btn btn-outline btn-sm" @click="ackAll">全部确认</button>
      </div>

      <!-- TopN 排行 -->
      <div class="card" v-if="tab==='top'">
        <div class="table-wrap">
          <table class="tbl net-table">
            <thead>
              <tr>
                <th class="c-idx">#</th>
                <th v-if="topType==='ip'" class="c-ip">IP 地址</th>
                <th class="c-dev">交换机</th>
                <th class="c-iface">端口</th>
                <th v-if="topType==='port'" class="c-cnt">终端数</th>
                <th class="c-peak">峰值吞吐</th>
                <th class="c-avg">均值吞吐</th>
                <th class="c-bar">占用</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!top.length">
                <td colspan="9" class="empty-row">暂无数据。请先添加交换机并执行一次采集。</td>
              </tr>
              <tr v-for="(r,i) in top" :key="(r.ip||r.iface)+'-'+r.deviceId">
                <td class="num">{{ i+1 }}</td>
                <td v-if="topType==='ip'" class="mono cell-strong">{{ r.ip }}</td>
                <td :title="r.device + '（' + r.host + '）'">
                  <span class="net-name">{{ r.device }}</span>
                  <span class="cell-sub">{{ r.host }}</span>
                </td>
                <td class="mono">{{ r.iface }}</td>
                <td v-if="topType==='port'" class="num">
                  <span v-if="r.ipCount>1" class="dev-badge warn">{{ r.ipCount }} 个</span>
                  <span v-else class="muted">{{ r.ipCount }}</span>
                </td>
                <td class="num cell-strong">{{ r.peakText }}</td>
                <td class="num">{{ r.avgText }}</td>
                <td>
                  <div class="net-bar"><i :style="{width: barWidth(r.peakBps)}"></i></div>
                </td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="openSeries(r)">趋势</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="net-note">
          按 IP 排行只统计端口下仅有 1 个终端的样本；端口下有多台机器时流量无法归属到具体 IP，只在「按端口」里出现。
        </div>
      </div>

      <!-- 最新快照 -->
      <div class="card" v-if="tab==='latest'">
        <div class="table-wrap">
          <table class="tbl net-table">
            <thead>
              <tr>
                <th class="c-dev">交换机</th>
                <th class="c-iface">端口</th>
                <th class="c-ip">归属 IP</th>
                <th class="c-in">入向</th>
                <th class="c-out">出向</th>
                <th class="c-total">合计</th>
                <th class="c-time">采样时间</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!latest.length">
                <td colspan="8" class="empty-row">暂无快照</td>
              </tr>
              <tr v-for="r in latest" :key="r.deviceId+'-'+r.iface">
                <td :title="r.device + '（' + r.host + '）'">
                  <span class="net-name">{{ r.device }}</span>
                  <span class="cell-sub">{{ r.host }}</span>
                </td>
                <td class="mono">{{ r.iface }}</td>
                <td>
                  <span v-if="r.ip" class="mono cell-strong">{{ r.ip }}</span>
                  <span v-else-if="r.ipCount>1" class="dev-badge warn">{{ r.ipCount }} 个终端</span>
                  <span v-else class="muted">未识别</span>
                </td>
                <td class="num">{{ r.inText }}</td>
                <td class="num">{{ r.outText }}</td>
                <td class="num cell-strong">{{ r.totalText }}</td>
                <td class="mono">{{ r.at }}</td>
                <td class="ops">
                  <button class="btn btn-sm btn-outline" @click="openSeries(r)">趋势</button>
                </td>
              </tr>
            </tbody>
            <tfoot v-if="latest.length">
              <tr>
                <td colspan="3">合计（{{ latest.length }} 个端口）</td>
                <td class="num">{{ sum(latest,'inBps') }}</td>
                <td class="num">{{ sum(latest,'outBps') }}</td>
                <td class="num">{{ sum(latest,'totalBps') }}</td>
                <td colspan="2"></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <!-- 突发告警 -->
      <div class="card" v-if="tab==='alerts'">
        <div class="table-wrap">
          <table class="tbl net-table">
            <thead>
              <tr>
                <th class="c-time">发生时间</th>
                <th class="c-dev">交换机</th>
                <th class="c-iface">端口</th>
                <th class="c-ip">归属 IP</th>
                <th class="c-dir">方向</th>
                <th class="c-peak">峰值</th>
                <th class="c-base">基线</th>
                <th class="c-ratio">倍数</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="!alerts.length">
                <td colspan="9" class="empty-row">暂无告警</td>
              </tr>
              <tr v-for="a in alerts" :key="a.id" :title="a.detail">
                <td class="mono">{{ a.raisedAt }}</td>
                <td :title="a.device + '（' + a.host + '）'">
                  <span class="net-name">{{ a.device }}</span>
                  <span class="cell-sub">{{ a.host }}</span>
                </td>
                <td class="mono">{{ a.iface }}</td>
                <td>
                  <span v-if="a.ip" class="mono cell-strong">{{ a.ip }}</span>
                  <span v-else class="dev-badge warn">{{ a.ipCount }} 个终端</span>
                </td>
                <td><span class="dev-badge" :class="a.kind==='in' ? 'ok' : 'warn'">{{ a.kind==='in' ? '入向为主' : '出向为主' }}</span></td>
                <td class="num cell-strong">{{ a.peakText }}</td>
                <td class="num">{{ a.baseText }}</td>
                <td class="num">
                  <span v-if="a.ratio" class="dev-badge err">{{ a.ratio }}×</span>
                  <span v-else class="muted">无基线</span>
                </td>
                <td class="ops">
                  <span v-if="a.ack" class="muted">已确认</span>
                  <button v-else-if="canOperate" class="btn btn-sm btn-outline" @click="ack(a)">确认</button>
                  <span v-else class="muted">未确认</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 趋势 -->
      <div class="modal-mask" v-if="series" @click.self="series=null">
        <div class="modal" style="width:720px">
          <div class="modal-head">
            端口趋势 · {{ series.iface }}
            <span class="x" @click="series=null">✕</span>
          </div>
          <div class="modal-body">
            <div class="muted" style="margin-bottom:8px">
              {{ series.device }}（{{ series.host }}）<template v-if="series.ip"> · IP {{ series.ip }}</template>
              · 最近 {{ minutesLabel }} · {{ series.items.length }} 个采样点
            </div>
            <div v-if="!series.items.length" class="muted">该时间段内没有采样点。</div>
            <svg v-else class="net-chart" :viewBox="'0 0 ' + CW + ' ' + CH" preserveAspectRatio="none">
              <line v-for="g in gridLines" :key="'g'+g.y"
                    :x1="PL" :y1="g.y" :x2="CW-PR" :y2="g.y" class="net-grid"></line>
              <polyline :points="poly(series.items,'outBps')" class="net-line out"></polyline>
              <polyline :points="poly(series.items,'inBps')" class="net-line in"></polyline>
            </svg>
            <div class="net-legend">
              <span><i class="sw in"></i>入向 峰值 {{ fmt(peakOf(series.items,'inBps')) }}</span>
              <span><i class="sw out"></i>出向 峰值 {{ fmt(peakOf(series.items,'outBps')) }}</span>
              <span class="muted">纵轴上限 {{ fmt(chartMax) }}</span>
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="series=null">关闭</button>
          </div>
        </div>
      </div>

      <!-- 阈值设置 -->
      <div class="modal-mask" v-if="cfgForm" @click.self="cfgForm=null">
        <div class="modal" style="width:560px">
          <div class="modal-head">流量阈值设置 <span class="x" @click="cfgForm=null">✕</span></div>
          <div class="modal-body">
            <div class="form-row">
              <div class="form-item"><label>自动采集</label>
                <select class="ipt" v-model="cfgForm.enabled">
                  <option :value="1">开启</option><option :value="0">关闭（仅手动触发）</option>
                </select></div>
              <div class="form-item"><label>采集间隔（秒）</label>
                <input class="ipt" type="number" min="60" step="60" v-model="cfgForm.interval_sec"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>基线回看（分钟）</label>
                <input class="ipt" type="number" min="10" v-model="cfgForm.window_min"></div>
              <div class="form-item"><label>突发倍数（×基线）</label>
                <input class="ipt" type="number" min="1.5" step="0.5" v-model="cfgForm.ratio"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>绝对下限（Mbps）</label>
                <input class="ipt" type="number" min="1" v-model="cfgForm.minMbps"></div>
              <div class="form-item"><label>告警冷却（分钟）</label>
                <input class="ipt" type="number" min="0" v-model="cfgForm.cool_down_min"></div>
            </div>
            <div class="form-row">
              <div class="form-item"><label>最少样本数</label>
                <input class="ipt" type="number" min="2" v-model="cfgForm.min_samples"></div>
              <div class="form-item"><label>采样保留（天）</label>
                <input class="ipt" type="number" min="1" v-model="cfgForm.keep_days"></div>
            </div>
            <div class="net-note">
              判定：当前吞吐 ≥ max(基线中位数 × 倍数, 绝对下限) 才告警。
              用中位数而非平均数，一次突发不会把基线抬上去导致后续漏报；
              绝对下限用来挡掉「0.2 Mbps 涨到 2 Mbps」这种十倍但无关紧要的抖动。
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn btn-outline" @click="cfgForm=null">取消</button>
            <button class="btn btn-primary" @click="saveConfig" :disabled="saving">{{ saving ? '保存中' : '保存' }}</button>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        tab: 'top',
        windows: WINDOWS,
        minutes: 60,
        topType: 'ip',
        deviceId: 0,
        unackOnly: false,
        devices: [],
        top: [],
        latest: [],
        alerts: [],
        status: {},
        loading: false,
        running: false,
        saving: false,
        series: null,
        cfgForm: null,
        CW: 680, CH: 180, PL: 8, PR: 8
      };
    },

    computed: {
      isAdmin() {
        const u = window.HisUser && window.HisUser.user;
        return !!(u && u.role_id === 1);
      },
      canOperate() {
        const u = window.HisUser && window.HisUser.user;
        return !!(u && (u.role_id === 1 || u.role_id === 2));
      },
      minutesLabel() {
        const w = WINDOWS.filter((x) => x.v === this.minutes)[0];
        return w ? w.label.replace('最近 ', '') : (this.minutes + ' 分钟');
      },
      chartMax() {
        if (!this.series || !this.series.items.length) return 1;
        let m = 0;
        for (const it of this.series.items) {
          m = Math.max(m, Number(it.inBps) || 0, Number(it.outBps) || 0);
        }
        // 留 15% 余量，峰值贴顶会看不出形状
        return Math.max(m * 1.15, 1000);
      },
      gridLines() {
        const n = 4;
        const out = [];
        for (let i = 1; i <= n; i++) {
          out.push({ y: 6 + (this.CH - 12) * i / (n + 1) });
        }
        return out;
      }
    },

    mounted() {
      this.loadStatus();
      this.loadDevices();
      this.load();
    },

    methods: {
      async loadStatus() {
        try { this.status = await api.get('/api/inspection/netflow/status'); }
        catch (e) { /* 状态拿不到不影响列表 */ }
      },

      async loadDevices() {
        try {
          const r = await api.get('/api/inspection/netflow/devices');
          this.devices = r.items || [];
        } catch (e) { this.devices = []; }
      },

      async load() {
        this.loading = true;
        try {
          if (this.tab === 'top') {
            const r = await api.get('/api/inspection/netflow/top?type=' + this.topType
              + '&minutes=' + this.minutes + '&limit=50');
            this.top = r.items || [];
          } else if (this.tab === 'latest') {
            const r = await api.get('/api/inspection/netflow/latest?deviceId=' + this.deviceId + '&limit=300');
            this.latest = r.items || [];
          } else {
            const r = await api.get('/api/inspection/netflow/alerts?limit=200'
              + (this.unackOnly ? '&unack=1' : '')
              + (this.deviceId ? '&deviceId=' + this.deviceId : ''));
            this.alerts = r.items || [];
          }
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.loading = false;
        }
      },

      refresh() { this.loadStatus(); this.load(); },

      async runNow() {
        this.running = true;
        try {
          const r = await api.post('/api/inspection/netflow/run', { deviceId: this.deviceId || 0 });
          const s = r.summary || {};
          this.$toast('采集完成：' + (s.ok || 0) + ' 台 / ' + (s.ports || 0) + ' 端口，告警 ' + (s.alerts || 0) + ' 条', 'ok');
          this.loadStatus();
          this.load();
        } catch (e) {
          this.$toast(e.message, 'err');
        } finally {
          this.running = false;
        }
      },

      async ack(a) {
        try {
          await api.post('/api/inspection/netflow/alerts/' + a.id + '/ack', {});
          a.ack = true;
          this.$toast('已确认', 'ok');
          this.loadStatus();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async ackAll() {
        try {
          const r = await api.post('/api/inspection/netflow/alerts/ack-all', {});
          this.$toast('已确认 ' + r.changes + ' 条', 'ok');
          this.loadStatus();
          this.load();
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async openSeries(r) {
        const items = await api.get('/api/inspection/netflow/series?deviceId=' + r.deviceId
          + '&iface=' + encodeURIComponent(r.iface) + '&minutes=' + this.minutes);
        this.series = {
          deviceId: r.deviceId, iface: r.iface, ip: r.ip || '',
          device: r.device || '', host: r.host || '', items: (items && items.items) || []
        };
      },

      /** 把一组时序值映射成 SVG 折线点 */
      poly(items, key) {
        const n = items.length;
        const max = this.chartMax || 1;
        const top = 6;
        const h = this.CH - 12;
        const w = this.CW - this.PL - this.PR;
        const pts = [];
        for (let i = 0; i < n; i++) {
          const x = n === 1 ? this.PL : this.PL + w * i / (n - 1);
          const v = Number(items[i][key]) || 0;
          const y = this.CH - 6 - (h * (v / max));
          pts.push(x.toFixed(1) + ',' + y.toFixed(1));
        }
        return pts.join(' ');
      },

      peakOf(items, key) {
        let m = 0;
        for (const it of items) m = Math.max(m, Number(it[key]) || 0);
        return m;
      },

      fmt(bps) {
        const v = Number(bps) || 0;
        if (v >= 1e9) return (v / 1e9).toFixed(2) + ' Gbps';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + ' Mbps';
        if (v >= 1e3) return (v / 1e3).toFixed(2) + ' Kbps';
        return Math.round(v) + ' bps';
      },

      sum(rows, key) {
        let t = 0;
        for (const r of rows) t += Number(r[key]) || 0;
        return this.fmt(t);
      },

      /** 相对本页最大值的占用条，纯视觉参考 */
      barWidth(bps) {
        let m = 0;
        for (const r of this.top) m = Math.max(m, Number(r.peakBps) || 0);
        if (!m) return '0%';
        return Math.max(2, Math.round((Number(bps) || 0) / m * 100)) + '%';
      },

      async openConfig() {
        try {
          const r = await api.get('/api/inspection/netflow/config');
          const c = Object.assign({}, r.config);
          c.minMbps = Math.round((Number(c.min_bps) || 0) / 1e6 * 100) / 100;
          this.cfgForm = c;
        } catch (e) { this.$toast(e.message, 'err'); }
      },

      async saveConfig() {
        this.saving = true;
        try {
          const body = Object.assign({}, this.cfgForm);
          const mbps = Number(body.minMbps);
          // 后端存的是 bps，界面按 Mbps 输入更符合习惯
          body.min_bps = Number.isFinite(mbps) && mbps > 0 ? Math.round(mbps * 1e6) : undefined;
          delete body.minMbps;
          if (body.min_bps === undefined) delete body.min_bps;
          const r = await api.put('/api/inspection/netflow/config', { config: body });
          this.$toast('已保存，下一轮生效', 'ok');
          this.cfgForm = null;
          this.status.config = r.config;
          this.load();
        } catch (e) {
          this.$toast((e.errors && e.errors[0]) || e.message, 'err');
        } finally {
          this.saving = false;
        }
      }
    }
  };
})();
