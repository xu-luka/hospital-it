'use strict';
/**
 * Linux 服务器采集模块：通过 SSH 执行一段只读巡检脚本，解析输出为统一结构
 */

const { sshConnect, sshExec, friendlySshError } = require('./sshutil');
const { shq, normArray, truncate } = require('./common');

/** 把进程名首字符变成 [x] 形式，避免 pgrep/grep 匹配到巡检脚本自身 */
function bracketed(name) {
  const s = String(name);
  if (!s) return s;
  const first = s.charAt(0);
  if (/[A-Za-z0-9]/.test(first)) return '[' + first + ']' + s.slice(1);
  return s;
}

/** 生成远端执行的巡检脚本（纯只读命令） */
function buildScript(server) {
  const L = [];
  L.push(`export LC_ALL=C`);
  L.push(`echo '<<<METRICS>>>'`);
  L.push(`echo "HOSTNAME=$(hostname 2>/dev/null || uname -n)"`);
  L.push(`OS_NAME=$(grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d'=' -f2- | tr -d '"' | head -n1)`);
  L.push(`[ -n "$OS_NAME" ] || OS_NAME=$(uname -s)`);
  L.push(`echo "OS=$OS_NAME"`);
  L.push(`echo "KERNEL=$(uname -r 2>/dev/null)"`);
  L.push(`echo "UPTIME_SEC=$(awk '{print int($1)}' /proc/uptime 2>/dev/null)"`);
  L.push(`CORES=$(grep -c '^processor' /proc/cpuinfo 2>/dev/null)`);
  L.push(`if [ -z "$CORES" ] || [ "$CORES" = "0" ]; then CORES=$(nproc 2>/dev/null || echo 1); fi`);
  L.push(`echo "CORES=$CORES"`);
  L.push(`echo "LOADAVG=$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"`);
  // CPU 使用率：采样 /proc/stat 两次，间隔 1 秒
  L.push(`S1=$(grep '^cpu ' /proc/stat 2>/dev/null); sleep 1; S2=$(grep '^cpu ' /proc/stat 2>/dev/null)`);
  L.push(`CPU_PCT=$(printf '%s\\n%s\\n' "$S1" "$S2" | awk 'NR==1{for(i=2;i<=NF;i++)t1+=$i; i1=$5+$6} NR==2{for(i=2;i<=NF;i++)t2+=$i; i2=$5+$6; dt=t2-t1; di=i2-i1; if(dt>0) printf "%.1f",(dt-di)*100/dt; else printf "0.0"}')`);
  L.push(`echo "CPU_PCT=$CPU_PCT"`);
  // 内存：优先用 MemAvailable，老内核退回 MemFree+Buffers+Cached
  L.push(`awk '/^MemTotal:/{t=$2}/^MemAvailable:/{a=$2}/^MemFree:/{f=$2}/^Buffers:/{b=$2}/^Cached:/{c=$2}/^SwapTotal:/{st=$2}/^SwapFree:/{sf=$2} END{if(a==""||a==0)a=f+b+c; if(t>0){u=t-a; printf "MEM_TOTAL_MB=%d MEM_USED_MB=%d MEM_PCT=%.1f\\n",t/1024,u/1024,u*100/t} else printf "MEM_TOTAL_MB=0 MEM_USED_MB=0 MEM_PCT=0\\n"; if(st>0) printf "SWAP_TOTAL_MB=%d SWAP_USED_MB=%d\\n",st/1024,(st-sf)/1024; else printf "SWAP_TOTAL_MB=0 SWAP_USED_MB=0\\n"}' /proc/meminfo 2>/dev/null`);
  L.push(`echo "PROCS=$(ls /proc 2>/dev/null | grep -c '^[0-9]')"`);
  L.push(`echo "ZOMBIES=$(cat /proc/[0-9]*/status 2>/dev/null | grep -c '^State:.Z (zombie)')"`);
  // 磁盘：排除虚拟文件系统
  L.push(`df -P -m 2>/dev/null | awk 'NR>1 && $1!~/^(tmpfs|devtmpfs|udev|none|squashfs|shm|efivarfs|proc|sysfs|cgroup)$/ && $6!~/^\\/(proc|sys|dev|run)(\\/|$)/ {m=$6; for(i=7;i<=NF;i++) m=m" "$i; s=$2; u=$3; a=$4; p=$5; gsub(/M/,"",s); gsub(/M/,"",u); gsub(/M/,"",a); gsub(/%/,"",p); print "DISK="m"|"$1"|"s"|"u"|"a"|"p}'`);

  // 网络与磁盘 IO：先采 T0，sleep 1 后采 T1，在 JS 端算速率（KB/s）
  L.push(`echo '<<<NET0>>>'`);
  L.push(`cat /proc/net/dev 2>/dev/null`);
  L.push(`echo '<<<IO0>>>'`);
  L.push(`cat /proc/diskstats 2>/dev/null`);
  L.push(`sleep 1`);
  L.push(`echo '<<<NET1>>>'`);
  L.push(`cat /proc/net/dev 2>/dev/null`);
  L.push(`echo '<<<IO1>>>'`);
  L.push(`cat /proc/diskstats 2>/dev/null`);
  // 系统日志错误（近 24 小时）
  L.push(`echo '<<<LOGS>>>'`);
  L.push(`LOG_ERR=$( if command -v journalctl >/dev/null 2>&1; then journalctl -p err -S '24 hours ago' --no-pager 2>/dev/null | grep -vc '^--'; else awk 'BEGIN{s=0} /(error|crit|alert|emerg|fail|failed)/{s++} END{print s+0}' /var/log/messages /var/log/syslog /var/log/kern.log 2>/dev/null; fi ); echo "LOG_ERROR=$LOG_ERR"`);
  L.push(`LOG_W=$( if command -v journalctl >/dev/null 2>&1; then journalctl -p warning -S '24 hours ago' --no-pager 2>/dev/null | grep -vc '^--'; else awk 'BEGIN{s=0} /(warn|warning)/{s++} END{print s+0}' /var/log/messages /var/log/syslog 2>/dev/null; fi ); echo "LOG_WARN=$LOG_W"`);
  L.push(`echo '<<<LOGSEND>>>'`);

  L.push(`echo '<<<SERVICES>>>'`);
  const services = normArray(server.services);
  services.forEach((svc, i) => {
    const name = String(svc.name === undefined ? '' : svc.name);
    const t = svc.type;
    if (t === 'process') {
      const pat = shq(bracketed(name));
      L.push(`if command -v pgrep >/dev/null 2>&1; then CNT=$(pgrep -fc ${pat} 2>/dev/null); [ -n "$CNT" ] || CNT=0; else CNT=$(ps -ef 2>/dev/null | grep -v grep | grep -c ${pat}); fi`);
      L.push(`echo "PROCESS|${i}|$CNT"`);
    } else if (t === 'port') {
      const port = name.replace(/[^0-9]/g, '');
      L.push(`if command -v ss >/dev/null 2>&1; then LADDR=$(ss -ltn 2>/dev/null | awk 'NR>1{print $4}'); else LADDR=$(netstat -ltn 2>/dev/null | awk 'NR>2{print $4}'); fi`);
      L.push(`if printf '%s\\n' "$LADDR" | grep -Eq '[:.]${port}$'; then echo "PORT|${i}|1"; else echo "PORT|${i}|0"; fi`);
    } else if (t === 'systemd') {
      L.push(`if command -v systemctl >/dev/null 2>&1; then ST=$(systemctl is-active ${shq(name)} 2>/dev/null); [ -n "$ST" ] || ST=unknown; else ST=nosystemctl; fi`);
      L.push(`echo "SYSTEMD|${i}|$ST"`);
    } else {
      L.push(`echo "UNKNOWN|${i}|不支持的检查类型"`);
    }
  });

  L.push(`echo '<<<CUSTOM>>>'`);
  const customs = normArray(server.custom_commands);
  customs.forEach((c, i) => {
    L.push(`echo '<<<CMD|${i}>>>'`);
    L.push(`OUT=$( { ${c.command} ; } 2>&1 ); CODE=$?`);
    L.push(`printf '%s\\n' "$OUT" | head -c 4000`);
    L.push(`echo "<<<EXIT|$CODE>>>"`);
  });
  L.push(`echo '<<<END>>>'`);
  return L.join('\n');
}

