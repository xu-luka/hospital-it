'use strict';
/**
 * 网络流量采集（端口级）—— 复用巡检已有的 SSH 通道，不引入 SNMP 等新协议。
 *
 * 思路：
 *   1) 读交换机每个端口的入/出速率（5 分钟均值，与采样间隔一致）；
 *   2) 用 ARP 表（IP→MAC）+ MAC 地址表（MAC→端口）把端口映射回终端 IP；
 *   3) 一个端口下只有 1 个 MAC 时，结果精确到 IP；多个时给出「端口 + 终端数」，
 *      绝不把端口总流量摊到每个 IP 上（那样数字是假的）。
 *
 * 兼容两套命令风格：
 *   · 华为 / H3C（display 系）
 *   · 思科 / 锐捷（show 系）
 *
 * 解析部分全部写成纯函数（parseXxx），便于用真实设备输出样本离线校验。
 */

const { sshConnect, sshExec } = require('./lib/sshutil');

/* ---------------- 通用小工具 ---------------- */

/** MAC 归一化：去掉 - : . 空格，全转小写 */
function normMac(s) {
  return String(s || '').trim().toLowerCase().replace(/[^0-9a-f]/g, '');
}

/**
 * 接口前缀归一表：缩写 → 统一名。
 * 同时登记「全称」，保证归一结果再归一仍然不变（幂等）。
 * 注意键里的连字符已去掉，因为 normIface 会先把 - 去掉。
 */
const IFACE_PREFIX = {
  // 千兆：Gi / GE / G / GigabitEthernet
  gi: 'gigabitethernet', ge: 'gigabitethernet', g: 'gigabitethernet',
  gigabitethernet: 'gigabitethernet', gigethernet: 'gigabitethernet',
  // 万兆：Te / TG / XE / XGE / XG / Ten-GigabitEthernet
  te: 'tengigabitethernet', tg: 'tengigabitethernet', ten: 'tengigabitethernet',
  xe: 'tengigabitethernet', xge: 'tengigabitethernet', xg: 'tengigabitethernet',
  tengigabitethernet: 'tengigabitethernet', tengige: 'tengigabitethernet',
  // 40G / 100G
  tf: 'fortygigabitethernet', fo: 'fortygigabitethernet', fortygigabitethernet: 'fortygigabitethernet',
  hg: 'hundredgigabitethernet', hge: 'hundredgigabitethernet', hundredgigabitethernet: 'hundredgigabitethernet',
  // 百兆
  fa: 'fastethernet', f: 'fastethernet', fastethernet: 'fastethernet',
  et: 'ethernet', e: 'ethernet', ethernet: 'ethernet',
  // 聚合口
  po: 'portchannel', pc: 'portchannel', portchannel: 'portchannel',
  agg: 'bridgeaggregation', bagg: 'bridgeaggregation', bridgeaggregation: 'bridgeaggregation',
  // 三层口
  vlan: 'vlanif', vl: 'vlanif', vlanif: 'vlanif', vlaninterface: 'vlanif',
  // 应当过滤掉的虚拟口
  me: 'meth', mgmt: 'meth', meth: 'meth',
  null: 'null', nu: 'null', nul: 'null',
  lo: 'loopback', loopback: 'loopback'
};

/**
 * 接口名归一化：GE0/0/1 / Gi0/0/1 / GigabitEthernet0/0/1 都变成 gigabitethernet0/0/1
 * （ARP 表常写缩写，速率表常写全称，不归一就对不上）
 * 连字符也一并去掉，使 Ten-GigabitEthernet 与 TenGigabitEthernet 等价。
 */
function normIface(s) {
  let t = String(s || '').trim().toLowerCase().replace(/[\s\-]/g, '');
  if (!t) return '';
  const m = t.match(/^([a-z]+)(\d.*)?$/);
  if (!m) return t;
  const head = m[1];
  const tail = m[2] || '';
  return (IFACE_PREFIX[head] || head) + tail;
}

