'use strict';
/**
 * ESXi 虚拟化平台巡检模块
 * 通道：vSphere SOAP API（/sdk），ESXi 6.0 与 8.0 通用，无需开启 SSH
 * 流程：Login → RetrieveServiceContent → RetrievePropertiesEx(ha-host) → Logout
 * 采集：版本/硬件/CPU/内存/运行时长/运行状态/虚拟机列表/数据存储/网卡/硬件健康
 */
const https = require('https');
const net = require('net');
const { round1 } = require('./common');

// 命名空间：不带版本号的 urn:vim25 被 ESXi 所有版本接受（向后兼容），
// 若被拒则回退带版本号的命名空间（6.0 / 8.0）
const NS_CANDIDATES = ['urn:vim25', 'urn:vim25/8.0', 'urn:vim25/6.0', 'urn:vim25/6.5', 'urn:vim25/7.0'];

// 主机属性集：使用"整对象/中等粒度"路径，而非逐个细字段。
// 原因：vSphere 的 RetrievePropertiesEx 是"全有或全无"——任一 pathSet 路径在该 ESXi
// 版本上非法，整个请求即返回 ServerFaultCode(InvalidProperty)。粗粒度的 'summary'、
// 'config.product' 等顶层路径在所有版本都合法，最稳妥；返回的嵌套结构再由 getProp 取值。
const HOST_PROPS = [
  'summary',                       // 含 config/hardware/runtime/quickStats/overallStatus/rebootRequired
  'config.product',                // 版本/build/apiVersion/vendor
  'config.network.pnic',           // 物理网卡
  'hardware.systemInfo',           // 型号/厂商/UUID/序列号(otherIdentifyingInfo)
  'runtime.hardwareStatusInfo',    // 硬件状态
  'runtime.healthStateSystemStatusInfo', // 健康状态
  'datastore', 'vm'                // 引用数组，供二次查询
];

// 回退属性集：用更粗的整对象路径，兜底兼容（万一某中等粒度子路径在特定版本非法）。
const HOST_PROPS_FALLBACK = [
  'summary', 'hardware', 'config', 'runtime', 'datastore', 'vm'
];

/** 从扁平或嵌套属性对象中按点路径取值（兼容两种解析结果） */
function getProp(p, path) {
  if (!p) return undefined;
  if (path in p) return p[path];
  const parts = path.split('.');
  let cur = p;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    if (!(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** 从 otherIdentifyingInfo 数组中提取序列号/服务标签 */
function extractSerial(oii) {
  if (!Array.isArray(oii)) return '';
  for (const item of oii) {
    if (!item) continue;
    const t = item.identifierType || {};
    const key = String(t.key || t.label || '');
    if (/ServiceTag|SerialNumber|Serial|serial/i.test(key)) {
      return item.identifierValue || '';
    }
  }
  return '';
}

function friendlyEsxiError(e, host, port) {
  const m = (e && e.message) ? String(e.message) : String(e);
  if (/ECONNREFUSED/.test(m)) {
    return '连接被拒绝，ESXi 的 ' + port + ' 端口未提供服务（' + m + '）';
  }
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) {
    return '网络不可达，无法路由到 ' + host + '（' + m + '）';
  }
  if (/ECONNRESET|EPIPE/.test(m)) {
    return '连接被对方重置，可能是设备主动断开或防火墙干扰（' + m + '）';
  }
  if (/CERT|certificate|self.?signed|UNABLE_TO_VERIFY/i.test(m)) {
    return 'TLS 证书校验失败，ESXi 使用自签名证书（已默认忽略，若仍出现请检查中间设备）：' + m;
  }
  if (/SSL|TLS|handshake|version/i.test(m)) {
    return 'TLS 协商失败，设备可能只支持较旧的 TLS 版本：' + m;
  }
  if (/InvalidLogin|Cannot complete login|not authenticated|Authentication failed/i.test(m)) {
    return '账号或密码错误，ESXi 认证失败（' + m + '）';
  }
  if (/vim\.fault|FaultCode/i.test(m)) {
    return 'ESXi 返回错误：' + m;
  }
  return m;
}

/** 预检 443：区分"防火墙静默丢包"与"服务拒绝"，给出针对性诊断 */
function precheckPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = new net.Socket();
    let done = false;
    const finish = (r) => { if (!done) { done = true; try { s.destroy(); } catch (e) {} resolve(r); } };
    s.setTimeout(timeoutMs);
    s.on('connect', () => finish({ ok: true }));
    s.on('timeout', () => finish({
      ok: false,
      hint: '无法连接 ESXi 管理端口 ' + port + '：TCP SYN 无任何响应（静默丢包）。'
        + '这通常表示中间防火墙/安全组拦截了该端口，或 ESXi 防火墙未放行。'
        + 'ESXi 的管理 API（vSphere Client、SDK、Redfish）全部只监听 ' + port + '，'
        + '请在防火墙上放行本机到 ' + host + ':' + port + ' 的 TCP 访问后重试。'
    }));
    s.on('error', (e) => finish({ ok: false, hint: '端口 ' + port + ' 连接失败：' + (e.code || e.message) }));
    s.connect(port, host);
  });
}

