'use strict';
/**
 * exporter 兼容性 + 大屏卡片扩展摘要自测（离线，不连真实库、不起服务）。
 *
 * 背景：用户反馈「Windows - exporter 那几台卡片上只有一行内存」。
 * 一是 exporter.js 按 0.30 指标名写、目标机装的是 0.32.1，CPU / uptime /
 * 核数 / 服务 / 带宽全变 null；二是老卡片只画 CPU / 内存两条进度条，
 * P1 采到的扩展指标根本没地方显示。前者由 exporter-selftest 覆盖，
 * 后者（extraHint）在这里覆盖，并顺带钉死 0.32 的关键指标名不许被改回去。
 */
const fs = require('fs');
const path = require('path');
const scheduler = require('../src/inspection/scheduler');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.error('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) pass++;
  else { fail++; console.error('FAIL  ' + name + '  got=' + a + ' want=' + b); }
}

function exporterResult(over) {
  return Object.assign({
    name: 'HIS 数据库', host: '10.0.0.5', os: 'windows', osLabel: 'Windows',
    connectLabel: 'exporter', ok: true, status: 'normal', channel: 'exporter',
    metrics: {
      cpu_percent: 18.6, mem_percent: 43.4, cores: 8, uptime_sec: 1071360, procs: 210,
      disks: [{ mount: 'C:' }, { mount: 'D:' }], net: [{ iface: 'eth0' }], diskio: [{ dev: 'C:' }]
    },
    extra: {
      system: { threads: 2100, handles: 45000, processor_queue_length: 2 },
      memory: { available_mb: 2048 },
      textfile: [{ key: 'his_settle_ms', value: 342 }],
      sampled_twice: true
    },
    services: [{ running: true }, { running: true }, { running: false }]
  }, over || {});
}
function statusOf(results) {
  scheduler.state.results = results;
  return scheduler.buildStatus();
}

