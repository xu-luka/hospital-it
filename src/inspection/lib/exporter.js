'use strict';
/**
 * windows_exporter 采集通道（HTTP 拉取 Prometheus 文本指标）
 *
 * 与 SSH / WMI 并列的第三种 Windows 采集方式：目标机装 windows_exporter 后，
 * 在 9182 端口提供只读的 /metrics 文本，本模块拉取并换算成与 collectWindows
 * 完全一致的结果结构（ok / metrics / services / customs）。
 *
 * 为什么值得单独开一条通道：
 *   1. 不需要任何远程登录协议 —— 没有 sshd、没有密码、没有 DCOM 动态端口；
 *   2. 只读 HTTP，攻击面就是一个 GET，防火墙限源即可；
 *   3. 端点不是「能执行命令的通道」，CVE 影响面与 SSH 完全不是一个量级。
 *
 * 三个必须在实现里处理的现实问题（踩了才不返工）：
 *   A. CPU 与网络速率都是 counter（开机至今的累计值），单次抓取算不出使用率，
 *      必须隔 1 秒抓两次做差分 —— 这是 Prometheus rate() 的最小实现。
 *   B. 指标名改过两轮：0.30（system_up_time → boot_time_timestamp_seconds、
 *      page_file 从 os 拆出去、cs 收集器还在），0.32（cpu_time_total →
 *      cpu_time_seconds_total、boot_time_timestamp 去掉 _seconds、commit_limit
 *      加 _bytes、current_bandwidth 改名且 bit/s 变 byte/s、服务标签 name → service、
 *      cs 收集器整个移除、os 只留 3 个指标）。每处取值一律「0.32 新名优先、
 *      0.30 / 0.29 旧名兜底」，否则装 0.32 的机器 CPU / uptime / 核数 / 服务
 *      会静默变 null，界面上看着就像「这条通道采不到东西」。
 *   C. 收集器是可选启用的。service / logical_disk 没开时，对应指标根本不存在，
 *      此时**绝不能把「查不到」当成「服务没跑」** —— 那会把一台正常的机器
 *      判成 critical。查不到就整体跳过该项，并在 note 里说明原因。
 */

const http = require('http');
const https = require('https');
const { round1, sleep } = require('./common');

const DEFAULT_PORT = 9182;
const MAX_BODY = 8 * 1024 * 1024;
const SAMPLE_GAP_MS = 1000;
const MAX_NET_IFACES = 6;

/**
 * P1：自定义指标只走 windows_exporter 官方 textfile 采集器。
 * 目标机把本机脚本算出的业务指标写成 .prom 文件，exporter 随 /metrics 一起吐出；
 * 本通道只认这个前缀开头的指标，其余一概忽略（不会误把系统指标当业务指标，
 * 也不会执行任何远程命令）。运维侧约定见交付文档，服务端不需要逐条配置。
 */
const TEXTFILE_PREFIX = 'his_';
const MAX_TEXTFILE_METRICS = 50;

/**
 * 静态（gauge）扩展指标目录。names 按「新名优先、旧名兜底」排列。
 * 只登记 windows_exporter 实际存在的指标名，查不到就留 null —— 收集器没开
 * 属于正常情况，绝不拿 0 冒充「没有」。
 * byLabel 表示这条指标按标签分组成多个序列（如每张网卡各有一行）。
 */
const METRIC_CATALOG = Object.freeze([
  { key: 'threads', group: 'system', unit: '个', names: ['windows_system_threads', 'windows_os_threads'], desc: '系统线程数' },
  { key: 'handles', group: 'system', unit: '个', names: ['windows_system_handle_count', 'windows_os_handle_count'], desc: '系统句柄数' },
  { key: 'processor_queue_length', group: 'system', unit: '个', names: ['windows_system_processor_queue_length'], desc: '处理器队列长度' },
  { key: 'memory_cache_bytes', group: 'memory', unit: 'B', names: ['windows_memory_cache_bytes', 'windows_os_cache_bytes'], desc: '内存缓存' },
  { key: 'memory_committed_bytes', group: 'memory', unit: 'B', names: ['windows_memory_committed_bytes', 'windows_os_committed_bytes'], desc: '已提交内存' },
  { key: 'memory_commit_limit_bytes', group: 'memory', unit: 'B', names: ['windows_memory_commit_limit_bytes', 'windows_memory_commit_limit', 'windows_os_commit_limit'], desc: '提交上限' },
  { key: 'net_current_bandwidth', group: 'net', unit: 'bps', byLabel: 'nic', names: ['windows_net_current_bandwidth_bytes', 'windows_net_current_bandwidth'], desc: '网卡标称带宽' }
]);

