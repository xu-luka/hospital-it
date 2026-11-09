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
 *   B. 指标名在 0.30 做过一轮 breaking change（system_up_time →
 *      boot_time_timestamp_seconds、page_file 从 os 拆出去等）。这里每处取值
 *      都写成「新名优先、旧名兜底」，免得以后有人装了 0.29 整条通道失灵。
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

/* ---------------- 换算 ---------------- */

/**
 * CPU 使用率：两次采样做差分。
 * 某个 mode 的计数器变小说明目标机重启过，整组差分作废（返回 null 而不是算个假值）。
 */
function cpuBusyPercent(a, b) {
  const arrA = a.get('windows_cpu_time_total');
  const arrB = b.get('windows_cpu_time_total');
  if (!arrA || !arrB) return null;

  const prev = {};
  for (const m of arrA) prev[m.labels.mode || ''] = m.value;

  let total = 0;
  let idle = 0;
  let usable = 0;
  for (const m of arrB) {
    const mode = m.labels.mode || '';
    if (!(mode in prev)) continue;
    const d = m.value - prev[mode];
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

    const drop = (bDrop[nic] !== undefined && aDrop[nic] !== undefined)
      ? Math.max(0, Math.round(bDrop[nic] - aDrop[nic])) : 0;
    out.push({
      iface: nic,
      rx_kbps: Math.round(drx / 1024 / secs),
      tx_kbps: Math.round(dtx / 1024 / secs),
      // 与 SSH 通道口径一致：errs 表示「错包 + 丢包」总量，报告按 errs > 0 告警
      errs: drop,
      drops: drop
    });
  }
  out.sort((x, y) => (y.rx_kbps + y.tx_kbps) - (x.rx_kbps + x.tx_kbps));
  return out.slice(0, MAX_NET_IFACES);
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

/** 服务当前状态：windows_service_state{name,state} 只有当前状态那条的值为 1 */
function serviceStates(map) {
  const out = {};
  const arr = map.get('windows_service_state') || [];
  for (const m of arr) {
    if (Number(m.value) !== 1) continue;
    const n = String(m.labels.name || '').toLowerCase();
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
  const gapMs = Math.max(1, t2 - t1);

  const notes = [];

  const osInfo = firstLabels(m2, 'windows_os_info') || {};
  const csInfo = firstLabels(m2, 'windows_cs_hostname') || {};
  const osHost = firstLabels(m2, 'windows_os_hostname') || {};

  const hostname = csInfo.hostname || osHost.hostname || String(server.host || '');
  const osName = osInfo.product || osInfo.caption || '';
  const kernel = osInfo.version || '';

  const bootTs = pickAny(m2, ['windows_system_boot_time_timestamp_seconds', 'windows_system_system_up_time']);
  const uptimeSec = (bootTs && isFinite(bootTs))
    ? Math.max(0, Math.round(Date.now() / 1000 - bootTs)) : null;

  const cores = pickAny(m2, ['windows_cpu_cores', 'windows_cs_logical_processors']);

  // 0.32 的 memory 收集器给 available；没装 memory 收集器时退回 os 收集器的空闲物理内存
  const memTotalBytes = pickAny(m2, [
    'windows_cs_physical_memory_bytes',
    'windows_memory_physical_total_bytes',
    'windows_memory_commit_limit'
  ]);
  const memAvailBytes = pickAny(m2, [
    'windows_memory_available_bytes',
    'windows_os_free_physical_memory_bytes',
    'windows_memory_physical_free_bytes'
  ]);
  const memTotalMb = (memTotalBytes && memTotalBytes > 0) ? Math.round(memTotalBytes / 1048576) : null;
  const memUsedMb = (memTotalMb && memAvailBytes !== null)
    ? Math.max(0, Math.round((memTotalBytes - memAvailBytes) / 1048576)) : null;
  const memPct = (memTotalMb && memUsedMb !== null)
    ? round1(memUsedMb * 100 / memTotalMb) : null;

  // 旧版指标名命中说明装的是 0.29 或更早 —— 不报错，但提示一句
  if (pick(m2, 'windows_system_system_up_time') !== null &&
      pick(m2, 'windows_system_boot_time_timestamp_seconds') === null) {
    notes.push('检测到旧版 windows_exporter 指标名，建议升级到 0.30 及以上（新版指标名有变化）');
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

  const customsIn = Array.isArray(server.customs) ? server.customs : [];
  if (customsIn.length > 0) {
    notes.push(customsIn.length + ' 条自定义命令未执行：本通道是只读指标端点，不支持远程执行命令');
  }
  if (!second.ok) {
    notes.push('第二次采样失败，本次未计算 CPU 与网络速率（' + second.error + '）');
  }

  return {
    ok: true,
    metrics: {
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
    },
    services: services,
    customs: [],
    note: notes.join('；'),
    channel: 'exporter'
  };
}

module.exports = { collectExporter, parseMetrics, parseLabels, DEFAULT_PORT };
