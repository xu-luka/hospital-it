'use strict';
/**
 * HTML 报告生成器：把巡检结果渲染为带汇总统计与筛选功能的单文件 HTML 报告
 */

const { escapeHtml, LEVEL_LABEL, formatUptime, formatMB, levelOf, levelRank, worst, round1, truncate } = require('./common');
const { levelOfHealth } = require('./bmc');

const CSS = `
:root { --bg:#f5f7fa; --card:#ffffff; --line:#e5e9f0; --text:#1f2937; --muted:#6b7280; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:"Segoe UI","Microsoft YaHei",Arial,sans-serif; background:var(--bg); color:var(--text); padding:24px; }
.wrap { max-width:1200px; margin:0 auto; }
h1 { font-size:22px; margin-bottom:4px; }
.meta { color:var(--muted); font-size:13px; margin-bottom:18px; }
.summary { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:12px; margin-bottom:20px; }
.stat { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
.stat .num { font-size:26px; font-weight:700; }
.stat .lbl { font-size:12px; color:var(--muted); margin-top:2px; }
.filters { margin:0 0 16px; display:flex; gap:8px; flex-wrap:wrap; }
.filters button { border:1px solid var(--line); background:var(--card); border-radius:6px; padding:6px 12px; font-size:13px; cursor:pointer; }
.filters button.active { background:#2563eb; color:#fff; border-color:#2563eb; }
.badge { display:inline-block; min-width:64px; text-align:center; border-radius:4px; padding:3px 10px; font-size:12px; font-weight:600; color:#fff; }
.b-normal{background:#16a34a}.b-warning{background:#d97706}.b-critical{background:#dc2626}.b-error{background:#6b7280}
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; margin-bottom:16px; overflow:hidden; }
.card-head { display:flex; justify-content:space-between; align-items:center; padding:14px 18px; cursor:pointer; gap:12px; }
.card-head:hover { background:#f9fafb; }
.card-head .title { font-size:16px; font-weight:600; }
.card-head .sub { font-size:12px; color:var(--muted); margin-top:2px; }
.card-body { padding:0 18px 18px; display:none; }
.card.open .card-body { display:block; }
.card.open .arrow { transform:rotate(90deg); }
.arrow { transition:transform .15s; color:var(--muted); }
.kv { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:10px; margin-bottom:16px; }
.kv .item { background:#f9fafb; border-radius:8px; padding:10px 12px; }
.kv .k { font-size:12px; color:var(--muted); }
.kv .v { font-size:15px; font-weight:600; margin-top:2px; word-break:break-all; }
table { width:100%; border-collapse:collapse; font-size:13px; margin-top:8px; }
th,td { border:1px solid var(--line); padding:7px 10px; text-align:left; vertical-align:top; }
th { background:#f3f4f6; font-weight:600; white-space:nowrap; }
.bar { background:#e5e7eb; border-radius:4px; height:10px; min-width:80px; overflow:hidden; }
.bar > i { display:block; height:100%; border-radius:4px; }
.sec-title { font-size:14px; font-weight:600; margin:14px 0 6px; }
pre { background:#0f172a; color:#e2e8f0; border-radius:6px; padding:10px; font-size:12px; overflow-x:auto; white-space:pre-wrap; word-break:break-all; max-height:220px; }
.errmsg { color:#dc2626; font-size:13px; margin-top:6px; white-space:pre-wrap; }
.notemsg { color:#92400e; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; font-size:13px; margin-bottom:12px; }
`;

function barHtml(pct, level) {
  const color = level === 'critical' ? '#dc2626' : level === 'warning' ? '#d97706' : '#16a34a';
  const w = Math.max(0, Math.min(100, pct || 0));
  return `<div class="bar"><i style="width:${w}%;background:${color}"></i></div>`;
}

function pctCell(value, unit, warn, crit) {
  if (value === null || value === undefined) return '<td>—</td>';
  const lv = levelOf(value, warn, crit);
  return `<td><span class="badge b-${lv}" style="min-width:44px">${value}${unit}</span></td>`;
}