/** counter 类扩展指标：必须两次采样做差分才有意义（每秒速率） */
const COUNTER_CATALOG = Object.freeze([
  { key: 'context_switches_total', group: 'system', names: ['windows_system_context_switches_total', 'windows_system_context_switches'] },
  { key: 'page_faults_total', group: 'memory', names: ['windows_memory_page_faults_total', 'windows_os_page_faults_total'] }
]);

/* ---------------- HTTP ---------------- */

/**
 * 拉一次 /metrics。永不 reject，统一返回 { ok, body } 或 { ok:false, error }。
 */
function fetchMetrics(urlStr, headers, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };

    let u;
    try {
      u = new URL(urlStr);
    } catch (e) {
      finish({ ok: false, error: '地址格式不对：' + urlStr });
      return;
    }
    const isTls = u.protocol === 'https:';
    const mod = isTls ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isTls ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ Accept: 'text/plain;version=0.0.4' }, headers || {}),
      // windows_exporter 默认用自签证书；本通道只在内网、且已按来源 IP 限源，
      // 因此不校验证书链。若以后换了正式证书，删掉这行即可恢复校验。
      rejectUnauthorized: false,
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode === 401 || res.statusCode === 403) {
        res.resume();
        finish({ ok: false, error: 'HTTP ' + res.statusCode + '（该端点启用了认证，请填写 Basic 账号口令）' });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        finish({ ok: false, error: 'HTTP ' + res.statusCode + ' ' + (res.statusMessage || '') });
        return;
      }
      let buf = '';
      let size = 0;
      res.setEncoding('utf8');
      res.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) {
          try { res.destroy(); } catch (e) { /* 忽略 */ }
          finish({ ok: false, error: '响应过大（超过 ' + Math.round(MAX_BODY / 1048576) + ' MB）' });
          return;
        }
        buf += d;
      });
      res.on('end', () => finish({ ok: true, body: buf }));
      res.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    });
    req.on('timeout', () => {
      try { req.destroy(); } catch (e) { /* 忽略 */ }
      finish({ ok: false, error: '拉取超时（' + Math.round(timeoutMs / 1000) + ' 秒）' });
    });
    req.on('error', (e) => finish({ ok: false, error: String((e && e.message) || e) }));
    req.end();
  });
}

/* ---------------- Prometheus 文本格式 ---------------- */

/**
 * 解析文本指标为 Map<name, [{ labels, value }]>。
 * 行格式： name{k="v",k2="v2"} 12345.6
 * 以 # 开头的 HELP / TYPE 注释行跳过。
 */
function parseMetrics(text) {
  const out = new Map();
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.charCodeAt(0) === 35) continue; // '#'
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const head = line.slice(0, sp).trim();
    const value = Number(line.slice(sp + 1).trim());
    // +Inf / NaN / 空值一律丢弃：参与差分只会算出 NaN
    if (!isFinite(value)) continue;

    let name = head;
    let labels = null;
    const ob = head.indexOf('{');
    if (ob > 0 && head.charCodeAt(head.length - 1) === 125) { // '}'
      name = head.slice(0, ob);
      labels = parseLabels(head.slice(ob + 1, head.length - 1));
    }
    if (!name) continue;
    let arr = out.get(name);
    if (!arr) { arr = []; out.set(name, arr); }
    arr.push({ labels: labels || {}, value: value });
  }
  return out;
}

/** 解析 {k="v",k2="v2"} 里的标签串（值里可能有转义引号） */
function parseLabels(s) {
  const r = {};
  const re = /([a-zA-Z_][\w]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    r[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\n/g, '\n');
  }
  return r;
}

/** 取一条指标的值；labels 传了就按标签精确匹配 */
function pick(map, name, labels) {
  const arr = map.get(name);
  if (!arr || !arr.length) return null;
  if (!labels) return arr[0].value;
  for (let i = 0; i < arr.length; i++) {
    const l = arr[i].labels;
    let ok = true;
    for (const k in labels) {
      if (l[k] !== labels[k]) { ok = false; break; }
    }
    if (ok) return arr[i].value;
  }
  return null;
}

/** 按顺序尝试多个指标名，返回第一个拿到的值（新旧版本兼容就靠它） */
function pickAny(map, names, labels) {
  for (let i = 0; i < names.length; i++) {
    const v = pick(map, names[i], labels);
    if (v !== null) return v;
  }
  return null;
}

/** 取第一条指标的标签集合（用于 os_info / cs_hostname 这类「值无意义、标签才有用」的指标） */
function firstLabels(map, name) {
  const arr = map.get(name);
  return (arr && arr.length) ? arr[0].labels : null;
}

