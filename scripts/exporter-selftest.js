'use strict';
/**
 * windows_exporter 采集通道自测
 *
 * 为什么不用「塞一段固定文本给 parseMetrics」就完事：
 * 这条通道真正容易出错的地方在**两次采样之间的换算**（counter 差分、网卡过滤、
 * 收集器没开时不能把「查不到」当成「服务没跑」）。这些只有在真起一个 HTTP 服务、
 * 按请求次数返回不同计数时才能验证。
 *
 * 用法：node scripts/exporter-selftest.js
 */

const http = require('http');
const { collectExporter, parseMetrics, parseLabels } = require('../src/inspection/lib/exporter');
const inspect = require('../src/inspection/inspect');

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond, extra) {
  if (cond) { pass++; return; }
  fail++;
  fails.push(name + (extra ? '  → ' + extra : ''));
}
function eq(name, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) { pass++; return; }
  fail++;
  fails.push(name + '  期望 ' + e + ' 实际 ' + a);
}
function near(name, actual, expect, tol) {
  if (actual === null || actual === undefined) {
    fail++;
    fails.push(name + '  期望约 ' + expect + ' 实际 null');
    return;
  }
  if (Math.abs(Number(actual) - Number(expect)) <= tol) { pass++; return; }
  fail++;
  fails.push(name + '  期望约 ' + expect + '±' + tol + ' 实际 ' + actual);
}
function contains(name, text, sub) {
  const t = String(text === null || text === undefined ? '' : text);
  if (t.indexOf(sub) >= 0) { pass++; return; }
  fail++;
  fails.push(name + '  应包含「' + sub + '」实际：' + t.slice(0, 160));
}
function group(t) { console.log('\n== ' + t); }

/* ---------------- 模拟端点 ---------------- */

/**
 * round=1 第一次采样，round=2 第二次采样（计数递增，用来验证差分）
 * opts 控制各种残缺场景
 */
function buildText(round, opts) {
  const o = opts || {};
  const r2 = round === 2;
  const lines = [];
  // 开机时刻按「当前时间 - 3600」动态算：脚本要跑十几秒，
  // 写成模块级常量会让后面几组用例的 uptime 越算越大，误判成失败
  const bootTs = Math.floor(Date.now() / 1000) - 3600;

  if (!o.empty) {
    lines.push('# HELP windows_cpu_time_total Time processor has spent in different modes');
    lines.push('# TYPE windows_cpu_time_total counter');
    // r1 total = 163，r2 total = 175，idle 差 6 / 总差 12 → 50%
    const idle = r2 ? 106 : 100;
    const user = r2 ? 54 : 50;
    const priv = r2 ? 12 : 10;
    lines.push('windows_cpu_time_total{mode="idle"} ' + idle);
    lines.push('windows_cpu_time_total{mode="user"} ' + user);
    lines.push('windows_cpu_time_total{mode="privileged"} ' + priv);
    lines.push('windows_cpu_time_total{mode="interrupt"} 2');
    lines.push('windows_cpu_time_total{mode="dpc"} 1');
    lines.push('windows_cpu_cores 8');
    lines.push('windows_system_processes 120');

    if (o.oldNames) {
      lines.push('windows_system_system_up_time ' + bootTs);
      lines.push('windows_os_hostname{hostname="TEST-HIS-01"} 1');
    } else {
      lines.push('windows_system_boot_time_timestamp_seconds ' + bootTs);
      lines.push('windows_cs_hostname{hostname="TEST-HIS-01"} 1');
      lines.push('windows_os_info{product="Microsoft Windows Server 2016 Standard",version="10.0.14393"} 1');
    }

    lines.push('windows_cs_physical_memory_bytes 8589934592');
    if (o.noMemoryCollector) {
      lines.push('windows_os_free_physical_memory_bytes 2147483648');
    } else {
      lines.push('windows_memory_available_bytes 2147483648');
    }

    if (!o.noDiskCollector) {
      lines.push('windows_logical_disk_size_bytes{volume="C:"} 107374182400');
      lines.push('windows_logical_disk_free_bytes{volume="C:"} 42949672960');
      // 下面两条必须被过滤：合计行与无盘符的卷
      lines.push('windows_logical_disk_size_bytes{volume="_Total"} 107374182400');
      lines.push('windows_logical_disk_free_bytes{volume="_Total"} 42949672960');
      lines.push('windows_logical_disk_size_bytes{volume="HarddiskVolume1"} 1048576');
      lines.push('windows_logical_disk_free_bytes{volume="HarddiskVolume1"} 524288');
    }

    const rx = r2 ? 1000000 + 102400 : 1000000;
    const tx = r2 ? 2000000 + 51200 : 2000000;
    lines.push('windows_net_bytes_received_total{nic="eth0"} ' + rx);
    lines.push('windows_net_bytes_sent_total{nic="eth0"} ' + tx);
    lines.push('windows_net_packets_received_discarded_total{nic="eth0"} ' + (r2 ? 3 : 1));
    // 环回接口流量再大也必须被过滤掉
    lines.push('windows_net_bytes_received_total{nic="Loopback Pseudo-Interface 1"} ' + (r2 ? 999999999 : 1));

    if (!o.noServiceCollector) {
      lines.push('windows_service_state{name="Spooler",state="running"} 1');
      lines.push('windows_service_state{name="Spooler",state="stopped"} 0');
      lines.push('windows_service_state{name="MSSQLSERVER",state="stopped"} 1');
      lines.push('windows_service_state{name="MSSQLSERVER",state="running"} 0');
    }
  }
  return lines.join('\n') + '\n';
}

function startServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv: srv, port: srv.address().port }));
  });
}
function closeServer(srv) {
  return new Promise((r) => { try { srv.close(() => r()); } catch (e) { r(); } });
}

/** 起一个标准的 /metrics 端点，返回 { srv, port, hits() } */
async function standardEndpoint(opts, handlerOverride) {
  let hits = 0;
  const wrap = (req, res) => {
    hits++;
    if (handlerOverride) return handlerOverride(req, res, hits);
    if (req.url.split('?')[0] !== '/metrics') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    res.end(buildText(hits === 1 ? 1 : 2, opts));
  };
  const s = await startServer(wrap);
  s.hits = () => hits;
  return s;
}

function serverObj(port, extra) {
  return Object.assign({
    name: 'test-win',
    host: '127.0.0.1',
    os: 'windows',
    port: port,
    auth: { type: 'exporter' }
  }, extra || {});
}

/* ---------------- 1. 文本解析 ---------------- */

function testParse() {
  group('1. Prometheus 文本解析');

  const m = parseMetrics([
    '# HELP windows_cpu_time_total blah',
    '# TYPE windows_cpu_time_total counter',
    'windows_cpu_time_total{mode="idle"} 12345.5',
    'windows_cpu_cores 8',
    'windows_os_info{product="Windows Server 2016",version="10.0.14393"} 1',
    '',
    'windows_bad_value NaN',
    'windows_bad_value2 +Inf',
    'windows_no_value',
    '   ',
    'windows_escaped{path="C:\\\\tmp\\\\a",note="say \\"hi\\""} 1'
  ].join('\n'));

  eq('带标签 counter 取值', m.get('windows_cpu_time_total')[0].value, 12345.5);
  eq('标签 mode', m.get('windows_cpu_time_total')[0].labels.mode, 'idle');
  eq('无标签 gauge 取值', m.get('windows_cpu_cores')[0].value, 8);
  eq('多标签解析', m.get('windows_os_info')[0].labels.product, 'Windows Server 2016');
  ok('NaN 被丢弃', !m.has('windows_bad_value'), '不应存在');
  ok('+Inf 被丢弃', !m.has('windows_bad_value2'), '不应存在');
  ok('无值的行被丢弃', !m.has('windows_no_value'), '不应存在');
  eq('转义反斜杠', m.get('windows_escaped')[0].labels.path, 'C:\\tmp\\a');
  eq('转义引号', m.get('windows_escaped')[0].labels.note, 'say "hi"');

  eq('parseLabels 空串', parseLabels(''), {});
  eq('parseLabels 单键', parseLabels('a="1"'), { a: '1' });
  eq('parseMetrics 空输入', parseMetrics('').size, 0);
  eq('parseMetrics null 输入', parseMetrics(null).size, 0);
}

/* ---------------- 2. 正常端到端 ---------------- */

