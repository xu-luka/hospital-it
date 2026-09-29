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

const { sshConnect, sshExec, friendlySshError } = require('./lib/sshutil');

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
    // 「Line protocol state: UP」/「line protocol is up」——协议状态比物理状态更能说明口通不通，
    // 见到就覆盖（H3C 在物理 UP、协议 DOWN 时会写成 current state: UP + Line protocol state: DOWN）
    if (/^line protocol\s+(?:state|is)/i.test(line)) {
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
    vendor: '华为/H3C 风格',
    version: 'display version',
    // 关分页是必须的：display interface 在 24 口交换机上就有上百行，
    // 不关分页会被 ---- More ---- 卡住，只回前 50 行，后面的端口全丢。
    paging: ['screen-length temporary 0', 'screen-length disable'],
    iface: 'display interface',
    arp: 'display arp',
    mac: 'display mac-address'
  },
  show: {
    vendor: '思科/锐捷 风格',
    version: 'show version',
    paging: ['terminal length 0'],
    iface: 'show interfaces',
    arp: 'show arp',
    mac: 'show mac address-table'
  }
};

/** 命令报错的样子（华为 Error: Unrecognized、思科 % Invalid input、H3C % Unrecognized） */
const BAD_OUTPUT_RE = /Unrecognized|Invalid|Unknown command|Incomplete|Error:|^\s*%/im;

function looksUnsupported(out) {
  const t = String(out || '');
  if (t.trim().length < 40) return true;
  return BAD_OUTPUT_RE.test(t.slice(0, 200));
}

function noteDiag(diag, r) {
  if (diag) diag.push({ cmd: r.cmd, ok: !!r.ok, bytes: r.bytes || 0 });
}

function friendlyErr(e) {
  const m = String((e && e.message) || e);
  try { return friendlySshError(e); } catch (e2) { return m; }
}

/* -------- shell 交互通道（主路径，与巡检 lib/switch.js 同一套路） --------
 *
 * 为什么要走 shell 而不是 exec：
 *   交换机（尤其华为/H3C）普遍只对 SSH 开放交互式 shell，exec 通道要么直接不开，
 *   要么每条命令一个新会话 —— 那样连「关分页」都做不到，display interface 只能拿到
 *   第一屏。巡检能采到这些设备，走的正是 shell。
 */

