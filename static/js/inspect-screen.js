/* 机房巡检：监控大屏 + 巡检报告（阶段 4）
 *
 * 大屏是把原 lib/dashboard.js 的服务端拼 HTML 整体翻译成 Vue 组件，
 * 交互行为刻意保持一致（分区折叠、按状态筛选、严重项排前、异常卡片呼吸），
 * 因为值班同事的肌肉记忆是照着原来那块屏养成的。
 *
 * 配色沿用深色科技风，但类名统一加 scr- 前缀，避免与浅色主题的业务页面互相污染；
 * 深色背景铺在最外层容器上，配合「全屏投屏」按钮可以直接投到机房电视。
 */
(function () {
  const V = window.HisViews || (window.HisViews = {});

  // 分区与顺序照搬原大屏：服务器 → 虚拟化 → 交换机 → 管理口 → 数据库
  const GROUPS = [
    { key: 'server', title: '服务器', os: ['linux', 'windows'] },
    { key: 'esxi', title: 'ESXi 虚拟化', os: ['esxi'] },
    { key: 'switch', title: '网络交换机', os: ['switch'] },
    { key: 'bmc', title: '服务器管理口', os: ['bmc'] },
    { key: 'database', title: '数据库', os: ['database'] }
  ];
  const ST_LABEL = { normal: '正常', warning: '警告', critical: '严重', error: '巡检失败' };
  // 排序权重：严重在最前，值班扫一眼就能看到要看的
  const ST_ORDER = { critical: 0, warning: 1, error: 2, normal: 3 };

  function pad(n) { return String(n).padStart(2, '0'); }

  V.BigScreenView = {
    template: `
    <div class="scr-wrap" ref="box">
      <div class="scr-top">
        <div>
          <div class="scr-title">机房设备巡检 · 监控大屏</div>
          <div class="scr-sub">{{ updateText }}</div>
        </div>
        <div class="scr-clock">
          <div class="scr-time">{{ clock }}</div>
          <div class="scr-date">{{ dateText }}</div>
        </div>
      </div>

      <div class="scr-bar">
        <span class="scr-live"><i class="scr-dot"></i>实时刷新 · 每 {{ data.interval }} 秒</span>
        <span v-if="data.round" class="scr-chip">第 {{ data.round }} 轮</span>
        <span v-if="data.running" class="scr-chip warn">正在巡检…</span>
        <span v-if="data.sourceMode" class="scr-chip">数据源：{{ sourceLabel }}</span>
        <!-- 流量视图切换：四套版式都在，值班时随手切；选择记在 localStorage 里
             （大屏是长期挂在电视上的，刷新一次就退回默认很烦） -->
        <template v-if="nf.ready">
          <span class="scr-flow-sw">
            <span class="k">流量</span>
            <span v-for="m in nfModes" :key="m.key" class="opt"
              :class="{active: nfMode===m.key}" @click="setNfMode(m.key)">{{ m.label }}</span>
          </span>
          <span class="scr-flow-sw">
            <span class="k">口径</span>
            <span class="opt" :class="{active: nfType==='ip'}" @click="setNfType('ip')">IP</span>
            <span class="opt" :class="{active: nfType==='port'}" @click="setNfType('port')">端口</span>
          </span>
          <span class="scr-flow-sw">
            <span class="opt" :class="{active: nfPorts}" @click="toggleNfPorts"
              title="在交换机卡片里显示该机 Top3 端口速率">
              端口条 · {{ nfPorts ? '开' : '关' }}
            </span>
          </span>
        </template>
        <div style="flex:1"></div>
        <button class="scr-btn" @click="refreshAll">立即刷新</button>
        <button v-if="canOperate" class="scr-btn primary" :disabled="busy" @click="runNow">
          {{ busy ? '巡检中…' : '触发巡检' }}
        </button>
        <button v-if="isAdmin" class="scr-btn" :disabled="busy" @click="reload">重载配置</button>
        <button class="scr-btn" @click="toggleFull">{{ full ? '退出投屏' : '全屏投屏' }}</button>
      </div>

      <div v-if="alertItems.length" class="scr-alert">
        <div v-for="(a,i) in alertItems" :key="i">{{ a }}</div>
      </div>

      <div class="scr-stats">
        <div class="scr-stat t"><div class="num">{{ summary.total }}</div><div class="lbl">设备总数</div></div>
        <div class="scr-stat n"><div class="num">{{ summary.normal }}</div><div class="lbl">正常</div></div>
        <div class="scr-stat w"><div class="num">{{ summary.warning }}</div><div class="lbl">警告</div></div>
        <div class="scr-stat c"><div class="num">{{ summary.critical }}</div><div class="lbl">严重</div></div>
        <div class="scr-stat e"><div class="num">{{ summary.error }}</div><div class="lbl">失败</div></div>
      </div>

      <div class="scr-flow" :class="{'with-aside': nf.ready && nfMode==='aside'}">
      <div class="scr-flow-main">

      <!-- 版式 A：顶部流量带。放在统计卡正下方、设备分区之前，
           不改变下面任何东西的位置，代价最小的集成方式。 -->
      <div v-if="nf.ready && nfMode==='band'" class="nf-band">
        <div class="nf-box">
          <div class="nf-box-h">
            <b>网络流量总览</b>
            <span>{{ nfRoundText }}</span>
          </div>
          <div class="nf-kpis">
            <div v-for="(k,i) in nfKpis" :key="i" class="nf-kpi" :class="k.cls">
              <div class="v">{{ k.v }}<s v-if="k.unit">{{ k.unit }}</s></div>
              <div class="l">{{ k.l }}</div>
            </div>
          </div>
        </div>
        <div class="nf-box">
          <div class="nf-box-h"><b>{{ topTitle }}</b><span>{{ nfDevText }}</span></div>
          <div v-for="(r,i) in topRows" :key="i" class="nf-row" :class="r.cls">
            <span class="ip">{{ r.label }}</span>
            <span class="bar"><i :style="{width: r.w}"></i></span>
            <span class="val">{{ r.peakText }}</span>
          </div>
          <div v-if="!topRows.length" class="nf-none">{{ nfEmptyText }}</div>
        </div>
      </div>

      <!-- 版式 C：独立流量分区，沿用「分区 + 标题 + 折叠」的既有习惯 -->
      <div v-if="nf.ready && nfMode==='section'" class="scr-sec">
        <div class="scr-sec-head">
          <div class="scr-sec-toggle">
            <span class="scr-sec-title">网络流量</span>
            <span class="scr-sec-count">{{ nfDevText }}</span>
          </div>
          <span class="scr-mini">
            <span class="cr active">未确认突发<b>{{ nfUnack }}</b></span>
          </span>
        </div>
        <div class="nf-sec-body">
          <div class="nf-panel">
            <div class="nf-panel-h">近 {{ nfMinutes }} 分钟 · 被监控端口总吞吐</div>
            <div class="nf-io">
              <div class="one in"><div class="n">{{ nfTotalText }}</div><div class="l">当前总吞吐</div></div>
              <div class="one out"><div class="n">{{ nfPeakText }}</div><div class="l">区间峰值</div></div>
              <div class="one in"><div class="n">{{ nfInOutText }}</div><div class="l">入站 / 出站</div></div>
            </div>
            <svg v-if="sparkPts" class="nf-chart" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polygon :points="sparkArea" fill="#4f8ef722" stroke="none"/>
              <polyline :points="sparkPts" fill="none" stroke="#7cc4ff" stroke-width="2"
                vector-effect="non-scaling-stroke"/>
            </svg>
            <div v-else class="nf-none">还没有足够的采样点（每 5 分钟一轮），趋势图会在第 2 轮后出现</div>
          </div>
          <div class="nf-panel">
            <div class="nf-panel-h">{{ topTitle }}</div>
            <table class="nf-tbl">
              <thead>
                <tr>
                  <th>IP / 端口</th><th>交换机</th>
                  <th class="num">峰值</th><th class="num">均值</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(r,i) in topRows" :key="i" :class="r.cls">
                  <td>{{ r.label }} · {{ r.iface }}</td>
                  <td class="nf-dev">{{ r.device }}</td>
                  <td class="num">{{ r.peakText }}</td>
                  <td class="num">{{ r.avgText }}</td>
                </tr>
                <tr v-if="!topRows.length"><td colspan="4" class="nf-none">{{ nfEmptyText }}</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div v-if="!groups.length" class="scr-empty">{{ data.updatedAt ? '当前没有纳管中的设备' : '正在加载巡检数据…' }}</div>

      <div v-for="g in groups" :key="g.key" class="scr-sec" :class="{collapsed: ui[g.key].collapsed}">
        <div class="scr-sec-head">
          <div class="scr-sec-toggle" @click="toggleGroup(g.key)">
            <span class="scr-sec-title">{{ g.title }}</span>
            <span class="scr-sec-count">{{ g.total }} 台</span>
            <span class="scr-chev">▼</span>
          </div>
          <span class="scr-mini">
            <span class="ok" :class="{active: ui[g.key].filter==='normal'}" @click="setFilter(g.key,'normal')">正常<b>{{ g.counts.normal }}</b></span>
            <span class="wr" :class="{active: ui[g.key].filter==='warning'}" @click="setFilter(g.key,'warning')">警告<b>{{ g.counts.warning }}</b></span>
            <span class="cr" :class="{active: ui[g.key].filter==='critical'}" @click="setFilter(g.key,'critical')">严重<b>{{ g.counts.critical }}</b></span>
            <span class="er" :class="{active: ui[g.key].filter==='error'}" @click="setFilter(g.key,'error')">失败<b>{{ g.counts.error }}</b></span>
          </span>
        </div>
        <div class="scr-grid">
          <div v-if="ui[g.key].filter && !shown(g).length" class="scr-nomatch">
            该分区下没有「{{ labelOf(ui[g.key].filter) }}」状态的设备
          </div>
          <div v-for="d in shown(g)" :key="d.name + d.host" class="scr-card" :class="d.status">
            <div class="scr-c-head">
              <div>
                <div class="scr-c-name"><i class="scr-dot" :class="d.status"></i>{{ d.name }}</div>
                <div class="scr-c-host">{{ d.host }}<span v-if="d.hostname"> · {{ d.hostname }}</span></div>
              </div>
              <span class="scr-badge" :class="d.status">{{ labelOf(d.status) }}</span>
            </div>
            <div class="scr-c-type">{{ d.osLabel }} · {{ d.connectLabel }}</div>

            <div v-if="d.status !== 'error' && (d.cpu !== null || d.mem !== null)" class="scr-bars">
              <div v-if="d.cpu !== null" class="scr-bar-row">
                <span class="k">CPU</span>
                <span class="track"><i class="fill" :class="barClass(d.cpu)" :style="{width: Math.min(100,d.cpu) + '%'}"></i></span>
                <span class="v">{{ pct(d.cpu) }}</span>
              </div>
              <div v-if="d.mem !== null" class="scr-bar-row">
                <span class="k">内存</span>
                <span class="track"><i class="fill" :class="barClass(d.mem)" :style="{width: Math.min(100,d.mem) + '%'}"></i></span>
                <span class="v">{{ pct(d.mem) }}</span>
              </div>
            </div>

            <!-- 版式 D：交换机卡片内联端口条。看设备与看流量在同一张卡片里，
                 不用在「这台机器怎么了」和「哪个口在跑」之间来回切视线。 -->
            <div v-if="nfPorts && nf.ready && d.os === 'switch' && portsOf(d).length" class="nf-ports">
              <div v-for="p in portsOf(d)" :key="p.iface" class="nf-port" :class="p.cls">
                <span class="if">{{ p.iface }}</span>
                <span class="who" :title="p.label">{{ p.label }}</span>
                <span class="track"><i :style="{width: p.w}"></i></span>
                <span class="val">{{ p.peakText }}</span>
              </div>
            </div>

            <div v-if="sortedReasons(d).length" class="scr-reasons">
              <div v-for="(r,ri) in sortedReasons(d)" :key="ri" class="scr-reason" :class="r.level==='critical' ? 'critical' : 'warning'">
                <span class="ri">{{ r.level==='critical' ? '✗' : '!' }}</span><span>{{ r.text }}</span>
              </div>
            </div>
            <div v-if="d.error" class="scr-c-err">{{ d.error }}</div>
            <div v-if="d.note" class="scr-c-note">{{ d.note }}</div>
          </div>
        </div>
      </div>
      </div>

      <!-- 版式 B：右侧固定流量栏。放在滚动区之外，滚设备列表时它始终在 -->
      <aside v-if="nf.ready && nfMode==='aside'" class="nf-aside">
        <div class="nf-aside-h">网络流量</div>
        <div class="nf-total">
          <div class="big">{{ nfTotalText }}</div>
          <div class="sub">被监控端口合计 · <span :class="nfDeltaUp ? 'up' : 'down'">{{ nfDeltaText }}</span></div>
        </div>
        <div class="nf-as-sec">{{ topTitle }}</div>
        <div v-for="(r,i) in topRows5" :key="i" class="nf-vrow" :class="r.cls">
          <span class="ip">{{ r.label }}</span>
          <span class="bar"><i :style="{width: r.w}"></i></span>
          <span class="val">{{ r.peakText }}</span>
        </div>
        <div v-if="!topRows5.length" class="nf-none">{{ nfEmptyText }}</div>

        <div class="nf-as-sec">近 {{ nfMinutes }} 分钟总吞吐</div>
        <svg v-if="sparkPts" class="nf-chart sm" viewBox="0 0 100 100" preserveAspectRatio="none">
          <polygon :points="sparkArea" fill="#4f8ef722" stroke="none"/>
          <polyline :points="sparkPts" fill="none" stroke="#7cc4ff" stroke-width="2"
            vector-effect="non-scaling-stroke"/>
        </svg>
        <div v-else class="nf-none">{{ nfEmptyText }}</div>

        <div class="nf-as-sec">突发告警 · {{ nfUnack }} 条未确认</div>
        <div v-for="a in nfAlerts" :key="a.id" class="nf-alert-item"
          :class="a.ratio >= 10 ? 'critical' : 'warning'">
          <b>{{ a.ip || a.iface }}</b> {{ a.peakText }}，基线 {{ a.baseText }}，约 {{ a.ratioText }} 倍
          <span v-if="a.ipCount > 1">（端口下 {{ a.ipCount }} 个终端）</span>
          <span class="t">{{ a.timeText }}</span>
        </div>
        <div v-if="!nfAlerts.length" class="nf-none">暂无未确认突发</div>
      </aside>
      </div>

      <div class="scr-foot">
        <div><i class="scr-dot"></i>数据每轮巡检后自动更新</div>
        <div>报告目录：{{ data.reportsDir || '-' }}</div>
      </div>
    </div>`,

    data() {
      return {
        data: { interval: 60, devices: [], summary: {}, running: false, round: 0 },
        clock: '--:--:--',
        dateText: '',
        full: false,
        busy: false,
        ui: {},
        // ---- 流量监控（复用巡检大屏这一块屏，不另开页面） ----
        // nf.ready 为 false 时页面完全不出现任何流量元素：
        // 万一服务器没重启、流量接口还是 404，大屏必须照常显示巡检。
        nf: { ready: false, error: '', status: null, topIp: [], topPort: [], trend: [], alerts: [] },
        nfMode: 'band',
        nfType: 'ip',
        nfPorts: true,
        nfMinutes: 60,
        nfModes: [
          { key: 'band', label: '流量带' },
          { key: 'aside', label: '侧栏' },
          { key: 'section', label: '分区' }
        ]
      };
    },

    computed: {
      user() { return window.HisUser ? window.HisUser.user : null; },
      isAdmin() { const u = this.user; return u && u.role_id === 1; },
      canOperate() { const u = this.user; return u && (u.role_id === 1 || u.role_id === 2); },
      summary() {
        const s = this.data.summary || {};
        return { total: s.total || 0, normal: s.normal || 0, warning: s.warning || 0, critical: s.critical || 0, error: s.error || 0 };
      },
      sourceLabel() { return this.data.sourceMode === 'db' ? '设备台账' : '配置文件'; },
      updateText() {
        if (this.data.updatedAt) return '上次巡检完成：' + this.data.updatedAt;
        return '等待首次巡检数据…';
      },
      groups() {
        const devs = this.data.devices || [];
        const out = [];
        for (const g of GROUPS) {
          const list = devs.filter((d) => g.os.indexOf(d.os) >= 0);
          if (!list.length) continue;
          const counts = { normal: 0, warning: 0, critical: 0, error: 0 };
          for (const d of list) { if (counts[d.status] !== undefined) counts[d.status]++; }
          out.push({
            key: g.key, title: g.title, os: g.os, list: list, counts: counts, total: list.length
          });
        }
        return out;
      },
      alertItems() {
        const items = [];
        if (this.data.keyError) items.push('主密钥不可用：加密口令的设备无法巡检 —— ' + this.data.keyError);
        const w = this.data.worker;
        if (w && w.enabled && !w.alive) items.push('采集子进程未在运行，本轮巡检将降级到主进程执行：' + (w.lastError || '请查看服务日志'));
        if (w && w.degraded) items.push('采集子进程短时间内反复崩溃，已停止自动重启：' + (w.lastError || ''));
        if (this.data.lastError) items.push('上一轮巡检异常：' + this.data.lastError);
        // 流量采集出问题也要上大屏：值班同事看到的应该是「采不到」，而不是一片安静
        const st = this.nf.status;
        if (this.nf.ready && st) {
          const s = st.lastSummary;
          if (st.lastError) items.push('流量采集：' + st.lastError);
          else if (s && s.failed) items.push('流量采集：' + s.failed + '/' + s.devices + ' 台交换机本轮没采到，具体原因见「流量监控 → 本轮采集明细」');
        }
        return items;
      },

      /* ---------------- 流量：口径与阈值 ---------------- */

      nfCfg() { return (this.nf.status && this.nf.status.config) || {}; },
      nfMinBps() { return Number(this.nfCfg.min_bps) || 50000000; },
      nfUnack() {
        const s = this.nf.status && this.nf.status.store;
        return (s && s.unack) || 0;
      },
      /** 按 IP 还是按端口 —— 两条数据都提前拉好了，切换只是换一份数组，不再打接口 */
      displayTop() { return this.nfType === 'ip' ? this.nf.topIp : this.nf.topPort; },
      nfMaxPeak() {
        let m = 0;
        for (const r of this.displayTop) m = Math.max(m, Number(r.peakBps) || 0);
        return m;
      },
      topTitle() {
        return (this.nfType === 'ip' ? 'Top IP' : 'Top 端口') + ' · 近 ' + this.nfMinutes + ' 分钟';
      },

      /**
       * 排行行。cls 直接反映「有没有超阈值」：
       * 超过绝对下限 3 倍标红、超过下限标黄，其余按默认色 —— 不看条长也知道有没有事。
       */
      topRows() {
        const list = this.displayTop || [];
        const max = this.nfMaxPeak || 1;
        const min = this.nfMinBps;
        return list.map((r) => {
          const peak = Number(r.peakBps) || 0;
          return {
            label: r.ip || (r.ipCount > 1 ? r.ipCount + ' 个终端' : r.iface),
            iface: r.iface,
            device: r.device,
            host: r.host,
            peakBps: peak,
            peakText: r.peakText || this.nfFmt(peak),
            avgText: r.avgText || this.nfFmt(r.avgBps),
            w: Math.max(2, Math.round(peak / max * 100)) + '%',
            cls: peak >= min * 3 ? 'hot' : (peak >= min ? 'warn' : '')
          };
        });
      },
      topRows5() { return this.topRows.slice(0, 5); },

      /* ---------------- 流量：趋势与文案 ---------------- */

      nfLastTrend() { const t = this.nf.trend; return t.length ? t[t.length - 1] : null; },
      nfPeakTrend() {
        let m = null;
        for (const it of this.nf.trend) if (!m || Number(it.totalBps) > Number(m.totalBps)) m = it;
        return m;
      },
      nfTotalText() { return this.nfFmt(this.nfLastTrend ? this.nfLastTrend.totalBps : 0); },
      nfPeakText() { return this.nfFmt(this.nfPeakTrend ? this.nfPeakTrend.totalBps : 0); },
      nfInOutText() {
        const l = this.nfLastTrend;
        return l ? (this.nfFmt(l.inBps) + ' / ' + this.nfFmt(l.outBps)) : '—';
      },
      nfKpis() {
        const cur = this.nfSplit(this.nfLastTrend ? this.nfLastTrend.totalBps : 0);
        const pk = this.nfSplit(this.nfPeakTrend ? this.nfPeakTrend.totalBps : 0);
        return [
          { v: cur.n, u: cur.u, l: '当前总吞吐', cls: '' },
          { v: pk.n, u: pk.u, l: '近 ' + this.nfMinutes + ' 分钟峰值', cls: '' },
          { v: String(this.nfUnack), u: '', l: '未确认突发', cls: this.nfUnack ? 'alert' : '' }
        ];
      },
      nfDeltaInfo() {
        const t = this.nf.trend || [];
        if (t.length < 2) return { up: false, text: '样本不足，下一轮开始有对比' };
        const a = Number(t[0].totalBps) || 0;
        const b = Number(t[t.length - 1].totalBps) || 0;
        if (!a) return { up: false, text: '样本不足，下一轮开始有对比' };
        const p = Math.round((b - a) / a * 100);
        // 说「较 N 分钟前」而不是「较 1 小时前」：流量采集刚开始时窗口里并没有满 1 小时
        const ta = this.nfTs(t[0].at);
        const tb = this.nfTs(t[t.length - 1].at);
        let span = '本窗口';
        if (ta && tb) {
          const m = Math.round((tb - ta) / 60000);
          span = m >= 90 ? (Math.round(m / 60) + ' 小时') : (m + ' 分钟');
        }
        return { up: p >= 0, text: '较 ' + span + '前 ' + (p >= 0 ? '+' : '') + p + '%' };
      },
      nfDeltaUp() { return this.nfDeltaInfo.up; },
      nfDeltaText() { return this.nfDeltaInfo.text; },
      nfRoundText() {
        const st = this.nf.status;
        if (!st) return '';
        if (!st.lastRunAt) return '尚未采集';
        return '最近采集 ' + String(st.lastRunAt).slice(11, 16)
          + ' · 每 ' + Math.max(1, Math.round((st.interval || 300) / 60)) + ' 分钟一轮';
      },
      nfDevText() {
        const s = this.nf.status && this.nf.status.lastSummary;
        if (!s) return '';
        return (s.devices || 0) + ' 台交换机 · ' + (s.ports || 0) + ' 端口';
      },
      nfEmptyText() {
        if (this.nf.error) return '流量数据不可用：' + this.nf.error;
        return '还没有流量样本。流量采集每 5 分钟一轮，需要先有一次成功采集。';
      },
      nfAlerts() {
        return (this.nf.alerts || []).slice(0, 4).map((a) => ({
          id: a.id, ip: a.ip, iface: a.iface, ipCount: a.ipCount,
          peakText: a.peakText, baseText: a.baseText,
          ratio: Number(a.ratio) || 0,
          ratioText: String(Math.round(Number(a.ratio) || 0)),
          timeText: a.raisedAt ? String(a.raisedAt).slice(11, 16) : ''
        }));
      },
      /** 折线点串：用 0~100 的归一化坐标系 + preserveAspectRatio=none，
          同一段 points 能同时画在 330px 的侧栏和 700px 的分区里 */
      sparkPts() {
        const t = this.nf.trend || [];
        if (t.length < 2) return '';
        let max = 0;
        for (const it of t) max = Math.max(max, Number(it.totalBps) || 0);
        if (max <= 0) return '';
        const out = [];
        for (let i = 0; i < t.length; i++) {
          const x = (i / (t.length - 1)) * 100;
          const y = 100 - (Number(t[i].totalBps) || 0) / max * 90 - 5;
          out.push(x.toFixed(2) + ',' + y.toFixed(2));
        }
        return out.join(' ');
      },
      sparkArea() {
        const p = this.sparkPts;
        return p ? ('0,100 ' + p + ' 100,100') : '';
      }
    },

    methods: {
      labelOf(s) { return ST_LABEL[s] || s; },
      pct(v) { return (v === null || v === undefined) ? '—' : v + '%'; },
      barClass(v) {
        if (v === null || v === undefined) return 'ok';
        return v >= 90 ? 'bad' : (v >= 70 ? 'warn' : 'ok');
      },
      sortedReasons(d) {
        const rs = (d.reasons || []).slice();
        rs.sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1));
        return rs;
      },
      shown(g) {
        // 分区内按状态排序 + 应用筛选；缺陷设备永远排在最前
        const f = this.ui[g.key] ? this.ui[g.key].filter : '';
        return g.list
          .filter((d) => !f || d.status === f)
          .slice()
          .sort((a, b) => (ST_ORDER[a.status] === undefined ? 9 : ST_ORDER[a.status])
            - (ST_ORDER[b.status] === undefined ? 9 : ST_ORDER[b.status]));
      },
      toggleGroup(key) {
        if (!this.ui[key]) return;
        this.ui[key].collapsed = !this.ui[key].collapsed;
      },
      setFilter(key, st) {
        if (!this.ui[key]) return;
        this.ui[key].filter = this.ui[key].filter === st ? '' : st;
      },
      tick() {
        const d = new Date();
        this.clock = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        this.dateText = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
          + ' 周' + '日一二三四五六'.charAt(d.getDay());
      },

      /* ---------------- 流量：格式化与取数 ---------------- */

      /** 大数字与单位拆开，方便「1.42 大 + Gbps 小」地排 */
      nfSplit(bps) {
        const v = Number(bps) || 0;
        if (v >= 1e9) return { n: (v / 1e9).toFixed(2), u: 'Gbps' };
        if (v >= 1e6) return { n: (v / 1e6).toFixed(1), u: 'Mbps' };
        if (v >= 1e3) return { n: (v / 1e3).toFixed(0), u: 'Kbps' };
        return { n: String(Math.round(v)), u: 'bps' };
      },
      nfFmt(bps) { const s = this.nfSplit(bps); return s.n + ' ' + s.u; },
      /**
       * 端口名缩写成网络工程师习惯的写法。
       * 卡片里那点宽度放不下 GigabitEthernet0/0/17（21 字符），
       * 不缩写就会溢出把 IP 和进度条挤没。
       */
      shortIface(s) {
        return String(s || '')
          .replace(/^HundredGigabitEthernet/i, 'HGE')
          .replace(/^FortyGigabitEthernet/i, 'FGE')
          .replace(/^TenGigabitEthernet/i, 'XGE')
          .replace(/^GigabitEthernet/i, 'GE')
          .replace(/^FastEthernet/i, 'FE')
          .replace(/^Ethernet/i, 'Eth')
          .replace(/^Bridge-Aggregation/i, 'BAGG')
          .replace(/^Port-channel/i, 'Po');
      },
      /** "2026-09-29 18:04:00" → 毫秒；解析不了返回 0（不自造时间戳） */
      nfTs(s) {
        const t = Date.parse(String(s || '').replace(' ', 'T'));
        return Number.isFinite(t) ? t : 0;
      },
      /** 某台交换机卡片里的 Top3 端口条（按端口口径取，多终端口也不会被漏掉） */
      portsOf(d) {
        if (!d || !d.host) return [];
        const list = (this.nf.topPort || []).filter((r) => r.host === d.host);
        if (!list.length) return [];
        let max = 0;
        for (const r of list) max = Math.max(max, Number(r.peakBps) || 0);
        const min = this.nfMinBps;
        return list.slice(0, 3).map((r) => {
          const peak = Number(r.peakBps) || 0;
          return {
            iface: this.shortIface(r.iface),
            label: r.ip || (r.ipCount > 1 ? r.ipCount + ' 个终端' : '—'),
            peakText: r.peakText || this.nfFmt(peak),
            // 每台设备内部相对自己的最大口 —— 跨设备比会把小交换机的口全压成 2%
            w: Math.max(3, Math.round(peak / (max || 1) * 100)) + '%',
            cls: peak >= min * 3 ? 'hot' : (peak >= min ? 'warn' : '')
          };
        });
      },

      async loadNetflow() {
        try {
          const [st, ip, port, tr, al] = await Promise.all([
            api.get('/api/inspection/netflow/status'),
            api.get('/api/inspection/netflow/top?type=ip&minutes=' + this.nfMinutes + '&limit=8'),
            // 卡片端口条用端口口径：多终端端口也要能看到，否则大流量口会被漏掉
            api.get('/api/inspection/netflow/top?type=port&minutes=' + this.nfMinutes + '&limit=30'),
            api.get('/api/inspection/netflow/trend?minutes=' + this.nfMinutes),
            api.get('/api/inspection/netflow/alerts?unack=1&limit=20')
          ]);
          this.nf = {
            ready: true, error: '',
            status: st || null,
            topIp: (ip && ip.items) || [],
            topPort: (port && port.items) || [],
            trend: (tr && tr.items) || [],
            alerts: (al && al.items) || []
          };
        } catch (e) {
          // 流量模块可能没装载、或服务还没重启（新接口 404）。
          // 大屏不能因此白屏 —— 标记为不可用，页面上所有流量元素一起隐藏。
          this.nf = Object.assign({}, this.nf, { ready: false, error: (e && e.message) || String(e) });
        }
      },

      refreshAll() { this.load(); this.loadNetflow(); },

      setNfMode(k) { this.nfMode = k; this.saveNfPref(); },
      setNfType(k) { this.nfType = k; this.saveNfPref(); },
      toggleNfPorts() { this.nfPorts = !this.nfPorts; this.saveNfPref(); },
      saveNfPref() {
        try {
          localStorage.setItem('his_scr_nf', JSON.stringify({
            mode: this.nfMode, type: this.nfType, ports: this.nfPorts
          }));
        } catch (e) { /* 隐私模式下 localStorage 不可写，忽略 */ }
      },
      loadNfPref() {
        try {
          const o = JSON.parse(localStorage.getItem('his_scr_nf') || '{}') || {};
          if (['band', 'aside', 'section'].indexOf(o.mode) >= 0) this.nfMode = o.mode;
          if (['ip', 'port'].indexOf(o.type) >= 0) this.nfType = o.type;
          if (typeof o.ports === 'boolean') this.nfPorts = o.ports;
        } catch (e) { /* 配置坏了就退回默认 */ }
      },
      ensureUi() {
        // 预先建好每个分区的 UI 状态，避免模板在渲染期去写响应式对象
        // （那样会触发二次更新，Vue 会警告或陷入重复渲染）
        for (const g of GROUPS) {
          if (!this.ui[g.key]) this.$set ? this.$set(this.ui, g.key, { collapsed: false, filter: '' })
            : (this.ui[g.key] = { collapsed: false, filter: '' });
        }
      },
      async load() {
        try {
          this.data = await api.get('/api/inspection/status');
        } catch (e) {
          this.data = Object.assign({}, this.data, { lastError: e.message });
          this.$toast && this.$toast('获取巡检状态失败：' + e.message, 'err');
        }
      },
      async runNow() {
        this.busy = true;
        try {
          const r = await api.post('/api/inspection/run', {});
          this.$toast && this.$toast(r.message || '巡检完成', 'ok');
          await this.load();
        } catch (e) {
          this.$toast && this.$toast(e.message, 'err');
        } finally { this.busy = false; }
      },
      async reload() {
        this.busy = true;
        try {
          const r = await api.post('/api/inspection/reload', {});
          this.$toast && this.$toast(r.message || '已重载', 'ok');
          await this.load();
        } catch (e) {
          this.$toast && this.$toast(e.message, 'err');
        } finally { this.busy = false; }
      },
      toggleFull() {
        const el = this.$refs.box;
        if (!el) return;
        if (!document.fullscreenElement) {
          if (el.requestFullscreen) el.requestFullscreen();
        } else if (document.exitFullscreen) {
          document.exitFullscreen();
        }
      },
      onFsChange() { this.full = !!document.fullscreenElement; }
    },

    mounted() {
      this.ensureUi();
      this.loadNfPref();
      this.tick();
      this.load();
      this.loadNetflow();
      this._t = setInterval(this.tick, 1000);
      this._p = setInterval(this.load, 15000);
      // 流量 5 分钟才采一轮，跟着 15 秒轮询纯属浪费；60 秒足够跟上手工触发的采集
      this._n = setInterval(this.loadNetflow, 60000);
      document.addEventListener('fullscreenchange', this.onFsChange);
    },

    beforeUnmount() {
      clearInterval(this._t);
      clearInterval(this._p);
      clearInterval(this._n);
      document.removeEventListener('fullscreenchange', this.onFsChange);
    }
  };

  /* ---------------- 巡检报告 ---------------- */

  V.ReportsView = {
    template: `
    <div>
      <div class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">
          <div style="font-size:16px;font-weight:600">巡检报告</div>
          <span class="dev-badge muted">共 {{ rows.length }} 份</span>
          <span v-if="dir" class="dev-badge muted" :title="dir">目录：{{ shortDir }}</span>
          <div style="flex:1"></div>
          <button v-if="canOperate" class="btn btn-primary btn-sm" :disabled="gen.busy" @click="generate">
            {{ gen.busy ? '生成中…' : '生成巡检报告' }}
          </button>
          <button class="btn btn-outline btn-sm" @click="load">刷新</button>
        </div>
      </div>

      <div v-if="gen.busy" class="card" style="margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <span style="font-weight:600">正在生成报告…</span>
          <span class="dev-badge muted">已用 {{ gen.elapsed }} 秒</span>
        </div>
        <div class="gen-log">
          <div v-for="(l,i) in gen.logs.slice(-40)" :key="i">{{ l }}</div>
        </div>
      </div>

      <div class="card">
        <div class="table-wrap">
          <table class="tbl rep-table">
            <thead>
              <tr>
                <th>报告名称</th>
                <th class="c-type">类型</th>
                <th class="c-time">生成时间</th>
                <th class="c-size">大小</th>
                <th class="c-ops">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.name">
                <td><div class="rep-name" :title="r.name">{{ r.name }}</div></td>
                <td>
                  <span class="dev-badge" :class="r.weekly ? 'warn' : 'ok'">{{ r.weekly ? '周报' : '巡检报告' }}</span>
                </td>
                <td class="mono">{{ r.stamp || '-' }}</td>
                <td class="num">{{ sizeText(r.size) }}</td>
                <td class="ops">
                  <div class="row-actions">
                    <button class="btn btn-ghost btn-sm" @click="preview(r)">预览</button>
                    <button class="btn btn-ghost btn-sm" @click="download(r)">下载</button>
                  </div>
                </td>
              </tr>
              <tr v-if="!rows.length">
                <td colspan="5" class="empty-row">
                  还没有报告。点击右上角「生成巡检报告」，或等待每周自动生成的周报。
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="modal-mask" v-if="pv.open">
        <div class="modal" style="width:92%;height:88%;display:flex;flex-direction:column">
          <div class="modal-head">
            {{ pv.name }}
            <span class="x" @click="closePreview">✕</span>
          </div>
          <div style="flex:1;overflow:hidden;background:#fff">
            <iframe v-if="pv.url" :src="pv.url" style="width:100%;height:100%;border:0"></iframe>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        rows: [],
        dir: '',
        pv: { open: false, name: '', url: '' },
        gen: { busy: false, logs: [], taskId: '', elapsed: 0, timer: null, poll: null }
      };
    },

    computed: {
      user() { return window.HisUser ? window.HisUser.user : null; },
      canOperate() { const u = this.user; return u && (u.role_id === 1 || u.role_id === 2); },
      shortDir() {
        const s = this.dir || '';
        return s.length > 34 ? '…' + s.slice(-34) : s;
      }
    },

    methods: {
      sizeText(n) {
        const v = Number(n || 0);
        if (v < 1024) return v + ' B';
        if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
        return (v / 1024 / 1024).toFixed(1) + ' MB';
      },
      async load() {
        try {
          const r = await api.get('/api/inspection/reports');
          this.rows = (r.items || []).slice().sort((a, b) => String(b.name).localeCompare(String(a.name)));
          this.dir = r.dir || '';
        } catch (e) {
          this.$toast && this.$toast('获取报告列表失败：' + e.message, 'err');
        }
      },
      // 报告原文需要 Bearer 才能取，且是自带内联样式的单文件 HTML，
      // 因此统一由 fetch 取回来转 blob 再交给 iframe / a[download]，
      // 不直接开新窗口 —— 那样浏览器不会自动带 token，会拿到 401。
      async fetchRaw(item) {
        const token = localStorage.getItem('his_token') || '';
        const url = '/api/inspection/reports/' + encodeURIComponent(item.name) + '/raw';
        const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
        if (!res.ok) throw new Error('获取报告失败（HTTP ' + res.status + '）');
        const html = await res.text();
        return new Blob([html], { type: 'text/html;charset=utf-8' });
      },
      async preview(item) {
        try {
          const blob = await this.fetchRaw(item);
          this.closePreview();
          this.pv = { open: true, name: item.name, url: URL.createObjectURL(blob) };
        } catch (e) {
          this.$toast && this.$toast(e.message, 'err');
        }
      },
      closePreview() {
        if (this.pv.url) URL.revokeObjectURL(this.pv.url);
        this.pv = { open: false, name: '', url: '' };
      },
      async download(item) {
        try {
          const blob = await this.fetchRaw(item);
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = item.name;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 3000);
        } catch (e) {
          this.$toast && this.$toast(e.message, 'err');
        }
      },
      async generate() {
        this.gen.busy = true;
        this.gen.logs = [];
        this.gen.elapsed = 0;
        const t0 = Date.now();
        this.gen.timer = setInterval(() => {
          this.gen.elapsed = Math.round((Date.now() - t0) / 1000);
        }, 1000);
        try {
          const r = await api.post('/api/inspection/reports/generate', {});
          this.gen.taskId = r.taskId;
          this.startPoll();
        } catch (e) {
          this.stopGen();
          this.$toast && this.$toast(e.message, 'err');
        }
      },
      startPoll() {
        let n = 0;
        this.gen.poll = setInterval(async () => {
          n++;
          if (n > 600) { this.stopGen(); this.$toast && this.$toast('等待超时，请查看服务日志', 'err'); return; }
          try {
            const t = await api.get('/api/inspection/reports/task/' + this.gen.taskId);
            this.gen.logs = t.logs || [];
            if (t.status !== 'running') {
              this.stopGen();
              if (t.status === 'done') {
                this.$toast && this.$toast('报告已生成：' + ((t.result && t.result.file) || ''), 'ok');
                this.load();
              } else {
                this.$toast && this.$toast('报告生成失败：' + ((t.result && t.result.error) || '未知原因'), 'err');
              }
            }
          } catch (e) {
            this.stopGen();
            this.$toast && this.$toast('查询任务失败：' + e.message, 'err');
          }
        }, 2000);
      },
      stopGen() {
        this.gen.busy = false;
        clearInterval(this.gen.timer);
        clearInterval(this.gen.poll);
        this.gen.timer = null;
        this.gen.poll = null;
      }
    },

    mounted() { this.load(); },
    beforeUnmount() {
      this.stopGen();
      this.closePreview();
    }
  };
})();