try {
  /* ---------- ① exporter 卡片摘要 ---------- */
  const st = statusOf([exporterResult()]);
  const d = st.devices[0];
  ok('设备仍在状态里', !!d);
  eq('CPU / 内存映射没被改坏', [d.cpu, d.mem], [18.6, 43.4]);
  ok('exporter 卡片有 extraHint', Array.isArray(d.extraHint) && d.extraHint.length > 0, d.extraHint);
  ok('扩展项计入 textfile', d.extraHint.some((x) => /^扩展 5 项$/.test(x)), d.extraHint);
  ok('显示核数', d.extraHint.indexOf('8 核') >= 0, d.extraHint);
  ok('开机时长按天显示', d.extraHint.indexOf('开机 12.4 天') >= 0, d.extraHint);
  ok('显示业务指标条数', d.extraHint.indexOf('业务指标 1') >= 0, d.extraHint);
  ok('显示服务在跑数', d.extraHint.indexOf('服务 2/3') >= 0, d.extraHint);
  ok('最多 6 个标签', d.extraHint.length <= 6, d.extraHint);
  ok('不出现 undefined / null 文案', d.extraHint.every((x) => !/undefined|null|NaN/.test(x)), d.extraHint);

  /* ---------- ② SSH / WMI 卡片版式不变 ---------- */
  const ssh = exporterResult({ channel: undefined, connectLabel: 'SSH 密码' });
  delete ssh.channel;
  delete ssh.extra;
  const st2 = statusOf([ssh]);
  eq('非 exporter 通道不生成摘要', st2.devices[0].extraHint, null);
  eq('非 exporter 的 CPU 仍正常', st2.devices[0].cpu, 18.6);

  /* ---------- ③ 边界：开机不足一天 / 空 extra / 采集失败 ---------- */
  const short = exporterResult({ metrics: { cpu_percent: 5, mem_percent: 20, uptime_sec: 7200 } });
  const st3 = statusOf([short]);
  ok('不足一天按小时显示', st3.devices[0].extraHint.some((x) => x === '开机 2 时'), st3.devices[0].extraHint);

  const empty = exporterResult({ extra: {}, metrics: { cpu_percent: 1, mem_percent: 2 }, services: [] });
  const st4 = statusOf([empty]);
  eq('extra 全空时不硬造摘要', st4.devices[0].extraHint, null);

  const failed = exporterResult({ ok: false, status: 'error', error: '连接失败' });
  const st5 = statusOf([failed]);
  eq('采集失败设备状态是 error', st5.devices[0].status, 'error');

  /* ---------- ④ 0.32.1 关键指标名不许被改回去 ---------- */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'inspection', 'lib', 'exporter.js'), 'utf8');
  const mustHave = [
    'windows_cpu_time_seconds_total',
    'windows_cpu_logical_processor',
    'windows_system_boot_time_timestamp',
    'windows_memory_commit_limit_bytes',
    'windows_net_current_bandwidth_bytes',
    'm.labels.service'
  ];
  for (const name of mustHave) ok('0.32 指标名已兼容：' + name, src.indexOf(name) >= 0);
  // 旧名也要留着，2008 R2 / 0.29 那批机器还在跑
  for (const name of ['windows_cpu_time_total', 'windows_system_system_up_time', 'windows_net_current_bandwidth']) {
    ok('旧版指标名仍兜底：' + name, src.indexOf(name) >= 0);
  }

  /* ---------- ⑤ 点「扩展 N 项」看到的明细 ---------- */
  const detailR = exporterResult({
    metrics: {
      cpu_percent: 18.6, mem_percent: 43.4, cores: 8, uptime_sec: 1071360, procs: 210,
      disks: [
        { mount: 'C:', size_mb: 204800, used_mb: 143360, use_percent: 70 },
        { mount: 'D:', size_mb: 512000, used_mb: 102400, use_percent: 20 }
      ],
      net: [{ iface: 'eth0', rx_kbps: 1200, tx_kbps: 800 }],
      diskio: [{ dev: 'C:', r_kbps: 340, w_kbps: 120 }]
    },
    extra: {
      system: { threads: 2100, handles: 45000, processor_queue_length: 2, context_switches_per_sec: 8123, processes: 210 },
      memory: { total_mb: 16384, used_mb: 7110, available_mb: 9274, committed_mb: 8100, commit_limit_mb: 20000, commit_percent: 40.5, page_faults_per_sec: 120 },
      disks: [{ mount: 'C:', read_iops: 88, write_iops: 34, read_latency_ms: 3.2, write_latency_ms: 5.1 }],
      net: [{ iface: 'eth0', rx_errors: 0, tx_errors: 0, bandwidth_bps: 1000000000, util_pct: 1.6 }],
      textfile: [{ key: 'his_settle_ms{item=门诊}', name: '医保结算平均耗时', value: 342.5, unit: 'ms', labels: { item: '门诊' } }],
      sampled_twice: true, gap_ms: 1012
    },
    services: [
      { name: 'MSSQLSERVER', running: true, detail: 'exporter: running' },
      { name: 'Spooler', running: false, detail: '未在 exporter 中查到该服务' }
    ],
    note: '采集到 textfile 自定义指标 1 条（白名单前缀 his_）'
  });
  const det = scheduler.extraDetailOf(detailR);
  const gOf = (t) => det.groups.find((g) => g.title === t) || { cols: [], rows: [] };
  const hasCell = (t, v) => gOf(t).rows.some((row) => row.indexOf(v) >= 0);
  const titles = det.groups.map((g) => g.title);
  for (const t of ['本轮采集', '系统扩展（windows_exporter）', '内存扩展', '磁盘（容量 / IOPS / 速率）',
    '网卡（速率 / 错包 / 带宽）', '服务检查', '业务指标（textfile）']) {
    ok('明细分组存在：' + t, titles.indexOf(t) >= 0, titles);
  }
  const hintN = Number(String((scheduler.extraHintOf(detailR) || [''])[0]).replace(/\D/g, ''));
  eq('明细计数与摘要「扩展 N 项」同源', det.meta.count, hintN);
  ok('开机时长进明细', hasCell('本轮采集', '12.4 天'), gOf('本轮采集').rows);
  ok('线程数带中文名与单位', hasCell('系统扩展（windows_exporter）', '2100 个'));
  ok('提交内存进明细', hasCell('内存扩展', '8100 MB'));
  ok('磁盘容量与 IO 合并到一行', gOf('磁盘（容量 / IOPS / 速率）').rows[0].indexOf('204800 MB') >= 0
    && gOf('磁盘（容量 / IOPS / 速率）').rows[0].indexOf('340') >= 0,
  gOf('磁盘（容量 / IOPS / 速率）').rows[0]);
  ok('IOPS 列在有数据时保留', gOf('磁盘（容量 / IOPS / 速率）').cols.indexOf('读 IOPS') >= 0);
  ok('带宽换算成 Mbps', hasCell('网卡（速率 / 错包 / 带宽）', '1000 Mbps'));
  ok('服务状态可读', hasCell('服务检查', '运行中') && hasCell('服务检查', '未运行'));
  ok('textfile 中文名带标签', hasCell('业务指标（textfile）', '医保结算平均耗时（门诊）'));
  ok('textfile 单位与采集键都在', hasCell('业务指标（textfile）', 'ms')
    && hasCell('业务指标（textfile）', 'his_settle_ms{item=门诊}'));
  ok('采样说明进 meta', det.meta.sampledTwice === true && det.meta.gapMs === 1012
    && det.meta.note.indexOf('textfile') >= 0);
  const allCells = det.groups.reduce((a, g) => a.concat(g.cols, ...g.rows), []);
  ok('明细里没有 undefined / null / NaN / [object Object]',
    allCells.every((c) => !/undefined|null|NaN|\[object Object\]/.test(c)), allCells);

  // 整列没数据时不摆一排「—」：原始 fixture 的网卡只有 iface，错包列必须被丢掉
  const thin = scheduler.extraDetailOf(exporterResult());
  const thinNet = thin.groups.find((g) => g.title.indexOf('网卡') === 0) || { cols: [], rows: [] };
  ok('全空列被剔除', thinNet.cols.indexOf('收错包') < 0 && thinNet.cols.indexOf('接口') >= 0, thinNet.cols);

  // 随 /status 一起下发，且只给 exporter 通道
  eq('status 里带明细', statusOf([detailR]).devices[0].extraDetail.groups.length, det.groups.length);
  eq('非 exporter 不带明细', statusOf([ssh]).devices[0].extraDetail, null);
  const blank = scheduler.extraDetailOf(exporterResult({ ok: false, extra: null, metrics: null, services: null }));
  ok('采集失败 / 字段全缺不抛错', Array.isArray(blank.groups) && blank.meta.count === 0);
  const blankCells = blank.groups.reduce((a, g) => a.concat(g.cols, ...g.rows), []);
  ok('空结果也不出现脏字符串', blankCells.every((c) => !/undefined|null|NaN/.test(c)), blankCells);
} catch (e) {
  fail++;
  console.error('FAIL  未捕获异常：' + (e && e.stack || e));
}

console.log('exporter-cards-selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
