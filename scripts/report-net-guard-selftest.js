'use strict';
/**
 * 回归自测：报告生成时 ex.net / ex.disks 结构异常不得抛错
 * 背景：2026-11-25 巡检报告生成失败 —— (ex.net || []).filter is not a function
 * Linux 通道 ex.net 是对象 {tcp_estab, tcp_listen, iface:[...]}，|| [] 兜不住，必须 Array.isArray
 *
 * 用法：node scripts/report-net-guard-selftest.js
 */
const path = require('path');
const { renderReport } = require(path.join(__dirname, '..', 'src', 'inspection', 'lib', 'report'));
const { DEFAULT_THRESHOLDS } = require(path.join(__dirname, '..', 'src', 'inspection', 'inspect'));

let pass = 0;
const fails = [];
function ok(tag, cond) { if (cond) pass++; else fails.push(tag); }

const meta = { date: '2026-11-25 08:30:00', thresholds: DEFAULT_THRESHOLDS, config: {} };
function baseResult(extra) {
  return {
    ok: true, status: 'normal', connectLabel: 'SSH 密码', host: '192.168.11.55', name: '测试主机',
    metrics: {
      hostname: 'test-host', os: 'Linux', uptime_sec: 3600, cores: 4,
      cpu_percent: 12, mem_total_mb: 8192, mem_used_mb: 2048, mem_percent: 25,
      disks: [], net: [], diskio: [], load1: 0.1
    },
    services: [], customs: [], logs: [],
    extra
  };
}

// 1. 精确复现：Linux 形态 ex.net 是对象（这次线上报错的场景）
{
  const r = baseResult({
    platform: 'linux',
    system: { threads: 200 }, memory: {},
    net: { tcp_estab: 12, tcp_listen: 5, iface: [{ iface: 'eth0', speed_mbps: 1000 }] },
    disks: [{ mount: '/', read_iops: 10, write_iops: 8 }]
  });
  let html = null, err = null;
  try { html = renderReport([r], meta); } catch (e) { err = e; }
  ok('Linux ex.net 对象不再抛错', err === null);
  ok('Linux ex.net 对象仍生成完整 HTML', typeof html === 'string' && html.indexOf('</html>') > 0);
}

// 2. Windows exporter 形态：ex.net 是数组，错包表必须还在
{
  const r = baseResult({
    platform: 'windows',
    system: {}, memory: {}, disks: [],
    net: [{ iface: 'eth0', rx_errors: 3, tx_errors: 1, rx_drops: 0, tx_drops: 0, bandwidth_bps: 100000000, util_pct: 12 }]
  });
  let html = null, err = null;
  try { html = renderReport([r], meta); } catch (e) { err = e; }
  ok('Windows ex.net 数组不抛错', err === null);
  ok('Windows 错包表正常渲染', typeof html === 'string' && html.indexOf('网络错包与带宽利用率') >= 0);
}

// 3. ex.net 缺失 / null / 字符串 等异常形态
for (const [tag, v] of [['缺失', undefined], ['null', null], ['字符串', 'bad'], ['数字', 42]]) {
  const r = baseResult({ platform: 'linux', system: {}, memory: {}, disks: [] });
  if (v !== undefined) r.extra.net = v;
  let err = null;
  try { renderReport([r], meta); } catch (e) { err = e; }
  ok('ex.net ' + tag + ' 不抛错', err === null);
}

// 4. ex.disks 异常形态（同类隐患一并加固）
for (const [tag, v] of [['对象', { mount: '/' }], ['字符串', 'bad'], ['null', null]]) {
  const r = baseResult({ platform: 'linux', system: {}, memory: {}, net: [] });
  r.extra.disks = v;
  let err = null;
  try { renderReport([r], meta); } catch (e) { err = e; }
  ok('ex.disks ' + tag + ' 不抛错', err === null);
}

console.log('\n== 报告 ex.net 类型守卫回归自测');
console.log('通过 ' + pass + ' 项');
if (fails.length) {
  console.log('失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