/** 渲染管理口硬件巡检卡片 */
function renderBmcCard(r) {
  const hw = r.hw || {};
  const healthBadge = (h) => {
    if (!h) return '<span style="color:var(--muted)">—</span>';
    const lv = levelOfHealth(h);
    const zh = { OK: '正常', Warning: '警告', Degraded: '降级', Critical: '严重', Fatal: '致命', PreFail: '预故障' }[h] || h;
    return `<span class="badge b-${lv}">${escapeHtml(zh)}</span>`;
  };
  const kv = `
  <div class="kv">
    <div class="item"><div class="k">电源状态</div><div class="v">${escapeHtml(hw.power || '—')}</div></div>
    <div class="item"><div class="k">厂商 / 型号</div><div class="v">${escapeHtml((hw.manufacturer + ' ' + hw.model).trim() || '—')}</div></div>
    <div class="item"><div class="k">BIOS 版本</div><div class="v">${escapeHtml(hw.bios || '—')}</div></div>
    <div class="item"><div class="k">序列号</div><div class="v">${escapeHtml(hw.serial || '—')}</div></div>
    <div class="item"><div class="k">CPU</div><div class="v">${hw.cpu_count === null || hw.cpu_count === undefined ? '—' : hw.cpu_count + ' 颗'} ${healthBadge(hw.cpu_health)}</div></div>
    <div class="item"><div class="k">内存</div><div class="v">${hw.mem_gib ? hw.mem_gib + ' GiB' : '—'} ${healthBadge(hw.mem_health)}</div></div>
    <div class="item"><div class="k">整机健康</div><div class="v">${healthBadge(hw.system_health)}</div></div>
  </div>`;
  const tempRows = (hw.temps || []).map((x) =>
    `<tr><td>${escapeHtml(x.name)}</td><td>${x.reading === null || x.reading === undefined ? '—' : x.reading + ' ℃'}</td><td>${healthBadge(x.health)}</td></tr>`).join('');
  const tempTable = tempRows ? `
    <div class="sec-title">温度</div>
    <table><thead><tr><th>传感器</th><th>读数</th><th>健康</th></tr></thead><tbody>${tempRows}</tbody></table>` : '';
  const fanRows = (hw.fans || []).map((x) =>
    `<tr><td>${escapeHtml(x.name)}</td><td>${x.reading === null || x.reading === undefined ? '—' : x.reading}</td><td>${healthBadge(x.health)}</td></tr>`).join('');
  const fanTable = fanRows ? `
    <div class="sec-title">风扇</div>
    <table><thead><tr><th>风扇</th><th>转速</th><th>健康</th></tr></thead><tbody>${fanRows}</tbody></table>` : '';
  const psuRows = (hw.psus || []).map((x) =>
    `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(x.state || '—')}</td><td>${healthBadge(x.health)}</td></tr>`).join('');
  const psuTable = psuRows ? `
    <div class="sec-title">电源模块</div>
    <table><thead><tr><th>电源</th><th>状态</th><th>健康</th></tr></thead><tbody>${psuRows}</tbody></table>` : '';
  const driveRows = (hw.drives || []).map((x) => {
    const media = x.media_type ? escapeHtml(x.media_type + (x.rpm ? ' ' + x.rpm + 'rpm' : '')) : '—';
    const life = x.life_left === null || x.life_left === undefined ? '—' : x.life_left + '%';
    const lifeLv = x.life_left === null || x.life_left === undefined ? null : (x.life_left <= 10 ? 'critical' : x.life_left <= 25 ? 'warning' : 'normal');
    const modelTxt = ((x.manufacturer ? x.manufacturer + ' ' : '') + (x.model || '')).trim() || '—';
    return `<tr><td>${escapeHtml(x.name)}</td><td>${escapeHtml(modelTxt)}</td><td>${escapeHtml(x.serial || '—')}</td><td>${media}</td><td>${escapeHtml(x.capacity || '—')}</td><td>${lifeLv ? '<span class="badge b-' + lifeLv + '">' + life + '</span>' : life}</td><td>${healthBadge(x.health)}</td></tr>`;
  }).join('');
  const driveTable = driveRows ? `
    <div class="sec-title">磁盘健康监测</div>
    <table><thead><tr><th>磁盘</th><th>型号</th><th>序列号</th><th>介质类型</th><th>容量</th><th>SSD剩余寿命</th><th>健康</th></tr></thead><tbody>${driveRows}</tbody></table>` : '';
  const eventRows = (hw.events || []).map((x) =>
    `<tr><td>${escapeHtml(x.time)}</td><td>${escapeHtml(x.severity)}</td><td>${escapeHtml(x.message)}</td></tr>`).join('');
  const eventTable = eventRows ? `
    <div class="sec-title">最近硬件事件日志</div>
    <table><thead><tr><th>时间</th><th>级别</th><th>信息</th></tr></thead><tbody>${eventRows}</tbody></table>` : '';
  return `<div class="card-body">${kv}${tempTable}${fanTable}${psuTable}${driveTable}${eventTable}</div>`;
}

/** 渲染交换机巡检卡片：设备概要 + 量化指标表 + 各命令原始输出 */
function renderSwitchCard(r, t) {
  const th = t || DEFAULT_THRESHOLDS;
  const hw = r.hw || {};
  const m = r.metrics || {};
  const kv = `
  <div class="kv">
    <div class="item"><div class="k">命令风格</div><div class="v">${escapeHtml(hw.vendor_hint || '—')}</div></div>
    <div class="item"><div class="k">设备型号</div><div class="v">${escapeHtml(hw.model || '见版本输出')}</div></div>
    <div class="item"><div class="k">软件版本</div><div class="v">${escapeHtml(hw.software || '见版本输出')}</div></div>
    <div class="item"><div class="k">运行时长</div><div class="v">${escapeHtml(hw.uptime || '见版本输出')}</div></div>
  </div>`;

  const cpuRow = (m.cpu_percent === null || m.cpu_percent === undefined)
    ? '<tr><td>CPU 使用率</td><td>—</td><td>—</td></tr>'
    : `<tr><td>CPU 使用率</td>${pctCell(m.cpu_percent, '%', th.cpu_percent_warn, th.cpu_percent_critical)}<td>${barHtml(m.cpu_percent, levelOf(m.cpu_percent, th.cpu_percent_warn, th.cpu_percent_critical))}</td></tr>`;
  const memRow = (m.mem_percent === null || m.mem_percent === undefined)
    ? '<tr><td>内存使用率</td><td>—</td><td>—</td></tr>'
    : `<tr><td>内存使用率</td>${pctCell(m.mem_percent, '%', th.memory_percent_warn, th.memory_percent_critical)}<td>${barHtml(m.mem_percent, levelOf(m.mem_percent, th.memory_percent_warn, th.memory_percent_critical))}</td></tr>`;
  const ports = m.ports || hw.ports || {};
  const portCell = (ports.total === null || ports.total === undefined)
    ? '<td>—</td><td>—</td>'
    : `<td>${ports.up} / ${ports.down}（共 ${ports.total}）</td><td>${ports.errors > 0 ? '<span class="badge b-warning">错包 ' + ports.errors + '</span>' : '无错包'}</td>`;
  const portRow = `<tr><td>端口 Up/Down</td>${portCell}</tr>`;
  const temps = m.temps || hw.temps || [];
  const tempRows = temps.length
    ? temps.map((tp) => `<tr><td>${escapeHtml(tp.label || '传感器')}</td>${pctCell(tp.c, '℃', th.switch_temp_warn, th.switch_temp_critical)}<td>${barHtml(tp.c, levelOf(tp.c, th.switch_temp_warn, th.switch_temp_critical))}</td></tr>`).join('')
    : '<tr><td>温度</td><td>—</td><td>—</td></tr>';
  const metricsTable = `
  <div class="sec-title">量化指标</div>
  <table><thead><tr><th>指标</th><th>数值</th><th>趋势</th></tr></thead>
  <tbody>${cpuRow}${memRow}${portRow}${tempRows}</tbody></table>`;

  const blocks = (r.sections || []).map((s) => `
    <div class="sec-title">${escapeHtml(s.title)}（${escapeHtml(s.cmd)}）</div>
    <pre>${escapeHtml(s.out || '(无输出)')}</pre>`).join('');
  return `<div class="card-body">${kv}${metricsTable}${blocks}</div>`;
}