async function testNormal() {
  group('2. 正常采集（两次采样差分）');

  const ep = await standardEndpoint();
  const r = await collectExporter(serverObj(ep.port, {
    services: [{ type: 'service', name: 'Spooler' }, { type: 'auto', name: 'MSSQLSERVER' }, { type: 'service', name: 'NotExist' }]
  }), 15000);
  await closeServer(ep.srv);

  eq('ok', r.ok, true);
  eq('两次请求都打到端点', ep.hits(), 2);
  eq('主机名', r.metrics.hostname, 'TEST-HIS-01');
  eq('系统名', r.metrics.os, 'Microsoft Windows Server 2016 Standard');
  eq('内核版本', r.metrics.kernel, '10.0.14393');
  eq('逻辑核数', r.metrics.cores, 8);
  eq('进程数', r.metrics.procs, 120);
  ok('开机时长约 3600 秒', Math.abs(r.metrics.uptime_sec - 3600) <= 5, '实际 ' + r.metrics.uptime_sec);

  eq('CPU 使用率 50%', r.metrics.cpu_percent, 50);

  eq('内存总量 MB', r.metrics.mem_total_mb, 8192);
  eq('内存已用 MB', r.metrics.mem_used_mb, 6144);
  eq('内存使用率 75%', r.metrics.mem_percent, 75);

  eq('磁盘只保留真实盘符', r.metrics.disks.length, 1);
  eq('磁盘挂载点', r.metrics.disks[0].mount, 'C:');
  eq('磁盘容量 MB', r.metrics.disks[0].size_mb, 102400);
  eq('磁盘使用率', r.metrics.disks[0].use_percent, 60);

  eq('网卡只保留物理接口', r.metrics.net.length, 1);
  eq('网卡名', r.metrics.net[0].iface, 'eth0');
  near('接收速率 KB/s', r.metrics.net[0].rx_kbps, 100, 15);
  near('发送速率 KB/s', r.metrics.net[0].tx_kbps, 50, 10);
  eq('丢包增量', r.metrics.net[0].errs, 2);

  eq('服务检查项数', r.services.length, 3);
  eq('Spooler 在跑', r.services[0].running, true);
  eq('auto 类型按服务判定（MSSQLSERVER 已停）', r.services[1].running, false);
  eq('不存在的服务判为未运行', r.services[2].running, false);
  contains('不存在服务的说明', r.services[2].detail, '未在 exporter 中查到');
  eq('自定义命令结果为空', r.customs, []);
  eq('事件日志计数不参与判定（null）', r.metrics.log_errors, null);
  eq('通道标识', r.channel, 'exporter');
}

/* ---------------- 3. 残缺场景 ---------------- */

async function testDegraded() {
  group('3. 收集器缺失 / 命令不可执行');

  // 3.1 service 收集器没开：不能把「查不到」当成「服务没跑」
  const ep1 = await standardEndpoint({ noServiceCollector: true });
  const r1 = await collectExporter(serverObj(ep1.port, {
    services: [{ type: 'service', name: 'Spooler' }]
  }), 15000);
  await closeServer(ep1.srv);
  eq('无 service 收集器时 ok', r1.ok, true);
  eq('无 service 收集器时不出服务项', r1.services.length, 0);
  contains('提示未启用 service 收集器', r1.note, '未启用 service 收集器');

  // 3.2 配了自定义命令：跳过并说明
  const ep2 = await standardEndpoint();
  const r2 = await collectExporter(serverObj(ep2.port, {
    customs: [{ name: '磁盘', command: 'dir' }]
  }), 15000);
  await closeServer(ep2.srv);
  eq('自定义命令结果为空', r2.customs.length, 0);
  contains('提示自定义命令未执行', r2.note, '不支持远程执行命令');

  // 3.3 进程/端口类检查项：跳过并说明
  const ep3 = await standardEndpoint();
  const r3 = await collectExporter(serverObj(ep3.port, {
    services: [{ type: 'process', name: 'sqlservr' }, { type: 'port', name: '1433' }]
  }), 15000);
  await closeServer(ep3.srv);
  eq('进程/端口检查项被跳过', r3.services.length, 0);
  contains('提示进程端口不支持', r3.note, '只支持按服务名检查');

  // 3.4 磁盘收集器没开：disks 为空但不该报错
  const ep4 = await standardEndpoint({ noDiskCollector: true });
  const r4 = await collectExporter(serverObj(ep4.port), 15000);
  await closeServer(ep4.srv);
  eq('无磁盘收集器时 ok', r4.ok, true);
  eq('无磁盘收集器时 disks 为空', r4.metrics.disks.length, 0);

  // 3.5 没装 memory 收集器，退回 os 的空闲内存指标
  const ep5 = await standardEndpoint({ noMemoryCollector: true });
  const r5 = await collectExporter(serverObj(ep5.port), 15000);
  await closeServer(ep5.srv);
  eq('缺 memory 收集器时仍能算内存率', r5.metrics.mem_percent, 75);
}