const PROMPT_RE = /^(<[^>\n]{1,60}>|\[[^\]\n]{1,60}\]|[A-Za-z0-9_.\-()]{1,40}[>#])\s*$/;

function openShell(conn) {
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

/**
 * 等待条件满足或超时；期间自动处理 ---- More ---- 翻页。
 *
 * 额外做了「静默/空转早退」：设备停止吐字（或压根没响应）就立刻收工。
 * 没有这道闸，一台死设备要按 45 秒 × 4 条命令算，八台交换机能拖到十分钟以上，
 * 5 分钟的采集间隔直接被挤爆（下一轮还会因为「上一轮未结束」被跳过）。
 */
function waitFor(getBuf, stream, cond, timeoutMs, quiet) {
  const q = quiet || {};
  const quietMs = q.quietMs || Math.min(6000, Math.max(1500, Math.round(timeoutMs / 4)));
  const emptyMs = q.emptyMs || Math.min(12000, Math.max(3000, Math.round(timeoutMs / 2)));
  const deadline = Date.now() + timeoutMs;
  const start = Date.now();
  let lastLen = -1;
  let lastChange = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      const buf = getBuf();
      if (buf.length !== lastLen) { lastLen = buf.length; lastChange = Date.now(); }
      if (/----\s*More\s*----/i.test(buf.slice(-80))) {
        try { stream.write(' '); } catch (e) { /* 忽略 */ }
        lastChange = Date.now();
      }
      if (cond(buf)) { resolve(true); return; }
      const now = Date.now();
      if (now > deadline) { resolve(false); return; }
      if (buf.length === 0 && now - start > emptyMs) { resolve(false); return; }
      if (buf.length > 0 && now - lastChange > quietMs) { resolve(false); return; }
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** 去掉命令回显行、分页符与首尾提示符行（输出中间的 [xxx] 段标题保留，避免误删内容） */
function stripShell(text, cmd) {
  const cmdTrim = String(cmd).trim();
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (const ln of lines) {
    const t = ln.trim();
    if (t === cmdTrim) continue;
    if (/^Info: The max number of VTY/i.test(t)) continue;
    if (/^of current VTY users on line is/i.test(t)) continue;
    if (/^The current login time is/i.test(t)) continue;
    if (/----\s*More\s*----/i.test(t)) continue;
    out.push(ln);
  }
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && PROMPT_RE.test(out[0].trim())) out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && PROMPT_RE.test(out[out.length - 1].trim())) out.pop();
  return out.join('\n').trim();
}

/**
 * 建一条 shell 会话，顺序发命令。
 * 每条命令都是「清空缓冲 → 发送 → 等提示符」，返回原始输出与去回显后的文本。
 */
async function openSession(conn) {
  const stream = await openShell(conn);
  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    // 一台 48 口交换机的 display interface 约 60~100KB；留足余量再裁尾
    if (buf.length > 1200000) buf = buf.slice(-1200000);
  });
  stream.stderr.on('data', () => { /* 静默 */ });
  stream.stderr.on('error', () => { /* 静默 */ });
  stream.on('error', () => { /* 静默 */ });

  const lastLine = (s) => (s.replace(/\r/g, '').trim().split('\n').pop() || '').trim();

  return {
    /** 等登录 banner 后的第一个提示符 */
    waitReady(ms) {
      return waitFor(() => buf, stream, (b) => PROMPT_RE.test(lastLine(b)), ms);
    },
    async send(cmd, ms) {
      buf = '';
      const started = Date.now();
      try { stream.write(cmd + '\n'); } catch (e) { /* 流已关，交给上层兜 */ }
      const ok = await waitFor(() => buf, stream, (b) => {
        const last = lastLine(b);
        if (!PROMPT_RE.test(last)) return false;
        // 正常有回显：拿到「回显 + 输出 + 提示符」即可收工。
        // 个别设备关了 echo，就多等 800ms，免得把上一条命令残留的提示符误判成本条结束。
        return b.length > cmd.length + 2 || (Date.now() - started) > 800;
      }, ms);
      const raw = buf;
      return { cmd: cmd, ok: ok, raw: raw, text: stripShell(raw, cmd), bytes: raw.length };
    },
    close() { try { stream.close(); } catch (e) { /* 忽略 */ } }
  };
}

/** shell 路径：先判命令风格 → 关分页 → 取「速率 + ARP + MAC」三张表 */
async function collectNetflowShell(server, timeoutMs, diag) {
  const conn = await sshConnect(server, timeoutMs);
  let sess;
  try {
    sess = await openSession(conn);
  } catch (e) {
    try { conn.end(); } catch (e2) { /* 忽略 */ }
    throw new Error('__NO_SHELL__');
  }
  try {
    await sess.waitReady(Math.min(timeoutMs, 15000));

    // 判风格：display version 与 show version 互斥，谁有输出就是谁
    let style = null;
    for (const name of ['display', 'show']) {
      const r = await sess.send(STYLES[name].version, Math.min(timeoutMs, 20000));
      noteDiag(diag, r);
      if (!looksUnsupported(r.text)) { style = name; break; }
    }
    if (!style) {
      return { ok: false, error: '设备未识别命令风格（display version / show version 均无有效输出）' };
    }
    const set = STYLES[style];

    // 关分页（结果本身无用，只为后续命令不被 More 卡住）
    for (const p of set.paging) noteDiag(diag, await sess.send(p, 8000));

    // 接口表最长，超时了也别丢已经收到的部分 —— 解析器能解多少算多少
    const rIface = await sess.send(set.iface, Math.max(timeoutMs, 30000));
    const rArp = await sess.send(set.arp, Math.min(timeoutMs, 20000));
    const rMac = await sess.send(set.mac, Math.min(timeoutMs, 20000));
    noteDiag(diag, rIface);
    noteDiag(diag, rArp);
    noteDiag(diag, rMac);

    const ports = style === 'display' ? parseDisplayInterface(rIface.text) : parseShowInterfaces(rIface.text);
    const arp = style === 'display' ? parseDisplayArp(rArp.text) : parseShowArp(rArp.text);
    const mac = style === 'display' ? parseDisplayMac(rMac.text) : parseShowMac(rMac.text);
    const rows = buildPortRows(ports, arp, mac);

    if (!ports.length) {
      // 采到了内容却一个端口都没解出来，把原文开头带上，便于对着设备核对格式
      const head = String(rIface.text || '').replace(/\s+/g, ' ').slice(0, 160);
      return {
        ok: false,
        style: style,
        error: set.iface + ' 无有效端口输出（收到 ' + rIface.bytes + ' 字节'
          + (rIface.ok ? '' : '，等待提示符超时') + '）：' + (head || '(空)')
      };
    }
    return {
      ok: true, style: style, vendor: set.vendor, via: 'shell',
      rows: rows, ports: ports.length, arpCount: arp.length, macCount: mac.length,
      truncated: !rIface.ok
    };
  } finally {
    if (sess) sess.close();
    try { conn.end(); } catch (e) { /* 忽略 */ }
  }
}