const RATE_UNIT = {
  bits: 1, bit: 1, bps: 1,
  kbits: 1e3, kbit: 1e3, kbps: 1e3,
  mbits: 1e6, mbit: 1e6, mbps: 1e6,
  gbits: 1e9, gbit: 1e9, gbps: 1e9,
  tbits: 1e12, tbit: 1e12, tbps: 1e12,
  bytes: 8, byte: 8, byps: 8,
  kbytes: 8e3, kbyte: 8e3, kbyps: 8e3,
  mbytes: 8e6, mbyte: 8e6, mbyps: 8e6,
  gbytes: 8e9, gbyte: 8e9, gbyps: 8e9
};

/** "1,234,567 bits/sec" → 1234567（bps） */
function toBps(numStr, unit) {
  const n = parseFloat(String(numStr || '').replace(/[,\s]/g, ''));
  if (!isFinite(n)) return null;
  const u = String(unit || '').toLowerCase().replace(/[^a-z]/g, '');
  const mult = RATE_UNIT[u];
  if (!mult) return null;
  return Math.round(n * mult);
}

/** 是否是无意义的接口（管理口/环回/null/vlan），流量监控里跳过 */
function isRealPort(name) {
  const n = normIface(name);
  if (!n) return false;
  return !/^(meth|null|loopback|vlanif|veth)/.test(n);
}

/* ---------------- 速率解析 ---------------- */

/**
 * 华为/H3C：display interface
 * 接口行：GigabitEthernet0/0/1 current state : UP
 * 速率行：Last 300 seconds input rate: 12345678 bits/sec, 100 packets/sec
 */