/* ---------------- 4. 错误分支 ---------------- */

async function testErrors() {
  group('4. 错误分支');

  // 4.1 路径不存在
  const ep1 = await standardEndpoint(null, (req, res) => { res.statusCode = 404; res.end('no'); });
  const r1 = await collectExporter(serverObj(ep1.port), 8000);
  await closeServer(ep1.srv);
  eq('404 判失败', r1.ok, false);
  contains('404 错误信息', r1.error, 'HTTP 404');
  contains('404 提示检查安装与防火墙', r1.error, '防火墙放行');

  // 4.2 端点要求认证
  const ep2 = await standardEndpoint(null, (req, res) => { res.statusCode = 401; res.end('auth'); });
  const r2 = await collectExporter(serverObj(ep2.port), 8000);
  await closeServer(ep2.srv);
  eq('401 判失败', r2.ok, false);
  contains('401 提示 Basic 认证', r2.error, 'Basic');

  // 4.3 9182 被别的 HTTP 服务占了（返回 HTML）
  const ep3 = await startServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<html>hello</html>'); });
  const r3 = await collectExporter(serverObj(ep3.port), 8000);
  await closeServer(ep3.srv);
  eq('非指标内容判失败', r3.ok, false);
  contains('提示端口被占用', r3.error, '不是 Prometheus 指标');

  // 4.4 端口没人监听
  const tmp = await startServer((req, res) => res.end('x'));
  const deadPort = tmp.port;
  await closeServer(tmp.srv);
  const r4 = await collectExporter(serverObj(deadPort), 8000);
  eq('连接被拒判失败', r4.ok, false);
  contains('连接失败信息', r4.error, '失败');

  // 4.5 缺主机地址
  const r5 = await collectExporter({ host: '', auth: { type: 'exporter' } }, 8000);
  eq('空 host 判失败', r5.ok, false);
  contains('空 host 提示', r5.error, '缺少主机地址');
}

/* ---------------- 5. 版本兼容 ---------------- */

async function testOldNames() {
  group('5. 旧版指标名兼容（0.29 及更早）');

  const ep = await standardEndpoint({ oldNames: true });
  const r = await collectExporter(serverObj(ep.port), 15000);
  await closeServer(ep.srv);

  eq('旧版 ok', r.ok, true);
  ok('旧版开机时间可换算', Math.abs(r.metrics.uptime_sec - 3600) <= 5, '实际 ' + r.metrics.uptime_sec);
  eq('旧版主机名走 windows_os_hostname', r.metrics.hostname, 'TEST-HIS-01');
  contains('提示升级版本', r.note, '旧版 windows_exporter');
}

/* ---------------- 6. Basic 认证 ---------------- */

async function testBasicAuth() {
  group('6. Basic 认证（端点开了 web.config 时）');

  const seen = [];
  const ep = await standardEndpoint(null, (req, res, hits) => {
    seen.push(req.headers.authorization || '');
    if (!req.headers.authorization) { res.statusCode = 401; res.end('need auth'); return; }
    res.setHeader('Content-Type', 'text/plain');
    res.end(buildText(hits === 1 ? 1 : 2, {}));
  });
  const r = await collectExporter(serverObj(ep.port, {
    auth: { type: 'exporter', username: 'monitor', password: 'p@ss' }
  }), 15000);
  await closeServer(ep.srv);

  eq('带凭据时成功', r.ok, true);
  const expected = 'Basic ' + Buffer.from('monitor:p@ss').toString('base64');
  eq('两次请求都带 Authorization', seen.length >= 2 && seen.every((h) => h === expected), true);
}

/* ---------------- 7. 接入调度 ---------------- */