/** 第一个真实存在的指标名（新旧版本兼容用） */
function firstHit(map, names) {
  for (let i = 0; i < names.length; i++) if (map.has(names[i])) return names[i];
  return null;
}

/**
 * 解析 # HELP 行。textfile 的中文显示名与单位从这里带过来：
 *   # HELP his_settlement_latency_ms 医保结算平均耗时|ms
 * 竖线前是显示名，竖线后是单位；不写竖线时按指标名后缀推断单位。
 */
function parseHelps(text) {
  const out = {};
  const lines = String(text || '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.indexOf('# HELP ') !== 0) continue;
    const rest = line.slice(7).trim();
    const sp = rest.indexOf(' ');
    if (sp <= 0) continue;
    out[rest.slice(0, sp)] = rest.slice(sp + 1).trim();
  }
  return out;
}

function unitFromName(n) {
  if (/_ms$|_milliseconds$/.test(n)) return 'ms';
  if (/_seconds$|_secs$|_sec$/.test(n)) return 's';
  if (/_bytes$/.test(n)) return 'B';
  if (/_percent$|_pct$|_ratio$/.test(n)) return '%';
  if (/_minutes$|_min$/.test(n)) return 'min';
  if (/_hours$|_hour$/.test(n)) return 'h';
  return '';
}

function r3(v) { return Math.round(Number(v) * 1000) / 1000; }

/**
 * textfile 自定义指标：只认白名单前缀，其余指标一律不当业务指标。
 * key = 指标名 + 稳定的标签串，P2 存历史趋势时用它做序列唯一键。
 * 同名不同标签（如 item=门诊 / item=住院）会展开成多行，各自独立。
 */
function textfileMetrics(map, helps, prefix) {
  const pfx = String(prefix || TEXTFILE_PREFIX);
  const items = [];
  const ignored = [];
  let truncated = 0;
  for (const entry of map) {
    const name = entry[0];
    const arr = entry[1] || [];
    if (name.indexOf(pfx) !== 0) {
      // 只提示「看起来像自定义但前缀不对」的指标，别把 windows_* 全列进告警
      if (!/^(windows_|go_|process_|promhttp_)/.test(name)) ignored.push(name);
      continue;
    }
    for (let i = 0; i < arr.length; i++) {
      const labels = Object.assign({}, arr[i].labels || {});
      const raw = String(helps[name] || '');
      const pipe = raw.lastIndexOf('|');
      const help = (pipe > 0 ? raw.slice(0, pipe) : raw).trim();
      const unit = (pipe > 0 ? raw.slice(pipe + 1).trim() : '') || labels.unit || unitFromName(name);
      const display = help || labels.name || name.slice(pfx.length);
      // name / unit 只是显示元数据，不参与序列唯一键
      delete labels.name;
      delete labels.unit;
      const lk = Object.keys(labels).sort();
      const key = name + (lk.length ? '{' + lk.map((k) => k + '=' + labels[k]).join(',') + '}' : '');
      if (items.length >= MAX_TEXTFILE_METRICS) { truncated++; continue; }
      items.push({
        key: key, metric: name, name: display, value: r3(arr[i].value), unit: unit,
        labels: labels, help: help, source: 'textfile'
      });
    }
  }
  items.sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return { items: items, ignored: ignored, truncated: truncated };
}

/* ---------------- 换算 ---------------- */

/**
 * CPU 使用率：两次采样做差分。
 * 某个 mode 的计数器变小说明目标机重启过，整组差分作废（返回 null 而不是算个假值）。
 */
function cpuBusyPercent(a, b) {
  // 0.32 起叫 windows_cpu_time_seconds_total（秒），0.31 及更早是 windows_cpu_time_total。
  // 早期实现只认旧名，装 0.32 的机器 CPU 恒为 null，大屏卡片整行消失。
  const name = firstHit(b, ['windows_cpu_time_seconds_total', 'windows_cpu_time_total']);
  if (!name || !a.has(name)) return null;
  const arrA = a.get(name);
  const arrB = b.get(name);
  if (!arrA || !arrB) return null;

  // 0.32 每个 core 每个 mode 各一条，必须按 mode 求和；旧版只有全局一条，求和也成立。
  const sumByMode = (arr) => {
    const out = {};
    for (const m of arr) {
      const mode = String(m.labels.mode || '');
      const v = Number(m.value);
      if (!isFinite(v)) continue;
      out[mode] = (out[mode] || 0) + v;
    }
    return out;
  };
  const prev = sumByMode(arrA);
  const now = sumByMode(arrB);

  let total = 0;
  let idle = 0;
  let usable = 0;
  for (const mode of Object.keys(now)) {
    if (!(mode in prev)) continue;
    const d = now[mode] - prev[mode];
    if (!isFinite(d) || d < 0) return null;
    total += d;
    if (mode === 'idle') idle = d;
    usable++;
  }
  if (!usable || total <= 0) return null;
  const pct = (total - idle) * 100 / total;
  return round1(Math.min(100, Math.max(0, pct)));
}

