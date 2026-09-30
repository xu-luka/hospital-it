'use strict';
/**
 * netflow 采集通道自测（离线，不连真实交换机）
 *
 * 背景：第一版采集器走的是 SSH **exec** 通道，结果八台交换机全部采不到
 * （「0/8 台交换机，0 个端口」）。交换机普遍只对 SSH 开放交互式 shell，
 * exec 要么不开，要么每条命令一个新会话 —— 那样连「关分页」都做不到。
 *
 * 本自测用假 sshutil 注入，模拟四类设备：
 *   1) 华为/H3C：只认 display 系，shell 通道正常
 *   2) 思科/锐捷：display 系报错，自动改走 show 系
 *   3) 不开 shell、只放 exec 的设备 → 必须自动回退到 exec
 *   4) 完全没响应 + exec 也失败 → 报错必须同时带上两条通道的原因
 * 另外校验两个容易踩的点：
 *   · 关分页命令必须发在取数命令**之前**，否则 display interface 会被 More 卡断；
 *   · 端口一个都没解析出来时，错误里要带设备原文片段，别只报「失败」。
 *
 * 用法: node scripts/netflow-shell-selftest.js
 */

const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..');
const SSHUTIL = require.resolve(path.join(ROOT, 'src', 'inspection', 'lib', 'sshutil'));
const real = require(SSHUTIL);

/* ---------------- 用假 sshutil 顶掉真实网络层 ---------------- */

let connectImpl = null;
let execImpl = null;

require.cache[SSHUTIL].exports = Object.assign({}, real, {
  sshConnect: (server, timeoutMs) => connectImpl(server, timeoutMs),
  sshExec: (conn, cmd, timeoutMs) => execImpl(conn, cmd, timeoutMs)
});

const netflow = require(path.join(ROOT, 'src', 'inspection', 'netflow'));

/* ---------------- 假的 shell 流 / 连接 ---------------- */

/**
 * @param {function(string):string|null} handler  收到命令返回输出；返回 null 表示「不响应」
 */
function makeStream(handler) {
  const stream = new EventEmitter();
  stream.stderr = new EventEmitter();
  stream.closed = false;
  stream.write = (data) => {
    const cmd = String(data).replace(/\r?\n$/, '');
    if (stream.closed) return;
    setTimeout(() => {
      if (stream.closed) return;
      const out = handler(cmd);
      if (out === null) return;               // 装死：一个字节都不回
      stream.emit('data', Buffer.from(cmd + '\r\n' + out + '\r\nSW1>'));
    }, 5);
  };
  stream.close = () => { stream.closed = true; };
  // 登录 banner + 首个提示符
  setTimeout(() => {
    if (!stream.closed) {
      stream.emit('data', Buffer.from('Info: The max number of VTY users on line is 5\r\nSW1>'));
    }
  }, 5);
  return stream;
}

function makeConn(streamFactory) {
  return {
    ended: false,
    shell(opts, cb) { cb(null, streamFactory()); },
    end() { this.ended = true; }
  };
}

/* ---------------- 设备输出样本 ---------------- */

const HUAWEI_VERSION = [
  'Huawei Versatile Routing Platform Software',
  'VRP (R) software, Version 5.170 (S5720 V200R019C10SPC500)',
  'Copyright (C) 2000-2019 HUAWEI TECH CO., LTD',
  'HUAWEI S5720-28X-SI-AC Routing Switch uptime is 123 days, 4 hours, 5 minutes'
].join('\n');

const DISPLAY_IFACE = [
  'GigabitEthernet0/0/1 current state : UP',
  'Line protocol state: UP',
  '    Last 300 seconds input rate 12345678 bits/sec, 100 packets/sec',
  '    Last 300 seconds output rate 876543 bits/sec, 20 packets/sec',
  'GigabitEthernet0/0/2 current state : DOWN',
  'Line protocol state: DOWN',
  '    Last 300 seconds input rate 0 bits/sec, 0 packets/sec',
  '    Last 300 seconds output rate 0 bits/sec, 0 packets/sec'
].join('\n');

const DISPLAY_ARP = [
  'IP ADDRESS      MAC ADDRESS     EXPIRE(M) TYPE        INTERFACE   VPN-INSTANCE',
  '172.16.9.10     00e0-fc12-3456            I -         GE0/0/1'
].join('\n');

const DISPLAY_MAC = [
  'MAC Address    VLAN/VSI   Learned-From        Type',
  '00e0-fc12-3456 10/-       GE0/0/1             dynamic'
].join('\n');

const CISCO_VERSION = [
  'Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE11, RELEASE SOFTWARE (fc3)',
  'Technical Support: http://www.cisco.com/techsupport',
  'Copyright (c) 1986-2017 by Cisco Systems, Inc.'
].join('\n');