function soapRequest(host, port, bodyXml, ns, sessionId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const soapAction = (ns === 'urn:vim25') ? 'urn:vim2' : 'urn:vim25/' + ns.replace('urn:vim25/', '');
    const payload = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"'
      + ' xmlns:xsd="http://www.w3.org/2001/XMLSchema"'
      + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
      + '<soapenv:Body>' + bodyXml + '</soapenv:Body></soapenv:Envelope>';
    const headers = {
      'Content-Type': 'text/xml; charset=utf-8',
      'SOAPAction': soapAction,
      'Content-Length': Buffer.byteLength(payload)
    };
    if (sessionId) headers['Cookie'] = 'vmware_soap_session="' + sessionId + '"';

    const req = https.request({
      host: host,
      port: port,
      path: '/sdk',
      method: 'POST',
      headers: headers,
      timeout: timeoutMs,
      rejectUnauthorized: false,   // ESXi 自签名证书
      // 兼容旧 ESXi（6.0）可能的较低 TLS 版本
      minVersion: 'TLSv1'
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let sid = null;
        const sc = res.headers['set-cookie'];
        if (sc) {
          for (const c of sc) {
            const m = /vmware_soap_session="?([^";]+)"?/i.exec(c);
            if (m) sid = m[1];
          }
        }
        if (!sid && res.headers['vmware-soap-session-id']) sid = res.headers['vmware-soap-session-id'];
        resolve({ status: res.statusCode, body: d, sessionId: sid });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('请求超时(' + timeoutMs + 'ms)')); });
    req.on('error', (e) => reject(e));
    req.end(payload);
  });
}

/** 从 SOAP 响应中检查 Fault */
function checkFault(body) {
  const fault = /<(?:\w+:)?Fault>([\s\S]*?)<\/(?:\w+:)?Fault>/i.exec(body);
  if (!fault) return null;
  const code = /<(?:\w+:)?faultcode>([^<]*)</i.exec(fault[1]);
  const str = /<(?:\w+:)?faultstring>([^<]*)</i.exec(fault[1]);
  const locMsg = /<localizeMessage>([\s\S]*?)<\/localizeMessage>/i.exec(fault[1]);
  let msg = locMsg ? locMsg[1].replace(/<[^>]+>/g, '').trim() : '';
  if (!msg) msg = (str ? str[1] : '') + (code ? ' [' + code[1] + ']' : '');
  return msg.trim() || 'SOAP Fault（无详细信息）';
}

/** 解析属性（如 xsi:type="ArrayOf..."）为对象 */
function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:.\-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