/** 网络速率：按网卡标签做差分，换算成 KB/s，只保留有流量的前几个 */
function netRates(a, b, gapMs) {
  const secs = Math.max(0.2, gapMs / 1000);
  const bRx = b.get('windows_net_bytes_received_total') || [];
  if (!bRx.length) return [];

  const index = (map, name) => {
    const r = {};
    for (const m of (map.get(name) || [])) {
      const k = m.labels.nic || '';
      if (k) r[k] = m.value;
    }
    return r;
  };
  const aRx = index(a, 'windows_net_bytes_received_total');
  const aTx = index(a, 'windows_net_bytes_sent_total');
  const bTx = index(b, 'windows_net_bytes_sent_total');
  const aDrop = index(a, 'windows_net_packets_received_discarded_total');
  const bDrop = index(b, 'windows_net_packets_received_discarded_total');
  const aTxDrop = index(a, 'windows_net_packets_outbound_discarded_total');
  const bTxDrop = index(b, 'windows_net_packets_outbound_discarded_total');
  const aRxErr = index(a, 'windows_net_packets_received_errors_total');
  const bRxErr = index(b, 'windows_net_packets_received_errors_total');
  const aTxErr = index(a, 'windows_net_packets_outbound_errors_total');
  const bTxErr = index(b, 'windows_net_packets_outbound_errors_total');
  // 0.32 改名且换了单位：windows_net_current_bandwidth 是 bit/s，
  // windows_net_current_bandwidth_bytes 是 byte/s，利用率换算差 8 倍，必须分开认。
  const bwName = firstHit(b, ['windows_net_current_bandwidth_bytes', 'windows_net_current_bandwidth']);
  const bwBytes = bwName === 'windows_net_current_bandwidth_bytes';
  const bw = bwName ? index(b, bwName) : {};

  // counter 差分：计数器回退（重启 / 网卡重建）时该项记 0，不编造数值
  const diff = (x, y, nic) => (x[nic] !== undefined && y[nic] !== undefined && y[nic] - x[nic] >= 0)
    ? Math.round(y[nic] - x[nic]) : 0;

  const out = [];
  for (const m of bRx) {
    const nic = m.labels.nic || '';
    // 虚拟/隧道接口的流量要么为 0 要么与物理网卡重复，全列出来只会把报告撑长
    if (!nic || /loopback|isatap|teredo|pseudo|tunnel/i.test(nic)) continue;
    const p = aRx[nic];
    if (p === undefined) continue;
    const drx = m.value - p;
    if (!isFinite(drx) || drx < 0) continue; // 重启或网卡重建
    const dtx = (bTx[nic] !== undefined && aTx[nic] !== undefined) ? Math.max(0, bTx[nic] - aTx[nic]) : 0;
    if (drx === 0 && dtx === 0) continue;

    /* errs / drops 保持原有口径（只统计接收方向丢弃包），否则一旦把错包算进来，
       evaluateResult 里 errs > 0 的告警行为会在升级后突然变化。错包明细另放下面
       的 rx_errors / tx_errors 字段，P1 只展示不判定，P3 阈值层再决定要不要用。 */
    const drop = diff(aDrop, bDrop, nic);
    const rxKbps = Math.round(drx / 1024 / secs);
    const txKbps = Math.round(dtx / 1024 / secs);
    const bandwidth = bw[nic] || null;
    out.push({
      iface: nic,
      rx_kbps: rxKbps,
      tx_kbps: txKbps,
      errs: drop,
      drops: drop,
      rx_errors: diff(aRxErr, bRxErr, nic),
      tx_errors: diff(aTxErr, bTxErr, nic),
      rx_drops: drop,
      tx_drops: diff(aTxDrop, bTxDrop, nic),
      bandwidth_bps: bandwidth,
      // 标称带宽按双向合计算利用率；没有该指标时为 null（不写 0）
      util_pct: bandwidth
        ? round1((rxKbps + txKbps) * 1024 * (bwBytes ? 1 : 8) * 100 / bandwidth) : null
    });
  }
  out.sort((x, y) => (y.rx_kbps + y.tx_kbps) - (x.rx_kbps + x.tx_kbps));
  return out.slice(0, MAX_NET_IFACES);
}

