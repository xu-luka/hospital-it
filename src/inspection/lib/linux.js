'use strict';
/**
 * Linux 服务器采集模块：通过 SSH 执行一段只读巡检脚本，解析输出为统一结构
 */

const { sshConnect, sshExec, friendlySshError } = require('./sshutil');
const { shq, normArray, truncate, round1 } = require('./common');

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
  // CPU 使用率 / iowait / steal / 上下文切换：两次采样做差分
  // 口径说明：使用率沿用「忙 = 总时间 - idle - iowait」，与历史快照可比；
  // iowait 与 steal 单独输出 —— 否则「磁盘卡死但 CPU 只有 15%」这种现场没人看得出来。
  // 老内核没有 steal 字段（$9 为空），awk 里用 +0 兜底，不会算出 NaN。
  L.push(`S1=$(grep -E '^cpu |^ctxt ' /proc/stat 2>/dev/null); sleep 1; S2=$(grep -E '^cpu |^ctxt ' /proc/stat 2>/dev/null)`);
  L.push(`printf '%s\\n%s\\n' "$S1" "$S2" | awk '$1=="cpu"{n++; if(n==1){t1=0; for(i=2;i<=NF;i++)t1+=$i; i1=$5+$6; w1=$6+0; s1=$9+0} else {t2=0; for(i=2;i<=NF;i++)t2+=$i; i2=$5+$6; w2=$6+0; s2=$9+0}} $1=="ctxt"{m++; if(m==1)c1=$2+0; else c2=$2+0} END{dt=t2-t1; if(dt>0){printf "CPU_PCT=%.1f\\nIOWAIT_PCT=%.1f\\nSTEAL_PCT=%.1f\\n",(dt-(i2-i1))*100/dt,(w2-w1)*100/dt,(s2-s1)*100/dt} else printf "CPU_PCT=0.0\\nIOWAIT_PCT=0.0\\nSTEAL_PCT=0.0\\n"; if(c2>c1 && c1>0) printf "CTXT_PS=%d\\n",c2-c1}'`);
  // 运行队列 / 阻塞队列：比 loadavg 更能反映「现在到底堵没堵」
  L.push(`awk '/^procs_running/{printf "PROCS_RUNNING=%d\\n",$2} /^procs_blocked/{printf "PROCS_BLOCKED=%d\\n",$2}' /proc/stat 2>/dev/null`);
  // 文件句柄已用 / 上限（句柄耗尽会让服务直接起不来，且报错很难懂）
  L.push(`awk 'NR==1{printf "FD_USED=%d FD_MAX=%s\\n",$1,$3}' /proc/sys/fs/file-nr 2>/dev/null`);
  // inode 使用率：磁盘没满但 inode 满，是排障最费时间的一类故障
  L.push(`df -P -i 2>/dev/null | awk 'NR>1 && $1!~/^(tmpfs|devtmpfs|udev|none|squashfs|shm|efivarfs|proc|sysfs|cgroup)$/ && $6!~/^\\/(proc|sys|dev|run)(\\/|$)/ {p=$5; gsub(/%/,"",p); if(p+0>mx){mx=p+0; mp=$6}} END{if(mx>0) printf "INODE_MAX_PCT=%d INODE_MAX_MOUNT=%s\\n",mx,mp}'`);
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
  // IO1 之后解析器停在 io1 段，必须重新开一次 metrics 段，否则下面这些 KEY=VALUE 全被丢弃
  L.push(`echo '<<<METRICS>>>'`);
  // TCP 连接状态：直接读 /proc/net/tcp，不依赖 ss/netstat（老机器上两者不一定都装了）
  // 状态码：01=ESTABLISHED 06=TIME_WAIT 0A=LISTEN
  L.push(`awk 'FNR>1{if($4=="01")e++; else if($4=="06")w++; else if($4=="0A")l++} END{printf "TCP_ESTAB=%d TCP_TIMEWAIT=%d TCP_LISTEN=%d\\n",e+0,w+0,l+0}' /proc/net/tcp /proc/net/tcp6 2>/dev/null`);
  // 重传段数：重传率高 = 链路质量差，光看错包看不出来
  L.push(`awk '/^Tcp:/ && $3 ~ /^[0-9]+$/ {printf "TCP_RETRANS=%d TCP_OUTSEGS=%d\\n",$13,$12}' /proc/net/snmp 2>/dev/null | tail -n1`);
  // 网卡链路速率：千兆口掉成百兆只有这里看得到（-1/空 表示未连接，跳过）
  L.push(`NS=""; for d in /sys/class/net/*; do [ -e "$d/speed" ] || continue; n=$(basename "$d"); [ "$n" = "lo" ] && continue; s=$(cat "$d/speed" 2>/dev/null); case "$s" in ''|*[!0-9]*) continue;; esac; NS="$NS,$n:$s"; done; [ -n "$NS" ] && echo "NET_SPEED=$NS"`);
  // 软 RAID 状态：阵列降级是静默灾难，不看不报
  L.push(`if [ -r /proc/mdstat ]; then MA=$(grep -c '^md[0-9]' /proc/mdstat 2>/dev/null); MD=$(grep -cE '\\[[U_]*_[U_]*\\]' /proc/mdstat 2>/dev/null); else MA=0; MD=0; fi; [ -n "$MA" ] || MA=0; [ -n "$MD" ] || MD=0; echo "MD_ARRAYS=$MA MD_DEGRADED=$MD"`);
  // 失败的服务单元：比逐个配服务名覆盖广，也能发现「没纳入监控」的挂掉服务
  L.push(`if command -v systemctl >/dev/null 2>&1; then FU=$(systemctl list-units --state=failed --no-legend --no-pager 2>/dev/null | grep -c .); [ -n "$FU" ] || FU=0; else FU=0; fi; echo "FAILED_UNITS=$FU"`);
  // 时间同步偏差（毫秒）：结算、日志对时全靠它，漂了会出大问题
  L.push(`TO=""; if command -v chronyc >/dev/null 2>&1; then TO=$(chronyc tracking 2>/dev/null | awk '/System time/{v=$4; if(v<0)v=-v; printf "%d",v*1000}'); fi; if [ -z "$TO" ] && command -v ntpq >/dev/null 2>&1; then TO=$(ntpq -p 2>/dev/null | awk 'NR>2 && $1 ~ /^\\*/ {v=$9; if(v<0)v=-v; printf "%d",v}'); fi; echo "TIME_OFFSET_MS=$TO"`);
  // OOM 次数：内存杀进程的唯一痕迹（新内核 dmesg 受限时读不到，按 0 处理）
  L.push(`OOM=$(dmesg 2>/dev/null | grep -ci 'out of memory'); [ -n "$OOM" ] || OOM=0; echo "OOM_KILLS=$OOM"`);
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

