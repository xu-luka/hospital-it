'use strict';
/**
 * P1「采集扩容 + textfile 自定义指标」自测
 *
 * 用法：node scripts/exporter-extra-selftest.js
 *
 * 覆盖三类容易悄悄坏掉的地方：
 *   1. 白名单：只认 his_ 前缀，标签展开成独立序列，中文名/单位从 # HELP 带过来；
 *   2. counter 差分：磁盘 IOPS/延迟、网络错包、上下文切换，重启回退不能算负值；
 *   3. 端到端：真起 HTTP 端点按请求次数返回不同计数，验证结果结构、报表区块、
 *      以及「第二次采样失败时静态指标 + textfile 仍然要有」。
 */
const http = require('http');
const path = require('path');
const E = require(path.join(__dirname, '..', 'src', 'inspection', 'lib', 'exporter'));
const { renderReport, evaluateResult } = require(path.join(__dirname, '..', 'src', 'inspection', 'lib', 'report'));
const { DEFAULT_THRESHOLDS } = require(path.join(__dirname, '..', 'src', 'inspection', 'inspect'));

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; return; }
  fails.push(tag + (extra !== undefined && extra !== '' ? '  → ' + extra : ''));
}
function eq(tag, a, b) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  ok(tag, x === y, '期望 ' + y + ' 实际 ' + x);
}
function near(tag, a, b, tol) {
  ok(tag, a !== null && a !== undefined && Math.abs(Number(a) - Number(b)) <= tol,
    '期望 ' + b + '±' + tol + ' 实际 ' + a);
}
function has(tag, text, sub) {
  ok(tag, String(text === null || text === undefined ? '' : text).indexOf(sub) >= 0,
    '应包含「' + sub + '」实际：' + String(text).slice(0, 200));
}
function none(tag, text, sub) {
  ok(tag, String(text || '').indexOf(sub) < 0, '不应包含「' + sub + '」');
}
function group(t) { console.log('\n== ' + t); }

/* ---------------- 1. # HELP / textfile 白名单 ---------------- */
group('# HELP 与 textfile 白名单（纯函数）');
{
  const text = [
    '# HELP his_settlement_latency_ms 医保结算平均耗时|ms',
    '# TYPE his_settlement_latency_ms gauge',
    'his_settlement_latency_ms{item="2207"} 342.5',
    'his_settlement_latency_ms{item="2201"} 120',
    '# HELP his_his_connections HIS 数据库连接数',
    'his_his_connections 87',
    '# HELP his_backup_age_hours 上次备份距今|h',
    'his_backup_age_hours 3',
    '# HELP his_cert_days_left 证书剩余天数|天',
    'his_cert_days_left 26',
    'my_custom_thing 9',
    'windows_system_threads 2100',
    '# HELP ignored_only 只有 HELP 没有样本',
    ''
  ].join('\n');
  const helps = E.parseHelps(text);
  eq('HELP 取到中文名+单位', helps.his_settlement_latency_ms, '医保结算平均耗时|ms');
  eq('HELP 无竖线也解析', helps.his_his_connections, 'HIS 数据库连接数');
  ok('没有 HELP 的指标不出现在 helps 里', !helps.windows_system_threads);

  const tf = E.textfileMetrics(E.parseMetrics(text), helps, E.TEXTFILE_PREFIX);
  const byKey = (k) => tf.items.find((x) => x.key === k) || {};
  eq('只收白名单前缀，共 5 条序列', tf.items.length, 5);
  ok('同名不同标签展开成两个独立 key',
    !!byKey('his_settlement_latency_ms{item=2201}').key && !!byKey('his_settlement_latency_ms{item=2207}').key);
  eq('按 key 排序，序列稳定（P2 趋势用）', tf.items[0].key, 'his_backup_age_hours');
  eq('中文显示名来自 HELP', byKey('his_settlement_latency_ms{item=2207}').name, '医保结算平均耗时');
  eq('单位来自 HELP 竖线后', byKey('his_settlement_latency_ms{item=2207}').unit, 'ms');
  eq('数值保留 3 位小数', byKey('his_settlement_latency_ms{item=2207}').value, 342.5);
  eq('无竖线时单位按后缀推断', byKey('his_backup_age_hours').unit, 'h');
  eq('无竖线时显示名仍取 HELP', byKey('his_backup_age_hours').name, '上次备份距今');
  eq('HELP 指定了单位时优先于后缀推断', byKey('his_cert_days_left').unit, '天');
  ok('显示元数据 name/unit 不进唯一键',
    !('name' in byKey('his_settlement_latency_ms{item=2207}').labels) && !('unit' in byKey('his_settlement_latency_ms{item=2207}').labels));
  eq('非白名单指标被点名', tf.ignored, ['my_custom_thing']);
  eq('截断计数为 0', tf.truncated, 0);

  const custom = E.textfileMetrics(E.parseMetrics(text), helps, 'biz_');
  eq('前缀可覆盖：换前缀后一条都不采', custom.items.length, 0);

  // 上限：造 60 条，只留 50 条，其余进 truncated
  const many = [];
  for (let i = 0; i < 60; i++) many.push('his_metric_' + i + ' ' + i);
  const cap = E.textfileMetrics(E.parseMetrics(many.join('\n')), {}, E.TEXTFILE_PREFIX);
  eq('上限 50 条', cap.items.length, 50);
  eq('超出部分被计数', cap.truncated, 10);
  ok('目录常量已导出且非空', E.METRIC_CATALOG.length >= 5 && E.COUNTER_CATALOG.length >= 2);
}

