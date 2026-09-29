'use strict';
/**
 * 网络流量采集器离线自测（不连真实交换机）
 *
 * 用法：
 *   node scripts/netflow-selftest.js
 *
 * 说明：解析全部是纯函数，用真实设备输出样本喂进去校验。
 * 以后改 netflow.js 的解析规则，先跑这个脚本做回归。
 */

const path = require('path');
const nf = require(path.join(__dirname, '..', 'src', 'inspection', 'netflow'));

/* ---------------- 样本 1：华为 / H3C（display 系） ---------------- */

const HW_IFACE = `GigabitEthernet0/0/1 current state : UP
Line protocol current state : UP
Description:to-nurse-station
Hardware address is 4c1f-cc12-3456
Last 300 seconds input rate: 12345678 bits/sec, 1234 packets/sec
Last 300 seconds output rate: 876543 bits/sec, 987 packets/sec
GigabitEthernet0/0/2 current state : DOWN
Line protocol current state : DOWN
GigabitEthernet0/0/3 current state : UP
Last 300 seconds input rate: 987654321 bits/sec, 90000 packets/sec
Last 300 seconds output rate: 12000000 bits/sec, 20000 packets/sec
GigabitEthernet0/0/4 current state : UP
Last 5 seconds input rate: 500000 bits/sec, 100 packets/sec
Last 5 seconds output rate: 300000 bits/sec, 80 packets/sec
MEth0/0/1 current state : UP
Last 300 seconds input rate: 1000 bits/sec, 1 packets/sec
NULL0 current state : UP
Last 300 seconds input rate: 0 bits/sec, 0 packets/sec`;

const HW_ARP = `IP ADDRESS      MAC ADDRESS     EXPIRE(M) TYPE        INTERFACE      VPN-INSTANCE
172.16.9.10     5489-98ab-1234  20        D-0         GE0/0/1
172.16.9.11     5489-98cd-5678  18        D-0         GE0/0/3
172.16.9.12     5489-98ef-9012  15        D-0         GE0/0/3`;

const HW_MAC = `MAC Address    VLAN/VSI/BD   Learned-From        Type
5489-98ab-1234 1/-           GE0/0/1             dynamic
5489-98cd-5678 1/-           GE0/0/3             dynamic
5489-98ef-9012 1/-           GE0/0/3             dynamic`;

/* ---------------- 样本 2：思科 / 锐捷（show 系） ---------------- */

const CS_IFACE = `GigabitEthernet0/1 is up, line protocol is up (connected)
  Hardware is Gigabit Ethernet, address is 0011.2233.4455
  5 minute input rate 1234000 bits/sec, 12 packets/sec
  5 minute output rate 567000 bits/sec, 8 packets/sec
GigabitEthernet0/2 is administratively down, line protocol is down
GigabitEthernet0/3 is up, line protocol is up (connected)
  5 minute input rate 987000000 bits/sec, 90000 packets/sec
  5 minute output rate 12000000 bits/sec, 20000 packets/sec`;

const CS_ARP = `Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  172.16.9.20            10   5489.98ab.aaaa  ARPA   GigabitEthernet0/1
Internet  172.16.9.21             3   5489.98ab.bbbb  ARPA   GigabitEthernet0/3
Internet  172.16.9.22             7   5489.98ab.cccc  ARPA   GigabitEthernet0/3`;

const CS_MAC = `Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
   1    5489.98ab.aaaa    DYNAMIC     Gi0/1
   1    5489.98ab.bbbb    DYNAMIC     Gi0/3
   1    5489.98ab.cccc    DYNAMIC     Gi0/3`;

/* ---------------- 断言框架 ---------------- */

let pass = 0;
const fails = [];

function eq(tag, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) { pass++; console.log('  [OK]   ' + tag + ' = ' + a); }
  else { fails.push(tag + ' 期望 ' + e + '，实际 ' + a); console.log('  [FAIL] ' + tag + ' 期望 ' + e + '，实际 ' + a); }
}

function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}

function find(rows, iface) {
  return rows.find((r) => nf.normIface(r.iface) === nf.normIface(iface));
}

/* ---------------- 1. 单元：单位换算 / 名称归一 ---------------- */

console.log('\n== 单元：速率单位换算 ==');
eq('toBps("1,000", bits)', nf.toBps('1,000', 'bits'), 1000);
eq('toBps("5", Mbits)', nf.toBps('5', 'Mbits'), 5000000);
eq('toBps("10", bytes)', nf.toBps('10', 'bytes'), 80);
eq('toBps("2", Gbits)', nf.toBps('2', 'Gbits'), 2000000000);
eq('toBps("abc", bits)', nf.toBps('abc', 'bits'), null);
eq('toBps("1", 未知单位)', nf.toBps('1', 'zzz'), null);

console.log('\n== 单元：接口名归一 ==');
const nGE = nf.normIface('GE0/0/1');
const nGi = nf.normIface('Gi0/0/1');
const nFull = nf.normIface('GigabitEthernet0/0/1');
ok('GE / Gi / GigabitEthernet 归一一致', nGE === nGi && nGi === nFull, nFull);
eq('normIface("XGE1/0/1")', nf.normIface('XGE1/0/1'), 'tengigabitethernet1/0/1');
eq('normIface("XGE1/0/1") 与 Ten-Gigabit 同端口', nf.normIface('XGE1/0/1'), nf.normIface('Ten-GigabitEthernet1/0/1'));
eq('normIface("TenGigabitEthernet1/0/1") 连字符等价', nf.normIface('TenGigabitEthernet1/0/1'), nf.normIface('Ten-GigabitEthernet1/0/1'));
eq('normIface("Bridge-Aggregation1")', nf.normIface('Bridge-Aggregation1'), 'bridgeaggregation1');
eq('normIface("Vlan-interface10")', nf.normIface('Vlan-interface10'), 'vlanif10');
eq('normIface("NULL0")', nf.normIface('NULL0'), 'null0');
eq('normIface("LoopBack0")', nf.normIface('LoopBack0'), 'loopback0');

