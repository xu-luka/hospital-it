'use strict';
/**
 * Linux 采集扩展自测（2026-11-11）
 *
 * 用法：node scripts/linux-selftest.js
 *
 * 为什么要有这份东西：
 *   1. 采集脚本是拼出来的 shell，段落标记和解析器是一对隐式契约 ——
 *      <<<IO1>>> 之后解析器就停在 io1 段，新加的 KEY=VALUE 会被静默丢掉。
 *      这坑真踩过（改完「全绿」但指标一个都不显示），必须有自测守住。
 *   2. 空串与 0 的区分：Number('') === 0，会把「没采到」显示成「0」，
 *      时间偏差、失败单元这类值上这是致命的误读。
 *   3. 大整数：文件句柄上限 9223372036854775807 超过 JS 安全整数，
 *      转数字会变成 ...776000，必须按字符串保留。
 *
 * 这里只做「给定远端输出 → 解析结果」的离线验证；
 * 真实 shell 链路（awk 差分、/proc 读取）由开发机上的假根目录 E2E 覆盖。
 */
const path = require('path');
const L = require(path.join(__dirname, '..', 'src', 'inspection', 'lib', 'linux'));

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

/* ---------------- 1. 脚本结构：段落顺序是硬契约 ---------------- */

const script = L.buildScript({
  services: [{ name: 'nginx', type: 'systemd' }],
  custom_commands: [{ name: '磁盘只读', command: 'mount | grep ro,' }]
});
const lines = script.split('\n');
const idxMetrics2 = lines.findIndex((l) => l === "echo '<<<METRICS>>>'" && lines.indexOf(l) > 0);
const lastMetricsMarker = lines.lastIndexOf("echo '<<<METRICS>>>'");
const idxIo1 = lines.indexOf("echo '<<<IO1>>>'");
const idxLogs = lines.indexOf("echo '<<<LOGS>>>'");
const idxTcp = lines.findIndex((l) => l.indexOf('TCP_ESTAB=') >= 0);
const idxSpeed = lines.findIndex((l) => l.indexOf('NET_SPEED=') >= 0);

ok('脚本里有重新开启 metrics 段的标记', lastMetricsMarker > idxIo1, '最后一条 <<<METRICS>>> 必须在 IO1 之后');
ok('TCP 统计在 metrics 段内（IO1 之后、LOGS 之前）', idxTcp > idxIo1 && idxTcp < idxLogs, idxTcp + ' / io1=' + idxIo1 + ' logs=' + idxLogs);
ok('网卡速率在 metrics 段内', idxSpeed > idxIo1 && idxSpeed < idxLogs, idxSpeed + ' / io1=' + idxIo1);
ok('iowait 与 steal 真的在脚本里算', script.indexOf('IOWAIT_PCT') >= 0 && script.indexOf('STEAL_PCT') >= 0);
ok('自定义命令仍然被引用（回归）', script.indexOf('mount | grep ro,') >= 0);
ok('服务检查仍然存在（回归）', script.indexOf('systemctl is-active') >= 0);
void idxMetrics2;

/* ---------------- 2. 解析：完整输出样本 ---------------- */

const fixture = [
  '<<<METRICS>>>',
  'HOSTNAME=his-db01',
  'OS=CentOS Linux 7 (Core)',
  'KERNEL=3.10.0-1160.el7.x86_64',
  'UPTIME_SEC=864000',
  'CORES=8',
  'LOADAVG=1.20 1.10 0.90',
  'CPU_PCT=23.5',
  'IOWAIT_PCT=31.2',
  'STEAL_PCT=2.0',
  'CTXT_PS=12345',
  'PROCS_RUNNING=3',
  'PROCS_BLOCKED=2',
  'FD_USED=6400',
  'FD_MAX=9223372036854775807',
  'INODE_MAX_PCT=42',
  'INODE_MAX_MOUNT=/var',
  'DISK=/|/dev/sda1|102400|40960|61440|40%',
  'DISK=/data|/dev/sdb1|2048000|20480|2027520|1%',
  'MEM_TOTAL_MB=16000 MEM_USED_MB=8000 MEM_PCT=50.0',
  'SWAP_TOTAL_MB=4000 SWAP_USED_MB=488',
  'PROCS=345',
  'ZOMBIES=1',
  '<<<NET0>>>',
  'eth0: 1000000 1000 0 0 0 0 0 0 500000 900 0 0 0 0 0 0',
  '<<<IO0>>>',
  '   8       0 sda 1000 0 800000 4000 500 0 40000 2000 0 6000 9000',
  '<<<NET1>>>',
  'eth0: 2024000 2000 3 2 0 0 0 0 1012000 1800 1 0 0 0 0 0',
  '<<<IO1>>>',
  '   8       0 sda 1100 0 1000000 4600 560 0 60400 2400 0 6100 9100',
  '<<<METRICS>>>',
  'TCP_ESTAB=120 TCP_TIMEWAIT=45 TCP_LISTEN=18',
  'TCP_RETRANS=1520 TCP_OUTSEGS=950000',
  'NET_SPEED=,eth0:1000,eth1:100',
  'MD_ARRAYS=2 MD_DEGRADED=1',
  'FAILED_UNITS=3',
  'TIME_OFFSET_MS=12',
  'OOM_KILLS=1',
  '<<<LOGS>>>',
  'LOG_ERROR=7 LOG_WARN=21',
  '<<<LOGSEND>>>',
  '<<<SERVICES>>>',
  'SYSTEMD|0|active',
  '<<<CUSTOM>>>',
  '<<<CMD|0>>>',
  'ro,',
  '<<<EXIT|0>>>',
  '<<<END>>>',
  ''
].join('\n');