/* ---------------- 2. counter 差分 ---------------- */
group('counter 差分（纯函数）');
{
  const a = E.parseMetrics([
    'windows_system_context_switches_total 50000',
    'windows_logical_disk_reads_total{volume="C:"} 1000',
    'windows_logical_disk_writes_total{volume="C:"} 500',
    'windows_logical_disk_read_seconds_total{volume="C:"} 10',
    'windows_logical_disk_write_seconds_total{volume="C:"} 5',
    'windows_logical_disk_read_bytes_total{volume="C:"} 104857600',
    'windows_logical_disk_write_bytes_total{volume="C:"} 52428800'
  ].join('\n'));
  const b = E.parseMetrics([
    'windows_system_context_switches_total 50500',
    'windows_logical_disk_reads_total{volume="C:"} 1100',
    'windows_logical_disk_writes_total{volume="C:"} 560',
    'windows_logical_disk_read_seconds_total{volume="C:"} 10.5',
    'windows_logical_disk_write_seconds_total{volume="C:"} 5.6',
    'windows_logical_disk_read_bytes_total{volume="C:"} 105906176',
    'windows_logical_disk_write_bytes_total{volume="C:"} 52953088'
  ].join('\n'));
  const spec = { key: 'context_switches_total', names: ['windows_system_context_switches_total'] };
  eq('上下文切换 500/秒', E.counterRate(a, b, spec, 1000), 500);
  const d = E.diskRates(a, b, 1000);
  eq('磁盘按卷出一行', Object.keys(d), ['C:']);
  eq('读 IOPS = 100', d['C:'].read_iops, 100);
  eq('写 IOPS = 60', d['C:'].write_iops, 60);
  eq('读延迟 = 5ms', d['C:'].read_latency_ms, 5);
  eq('写延迟 = 10ms', d['C:'].write_latency_ms, 10);
  eq('读吞吐 = 1024 KB/s', d['C:'].read_kbps, 1024);
  eq('写吞吐 = 512 KB/s', d['C:'].write_kbps, 512);

  const back = E.parseMetrics('windows_logical_disk_reads_total{volume="C:"} 900');
  eq('计数器回退不产生负 IOPS', E.diskRates(a, back, 1000)['C:'].read_iops, 0);
  eq('计数器回退不产生负速率', E.counterRate(a, E.parseMetrics('windows_system_context_switches_total 49900'), spec, 1000), null);
  eq('完全没开 IO 收集器时不硬造 0', E.diskRates(E.parseMetrics('windows_cpu_cores 8'), E.parseMetrics('windows_cpu_cores 8'), 1000), {});
  const multi = E.parseMetrics('windows_system_context_switches_total{core="0"} 10\nwindows_system_context_switches_total{core="1"} 10');
  eq('序列数变化作废（不编造速率）', E.counterRate(a, multi, spec, 1000), null);
  const old = E.parseMetrics('windows_system_context_switches 50500');
  const oldA = E.parseMetrics('windows_system_context_switches 50000');
  eq('旧指标名兜底', E.counterRate(oldA, old, { names: ['windows_system_context_switches_total', 'windows_system_context_switches'] }, 1000), 500);
}