const SHOW_IFACE = [
  'GigabitEthernet0/1 is up, line protocol is up (connected)',
  '  Hardware is Gigabit Ethernet, address is 0011.2233.4455',
  '  5 minute input rate 1234000 bits/sec, 12 packets/sec',
  '  5 minute output rate 567000 bits/sec, 8 packets/sec',
  'GigabitEthernet0/2 is down, line protocol is down (notconnect)',
  '  5 minute input rate 0 bits/sec, 0 packets/sec',
  '  5 minute output rate 0 bits/sec, 0 packets/sec'
].join('\n');

const SHOW_ARP = [
  'Protocol  Address          Age (min)  Hardware Addr   Type   Interface',
  'Internet  172.16.9.20             5   0011.2233.4455  ARPA   GigabitEthernet0/1'
].join('\n');

const SHOW_MAC = [
  '          Mac Address Table',
  'Vlan    Mac Address       Type        Ports',
  '----    -----------       --------    -----',
  '   1    0011.2233.4455    DYNAMIC     Gi0/1'
].join('\n');

const NO_SUCH_CMD = "Error: Unrecognized command found at '^' position.";
const CISCO_BAD = "% Invalid input detected at '^' marker.";

/* 防火墙/网关类设备：确实能 SSH 登录、也真有 show 命令，但没有交换机那套数据。
 * 这是 2026-09-30 某台「360 防火墙」被登记成网络交换机后的真实输出形态：
 *   show version 有回（很短），show interfaces 直接 "% Invalid parameter detected"。
 * 以前只会把设备原话原样甩给用户，看的人不知道该怎么办。 */
const FW_VERSION = [
  '360 Firewall Platform',
  'Version 3.2.1 (build 20240118)',
  'Serial: FW-A1B2C3-0007'
].join('\n');
const FW_INVALID = "% Invalid parameter detected at '^' marker.";

/* ---------------- 断言 ---------------- */

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra !== undefined ? ' = ' + JSON.stringify(extra) : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra !== undefined ? ' = ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name, got === want, got); }

/* ---------------- 用例 ---------------- */

async function case1HuaweiShell() {
  console.log('\n== 用例 1：华为/H3C 设备，shell 通道 ==');
  const cmds = [];
  connectImpl = async () => makeConn(() => makeStream((cmd) => {
    cmds.push(cmd);
    if (cmd === 'display version') return HUAWEI_VERSION;
    if (cmd.indexOf('screen-length') === 0) return '';
    if (cmd === 'display interface') return DISPLAY_IFACE;
    if (cmd === 'display arp') return DISPLAY_ARP;
    if (cmd === 'display mac-address') return DISPLAY_MAC;
    return NO_SUCH_CMD;
  }));
  execImpl = async () => ({ stdout: '', stderr: '不该走到 exec', code: -1 });

  const r = await netflow.collectNetflow({ host: '10.0.0.1' }, { timeoutMs: 5000 });
  eq('采集成功', r.ok, true);
  eq('走 shell 通道', r.via, 'shell');
  eq('识别为 display 风格', r.style, 'display');
  eq('解析出 2 个端口', r.ports, 2);
  eq('ARP 1 条', r.arpCount, 1);
  eq('MAC 1 条', r.macCount, 1);
  const p1 = (r.rows || []).filter((x) => x.ifaceKey === 'gigabitethernet0/0/1')[0];
  ok('GE0/0/1 取到入速率 12345678 bps', p1 && p1.inBps === 12345678, p1 && p1.inBps);
  eq('GE0/0/1 单终端 → IP 精确', p1 && p1.ip, '172.16.9.10');
  const p2 = (r.rows || []).filter((x) => x.ifaceKey === 'gigabitethernet0/0/2')[0];
  eq('GE0/0/2 协议 DOWN → linkUp=false', p2 && p2.linkUp, false);
  // 关分页必须早于取数，否则 display interface 的第一屏之后会被 More 卡住
  const iPaging = cmds.indexOf('screen-length temporary 0');
  const iIface = cmds.indexOf('display interface');
  ok('关分页命令在取数之前', iPaging >= 0 && iIface >= 0 && iPaging < iIface,
    'paging@' + iPaging + ' iface@' + iIface);
  // display version + 2 条关分页 + interface + arp + mac
  ok('诊断明细含 6 条命令', (r.diag || []).length === 6, (r.diag || []).length);
  ok('诊断明细有字节数', (r.diag || []).every((d) => d.bytes > 0));
}

