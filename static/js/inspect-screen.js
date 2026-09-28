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
        <div style="flex:1"></div>
        <button class="scr-btn" @click="load">立即刷新</button>
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
        ui: {}
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
        return items;
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
      this.tick();
      this.load();
      this._t = setInterval(this.tick, 1000);
      this._p = setInterval(this.load, 15000);
      document.addEventListener('fullscreenchange', this.onFsChange);
    },

    beforeUnmount() {
      clearInterval(this._t);
      clearInterval(this._p);
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
        <table class="tbl">
          <thead>
            <tr>
              <th style="width:44%">报告名称</th>
              <th style="width:14%">类型</th>
              <th style="width:16%">生成时间</th>
              <th style="width:10%">大小</th>
              <th style="width:16%">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.name">
              <td>{{ r.name }}</td>
              <td>
                <span class="dev-badge" :class="r.weekly ? 'warn' : 'ok'">{{ r.weekly ? '周报' : '巡检报告' }}</span>
              </td>
              <td>{{ r.stamp || '-' }}</td>
              <td>{{ sizeText(r.size) }}</td>
              <td>
                <button class="btn btn-outline btn-sm" @click="preview(r)">预览</button>
                <button class="btn btn-outline btn-sm" @click="download(r)">下载</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="5" style="text-align:center;color:#8a94a6;padding:26px">
                还没有报告。点击右上角「生成巡检报告」，或等待每周自动生成的周报。
              </td>
            </tr>
          </tbody>
        </table>
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
