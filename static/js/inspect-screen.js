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

  // 指标下拉的最后一道兜底：新版后端 /metrics/catalog 会返回「内置目录 ∪ 实际采集」，
  // 但服务没重启、接口 404、或连的是旧后端时可能返回空 items。空 <select> 在界面上
  // 只剩一个孤零零的小箭头，值班同事会以为控件坏了，所以这里保底给几个最常用指标。
  // 只放高频内置项，中文名与后端 METRIC_CATALOG 保持一致；动态 textfile 指标仍以后端为准。
  const FALLBACK_METRICS = [
    { key: 'cpu_percent', label: 'CPU 使用率', unit: '%' },
    { key: 'mem_percent', label: '内存使用率', unit: '%' },
    { key: 'disk_percent_max', label: '磁盘最大使用率', unit: '%' },
    { key: 'log_errors', label: '事件日志错误数', unit: '条' },
    { key: 'load1', label: '负载 1 分钟', unit: '' },
    { key: 'net_total_kbps', label: '网卡总速率', unit: 'KB/s' },
    { key: 'x.commit_percent', label: '提交内存占比', unit: '%' },
    { key: 'x.tcp_established', label: 'TCP 已建立连接', unit: '个' }
  ];

  /* ---------------- 驾驶舱版（P1） ----------------
     同一视图内的第二套版式：值班版 DOM 一行不动，驾驶舱版只做投屏只读展示。
     图表全部手绘 SVG（内网没有图表库），数据一律从 load()/loadExt()/
     loadNetflow()/loadBiz() 已拉回来的响应式对象派生，零新增后端接口。 */
  const CAB_MODES = [
    { key: 'duty', label: '值班版' },
    { key: 'cockpit', label: '驾驶舱版' }
  ];
  const CAB_PALETTES = [
    { key: 'system', label: '系统色' },
    { key: 'ref', label: '参考色' }
  ];
  const CAB_ST_COLOR = {
    normal: 'var(--cab-ok)', warning: 'var(--cab-warn)',
    critical: 'var(--cab-bad)', error: 'var(--cab-muted)'
  };

  /** 环形 / 旭日分段：数值 → stroke-dasharray + stroke-dashoffset。
      每段减 1.5 留一道缝，否则同色相邻时会糊成一整圈。 */
  function arcOf(segs, r) {
    const c = 2 * Math.PI * r;
    let total = 0;
    for (const s of segs) total += (Number(s.value) || 0);
    let acc = 0;
    const out = segs.map((s) => {
      const v = Number(s.value) || 0;
      const len = total ? v / total * c : 0;
      const row = {
        label: s.label, value: v, color: s.color,
        dash: Math.max(0, len - 1.5), offset: -acc,
        pct: total ? Math.round(v / total * 1000) / 10 : 0
      };
      acc += len;
      return row;
    });
    return { c: c, segs: out, total: total };
  }

  /** 分区聚合：健康度 / 环形 / 旭日共用一份，避免三处各算一遍导致数字对不上 */
  function cabGroupOf(key, title, list, color) {
    const counts = { normal: 0, warning: 0, critical: 0, error: 0 };
    let cpu = 0, cn = 0, mem = 0, mn = 0;
    for (const d of list) {
      if (counts[d.status] !== undefined) counts[d.status]++;
      if (typeof d.cpu === 'number' && isFinite(d.cpu)) { cpu += d.cpu; cn++; }
      if (typeof d.mem === 'number' && isFinite(d.mem)) { mem += d.mem; mn++; }
    }
    return {
      key: key, title: title, total: list.length, counts: counts, color: color,
      okPct: list.length ? Math.round(counts.normal / list.length * 100) : 0,
      cpuAvg: cn ? Math.round(cpu / cn) : null,
      memAvg: mn ? Math.round(mem / mn) : null
    };
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  V.BigScreenView = {
    template: `
    <div class="scr-wrap" :class="{cockpit: screenMode==='cockpit', 'ref-blue': screenMode==='cockpit' && palette==='ref'}" ref="box">
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
        <!-- 版式开关：默认仍是值班版（保护值班肌肉记忆），选择记在 localStorage。
             驾驶舱版是投屏只读视图，写操作一律留在值班版。 -->
        <span class="scr-flow-sw">
          <span class="k">版式</span>
          <span v-for="m in cabModes" :key="m.key" class="opt"
            :class="{active: screenMode===m.key}" @click="setScreenMode(m.key)">{{ m.label }}</span>
        </span>
        <span v-if="screenMode==='cockpit'" class="scr-flow-sw">
          <span class="k">色板</span>
          <span v-for="p in cabPalettes" :key="p.key" class="opt"
            :class="{active: palette===p.key}" @click="setPalette(p.key)">{{ p.label }}</span>
        </span>
        <template v-if="screenMode==='duty'">
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
        </template>
        <template v-else>
          <span class="scr-live"><i class="scr-dot"></i>投屏只读 · 每 {{ data.interval }} 秒</span>
          <span v-if="data.round" class="scr-chip">第 {{ data.round }} 轮</span>
          <span class="scr-chip">{{ cabAsOf }}</span>
          <span v-if="data.sourceMode" class="scr-chip">数据源：{{ sourceLabel }}</span>
        </template>
        <div style="flex:1"></div>
        <button v-if="screenMode==='cockpit'" class="scr-btn" @click="toggleCabMeta">角标 · {{ showCabMeta ? '开' : '关' }}</button>
        <button class="scr-btn" @click="refreshAll">立即刷新</button>
        <template v-if="screenMode==='duty'">
          <button v-if="canOperate" class="scr-btn primary" :disabled="busy" @click="runNow">
            {{ busy ? '巡检中…' : '触发巡检' }}
          </button>
          <button v-if="isAdmin" class="scr-btn" :disabled="busy" @click="reload">重载配置</button>
        </template>
        <button class="scr-btn" @click="toggleFull">{{ full ? '退出投屏' : '全屏投屏' }}</button>
      </div>

      <!-- P1：值班版顶层块逐一带版式条件，驾驶舱版是下面独立的 cab-wrap。
           不用 <template> 整块包：运行时编译器会把内层的 </div> 提前闭合根容器，
           实测会把 cab-wrap 挤到 .scr-wrap 外面，投屏时整块内容掉到屏幕下方。 -->
      <div v-if="screenMode==='duty' && canInspect && alertItems.length" class="scr-alert">
        <div v-for="(a,i) in alertItems" :key="i">{{ a }}</div>
      </div>

      <div v-if="screenMode==='duty' && !canInspect" class="scr-alert">
        <div>当前角色未被分配「巡检报告 · 查看」权限，大屏不显示巡检数据{{ canNetflow ? '，仅显示流量部分' : '' }}。需要查看请让管理员在【系统管理 → 角色权限】中勾选。</div>
      </div>

      <div v-if="screenMode==='duty' && canInspect" class="scr-stats">
        <div class="scr-stat t"><div class="num">{{ summary.total }}</div><div class="lbl">设备总数</div></div>
        <div class="scr-stat n"><div class="num">{{ summary.normal }}</div><div class="lbl">正常</div></div>
        <div class="scr-stat w"><div class="num">{{ summary.warning }}</div><div class="lbl">警告</div></div>
        <div class="scr-stat c"><div class="num">{{ summary.critical }}</div><div class="lbl">严重</div></div>
        <div class="scr-stat e"><div class="num">{{ summary.error }}</div><div class="lbl">失败</div></div>
      </div>

      <!-- P2/P3 扩展区块：按定稿插在统计卡正下方，下面的设备分区与流量监控顺序一律不动。
           ext.ready 为 false 时整块隐藏 —— 历史库不可用、接口 404（服务没重启）都不能让大屏白屏。 -->
      <div v-if="screenMode==='duty' && canInspect && ext.ready" class="sx-wrap">
        <div class="sx-head">
          <div>
            <div class="sx-title">扩展监控与告警</div>
            <div class="sx-sub">第 {{ ext.latest.roundNo || '—' }} 轮 · {{ ext.latest.checkedAt || '暂无历史' }}
              · 业务指标 {{ bizCards.length }} 项 · 可用指标 {{ metricOptions.length }} 项</div>
          </div>
          <div style="flex:1"></div>
          <span class="sx-chip" :class="{bad: ext.summary.critical > 0}">严重 {{ ext.summary.critical }}</span>
          <span class="sx-chip" :class="{warn: ext.summary.unacked > 0}">未确认 {{ ext.summary.unacked }}</span>
          <button class="scr-btn" @click="loadExt">刷新</button>
          <button v-if="canOperate" class="scr-btn" @click="ext.editing = !ext.editing">{{ ext.editing ? '完成编辑' : '阈值规则' }}</button>
        </div>

        <div class="sx-cards">
          <div v-for="c in bizCards" :key="c.key" class="sx-card" :class="c.cls">
            <div class="k" :title="c.key">{{ c.label }}</div>
            <div class="v">{{ c.value }}<s v-if="c.unit">{{ c.unit }}</s></div>
            <div class="d">{{ c.device }}</div>
          </div>
          <div v-if="!bizCards.length" class="sx-empty">暂无 textfile 业务指标：目标机 .prom 放入 textfile_inputs 后，下一轮巡检会出现在这里</div>
        </div>

        <div class="sx-body">
          <div class="sx-panel">
            <div class="sx-panel-h">
              <b>历史趋势</b>
              <select v-model="ext.deviceId" class="sx-sel" @change="loadSeries">
                <option v-for="d in extDevices" :key="d.id" :value="d.id">{{ d.name }}</option>
              </select>
              <select v-model="ext.key" class="sx-sel wide" @change="loadSeries">
                <option v-for="m in metricOptions" :key="m.key" :value="m.key">{{ m.label }}</option>
              </select>
              <span class="sx-ranges">
                <span v-for="r in ext.ranges" :key="r.key" class="opt"
                  :class="{active: ext.range === r.key}" @click="setExtRange(r.key)">{{ r.label }}</span>
              </span>
            </div>
            <div class="sx-chart-wrap">
              <svg v-if="chart" class="sx-chart" viewBox="0 0 600 180" preserveAspectRatio="xMidYMid meet">
                <line v-for="(g,i) in chart.grid" :key="'g'+i" :x1="chart.L" :x2="600-chart.R"
                  :y1="g.y" :y2="g.y" stroke="#243247" stroke-width="1"/>
                <text v-for="(g,i) in chart.grid" :key="'t'+i" :x="chart.L-6" :y="g.y+4"
                  fill="#8a99ac" font-size="10" text-anchor="end">{{ g.v }}</text>
                <polygon v-if="chart.band" :points="chart.band" fill="#4f8ef722" stroke="none"/>
                <polyline v-if="chart.line" :points="chart.line" fill="none" stroke="#7cc4ff"
                  stroke-width="2" vector-effect="non-scaling-stroke"/>
                <line v-if="chart.yWarn !== null" :x1="chart.L" :x2="600-chart.R" :y1="chart.yWarn" :y2="chart.yWarn"
                  stroke="#e5a54b" stroke-width="1" stroke-dasharray="5 4"/>
                <line v-if="chart.yCrit !== null" :x1="chart.L" :x2="600-chart.R" :y1="chart.yCrit" :y2="chart.yCrit"
                  stroke="#ef6b73" stroke-width="1" stroke-dasharray="5 4"/>
                <text v-for="(t,i) in chart.xTicks" :key="'x'+i" :x="t.x" :y="174"
                  fill="#8a99ac" font-size="10" text-anchor="middle">{{ t.label }}</text>
              </svg>
              <div v-else class="sx-empty">该设备此指标还没有足够的历史点（每轮巡检落一条，至少 2 点才成线）</div>
            </div>
            <div v-if="ext.series.items && ext.series.items.length" class="sx-kpis">
              <span>最新 <b>{{ ext.series.items[ext.series.items.length-1].value }}{{ ext.series.unit }}</b></span>
              <span>均值 <b>{{ ext.series.avg }}{{ ext.series.unit }}</b></span>
              <span>峰值 <b>{{ ext.series.max }}{{ ext.series.unit }}</b></span>
              <span>{{ ext.series.count }} 点 · {{ ext.series.label }}</span>
            </div>
          </div>

          <div class="sx-panel">
            <div class="sx-panel-h"><b>活跃告警</b><span>{{ ext.events.length }} 条未恢复</span></div>
            <div class="sx-events">
              <div v-for="e in ext.events" :key="e.id" class="sx-event" :class="e.level">
                <div class="t">{{ e.message }}</div>
                <div class="m">{{ e.first_at }} · 连续 {{ e.hits }} 轮 ·
                  {{ e.status === 'acked' ? '已确认 ' + e.acked_by : '未确认' }}</div>
                <button v-if="canOperate && e.status === 'open'" class="sx-ack" @click="ackEvent(e.id)">确认</button>
              </div>
              <div v-if="!ext.events.length" class="sx-empty">暂无活跃告警</div>
            </div>
          </div>
        </div>

        <div v-if="ext.editing && canOperate" class="sx-rules">
          <div class="sx-add">
            <span class="k">新增按设备覆盖</span>
            <select v-model="ext.newRule.device_id" class="sx-sel">
              <option v-for="d in extDevices" :key="d.id" :value="d.id">{{ d.name }}</option>
            </select>
            <select v-model="ext.newRule.metric_key" class="sx-sel wide">
              <option v-for="m in metricOptions" :key="m.key" :value="m.key">{{ m.label }}</option>
            </select>
            <span class="k">警告</span><input class="sx-ipt" type="number" v-model.number="ext.newRule.warn">
            <span class="k">严重</span><input class="sx-ipt" type="number" v-model.number="ext.newRule.crit">
            <button class="scr-btn primary" @click="addOverride">添加</button>
          </div>
          <table class="sx-tbl">
            <thead><tr>
              <th>指标</th><th>作用范围</th><th>方向</th><th>警告线</th><th>严重线</th>
              <th>连续轮次</th><th>冷却(分)</th><th>启用</th><th></th>
            </tr></thead>
            <tbody>
              <tr v-for="r in ext.rules" :key="r.id">
                <td :title="r.metric_key">{{ r.label || r.metric_key }}</td>
                <td>{{ r.device_id ? (r.device_name || '设备 ' + r.device_id) : '全局' }}</td>
                <td>{{ r.direction === 'down' ? '低于' : '超过' }}</td>
                <template v-if="ext.ruleDraft[r.id]">
                  <td><input class="sx-ipt" type="number" v-model.number="ext.ruleDraft[r.id].warn"></td>
                  <td><input class="sx-ipt" type="number" v-model.number="ext.ruleDraft[r.id].crit"></td>
                  <td><input class="sx-ipt" type="number" v-model.number="ext.ruleDraft[r.id].consecutive"></td>
                  <td><input class="sx-ipt" type="number" v-model.number="ext.ruleDraft[r.id].cooldown_min"></td>
                  <td><input type="checkbox" v-model="ext.ruleDraft[r.id].enabled"></td>
                  <td>
                    <button class="sx-ack" @click="saveRule(r)">保存</button>
                    <button v-if="r.device_id" class="sx-ack del" @click="delRule(r)">删除</button>
                  </td>
                </template>
                <td v-else colspan="6" class="sx-err">草稿未就绪</td>
              </tr>
            </tbody>
          </table>
          <div class="sx-hint">改完规则，阈值线、告警判定与下一轮的事件会一起重算；已有事件不受影响。全局规则只能改/停用，不能删。</div>
        </div>
      </div>

      <div v-if="screenMode==='duty'" class="scr-flow" :class="{'with-aside': nf.ready && nfMode==='aside'}">
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

      <div v-if="canInspect && !groups.length" class="scr-empty">{{ data.updatedAt ? '当前没有纳管中的设备' : '正在加载巡检数据…' }}</div>

      <template v-if="canInspect">
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

            <!-- exporter 通道采到的扩展指标不进 CPU/内存两条进度条，老卡片上就等于「什么都没有」。
                 这里给 exporter 设备补一行摘要，SSH/WMI 卡片版式保持原样；
                 整行是按钮，点开看本轮每一项的名字和值（数据随 status 一起下来，不另发请求）。 -->
            <button v-if="d.extraHint && d.extraHint.length" type="button" class="scr-c-more"
              @click="openExtra(d)" :title="'点击查看 ' + d.name + ' 的扩展采集明细'">
              <span v-for="(t, ti) in d.extraHint" :key="ti">{{ t }}</span>
              <span class="scr-c-more-go">明细 ›</span>
            </button>

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
      </template>

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

      <div v-if="screenMode==='duty'" class="scr-foot">
        <div><i class="scr-dot"></i>数据每轮巡检后自动更新</div>
        <div>报告目录：{{ data.reportsDir || '-' }}</div>
      </div>

      <!-- 扩展采集明细：只读弹窗。点遮罩 / 右上角 ✕ / Esc 都能关，
           每 15 秒轮询回来会同步刷新，不会让人对着上一轮的数据发呆。 -->
      <div v-if="screenMode==='duty' && extraDlg" class="sx-dlg-mask" @click.self="closeExtra">
        <div class="sx-dlg" role="dialog" aria-modal="true" aria-label="扩展采集明细">
          <div class="sx-dlg-h">
            <div class="sx-dlg-ht">
              <div class="sx-dlg-t">扩展采集明细 · {{ extraDlg.name }}</div>
              <div class="sx-dlg-s">{{ extraDlg.host }}<span v-if="extraDlg.osLabel"> · {{ extraDlg.osLabel }}</span>
                · {{ extraDlg.detail.meta.hint.join(' · ') }}
                <span v-if="extraDlg.detail.meta.count"> · {{ extraDlg.detail.meta.sampledTwice ? '两次采样差分' : '单次采样' }}</span>
              </div>
            </div>
            <button type="button" class="sx-dlg-x" @click="closeExtra" title="关闭">✕</button>
          </div>
          <div class="sx-dlg-b">
            <div v-for="(g, gi) in extraDlg.detail.groups" :key="gi" class="sx-dlg-g">
              <div class="sx-dlg-gt">{{ g.title }}<span>{{ g.rows.length }} 行</span></div>
              <div class="sx-dlg-scroll">
                <table class="sx-dlg-tb">
                  <thead><tr><th v-for="(c, ci) in g.cols" :key="ci">{{ c }}</th></tr></thead>
                  <tbody>
                    <tr v-for="(row, ri) in g.rows" :key="ri">
                      <td v-for="(v, ci) in row" :key="ci" :class="{k: ci === 0}">{{ v }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
            <div v-if="!extraDlg.detail.groups.length" class="sx-dlg-empty">本轮没有采到扩展指标，等下一轮巡检后再看。</div>
            <div v-if="extraDlg.detail.meta.note" class="sx-dlg-note">采集说明：{{ extraDlg.detail.meta.note }}</div>
            <div class="sx-dlg-foot">数据来自最近一轮巡检，随大屏自动刷新 · 按 Esc 或点空白处关闭</div>
          </div>
        </div>
      </div>

      <!-- ★ P1 驾驶舱版：投屏只读、16 面板、12 栅格。
           数据全部来自现有接口，面板右上角标「接口 · 权限码」，可一键隐去；
           参考图里 4 个重复 TOP10 合成 C2 一个 Tab 榜，3 个空占位换成真指标。 -->
      <div v-if="screenMode==='cockpit'" class="cab-wrap">
        <div v-if="!canInspect" class="cab-noperm">
          <b>当前角色没有「巡检报告 · 查看」权限</b>
          <span>驾驶舱版不显示巡检数据，也不会发起对应请求。请让管理员在【系统管理 → 角色权限】勾选，或切回值班版查看流量部分。</span>
        </div>

        <div v-else class="cab-grid">
          <div v-for="k in cabKpis" :key="k.k" class="cab-kpi" :class="k.cls">
            <div class="cab-kpi-v">{{ k.v }}</div>
            <div class="cab-kpi-l">{{ k.label }}</div>
            <span v-if="showCabMeta" class="cab-meta">{{ k.meta }}</span>
          </div>

          <div class="cab-panel cab-a1">
            <div class="cab-h"><b>设备状态分布</b><span v-if="showCabMeta" class="cab-meta">{{ cabMeta.a1 }}</span></div>
            <div class="cab-b cab-ring-b">
              <svg class="cab-ring-svg" viewBox="0 0 140 140">
                <circle cx="70" cy="70" r="52" fill="none" stroke="var(--cab-line)" stroke-width="14"/>
                <circle v-for="(s,i) in cabStatusRing.segs" :key="i" cx="70" cy="70" r="52"
                  fill="none" :stroke="s.color" stroke-width="14"
                  :stroke-dasharray="s.dash + ' ' + (cabStatusRing.c - s.dash)"
                  :stroke-dashoffset="s.offset" transform="rotate(-90 70 70)"/>
                <text x="70" y="68" text-anchor="middle" class="cab-ring-n">{{ summary.total }}</text>
                <text x="70" y="88" text-anchor="middle" class="cab-ring-t">纳管设备</text>
              </svg>
              <div class="cab-legend">
                <div v-for="(s,i) in cabStatusRing.segs" :key="i" class="cab-lg">
                  <i :style="{background:s.color}"></i><span>{{ s.label }}</span><b>{{ s.value }}</b><em>{{ s.pct }}%</em>
                </div>
              </div>
            </div>
          </div>

          <div class="cab-panel cab-a2">
            <div class="cab-h"><b>分区设备分布</b><span v-if="showCabMeta" class="cab-meta">{{ cabMeta.a2 }}</span></div>
            <div class="cab-b cab-ring-b">
              <svg class="cab-ring-svg" viewBox="0 0 140 140">
                <circle cx="70" cy="70" r="52" fill="none" stroke="var(--cab-line)" stroke-width="14"/>
                <circle v-for="(s,i) in cabGroupRing.segs" :key="i" cx="70" cy="70" r="52"
                  fill="none" :stroke="s.color" stroke-width="14"
                  :stroke-dasharray="s.dash + ' ' + (cabGroupRing.c - s.dash)"
                  :stroke-dashoffset="s.offset" transform="rotate(-90 70 70)"/>
                <text x="70" y="68" text-anchor="middle" class="cab-ring-n">{{ cabGroupRing.total }}</text>
                <text x="70" y="88" text-anchor="middle" class="cab-ring-t">已归类</text>
              </svg>
              <div class="cab-legend sm">
                <div v-for="(s,i) in cabGroupRing.segs" :key="i" class="cab-lg">
                  <i :style="{background:s.color}"></i><span>{{ s.label }}</span><b>{{ s.value }}</b>
                </div>
                <div v-if="!cabGroupRing.segs.length" class="cab-empty">暂无设备</div>
              </div>
            </div>
          </div>

          <div class="cab-panel cab-a3">
            <div class="cab-h"><b>分区健康度</b><span v-if="showCabMeta" class="cab-meta">{{ cabMeta.a3 }}</span></div>
            <div class="cab-b cab-hb">
              <div v-for="g in cabGroups" :key="g.key" class="cab-hb-row">
                <span class="nm" :title="g.title">{{ g.title }}</span>
                <span class="track"><i :style="{width: g.okPct + '%', background: g.color}"></i></span>
                <span class="pc">{{ g.okPct }}%</span>
                <span class="ex">C{{ g.cpuAvg === null ? '-' : g.cpuAvg }} M{{ g.memAvg === null ? '-' : g.memAvg }}</span>
              </div>
              <div v-if="!cabGroups.length" class="cab-empty">暂无设备分组数据</div>
            </div>
          </div>

          <div class="cab-panel cab-b1">
            <div class="cab-h"><b>分区 × 状态</b><span class="cab-h-sub">主分析图</span>
              <span v-if="showCabMeta" class="cab-meta">{{ cabMeta.b1 }}</span></div>
            <div class="cab-b cab-sun-b">
              <svg class="cab-sun-svg" viewBox="0 0 200 200">
                <circle cx="100" cy="100" r="44" fill="none" stroke="var(--cab-line)" stroke-width="18"/>
                <circle v-for="(s,i) in cabSun.inner.segs" :key="'i'+i" cx="100" cy="100" r="44"
                  fill="none" :stroke="s.color" stroke-width="18"
                  :stroke-dasharray="s.dash + ' ' + (cabSun.inner.c - s.dash)"
                  :stroke-dashoffset="s.offset" transform="rotate(-90 100 100)"/>
                <circle cx="100" cy="100" r="72" fill="none" stroke="var(--cab-line)" stroke-width="18"/>
                <circle v-for="(s,i) in cabSun.outer.segs" :key="'o'+i" cx="100" cy="100" r="72"
                  fill="none" :stroke="s.color" stroke-width="18" opacity=".82"
                  :stroke-dasharray="s.dash + ' ' + (cabSun.outer.c - s.dash)"
                  :stroke-dashoffset="s.offset" transform="rotate(-90 100 100)"/>
                <text x="100" y="97" text-anchor="middle" class="cab-sun-n">{{ summary.total }}</text>
                <text x="100" y="117" text-anchor="middle" class="cab-ring-t">台 · 本轮</text>
              </svg>
              <div class="cab-sun-side">
                <div class="cab-sun-t">内环 · 设备分区</div>
                <div v-for="(s,i) in cabSun.inner.segs" :key="'li'+i" class="cab-lg">
                  <i :style="{background:s.color}"></i><span>{{ s.label }}</span><b>{{ s.value }}</b>
                </div>
                <div class="cab-sun-t">外环 · 状态构成</div>
                <div class="cab-sun-st">
                  <span v-for="(t,i) in cabStLegend" :key="i">
                    <i :style="{background:t.color}"></i>{{ t.label }} {{ t.value }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div class="cab-panel cab-b2">
            <div class="cab-h">
              <b>趋势</b>
              <span class="cab-tabs">
                <span v-for="t in cabTrendTabs" :key="t.key" class="opt"
                  :class="{active: cabTrendTab===t.key}" @click="setTrendTab(t.key)">{{ t.label }}</span>
              </span>
              <span v-if="showCabMeta" class="cab-meta">{{ cabMeta.b2 }}</span>
            </div>
            <div class="cab-b cab-trend-b">
              <svg v-if="cabTrend.bars.length" class="cab-trend-svg" viewBox="0 0 560 150">
                <line v-for="(y,i) in cabTrend.grid" :key="'g'+i" x1="38" x2="552" :y1="y" :y2="y"
                  stroke="var(--cab-line)" stroke-width="1"/>
                <text v-for="(a,i) in cabTrend.axis" :key="'a'+i" x="32" :y="cabTrend.grid[i]+4"
                  text-anchor="end" class="cab-axis">{{ a }}</text>
                <g v-for="(b,i) in cabTrend.bars" :key="'b'+i">
                  <rect v-for="(p,j) in b.parts" :key="j" :x="b.x" :y="p.y" :width="b.w" :height="p.h" :fill="p.color"/>
                  <text :x="b.x + b.w/2" y="146" text-anchor="middle" class="cab-axis">{{ b.label }}</text>
                </g>
              </svg>
              <div v-else class="cab-empty">{{ cabTrend.empty }}</div>
              <div class="cab-trend-foot">{{ cabTrend.source }}</div>
            </div>
          </div>

          <div class="cab-panel cab-c1">
            <div class="cab-h"><b>活跃告警</b><span class="cab-h-sub">{{ ext.events.length }} 条未恢复</span>
              <span v-if="showCabMeta" class="cab-meta">{{ cabMeta.c1 }}</span></div>
            <div class="cab-b cab-ev-list">
              <div v-for="e in cabAlerts" :key="e.id" class="cab-ev" :class="e.level">
                <span class="dot"></span><span class="tx" :title="e.message">{{ e.message }}</span>
                <span class="tm">{{ e.meta }}</span>
              </div>
              <div v-if="!cabAlerts.length" class="cab-empty">暂无活跃告警</div>
            </div>
          </div>

          <div class="cab-panel cab-c2">
            <div class="cab-h">
              <b>TOP 榜</b>
              <span class="cab-tabs">
                <span v-for="t in cabTopTabs" :key="t.key" class="opt"
                  :class="{active: cabTopTab===t.key}" @click="setTopTab(t.key)">{{ t.label }}</span>
              </span>
              <span v-if="showCabMeta" class="cab-meta">{{ cabMeta.c2 }}</span>
            </div>
            <div class="cab-b cab-rank">
              <div v-for="(r,i) in cabTopRows" :key="i" class="cab-rank-row">
                <span class="no">{{ i+1 }}</span>
                <span class="nm" :title="r.label">{{ r.label }}</span>
                <span class="track"><i :style="{width: r.w + '%'}"></i></span>
                <span class="vl">{{ r.value }}</span>
              </div>
              <div v-if="!cabTopRows.length" class="cab-empty">暂无排行数据</div>
            </div>
          </div>

          <div class="cab-panel cab-c3">
            <div class="cab-h"><b>覆盖与处置</b><span v-if="showCabMeta" class="cab-meta">{{ cabMeta.c3 }}</span></div>
            <div class="cab-b cab-cover">
              <div class="cab-cov-item">
                <div class="ring" :style="{background: 'conic-gradient(var(--cab-ok) ' + cabCover.done + '%, var(--cab-surface) 0)'}"><i>{{ cabCover.done }}%</i></div>
                <div class="lb">本轮巡检完成</div><div class="sb">{{ summary.total - summary.error }} / {{ summary.total }} 台</div>
              </div>
              <div class="cab-cov-item">
                <div class="ring" :style="{background: 'conic-gradient(var(--cab-info) ' + cabCover.ack + '%, var(--cab-surface) 0)'}"><i>{{ cabCover.ack }}%</i></div>
                <div class="lb">告警已确认</div><div class="sb">{{ cabCover.ackBase }} 条未恢复</div>
              </div>
              <div class="cab-cov-item">
                <div class="ring" :style="{background: 'conic-gradient(var(--cab-s1) ' + (cabCover.avail === null ? 0 : cabCover.avail) + '%, var(--cab-surface) 0)'}">
                  <i>{{ cabCover.avail === null ? '-' : cabCover.avail + '%' }}</i>
                </div>
                <div class="lb">近 7 天可用率</div><div class="sb">{{ cabCover.availBase }}</div>
              </div>
              <div class="cab-cov-line">纳管指标 <b>{{ cabCover.metrics }}</b> 项 · 阈值规则 <b>{{ ext.rules.length }}</b> 条</div>
            </div>
          </div>

          <div class="cab-panel cab-d1">
            <div class="cab-h"><b>textfile 业务指标</b><span class="cab-h-sub">{{ bizCards.length }} 项</span>
              <span v-if="showCabMeta" class="cab-meta">{{ cabMeta.d1 }}</span></div>
            <div class="cab-b cab-biz">
              <div v-for="c in bizCards" :key="c.key" class="cab-biz-card" :class="c.cls">
                <div class="k" :title="c.key">{{ c.label }}</div>
                <div class="v">{{ c.value }}<s v-if="c.unit">{{ c.unit }}</s></div>
                <div class="d" :title="c.device">{{ c.device }}</div>
              </div>
              <div v-if="!bizCards.length" class="cab-empty">暂无 textfile 业务指标：目标机 .prom 放入 textfile_inputs 后，下一轮巡检会出现在这里</div>
            </div>
          </div>

          <div v-if="canDashboard" class="cab-panel cab-d2">
            <div class="cab-h"><b>最近事件流水</b><span v-if="showCabMeta" class="cab-meta">{{ cabMeta.d2 }}</span></div>
            <div class="cab-b cab-tl">
              <div v-for="(r,i) in cabRecent" :key="i" class="cab-tl-row">
                <span class="tm">{{ r.at }}</span>
                <span class="tx"><b>{{ r.no }}</b> {{ r.title }} <em>{{ r.who }}</em></span>
              </div>
              <div v-if="!cabRecent.length" class="cab-empty">暂无处理动态，或工作台接口暂不可用</div>
            </div>
          </div>
          <div v-else class="cab-panel cab-d2">
            <div class="cab-h"><b>最近事件流水</b></div>
            <div class="cab-b"><div class="cab-empty">需要「工作台 · 查看」权限，未发起请求</div></div>
          </div>

          <div class="cab-foot">
            <span>口径：设备状态来自最近一轮巡检（每 {{ data.interval }} 秒）· 流量为近 {{ nfMinutes }} 分钟 · 工单为近 30 天 · 合同为近 12 个月</span>
            <span>{{ cabAsOf }} · {{ data.sourceMode ? sourceLabel : '数据源未就绪' }}</span>
          </div>
        </div>
      </div>
    </div>`,

    data() {
      return {
        data: { interval: 60, devices: [], summary: {}, running: false, round: 0 },
        // ---- P1 驾驶舱版：默认值班版，绝不改变既有值班习惯 ----
        screenMode: 'duty',
        palette: 'system',
        showCabMeta: true,
        trendTab: 'flow',
        cockpitTab: 'ip',
        cabModes: CAB_MODES,
        cabPalettes: CAB_PALETTES,
        // 工作台统计：只在驾驶舱版且持有 dashboard.view 时请求；接口 404 走 safeGet 降级
        biz: { ready: false, contracts: {}, issues: {} },
        clock: '--:--:--',
        dateText: '',
        full: false,
        busy: false,
        ui: {},
        // 点「扩展 N 项」打开的只读明细弹窗；存一份快照 + 设备键，轮询回来再对键刷新
        extraDlg: null,
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
        ],
        // ---- P2/P3 扩展区块：历史趋势 + textfile 业务卡 + 阈值告警 ----
        // 与 nf 一样独立降级：任何一个接口 404 / 历史库没准备好，整块一起隐藏。
        ext: {
          ready: false, error: '', editing: false, busy: false,
          catalog: [], latest: { ready: false, roundNo: 0, checkedAt: null, items: [] },
          series: { ready: false, items: [], label: '', labelCn: '', unit: '', min: null, max: null, avg: null, count: 0 },
          ranges: [
            { key: '1h', label: '1 时' }, { key: '6h', label: '6 时' },
            { key: '24h', label: '24 时' }, { key: '7d', label: '7 天' }
          ],
          range: '24h', deviceId: 0, key: 'cpu_percent',
          events: [], rules: [], ruleDraft: {},
          summary: { open: 0, unacked: 0, critical: 0 },
          // 近 7 天可用率：历史库没跑第一轮时 ready:false，C3 显示「-」而不是 0%
          avail: { ready: false, items: [] },
          newRule: { device_id: 0, metric_key: 'cpu_percent', warn: 80, crit: 95 }
        }
      };
    },

    computed: {
      /** 指标下拉的数据源：以后端目录为准，缺失时用内置高频项补齐，绝不返回空数组 */
      metricOptions() {
        const list = (this.ext.catalog || []).slice();
        const seen = new Set(list.map((m) => m.key));
        for (const m of FALLBACK_METRICS) {
          if (!seen.has(m.key)) { list.push(m); seen.add(m.key); }
        }
        return list;
      },
      user() { return window.HisUser ? window.HisUser.user : null; },
      // 大屏是「显示终端」：能不能打开看「监控大屏.查看」，
      // 能显示哪些内容取决于有没有对应模块的查看权限 —— 没有就不请求、不显示，
      // 避免出现"勾了大屏却满屏 403 报错"这种莫名其妙的状态。
      isAdmin() { return !!(window.HisPerm && window.HisPerm.can('inspection.manage')); },
      canOperate() { return !!(window.HisPerm && window.HisPerm.can('inspection.manage')); },
      canInspect() { return !!(window.HisPerm && window.HisPerm.can('inspection.view')); },
      canNetflow() { return !!(window.HisPerm && window.HisPerm.can('netflow.view')); },
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
      },

      /* ---------------- P2/P3：扩展区块 ---------------- */

      extDevices() {
        const fromDash = (this.data.devices || [])
          .filter((d) => d && d.id)
          .map((d) => ({ id: d.id, name: d.name }));
        if (fromDash.length) return fromDash;
        return (this.ext.latest.items || [])
          .filter((d) => d && d.deviceId)
          .map((d) => ({ id: d.deviceId, name: d.name }));
      },
      /** textfile 业务指标卡：同一指标多台设备时取第一台有值的，最多 8 张 */
      bizCards() {
        const out = [];
        const seen = new Set();
        const cat = {};
        for (const m of this.metricOptions) cat[m.key] = m;
        for (const d of (this.ext.latest.items || [])) {
          for (const k of Object.keys(d.metrics || {})) {
            if (k.indexOf('tf.') !== 0 || seen.has(k)) continue;
            if (k.indexOf('tf.his_collector_timestamp') === 0) continue; // 时间戳是技术位，不占卡片
            const v = Number(d.metrics[k]);
            if (!Number.isFinite(v)) continue;
            seen.add(k);
            const meta = cat[k] || {};
            const rule = this.ruleFor(k, d.deviceId);
            let cls = '';
            if (rule) {
              const w = Number(rule.warn), c = Number(rule.crit);
              const down = rule.direction === 'down';
              if (down && Number.isFinite(c) && v < c) cls = 'bad';
              else if (down && Number.isFinite(w) && v < w) cls = 'warn';
              else if (!down && Number.isFinite(c) && v >= c) cls = 'bad';
              else if (!down && Number.isFinite(w) && v >= w) cls = 'warn';
            }
            out.push({ key: k, label: meta.label || k.slice(3), value: v,
              unit: meta.unit || '', device: d.name, cls: cls });
          }
        }
        return out.slice(0, 8);
      },
      currentRule() { return this.ruleFor(this.ext.key, this.ext.deviceId); },
      /** SVG 折线 + min/max 带 + 阈值线。阈值线读规则表，改规则立刻跟着动 */
      chart() {
        const items = (this.ext.series && this.ext.series.items) || [];
        if (items.length < 2) return null;
        const W = 600, H = 180, L = 52, R = 12, T = 12, B = 30;
        const iw = W - L - R, ih = H - T - B;
        let mn = Infinity, mx = -Infinity;
        for (const it of items) {
          mn = Math.min(mn, Number(it.min)); mx = Math.max(mx, Number(it.max));
        }
        if (!Number.isFinite(mn) || !Number.isFinite(mx)) return null;
        const rule = this.currentRule;
        if (rule) {
          for (const v of [Number(rule.warn), Number(rule.crit)]) {
            if (Number.isFinite(v)) { mn = Math.min(mn, v); mx = Math.max(mx, v); }
          }
        }
        if (mx === mn) { mn -= 1; mx += 1; }
        const pad = (mx - mn) * 0.1; mn -= pad; mx += pad;
        const y = (v) => T + ih - (v - mn) / (mx - mn) * ih;
        const x = (i) => L + (items.length === 1 ? iw / 2 : i / (items.length - 1) * iw);
        const line = items.map((it, i) => x(i).toFixed(2) + ',' + y(Number(it.value)).toFixed(2)).join(' ');
        const up = items.map((it, i) => x(i).toFixed(2) + ',' + y(Number(it.max)).toFixed(2));
        const dn = items.slice().reverse().map((it, j) => {
          const i = items.length - 1 - j;
          return x(i).toFixed(2) + ',' + y(Number(it.min)).toFixed(2);
        });
        const grid = [];
        for (let k = 0; k <= 4; k++) {
          const v = mn + (mx - mn) * k / 4;
          grid.push({ y: y(v).toFixed(2), v: Math.round(v * 10) / 10 });
        }
        const xTicks = [];
        for (let k = 0; k <= 4; k++) {
          const idx = Math.round((items.length - 1) * k / 4);
          const d = new Date(items[idx].ts);
          const p = (n) => String(n).padStart(2, '0');
          xTicks.push({
            x: x(idx).toFixed(2),
            label: this.ext.range === '7d'
              ? (d.getMonth() + 1) + '/' + d.getDate()
              : p(d.getHours()) + ':' + p(d.getMinutes())
          });
        }
        const yRule = (v) => (Number.isFinite(v) && v >= mn && v <= mx) ? y(v).toFixed(2) : null;
        return {
          L: L, R: R, grid: grid, xTicks: xTicks, line: line, band: up.concat(dn).join(' '),
          yWarn: rule ? yRule(Number(rule.warn)) : null,
          yCrit: rule ? yRule(Number(rule.crit)) : null
        };
      },

      /* ---------------- P1 驾驶舱版：全部从现有响应式数据派生 ----------------
         不新增后端接口、不新增定时轮询；任何接口 404 / 权限不足都降级成空态，
         整屏绝不白屏（沿用 nf.ready / ext.ready 的既有设计原则）。 */

      canDashboard() { return !!(window.HisPerm && window.HisPerm.can('dashboard.view')); },
      cabAsOf() {
        return this.data.updatedAt ? '数据截至 ' + String(this.data.updatedAt).slice(5, 16)
          : '等待首轮巡检数据';
      },
      cabMeta() {
        return {
          a1: '/api/inspection/status · summary',
          a2: '/api/inspection/status · devices[].os',
          a3: '/api/inspection/status · devices[]',
          b1: '/api/inspection/status · devices[] × status',
          b2: this.cabTrendTab === 'flow' ? '/api/inspection/netflow/trend · netflow.view'
            : (this.cabTrendTab === 'issues'
              ? '/api/dashboard/issues · daily[]' : '/api/dashboard/contracts · monthly[]'),
          c1: '/api/inspection/alerts/events · inspection.view',
          c2: (this.cabTopTab === 'ip' || this.cabTopTab === 'port')
            ? '/api/inspection/netflow/top · netflow.view'
            : (this.cabTopTab === 'alert'
              ? '/api/inspection/alerts/events · inspection.view'
              : '/api/inspection/status · devices[].cpu'),
          c3: '/api/inspection/alerts/summary + availability · inspection.view',
          d1: '/api/inspection/metrics/latest · inspection.view',
          d2: '/api/dashboard/issues · recent[] · dashboard.view'
        };
      },
      cabKpis() {
        const s = this.summary, u = Number((this.ext.summary || {}).unacked) || 0;
        return [
          { k: 'total', label: '设备总数', v: s.total, cls: '', meta: '/api/inspection/status · inspection.view' },
          { k: 'normal', label: '正常', v: s.normal, cls: 'ok', meta: '/api/inspection/status · inspection.view' },
          { k: 'warning', label: '警告', v: s.warning, cls: 'warn', meta: '/api/inspection/status · inspection.view' },
          { k: 'critical', label: '严重', v: s.critical, cls: 'bad', meta: '/api/inspection/status · inspection.view' },
          { k: 'error', label: '巡检失败', v: s.error, cls: 'muted', meta: '/api/inspection/status · inspection.view' },
          { k: 'unacked', label: '未确认告警', v: u, cls: u ? 'bad' : 'ok', meta: '/api/inspection/alerts/summary · inspection.view' }
        ];
      },
      /** 未归类设备兜底成「其他」，保证内环 / 外环 / 中心数字互相自洽 */
      cabGroups() {
        const devs = this.data.devices || [];
        const out = [];
        let grouped = 0;
        GROUPS.forEach((g, i) => {
          const list = devs.filter((d) => g.os.indexOf(d.os) >= 0);
          if (!list.length) return;
          grouped += list.length;
          out.push(cabGroupOf(g.key, g.title, list, 'var(--cab-s' + ((i % 5) + 1) + ')'));
        });
        if (grouped < devs.length) {
          out.push(cabGroupOf('other', '其他', devs.filter((d) =>
            !GROUPS.some((g) => g.os.indexOf(d.os) >= 0)), 'var(--cab-s5)'));
        }
        return out;
      },
      cabStatusRing() {
        const s = this.summary;
        return arcOf([
          { label: '正常', value: s.normal, color: CAB_ST_COLOR.normal },
          { label: '警告', value: s.warning, color: CAB_ST_COLOR.warning },
          { label: '严重', value: s.critical, color: CAB_ST_COLOR.critical },
          { label: '失败', value: s.error, color: CAB_ST_COLOR.error }
        ], 52);
      },
      cabGroupRing() {
        return arcOf(this.cabGroups.map((g) => ({ label: g.title, value: g.total, color: g.color })), 52);
      },
      cabSun() {
        const gs = this.cabGroups;
        const outerRaw = [];
        for (const g of gs) {
          for (const k of ['normal', 'warning', 'critical', 'error']) {
            outerRaw.push({ label: g.title + ' · ' + ST_LABEL[k], value: g.counts[k], color: CAB_ST_COLOR[k] });
          }
        }
        return {
          inner: arcOf(gs.map((g) => ({ label: g.title, value: g.total, color: g.color })), 44),
          outer: arcOf(outerRaw, 72)
        };
      },
      cabStLegend() {
        const s = this.summary;
        return [
          { label: '正常', value: s.normal, color: CAB_ST_COLOR.normal },
          { label: '警告', value: s.warning, color: CAB_ST_COLOR.warning },
          { label: '严重', value: s.critical, color: CAB_ST_COLOR.critical },
          { label: '失败', value: s.error, color: CAB_ST_COLOR.error }
        ];
      },
      /** Tab 只按权限生成：没权限的源连 Tab 都不出现，更不会去请求 */
      cabTrendTabs() {
        const t = [];
        if (this.canNetflow) t.push({ key: 'flow', label: '流量吞吐' });
        if (this.canDashboard) {
          t.push({ key: 'issues', label: '工单趋势' });
          t.push({ key: 'contracts', label: '合同新增' });
        }
        return t;
      },
      /** 不在 computed 里写 this.trendTab（渲染期改响应式数据会触发二次更新）。
          派生「当前实际生效的 Tab」，用户切换时由 setTrendTab 校验后写入。 */
      cabTrendTab() {
        const keys = this.cabTrendTabs.map((t) => t.key);
        return keys.indexOf(this.trendTab) >= 0 ? this.trendTab : (keys[0] || 'flow');
      },
      cabTopTabs() {
        const t = [];
        if (this.canNetflow) {
          t.push({ key: 'ip', label: '流量 IP' });
          t.push({ key: 'port', label: '流量端口' });
        }
        if (this.canInspect) {
          t.push({ key: 'load', label: '高负载设备' });
          t.push({ key: 'alert', label: '告警设备' });
        }
        return t;
      },
      cabTopTab() {
        const keys = this.cabTopTabs.map((t) => t.key);
        return keys.indexOf(this.cockpitTab) >= 0 ? this.cockpitTab : (keys[0] || 'load');
      },
      /** 堆叠柱：三个数据源统一成 {bars,grid,axis,source,empty}，模板不做分支 */
      cabTrend() {
        const tab = this.cabTrendTab;
        let raw = [], source = '', empty = '暂无数据';
        if (tab === 'flow') {
          raw = (this.nf.trend || []).slice(-12).map((it) => ({
            label: String(it.at || '').slice(11, 16),
            parts: [
              { v: Number(it.inBps) || 0, color: 'var(--cab-info)' },
              { v: Number(it.outBps) || 0, color: 'var(--cab-s1)' }
            ]
          }));
          source = '/api/inspection/netflow/trend · 入站 / 出站 · 近 ' + this.nfMinutes + ' 分钟';
          empty = this.nf.error ? '流量数据不可用：' + this.nf.error : '还没有流量样本（每 5 分钟一轮）';
        } else if (tab === 'issues') {
          raw = (((this.biz.issues || {}).daily) || []).slice(-14).map((d) => ({
            label: String(d.d || '').slice(5),
            parts: [{ v: Number(d.c) || 0, color: 'var(--cab-s2)' }]
          }));
          source = '/api/dashboard/issues · 近 30 天每日新增工单';
          empty = '工作台工单统计暂不可用';
        } else {
          raw = (((this.biz.contracts || {}).monthly) || []).slice(-12).map((m) => ({
            label: String(m.ym || '').slice(2),
            parts: [{ v: Number(m.c) || 0, color: 'var(--cab-s3)' }]
          }));
          source = '/api/dashboard/contracts · 近 12 个月新增合同';
          empty = '工作台合同统计暂不可用';
        }
        const W = 560, H = 150, L = 38, R = 8, T = 8, B = 20;
        let max = 0;
        for (const r of raw) {
          let sum = 0;
          for (const p of r.parts) sum += Math.max(0, p.v);
          max = Math.max(max, sum);
        }
        if (max <= 0) return { bars: [], grid: [], axis: [], source: source, empty: empty };
        const ih = H - T - B, iw = W - L - R;
        const step = iw / Math.max(1, raw.length);
        const bw = Math.max(6, Math.min(30, step * 0.62));
        const bars = raw.map((r, i) => {
          let acc = 0;
          const parts = r.parts.map((p) => {
            const h = Math.max(0, p.v) / max * ih;
            const row = { y: +(T + ih - acc - h).toFixed(2), h: +h.toFixed(2), color: p.color };
            acc += h;
            return row;
          });
          return {
            x: +(L + step * i + (step - bw) / 2).toFixed(2), w: +bw.toFixed(2),
            label: r.label, parts: parts
          };
        });
        const grid = [T, T + ih / 2, T + ih].map((n) => +n.toFixed(2));
        return { bars: bars, grid: grid, axis: [String(Math.round(max)), String(Math.round(max / 2)), '0'],
          source: source, empty: empty };
      },
      /** 参考图 4 个重复 TOP10 → 一个 Tab 榜：流量 IP / 端口 / 高负载 / 告警 */
      cabTopRows() {
        const tab = this.cabTopTab;
        let rows = [];
        if (tab === 'ip' || tab === 'port') {
          const src = (tab === 'ip' ? this.nf.topIp : this.nf.topPort) || [];
          let max = 0;
          for (const r of src) max = Math.max(max, Number(r.peakBps) || 0);
          rows = src.slice(0, 6).map((r) => ({
            label: r.ip || (r.ipCount > 1 ? r.ipCount + ' 个终端' : r.iface),
            value: r.peakText || this.nfFmt(r.peakBps),
            w: Math.max(3, Math.round((Number(r.peakBps) || 0) / (max || 1) * 100))
          }));
        } else if (tab === 'load') {
          const list = (this.data.devices || [])
            .filter((d) => d.status !== 'error' && typeof d.cpu === 'number' && isFinite(d.cpu))
            .sort((a, b) => b.cpu - a.cpu).slice(0, 6);
          const max = list.length ? list[0].cpu : 1;
          rows = list.map((d) => ({ label: d.name, value: this.pct(d.cpu),
            w: Math.max(3, Math.round(d.cpu / (max || 1) * 100)) }));
        } else {
          const list = (this.ext.events || []).slice()
            .sort((a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0)).slice(0, 6);
          const max = list.length ? (Number(list[0].hits) || 1) : 1;
          rows = list.map((e) => ({ label: String(e.message || '').slice(0, 20),
            value: (e.hits || 0) + ' 轮',
            w: Math.max(3, Math.round((Number(e.hits) || 0) / max * 100)) }));
        }
        return rows;
      },
      cabAlerts() {
        return (this.ext.events || []).slice()
          .sort((a, b) => (a.level === 'critical' ? 0 : 1) - (b.level === 'critical' ? 0 : 1))
          .slice(0, 5).map((e) => ({
            id: e.id, level: e.level || 'warning', message: e.message,
            meta: String(e.first_at || '').slice(5, 16) + ' · ' + (e.hits || 0) + ' 轮'
          }));
      },
      cabCover() {
        const s = this.summary, es = this.ext.summary || {};
        const done = s.total ? Math.max(0, Math.round((s.total - s.error) / s.total * 100)) : 0;
        const open = Number(es.open) || 0, unacked = Number(es.unacked) || 0;
        const ack = open ? Math.max(0, Math.round((open - unacked) / open * 100)) : 100;
        const items = (this.ext.avail || {}).items || [];
        let sum = 0, n = 0;
        for (const a of items) {
          const v = Number(a.rate);
          if (Number.isFinite(v)) { sum += v; n++; }
        }
        return {
          done: done, ack: ack, ackBase: open,
          avail: n ? Math.round(sum / n) : null,
          availBase: n ? n + ' 台设备 · 历史库' : '历史库暂无可用率数据',
          metrics: this.metricOptions.length
        };
      },
      cabRecent() {
        return (((this.biz.issues || {}).recent) || []).slice(0, 6).map((r) => ({
          no: r.no || '', title: r.title || r.action || '',
          who: r.operator_name || '—', at: String(r.created_at || '').slice(5, 16)
        }));
      }
    },

    methods: {
      /** 当前指标生效的规则：按设备覆盖优先于全局。
          必须放 methods —— computed 是无参 getter，写成带参方法会在渲染期抛
          "this.ruleFor is not a function"，整块大屏直接白屏。 */
      ruleFor(key, deviceId) {
        const rs = (this.ext.rules || []).filter((r) => r.metric_key === key && r.enabled);
        return rs.find((r) => Number(r.device_id) === Number(deviceId))
          || rs.find((r) => Number(r.device_id) === 0) || null;
      },
      labelOf(s) { return ST_LABEL[s] || s; },
      pct(v) { return (v === null || v === undefined) ? '—' : v + '%'; },

      /* ---------------- 扩展采集明细弹窗 ---------------- */

      extraKey(d) { return String((d && d.name) || '') + '|' + String((d && d.host) || ''); },
      openExtra(d) {
        // 服务没重启时后端还是老版本，status 里没有 extraDetail。点了必须给话，
        // 不能「什么都没发生」—— 值班同事最烦这种无声按钮。
        const detail = (d.extraDetail && d.extraDetail.groups && d.extraDetail.meta) ? d.extraDetail : {
          groups: [{
            title: '暂未取得明细',
            cols: ['项目', '当前值'],
            rows: [
              ['说明', '服务端尚未下发扩展明细：请在部署根应用本次更新包并重启服务，然后 Ctrl+F5 刷新页面'],
              ['本轮摘要', (d.extraHint || []).join(' · ')]
            ]
          }],
          meta: { count: 0, sampledTwice: false, gapMs: null, note: '', hint: d.extraHint || [] }
        };
        this.extraDlg = {
          key: this.extraKey(d), name: d.name, host: d.host, osLabel: d.osLabel || '',
          detail: detail
        };
      },
      closeExtra() { this.extraDlg = null; },
      /** 15 秒轮询回来后，用同一台设备的新一轮数据替换弹窗快照 */
      syncExtraDlg() {
        if (!this.extraDlg) return;
        const key = this.extraDlg.key;
        const d = (this.data.devices || []).find((x) => this.extraKey(x) === key);
        if (!d || !d.extraDetail || !d.extraDetail.groups || !d.extraDetail.meta) return;
        this.extraDlg = Object.assign({}, this.extraDlg, {
          name: d.name, host: d.host, osLabel: d.osLabel || '', detail: d.extraDetail
        });
      },
      onKey(e) { if (e.key === 'Escape' && this.extraDlg) this.closeExtra(); },
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

      /* ---------------- P2/P3：扩展区块取数与交互 ---------------- */

      /** 单个接口失败只让那一块空着，不能让整个扩展区（更不能有整个大屏）消失 */
      async safeGet(url, fallback) {
        try { return await api.get(url); } catch (e) { return fallback; }
      },
      async loadExt() {
        const [cat, lat, ev, sum, rules, av] = await Promise.all([
          this.safeGet('/api/inspection/metrics/catalog', { items: [] }),
          this.safeGet('/api/inspection/metrics/latest', { ready: false, items: [] }),
          this.safeGet('/api/inspection/alerts/events?status=unresolved&limit=50', { items: [] }),
          this.safeGet('/api/inspection/alerts/summary', { open: 0, unacked: 0, critical: 0 }),
          this.safeGet('/api/inspection/alerts/rules', { items: [] }),
          // 驾驶舱 C3 的「近 7 天可用率」：老后端没有这个接口时返回 ready:false，显示「-」
          this.safeGet('/api/inspection/availability?days=7', { ready: false, items: [] })
        ]);
        const catalog = (cat && cat.items) || [];
        const ruleList = (rules && rules.items) || [];
        const draft = {};
        for (const r of ruleList) {
          draft[r.id] = { warn: r.warn, crit: r.crit, consecutive: r.consecutive,
            cooldown_min: r.cooldown_min, enabled: !!r.enabled };
        }
        const devs = (this.data.devices || []).filter((d) => d && d.id);
        if (!this.ext.deviceId && devs.length) this.ext.deviceId = devs[0].id;
        if (!this.ext.newRule.device_id && devs.length) this.ext.newRule.device_id = devs[0].id;
        // 下拉永远不能出现「v-model 的值不在 options 里」：那样 select 会显示成空白框。
        // 目录空 / 服务没重启 / 连到旧后端时，用内置兜底项一并校正当前选中值。
        const merged = catalog.slice();
        const seenKeys = new Set(merged.map((m) => m.key));
        for (const m of FALLBACK_METRICS) {
          if (!seenKeys.has(m.key)) { merged.push(m); seenKeys.add(m.key); }
        }
        if (!merged.some((m) => m.key === this.ext.key)) this.ext.key = merged[0].key;
        if (!merged.some((m) => m.key === this.ext.newRule.metric_key)) {
          this.ext.newRule.metric_key = merged[0].key;
        }
        // 历史库没跑第一轮时整块仍要显示（告诉值班「还没有数据」），不隐藏
        this.ext = Object.assign({}, this.ext, {
          ready: true, catalog: catalog,
          latest: lat || { ready: false, roundNo: 0, checkedAt: null, items: [] },
          events: (ev && ev.items) || [],
          summary: sum || { open: 0, unacked: 0, critical: 0 },
          rules: ruleList, ruleDraft: draft,
          avail: av || { ready: false, items: [] }
        });
        await this.loadSeries();
      },
      async loadSeries() {
        if (!this.ext.deviceId || !this.ext.key) return;
        try {
          this.ext.series = await api.get('/api/inspection/series?deviceId=' + this.ext.deviceId
            + '&key=' + encodeURIComponent(this.ext.key) + '&range=' + this.ext.range);
        } catch (e) {
          this.ext.series = { ready: false, items: [], label: '', unit: '',
            min: null, max: null, avg: null, count: 0, error: (e && e.message) || String(e) };
        }
      },
      setExtRange(k) { this.ext.range = k; this.loadSeries(); },
      async ackEvent(id) {
        try {
          await api.post('/api/inspection/alerts/events/' + id + '/ack', {});
          this.$toast && this.$toast('已确认', 'ok');
          await this.loadExt();
        } catch (e) { this.$toast && this.$toast('确认失败：' + e.message, 'err'); }
      },
      async saveRule(r) {
        const d = this.ext.ruleDraft[r.id];
        if (!d) return;
        const body = Object.assign({}, r, {
          warn: d.warn, crit: d.crit, consecutive: d.consecutive,
          cooldown_min: d.cooldown_min, enabled: d.enabled ? 1 : 0
        });
        try {
          await api.post('/api/inspection/alerts/rules', body);
          this.$toast && this.$toast('规则已保存，阈值线已更新', 'ok');
          await this.loadExt();
        } catch (e) { this.$toast && this.$toast('保存失败：' + e.message, 'err'); }
      },
      async delRule(r) {
        try {
          await api.del('/api/inspection/alerts/rules/' + r.id);
          this.$toast && this.$toast('覆盖规则已删除，恢复使用全局值', 'ok');
          await this.loadExt();
        } catch (e) { this.$toast && this.$toast('删除失败：' + e.message, 'err'); }
      },
      async addOverride() {
        const n = this.ext.newRule;
        if (!n.device_id || !n.metric_key) return;
        const meta = this.metricOptions.find((m) => m.key === n.metric_key) || {};
        const base = (this.ext.rules || []).find((r) => r.metric_key === n.metric_key && !r.device_id) || {};
        const body = {
          metric_key: n.metric_key, device_id: n.device_id,
          label: meta.label || '', unit: meta.unit || '',
          direction: base.direction || 'up', mode: base.mode || 'value',
          warn: n.warn, crit: n.crit,
          consecutive: base.consecutive || 1, cooldown_min: base.cooldown_min || 30, enabled: 1
        };
        try {
          await api.post('/api/inspection/alerts/rules', body);
          this.$toast && this.$toast('已添加按设备覆盖', 'ok');
          await this.loadExt();
        } catch (e) { this.$toast && this.$toast('添加失败：' + e.message, 'err'); }
      },

      refreshAll() {
        if (this.canInspect) this.load();
        if (this.canNetflow) this.loadNetflow();
        if (this.canInspect) this.loadExt();
        if (this.screenMode === 'cockpit') this.loadBiz();
      },

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
          this.syncExtraDlg();
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
      onFsChange() { this.full = !!document.fullscreenElement; },

      /* ---------------- P1 驾驶舱版：偏好 / Tab / 业务取数 ---------------- */

      /** 照抄 saveNfPref 的 try/catch：隐私模式下 localStorage 不可写不能让大屏挂掉 */
      saveScreenPref() {
        try {
          localStorage.setItem('his_scr_mode', JSON.stringify({
            mode: this.screenMode, palette: this.palette, meta: this.showCabMeta
          }));
        } catch (e) { /* 退回默认值即可 */ }
      },
      loadScreenPref() {
        try {
          const o = JSON.parse(localStorage.getItem('his_scr_mode') || '{}') || {};
          if (['duty', 'cockpit'].indexOf(o.mode) >= 0) this.screenMode = o.mode;
          if (['system', 'ref'].indexOf(o.palette) >= 0) this.palette = o.palette;
          if (typeof o.meta === 'boolean') this.showCabMeta = o.meta;
        } catch (e) { /* 配置坏了就退回默认值班版 */ }
      },
      /** ?mode=cockpit 给预览页 / 投屏预案用：只临时覆盖，不写回偏好。
          同时认 location.search 与 hash 里的查询串（main.js 是 hash 路由）。 */
      applyScreenOverride() {
        const read = (s) => {
          try { return new URLSearchParams(s); } catch (e) { return null; }
        };
        const h = String(location.hash || '');
        const hq = h.indexOf('?') >= 0 ? read(h.slice(h.indexOf('?') + 1)) : null;
        const q = read(String(location.search || ''));
        const m = (hq && hq.get('mode')) || (q && q.get('mode'));
        if (m === 'cockpit' || m === 'duty') this.screenMode = m;
        const p = (hq && hq.get('palette')) || (q && q.get('palette'));
        if (p === 'ref' || p === 'system') this.palette = p;
      },
      setScreenMode(k) {
        if (['duty', 'cockpit'].indexOf(k) < 0) return;
        this.screenMode = k;
        this.saveScreenPref();
        if (k === 'cockpit') this.loadBiz();
      },
      setPalette(k) {
        if (['system', 'ref'].indexOf(k) >= 0) { this.palette = k; this.saveScreenPref(); }
      },
      toggleCabMeta() { this.showCabMeta = !this.showCabMeta; this.saveScreenPref(); },
      setTrendTab(k) { if (this.cabTrendTabs.some((t) => t.key === k)) this.trendTab = k; },
      setTopTab(k) { if (this.cabTopTabs.some((t) => t.key === k)) this.cockpitTab = k; },
      /** 只在驾驶舱版 + 有 dashboard.view 时才真的发请求；任一接口 404 只让对应面板空着。
          不新增后端接口，也不新增服务重启的需求。 */
      async loadBiz() {
        if (this.screenMode !== 'cockpit' || !this.canDashboard) return;
        const [c, i] = await Promise.all([
          this.safeGet('/api/dashboard/contracts', null),
          this.safeGet('/api/dashboard/issues', null)
        ]);
        this.biz = { ready: !!(c || i), contracts: c || {}, issues: i || {} };
      }
    },

    mounted() {
      this.ensureUi();
      this.loadNfPref();
      // 版式偏好默认值班版；?mode=cockpit 只临时覆盖（预览页 / 投屏预案），不写回偏好
      this.loadScreenPref();
      this.applyScreenOverride();
      this.tick();
      // 没有对应权限的接口一律不请求：既不会刷出一堆 403 提示，也少两次无用请求
      if (this.canInspect) {
        this.load();
        this._p = setInterval(this.load, 15000);
        // 历史趋势按轮次落库（默认 60 秒一轮），1 分钟跟一次足够，别跟着 15 秒空转
        this.loadExt();
        this._e = setInterval(this.loadExt, 60000);
      }
      if (this.canNetflow) {
        this.loadNetflow();
        // 流量 5 分钟才采一轮，跟着 15 秒轮询纯属浪费；60 秒足够跟上手工触发的采集
        this._n = setInterval(this.loadNetflow, 60000);
      }
      // 工作台统计只给驾驶舱版用。定时器常驻、loadBiz 内部按版式与权限短路，
      // 值班版只是空转一次 return，换来切版式时不必管定时器生命周期。
      if (this.canDashboard) {
        this.loadBiz();
        this._b = setInterval(this.loadBiz, 60000);
      }
      this._t = setInterval(this.tick, 1000);
      document.addEventListener('fullscreenchange', this.onFsChange);
      document.addEventListener('keydown', this.onKey);
    },

    beforeUnmount() {
      clearInterval(this._t);
      clearInterval(this._p);
      clearInterval(this._n);
      clearInterval(this._e);
      clearInterval(this._b);
      document.removeEventListener('fullscreenchange', this.onFsChange);
      document.removeEventListener('keydown', this.onKey);
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
                    <button class="btn btn-ghost btn-sm" @click="exportPdf(r)" :disabled="!!printing"
                            title="打开打印对话框，目标选择「另存为 PDF」">{{ printing === r.name ? '准备中…' : '导出PDF' }}</button>
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
        printing: '',   // 正在准备导出的报告名（空 = 空闲），用于禁用按钮防重复点击
        pv: { open: false, name: '', url: '' },
        gen: { busy: false, logs: [], taskId: '', elapsed: 0, timer: null, poll: null }
      };
    },

    computed: {
      user() { return window.HisUser ? window.HisUser.user : null; },
      // 生成报告属于巡检的写操作 → 巡检报告.管理
      canOperate() { return !!(window.HisPerm && window.HisPerm.can('inspection.manage')); },
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
      /**
       * 导出 PDF：服务端把报告补成「打印友好版」，再借浏览器自带的「打印 → 另存为 PDF」出成品。
       *
       * 为什么不在服务端直接生成 PDF：中文字体动辄 10MB 起步，还得做子集化；内网这台机器也不保证
       * 装了 LibreOffice / wkhtmltopdf。浏览器自带的 PDF 引擎本来就在客户端，打印样式还完全可控。
       *
       * 为什么绕一层隐藏 iframe 而不是 window.open：
       *   · 报告接口要 Bearer，新窗口带不上 token，只会拿到 401；
       *   · iframe 装 blob 是同源的，可以直接调 contentWindow.print()，也不会把当前页顶掉。
       *
       * ★ 隐藏 iframe 必须给真实尺寸（哪怕移出视口），不能用 display:none ——
       *   不参与布局的文档在 Chrome 里打印出来是空白页。
       */
      async exportPdf(item) {
        if (this.printing) return;
        this.printing = item.name;
        let fr = null;
        let objUrl = '';
        const cleanup = () => {
          if (objUrl) { URL.revokeObjectURL(objUrl); objUrl = ''; }
          if (fr && fr.parentNode) fr.parentNode.removeChild(fr);
          fr = null;
          this.printing = '';
        };
        try {
          const token = localStorage.getItem('his_token') || '';
          const url = '/api/inspection/reports/' + encodeURIComponent(item.name) + '/print';
          const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
          if (!res.ok) {
            let m = '获取打印版失败（HTTP ' + res.status + '）';
            try { const j = await res.json(); if (j && j.message) m = j.message; } catch (e) {}
            throw new Error(m);
          }
          const html = await res.text();
          objUrl = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));

          const old = document.getElementById('__rep_print_frame');
          if (old) old.parentNode.removeChild(old);

          fr = document.createElement('iframe');
          fr.id = '__rep_print_frame';
          fr.style.cssText = 'position:fixed;left:-9999px;top:0;width:820px;height:1160px;border:0;opacity:0;pointer-events:none;';
          fr.src = objUrl;
          document.body.appendChild(fr);

          await new Promise((resolve, reject) => {
            const to = setTimeout(() => reject(new Error('加载打印版超时，请重试')), 20000);
            fr.onload = () => { clearTimeout(to); resolve(); };
            fr.onerror = () => { clearTimeout(to); reject(new Error('加载打印版失败，请重试')); };
          });
          // 报告里的注入脚本会在 load 后展开折叠卡片，等它跑完再调 print，
          // 否则打印出来的只有标题没有数据
          await new Promise((r) => setTimeout(r, 350));

          const win = fr.contentWindow;
          if (!win || typeof win.print !== 'function') throw new Error('当前浏览器不支持直接打印，请先「预览」后按 Ctrl+P');
          win.addEventListener('afterprint', cleanup, { once: true });
          win.focus();
          win.print();
          // Chrome/Edge 的 print() 会阻塞到对话框关闭才返回，此时任务是安全的；
          // 个别浏览器立即返回，则靠上面的 afterprint 兜底回收。给 3 秒缓冲再清。
          setTimeout(cleanup, 3000);
        } catch (e) {
          this.$toast && this.$toast(e.message, 'err');
          cleanup();
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