/** 渲染数据库巡检卡片 */
function renderDbCard(r, t) {
  const db = r.db || {};
  const connPct = (db.conn_max && db.conn_total !== null && db.conn_total !== undefined)
    ? round1(db.conn_total * 100 / db.conn_max) : null;
  const connLv = connPct === null ? null : levelOf(connPct, t.db_conn_percent_warn, t.db_conn_percent_critical);
  const kv = `
  <div class="kv">
    <div class="item"><div class="k">数据库类型</div><div class="v">${escapeHtml(db.engineLabel || '—')}</div></div>
    ${db.instance ? `<div class="item"><div class="k">实例名</div><div class="v">${escapeHtml(db.instance)}</div></div>` : ''}
    <div class="item"><div class="k">版本</div><div class="v">${escapeHtml(truncate(db.version || '—', 60))}</div></div>
    <div class="item"><div class="k">运行时长</div><div class="v">${formatUptime(db.uptime_sec)}</div></div>
    <div class="item"><div class="k">会话连接</div><div class="v">${db.conn_total === null || db.conn_total === undefined ? '—' : db.conn_total + (db.conn_max ? ' / ' + db.conn_max : '') + (connPct === null ? '' : ' (' + connPct + '%)')}</div></div>
    ${db.conn_active !== null && db.conn_active !== undefined ? `<div class="item"><div class="k">活跃会话</div><div class="v">${db.conn_active}</div></div>` : ''}
    ${db.blocked !== null && db.blocked !== undefined ? `<div class="item"><div class="k">阻塞会话</div><div class="v" style="${db.blocked > 0 ? 'color:#dc2626;font-weight:600' : ''}">${db.blocked}</div></div>` : ''}
    ${db.tdsVersion ? `<div class="item"><div class="k">TDS 协议</div><div class="v">${escapeHtml(db.tdsVersion)}</div></div>` : ''}
  </div>`;

  const perfTable = connPct === null ? '' : `
    <div class="sec-title">连接数使用率</div>
    <table><thead><tr><th>指标</th><th>当前值</th><th style="min-width:120px">图示</th><th>警告线</th><th>严重线</th></tr></thead>
    <tbody><tr><td>会话连接</td>${pctCell(connPct, '%', t.db_conn_percent_warn, t.db_conn_percent_critical)}<td>${barHtml(connPct, connLv)}</td><td>${t.db_conn_percent_warn}%</td><td>${t.db_conn_percent_critical}%</td></tr></tbody></table>`;

  // SQL Server：数据库列表
  let dbTable = '';
  if (db.databases && db.databases.length) {
    const rows = db.databases.map((d) => {
      const logLv = d.log_used_pct === null || d.log_used_pct === undefined ? null : levelOf(d.log_used_pct, t.db_space_percent_warn, t.db_space_percent_critical);
      return `<tr><td>${escapeHtml(d.name)}</td><td>${formatMB(d.size_mb)}</td>${pctCell(d.log_used_pct, '%', t.db_space_percent_warn, t.db_space_percent_critical)}<td>${d.log_used_pct === null || d.log_used_pct === undefined ? '—' : barHtml(d.log_used_pct, logLv)}</td></tr>`;
    }).join('');
    dbTable = `
    <div class="sec-title">数据库与日志使用率</div>
    <table><thead><tr><th>数据库</th><th>数据大小</th><th>日志使用率</th><th style="min-width:100px">图示</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  }
  // Oracle：表空间
  let tsTable = '';
  if (db.tablespaces && db.tablespaces.length) {
    const rows = db.tablespaces.map((d) => {
      const lv = levelOf(d.use_pct, t.db_space_percent_warn, t.db_space_percent_critical);
      return `<tr><td>${escapeHtml(d.name)}</td><td>${formatMB(d.size_mb)}</td><td>${formatMB(d.used_mb)}</td>${pctCell(d.use_pct, '%', t.db_space_percent_warn, t.db_space_percent_critical)}<td>${barHtml(d.use_pct, lv)}</td></tr>`;
    }).join('');
    tsTable = `
    <div class="sec-title">表空间使用率</div>
    <table><thead><tr><th>表空间</th><th>总大小</th><th>已用</th><th>使用率</th><th style="min-width:100px">图示</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  } else if (db.engine === 'oracle') {
    tsTable = '<div class="sec-title">表空间</div><div style="color:var(--muted);font-size:13px">未采集到表空间信息（当前账号需具备 DBA 权限，建议授予 SELECT ANY DICTIONARY 或 DBA 角色）</div>';
  }
  // 备份时效 / 缓冲命中率 / 锁等待
  const backupAgeH = (db.last_backup_ms !== null && db.last_backup_ms !== undefined)
    ? (Date.now() - db.last_backup_ms) / 3600000 : null;
  const backupTxt = backupAgeH === null
    ? '—'
    : (backupAgeH >= 48 ? Math.round(backupAgeH / 24) + ' 天前' : Math.round(backupAgeH) + ' 小时前');
  const backupLv = backupAgeH === null ? null : levelOf(backupAgeH, t.db_backup_age_warn_h, t.db_backup_age_critical_h);
  const bufLv = db.buffer_hit_pct === null || db.buffer_hit_pct === undefined ? null
    : (db.buffer_hit_pct < t.db_buffer_hit_critical ? 'critical' : db.buffer_hit_pct < t.db_buffer_hit_warn ? 'warning' : 'normal');
  const lockLv = (db.max_wait_ms && db.max_wait_ms >= t.db_lock_wait_critical_ms) ? 'critical'
    : (db.max_wait_ms && db.max_wait_ms >= t.db_lock_wait_warn_ms) ? 'warning'
      : (db.lock_waiters && db.lock_waiters > 0) ? 'warning' : 'normal';
  const badge = (lv, txt) => lv === null ? '<span style="color:var(--muted)">—</span>'
    : `<span class="badge b-${lv}">${escapeHtml(txt)}</span>`;
  const healthTable = `
    <div class="sec-title">备份 · 缓存 · 锁等待</div>
    <table><thead><tr><th>指标</th><th>数值</th><th>判定</th></tr></thead>
    <tbody>
      <tr><td>最近一次备份</td><td>${backupTxt}</td><td>${badge(backupLv, backupAgeH === null ? '未采集' : (backupLv === 'normal' ? '正常' : (backupLv === 'critical' ? '严重滞后' : '偏久')))}</td></tr>
      <tr><td>缓冲命中率</td><td>${db.buffer_hit_pct === null || db.buffer_hit_pct === undefined ? '—' : db.buffer_hit_pct + '%'}</td><td>${badge(bufLv, bufLv === null ? '未采集' : (bufLv === 'normal' ? '正常' : (bufLv === 'critical' ? '过低' : '偏低')))}</td></tr>
      <tr><td>锁等待会话</td><td>${db.lock_waiters === null || db.lock_waiters === undefined ? '—' : db.lock_waiters + ' 个（最长 ' + (db.max_wait_ms || 0) + ' ms）'}</td><td>${badge(lockLv, lockLv === null ? '未采集' : (lockLv === 'normal' ? '正常' : (lockLv === 'critical' ? '严重阻塞' : '存在等待')))}</td></tr>
    </tbody></table>`;

  return `<div class="card-body">${kv}${perfTable}${healthTable}${dbTable}${tsTable}</div>`;
}