function num(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** 解析远端脚本输出 */
function parseOutput(text) {
  const metricsRaw = {};
  const disks = [];
  const svcRaw = [];
  const customs = [];
  const net0 = [];
  const net1 = [];
  const io0 = [];
  const io1 = [];
  const logRaw = {};
  let section = '';
  let cur = null;
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (line === '<<<METRICS>>>') { section = 'metrics'; continue; }
    if (line === '<<<SERVICES>>>') { section = 'services'; continue; }
    if (line === '<<<CUSTOM>>>') { section = 'custom'; continue; }
    if (line === '<<<END>>>') { section = ''; continue; }
    if (line === '<<<NET0>>>') { section = 'net0'; continue; }
    if (line === '<<<NET1>>>') { section = 'net1'; continue; }
    if (line === '<<<IO0>>>') { section = 'io0'; continue; }
    if (line === '<<<IO1>>>') { section = 'io1'; continue; }
    if (line === '<<<LOGS>>>') { section = 'logs'; continue; }
    if (line === '<<<LOGSEND>>>') { section = ''; continue; }
    if (line.startsWith('<<<CMD|')) {
      cur = { idx: parseInt(line.slice(7), 10), output: [] };
      customs.push(cur);
      continue;
    }
    if (line.startsWith('<<<EXIT|')) {
      if (cur) cur.code = parseInt(line.slice(8), 10) || 0;
      continue;
    }
    if (section === 'metrics') {
      if (line.startsWith('DISK=')) {
        const f = line.slice(5).split('|');
        if (f.length >= 6) {
          disks.push({ mount: f[0], fs: f[1], size_mb: num(f[2]), used_mb: num(f[3]), avail_mb: num(f[4]), use_percent: num(f[5]) });
        }
      } else {
        for (const token of line.split(/\s+/)) {
          const m = token.match(/^([A-Z_]+)=(.*)$/);
          if (m) metricsRaw[m[1]] = m[2];
        }
      }
    } else if (section === 'services') {
      const p = line.split('|');
      if (p.length >= 3) svcRaw.push({ type: p[0], idx: parseInt(p[1], 10), value: p.slice(2).join('|') });
    } else if (section === 'net0') {
      net0.push(line);
    } else if (section === 'net1') {
      net1.push(line);
    } else if (section === 'io0') {
      io0.push(line);
    } else if (section === 'io1') {
      io1.push(line);
    } else if (section === 'logs') {
      for (const token of line.split(/\s+/)) {
        const m = token.match(/^([A-Z_]+)=(.*)$/);
        if (m) logRaw[m[1]] = m[2];
      }
    } else if (section === 'custom' && cur) {
      cur.output.push(line);
    }
  }
  return { metricsRaw, disks, svcRaw, customs, net0, net1, io0, io1, logRaw };
}