/** 把 XML 字符串切成 token 序列（open/close/self/text） */
function tokenize(s) {
  const tokens = [];
  let i = 0;
  const n = s.length;
  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { if (i < n) tokens.push({ t: 'text', v: s.substring(i) }); break; }
    if (lt > i) tokens.push({ t: 'text', v: s.substring(i, lt) });
    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    let raw = s.substring(lt + 1, gt);
    i = gt + 1;
    if (raw.startsWith('!--')) { const e = s.indexOf('-->', lt); if (e >= 0) i = e + 3; continue; }
    if (raw.startsWith('!') || raw.startsWith('?')) continue;
    const closing = raw[0] === '/';
    if (closing) raw = raw.substring(1);
    const selfClose = /\/\s*$/.test(raw);
    if (selfClose) raw = raw.replace(/\/\s*$/, '');
    const nm = /^\s*([^\s]+)/.exec(raw);
    const name = nm ? nm[1] : '';
    const attrs = parseAttrs(raw.substring(name.length));
    tokens.push({ t: closing ? 'close' : (selfClose ? 'self' : 'open'), name, attrs });
  }
  return tokens;
}

/** 从一个 open token 递归解析出元素节点，返回 [node, 下一位置] */
function parseXmlNode(tokens, idx) {
  const openTok = tokens[idx];
  let i = idx + 1;
  const children = [];
  let text = '';
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.t === 'close') { i++; break; }
    else if (tk.t === 'self') { children.push({ name: tk.name, attrs: tk.attrs, children: [], text: '' }); i++; }
    else if (tk.t === 'open') { const r = parseXmlNode(tokens, i); children.push(r[0]); i = r[1]; }
    else { text += tk.v || ''; i++; }
  }
  return [{ name: openTok.name, attrs: openTok.attrs, children, text }, i];
}

/** 元素节点 → JS 值：数组类型→数组；带 type 的引用→{type,'#text'}；含子元素→对象；叶子→文本 */
function nodeToValue(node) {
  const xsiType = node.attrs['xsi:type'] || '';
  const isArray = /ArrayOf/i.test(xsiType);
  const typeAttr = node.attrs['type'];

  if (node.children.length === 0) {
    const t = decodeEnt(node.text || '').trim();
    if (typeAttr) return { type: typeAttr, '#text': t };
    return t === '' ? null : t;
  }
  if (isArray) {
    const arr = [];
    for (const c of node.children) arr.push(nodeToValue(c));
    return arr;
  }
  const groups = {}; const order = [];
  for (const c of node.children) {
    if (!(c.name in groups)) { groups[c.name] = []; order.push(c.name); }
    groups[c.name].push(nodeToValue(c));
  }
  const obj = {};
  for (const k of order) obj[k] = groups[k].length === 1 ? groups[k][0] : groups[k];
  if (typeAttr) obj.type = typeAttr;
  return obj;
}

/** 解析 <val> 内部片段为 JS 值（含数组/引用/嵌套对象） */
function parseValFragment(innerXml, attrs) {
  const tokens = tokenize(innerXml);
  const xsiType = attrs['xsi:type'] || '';
  const isArray = /ArrayOf/i.test(xsiType);
  const typeAttr = attrs['type'];

  const topChildren = [];
  let text = '';
  let i = 0;
  while (i < tokens.length) {
    const tk = tokens[i];
    if (tk.t === 'open') { const r = parseXmlNode(tokens, i); topChildren.push(r[0]); i = r[1]; }
    else if (tk.t === 'self') { topChildren.push({ name: tk.name, attrs: tk.attrs, children: [], text: '' }); i++; }
    else if (tk.t === 'close') { i++; }
    else { text += tk.v || ''; i++; }
  }

  if (topChildren.length === 0) {
    const t = decodeEnt(text).trim();
    if (typeAttr) return { type: typeAttr, '#text': t };
    return t === '' ? null : t;
  }
  if (isArray) {
    const arr = [];
    for (const c of topChildren) arr.push(nodeToValue(c));
    return arr;
  }
  const groups = {}; const order = [];
  for (const c of topChildren) {
    if (!(c.name in groups)) { groups[c.name] = []; order.push(c.name); }
    groups[c.name].push(nodeToValue(c));
  }
  const obj = {};
  for (const k of order) obj[k] = groups[k].length === 1 ? groups[k][0] : groups[k];
  if (typeAttr) obj.type = typeAttr;
  return obj;
}