/** 渲染 ESXi 虚拟化平台巡检卡片 */
function renderEsxiCard(r, t) {
  const e = r.esxi || {};
  const cpuLv = levelOf(e.cpuPercent, t.cpu_percent_warn, t.cpu_percent_critical);
  const memLv = levelOf(e.memPercent, t.memory_percent_warn, t.memory_percent_critical);
  const statusZh = { green: '正常', yellow: '警告', red: '严重', gray: '未知', poweredOn: '开机', poweredOff: '关机', connected: '已连接', disconnected: '已断开', notResponding: '无响应' };
  const stBadge = (v) => {
    if (!v) return '<span style="color:var(--muted)">—</span>';
    const lv = v === 'green' || v === 'connected' || v === 'poweredOn' ? 'normal'
      : v === 'yellow' || v === 'disconnected' ? 'warning'
        : v === 'red' || v === 'notResponding' ? 'critical' : 'error';
    return `<span class="badge b-${lv}">${escapeHtml(statusZh[v] || v)}</span>`;
  };

  const cpuInfo = [e.cpuModel, e.cpuSockets ? e.cpuSockets + ' 颗' : '', e.cpuCores ? e.cpuCores + ' 核' : '', e.cpuThreads ? e.cpuThreads + ' 线程' : '', e.cpuMhz ? e.cpuMhz + ' MHz' : '']
    .filter(Boolean).join(' · ') || '—';

  const kv = `
  <div class="kv">
    <div class="item"><div class="k">主机名</div><div class="v">${escapeHtml(e.hostname || '—')}</div></div>
    <div class="item"><div class="k">ESXi 版本</div><div class="v">${escapeHtml((e.version || '') + (e.build ? ' (build ' + e.build + ')' : '')) || '—'}</div></div>
    <div class="item"><div class="k">产品</div><div class="v">${escapeHtml(e.product || '—')}</div></div>
    <div class="item"><div class="k">API 版本</div><div class="v">${escapeHtml(e.apiVersion || '—')}</div></div>
    <div class="item"><div class="k">厂商 / 型号</div><div class="v">${escapeHtml((e.vendor + ' ' + e.model).trim() || '—')}</div></div>
    <div class="item"><div class="k">序列号</div><div class="v">${escapeHtml(e.serial || '—')}</div></div>
    <div class="item"><div class="k">运行时长</div><div class="v">${formatUptime(e.uptimeSec)}</div></div>
    <div class="item"><div class="k">整体状态</div><div class="v">${stBadge(e.overallStatus)}</div></div>
    <div class="item"><div class="k">连接状态</div><div class="v">${stBadge(e.connectionState)}</div></div>
    <div class="item"><div class="k">电源状态</div><div class="v">${stBadge(e.powerState)}</div></div>
    <div class="item"><div class="k">维护模式</div><div class="v">${e.maintenanceMode ? '<span class="badge b-warning">已启用</span>' : '未启用'}</div></div>
    <div class="item"><div class="k">需重启生效</div><div class="v">${e.rebootRequired ? '<span class="badge b-warning">是</span>' : '否'}</div></div>
    <div class="item"><div class="k">虚拟机数量</div><div class="v">${e.vmCount === null || e.vmCount === undefined ? '—' : e.vmCount}</div></div>
    <div class="item"><div class="k">数据存储数量</div><div class="v">${e.datastoreCount === null || e.datastoreCount === undefined ? '—' : e.datastoreCount}</div></div>
  </div>`;

  const perfTable = `
    <div class="sec-title">资源使用率</div>
    <table><thead><tr><th>指标</th><th>当前值</th><th style="min-width:120px">图示</th><th>警告线</th><th>严重线</th></tr></thead>
    <tbody>
      <tr><td>CPU 使用率${e.cpuUsedMhz !== null && e.cpuUsedMhz !== undefined ? '（' + e.cpuUsedMhz + ' / ' + (e.cpuTotalMhz || '—') + ' MHz）' : ''}</td>${pctCell(e.cpuPercent, '%', t.cpu_percent_warn, t.cpu_percent_critical)}<td>${barHtml(e.cpuPercent, cpuLv)}</td><td>${t.cpu_percent_warn}%</td><td>${t.cpu_percent_critical}%</td></tr>
      <tr><td>内存使用率（${formatMB(e.memUsedMb)} / ${formatMB(e.memTotalMb)}）</td>${pctCell(e.memPercent, '%', t.memory_percent_warn, t.memory_percent_critical)}<td>${barHtml(e.memPercent, memLv)}</td><td>${t.memory_percent_warn}%</td><td>${t.memory_percent_critical}%</td></tr>
    </tbody></table>
    <div style="font-size:12px;color:var(--muted);margin-top:4px">CPU：${escapeHtml(cpuInfo)}</div>`;

  let dsTable = '';
  if (e.datastores && e.datastores.length) {
    const rows = e.datastores.map((d) => {
      const lv = levelOf(d.usedPercent, t.disk_percent_warn, t.disk_percent_critical);
      const acc = d.accessible === false ? '<span class="badge b-critical">不可访问</span>' : '可访问';
      return `<tr><td>${escapeHtml(d.name || '—')}</td><td>${escapeHtml(d.type || '—')}</td><td>${formatMB(d.capacityMb)}</td><td>${formatMB(d.usedMb)}</td><td>${formatMB(d.freeMb)}</td>${pctCell(d.usedPercent, '%', t.disk_percent_warn, t.disk_percent_critical)}<td>${barHtml(d.usedPercent, lv)}</td><td>${acc}</td></tr>`;
    }).join('');
    dsTable = `
    <div class="sec-title">数据存储</div>
    <table><thead><tr><th>名称</th><th>类型</th><th>总容量</th><th>已用</th><th>可用</th><th>使用率</th><th style="min-width:100px">图示</th><th>可访问性</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  } else if (e.dsError) {
    dsTable = `<div class="sec-title">数据存储</div><div class="errmsg">采集失败：${escapeHtml(truncate(e.dsError, 200))}</div>`;
  }

  let vmTable = '';
  if (e.vms && e.vms.length) {
    const rows = e.vms.map((v) => {
      const lv = v.power === 'poweredOn' ? 'normal' : v.power === 'poweredOff' ? 'error' : 'warning';
      const stLv = v.status === 'green' ? 'normal' : v.status === 'yellow' ? 'warning' : v.status === 'red' ? 'critical' : 'error';
      return `<tr><td>${escapeHtml(v.name || '—')}</td><td><span class="badge b-${lv}">${escapeHtml(statusZh[v.power] || v.power || '—')}</span></td><td><span class="badge b-${stLv}">${escapeHtml(statusZh[v.status] || v.status || '—')}</span></td><td>${v.cpu === null || v.cpu === undefined ? '—' : v.cpu}</td><td>${v.memMb ? formatMB(v.memMb) : '—'}</td><td>${escapeHtml(v.guestOs || '—')}</td><td>${escapeHtml(v.ip || '—')}</td></tr>`;
    }).join('');
    vmTable = `
    <div class="sec-title">虚拟机（${e.vms.length} 台${e.vmCount > e.vms.length ? '，仅列出前 ' + e.vms.length + ' 台' : ''}）</div>
    <table><thead><tr><th>名称</th><th>电源</th><th>状态</th><th>vCPU</th><th>内存</th><th>客户机系统</th><th>IP</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  } else if (e.vmError) {
    vmTable = `<div class="sec-title">虚拟机</div><div class="errmsg">采集失败：${escapeHtml(truncate(e.vmError, 200))}</div>`;
  } else if (e.vmCount === 0) {
    vmTable = '<div class="sec-title">虚拟机</div><div style="color:var(--muted);font-size:13px">该主机上没有虚拟机</div>';
  }

  let pnicTable = '';
  if (e.pnics && e.pnics.length) {
    const rows = e.pnics.map((n) =>
      `<tr><td>${escapeHtml(n.device || '—')}</td><td>${escapeHtml(n.mac || '—')}</td><td>${escapeHtml(n.speed || '—')}</td><td>${n.connected ? '<span class="badge b-normal">已连接</span>' : '<span class="badge b-critical">未连接</span>'}</td></tr>`).join('');
    pnicTable = `
    <div class="sec-title">物理网卡</div>
    <table><thead><tr><th>网卡</th><th>MAC 地址</th><th>链路速率</th><th>链路状态</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  }

  return `<div class="card-body">${kv}${perfTable}${dsTable}${vmTable}${pnicTable}</div>`;
}

/** 渲染单台服务器卡片 */
function serverCard(r, thresholds, idx) {
  const t = thresholds;
  const head = `
  <div class="card-head" onclick="toggle(${idx})">
    <div>
      <div class="title">${escapeHtml(r.name)} <span style="font-weight:400;color:var(--muted);font-size:13px">${escapeHtml(r.host)}</span></div>
      <div class="sub">${escapeHtml(r.osLabel)} · ${escapeHtml(r.connectLabel)}</div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span class="badge b-${r.status}">${LEVEL_LABEL[r.status]}</span>
      <span class="arrow">&#9654;</span>
    </div>
  </div>`;

  let body;
  if (!r.ok) {
    body = `<div class="card-body"><div class="errmsg">巡检失败：${escapeHtml(r.error || '未知错误')}</div></div>`;
  } else if (r.kind === 'bmc') {
    body = renderBmcCard(r);
  } else if (r.kind === 'switch') {
    body = renderSwitchCard(r, t);
  } else if (r.kind === 'database') {
    body = renderDbCard(r, t);
  } else if (r.kind === 'esxi') {
    body = renderEsxiCard(r, t);
  } else {
    const m = r.metrics;
    const cpuLv = levelOf(m.cpu_percent, t.cpu_percent_warn, t.cpu_percent_critical);
    const memLv = levelOf(m.mem_percent, t.memory_percent_warn, t.memory_percent_critical);
    const kv = `
    <div class="kv">
      <div class="item"><div class="k">主机名</div><div class="v">${escapeHtml(m.hostname || '—')}</div></div>
      <div class="item"><div class="k">操作系统</div><div class="v">${escapeHtml(m.os || '—')}</div></div>
      <div class="item"><div class="k">内核/版本</div><div class="v">${escapeHtml(m.kernel || '—')}</div></div>
      <div class="item"><div class="k">运行时长</div><div class="v">${escapeHtml(formatUptime(m.uptime_sec))}</div></div>
      <div class="item"><div class="k">CPU 核数</div><div class="v">${m.cores === null || m.cores === undefined ? '—' : escapeHtml(m.cores)}</div></div>
      ${m.load1 === null ? '' : `<div class="item"><div class="k">系统负载 (1/5/15分)</div><div class="v">${m.load1 === null ? '—' : m.load1 + ' / ' + m.load5 + ' / ' + m.load15}</div></div>`}
      ${m.procs === null ? '' : `<div class="item"><div class="k">进程数${m.zombies !== null ? '（僵尸）' : ''}</div><div class="v">${m.procs}${m.zombies !== null ? '（' + m.zombies + '）' : ''}</div></div>`}
      ${m.swap_total_mb ? `<div class="item"><div class="k">Swap 使用</div><div class="v">${formatMB(m.swap_used_mb)} / ${formatMB(m.swap_total_mb)}</div></div>` : ''}
    </div>`;

    const diskRows = (m.disks || []).map((d) => {
      const lv = levelOf(d.use_percent, t.disk_percent_warn, t.disk_percent_critical);
      return `<tr><td>${escapeHtml(d.mount)}</td><td>${escapeHtml(d.fs || '')}</td><td>${formatMB(d.size_mb)}</td><td>${formatMB(d.used_mb)}</td><td>${formatMB(d.avail_mb)}</td>${pctCell(d.use_percent, '%', t.disk_percent_warn, t.disk_percent_critical)}<td>${barHtml(d.use_percent, lv)}</td></tr>`;
    }).join('');
    const diskTable = diskRows ? `
      <div class="sec-title">磁盘分区</div>
      <table><thead><tr><th>挂载点</th><th>文件系统</th><th>总容量</th><th>已用</th><th>可用</th><th>使用率</th><th style="min-width:100px">图示</th></tr></thead>
      <tbody>${diskRows}</tbody></table>` : '<div class="sec-title">磁盘分区</div><div style="color:var(--muted);font-size:13px">未采集到磁盘信息</div>';

    const svcRows = (r.services || []).map((s) => {
      const lv = s.running ? 'normal' : 'critical';
      const typeLabel = { process: '进程', port: '端口', systemd: 'systemd 服务', service: 'Windows 服务' }[s.type] || s.type;
      return `<tr><td>${escapeHtml(s.name)}</td><td>${escapeHtml(typeLabel)}</td><td><span class="badge b-${lv}">${s.running ? '运行中' : '未运行'}</span></td><td>${escapeHtml(s.detail || '')}</td></tr>`;
    }).join('');
    const svcTable = svcRows ? `
      <div class="sec-title">关键服务检查</div>
      <table><thead><tr><th>名称</th><th>类型</th><th>状态</th><th>详情</th></tr></thead>
      <tbody>${svcRows}</tbody></table>` : '';

    const net = m.net || [];
    const netTable = net.length ? `
      <div class="sec-title">网络吞吐（KB/s）与错包</div>
      <table><thead><tr><th>接口</th><th>接收</th><th>发送</th><th>错包</th><th>丢包</th></tr></thead>
      <tbody>${net.map((ni) => `<tr><td>${escapeHtml(ni.iface || '')}</td><td>${ni.rx_kbps === null || ni.rx_kbps === undefined ? '—' : ni.rx_kbps}</td><td>${ni.tx_kbps === null || ni.tx_kbps === undefined ? '—' : ni.tx_kbps}</td><td>${ni.errs > 0 ? '<span class="badge b-warning">' + ni.errs + '</span>' : (ni.errs || 0)}</td><td>${ni.drops || 0}</td></tr>`).join('')}</tbody></table>` : '';

    const diskio = m.diskio || [];
    const diskIoTable = diskio.length ? `
      <div class="sec-title">磁盘 IO（KB/s）</div>
      <table><thead><tr><th>设备</th><th>读取</th><th>写入</th></tr></thead>
      <tbody>${diskio.map((d) => `<tr><td>${escapeHtml(d.dev || '')}</td><td>${d.r_kbps === null || d.r_kbps === undefined ? '—' : d.r_kbps}</td><td>${d.w_kbps === null || d.w_kbps === undefined ? '—' : d.w_kbps}</td></tr>`).join('')}</tbody></table>` : '';

    const logLine = (m.log_errors !== null && m.log_errors !== undefined) ? `
      <div class="sec-title">系统日志（近 24 小时）</div>
      <div class="kv"><div class="item"><div class="k">错误</div><div class="v" style="${m.log_errors > 0 ? 'color:#dc2626;font-weight:600' : ''}">${m.log_errors} 条</div></div><div class="item"><div class="k">警告</div><div class="v">${m.log_warns === null || m.log_warns === undefined ? '—' : m.log_warns + ' 条'}</div></div></div>` : '';

    const customBlocks = (r.customs || []).map((c) => `
      <div class="sec-title">自定义命令：${escapeHtml(c.name)}（退出码 ${c.code}）</div>
      <pre>${escapeHtml(c.output || '(无输出)')}</pre>`).join('');

    const perfTable = `
      <div class="sec-title">资源使用率</div>
      <table><thead><tr><th>指标</th><th>当前值</th><th style="min-width:120px">图示</th><th>警告线</th><th>严重线</th></tr></thead>
      <tbody>
        <tr><td>CPU 使用率</td>${pctCell(m.cpu_percent, '%', t.cpu_percent_warn, t.cpu_percent_critical)}<td>${barHtml(m.cpu_percent, cpuLv)}</td><td>${t.cpu_percent_warn}%</td><td>${t.cpu_percent_critical}%</td></tr>
        <tr><td>内存使用率</td>${pctCell(m.mem_percent, '%', t.memory_percent_warn, t.memory_percent_critical)}<td>${barHtml(m.mem_percent, memLv)}</td><td>${t.memory_percent_warn}%</td><td>${t.memory_percent_critical}%</td></tr>
        <tr><td>内存（已用/总量）</td><td colspan="4">${formatMB(m.mem_used_mb)} / ${formatMB(m.mem_total_mb)}</td></tr>
      </tbody></table>`;

    body = `<div class="card-body">${kv}${perfTable}${diskTable}${netTable}${diskIoTable}${logLine}${svcTable}${customBlocks}</div>`;
  }
  // 采集通道降级提示（如 wmic 被移除后自动改用 PowerShell/CIM）：置于卡片正文最前，成功采集也可见
  if (r.ok && r.note) {
    body = body.replace('<div class="card-body">', '<div class="card-body"><div class="notemsg">' + escapeHtml(r.note) + '</div>');
  }
  return `<div class="card open" data-status="${r.status}" id="card-${idx}">${head}${body}</div>`;
}

/** 生成完整 HTML */
function renderReport(results, meta) {
  // 按登录方式排序：SSH 密码 → SSH 密钥 → WMI → Redfish → 本机
  const ORDER = { 'SSH 密码': 0, 'SSH 密钥': 1, 'SSH(设备)': 1, 'WMI': 2, 'Redfish': 3, '本机': 4, 'TDS连接': 2, 'Oracle连接': 2, 'vSphere API': 3 };
  results = results.slice().sort((a, b) => {
    const oa = ORDER[a.connectLabel] === undefined ? 9 : ORDER[a.connectLabel];
    const ob = ORDER[b.connectLabel] === undefined ? 9 : ORDER[b.connectLabel];
    return oa - ob;
  });
  const count = { total: results.length, normal: 0, warning: 0, critical: 0, error: 0 };
  for (const r of results) {
    if (!r.ok) count.error++;
    else if (count[r.status] !== undefined) count[r.status]++;
  }
  const cards = results.map((r, i) => serverCard(r, meta.thresholds, i)).join('\n');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>服务器巡检报告 ${escapeHtml(meta.date)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<h1>机房设备巡检报告</h1>
<div class="meta">巡检时间：${escapeHtml(meta.date)} · 共 ${count.total} 台 · 程序版本 ${escapeHtml(meta.version)}</div>
<div class="summary">
  <div class="stat"><div class="num">${count.total}</div><div class="lbl">服务器总数</div></div>
  <div class="stat"><div class="num" style="color:#16a34a">${count.normal}</div><div class="lbl">正常</div></div>
  <div class="stat"><div class="num" style="color:#d97706">${count.warning}</div><div class="lbl">警告</div></div>
  <div class="stat"><div class="num" style="color:#dc2626">${count.critical}</div><div class="lbl">严重</div></div>
  <div class="stat"><div class="num" style="color:#6b7280">${count.error}</div><div class="lbl">巡检失败</div></div>
</div>
<div class="filters">
  <button class="active" onclick="filter(this,'all')">全部</button>
  <button onclick="filter(this,'critical')">严重</button>
  <button onclick="filter(this,'warning')">警告</button>
  <button onclick="filter(this,'error')">失败</button>
  <button onclick="filter(this,'normal')">正常</button>
</div>
${cards}
</div>
<script>
function toggle(i){document.getElementById('card-'+i).classList.toggle('open');}
function filter(btn,st){
  document.querySelectorAll('.filters button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.card').forEach(c=>{
    c.style.display=(st==='all'||c.dataset.status===st)?'':'none';
  });
}
</script>
</body>
</html>`;
}

/** 对单台巡检结果做阈值评估，得出整体状态；同时收集触发警告/严重的具体原因 */
function evaluateResult(r, t) {
  if (!r.ok) { r.status = 'error'; r.reasons = []; return r; }
  // reasons: [{ level:'warning'|'critical', text:'...' }]，仅收集非正常项
  const reasons = [];
  const add = (lv, text) => { if (lv === 'warning' || lv === 'critical') reasons.push({ level: lv, text: text }); };
  if (r.kind === 'switch') {
    const m = r.metrics || {};
    const hw = r.hw || {};
    let st = 'normal';
    if (m.cpu_percent !== null && m.cpu_percent !== undefined) {
      const lv = levelOf(m.cpu_percent, t.cpu_percent_warn, t.cpu_percent_critical);
      st = worst(st, lv);
      add(lv, 'CPU 使用率 ' + round1(m.cpu_percent) + '%');
    }
    if (m.mem_percent !== null && m.mem_percent !== undefined) {
      const lv = levelOf(m.mem_percent, t.memory_percent_warn, t.memory_percent_critical);
      st = worst(st, lv);
      add(lv, '内存使用率 ' + round1(m.mem_percent) + '%');
    }
    for (const tp of (m.temps || hw.temps || [])) {
      if (tp.c === null || tp.c === undefined) continue;
      const lv = levelOf(tp.c, t.switch_temp_warn, t.switch_temp_critical);
      st = worst(st, lv);
      add(lv, '温度「' + (tp.label || '传感器') + '」' + round1(tp.c) + '℃');
    }
    const ports = m.ports || hw.ports || {};
    if (ports.errors && ports.errors > 0) { st = worst(st, 'warning'); add('warning', '端口错包累计 ' + ports.errors + ' 个'); }
    if (ports.total && ports.down && ports.down > 0) { st = worst(st, 'warning'); add('warning', ports.down + ' 个端口处于 Down 状态（共 ' + ports.total + '）'); }
    r.status = st;
    r.reasons = reasons;
    return r;
  }
  if (r.kind === 'database') {
    const db = r.db || {};
    let st = 'normal';
    if (db.conn_max && db.conn_total !== null && db.conn_total !== undefined) {
      const lv = levelOf(db.conn_total * 100 / db.conn_max, t.db_conn_percent_warn, t.db_conn_percent_critical);
      st = worst(st, lv);
      add(lv, '连接数 ' + round1(db.conn_total * 100 / db.conn_max) + '%（' + db.conn_total + '/' + db.conn_max + '）');
    }
    if (db.blocked && db.blocked > 0) { st = worst(st, 'warning'); add('warning', '存在 ' + db.blocked + ' 个阻塞会话'); }
    for (const d of db.databases || []) {
      if (d.log_used_pct !== null && d.log_used_pct !== undefined) {
        const lv = levelOf(d.log_used_pct, t.db_space_percent_warn, t.db_space_percent_critical);
        st = worst(st, lv);
        add(lv, '数据库「' + (d.name || '') + '」日志使用 ' + round1(d.log_used_pct) + '%');
      }
    }
    for (const d of db.tablespaces || []) {
      const lv = levelOf(d.use_pct, t.db_space_percent_warn, t.db_space_percent_critical);
      st = worst(st, lv);
      add(lv, '表空间「' + (d.name || '') + '」使用 ' + round1(d.use_pct) + '%');
    }
    if (db.last_backup_ms !== null && db.last_backup_ms !== undefined) {
      const ageH = (Date.now() - db.last_backup_ms) / 3600000;
      const lv = levelOf(ageH, t.db_backup_age_warn_h, t.db_backup_age_critical_h);
      st = worst(st, lv);
      add(lv, '最近一次备份距今 ' + (ageH >= 48 ? Math.round(ageH / 24) + ' 天' : Math.round(ageH) + ' 小时'));
    }
    if (db.buffer_hit_pct !== null && db.buffer_hit_pct !== undefined) {
      const lv = db.buffer_hit_pct < t.db_buffer_hit_critical ? 'critical'
        : db.buffer_hit_pct < t.db_buffer_hit_warn ? 'warning' : 'normal';
      st = worst(st, lv);
      add(lv, '缓冲命中率 ' + round1(db.buffer_hit_pct) + '%');
    }
    if (db.lock_waiters !== null && db.lock_waiters !== undefined && (db.lock_waiters > 0 || (db.max_wait_ms && db.max_wait_ms > 0))) {
      const lv = (db.max_wait_ms && db.max_wait_ms >= t.db_lock_wait_critical_ms) ? 'critical'
        : 'warning';
      st = worst(st, lv);
      add(lv, '锁等待会话 ' + db.lock_waiters + ' 个（最长 ' + (db.max_wait_ms || 0) + ' ms）');
    }
    r.status = st;
    r.reasons = reasons;
    return r;
  }
  if (r.kind === 'esxi') {
    const e = r.esxi || {};
    let st = 'normal';
    // 主机整体状态（green/yellow/red）
    const mapStatus = (v) => v === 'red' || v === 'notResponding' ? 'critical'
      : v === 'yellow' || v === 'disconnected' ? 'warning' : null;
    const statusZh = { yellow: '警告', red: '严重', disconnected: '已断开', notResponding: '无响应' };
    const osLv = mapStatus(e.overallStatus);
    if (osLv) { st = worst(st, osLv); add(osLv, '主机整体状态：' + (statusZh[e.overallStatus] || e.overallStatus)); }
    const csLv = mapStatus(e.connectionState);
    if (csLv) { st = worst(st, csLv); add(csLv, '连接状态：' + (statusZh[e.connectionState] || e.connectionState)); }
    // CPU / 内存使用率
    let cpuLv = levelOf(e.cpuPercent, t.cpu_percent_warn, t.cpu_percent_critical);
    st = worst(st, cpuLv);
    add(cpuLv, 'CPU 使用率 ' + round1(e.cpuPercent) + '%');
    let memLv = levelOf(e.memPercent, t.memory_percent_warn, t.memory_percent_critical);
    st = worst(st, memLv);
    add(memLv, '内存使用率 ' + round1(e.memPercent) + '%');
    // 数据存储使用率与可访问性
    for (const d of e.datastores || []) {
      const lv = levelOf(d.usedPercent, t.disk_percent_warn, t.disk_percent_critical);
      st = worst(st, lv);
      add(lv, '数据存储「' + (d.name || '') + '」使用 ' + round1(d.usedPercent) + '%');
      if (d.accessible === false) { st = worst(st, 'critical'); add('critical', '数据存储「' + (d.name || '') + '」不可访问'); }
    }
    // 维护模式 / 待重启提示为警告
    if (e.maintenanceMode) { st = worst(st, 'warning'); add('warning', '主机处于维护模式'); }
    if (e.rebootRequired) { st = worst(st, 'warning'); add('warning', '主机有待重启的变更'); }
    // 网卡链路断开
    for (const n of e.pnics || []) {
      if (n.connected === false) { st = worst(st, 'warning'); add('warning', '网卡 ' + (n.device || '') + ' 链路未连接'); }
    }
    r.status = st;
    r.reasons = reasons;
    return r;
  }
  if (r.kind === 'bmc') {
    const hw = r.hw || {};
    let st = 'normal';
    const healthZh = { Warning: '警告', Degraded: '降级', Critical: '严重', Fatal: '致命', PreFail: '预故障' };
    // 检查一项健康状态并收集原因
    const chk = (label, health) => {
      const lv = levelOfHealth(health);
      st = worst(st, lv);
      if (lv === 'warning' || lv === 'critical') add(lv, label + '：' + (healthZh[health] || health));
    };
    chk('整机健康', hw.system_health);
    chk('CPU 健康', hw.cpu_health);
    chk('内存健康', hw.mem_health);
    for (const x of hw.temps || []) chk('温度「' + (x.name || '') + '」', x.health);
    for (const x of hw.fans || []) chk('风扇「' + (x.name || '') + '」', x.health);
    for (const x of hw.psus || []) chk('电源「' + (x.name || '') + '」', x.health);
    for (const x of hw.drives || []) {
      chk('磁盘「' + (x.name || '') + '」', x.health);
      if (x.life_left !== null && x.life_left !== undefined) {
        const lifeLv = x.life_left <= 10 ? 'critical' : x.life_left <= 25 ? 'warning' : 'normal';
        if (lifeLv !== 'normal') { st = worst(st, lifeLv); add(lifeLv, '磁盘「' + (x.name || '') + '」SSD 剩余寿命 ' + x.life_left + '%'); }
      }
    }
    if (hw.power && hw.power !== 'On') { st = worst(st, 'critical'); add('critical', '电源状态：' + hw.power + '（非开机）'); }
    for (const e of hw.events || []) {
      if (e.severity === 'Critical' || e.severity === 'Fatal') { st = worst(st, 'critical'); add('critical', '事件日志：' + (e.message || e.severity)); }
      else if (e.severity === 'Warning') { st = worst(st, 'warning'); add('warning', '事件日志：' + (e.message || e.severity)); }
    }
    r.status = st;
    r.reasons = reasons;
    return r;
  }
  const m = r.metrics;
  let st = 'normal';
  const cpuLv = levelOf(m.cpu_percent, t.cpu_percent_warn, t.cpu_percent_critical);
  st = worst(st, cpuLv);
  add(cpuLv, 'CPU 使用率 ' + round1(m.cpu_percent) + '%');
  const memLv = levelOf(m.mem_percent, t.memory_percent_warn, t.memory_percent_critical);
  st = worst(st, memLv);
  add(memLv, '内存使用率 ' + round1(m.mem_percent) + '%');
  for (const d of m.disks || []) {
    const lv = levelOf(d.use_percent, t.disk_percent_warn, t.disk_percent_critical);
    st = worst(st, lv);
    add(lv, '磁盘 ' + (d.mount || '') + ' 使用 ' + round1(d.use_percent) + '%');
  }
  if (t.load_per_core_warn && m.load1 !== null && m.cores) {
    if (m.load1 / m.cores >= t.load_per_core_warn) { st = worst(st, 'warning'); add('warning', '负载 ' + m.load1 + '（' + round1(m.load1 / m.cores) + '/核）'); }
  }
  for (const s of r.services || []) if (!s.running) { st = worst(st, 'critical'); add('critical', '服务「' + (s.name || '') + '」未运行'); }
  for (const ni of m.net || []) {
    if (ni.errs && ni.errs > 0) { st = worst(st, 'warning'); add('warning', '网络接口「' + (ni.iface || '?') + '」错包/丢包 ' + ni.errs + (ni.drops ? ('（丢 ' + ni.drops + '）') : '')); }
  }
  if (m.log_errors !== null && m.log_errors !== undefined) {
    const lv = levelOf(m.log_errors, t.log_error_warn, t.log_error_critical);
    st = worst(st, lv);
    add(lv, '系统日志近 24 小时错误 ' + m.log_errors + ' 条' + (m.log_warns ? '（警告 ' + m.log_warns + ' 条）' : ''));
  }
  r.status = st;
  r.reasons = reasons;
  return r;
}

module.exports = { renderReport, evaluateResult };
