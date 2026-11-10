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

      <div v-if="canInspect && alertItems.length" class="scr-alert">
        <div v-for="(a,i) in alertItems" :key="i">{{ a }}</div>
      </div>

      <div v-if="!canInspect" class="scr-alert">
        <div>当前角色未被分配「巡检报告 · 查看」权限，大屏不显示巡检数据{{ canNetflow ? '，仅显示流量部分' : '' }}。需要查看请让管理员在【系统管理 → 角色权限】中勾选。</div>
      </div>

      <div v-if="canInspect" class="scr-stats">
        <div class="scr-stat t"><div class="num">{{ summary.total }}</div><div class="lbl">设备总数</div></div>
        <div class="scr-stat n"><div class="num">{{ summary.normal }}</div><div class="lbl">正常</div></div>
        <div class="scr-stat w"><div class="num">{{ summary.warning }}</div><div class="lbl">警告</div></div>
        <div class="scr-stat c"><div class="num">{{ summary.critical }}</div><div class="lbl">严重</div></div>
        <div class="scr-stat e"><div class="num">{{ summary.error }}</div><div class="lbl">失败</div></div>
      </div>

      <!-- P2/P3 扩展区块：按定稿插在统计卡正下方，下面的设备分区与流量监控顺序一律不动。
           ext.ready 为 false 时整块隐藏 —— 历史库不可用、接口 404（服务没重启）都不能让大屏白屏。 -->
      <div v-if="canInspect && ext.ready" class="sx-wrap">
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
        const [cat, lat, ev, sum, rules] = await Promise.all([
          this.safeGet('/api/inspection/metrics/catalog', { items: [] }),
          this.safeGet('/api/inspection/metrics/latest', { ready: false, items: [] }),
          this.safeGet('/api/inspection/alerts/events?status=unresolved&limit=50', { items: [] }),
          this.safeGet('/api/inspection/alerts/summary', { open: 0, unacked: 0, critical: 0 }),
          this.safeGet('/api/inspection/alerts/rules', { items: [] })
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
          rules: ruleList, ruleDraft: draft
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
      this._t = setInterval(this.tick, 1000);
      document.addEventListener('fullscreenchange', this.onFsChange);
    },

    beforeUnmount() {
      clearInterval(this._t);
      clearInterval(this._p);
      clearInterval(this._n);
      clearInterval(this._e);
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