async function testWiring() {
  group('7. 接入巡检调度与配置校验');

  // 7.1 exporter 不需要账号密码，不该报校验错
  eq('exporter 无凭据通过校验',
    inspect.validateServer({ name: 'a', host: '1.1.1.1', os: 'windows', auth: { type: 'exporter' } }, 0).length, 0);

  // 7.2 未知类型要报错，且错误信息里列出 exporter
  const bad = inspect.validateServer({ name: 'a', host: '1.1.1.1', os: 'windows', auth: { type: 'bogus' } }, 0);
  eq('未知认证方式报错', bad.length, 1);
  contains('错误信息列出 exporter', bad[0], 'exporter');

  // 7.3 inspectOne 真的把 exporter 分流到新通道
  const ep = await standardEndpoint();
  const r = await inspect.inspectOne(serverObj(ep.port), 15000);
  await closeServer(ep.srv);
  eq('inspectOne 走 exporter 通道', r.ok, true);
  eq('连接方式显示 exporter', r.connectLabel, 'exporter');
  eq('结果带通道标识', r.channel, 'exporter');
  eq('inspectOne 补了设备名', r.name, 'test-win');
  eq('inspectOne 补了系统标签', r.osLabel, 'Windows');
}

/* ---------------- 8. 台账往返 ---------------- */

/**
 * 用真库跑一遍「存进去 → 读出来 → 采集」：
 * validateWithKernel 会回头调用 inspect.validateServer，如果那边没放行 exporter，
 * 保存设备就会直接失败 —— 这一步不测，前端点保存时报错才发现就晚了。
 * 数据自己造自己删（物理删：测试设备没有历史记录引用）。
 */
async function testRepoRoundtrip() {
  group('8. 台账存取往返（真库）');

  const nodePath = require('path');
  process.chdir(nodePath.resolve(__dirname, '..'));
  const { init } = require('../src/db');
  const { db } = require('../src/db-contract');
  const repo = require('../src/inspection/device-repo');
  init();

  const ep = await standardEndpoint();
  let id = 0;
  try {
    const r = await repo.createDevice({
      name: 'selftest-exporter-通道',
      host: '127.0.0.1',
      os: 'windows',
      port: ep.port,
      protocol: 'http',
      auth_type: 'exporter',
      enabled: true,
      services: [{ type: 'service', name: 'Spooler' }],
      custom_commands: []
    }, null);

    ok('台账保存 exporter 设备成功', r.ok === true, r.errors);
    if (r.ok) {
      id = r.id;
      const row = repo.getRow(id);
      eq('落库 auth_type', row.auth_type, 'exporter');
      eq('落库 port', row.port, ep.port);
      eq('落库 protocol', row.protocol, 'http');

      const s = repo.toServer(row);
      eq('toServer 的 auth.type', s.auth.type, 'exporter');

      const res = await inspect.inspectOne(s, 15000);
      eq('从台账取出后能采集', res.ok, true);
      eq('从台账取出后连接方式', res.connectLabel, 'exporter');
      eq('从台账取出后能判服务', (res.services[0] || {}).running, true);

      /* 「监控方式」列读的是 publicView().connect_label（列表接口直接给前端显示），
         不是巡检结果里的 connectLabel —— 两处必须同一个名字，否则台账列和详情会对不上。 */
      eq('列表视图带 connect_label', repo.publicView(row).connect_label, 'exporter');
      eq('列表视图的 connect_label 与巡检结果一致', repo.publicView(row).connect_label, res.connectLabel);
      eq('没配通道时显示「未设置」而不是「SSH 密码」',
        repo.publicView({ os: 'windows', auth_type: '', db_engine: '' }).connect_label, '未设置');
    }
  } finally {
    if (id) db.prepare('DELETE FROM it_devices WHERE id=?').run(id);
    await closeServer(ep.srv);
  }

  if (id) {
    const gone = db.prepare('SELECT id FROM it_devices WHERE id=?').get(id);
    eq('测试数据已清理', gone, undefined);
  }
}

/* ---------------- 跑 ---------------- */

(async function run() {
  testParse();
  await testNormal();
  await testDegraded();
  await testErrors();
  await testOldNames();
  await testBasicAuth();
  await testWiring();
  await testRepoRoundtrip();

  console.log('\n────────────────────────────────────────');
  if (fail) {
    console.log('失败 ' + fail + ' 项：');
    fails.forEach((f) => console.log('  ✗ ' + f));
  }
  console.log('exporter-selftest：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('自测脚本异常：' + ((e && e.stack) || e));
  process.exitCode = 1;
});