/* ---------------- 3. 真 HTTP 端到端 ---------------- */
group('真 HTTP 端点 · 两次采样');

function buildText(round) {
  const r2 = round === 2;
  const L = [];
  const bootTs = Math.floor(Date.now() / 1000) - 3600;
  // 0.32.1 真实指标名：每个 core 每个 mode 一条；开机时刻去掉 _seconds。
  // 主路径必须用真名，否则自测全绿、真实机器 CPU 恒为 null。
  L.push('# HELP windows_cpu_time_seconds_total CPU time');
  for (const core of ['0', '1']) {
    L.push('windows_cpu_time_seconds_total{core="' + core + '",mode="idle"} ' + (r2 ? 53 : 50));
    L.push('windows_cpu_time_seconds_total{core="' + core + '",mode="user"} ' + (r2 ? 27 : 25));
    L.push('windows_cpu_time_seconds_total{core="' + core + '",mode="privileged"} ' + (r2 ? 6 : 5));
  }
  L.push('windows_cpu_logical_processor 8');
  L.push('windows_os_hostname{hostname="TEST-HIS-01"} 1');
  L.push('windows_os_info{product="Windows Server 2019",version="10.0.17763"} 1');
  L.push('windows_system_boot_time_timestamp ' + bootTs);
  L.push('windows_system_processes 120');
  L.push('windows_system_threads 2100');
  L.push('windows_system_handle_count 45000');
  L.push('windows_system_processor_queue_length 2');
  L.push('windows_system_context_switches_total ' + (r2 ? 50500 : 50000));
  L.push('windows_memory_physical_total_bytes 8589934592');
  L.push('windows_memory_available_bytes 2147483648');
  L.push('windows_memory_cache_bytes 1073741824');
  L.push('windows_memory_committed_bytes 4294967296');
  L.push('windows_memory_commit_limit_bytes 8589934592');
  L.push('windows_memory_page_faults_total ' + (r2 ? 1100 : 1000));
  L.push('windows_logical_disk_size_bytes{volume="C:"} 107374182400');
  L.push('windows_logical_disk_free_bytes{volume="C:"} 42949672960');
  L.push('windows_logical_disk_reads_total{volume="C:"} ' + (r2 ? 1100 : 1000));
  L.push('windows_logical_disk_writes_total{volume="C:"} ' + (r2 ? 560 : 500));
  L.push('windows_logical_disk_read_seconds_total{volume="C:"} ' + (r2 ? 10.5 : 10));
  L.push('windows_logical_disk_write_seconds_total{volume="C:"} ' + (r2 ? 5.6 : 5));
  L.push('windows_logical_disk_read_bytes_total{volume="C:"} ' + (r2 ? 105906176 : 104857600));
  L.push('windows_logical_disk_write_bytes_total{volume="C:"} ' + (r2 ? 52953088 : 52428800));
  L.push('windows_net_bytes_received_total{nic="eth0"} ' + (r2 ? 1102400 : 1000000));
  L.push('windows_net_bytes_sent_total{nic="eth0"} ' + (r2 ? 2051200 : 2000000));
  L.push('windows_net_packets_received_discarded_total{nic="eth0"} ' + (r2 ? 3 : 1));
  L.push('windows_net_packets_outbound_discarded_total{nic="eth0"} ' + (r2 ? 1 : 0));
  L.push('windows_net_packets_received_errors_total{nic="eth0"} ' + (r2 ? 5 : 2));
  L.push('windows_net_packets_outbound_errors_total{nic="eth0"} ' + (r2 ? 2 : 0));
  L.push('windows_net_current_bandwidth_bytes{nic="eth0"} 125000000'); // = 1 Gbps
  L.push('windows_net_bytes_received_total{nic="Loopback Pseudo-Interface 1"} ' + (r2 ? 9999 : 1));
  L.push('windows_service_state{service="Spooler",state="running"} 1');
  L.push('# HELP his_settlement_latency_ms 医保结算平均耗时|ms');
  L.push('his_settlement_latency_ms{item="2207"} 342.5');
  L.push('his_settlement_latency_ms{item="2201"} 120');
  L.push('# HELP his_his_connections HIS 数据库连接数');
  L.push('his_his_connections 87');
  L.push('# HELP his_backup_age_hours 上次备份距今|h');
  L.push('his_backup_age_hours 3');
  L.push('# HELP his_cert_days_left 证书剩余天数|天');
  L.push('his_cert_days_left 26');
  L.push('my_custom_thing 9');
  return L.join('\n') + '\n';
}