console.log('\n== 单元：MAC 归一 ==');
ok('短横与点分隔一致', nf.normMac('5489-98AB-1234') === nf.normMac('5489.98ab.1234'));
eq('normMac("") ', nf.normMac(''), '');


/* ---------------- 2. 华为 / H3C 端到端 ---------------- */

const hwPorts = nf.parseDisplayInterface(HW_IFACE);
const hwArp = nf.parseDisplayArp(HW_ARP);
const hwMac = nf.parseDisplayMac(HW_MAC);
const hwRows = nf.buildPortRows(hwPorts, hwArp, hwMac);

console.log('\n== 华为/H3C：display interface ==');
console.log('  解析到端口 ' + hwPorts.length + ' 个，ARP ' + hwArp.length + ' 条，MAC ' + hwMac.length + ' 条');
eq('端口数（MEth/NULL0 应被过滤）', hwPorts.length, 4);
eq('ARP 条数', hwArp.length, 3);
eq('MAC 条数', hwMac.length, 3);

const p1 = find(hwRows, 'GigabitEthernet0/0/1');
const p2 = find(hwRows, 'GigabitEthernet0/0/2');
const p3 = find(hwRows, 'GigabitEthernet0/0/3');
const p4 = find(hwRows, 'GigabitEthernet0/0/4');

eq('GE0/0/1 入速率(bps)', p1 && p1.inBps, 12345678);
eq('GE0/0/1 出速率(bps)', p1 && p1.outBps, 876543);
eq('GE0/0/1 链路 UP', p1 && p1.linkUp, true);
eq('GE0/0/1 单终端 -> ip 精确', p1 && p1.ip, '172.16.9.10');

eq('GE0/0/2 链路 DOWN', p2 && p2.linkUp, false);
eq('GE0/0/2 无终端', p2 && p2.ipCount, 0);

eq('GE0/0/3 入速率(bps)', p3 && p3.inBps, 987654321);
eq('GE0/0/3 出速率(bps)', p3 && p3.outBps, 12000000);
eq('GE0/0/3 终端数', p3 && p3.ipCount, 2);
eq('GE0/0/3 多终端 -> ip 置空（不摊流量）', p3 && p3.ip, '');
eq('GE0/0/3 终端 IP 列表', p3 && p3.ips.slice().sort(), ['172.16.9.11', '172.16.9.12']);

eq('GE0/0/4 无 300 秒均值回落 5 秒', p4 && p4.inBps, 500000);
eq('GE0/0/4 出速率', p4 && p4.outBps, 300000);

/* ---------------- 3. 思科 / 锐捷 端到端 ---------------- */

const csPorts = nf.parseShowInterfaces(CS_IFACE);
const csArp = nf.parseShowArp(CS_ARP);
const csMac = nf.parseShowMac(CS_MAC);
const csRows = nf.buildPortRows(csPorts, csArp, csMac);

console.log('\n== 思科/锐捷：show interfaces ==');
console.log('  解析到端口 ' + csPorts.length + ' 个，ARP ' + csArp.length + ' 条，MAC ' + csMac.length + ' 条');
eq('端口数', csPorts.length, 3);
eq('ARP 条数', csArp.length, 3);
eq('MAC 条数', csMac.length, 3);

const c1 = find(csRows, 'GigabitEthernet0/1');
const c2 = find(csRows, 'GigabitEthernet0/2');
const c3 = find(csRows, 'GigabitEthernet0/3');

eq('Gi0/1 入速率', c1 && c1.inBps, 1234000);
eq('Gi0/1 出速率', c1 && c1.outBps, 567000);
eq('Gi0/1 单终端 -> ip（Gi 缩写与全称对齐）', c1 && c1.ip, '172.16.9.20');

eq('Gi0/2 administratively down', c2 && c2.linkUp, false);

eq('Gi0/3 入速率', c3 && c3.inBps, 987000000);
eq('Gi0/3 终端数', c3 && c3.ipCount, 2);
eq('Gi0/3 多终端 -> ip 置空', c3 && c3.ip, '');
eq('Gi0/3 终端 IP 列表', c3 && c3.ips.slice().sort(), ['172.16.9.21', '172.16.9.22']);

/* ---------------- 4. 结果表（可视化核对） ---------------- */

function table(tag, rows) {
  console.log('\n== ' + tag + ' 结果行 ==');
  console.log('  ' + '接口'.padEnd(24) + '链路'.padEnd(6) + '入(Mbps)'.padStart(10) + '出(Mbps)'.padStart(10) + '  终端  归属 IP');
  for (const r of rows.slice().sort((a, b) => b.totalBps - a.totalBps)) {
    console.log('  ' + String(r.iface).padEnd(24) +
      (r.linkUp ? 'UP' : 'DOWN').padEnd(6) +
      (r.inBps / 1e6).toFixed(2).padStart(10) +
      (r.outBps / 1e6).toFixed(2).padStart(10) +
      String(r.ipCount).padStart(5) + '  ' +
      (r.ip || (r.ipCount > 1 ? '[' + r.ips.join(', ') + ']' : '-')));
  }
}
table('华为/H3C', hwRows);
table('思科/锐捷', csRows);

/* ---------------- 汇总 ---------------- */

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('全部通过');