/** counter 差分算每秒速率；两次采样序列数不一致或计数器回退时返回 null */
function counterRate(a, b, spec, gapMs) {
  if (!gapMs || gapMs <= 0) return null;
  const na = firstHit(a, spec.names);
  const nb = firstHit(b, spec.names);
  if (!na || na !== nb) return null;
  const aa = a.get(na) || [];
  const bb = b.get(nb) || [];
  if (!aa.length || aa.length !== bb.length) return null;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < aa.length; i++) { sa += aa[i].value; sb += bb[i].value; }
  const d = sb - sa;
  if (!isFinite(d) || d < 0) return null;
  return Math.round(d * 1000 / gapMs * 100) / 100;
}

/**
 * 逻辑磁盘 IO：counter 两次差分，出 IOPS / 平均延迟 / 吞吐。
 * 拿不到任何 counter 时返回 {} —— logical_disk 收集器只开容量指标是常见配置。
 */
function diskRates(a, b, gapMs) {
  const secs = Math.max(0.2, gapMs / 1000);
  const specs = {
    reads: ['windows_logical_disk_reads_total', 'windows_logical_disk_reads_total'],
    writes: ['windows_logical_disk_writes_total'],
    readSec: ['windows_logical_disk_read_seconds_total', 'windows_logical_disk_read_latency_seconds_total'],
    writeSec: ['windows_logical_disk_write_seconds_total', 'windows_logical_disk_write_latency_seconds_total'],
    readBytes: ['windows_logical_disk_read_bytes_total'],
    writeBytes: ['windows_logical_disk_write_bytes_total']
  };
  const idx = (map, names) => {
    const name = firstHit(map, names);
    const r = {};
    if (!name) return r;
    for (const m of (map.get(name) || [])) {
      const k = m.labels.volume || '';
      if (k) r[k] = m.value;
    }
    return r;
  };
  const A = {}; const B = {};
  for (const k in specs) { A[k] = idx(a, specs[k]); B[k] = idx(b, specs[k]); }
  if (!Object.keys(B.reads).length && !Object.keys(B.writes).length &&
      !Object.keys(B.readBytes).length && !Object.keys(B.writeBytes).length) return {};

  const out = {};
  const vols = new Set(Object.keys(B.reads).concat(Object.keys(B.writes),
    Object.keys(B.readBytes), Object.keys(B.writeBytes)));
  const d = (kk, vol) => {
    const x = A[kk][vol]; const y = B[kk][vol];
    return (x === undefined || y === undefined || !isFinite(y - x) || y - x < 0) ? 0 : (y - x);
  };
  for (const vol of vols) {
    if (!vol || vol === '_Total' || /^harddiskvolume/i.test(vol)) continue;
    const dr = d('reads', vol); const dw = d('writes', vol);
    const drs = d('readSec', vol); const dws = d('writeSec', vol);
    out[vol] = {
      read_iops: Math.round(dr / secs * 100) / 100,
      write_iops: Math.round(dw / secs * 100) / 100,
      // 平均延迟 = 累计秒数 / 累计次数；没有秒数指标时为 null，不写 0
      read_latency_ms: drs && dr ? Math.round(drs * 1000 / dr * 100) / 100 : null,
      write_latency_ms: dws && dw ? Math.round(dws * 1000 / dw * 100) / 100 : null,
      read_kbps: Math.round(d('readBytes', vol) / 1024 / secs * 100) / 100,
      write_kbps: Math.round(d('writeBytes', vol) / 1024 / secs * 100) / 100
    };
  }
  return out;
}

/**
 * 汇总「扩展指标」到顶层 extra。刻意不塞进 metrics：
 *   - evaluateResult / compare / 报表都按固定字段读 metrics，多字段容易被当成新判定项；
 *   - P2 的 metrics_json 存整包时会把 extra 一起带上，趋势可按 key 取序列。
 */