function parseDisplayInterface(text) {
  const ports = [];
  let cur = null;
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    // 接口起始行
    const head = line.match(/^([A-Za-z][A-Za-z0-9]*[\d\/:.]+(?:\:\d+)?)\s+(?:current state|is)\s*[:\s]/i)
      || line.match(/^([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s+current state/i);
    if (head) {
      cur = { iface: head[1], inBps: null, outBps: null, linkUp: null };
      ports.push(cur);
      if (/administratively down|DOWN/i.test(line)) cur.linkUp = false;
      else if (/\bUP\b/i.test(line)) cur.linkUp = true;
      continue;
    }
    if (!cur) continue;
    if (cur.linkUp === null && /line protocol is/i.test(line)) {
      cur.linkUp = !/down/i.test(line);
      continue;
    }
    // 优先取 300 秒均值（与 5 分钟采样间隔一致），没有再取 5 秒瞬时
    let m = line.match(/Last 300 seconds input rate:?\s*([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes)\/sec/i);
    if (m) { cur.inBps = toBps(m[1], m[2]); continue; }
    m = line.match(/Last 300 seconds output rate:?\s*([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes)\/sec/i);
    if (m) { cur.outBps = toBps(m[1], m[2]); continue; }
    if (cur.inBps === null) {
      m = line.match(/Last 5 seconds input rate:?\s*([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes)\/sec/i);
      if (m) { cur.inBps = toBps(m[1], m[2]); continue; }
    }
    if (cur.outBps === null) {
      m = line.match(/Last 5 seconds output rate:?\s*([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes)\/sec/i);
      if (m) { cur.outBps = toBps(m[1], m[2]); continue; }
    }
  }
  return ports.filter((p) => p && isRealPort(p.iface));
}

/**
 * 思科/锐捷：show interfaces
 * 接口行：GigabitEthernet0/1 is up, line protocol is up
 * 速率行： 5 minute input rate 1234000 bits/sec, 12 packets/sec
 */
function parseShowInterfaces(text) {
  const ports = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const head = line.match(/^([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s+is\s+(up|down|administratively down)/i);
    if (head) {
      cur = { iface: head[1], inBps: null, outBps: null, linkUp: !/down/i.test(head[2]) };
      ports.push(cur);
      continue;
    }
    if (!cur) continue;
    let m = line.match(/(\d+)\s+minute[s]?\s+input\s+rate\s+([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes|[KMGT]?bps)\/sec/i);
    if (m) { cur.inBps = toBps(m[2], m[3]); continue; }
    m = line.match(/(\d+)\s+minute[s]?\s+output\s+rate\s+([\d,]+)\s*([KMGT]?bits|[KMGT]?bytes|[KMGT]?bps)\/sec/i);
    if (m) { cur.outBps = toBps(m[2], m[3]); continue; }
    if (cur.inBps === null) {
      m = line.match(/input\s+rate\s+([\d.,]+)\s*([KMGT]?bits|[KMGT]?bytes|[KMGT]?bps)\/sec/i);
      if (m) { cur.inBps = toBps(m[1], m[2]); continue; }
    }
    if (cur.outBps === null) {
      m = line.match(/output\s+rate\s+([\d.,]+)\s*([KMGT]?bits|[KMGT]?bytes|[KMGT]?bps)\/sec/i);
      if (m) { cur.outBps = toBps(m[1], m[2]); continue; }
    }
  }
  return ports.filter((p) => p && isRealPort(p.iface));
}

/* ---------------- ARP 解析 ---------------- */

/** 华为/H3C：display arp —— IP + MAC（+ 出接口） */
function parseDisplayArp(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F]{4}[-.][0-9a-fA-F]{4}[-.][0-9a-fA-F]{4})\b/);
    if (!m) continue;
    const rest = line.slice(m[0].length).trim();
    const iface = (rest.match(/([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s*$/) || [])[1] || '';
    out.push({ ip: m[1], mac: normMac(m[2]), iface });
  }
  return out;
}

/** 思科：show arp —— Internet  x.x.x.x  age  xxxx.xxxx.xxxx  ARPA  Gi0/1 */
function parseShowArp(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+[\-\d]+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\b(.*)$/);
    if (m) {
      const iface = (m[3].match(/([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s*$/) || [])[1] || '';
      out.push({ ip: m[1], mac: normMac(m[2]), iface });
      continue;
    }
    // 部分锐捷/华为英文界面也用 xxxx-xxxx-xxxx
    const m2 = line.match(/^Internet\s+(\d{1,3}(?:\.\d{1,3}){3})\s+[\-\d]+\s+([0-9a-fA-F]{4}[-.][0-9a-fA-F]{4}[-.][0-9a-fA-F]{4})\b(.*)$/);
    if (m2) {
      const iface = (m2[3].match(/([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s*$/) || [])[1] || '';
      out.push({ ip: m2[1], mac: normMac(m2[2]), iface });
    }
  }
  return out;
}

/* ---------------- MAC 地址表解析 ---------------- */

/** 华为/H3C：display mac-address —— MAC + 出端口 */
function parseDisplayMac(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    // MAC  VLAN/VSI/BD  Learned-From  Type   或  MAC  VLAN  State  Port  Aging
    const m = line.match(/^([0-9a-fA-F]{4}[-.][0-9a-fA-F]{4}[-.][0-9a-fA-F]{4})\s+\S+\s+([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\b/);
    if (m) { out.push({ mac: normMac(m[1]), port: m[2] }); continue; }
    const m2 = line.match(/^([0-9a-fA-F]{4}[-.][0-9a-fA-F]{4}[-.][0-9a-fA-F]{4})\s+\d+\s+\S+\s+([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\b/);
    if (m2) out.push({ mac: normMac(m2[1]), port: m2[2] });
  }
  return out;
}

/** 思科：show mac address-table —— vlan  mac  type  port */
function parseShowMac(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const m = line.match(/^\s*\d+\s+([0-9a-fA-F]{4}\.[0-9a-fA-F]{4}\.[0-9a-fA-F]{4})\s+\S+\s+([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s*$/i);
    if (m) { out.push({ mac: normMac(m[1]), port: m[2] }); continue; }
    const m2 = line.match(/^\s*\d+\s+([0-9a-fA-F]{4}[-.][0-9a-fA-F]{4}[-.][0-9a-fA-F]{4})\s+\S+\s+([A-Za-z][A-Za-z0-9]*[\d\/:.]+)\s*$/i);
    if (m2) out.push({ mac: normMac(m2[1]), port: m2[2] });
  }
  return out;
}

/* ---------------- 汇总：端口 → IP ---------------- */

/**
 * 把「速率 + ARP + MAC」三张表合成为端口流量行。
 * 端口下只有 1 个终端时 ip 精确到该终端；多个时 ip 为空、给出终端数。
 */
function buildPortRows(ports, arp, macTable) {
  const macToPort = new Map();
  for (const m of macTable) {
    const key = normMac(m.mac);
    if (!key) continue;
    const port = normIface(m.port);
    if (!port) continue;
    if (!macToPort.has(key)) macToPort.set(key, port);
  }
  const macToIp = new Map();
  for (const a of arp) {
    const key = normMac(a.mac);
    if (!key) continue;
    if (!macToIp.has(key)) macToIp.set(key, []);
    macToIp.get(key).push(a.ip);
  }
  // 端口 → 该端口下所有 MAC
  const portMacs = new Map();
  for (const [mac, port] of macToPort) {
    if (!portMacs.has(port)) portMacs.set(port, []);
    portMacs.get(port).push(mac);
  }

  const rows = [];
  for (const p of ports) {
    const key = normIface(p.iface);
    const macs = portMacs.get(key) || [];
    const ips = [];
    for (const mac of macs) {
      const list = macToIp.get(mac) || [];
      for (const ip of list) if (ips.indexOf(ip) < 0) ips.push(ip);
    }
    const inBps = p.inBps == null ? 0 : p.inBps;
    const outBps = p.outBps == null ? 0 : p.outBps;
    rows.push({
      iface: p.iface,
      // 归一化端口键：同一端口在 ARP 表写 GE0/0/1、速率表写 GigabitEthernet0/0/1，
      // 存库与判定都必须用这个键，否则跨轮对不上、每轮都当成新端口
      ifaceKey: key,
      linkUp: p.linkUp === true,
      inBps,
      outBps,
      totalBps: inBps + outBps,
      ips,
      ipCount: ips.length,
      // 只挂 1 个终端时才是「这个 IP 的流量」，否则只是「这个端口的总流量」
      ip: ips.length === 1 ? ips[0] : ''
    });
  }
  return rows;
}

/* ---------------- 采集入口 ---------------- */

const STYLES = {
  display: {
    version: 'display version',
    iface: 'display interface',
    arp: 'display arp',
    mac: 'display mac-address'
  },
  show: {
    version: 'show version',
    iface: 'show interfaces',
    arp: 'show arp',
    mac: 'show mac address-table'
  }
};

function looksUnsupported(out) {
  return !out || out.length < 40 || /Unrecognized|Invalid|Unknown command|Incomplete|Error:/i.test(out.slice(0, 200));
}

/**
 * 采集一台交换机的端口流量。
 * @param {object} server  与巡检相同的设备结构 { host, port, auth: {...} }
 * @param {object} opts    { timeoutMs }
 * @returns {Promise<{ok, style?, rows?, ports?, arpCount?, macCount?, error?}>}
 */
async function collectNetflow(server, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 25000;
  let conn = null;
  try {
    conn = await sshConnect(server, timeoutMs);
    // 先判别命令风格：display 系不通就退回 show 系
    const v1 = await sshExec(conn, STYLES.display.iface, timeoutMs);
    let style = 'display';
    if (looksUnsupported(v1.stdout)) {
      const v2 = await sshExec(conn, STYLES.show.iface, timeoutMs);
      if (looksUnsupported(v2.stdout)) {
        return { ok: false, error: '未识别的命令行风格（display / show 均无有效输出）' };
      }
      style = 'show';
    }
    const set = STYLES[style];
    const a = await sshExec(conn, set.arp, timeoutMs);
    const m = await sshExec(conn, set.mac, timeoutMs);
    const rawIface = style === 'display' ? v1.stdout : (await sshExec(conn, set.iface, timeoutMs)).stdout;

    const ports = style === 'display' ? parseDisplayInterface(rawIface) : parseShowInterfaces(rawIface);
    const arp = style === 'display' ? parseDisplayArp(a.stdout) : parseShowArp(a.stdout);
    const mac = style === 'display' ? parseDisplayMac(m.stdout) : parseShowMac(m.stdout);
    const rows = buildPortRows(ports, arp, mac);
    return { ok: true, style, rows, ports: ports.length, arpCount: arp.length, macCount: mac.length };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  } finally {
    if (conn) { try { conn.end(); } catch (e) { /* 忽略 */ } }
  }
}

module.exports = {
  collectNetflow,
  buildPortRows,
  normIface,
  normMac,
  toBps,
  parseDisplayInterface,
  parseShowInterfaces,
  parseDisplayArp,
  parseShowArp,
  parseDisplayMac,
  parseShowMac
};