/** 解析 RetrievePropertiesEx 响应中所有 propSet 为 { 属性名: 值 } */
function parsePropSets(xml) {
  const out = {};
  const re = /<(?:\w+:)?propSet>([\s\S]*?)<\/(?:\w+:)?propSet>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const blk = m[1];
    const nm = /<(?:\w+:)?name>([^<]*)<\/(?:\w+:)?name>/.exec(blk);
    if (!nm) continue;
    const name = decodeEnt(nm[1].trim());
    const valStart = blk.search(/<(?:\w+:)?val\b/);
    if (valStart < 0) { out[name] = null; continue; }
    const openEnd = blk.indexOf('>', valStart);
    const closeIdx = blk.search(/<\/(?:\w+:)?val>/);
    if (openEnd < 0 || closeIdx < 0) { out[name] = null; continue; }
    const openTag = blk.substring(valStart, openEnd + 1);
    const attrs = parseAttrs(openTag);
    const innerXml = blk.substring(openEnd + 1, closeIdx);
    out[name] = parseValFragment(innerXml, attrs);
  }
  return out;
}

function decodeEnt(s) {
  if (s === null || s === undefined) return s;
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function toNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** vSphere 的 xsd:boolean 叶子节点解析后是字符串 'true'/'false'，统一判定真值 */
function isTrue(v) {
  return v === true || v === 'true' || v === '1' || v === 1;
}

/**
 * 判断物理网卡链路是否 up。
 * 依据 VMware 官方语义：PhysicalNic.linkSpeed（PhysicalNicLinkInfo）字段
 * "链路建立时存在，未建立时不返回(null)"；PhysicalNicLinkInfo 本身只有 speedMb / duplex，
 * 并没有 linkUp 字段。因此：linkSpeed 存在且 speedMb>0 → up；linkSpeed 缺失 → down。
 * 兼容个别版本以 linkSpeed.speedMb=0 或独立 linkUp 字段表达 down 的情况。
 */
function pnicLinkUp(n) {
  if (!n) return false;
  const ls = n.linkSpeed;
  if (ls && typeof ls === 'object') {
    // 显式带 linkUp 字段时以其为准（个别实现）
    if (ls.linkUp !== undefined && ls.linkUp !== null) return isTrue(ls.linkUp);
    const mb = toNum(ls.speedMb);
    if (mb !== null) return mb > 0;
    // 有 linkSpeed 对象但无速率信息，按 duplex 兜底，仍视为 up
    if (ls.duplex !== undefined && ls.duplex !== null) return true;
    return true;
  }
  // 无 linkSpeed 对象：回看网卡自身是否有 linkUp / 速率字段
  if (n.linkUp !== undefined && n.linkUp !== null) return isTrue(n.linkUp);
  return false;
}

/** 把 SOAP 属性集转换为统一的巡检结构 */
function buildResult(p, host) {
  const prod = getProp(p, 'config.product') || {};
  const hw = getProp(p, 'summary.hardware') || {};
  const sysInfo = getProp(p, 'hardware.systemInfo') || {};
  const rt = getProp(p, 'summary.runtime') || {};
  const qs = getProp(p, 'summary.quickStats') || {};
  const cfg = getProp(p, 'summary.config') || {};

  // 内存：summary.totalMemory 非法，改用 summary.hardware.memorySize（字节）
  const memTotalBytes = toNum(hw.memorySize);
  const memUsedMb = toNum(qs.overallMemoryUsage);
  const memTotalMb = memTotalBytes ? Math.round(memTotalBytes / 1048576) : null;
  const memPercent = (memTotalMb && memUsedMb != null) ? round1(memUsedMb / memTotalMb * 100) : null;

  // CPU：summary.totalCpu 非法，改用 hardware.cpuMhz × hardware.numCpuCores
  const cpuMhz = toNum(hw.cpuMhz);
  const numCpuCores = toNum(hw.numCpuCores);
  const cpuMhzTotal = (cpuMhz || 0) * (numCpuCores || 0);
  const cpuUsedMhz = toNum(qs.overallCpuUsage);
  const cpuPercent = (cpuMhzTotal > 0 && cpuUsedMhz != null) ? round1(cpuUsedMhz / cpuMhzTotal * 100) : null;

  const serial = extractSerial(sysInfo.otherIdentifyingInfo) || extractSerial(hw.otherIdentifyingInfo);
  const hostname = cfg.name || host;
  const version = prod.version || (cfg.product ? cfg.product.version : null) || '';
  const build = prod.build || '';
  const apiVersion = prod.apiVersion || '';

  // 数据存储
  const dsRefs = Array.isArray(p.datastore) ? p.datastore : [];
  // 虚拟机
  const vmRefs = Array.isArray(p.vm) ? p.vm : [];
  // 物理网卡
  const pnics = Array.isArray(getProp(p, 'config.network.pnic')) ? getProp(p, 'config.network.pnic')
    : (Array.isArray((getProp(p, 'config.network') || {}).pnic) ? getProp(p, 'config.network').pnic : []);

  const hwStatus = getProp(p, 'runtime.hardwareStatusInfo') || null;
  const healthState = getProp(p, 'runtime.healthStateSystemStatusInfo') || null;

  return {
    ok: true,
    kind: 'esxi',
    esxi: {
      hostname: hostname,
      product: prod.fullName || 'VMware ESXi',
      version: version,
      build: build,
      apiVersion: apiVersion,
      vendor: prod.vendor || sysInfo.vendor || hw.vendor || '',
      model: sysInfo.model || hw.model || '',
      serial: serial,
      uuid: sysInfo.uuid || hw.uuid || '',
      cpuModel: hw.cpuModel || '',
      cpuSockets: toNum(hw.numCpuPkgs),
      cpuCores: numCpuCores,
      cpuThreads: toNum(hw.numCpuThreads),
      cpuMhz: cpuMhz,
      cpuTotalMhz: cpuMhzTotal > 0 ? cpuMhzTotal : null,
      cpuUsedMhz: cpuUsedMhz,
      cpuPercent: cpuPercent,
      memTotalMb: memTotalMb,
      memUsedMb: memUsedMb,
      memPercent: memPercent,
      uptimeSec: toNum(qs.uptime),
      bootTime: rt.bootTime || null,
      connectionState: rt.connectionState || null,
      powerState: rt.powerState || null,
      overallStatus: getProp(p, 'summary.overallStatus') || null,
      maintenanceMode: isTrue(rt.inMaintenanceMode),
      rebootRequired: isTrue(getProp(p, 'summary.rebootRequired')),
      hardwareStatus: hwStatus,
      healthState: healthState,
      vmCount: vmRefs.length,
      datastoreCount: dsRefs.length,
      pnics: pnics.map((n) => ({
        device: n.device || n.key || '',
        mac: n.mac || '',
        speed: (n.linkSpeed && n.linkSpeed.speedMb != null) ? n.linkSpeed.speedMb + ' Mbps' : '—',
        connected: pnicLinkUp(n)
      })),
      // 虚拟机与数据存储需要二次查询（引用型属性），在主流程中补充
      _vmRefs: vmRefs,
      _dsRefs: dsRefs
    },
    metrics: {
      hostname: hostname,
      os: 'VMware ESXi ' + version,
      kernel: null,
      uptime_sec: toNum(qs.uptime),
      cores: numCpuCores,
      load1: null, load5: null, load15: null,
      cpu_percent: cpuPercent,
      mem_total_mb: memTotalMb,
      mem_used_mb: memUsedMb,
      mem_percent: memPercent,
      swap_total_mb: null, swap_used_mb: null,
      procs: vmRefs.length,
      zombies: null,
      disks: []
    },
    services: [],
    customs: []
  };
}

/** 解析 RetrievePropertiesEx 响应中的多个 <objects> 块，每块返回 { 属性名: 值 } */
function parseObjects(xml) {
  const results = [];
  const objRe = /<(?:\w+:)?objects>([\s\S]*?)<\/(?:\w+:)?objects>/g;
  let m;
  while ((m = objRe.exec(xml)) !== null) {
    const blk = m[1];
    const props = {};
    const psRe = /<(?:\w+:)?propSet>([\s\S]*?)<\/(?:\w+:)?propSet>/g;
    let pm;
    while ((pm = psRe.exec(blk)) !== null) {
      const sub = pm[1];
      const nm = /<(?:\w+:)?name>([^<]*)<\/(?:\w+:)?name>/.exec(sub);
      if (!nm) continue;
      const name = decodeEnt(nm[1].trim());
      const valStart = sub.search(/<(?:\w+:)?val\b/);
      if (valStart < 0) { props[name] = null; continue; }
      const openEnd = sub.indexOf('>', valStart);
      const closeIdx = sub.search(/<\/(?:\w+:)?val>/);
      if (openEnd < 0 || closeIdx < 0) { props[name] = null; continue; }
      const openTag = sub.substring(valStart, openEnd + 1);
      const attrs = parseAttrs(openTag);
      const innerXml = sub.substring(openEnd + 1, closeIdx);
      props[name] = parseValFragment(innerXml, attrs);
    }
    results.push(props);
  }
  return results;
}

/** 从 MOR 引用中提取 mor 字符串与类型 */
function refToMor(r, defaultType) {
  let mor = '', type = defaultType;
  if (typeof r === 'string') { mor = r; }
  else if (r && typeof r === 'object') {
    mor = r['#text'] || r._value || r.value || r.mor || '';
    if (r.type) type = r.type;
  }
  return { mor, type };
}

/** 查询虚拟机列表（名称、电源状态、资源） */
async function fetchVms(host, port, ns, sessionId, refs, timeoutMs) {
  if (!refs || !refs.length) return [];
  const objs = refs.slice(0, 200).map((r) => {
    const { mor, type } = refToMor(r, 'VirtualMachine');
    return '<obj type="' + type + '">' + escapeXml(mor) + '</obj>';
  }).join('');
  const xml = '<RetrievePropertiesEx xmlns="' + ns + '">'
    + '<_this type="PropertyCollector">ha-property-collector</_this>'
    + '<specSet><propSet><type>VirtualMachine</type><all>false</all>'
    + '<pathSet>name</pathSet><pathSet>runtime.powerState</pathSet>'
    + '<pathSet>config.hardware.numCPU</pathSet><pathSet>config.hardware.memoryMB</pathSet>'
    + '<pathSet>guest.guestFullName</pathSet><pathSet>guest.ipAddress</pathSet>'
    + '<pathSet>summary.overallStatus</pathSet>'
    + '</propSet><objectSet>' + objs + '<skip>false</skip></objectSet></specSet>'
    + '<options><maxObjects>200</maxObjects></options></RetrievePropertiesEx>';
  const r = await soapRequest(host, port, xml, ns, sessionId, timeoutMs);
  if (r.status !== 200) return [];
  const out = [];
  for (const props of parseObjects(r.body)) {
    out.push({
      name: getProp(props, 'name'),
      power: getProp(props, 'runtime.powerState'),
      cpu: toNum(getProp(props, 'config.hardware.numCPU')),
      memMb: toNum(getProp(props, 'config.hardware.memoryMB')),
      guestOs: getProp(props, 'guest.guestFullName'),
      ip: getProp(props, 'guest.ipAddress'),
      status: getProp(props, 'summary.overallStatus')
    });
  }
  return out;
}

/** 查询数据存储容量 */
async function fetchDatastores(host, port, ns, sessionId, refs, timeoutMs) {
  if (!refs || !refs.length) return [];
  const objs = refs.slice(0, 100).map((r) => {
    const { mor, type } = refToMor(r, 'Datastore');
    return '<obj type="' + type + '">' + escapeXml(mor) + '</obj>';
  }).join('');
  const xml = '<RetrievePropertiesEx xmlns="' + ns + '">'
    + '<_this type="PropertyCollector">ha-property-collector</_this>'
    + '<specSet><propSet><type>Datastore</type><all>false</all>'
    + '<pathSet>name</pathSet><pathSet>summary.capacity</pathSet>'
    + '<pathSet>summary.freeSpace</pathSet><pathSet>summary.type</pathSet>'
    + '<pathSet>summary.accessible</pathSet><pathSet>summary.maintenanceMode</pathSet>'
    + '</propSet><objectSet>' + objs + '<skip>false</skip></objectSet></specSet>'
    + '<options><maxObjects>100</maxObjects></options></RetrievePropertiesEx>';
  const r = await soapRequest(host, port, xml, ns, sessionId, timeoutMs);
  if (r.status !== 200) return [];
  const out = [];
  for (const props of parseObjects(r.body)) {
    const cap = toNum(getProp(props, 'summary.capacity'));
    const free = toNum(getProp(props, 'summary.freeSpace'));
    out.push({
      name: getProp(props, 'name'),
      type: getProp(props, 'summary.type'),
      capacityMb: cap ? Math.round(cap / 1048576) : null,
      freeMb: free ? Math.round(free / 1048576) : null,
      usedMb: (cap && free != null) ? Math.round((cap - free) / 1048576) : null,
      usedPercent: (cap && free != null) ? round1((cap - free) / cap * 100) : null,
      accessible: isTrue(getProp(props, 'summary.accessible')),
      maintenanceMode: getProp(props, 'summary.maintenanceMode')
    });
  }
  return out;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

async function collectEsxi(server, timeoutMs) {
  const host = server.host;
  const port = toNum(server.port) || 443;
  const auth = server.auth || {};
  const user = auth.username || 'root';
  const pass = auth.password || '';
  const perCall = Math.max(8000, Math.min(timeoutMs || 60000, 60000));

  // 预检端口，给出针对性诊断（443 被防火墙静默丢包是最常见问题）
  const pre = await precheckPort(host, port, Math.min(15000, Math.max(5000, Math.round(perCall / 3))));
  if (!pre.ok) {
    return { ok: false, kind: 'esxi', error: pre.hint, name: server.name, host: host };
  }

  let ns = NS_CANDIDATES[0];
  let sessionId = null;
  let loggedNs = null;

  try {
    // 逐个命名空间尝试登录，兼容不同 ESXi 版本
    let lastErr = null;
    for (const cand of NS_CANDIDATES) {
      ns = cand;
      const loginXml = '<Login xmlns="' + ns + '">'
        + '<_this type="SessionManager">ha-sessionmgr</_this>'
        + '<userName>' + escapeXml(user) + '</userName>'
        + '<password>' + escapeXml(pass) + '</password>'
        + '</Login>';
      try {
        const lr = await soapRequest(host, port, loginXml, ns, null, perCall);
        const f = checkFault(lr.body);
        if (lr.status === 200 && !f && lr.sessionId) {
          sessionId = lr.sessionId;
          loggedNs = ns;
          break;
        }
        lastErr = f || ('HTTP ' + lr.status);
        // 认证类错误直接终止，不再尝试其他命名空间
        if (/InvalidLogin|Cannot complete login|Authentication/i.test(String(lastErr))) break;
      } catch (e) {
        lastErr = e.message;
      }
    }

    if (!sessionId) {
      return {
        ok: false, kind: 'esxi', name: server.name, host: host,
        error: friendlyEsxiError(new Error('ESXi 登录失败：' + (lastErr || '未获取到会话，账号密码可能错误')), host, port)
      };
    }
    ns = loggedNs;

    // 查询主机属性：先用详细属性集；若因属性非法被拒（InvalidProperty/ServerFaultCode），
    // 回退到整对象属性集，最大限度兼容不同 ESXi 版本。
    let p = null;
    let propErr = null;
    for (const propSet of [HOST_PROPS, HOST_PROPS_FALLBACK]) {
      const propsXml = '<RetrievePropertiesEx xmlns="' + ns + '">'
        + '<_this type="PropertyCollector">ha-property-collector</_this>'
        + '<specSet><propSet><type>HostSystem</type><all>false</all>'
        + propSet.map((x) => '<pathSet>' + escapeXml(x) + '</pathSet>').join('')
        + '</propSet><objectSet><obj type="HostSystem">ha-host</obj><skip>false</skip></objectSet>'
        + '</specSet><options/></RetrievePropertiesEx>';

      const pr = await soapRequest(host, port, propsXml, ns, sessionId, perCall);
      const pf = checkFault(pr.body);
      if (pr.status === 200 && !pf) {
        const parsed = parsePropSets(pr.body);
        if (Object.keys(parsed).length) { p = parsed; break; }
        propErr = 'ESXi 未返回任何主机属性，可能是账号权限不足或该主机不受管';
      } else {
        propErr = pf || ('HTTP ' + pr.status);
      }
    }

    if (!p) {
      const detail = String(propErr || '未知错误');
      let hint = 'ESXi 主机属性查询失败：' + detail;
      if (/InvalidProperty/i.test(detail)) {
        hint += '\n说明：请求的某个属性路径在该 ESXi 版本上不受支持，已尝试整对象回退仍失败。'
          + '请确认账号对主机具备"读取(Read-only)"及以上权限。';
      } else if (/ServerFaultCode/i.test(detail) && !/InvalidProperty/i.test(detail)) {
        hint += '\n说明：ESXi 返回了服务端错误但未给出具体属性名。'
          + '常见原因为账号权限不足（无法读取主机对象），请确认该账号能正常登录 vSphere Client 并查看该主机。';
      }
      return { ok: false, kind: 'esxi', name: server.name, host: host, error: hint };
    }

    const result = buildResult(p, host);

    // 补充虚拟机与数据存储（失败不影响主体结果）
    try {
      result.esxi.vms = await fetchVms(host, port, ns, sessionId, result.esxi._vmRefs, perCall);
    } catch (e) { result.esxi.vms = []; result.esxi.vmError = e.message; }
    try {
      result.esxi.datastores = await fetchDatastores(host, port, ns, sessionId, result.esxi._dsRefs, perCall);
    } catch (e) { result.esxi.datastores = []; result.esxi.dsError = e.message; }
    delete result.esxi._vmRefs;
    delete result.esxi._dsRefs;

    // 注销会话，避免占用 ESXi 会话槽位
    try {
      const logoutXml = '<Logout xmlns="' + ns + '">'
        + '<_this type="SessionManager">ha-sessionmgr</_this></Logout>';
      await soapRequest(host, port, logoutXml, ns, sessionId, 8000);
    } catch (e) { /* 注销失败可忽略 */ }

    result.name = server.name;
    result.host = host;
    result.osLabel = 'ESXi';
    result.connectLabel = 'vSphere API';
    return result;
  } catch (e) {
    return {
      ok: false, kind: 'esxi', name: server.name, host: host,
      error: friendlyEsxiError(e, host, port)
    };
  }
}

module.exports = { collectEsxi, friendlyEsxiError, HOST_PROPS, HOST_PROPS_FALLBACK, parsePropSets, parseObjects, buildResult, getProp, extractSerial, refToMor, parseValFragment, parseAttrs, pnicLinkUp, isTrue };