function buildExtra(m1, m2, gapMs, hasSecond, textItems, base, io) {
  const scalars = { system: {}, memory: {}, net: {} };
  for (const spec of METRIC_CATALOG) {
    if (spec.byLabel) continue;  // 按标签分组的指标（带宽）在下面单独处理
    const v = pickAny(m2, spec.names);
    scalars[spec.group][spec.key] = (v === null) ? null : Math.round(v * 100) / 100;
  }
  const rates = { system: {}, memory: {} };
  for (const spec of COUNTER_CATALOG) {
    rates[spec.group][spec.key.replace(/_total$/, '') + '_per_sec'] =
      hasSecond ? counterRate(m1, m2, spec, gapMs) : null;
  }
  const mb = (v) => (v === null || v === undefined) ? null : Math.round(v / 1048576);
  const committed = scalars.memory.memory_committed_bytes;
  const limit = scalars.memory.memory_commit_limit_bytes;
  const bandwidth = {};
  const bwName = firstHit(m2, ['windows_net_current_bandwidth_bytes', 'windows_net_current_bandwidth']);
  // 字段名 bandwidth_bps 是 bit/s；0.32 给的是 byte/s，统一换算，别让下游算错 8 倍
  const bwScale = bwName === 'windows_net_current_bandwidth_bytes' ? 8 : 1;
  for (const m of (bwName ? (m2.get(bwName) || []) : [])) {
    const k = m.labels.nic || '';
    if (k) bandwidth[k] = m.value * bwScale;
  }

  const disks = (base.disks || []).map((d) => Object.assign({}, d, io[d.mount] || {}));
  const net = (base.net || []).map((n) => Object.assign({}, n, { bandwidth_bps: bandwidth[n.iface] || null }));

  return {
    system: Object.assign({
      cores: base.cores,
      uptime_sec: base.uptime_sec,
      processes: base.procs
    }, scalars.system, rates.system),
    memory: {
      total_mb: base.mem_total_mb,
      used_mb: base.mem_used_mb,
      used_percent: base.mem_percent,
      available_mb: mb(pickAny(m2, ['windows_memory_available_bytes', 'windows_os_free_physical_memory_bytes'])),
      cache_mb: mb(scalars.memory.memory_cache_bytes),
      committed_mb: mb(committed),
      commit_limit_mb: mb(limit),
      commit_percent: (committed && limit) ? round1(committed * 100 / limit) : null,
      page_faults_per_sec: rates.memory.page_faults_per_sec
    },
    disks: disks,
    net: net,
    textfile: textItems,
    sampled_twice: !!hasSecond,
    gap_ms: hasSecond ? Math.round(gapMs) : null
  };
}

/** 逻辑磁盘：volume 标签配 size/free 两个指标 */
function disksOf(map) {
  const freeArr = map.get('windows_logical_disk_free_bytes') || [];
  if (!freeArr.length) return [];

  const size = {};
  for (const m of (map.get('windows_logical_disk_size_bytes') || [])) {
    const k = m.labels.volume || '';
    if (k) size[k] = m.value;
  }

  const out = [];
  for (const m of freeArr) {
    const vol = m.labels.volume || '';
    if (!vol || vol === '_Total' || /^harddiskvolume/i.test(vol)) continue;
    const sz = size[vol];
    const fr = m.value;
    if (!sz || sz <= 0 || !isFinite(fr)) continue;
    out.push({
      mount: vol,
      fs: '',
      size_mb: Math.round(sz / 1048576),
      used_mb: Math.round((sz - fr) / 1048576),
      avail_mb: Math.round(fr / 1048576),
      use_percent: Math.round((sz - fr) * 100 / sz)
    });
  }
  out.sort((x, y) => String(x.mount).localeCompare(String(y.mount)));
  return out;
}

/**
 * 服务当前状态：windows_service_state 只有当前状态那条的值为 1。
 * 0.32 起服务名标签叫 service，0.31 及更早叫 name —— 两个都认，否则 0.32 上
 * states 恒为空，配了服务检查的机器会被整批误判成「服务没在跑」。
 */
function serviceStates(map) {
  const out = {};
  const arr = map.get('windows_service_state') || [];
  for (const m of arr) {
    if (Number(m.value) !== 1) continue;
    const n = String(m.labels.service || m.labels.name || '').toLowerCase();
    if (n) out[n] = String(m.labels.state || '').toLowerCase();
  }
  return out;
}

/* ---------------- 采集入口 ---------------- */

/**
 * 采集一台设备。签名与 collectWindows 一致：collectExporter(server, timeoutMs)
 * 返回 { ok:true, metrics, services, customs, note? } 或 { ok:false, error }
 */