/** exec 通道回退：个别设备反过来只放 exec，不支持交互式 shell */
async function collectNetflowExec(server, timeoutMs) {
  let conn = null;
  try {
    conn = await sshConnect(server, timeoutMs);
    for (const name of ['display', 'show']) {
      const set = STYLES[name];
      const v = await sshExec(conn, set.iface, timeoutMs);
      if (looksUnsupported(v.stdout)) continue;
      const a = await sshExec(conn, set.arp, timeoutMs);
      const m = await sshExec(conn, set.mac, timeoutMs);
      const ports = name === 'display' ? parseDisplayInterface(v.stdout) : parseShowInterfaces(v.stdout);
      const arp = name === 'display' ? parseDisplayArp(a.stdout) : parseShowArp(a.stdout);
      const mac = name === 'display' ? parseDisplayMac(m.stdout) : parseShowMac(m.stdout);
      const rows = buildPortRows(ports, arp, mac);
      if (!ports.length) {
        return {
          ok: false, style: name,
          error: set.iface + ' 在 exec 通道无有效端口输出（收到 ' + String(v.stdout || '').length + ' 字节）'
        };
      }
      return {
        ok: true, style: name, vendor: set.vendor, via: 'exec',
        rows: rows, ports: ports.length, arpCount: arp.length, macCount: mac.length
      };
    }
    return { ok: false, error: '未识别的命令行风格（display / show 均无有效输出）' };
  } catch (e) {
    return { ok: false, error: friendlyErr(e) };
  } finally {
    if (conn) { try { conn.end(); } catch (e) { /* 忽略 */ } }
  }
}

/**
 * 采集一台交换机的端口流量。
 * @param {object} server  与巡检相同的设备结构 { host, port, auth: {...} }
 * @param {object} opts    { timeoutMs }
 * @returns {Promise<{ok, style?, via?, rows?, ports?, arpCount?, macCount?, error?, diag?}>}
 */
async function collectNetflow(server, opts) {
  const o = opts || {};
  const timeoutMs = Math.max(5000, Number(o.timeoutMs) || 45000);
  const diag = [];

  let shellErr = null;
  try {
    const r = await collectNetflowShell(server, timeoutMs, diag);
    if (r.ok) { r.diag = diag; return r; }
    shellErr = r.error || '未知原因';
  } catch (e) {
    const m = String((e && e.message) || e);
    shellErr = m === '__NO_SHELL__' ? '设备不支持交互式 shell 通道' : friendlyErr(e);
  }

  // 连接层面的错误（认证/超时/网络）换通道也救不回来，直接报出去，别让用户等两遍超时
  if (/(认证失败|连接超时|连接被拒绝|网络不可达|无法解析|连接被对方重置|ECONN|ETIMEDOUT|EHOSTUNREACH|ENOTFOUND)/.test(shellErr)) {
    return { ok: false, error: shellErr, via: 'shell', diag: diag };
  }

  const r2 = await collectNetflowExec(server, timeoutMs);
  r2.diag = diag;
  if (r2.ok) {
    r2.note = 'shell 通道失败，已回退 exec 通道（shell 报错：' + shellErr + '）';
    return r2;
  }
  r2.error = 'shell 通道：' + shellErr + '；exec 通道：' + (r2.error || '未知原因');
  return r2;
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
