'use strict';
/**
 * 监控大屏页面渲染：深色科技风，设备状态卡片网格，自动刷新
 */

/**
 * 渲染监控大屏页面
 * @param {object} [opt] 可选上下文 { user, title }
 *   user: { user, role, displayName } —— 传入时显示导航栏（报告入口、当前用户、退出登录）
 *   title: 页面标题，默认「机房设备巡检 · 监控大屏」
 * 不传参数时输出不含导航栏的版本，保持向后兼容。
 */
function renderBigScreen(opt) {
  const o = opt || {};
  const escHtml = (s) => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const pageTitle = o.title || '机房设备巡检 · 监控大屏';

  // 导航栏：仅在已登录上下文下渲染（含退出登录所需的 CSRF token）
  let nav = '';
  if (o.user) {
    const u = o.user;
    const isAdmin = u.role === 'admin';
    const isLocal = u.role === 'local';   // 本机免登录模式：无会话，故不显示退出入口
    const roleText = isAdmin ? '管理员' : isLocal ? '本机模式' : '只读';
    nav = '<div class="topnav">'
      + '<a href="/" class="on">监控大屏</a>'
      + '<a href="/reports">巡检报告</a>'
      + (isAdmin ? '<button type="button" id="btnReload">重载配置</button>' : '')
      + '<span class="who">'
      + '<span>' + escHtml(u.displayName || u.user || '') + '</span>'
      + '<span class="role' + (isAdmin ? ' admin' : '') + '">' + roleText + '</span>'
      + (isLocal ? '' : '<a href="/logout">退出</a>')
      + '</span></div>';
  }

  // CSRF token 以 JSON 字面量注入脚本。
  // 注意：JSON.stringify 不会转义 < > & 与 U+2028/U+2029，若 token 含 </script>
  // 会提前闭合页面脚本标签形成 XSS，因此必须再做一层 HTML 安全的 Unicode 转义。
  const csrfJson = JSON.stringify(String(o.csrfToken || ''))
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escHtml(pageTitle)}</title>
<style>
:root { --bg:#0a1220; --panel:#101c31; --line:#1e3050; --text:#dbe7ff; --muted:#7d93b8; }
* { box-sizing:border-box; margin:0; padding:0; }
html,body { height:100%; }
body { background:radial-gradient(1200px 600px at 70% -10%, #14294a 0%, var(--bg) 55%); color:var(--text); font-family:"Microsoft YaHei UI","Segoe UI",sans-serif; min-height:100%; }
.wrap { max-width:1800px; margin:0 auto; padding:28px 36px; }
.head { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; flex-wrap:wrap; margin-bottom:24px; }
.title { font-size:30px; font-weight:700; letter-spacing:2px; background:linear-gradient(90deg,#7cc4ff,#4f8ef7); -webkit-background-clip:text; background-clip:text; color:transparent; }
.sub { color:var(--muted); font-size:13px; margin-top:6px; }
.clock { text-align:right; }
.clock .time { font-size:30px; font-weight:700; font-variant-numeric:tabular-nums; }
.clock .date { color:var(--muted); font-size:13px; margin-top:2px; }
.stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:14px; margin-bottom:26px; }
.stat { background:linear-gradient(160deg,var(--panel),#0c1626); border:1px solid var(--line); border-radius:12px; padding:16px 18px; position:relative; overflow:hidden; }
.stat::after { content:''; position:absolute; left:0; top:0; bottom:0; width:4px; border-radius:12px 0 0 12px; }
.stat.t::after{background:#4f8ef7}.stat.n::after{background:#22c55e}.stat.w::after{background:#f59e0b}.stat.c::after{background:#ef4444}.stat.e::after{background:#6b7280}
.stat .num { font-size:34px; font-weight:800; font-variant-numeric:tabular-nums; }
.stat.n .num{color:#22c55e}.stat.w .num{color:#f59e0b}.stat.c .num{color:#ef4444}.stat.e .num{color:#9aa4b2}.stat.t .num{color:#7cc4ff}
.stat .lbl { color:var(--muted); font-size:13px; margin-top:4px; }
.grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:16px; }
#grid { display:block; }
.section { margin-bottom:30px; }
.sec-head { display:flex; align-items:center; gap:12px; margin-bottom:14px; }
.sec-title { font-size:18px; font-weight:700; letter-spacing:1px; color:#7cc4ff; }
.sec-title::before { content:''; display:inline-block; width:5px; height:18px; border-radius:3px; background:linear-gradient(180deg,#7cc4ff,#4f8ef7); margin-right:10px; vertical-align:-3px; }
.sec-count { color:var(--muted); font-size:13px; }
.sec-toggle { display:flex; align-items:center; gap:12px; flex:1; cursor:pointer; user-select:none; }
.sec-toggle:hover .sec-title { opacity:.85; }
.chev { display:inline-block; margin-left:8px; color:var(--muted); font-size:13px; transition:transform .2s; }
.section.collapsed .chev { transform:rotate(-90deg); }
.section.collapsed .grid { display:none; }
.sec-mini { margin-left:auto; display:flex; gap:8px; font-size:12px; color:var(--muted); }
.sec-mini span { cursor:pointer; user-select:none; padding:3px 10px; border-radius:14px; border:1px solid transparent; transition:background .15s,border-color .15s; }
.sec-mini span:hover { background:#1e3050; }
.sec-mini span.active { background:#274060; border-color:#4f8ef7aa; color:var(--text); }
.sec-mini b { font-weight:700; margin-left:3px; }
.sec-mini .ok b{color:#22c55e}.sec-mini .wr b{color:#f59e0b}.sec-mini .cr b{color:#ef4444}.sec-mini .er b{color:#9aa4b2}
.no-match { color:var(--muted); font-size:13px; padding:18px 4px; grid-column:1/-1; }
.card { background:linear-gradient(160deg,var(--panel),#0c1626); border:1px solid var(--line); border-radius:12px; padding:18px; position:relative; transition:transform .15s; }
.card:hover { transform:translateY(-2px); }
.card::before { content:''; position:absolute; left:0; top:14px; bottom:14px; width:4px; border-radius:0 4px 4px 0; }
.card.normal::before{background:#22c55e}.card.warning::before{background:#f59e0b}.card.critical::before{background:#ef4444;box-shadow:0 0 12px #ef444488}.card.error::before{background:#6b7280}
.card.critical { border-color:#ef444466; animation:blink 1.6s ease-in-out infinite; }
@keyframes blink { 0%,100%{box-shadow:none} 50%{box-shadow:0 0 18px #ef444455} }
.c-head { display:flex; justify-content:space-between; align-items:center; gap:10px; }
.c-name { font-size:16px; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.c-host { color:var(--muted); font-size:12px; margin-top:3px; }
.dot { display:inline-block; width:10px; height:10px; border-radius:50%; margin-right:6px; vertical-align:middle; }
.dot.normal{background:#22c55e;box-shadow:0 0 8px #22c55e}.dot.warning{background:#f59e0b;box-shadow:0 0 8px #f59e0b}.dot.critical{background:#ef4444;box-shadow:0 0 8px #ef4444}.dot.error{background:#6b7280}
.badge { font-size:12px; padding:3px 10px; border-radius:20px; flex-shrink:0; }
.badge.normal{background:#22c55e22;color:#4ade80}.badge.warning{background:#f59e0b22;color:#fbbf24}.badge.critical{background:#ef444422;color:#f87171}.badge.error{background:#6b728022;color:#9aa4b2}
.c-type { color:var(--muted); font-size:12px; margin-top:10px; }
.bars { margin-top:12px; display:grid; gap:8px; }
.bar-row { display:flex; align-items:center; gap:8px; font-size:12px; color:var(--muted); }
.bar-row .k { width:34px; flex-shrink:0; }
.bar-track { flex:1; height:8px; background:#0d1a2e; border-radius:6px; overflow:hidden; }
.bar-fill { height:100%; border-radius:6px; transition:width .6s; }
.bar-fill.ok{background:linear-gradient(90deg,#22c55e,#4ade80)}.bar-fill.warn{background:linear-gradient(90deg,#f59e0b,#fbbf24)}.bar-fill.bad{background:linear-gradient(90deg,#ef4444,#f87171)}
.bar-row .v { width:44px; text-align:right; font-variant-numeric:tabular-nums; color:var(--text); }
.c-err { margin-top:10px; font-size:12px; color:#fca5a5; background:#ef444411; border:1px solid #ef444433; border-radius:8px; padding:8px 10px; word-break:break-all; max-height:64px; overflow:hidden; }
.c-reasons { margin-top:10px; display:grid; gap:5px; }
.c-note { margin-top:8px; font-size:11px; line-height:1.5; color:#fbbf24; background:rgba(251,191,36,.1); border-left:2px solid rgba(251,191,36,.5); border-radius:4px; padding:5px 8px; }
.reason { font-size:12px; line-height:1.5; border-radius:7px; padding:6px 9px; display:flex; gap:7px; align-items:flex-start; word-break:break-word; }
.reason .ri { flex-shrink:0; font-weight:800; width:13px; text-align:center; }
.reason.warning { color:#fcd34d; background:#f59e0b16; border:1px solid #f59e0b3a; }
.reason.critical { color:#fca5a5; background:#ef444416; border:1px solid #ef444444; }
.foot { margin-top:26px; color:var(--muted); font-size:13px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:10px; }
.refresh-dot { display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e; margin-right:6px; animation:pulse 2s infinite; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
.empty { text-align:center; color:var(--muted); padding:80px 0; font-size:16px; }
.topnav { display:flex; align-items:center; gap:9px; margin-bottom:14px; flex-wrap:wrap; }
.topnav a, .topnav button { padding:6px 15px; font-size:12.5px; color:var(--muted); text-decoration:none;
  background:transparent; border:1px solid var(--line); border-radius:17px; cursor:pointer; font-family:inherit; transition:.15s; }
.topnav a:hover, .topnav button:hover { color:var(--text); background:#1e3050; }
.topnav a.on { color:#fff; background:#274060; border-color:#4f8ef7aa; }
.topnav .who { margin-left:auto; font-size:12.5px; color:var(--muted); display:flex; align-items:center; gap:9px; }
.topnav .role { padding:2px 9px; font-size:11px; border-radius:10px; background:#1e3050; color:#7cc4ff; border:1px solid #2b4a75; }
.topnav .role.admin { background:#3a2f14; color:#fbbf24; border-color:#6b5518; }
</style>
</head>
<body>
<div class="wrap">
  ${nav}
  <div class="head">
    <div>
      <div class="title">${escHtml(pageTitle)}</div>
      <div class="sub" id="updateInfo">等待首次巡检数据...</div>
    </div>
    <div class="clock">
      <div class="time" id="clockTime">--:--:--</div>
      <div class="date" id="clockDate"></div>
    </div>
  </div>
  <div class="stats" id="stats"></div>
  <div class="grid" id="grid"><div class="empty">正在加载巡检数据…</div></div>
  <div class="foot">
    <div><span class="refresh-dot"></span>实时监控中 · 数据每轮巡检后自动更新</div>
    <div id="footInfo"></div>
  </div>
</div>
<script>
var POLL_MS = 15000;
function pad(n){ return String(n).padStart(2,'0'); }
function tick(){
  var d = new Date();
  document.getElementById('clockTime').textContent = pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  document.getElementById('clockDate').textContent = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+' 周'+'日一二三四五六'.charAt(d.getDay());
}
setInterval(tick, 1000); tick();
function barClass(v){ if(v===null||v===undefined) return 'ok'; return v>=90?'bad':(v>=70?'warn':'ok'); }
function pct(v){ return (v===null||v===undefined)?'—':v+'%'; }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
// 各分区交互状态（折叠/筛选），在自动刷新间保持
var uiState = {};
var lastData = null;
function render(data){
  lastData = data;
  var s = data.summary || {};
  document.getElementById('stats').innerHTML =
    '<div class="stat t"><div class="num">'+(s.total||0)+'</div><div class="lbl">设备总数</div></div>'+
    '<div class="stat n"><div class="num">'+(s.normal||0)+'</div><div class="lbl">正常</div></div>'+
    '<div class="stat w"><div class="num">'+(s.warning||0)+'</div><div class="lbl">警告</div></div>'+
    '<div class="stat c"><div class="num">'+(s.critical||0)+'</div><div class="lbl">严重</div></div>'+
    '<div class="stat e"><div class="num">'+(s.error||0)+'</div><div class="lbl">失败</div></div>';
  document.getElementById('updateInfo').textContent = (data.updatedAt?('上次巡检完成：'+data.updatedAt):'正在巡检...')+' · 每 '+data.interval+' 秒轮询 · 第 '+(data.round||0)+' 轮';
  document.getElementById('footInfo').textContent = '巡检中 '+((data.running)?'是':'否');
  var devs = data.devices || [];
  if (!devs.length) { document.getElementById('grid').innerHTML = '<div class="empty">暂无设备数据</div>'; return; }
  // 状态排序：严重 > 警告 > 失败 > 正常
  var order = { critical:0, warning:1, error:2, normal:3 };
  // 按设备类型分区：服务器(含Linux/Windows) → ESXi虚拟化 → 交换机 → 管理口 → 数据库
  var groups = [
    { key:'server',   title:'服务器',    match:function(o){ return o==='linux'||o==='windows'; } },
    { key:'esxi',     title:'ESXi 虚拟化', match:function(o){ return o==='esxi'; } },
    { key:'switch',   title:'网络交换机', match:function(o){ return o==='switch'; } },
    { key:'bmc',      title:'服务器管理口', match:function(o){ return o==='bmc'; } },
    { key:'database', title:'数据库',    match:function(o){ return o==='database'; } }
  ];
  function cardHtml(d){
    var st = d.status || 'error';
    var label = {normal:'正常',warning:'警告',critical:'严重',error:'巡检失败'}[st] || st;
    var h = '<div class="card '+st+'"><div class="c-head"><div><div class="c-name"><span class="dot '+st+'"></span>'+esc(d.name)+'</div><div class="c-host">'+esc(d.host)+(d.hostname?(' · '+esc(d.hostname)):'')+'</div></div><span class="badge '+st+'">'+label+'</span></div>';
    h += '<div class="c-type">'+esc(d.osLabel||'')+' · '+esc(d.connectLabel||'')+'</div>';
    if (st !== 'error' && (d.cpu !== null || d.mem !== null)) {
      h += '<div class="bars">';
      if (d.cpu !== null) h += '<div class="bar-row"><span class="k">CPU</span><div class="bar-track"><div class="bar-fill '+barClass(d.cpu)+'" style="width:'+Math.min(100,d.cpu)+'%"></div></div><span class="v">'+pct(d.cpu)+'</span></div>';
      if (d.mem !== null) h += '<div class="bar-row"><span class="k">内存</span><div class="bar-track"><div class="bar-fill '+barClass(d.mem)+'" style="width:'+Math.min(100,d.mem)+'%"></div></div><span class="v">'+pct(d.mem)+'</span></div>';
      h += '</div>';
    }
    // 警告/严重设备：显示触发原因（严重项排前）
    if ((st === 'warning' || st === 'critical') && d.reasons && d.reasons.length) {
      var rs = d.reasons.slice().sort(function(a,b){ return (a.level==='critical'?0:1)-(b.level==='critical'?0:1); });
      h += '<div class="c-reasons">';
      for (var q=0;q<rs.length;q++){
        var lv = rs[q].level==='critical'?'critical':'warning';
        var ic = lv==='critical'?'✗':'!';
        h += '<div class="reason '+lv+'"><span class="ri">'+ic+'</span><span>'+esc(rs[q].text)+'</span></div>';
      }
      h += '</div>';
    }
    if (d.error) h += '<div class="c-err">'+esc(d.error)+'</div>';
    // 采集通道降级提示：即使状态正常也要显示，便于运维知晓 wmic 已不可用
    if (d.note) h += '<div class="c-note">'+esc(d.note)+'</div>';
    return h + '</div>';
  }
  var html = '';
  for (var g=0; g<groups.length; g++){
    var grp = groups[g];
    var list = devs.filter(function(d){ return grp.match(d.os); });
    if (!list.length) continue;
    list.sort(function(a,b){ return (order[a.status]===undefined?9:order[a.status]) - (order[b.status]===undefined?9:order[b.status]); });
    var c = { normal:0, warning:0, critical:0, error:0 };
    for (var k=0;k<list.length;k++){ var stt = list[k].status||'error'; if (c[stt]!==undefined) c[stt]++; }
    var gs = uiState[grp.key] || (uiState[grp.key] = { collapsed:false, filter:null });
    // 分区标题（点击折叠/展开）+ 状态筛选按钮（点击按状态过滤卡片，事件委托处理）
    function fBtn(cls, st, label, cnt){
      var act = gs.filter===st ? ' active' : '';
      return '<span class="'+cls+act+'" data-grp="'+grp.key+'" data-st="'+st+'">'+label+'<b>'+cnt+'</b></span>';
    }
    html += '<div class="section'+(gs.collapsed?' collapsed':'')+'" data-key="'+grp.key+'">';
    html += '<div class="sec-head"><div class="sec-toggle" data-key="'+grp.key+'"><span class="sec-title">'+grp.title+'</span><span class="sec-count">'+list.length+' 台</span><span class="chev">▼</span></div>';
    html += '<span class="sec-mini">'+fBtn('ok','normal','正常',c.normal)+fBtn('wr','warning','警告',c.warning)+fBtn('cr','critical','严重',c.critical)+fBtn('er','error','失败',c.error)+'</span></div>';
    // 应用筛选：只渲染匹配状态（无筛选则全部）
    var shown = list.filter(function(d){ var st=(d.status||'error'); return !gs.filter || st===gs.filter; });
    html += '<div class="grid">';
    if (gs.filter && !shown.length) html += '<div class="no-match">该分区下没有「'+({normal:'正常',warning:'警告',critical:'严重',error:'失败'}[gs.filter])+'」状态的设备</div>';
    for (var i=0;i<shown.length;i++){ html += cardHtml(shown[i]); }
    html += '</div></div>';
  }
  document.getElementById('grid').innerHTML = html;
}
function poll(){
  fetch('/api/status').then(function(r){ return r.json(); }).then(render).catch(function(){
    document.getElementById('updateInfo').textContent = '数据服务连接失败，重试中...';
  });
}
// 点击分区标题：折叠/展开
function toggleCollapse(key){
  var gs = uiState[key];
  if (!gs) return;
  gs.collapsed = !gs.collapsed;
  var sec = document.querySelector('.section[data-key="'+key+'"]');
  if (sec) sec.classList.toggle('collapsed', gs.collapsed);
}
// 点击状态数字：切换该分区的状态筛选（再点一次取消）
function toggleFilter(key, st){
  var gs = uiState[key];
  if (!gs) return;
  gs.filter = (gs.filter === st) ? null : st;
  if (lastData) render(lastData);
}
// 事件委托：处理分区标题折叠与状态按钮筛选（避免内联 onclick 在模板字符串中的转义问题）
document.addEventListener('click', function(e){
  var btn = e.target.closest ? e.target.closest('.sec-mini span[data-st]') : null;
  if (btn) { toggleFilter(btn.getAttribute('data-grp'), btn.getAttribute('data-st')); return; }
  var tg = e.target.closest ? e.target.closest('.sec-toggle') : null;
  if (tg) { toggleCollapse(tg.getAttribute('data-key')); }
});
// 管理员：重载配置（POST，带 CSRF token；token 以 JSON 注入，避免 HTML/JS 转义问题）
var CSRF_TOKEN = ${csrfJson};
(function(){
  var b = document.getElementById('btnReload');
  if (!b) return;
  b.addEventListener('click', function(){
    if (!confirm('确定重新加载 config.json 配置？\\n\\n重载后下一轮巡检将使用新配置。')) return;
    b.disabled = true; b.textContent = '重载中…';
    fetch('/api/reload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': CSRF_TOKEN || '' },
      credentials: 'same-origin'
    }).then(function(r){ return r.json().then(function(j){ return { status: r.status, body: j }; }); })
      .then(function(res){
        if (res.status === 200 && res.body && res.body.ok) {
          b.textContent = '已重载';
          setTimeout(function(){ b.textContent = '重载配置'; b.disabled = false; poll(); }, 1600);
        } else if (res.status === 401) {
          location.href = '/login';
        } else {
          alert('重载失败：' + ((res.body && res.body.message) || ('HTTP ' + res.status)));
          b.textContent = '重载配置'; b.disabled = false;
        }
      }).catch(function(err){
        alert('重载请求失败：' + err);
        b.textContent = '重载配置'; b.disabled = false;
      });
  });
})();
poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>`;
}

module.exports = { renderBigScreen };