async function case2CiscoShell() {
  console.log('\n== 用例 2：思科/锐捷设备，display 报错后改走 show 系 ==');
  const cmds = [];
  connectImpl = async () => makeConn(() => makeStream((cmd) => {
    cmds.push(cmd);
    if (cmd === 'display version') return CISCO_BAD;
    if (cmd.indexOf('terminal length') === 0) return '';
    if (cmd === 'show version') return CISCO_VERSION;
    if (cmd === 'show interfaces') return SHOW_IFACE;
    if (cmd === 'show arp') return SHOW_ARP;
    if (cmd === 'show mac address-table') return SHOW_MAC;
    return NO_SUCH_CMD;
  }));
  execImpl = async () => ({ stdout: '', stderr: '不该走到 exec', code: -1 });

  const r = await netflow.collectNetflow({ host: '10.0.0.2' }, { timeoutMs: 5000 });
  eq('采集成功', r.ok, true);
  eq('判定为 show 风格', r.style, 'show');
  eq('解析出 2 个端口', r.ports, 2);
  const p1 = (r.rows || []).filter((x) => x.ifaceKey === 'gigabitethernet0/1')[0];
  ok('Gi0/1 取到入速率 1234000 bps', p1 && p1.inBps === 1234000, p1 && p1.inBps);
  eq('Gi0/1 单终端 → IP 精确（Gi 缩写与全称对齐）', p1 && p1.ip, '172.16.9.20');
  const p2 = (r.rows || []).filter((x) => x.ifaceKey === 'gigabitethernet0/2')[0];
  eq('Gi0/2 down', p2 && p2.linkUp, false);
  ok('确已发过 display version（先试 display 再退 show）', cmds.indexOf('display version') === 0, cmds[0]);
}

async function case3ExecFallback() {
  console.log('\n== 用例 3：设备不开 shell 通道 → 自动回退 exec ==');
  connectImpl = async () => ({
    ended: false,
    shell(opts, cb) { cb(new Error('Shell request failed on channel 0')); },
    end() { this.ended = true; }
  });
  const cmds = [];
  execImpl = async (conn, cmd) => {
    cmds.push(cmd);
    if (cmd === 'display interface') return { stdout: DISPLAY_IFACE, stderr: '', code: 0 };
    if (cmd === 'display arp') return { stdout: DISPLAY_ARP, stderr: '', code: 0 };
    if (cmd === 'display mac-address') return { stdout: DISPLAY_MAC, stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: -1 };
  };

  const r = await netflow.collectNetflow({ host: '10.0.0.3' }, { timeoutMs: 5000 });
  eq('回退后采集成功', r.ok, true);
  eq('标记走 exec 通道', r.via, 'exec');
  eq('端口仍解析正确', r.ports, 2);
  ok('说明里写明已回退', /回退 exec/.test(r.note || ''), r.note);
}

async function case4AllFail() {
  console.log('\n== 用例 4：设备完全不响应，两条通道都失败 ==');
  connectImpl = async () => makeConn(() => makeStream(() => null)); // 一个字节都不回
  execImpl = async () => ({ stdout: '', stderr: '', code: -1 });

  const t0 = Date.now();
  const r = await netflow.collectNetflow({ host: '10.0.0.4' }, { timeoutMs: 5000 });
  const cost = Date.now() - t0;
  eq('采集失败', r.ok, false);
  ok('错误里点明 shell 通道', /shell 通道/.test(r.error), r.error);
  ok('错误里点明 exec 通道', /exec 通道/.test(r.error));
  // 没有静默早退的话，一台死设备要按 5 秒 × 多条命令算；这里必须明显更快
  ok('静默早退生效（<12 秒）', cost < 12000, cost + 'ms');
}

async function case5AuthFailFast() {
  console.log('\n== 用例 5：认证失败 → 不浪费时间再试 exec ==');
  let execCalls = 0;
  connectImpl = async () => { throw new Error('All configured authentication methods failed'); };
  execImpl = async () => { execCalls++; return { stdout: '', stderr: '', code: -1 }; };

  const r = await netflow.collectNetflow({ host: '10.0.0.5' }, { timeoutMs: 5000 });
  eq('采集失败', r.ok, false);
  ok('错误已翻成中文并指明认证', /认证失败/.test(r.error), r.error);
  eq('未再调用 exec 通道', execCalls, 0);
}