const r = L.buildResult(L.parseOutput(fixture), {
  services: [{ name: 'nginx', type: 'systemd' }],
  custom_commands: [{ name: '磁盘只读', command: 'mount | grep ro,' }]
});
const m = r.metrics;
const ex = r.extra || {};

eq('ok', r.ok, true);
eq('主机名', m.hostname, 'his-db01');
eq('CPU 使用率（不含 iowait 口径）', m.cpu_percent, 23.5);
eq('iowait 单独输出', ex.cpu && ex.cpu.iowait_pct, 31.2);
eq('steal 单独输出', ex.cpu && ex.cpu.steal_pct, 2);
eq('上下文切换/秒', ex.cpu && ex.cpu.ctxt_ps, 12345);
eq('运行队列', ex.cpu && ex.cpu.procs_running, 3);
eq('阻塞队列', ex.cpu && ex.cpu.procs_blocked, 2);
eq('句柄已用', ex.fs && ex.fs.fd_used, 6400);
eq('句柄上限按字符串保留精度', ex.fs && ex.fs.fd_max, '9223372036854775807');
eq('inode 使用率', ex.fs && ex.fs.inode_max_pct, 42);
eq('inode 峰值挂载点', ex.fs && ex.fs.inode_max_mount, '/var');
eq('TCP 已建立', ex.net && ex.net.tcp_estab, 120);
eq('TCP TIME_WAIT', ex.net && ex.net.tcp_timewait, 45);
eq('TCP 监听', ex.net && ex.net.tcp_listen, 18);
eq('重传段数', ex.net && ex.net.retrans_total, 1520);
eq('重传率', ex.net && ex.net.retrans_pct, 0.2);
eq('网卡链路速率', ex.net && ex.net.iface, [
  { iface: 'eth0', speed_mbps: 1000 }, { iface: 'eth1', speed_mbps: 100 }
]);
eq('RAID 阵列数', ex.health && ex.health.md_arrays, 2);
eq('RAID 降级数', ex.health && ex.health.md_degraded, 1);
eq('失败服务单元', ex.health && ex.health.failed_units, 3);
eq('时间同步偏差', ex.health && ex.health.time_offset_ms, 12);
eq('OOM 次数', ex.health && ex.health.oom, 1);
eq('磁盘扩展条数', (ex.disks || []).length, 1);
eq('磁盘读 IOPS', (ex.disks[0] || {}).read_iops, 100);
eq('磁盘写 IOPS', (ex.disks[0] || {}).write_iops, 60);
eq('磁盘读等待', (ex.disks[0] || {}).read_await_ms, 6);
eq('磁盘利用率', (ex.disks[0] || {}).util_pct, 10);
eq('磁盘吞吐仍走 metrics.diskio', (m.diskio[0] || {}).r_kbps, 100000);
eq('网卡错包累计', (m.net[0] || {}).errs, 4);
eq('日志错误数', m.log_errors, 7);
eq('服务检查回归', (r.services[0] || {}).running, true);
eq('自定义命令输出回归', (r.customs[0] || {}).output, 'ro,');

/* ---------------- 3. 缺项/老内核：不能崩、不能造假数 ---------------- */

const bare = [
  '<<<METRICS>>>',
  'HOSTNAME=old-box',
  'CPU_PCT=4.0',
  'STEAL_PCT=0.0',
  'TIME_OFFSET_MS=',
  'FAILED_UNITS=',
  'NET_SPEED=',
  '<<<LOGS>>>',
  'LOG_ERROR=0 LOG_WARN=0',
  '<<<LOGSEND>>>',
  '<<<END>>>',
  ''
].join('\n');
const rb = L.buildResult(L.parseOutput(bare), { services: [], custom_commands: [] });
eq('缺项时仍 ok', rb.ok, true);
eq('空的时间偏差是 null 不是 0', rb.extra.health.time_offset_ms, null);
eq('空的失败单元是 null 不是 0', rb.extra.health.failed_units, null);
eq('无网卡速率时为空数组', rb.extra.net.iface, []);
eq('无 iowait 字段时为 null', rb.extra.cpu.iowait_pct, null);
eq('无磁盘时不报错', rb.metrics.disks.length, 0);

/* ---------------- 4. 计数口径 ---------------- */

function countExtra(extra) {
  let n = 0;
  const walk = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const v of Object.values(o)) {
      if (typeof v === 'number' && isFinite(v)) n++;
      else if (v && typeof v === 'object' && !Array.isArray(v)) walk(v);
    }
  };
  walk(extra);
  return n;
}
ok('扩展项计数 > 0（大屏「扩展 N 项」不会为 0）', countExtra(ex) > 10, '实际 ' + countExtra(ex));

/* ---------------- 输出 ---------------- */

if (fails.length) {
  console.log('FAIL ' + fails.length + ' / PASS ' + pass);
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS ' + pass + ' 项全部通过（Linux 采集扩展）');