function endpoint(opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let hits = 0;
    const srv = http.createServer((req, res) => {
      hits++;
      if (o.failSecond && hits >= 2) { res.statusCode = 500; res.end('boom'); return; }
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.end(buildText(hits === 1 ? 1 : 2));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, hits: () => hits }));
  });
}
const close = (s) => new Promise((r) => { try { s.close(() => r()); } catch (e) { r(); } });

async function main() {
  const s = await endpoint();
  const server = {
    host: '127.0.0.1', port: s.port, protocol: 'http', auth: { type: 'exporter' },
    services: [{ type: 'auto', name: 'Spooler' }],
    custom_commands: [{ name: '旧检查', command: 'dir C:\\' }]
  };
  const r = await E.collectExporter(server, 8000);
  eq('采集成功', r.ok, true);
  eq('确实抓了两次', s.hits(), 2);
  eq('通道标记', r.channel, 'exporter');
  near('CPU 差分 50%', r.metrics.cpu_percent, 50, 1);
  eq('内存总量 8192 MB', r.metrics.mem_total_mb, 8192);
  eq('磁盘分区仍过滤 _Total', r.metrics.disks.length, 1);
  eq('环回网卡仍被过滤', r.metrics.net.length, 1);
  eq('服务检查仍有效', r.services[0].running, true);

  group('扩展指标 extra');
  ok('extra 存在', !!r.extra);
  eq('两次采样标记', r.extra.sampled_twice, true);
  eq('系统线程数', r.extra.system.threads, 2100);
  eq('句柄数', r.extra.system.handles, 45000);
  eq('处理器队列', r.extra.system.processor_queue_length, 2);
  near('上下文切换/秒', r.extra.system.context_switches_per_sec, 500, 20);
  eq('内存提交 4096 MB', r.extra.memory.committed_mb, 4096);
  eq('提交上限 8192 MB', r.extra.memory.commit_limit_mb, 8192);
  eq('提交使用率 50%', r.extra.memory.commit_percent, 50);
  eq('缓存 1024 MB', r.extra.memory.cache_mb, 1024);
  near('缺页/秒', r.extra.memory.page_faults_per_sec, 100, 10);
  near('磁盘读 IOPS', r.extra.disks[0].read_iops, 100, 5);
  near('磁盘读延迟 ms', r.extra.disks[0].read_latency_ms, 5, 0.5);
  near('磁盘读吞吐 KB/s', r.metrics.diskio[0].r_kbps, 1024, 40);
  near('磁盘写吞吐 KB/s', r.metrics.diskio[0].w_kbps, 512, 20);
  eq('diskio 直接喂给旧报表表格', r.metrics.diskio.length, 1);
  eq('接收错包差分', r.extra.net[0].rx_errors, 3);
  eq('发送错包差分', r.extra.net[0].tx_errors, 2);
  eq('发送丢包差分', r.extra.net[0].tx_drops, 1);
  eq('带宽 1 Gbps', r.extra.net[0].bandwidth_bps, 1000000000);
  ok('带宽利用率有值且合理', r.extra.net[0].util_pct > 0 && r.extra.net[0].util_pct < 5,
    r.extra.net[0].util_pct);
  eq('errs 口径保持原样（只算接收丢弃包）', r.metrics.net[0].errs, 2);
  eq('drops 口径保持原样', r.metrics.net[0].drops, 2);

  group('textfile 自定义指标');
  eq('customs 5 条', r.customs.length, 5);
  eq('extra.textfile 与 customs 同源', r.extra.textfile.length, 5);
  const c0 = r.customs.find((c) => c.key === 'his_settlement_latency_ms{item=2207}');
  ok('按 key 能找到序列', !!c0);
  eq('中文名', c0 && c0.name, '医保结算平均耗时');
  eq('输出带单位', c0 && c0.output, '342.5 ms');
  eq('source 标记', c0 && c0.source, 'textfile');
  eq('code 保持 0（报表老结构）', c0 && c0.code, 0);
  eq('证书单位来自 HELP', (r.customs.find((c) => c.key === 'his_cert_days_left') || {}).unit, '天');
  has('note 报告 textfile 条数', r.note, 'textfile 自定义指标 5 条');
  has('note 点名非白名单指标', r.note, 'my_custom_thing');
  has('note 说明自定义命令被跳过', r.note, '1 条自定义命令未执行');
  has('note 提示改用 textfile', r.note, 'his_ 前缀');
  ok('没有执行任何远程命令', String(r.note).indexOf('dir C:') < 0);

  group('报表渲染');
  const rr = Object.assign({}, r, { name: 'HIS-DB01', host: '127.0.0.1', kind: 'windows' });
  evaluateResult(rr, DEFAULT_THRESHOLDS);
  const html = renderReport([rr], { thresholds: DEFAULT_THRESHOLDS });
  has('报表有扩展指标区块', html, '扩展指标（windows_exporter）');
  has('报表有磁盘 IOPS 表', html, '磁盘 IOPS 与平均延迟');
  has('报表有网络错包表', html, '网络错包与带宽利用率');
  has('报表有 textfile 指标表', html, '自定义指标（textfile，共 5 条）');
  has('报表显示中文指标名', html, '医保结算平均耗时');
  has('报表显示采集键', html, 'his_settlement_latency_ms{item=2207}');
  has('报表仍有原来的磁盘 IO 表', html, '磁盘 IO（KB/s）');
  none('textfile 不再被标成自定义命令', html, '自定义命令：');
  eq('evaluateResult 仍只按原字段判定', rr.status, 'warning');
  has('判定原因仍是原有 errs 口径', JSON.stringify(rr.reasons), '错包/丢包');

  group('第二次采样失败降级');
  const s2 = await endpoint({ failSecond: true });
  const r2 = await E.collectExporter(Object.assign({}, server, { port: s2.port }), 8000);
  eq('整体仍算成功（静态指标还有价值）', r2.ok, true);
  eq('sampled_twice = false', r2.extra.sampled_twice, false);
  eq('CPU 不再编造', r2.metrics.cpu_percent, null);
  eq('diskio 为空', r2.metrics.diskio.length, 0);
  eq('net 为空', r2.metrics.net.length, 0);
  eq('磁盘容量仍在', r2.metrics.disks.length, 1);
  eq('★ textfile 指标仍在', r2.customs.length, 5);
  eq('★ extra.textfile 仍在', r2.extra.textfile.length, 5);
  eq('线程数等静态指标仍在', r2.extra.system.threads, 2100);
  has('note 说明降级', r2.note, '第二次采样失败');

  await close(s.srv);
  await close(s2.srv);

  console.log('\n===================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    fails.forEach((f) => console.log('  [FAIL] ' + f));
    process.exitCode = 1;
  } else {
    console.log('ALL OK');
  }
}

main().catch((e) => {
  console.error('自测异常：', e && e.stack || e);
  process.exitCode = 1;
});