function parseNetSnapshot(lines) {
  const map = {};
  for (const ln of lines) {
    const ci = ln.indexOf(':');
    if (ci < 0) continue;
    const name = ln.slice(0, ci).trim();
    if (!name || name === 'Inter' || name === 'face') continue;
    const f = ln.slice(ci + 1).trim().split(/\s+/);
    if (f.length < 11) continue;
    map[name] = {
      rx_bytes: Number(f[0]) || 0,
      rx_errs: Number(f[2]) || 0,
      rx_drop: Number(f[3]) || 0,
      tx_bytes: Number(f[8]) || 0,
      tx_errs: Number(f[10]) || 0,
      tx_drop: Number(f[11]) || 0
    };
  }
  return map;
}

function parseIoSnapshot(lines) {
  const map = {};
  for (const ln of lines) {
    const f = ln.trim().split(/\s+/);
    if (f.length < 10) continue;
    const name = f[2];
    map[name] = { rd: Number(f[5]) || 0, wr: Number(f[9]) || 0 };
  }
  return map;
}

/** 把解析结果整理为统一结构 */
function buildResult(parsed, server) {
  const mr = parsed.metricsRaw;
  const load = String(mr.LOADAVG || '').split(/\s+/);
  const servicesCfg = normArray(server.services);
  const services = parsed.svcRaw.map((r) => {
    const cfg = servicesCfg[r.idx] || {};
    const name = String(cfg.name === undefined ? '' : cfg.name);
    if (r.type === 'PROCESS') {
      const cnt = parseInt(r.value, 10) || 0;
      return { name, type: 'process', running: cnt > 0, detail: cnt > 0 ? ('匹配到 ' + cnt + ' 个进程') : '未发现进程' };
    }
    if (r.type === 'PORT') {
      return { name, type: 'port', running: r.value === '1', detail: r.value === '1' ? '端口监听中' : '端口未监听' };
    }
    if (r.type === 'SYSTEMD') {
      const v = r.value;
      return { name, type: 'systemd', running: v === 'active', detail: v === 'nosystemctl' ? '无 systemctl，无法检查' : v };
    }
    return { name, type: r.type || 'unknown', running: false, detail: r.value };
  });
  const customsCfg = normArray(server.custom_commands);
  const customs = parsed.customs.map((c) => {
    const cfg = customsCfg[c.idx] || {};
    const output = c.output.join('\n').replace(/\s+$/, '');
    return { name: cfg.name || ('命令' + (c.idx + 1)), output, code: c.code === undefined ? 0 : c.code };
  });
  // 网络速率（KB/s）与错包；排除回环口
  const net0m = parseNetSnapshot(parsed.net0);
  const net1m = parseNetSnapshot(parsed.net1);
  const net = [];
  for (const iface of Object.keys(net1m)) {
    if (iface === 'lo') continue;
    const a = net0m[iface];
    const b = net1m[iface];
    if (!a) continue;
    net.push({
      iface,
      rx_kbps: Math.max(0, Math.round((b.rx_bytes - a.rx_bytes) / 1024)),
      tx_kbps: Math.max(0, Math.round((b.tx_bytes - a.tx_bytes) / 1024)),
      errs: b.rx_errs + b.tx_errs,
      drops: b.rx_drop + b.tx_drop
    });
  }
  // 磁盘 IO（KB/s）；只统计实体盘，跳过分区/虚拟设备
  const io0m = parseIoSnapshot(parsed.io0);
  const io1m = parseIoSnapshot(parsed.io1);
  const diskio = [];
  for (const dev of Object.keys(io1m)) {
    if (!/^(sd[a-z]+|hd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|md\d+)$/.test(dev)) continue;
    const a = io0m[dev];
    const b = io1m[dev];
    if (!a) continue;
    diskio.push({
      dev,
      r_kbps: Math.max(0, Math.round((b.rd - a.rd) * 512 / 1024)),
      w_kbps: Math.max(0, Math.round((b.wr - a.wr) * 512 / 1024))
    });
  }
  const log_errors = num(parsed.logRaw.LOG_ERROR);
  const log_warns = num(parsed.logRaw.LOG_WARN);
  return {
    ok: true,
    metrics: {
      hostname: mr.HOSTNAME || '',
      os: mr.OS || '',
      kernel: mr.KERNEL || '',
      uptime_sec: num(mr.UPTIME_SEC),
      cores: num(mr.CORES),
      load1: num(load[0]), load5: num(load[1]), load15: num(load[2]),
      cpu_percent: num(mr.CPU_PCT),
      mem_total_mb: num(mr.MEM_TOTAL_MB),
      mem_used_mb: num(mr.MEM_USED_MB),
      mem_percent: num(mr.MEM_PCT),
      swap_total_mb: num(mr.SWAP_TOTAL_MB),
      swap_used_mb: num(mr.SWAP_USED_MB),
      procs: num(mr.PROCS),
      zombies: num(mr.ZOMBIES),
      disks: parsed.disks,
      net: net,
      diskio: diskio,
      log_errors: log_errors,
      log_warns: log_warns
    },
    services,
    customs
  };
}

/** 采集入口：连接 -> 执行脚本 -> 解析；失败时返回 { ok:false, error } */
async function collectLinux(server, timeoutMs) {
  let conn = null;
  try {
    conn = await sshConnect(server, timeoutMs);
    const script = buildScript(server);
    const r = await sshExec(conn, script, timeoutMs);
    const parsed = parseOutput(r.stdout);
    if (Object.keys(parsed.metricsRaw).length === 0) {
      throw new Error('远端输出无法解析。' + truncate((r.stderr || r.stdout || '').trim(), 300));
    }
    return buildResult(parsed, server);
  } catch (e) {
    return { ok: false, error: friendlySshError(e) };
  } finally {
    if (conn) { try { conn.end(); } catch (e) { /* 忽略 */ } }
  }
}

module.exports = { collectLinux, buildScript, parseOutput, buildResult };
