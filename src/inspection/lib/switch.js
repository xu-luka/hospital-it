'use strict';
/**
 * 网络交换机巡检模块：SSH 登录设备 CLI 采集
 * 主路径：shell 交互通道（逐条发命令、按提示符判定结束、自动翻页）
 * 回退：exec 通道（部分设备只支持 exec）
 * 兼容华为/H3C（display 系）与思科（show 系）命令风格
 */

const { sshConnect, sshExec, friendlySshError } = require('./sshutil');
const { truncate, sleep } = require('./common');

const PROMPT_RE = /^(<[^>\n]{1,60}>|\[[^\]\n]{1,60}\]|[A-Za-z0-9_.\-()]{1,40}[>#])\s*$/;

/** 候选命令组：按顺序探测，取第一个 version 命令有内容且通过判别命令的风格 */
const COMMAND_SETS = [
  {
    vendor: '华为/H3C 风格',
    paging: ['screen-length temporary 0', 'screen-length disable'],
    version: 'display version',
    sections: [
      { title: 'CPU 使用率', cmd: 'display cpu-usage' },
      { title: '内存', cmd: 'display memory' },
      { title: '接口状态', cmd: 'display interface brief' },
      { title: '环境（温度/风扇/电源）', cmd: 'display environment' },
      { title: '当前配置', cmd: 'display current-configuration', long: true }
    ]
  },
  {
    vendor: '360/网神 风格',
    paging: ['terminal length 0'],
    version: 'show version',
    // 与思科都用 show version，用 show system info 判别（思科无此命令）
    discriminator: 'show system info',
    sections: [
      { title: '系统信息', cmd: 'show system info' },
      { title: '接口状态', cmd: 'show interface' },
      { title: '授权信息', cmd: 'show license' },
      { title: 'HA 状态', cmd: 'show ha' }
    ]
  },
  {
    vendor: '思科/锐捷 风格',
    paging: ['terminal length 0'],
    version: 'show version',
    sections: [
      { title: 'CPU 使用率', cmd: 'show processes cpu' },
      { title: '内存', cmd: 'show memory' },
      { title: '接口状态', cmd: 'show interface status' },
      { title: '环境（温度/风扇/电源）', cmd: 'show environment' },
      { title: '当前配置', cmd: 'show running-config', long: true }
    ]
  }
];

/** 打开 shell 通道 */
function openShell(conn) {
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

/** 等待条件满足或超时；期间自动处理 More 翻页 */
function waitFor(getBuf, stream, cond, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      const buf = getBuf();
      if (/----\s*More\s*----/i.test(buf.slice(-80))) {
        try { stream.write(' '); } catch (e) { /* 忽略 */ }
      }
      if (cond(buf)) { resolve(true); return; }
      if (Date.now() > deadline) { resolve(false); return; }
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** 去掉命令回显行与首尾提示符行（输出中间的 [xxx] 段标题等保留，避免误删配置内容） */
function stripShell(text, cmd) {
  const cmdTrim = String(cmd).trim();
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === cmdTrim) continue;
    if (/^Info: The max number of VTY/i.test(t)) continue; // 登录提示信息首行
    if (/^of current VTY users on line is/i.test(t)) continue;
    if (/^The current login time is/i.test(t)) continue;
    if (/----\s*More\s*----/i.test(t)) continue;
    out.push(lines[i]);
  }
  while (out.length && out[0].trim() === '') out.shift();
  while (out.length && PROMPT_RE.test(out[0].trim())) out.shift();
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  while (out.length && PROMPT_RE.test(out[out.length - 1].trim())) out.pop();
  return out.join('\n').trim();
}

/** shell 通道采集主路径 */
async function collectSwitchShell(server, timeoutMs) {
  const conn = await sshConnect(server, timeoutMs);
  let stream;
  try {
    stream = await openShell(conn);
  } catch (e) {
    try { conn.end(); } catch (e2) { /* 忽略 */ }
    throw new Error('__NO_SHELL__');
  }

  let buf = '';
  stream.on('data', (d) => {
    buf += d.toString();
    if (buf.length > 800000) buf = buf.slice(-800000);
  });
  stream.stderr.on('data', () => { /* 静默 */ });
  stream.on('error', () => { /* 静默 */ });

  const sections = [];
  let vendor = null;

  try {
    // 等初始提示符
    await waitFor(() => buf, stream, (b) => PROMPT_RE.test((b.trim().split('\n').pop() || '').trim()), Math.min(timeoutMs, 15000));

    // 探测命令风格：逐个风格尝试 version 命令，有判别命令的需判别命令也成功
    const seenVersion = {};
    for (const set of COMMAND_SETS) {
      let out = seenVersion[set.version];
      if (out === undefined) {
        buf = '';
        stream.write(set.version + '\n');
        await waitFor(() => buf, stream, (b) => {
          const last = (b.replace(/\r/g, '').trim().split('\n').pop() || '').trim();
          return b.length > set.version.length + 10 && PROMPT_RE.test(last);
        }, Math.min(timeoutMs, 20000));
        out = stripShell(buf, set.version);
        seenVersion[set.version] = out;
      }
      if (!(out.length > 40 && !/Error|Unrecognized|Invalid|Unknown/i.test(out.slice(0, 100)))) continue;
      // 判别命令（用于区分同用 show version 的不同风格）
      if (set.discriminator) {
        buf = '';
        stream.write(set.discriminator + '\n');
        await waitFor(() => buf, stream, (b) => {
          const last = (b.replace(/\r/g, '').trim().split('\n').pop() || '').trim();
          return b.length > set.discriminator.length + 4 && PROMPT_RE.test(last);
        }, Math.min(timeoutMs, 15000));
        const dOut = stripShell(buf, set.discriminator);
        if (dOut.length < 20 || /Error|Unrecognized|Invalid|Unknown|Incomplete/i.test(dOut.slice(0, 100))) continue;
      }
      vendor = set;
      sections.push({ title: '设备版本', cmd: set.version, out: truncate(out, 4000) });
      // 发分页禁用命令（结果忽略）
      for (const p of set.paging) {
        buf = '';
        stream.write(p + '\n');
        await waitFor(() => buf, stream, (b) => {
          const last = (b.replace(/\r/g, '').trim().split('\n').pop() || '').trim();
          return b.length > p.length + 2 && PROMPT_RE.test(last);
        }, 8000);
      }
      break;
    }
    if (!vendor) throw new Error('设备未识别命令风格（display/show 均无有效输出）');

    for (const c of vendor.sections) {
      buf = '';
      stream.write(c.cmd + '\n');
      const cmdTimeout = c.long ? Math.max(timeoutMs * 2, 60000) : Math.min(timeoutMs, 20000);
      await waitFor(() => buf, stream, (b) => {
        const last = (b.replace(/\r/g, '').trim().split('\n').pop() || '').trim();
        return b.length > c.cmd.length + 4 && PROMPT_RE.test(last);
      }, cmdTimeout);
      const out = stripShell(buf, c.cmd);
      const limit = c.long ? 100000 : 4000;
      sections.push({ title: c.title, cmd: c.cmd, out: out ? truncate(out, limit) : '(无输出或命令不支持)' });
    }
  } finally {
    try { stream.close(); } catch (e) { /* 忽略 */ }
    try { conn.end(); } catch (e) { /* 忽略 */ }
  }

  const verText = (sections[0] && sections[0].out) || '';
  const hw = { vendor_hint: vendor.vendor, software: '', model: '', uptime: '' };
  const mSoft = verText.match(/(?:Software[^\n]*|VRP[^\n]*|Version[^\n]*)/i);
  if (mSoft) hw.software = mSoft[0].trim().slice(0, 120);
  const mModel = verText.match(/(?:Model[^\n]*|[A-Z]{2,}\d{3,4}[A-Z0-9-]*)/i);
  if (mModel) hw.model = mModel[0].trim().slice(0, 80);
  const mUp = verText.match(/(?:uptime is[^\n]*|RunTime[^\n]*)/i);
  if (mUp) hw.uptime = mUp[0].trim().slice(0, 120);

  return applySwitchMetrics({
    ok: true,
    kind: 'switch',
    hw: hw,
    sections: sections,
    metrics: {
      hostname: server.host, os: '网络交换机', kernel: hw.software,
      uptime_sec: null, cores: null, load1: null, load5: null, load15: null,
      cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null,
      swap_total_mb: null, swap_used_mb: null, procs: null, zombies: null, disks: []
    },
    services: [],
    customs: []
  });
}

/** exec 通道回退：逐命令独立会话（部分设备每次只允许一条命令后断开） */
async function collectSwitchExec(server, timeoutMs) {
  /** 独立会话执行单条命令 */
  async function execOnce(cmd, cmdTimeout) {
    let conn = null;
    try {
      conn = await sshConnect(server, Math.max(timeoutMs, 20000));
      return await sshExec(conn, cmd, cmdTimeout);
    } finally {
      if (conn) { try { conn.end(); } catch (e) { /* 忽略 */ } }
    }
  }

  let style = null;
  for (let i = 0; i < COMMAND_SETS.length; i++) {
    const set = COMMAND_SETS[i];
    const r = await execOnce(set.version, Math.min(timeoutMs, 20000));
    const out = (r.stdout || '').trim();
    if (!(out && out.length > 20 && !/% (Unrecognized|Invalid|Incomplete|Unknown)/i.test(out))) continue;
    if (set.discriminator) {
      const d = await execOnce(set.discriminator, Math.min(timeoutMs, 15000));
      const dOut = (d.stdout || '').trim();
      if (!(dOut && dOut.length > 20 && !/% (Unrecognized|Invalid|Incomplete|Unknown)/i.test(dOut))) continue;
    }
    style = i;
    break;
  }
  if (style === null) throw new Error('设备未响应 version 查询命令');
  const set = COMMAND_SETS[style];
  const sections = [{ title: '设备版本', cmd: set.version, out: null }];
  const vr = await execOnce(set.version, Math.min(timeoutMs, 20000));
  sections[0].out = truncate((vr.stdout || '').trim(), 4000);
  for (const c of set.sections) {
    const r = await execOnce(c.cmd, c.long ? Math.max(timeoutMs * 2, 60000) : Math.min(timeoutMs, 20000));
    const out = (r.stdout || '').trim();
    sections.push({ title: c.title, cmd: c.cmd, out: out ? truncate(out, c.long ? 100000 : 4000) : '(无输出或命令不支持)' });
  }
  const verText = sections[0].out || '';
  const hw = { vendor_hint: set.vendor, software: '', model: '', uptime: '' };
  const mSoft = verText.match(/(?:Software[^\n]*|VRP[^\n]*|Version[^\n]*)/i);
  if (mSoft) hw.software = mSoft[0].trim().slice(0, 120);
  const mModel = verText.match(/(?:Model[^\n]*|USG\d+[A-Z0-9-]*|S\d{3,4}[A-Z0-9-]*|[A-Z]{2,}\d{3,4}[A-Z0-9-]*)/i);
  if (mModel) hw.model = mModel[0].trim().slice(0, 80);
  const mUp = verText.match(/(?:uptime is[^\n]*|RunTime[^\n]*)/i);
  if (mUp) hw.uptime = mUp[0].trim().slice(0, 120);
  return applySwitchMetrics({
    ok: true, kind: 'switch', hw: hw, sections: sections,
    metrics: {
      hostname: server.host, os: '网络交换机', kernel: hw.software,
      uptime_sec: null, cores: null, load1: null, load5: null, load15: null,
      cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null,
      swap_total_mb: null, swap_used_mb: null, procs: null, zombies: null, disks: []
    },
    services: [], customs: []
  });
}

/** 采集入口 */
async function collectSwitch(server, timeoutMs) {
  try {
    return await collectSwitchShell(server, timeoutMs);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg === '__NO_SHELL__') {
      try { return await collectSwitchExec(server, timeoutMs); }
      catch (e2) { return { ok: false, error: friendlySshError(e2) }; }
    }
    if (/认证|超时|拒绝|重置|不可达|解析/.test(msg)) {
      return { ok: false, error: friendlySshError(e) };
    }
    // shell 路径其他错误也尝试 exec 回退
    try { return await collectSwitchExec(server, timeoutMs); }
    catch (e2) { return { ok: false, error: friendlySshError(e) + '（exec 回退：' + friendlySshError(e2) + '）' }; }
  }
}