async function collectExporter(server, timeoutMs) {
  const auth = server.auth || {};
  const host = String(server.host || '').trim();
  if (!host) return { ok: false, error: '缺少主机地址' };

  const proto = String(server.protocol || '').toLowerCase() === 'https' ? 'https' : 'http';
  const port = Number(server.port) || DEFAULT_PORT;
  const url = proto + '://' + host + ':' + port + '/metrics';

  const headers = {};
  // exporter 本身不需要账号；只有在 web.config 里开了 Basic 认证时才用得上，
  // 所以这两个字段在这条通道上是「可选」的（前端 label 也据此去掉必填星号）。
  if (auth.username) {
    headers.Authorization = 'Basic ' +
      Buffer.from(String(auth.username) + ':' + String(auth.password || '')).toString('base64');
  }

  // 两次采样 + 1 秒间隔，单次 HTTP 不必占满整个巡检超时
  const perTimeout = Math.max(3000, Math.min(Number(timeoutMs) || 15000, 15000));

  const first = await fetchMetrics(url, headers, perTimeout);
  if (!first.ok) {
    return {
      ok: false,
      error: '拉取 ' + url + ' 失败：' + first.error +
        '（确认目标机已安装 windows_exporter 且防火墙放行 ' + port + ' 端口）'
    };
  }
  const m1 = parseMetrics(first.body);
  if (!m1.size) {
    return { ok: false, error: '拉取 ' + url + ' 成功但内容不是 Prometheus 指标（是不是 9182 被别的服务占了？）' };
  }

  // 第二次采样：算 CPU / 网络速率必须有它。失败时降级为「只出静态指标」，
  // 比整台判失败更有价值 —— 磁盘和内存还在，运维照样能看出问题。
  const t1 = Date.now();
  await sleep(SAMPLE_GAP_MS);
  const second = await fetchMetrics(url, headers, perTimeout);
  const t2 = Date.now();
  const m2 = second.ok ? parseMetrics(second.body) : m1;
  const helps = parseHelps(second.ok ? second.body : first.body);
  const gapMs = Math.max(1, t2 - t1);

  const notes = [];

  const osInfo = firstLabels(m2, 'windows_os_info') || {};
  const csInfo = firstLabels(m2, 'windows_cs_hostname') || {};
  const osHost = firstLabels(m2, 'windows_os_hostname') || {};

  const hostname = csInfo.hostname || osHost.hostname || String(server.host || '');
  const osName = osInfo.product || osInfo.caption || '';
  const kernel = osInfo.version || '';

  // 开机时刻改名过两次：0.32 是 boot_time_timestamp，0.30/0.31 带 _seconds，
  // 0.29 及更早是 system_up_time。三个都认，否则 uptime 恒为 null。
  const bootTs = pickAny(m2, [
    'windows_system_boot_time_timestamp',
    'windows_system_boot_time_timestamp_seconds',
    'windows_system_system_up_time'
  ]);
  const uptimeSec = (bootTs && isFinite(bootTs))
    ? Math.max(0, Math.round(Date.now() / 1000 - bootTs)) : null;

  // 0.32 没有 cs 收集器了，核数由 cpu 收集器的 windows_cpu_logical_processor 给出
  const cores = pickAny(m2, [
    'windows_cpu_logical_processor', 'windows_cpu_cores', 'windows_cs_logical_processors'
  ]);

  // 0.32 的 memory 收集器给 available / physical_total；cs / os 那批是旧名兜底
  const memTotalBytes = pickAny(m2, [
    'windows_memory_physical_total_bytes',
    'windows_cs_physical_memory_bytes',
    'windows_memory_commit_limit_bytes',
    'windows_memory_commit_limit'
  ]);
  const memAvailBytes = pickAny(m2, [
    'windows_memory_available_bytes',
    'windows_memory_physical_free_bytes',
    'windows_os_free_physical_memory_bytes'
  ]);
  const memTotalMb = (memTotalBytes && memTotalBytes > 0) ? Math.round(memTotalBytes / 1048576) : null;
  const memUsedMb = (memTotalMb && memAvailBytes !== null)
    ? Math.max(0, Math.round((memTotalBytes - memAvailBytes) / 1048576)) : null;
  const memPct = (memTotalMb && memUsedMb !== null)
    ? round1(memUsedMb * 100 / memTotalMb) : null;

  // 旧版指标名命中说明装的是 0.29 或更早 —— 不报错，但提示一句
  if (pick(m2, 'windows_system_system_up_time') !== null &&
      pick(m2, 'windows_system_boot_time_timestamp_seconds') === null &&
      pick(m2, 'windows_system_boot_time_timestamp') === null) {
    notes.push('检测到旧版 windows_exporter 指标名（0.29 及更早），建议升级到 0.32（指标名已改过两轮）');
  }

  /* 服务检查：只支持按「服务名」检查，进程/端口两类本通道做不到 ——
     跳过而不是判失败。另外 service 收集器没开时整个指标都不存在，
     此时「查不到」绝不能等于「没在跑」，必须整体跳过。 */
  const wanted = Array.isArray(server.services) ? server.services : [];
  const svcArr = m2.get('windows_service_state') || [];
  const hasSvcCollector = svcArr.length > 0;
  const states = hasSvcCollector ? serviceStates(m2) : {};
  const services = [];
  let skippedSvc = 0;
  let skippedType = 0;

  for (const s of wanted) {
    const nm = String((s && s.name) || '').trim();
    if (!nm) continue;
    const type = String((s && s.type) || 'auto').toLowerCase();
    // auto 是前端「+ 添加」的默认值（界面上没有类型选择器），
    // 用户填的就是服务名，所以这里一并按服务处理，避免配了却不检查。
    if (type !== 'service' && type !== 'auto') { skippedType++; continue; }
    if (!hasSvcCollector) { skippedSvc++; continue; }
    const st = states[nm.toLowerCase()];
    services.push({
      name: nm,
      type: 'service',
      running: st === 'running',
      detail: st ? ('exporter: ' + st) : '未在 exporter 中查到该服务'
    });
  }
  if (skippedSvc > 0) {
    notes.push(skippedSvc + ' 个服务检查项已跳过：该端点未启用 service 收集器（安装时 ENABLED_COLLECTORS 要包含 service）');
  }
  if (skippedType > 0) {
    notes.push(skippedType + ' 个「进程 / 端口」检查项已跳过：本通道只支持按服务名检查');
  }

  /* 自定义指标：只走 textfile，绝不恢复远程命令。
     server 里的字段叫 custom_commands（device-repo.toServer 就是这么拼的），
     之前这里读的 server.customs 根本不存在，导致「命令被跳过」的提示从未出现过。 */
  const customsIn = Array.isArray(server.custom_commands) ? server.custom_commands
    : (Array.isArray(server.customs) ? server.customs : []);
  if (customsIn.length > 0) {
    notes.push(customsIn.length + ' 条自定义命令未执行：本通道不支持远程执行命令，'
      + '自定义指标请改用 textfile 采集器（' + TEXTFILE_PREFIX + ' 前缀）');
  }

  const prefix = String(server.textfilePrefix || server.textfile_prefix || TEXTFILE_PREFIX);
  const tf = textfileMetrics(m2, helps, prefix);
  if (tf.items.length) {
    notes.push('采集到 textfile 自定义指标 ' + tf.items.length + ' 条（白名单前缀 ' + prefix + '）');
  }
  if (tf.ignored.length) {
    notes.push('忽略 ' + tf.ignored.length + ' 条非白名单指标：' + tf.ignored.slice(0, 5).join('、')
      + '（自定义指标须以 ' + prefix + ' 开头）');
  }
  if (tf.truncated) {
    notes.push('textfile 指标超过 ' + MAX_TEXTFILE_METRICS + ' 条，已截断 ' + tf.truncated + ' 条');
  }
  // 映射成报表原本就认识的 customs 形状，report.js 只需认一下 source 就能换标题
  const customs = tf.items.map((t) => ({
    name: t.name,
    output: String(t.value) + (t.unit ? ' ' + t.unit : ''),
    code: 0,
    source: 'textfile',
    key: t.key,
    value: t.value,
    unit: t.unit,
    labels: t.labels
  }));

  if (!second.ok) {
    notes.push('第二次采样失败，本次未计算 CPU / 网络 / 磁盘速率（' + second.error + '）');
  }

  const metrics = {
    hostname: hostname,
    os: osName,
    kernel: kernel,
    uptime_sec: uptimeSec,
    cores: cores === null ? null : Math.round(cores),
    load1: null, load5: null, load15: null,
    cpu_percent: second.ok ? cpuBusyPercent(m1, m2) : null,
    mem_total_mb: memTotalMb,
    mem_used_mb: memUsedMb,
    mem_percent: memPct,
    swap_total_mb: null,
    swap_used_mb: null,
    procs: (function () {
      const p = pickAny(m2, ['windows_system_processes', 'windows_os_processes']);
      return p === null ? null : Math.round(p);
    })(),
    zombies: null,
    disks: disksOf(m2),
    net: second.ok ? netRates(m1, m2, gapMs) : [],
    diskio: [],
    // exporter 不出事件日志计数；null 在评估里被当作「不判定」，不会误报
    log_errors: null,
    log_warns: null
  };

  // 磁盘 IO 差分直接喂给报表已有的「磁盘 IO（KB/s）」表格，前端一行都不用改
  const io = second.ok ? diskRates(m1, m2, gapMs) : {};
  metrics.diskio = Object.keys(io)
    .map((vol) => ({ dev: vol, r_kbps: io[vol].read_kbps, w_kbps: io[vol].write_kbps }))
    .filter((x) => x.r_kbps || x.w_kbps);

  return {
    ok: true,
    metrics: metrics,
    extra: buildExtra(m1, m2, gapMs, second.ok, tf.items, metrics, io),
    services: services,
    customs: customs,
    note: notes.join('；'),
    channel: 'exporter'
  };
}

module.exports = {
  collectExporter, parseMetrics, parseLabels, parseHelps, textfileMetrics,
  diskRates, counterRate, buildExtra,
  METRIC_CATALOG, COUNTER_CATALOG, TEXTFILE_PREFIX, MAX_TEXTFILE_METRICS, DEFAULT_PORT
};