async function case6NoPorts() {
  console.log('\n== 用例 6：连上了但一个端口都没解析出来 → 报错带设备原文 ==');
  connectImpl = async () => makeConn(() => makeStream((cmd) => {
    if (cmd === 'display version') return HUAWEI_VERSION;
    if (cmd.indexOf('screen-length') === 0) return '';
    if (cmd === 'display interface') return 'Interface statistics are not available in user view.';
    return '';
  }));
  execImpl = async () => ({ stdout: 'Interface statistics are not available in user view.', stderr: '', code: 0 });

  const r = await netflow.collectNetflow({ host: '10.0.0.6' }, { timeoutMs: 5000 });
  eq('采集失败', r.ok, false);
  // 文案是新的，考点是「说清试过哪些命令 + 保留原话」，便于对着设备核对格式
  ok('错误说明有返回但解不出端口', /没能解析出端口速率/.test(r.error), r.error);
  ok('错误里保留了设备原文片段', /Interface statistics/.test(r.error));
  ok('错误里列出了试过的命令', /display interface/.test(r.error), r.error);
}

/**
 * 用例 7：防火墙/网关类设备 —— 认 show 系，但 show interfaces 被拒。
 *
 * 期望的不是「又一条技术报错」，而是：①认得出这是设备不支持、②告诉人下一步做什么、
 * ③不要再浪费一次 exec 握手（命令行得了 cousins，换通道也是同样结果）。
 */
async function case7UnsupportedDevice() {
  console.log('\n== 用例 7：防火墙类设备（命令不支持）→ 说清原因且不再试 exec ==');
  let execCalls = 0;
  const cmds = [];
  connectImpl = async () => makeConn(() => makeStream((cmd) => {
    cmds.push(cmd);
    if (cmd === 'display version') return NO_SUCH_CMD;
    if (cmd === 'show version') return FW_VERSION;
    if (cmd === 'terminal length 0') return '';
    if (cmd === 'show interfaces') return FW_INVALID;
    if (cmd === 'show interface') return FW_INVALID;
    return FW_INVALID;
  }));
  execImpl = async () => { execCalls++; return { stdout: FW_INVALID, stderr: '', code: 0 }; };

  const r = await netflow.collectNetflow({ host: '10.0.0.7' }, { timeoutMs: 5000 });
  eq('采集失败', r.ok, false);
  eq('归类为设备不支持', r.reason, 'unsupported');
  ok('点明这类设备通常不是交换机', /防火墙|路由器|专用网关/.test(r.error), r.error);
  ok('告诉管理员下一步去哪处理', /采集范围/.test(r.error));
  ok('没再把 show interfaces 的原话丢掉', /Invalid parameter/.test(r.error));
  eq('未多此一举再试 exec', execCalls, 0);
  // 端口都没拿到时不该再去拉 ARP / MAC —— 失败轮次要快收尸
  ok('未浪费往返去取 ARP', cmds.indexOf('show arp') < 0, cmds.join(' | '));
  ok('未浪费往返去取 MAC', cmds.indexOf('show mac address-table') < 0);
}

/** 用例 8：设备只有单数的 show interface —— 主命令失败后必须自动试变体 */
async function case8IfaceVariant() {
  console.log('\n== 用例 8：只有 show interface（无复数）→ 用命令变体救回来 ==');
  connectImpl = async () => makeConn(() => makeStream((cmd) => {
    if (cmd === 'display version') return NO_SUCH_CMD;
    if (cmd === 'show version') return CISCO_VERSION;
    if (cmd === 'terminal length 0') return '';
    if (cmd === 'show interfaces') return CISCO_BAD;   // 这台设备不认复数
    if (cmd === 'show interface') return SHOW_IFACE;   // 只认单数
    if (cmd === 'show arp') return SHOW_ARP;
    if (cmd === 'show mac address-table') return SHOW_MAC;
    return '';
  }));
  execImpl = async () => ({ stdout: '', stderr: '', code: 0 });

  const r = await netflow.collectNetflow({ host: '10.0.0.8' }, { timeoutMs: 5000 });
  eq('采集成功', r.ok, true);
  eq('走 shell 通道', r.via, 'shell');
  eq('最终用上的命令', r.ifaceCmd, 'show interface');
  eq('端口数', r.ports, 2);
  eq('ARP 行', r.arpCount, 1);
  eq('MAC 行', r.macCount, 1);
}

/* ---------------- 入口 ---------------- */

(async () => {
  console.log('netflow 采集通道自测（假 SSH，离线）');
  try {
    await case1HuaweiShell();
    await case2CiscoShell();
    await case3ExecFallback();
    await case4AllFail();
    await case5AuthFailFast();
    await case6NoPorts();
    await case7UnsupportedDevice();
    await case8IfaceVariant();
  } catch (e) {
    fail++;
    console.log('\n[FAIL] 用例抛异常：' + ((e && e.stack) || e));
  }
  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  if (fail) { console.log('存在失败项'); process.exit(1); }
  console.log('全部通过');
})();