/**
 * 从已采集的 sections 文本里量化出 CPU/内存/温度/端口等指标。
 * 兼容华为/H3C（display 系）与思科（show 系）输出格式；解析不到则返回 null，不报错。
 * 返回 { cpu_percent, mem_percent, temps:[{label,c}], ports:{total,up,down,errors} }
 */
function parseSwitchMetrics(sections) {
  const outOf = (kw) => {
    const s = (sections || []).find((x) => typeof x.title === 'string' && x.title.indexOf(kw) >= 0);
    return s && typeof s.out === 'string' ? s.out : '';
  };
  const cpuText = outOf('CPU');
  const memText = outOf('内存') || outOf('Memory');
  const envText = outOf('环境') || outOf('Environment') || outOf('温度');
  const ifText = outOf('接口') || outOf('Interface');

  // CPU 使用率
  let cpu_percent = null;
  if (cpuText) {
    const mHw = cpuText.match(/CPU\s*(?:Using\s*)?Percentage\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (mHw) cpu_percent = parseFloat(mHw[1]);
    else {
      const mCi = cpuText.match(/five\s*seconds?\s*:\s*(\d+(?:\.\d+)?)\s*%/i);
      if (mCi) cpu_percent = parseFloat(mCi[1]);
      else {
        const mAny = cpuText.match(/(\d+(?:\.\d+)?)\s*%/);
        if (mAny) cpu_percent = parseFloat(mAny[1]);
      }
    }
  }

  // 内存使用率
  let mem_percent = null;
  if (memText) {
    const mHw = memText.match(/Memory\s*(?:Using\s*)?Percentage\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
    if (mHw) mem_percent = parseFloat(mHw[1]);
    else {
      const mTot = memText.match(/Total:\s*(\d[\d,]*)/i);
      const mUsed = memText.match(/Used:\s*(\d[\d,]*)/i);
      if (mTot && mUsed) {
        const tot = parseFloat(mTot[1].replace(/,/g, ''));
        const used = parseFloat(mUsed[1].replace(/,/g, ''));
        if (tot > 0) mem_percent = Math.round((used / tot) * 1000) / 10;
      } else {
        const mAny = memText.match(/(\d+(?:\.\d+)?)\s*%/);
        if (mAny) mem_percent = parseFloat(mAny[1]);
      }
    }
  }

  // 温度（环境传感器）
  const temps = [];
  if (envText) {
    for (const ln of envText.split(/\r?\n/)) {
      if (!/(?:temp|温度|slot|sensor|thermal)/i.test(ln)) continue;
      const m = ln.match(/(\d+(?:\.\d+)?)\s*°?\s*C\b/i) || ln.match(/[:=]\s*(\d+(?:\.\d+)?)\s*$/);
      if (m) temps.push({ label: ln.trim().slice(0, 40), c: parseFloat(m[1]) });
    }
  }

  // 端口 up/down 与错包计数
  const ports = { total: null, up: null, down: null, errors: null };
  if (ifText) {
    const ifcRe = /^(?:GE|XGE|10GE|25GE|40GE|100GE|Eth|Gigabit|Ten|Twenty|Forty|Hundred|FastEthernet|Gi|Te|Fa|Hu|Po|Vlanif|Vlan|LoopBack|NULL|MEth|ME|Serial|Tunnel|XGi)\b|^\S+\/\d+(?:\/\d+)?\b/i;
    let total = 0, up = 0, down = 0, errors = 0;
    for (const ln of ifText.split(/\r?\n/)) {
      const t = ln.trim();
      if (!t || !ifcRe.test(t)) continue;
      total++;
      const isUp = /\b(up|connected)\b/i.test(t) && !/\b(down|notconnect|disabled|administratively\s+down)\b/i.test(t);
      if (isUp) up++; else down++;
      // 错包列仅对含利用率(%)的华为式 brief 有效；思科 show interface status 无错包列，跳过
      if (/%/.test(t)) {
        const ints = (t.match(/\b(\d+)\b/g) || []).map(Number);
        if (ints.length >= 2) errors += ints[ints.length - 2] + ints[ints.length - 1];
      }
    }
    if (total > 0) { ports.total = total; ports.up = up; ports.down = down; ports.errors = errors; }
  }

  return { cpu_percent, mem_percent, temps, ports };
}

/** 把解析出的量化指标回填到采集结果（metrics 与大屏/报告共用 hw） */
function applySwitchMetrics(result) {
  const parsed = parseSwitchMetrics(result.sections || []);
  result.metrics = result.metrics || {};
  result.metrics.cpu_percent = parsed.cpu_percent;
  result.metrics.mem_percent = parsed.mem_percent;
  result.metrics.temps = parsed.temps;
  result.metrics.ports = parsed.ports;
  result.hw = Object.assign({}, result.hw, {
    temps: parsed.temps,
    ports: parsed.ports,
    cpu_percent: parsed.cpu_percent,
    mem_percent: parsed.mem_percent
  });
  return result;
}

module.exports = { collectSwitch, parseSwitchMetrics, applySwitchMetrics };