/**
 * 空串必须返回 null：Number('') === 0，会把「没采到」显示成 0。
 * 时间偏差、失败单元这类值，0 和「不知道」是两件完全不同的事。
 */
function numOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  const n = Number(s);
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
    if (f.length < 13) continue;
    const name = f[2];
    // /proc/diskstats: 3=reads 完成 5=读扇区 6=读耗时ms 7=写完成 9=写扇区 10=写耗时ms 12=设备忙ms
    map[name] = {
      rd: Number(f[5]) || 0, wr: Number(f[9]) || 0,
      rd_ios: Number(f[3]) || 0, wr_ios: Number(f[7]) || 0,
      rd_ms: Number(f[6]) || 0, wr_ms: Number(f[10]) || 0,
      io_ms: Number(f[12]) || 0
    };
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
  // 磁盘 IO（KB/s）+ 扩展（IOPS / 平均等待 / 利用率）；只统计实体盘，跳过分区/虚拟设备
  const io0m = parseIoSnapshot(parsed.io0);
  const io1m = parseIoSnapshot(parsed.io1);
  const diskio = [];
  const extraDisks = [];
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
    // 两次采样间隔按 1 秒算（与上面 KB/s 同一口径）；计数器回退时不给值，别造假数
    const dr = b.rd_ios - a.rd_ios;
    const dw = b.wr_ios - a.wr_ios;
    const busy = b.io_ms - a.io_ms;
    extraDisks.push({
      dev: dev,
      read_iops: dr > 0 ? Math.round(dr) : 0,
      write_iops: dw > 0 ? Math.round(dw) : 0,
      read_await_ms: dr > 0 ? round1(Math.max(0, (b.rd_ms - a.rd_ms) / dr)) : null,
      write_await_ms: dw > 0 ? round1(Math.max(0, (b.wr_ms - a.wr_ms) / dw)) : null,
      util_pct: busy >= 0 ? round1(Math.min(100, busy / 10)) : null
    });
  }
  // 网卡链路速率（NET_SPEED 形如 ",eth0:1000,eth1:100"）
  const ifaceSpeed = [];
  for (const pair of String(mr.NET_SPEED || '').split(',')) {
    const p = pair.trim();
    if (!p) continue;
    const i = p.lastIndexOf(':');
    if (i <= 0) continue;
    const mbps = num(p.slice(i + 1));
    if (mbps === null) continue;
    ifaceSpeed.push({ iface: p.slice(0, i), speed_mbps: mbps });
  }
  const retrans = numOrNull(mr.TCP_RETRANS);
  const outsegs = numOrNull(mr.TCP_OUTSEGS);
  const extra = {
    platform: 'linux',
    // 与 exporter 通道共用「本轮采集」那段展示口径：脚本里确实隔 1 秒采了两次
    sampled_twice: true,
    gap_ms: 1000,
    cpu: {
      iowait_pct: numOrNull(mr.IOWAIT_PCT),
      steal_pct: numOrNull(mr.STEAL_PCT),
      ctxt_ps: numOrNull(mr.CTXT_PS),
      procs_running: numOrNull(mr.PROCS_RUNNING),
      procs_blocked: numOrNull(mr.PROCS_BLOCKED)
    },
    fs: {
      fd_used: numOrNull(mr.FD_USED),
      // 上限通常是 9223372036854775807，超过 JS 安全整数，必须按字符串保留原值
      fd_max: mr.FD_MAX ? String(mr.FD_MAX) : null,
      inode_max_pct: numOrNull(mr.INODE_MAX_PCT),
      inode_max_mount: mr.INODE_MAX_MOUNT || ''
    },
    net: {
      tcp_estab: numOrNull(mr.TCP_ESTAB),
      tcp_timewait: numOrNull(mr.TCP_TIMEWAIT),
      tcp_listen: numOrNull(mr.TCP_LISTEN),
      retrans_total: retrans,
      retrans_pct: (retrans !== null && outsegs) ? round1(retrans * 100 / outsegs) : null,
      iface: ifaceSpeed
    },
    disks: extraDisks,
    health: {
      failed_units: numOrNull(mr.FAILED_UNITS),
      time_offset_ms: numOrNull(mr.TIME_OFFSET_MS),
      oom: numOrNull(mr.OOM_KILLS),
      md_arrays: numOrNull(mr.MD_ARRAYS),
      md_degraded: numOrNull(mr.MD_DEGRADED)
    }
  };
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
    customs,
    extra
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
