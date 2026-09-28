'use strict';
/**
 * Windows 服务器采集模块（SSH 访问方式）
 * 远程：通过 SSH 用 cmd + wmic/netstat 原生通道采集（不依赖 powershell，绕开 EDR 对 powershell 的拦截）
 * 本机：auth.type = "local" 时直接用 PowerShell 在本地执行
 * 远程 WMI：auth.type = "wmi" 时走 WmiQuery 工具（域环境零配置）
 */

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');
const { sshConnect, sshExecRaw, sshExecStdin, friendlySshError } = require('./sshutil');
const { extractJson, normArray, psSingle, round1 } = require('./common');

/* 通过 SSH stdin 执行 PowerShell 脚本的短命令（多个候选依次尝试）。
 *  命令行本身恒定约 300 字符，彻底绕开远端 cmd.exe 的 8191 字符上限；
 *  真正的脚本内容从 stdin 流式喂入（见 sshExecStdin），不再受命令行长度限制。
 *
 * ★ 关键坑（踩过两次）：不能用 [Console]::In.ReadToEnd() 读脚本。
 *   它按「控制台输入编码」解码，中文 Windows 上是 GBK(936)，而 SSH 发来的是 UTF-8，
 *   脚本里只要有中文（注释或输出文案）就会被解码成乱码 → 报
 *   "表达式或语句中包含意外的标记" 的行1/末尾解析错误，表现就是整条回退通道失败。
 *   改为 OpenStandardInput() 读**原始字节**再自行 [Text.Encoding]::UTF8.GetString，
 *   与系统代码页完全无关，中文脚本也能正确执行。
 *
 * 两个候选：
 *   ① 内存执行（Invoke-Expression）：不落盘，避开 EDR 对写文件的拦截，首选；
 *   ② 落盘执行（写 UTF8-BOM 临时 ps1 再 &）：Invoke-Expression 被约束语言模式禁用时的退路。 */
const PS_READ_STDIN = "$ms=New-Object System.IO.MemoryStream; [System.Console]::OpenStandardInput().CopyTo($ms); $s=[System.Text.Encoding]::UTF8.GetString($ms.ToArray());";
const PS_RUNNERS = [
  PS_READ_STDIN + " Invoke-Expression $s",
  PS_READ_STDIN + " $f=Join-Path $env:TEMP ('qy_'+[System.Guid]::NewGuid().ToString('N')+'.ps1'); [System.IO.File]::WriteAllText($f,$s,(New-Object System.Text.UTF8Encoding($true))); & $f; Remove-Item $f -Force -ErrorAction SilentlyContinue",
];

function num(v) {
  const n = Number(v);
  return isNaN(n) ? null : n;
}

/** 共用 PowerShell 片段：采集网络吞吐、磁盘 IO、近 24h 事件日志错误/警告。
 *  在两条 PowerShell 通道（本地 buildScript、非 WMI 回退）内直接内联；
 *  在 wmic 主路作为 best-effort 额外调用（被 EDR 拦截时降级为 null）。
 *  输出四个变量：$net / $diskio / $log_errors / $log_warns */
function extraPsSnippet() {
  return `
$net=@(); $diskio=@(); $log_errors=0; $log_warns=0
try {
  Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' } | ForEach-Object {
    $net += [PSCustomObject]@{ iface=$_.Name; rx_kbps=[math]::Round(($_.BytesReceivedPersec)/1024); tx_kbps=[math]::Round(($_.BytesSentPersec)/1024); errs=0; drops=0 }
  }
} catch { }
try {
  $e=0; Get-NetAdapterStatistics -ErrorAction Stop | ForEach-Object { $e += (($_.ReceivedErrors+$_.SentErrors+$_.ReceivedDiscardedPackets+$_.SentDiscardedPackets)) }; if($net.Count -gt 0){ $net | ForEach-Object { $_.errs=$e; $_.drops=$e } }
} catch { }
try {
  Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -ErrorAction Stop | Where-Object { $_.Name -ne '_Total' } | ForEach-Object {
    $diskio += [PSCustomObject]@{ dev=$_.Name; r_kbps=[math]::Round(($_.DiskReadBytesPersec)/1024); w_kbps=[math]::Round(($_.DiskWriteBytesPersec)/1024) }
  }
} catch { }
try {
  $since=(Get-Date).AddHours(-24)
  $errEvts = @(Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=$since} -ErrorAction Stop)
  $log_errors = $errEvts.Count
  $warnEvts = @(Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=3; StartTime=$since} -ErrorAction Stop)
  $log_warns = $warnEvts.Count
} catch {
  try {
    $log_errors = @(Get-EventLog -LogName System,Application -EntryType Error -After $since -ErrorAction Stop).Count
    $log_warns = @(Get-EventLog -LogName System,Application -EntryType Warning -After $since -ErrorAction Stop).Count
  } catch { }
}
`;
}

/** 不依赖 WMI 的网络/磁盘IO/日志采集片段（供非 WMI 回退通道使用）。
 *  与 extraPsSnippet 不同，本片段严禁使用 Get-CimInstance（依赖 WMI 仓库），
 *  目标机 WMI 故障时 Get-CimInstance 会卡死导致整次采集超时。改用 Get-Counter 走 PDH
 *  （性能计数器子系统，独立于 WMI 仓库），以及 Get-WinEvent 走事件日志服务（同样独立于 WMI）。
 *  输出四个变量：$net / $diskio / $log_errors / $log_warns */
function extraPsSnippetNoWmi() {
  return `
$net=@(); $diskio=@(); $log_errors=0; $log_warns=0
try {
  $rx = Get-Counter -Counter '\\Network Interface(*)\\Bytes Received/sec' -ErrorAction Stop
  $tx = Get-Counter -Counter '\\Network Interface(*)\\Bytes Sent/sec' -ErrorAction Stop
  $nmap = @{}
  foreach ($s in $rx.CounterSamples) { if ($s.InstanceName -and $s.InstanceName -ne '_Total') { $nmap[$s.InstanceName] = [PSCustomObject]@{ iface=$s.InstanceName; rx_kbps=[math]::Round($s.CookedValue/1024); tx_kbps=0; errs=0; drops=0 } } }
  foreach ($s in $tx.CounterSamples) { if ($s.InstanceName -and $s.InstanceName -ne '_Total' -and $nmap.ContainsKey($s.InstanceName)) { $nmap[$s.InstanceName].tx_kbps = [math]::Round($s.CookedValue/1024) } }
  $net = @($nmap.Values)
} catch { }
try {
  $r = Get-Counter -Counter '\\PhysicalDisk(*)\\Disk Read Bytes/sec' -ErrorAction Stop
  $w = Get-Counter -Counter '\\PhysicalDisk(*)\\Disk Write Bytes/sec' -ErrorAction Stop
  $dmap = @{}
  foreach ($s in $r.CounterSamples) { if ($s.InstanceName -and $s.InstanceName -ne '_Total') { $dmap[$s.InstanceName] = [PSCustomObject]@{ dev=$s.InstanceName; r_kbps=[math]::Round($s.CookedValue/1024); w_kbps=0 } } }
  foreach ($s in $w.CounterSamples) { if ($s.InstanceName -and $s.InstanceName -ne '_Total' -and $dmap.ContainsKey($s.InstanceName)) { $dmap[$s.InstanceName].w_kbps = [math]::Round($s.CookedValue/1024) } }
  $diskio = @($dmap.Values)
} catch { }
try {
  $since=(Get-Date).AddHours(-24)
  $log_errors = @(Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=1,2; StartTime=$since} -ErrorAction Stop).Count
  $log_warns = @(Get-WinEvent -FilterHashtable @{LogName='System','Application'; Level=3; StartTime=$since} -ErrorAction Stop).Count
} catch {
  try {
    $log_errors = @(Get-EventLog -LogName System,Application -EntryType Error -After $since -ErrorAction Stop).Count
    $log_warns = @(Get-EventLog -LogName System,Application -EntryType Warning -After $since -ErrorAction Stop).Count
  } catch { }
}
`;
}

/** 采集脚本主体（只读操作），cfg 直接以字符串字面量嵌入 */
function buildScript(server) {
  const cfgPayload = JSON.stringify({
    services: normArray(server.services).map((s) => ({ type: s.type, name: String(s.name) })),
    custom: normArray(server.custom_commands).map((c) => ({ name: c.name, command: c.command }))
  });
  return `
$ErrorActionPreference='Continue'
try { [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new() } catch { }
function QwStage([string]$n){ [Console]::Out.WriteLine('QWINSPECT-STAGE:' + $n); [Console]::Out.Flush() }
QwStage 'start'
$cfg = ConvertFrom-Json '${psSingle(cfgPayload)}'
QwStage 'cfg'
$os = Get-CimInstance Win32_OperatingSystem
QwStage 'os'
$cpu = 0
try { $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } catch { }
if ($null -eq $cpu) { $cpu = 0 }
$cores = 0
try { $cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum } catch { }
if ($null -eq $cores) { $cores = 0 }
QwStage 'cpu'
$upSec = [int]($os.LocalDateTime - $os.LastBootUpTime).TotalSeconds
$disks = @()
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $sz = [double]$_.Size; $fr = [double]$_.FreeSpace
  $disks += [PSCustomObject]@{
    mount = $_.DeviceID
    fs = $_.FileSystem
    size_mb = [math]::Round($sz/1MB)
    used_mb = [math]::Round(($sz-$fr)/1MB)
    avail_mb = [math]::Round($fr/1MB)
    use_percent = $(if($sz -gt 0){[math]::Round(($sz-$fr)*100/$sz)}else{0})
  }
}
QwStage 'disks'
$svcs = @()
foreach ($s in $cfg.services) {
  if ($s.type -eq 'service') {
    $svc = Get-Service -Name $s.name -ErrorAction SilentlyContinue
    $running = $false; $detail = '未找到该服务'
    if ($svc) { $running = ($svc.Status -eq 'Running'); $detail = [string]$svc.Status }
    $svcs += [PSCustomObject]@{ name=$s.name; type='service'; running=$running; detail=$detail }
  } elseif ($s.type -eq 'process') {
    $procs = @(Get-Process -Name $s.name -ErrorAction SilentlyContinue)
    $svcs += [PSCustomObject]@{ name=$s.name; type='process'; running=($procs.Count -gt 0); detail=("$($procs.Count) 个进程") }
  } elseif ($s.type -eq 'port') {
    $p = 0; [int]::TryParse([string]$s.name, [ref]$p) | Out-Null
    $running = $false; $detail = ''
    try {
      $l = @(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction Stop)
      $running = $l.Count -gt 0; $detail = "$($l.Count) 个监听"
    } catch {
      $n = @(netstat -an | Select-String (":$p\\s") | Select-String 'LISTENING')
      $running = $n.Count -gt 0; $detail = "$($n.Count) 个监听"
    }
    $svcs += [PSCustomObject]@{ name=$s.name; type='port'; running=$running; detail=$detail }
  }
}
QwStage 'services'
$customs = @()
foreach ($c in $cfg.custom) {
  $out = ''; $code = 0
  try { $out = ((Invoke-Expression $c.command 2>&1) | Out-String).Trim() } catch { $out = $_.Exception.Message; $code = 1 }
  if ($out.Length -gt 2000) { $out = $out.Substring(0,2000) + '...(已截断)' }
  $customs += [PSCustomObject]@{ name=$c.name; output=$out; code=$code }
}
QwStage 'customs'
$procCount = @(Get-Process).Count
QwStage 'procs'
${extraPsSnippet()}
[PSCustomObject]@{
  hostname = $env:COMPUTERNAME
  os = $os.Caption
  kernel = $os.Version
  uptime_sec = $upSec
  cpu_percent = [math]::Round([double]$cpu,1)
  cpu_cores = $cores
  proc_count = $procCount
  mem_total_mb = [math]::Round($os.TotalVisibleMemorySize/1024)
  mem_used_mb = [math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory)/1024)
  disks = $disks
  services = $svcs
  customs = $customs
  net = $net
  diskio = $diskio
  log_errors = $log_errors
  log_warns = $log_warns
} | ConvertTo-Json -Depth 6 -Compress
QwStage 'done'
`;
}

/** 按 GBK 解码远端输出（中文 Windows 的 cmd/wmic 输出编码） */
function decodeGbk(buf) {
  return iconv.decode(buf, 'gbk');
}

/** 简易 CSV 行解析（支持双引号包裹与转义） */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** 解析 wmic /format:csv 输出为对象数组 */
function wmicRows(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const f = parseCsvLine(lines[i]);
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = f[j] === undefined ? '' : f[j].trim();
    }
    rows.push(obj);
  }
  return rows;
}

/** 解析 wmic 时间串 20260825103000.000000+480 为 Date */
function parseWmicTime(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** 解码命令的 stderr：优先用原始字节按 GBK 解码（中文 Windows 的错误信息是 GBK），
 *  避免直接把 GBK 字节当 UTF-8 拼串而产生乱码。 */
function decodeStderr(r) {
  if (r && Buffer.isBuffer(r.stderrRaw) && r.stderrRaw.length) {
    const g = iconv.decode(r.stderrRaw, 'gbk').trim();
    const u = r.stderrRaw.toString('utf8').trim();
    // UTF-8 解码无替换字符时优先 UTF-8（部分远端为英文或 UTF-8 输出）
    if (u && u.indexOf('\uFFFD') === -1) return u;
    if (g) return g;
  }
  return String((r && r.stderr) || '').trim();
}

/** 解码命令的 stdout（自定义命令输出）：自适应 UTF-8 / GBK。
 *  中文 Windows 的 cmd 输出通常是 GBK；若 UTF-8 解码出现替换字符（U+FFFD）说明是 GBK。 */
function decodeOutput(buf) {
  if (!buf || !buf.length) return '';
  const u = buf.toString('utf8');
  if (u.indexOf('\uFFFD') === -1) return u.trim();
  const g = iconv.decode(buf, 'gbk');
  // GBK 解出的替换字符更少时才采用，避免误判
  const cnt = (s) => (s.match(/\uFFFD/g) || []).length;
  return (cnt(g) < cnt(u) ? g : u).trim();
}

/** 过滤 PowerShell 远程执行时的 CLIXML 进度/序列化噪声（#< CLIXML <Objs ...>）。
 *  这类输出不是真实错误，混在 stderr 里会让报错信息不可读。 */
function stripClixml(s) {
  let out = String(s || '');
  const idx = out.indexOf('#< CLIXML');
  if (idx >= 0) out = out.slice(0, idx);
  // 去掉残留的 XML 片段
  out = out.replace(/<Objs[\s\S]*?<\/Objs>/g, '');
  return out.trim();
}

/** 解码 PowerShell 输出并提取 JSON。
 *  注意：GBK 字节按 UTF-8 解码时，JSON 结构字符仍是 ASCII，extractJson 会"成功"
 *  但中文全是乱码，因此必须先判断 UTF-8 解码是否可信（是否出现替换字符 U+FFFD）。 */
function decodePwshJson(buf) {
  const utf8 = buf.toString('utf8');
  const utf8Data = extractJson(utf8);
  const utf8Valid = !!utf8Data && utf8Data.hostname !== undefined;
  const utf8Suspect = utf8.indexOf('\uFFFD') !== -1;

  if (utf8Valid && !utf8Suspect) return utf8Data;
  const gbkData = extractJson(decodeGbk(buf));
  if (gbkData && gbkData.hostname !== undefined) return gbkData;
  // GBK 也解析不出来时，退回 UTF-8 的结果（可能仅个别字符乱码，好过整体失败）
  return utf8Valid ? utf8Data : null;
}

/**
 * 经 SSH stdin 执行一段 PowerShell 脚本：依次尝试 PS_RUNNERS，直到解析出 JSON。
 * 多执行器的原因：不同机器的安全策略不同（约束语言模式禁 Invoke-Expression、
 * EDR 禁写临时文件等），单个写法无法通吃，逐个试最稳。
 *  @returns {Promise<{data:object|null, last:object|null}>}
 */
async function runPsScript(conn, script, timeoutMs) {
  let last = null;
  for (const runner of PS_RUNNERS) {
    const cmd = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "' + runner + '"';
    const r = await sshExecStdin(conn, cmd, script, timeoutMs);
    last = r;
    const data = decodePwshJson(r.stdout);
    if (data) return { data, last: r };
  }
  return { data: null, last };
}

/** 从最后一次失败的 PowerShell 执行结果里提炼可读原因（截去过长的 CLIXML） */
function psErrorDetail(r) {
  if (!r) return '';
  const raw = stripClixml(decodeStderr(r)) || '';
  const flat = raw.replace(/\r?\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  // PowerShell 报错首行通常最具信息量（如"表达式或语句中包含意外的标记"），优先保留
  const first = flat.split(/(?<=[。；])/)[0] || flat;
  return (first.length > 160 ? first.slice(0, 160) + '…' : first);
}

/** 非 WMI 采集脚本：目标机 WMI 仓库/DCOM 故障时，wmic 与 Get-CimInstance 均不可用，
 *  改用注册表 + PerformanceCounter + ComputerInfo + DriveInfo + Get-Service + netstat。
 *  该路径在 wmic 被移除的新系统（Win11 24H2+）上同样可用，因此作为统一回退通道。
 *  设计要点：脚本不含设备配置（服务/自定义命令在 JS 侧匹配与执行），长度可控；
 *  执行时整体经 SSH stdin 流式喂入（见 runPsScript），不占用命令行，彻底绕开
 *  cmd.exe 的 8191 字符命令行上限（旧实现用 -EncodedCommand 内嵌脚本，被更新后变长的
 *  脚本撑爆上限而报"命令行太长"）。
 *  脚本内允许出现中文：执行器按 UTF-8 解码 stdin 原始字节，不受目标机代码页影响。 */
function buildNoWmiScript() {
  return `
$ErrorActionPreference='Continue'
try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch { }
$os=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$mt=0;$ma=0
try{
  Add-Type -AssemblyName Microsoft.VisualBasic
  $ci=New-Object Microsoft.VisualBasic.Devices.ComputerInfo
  $mt=[int]($ci.TotalPhysicalMemory/1MB);$ma=[int]($ci.AvailablePhysicalMemory/1MB)
}catch{
  try{ $ma=[int](New-Object System.Diagnostics.PerformanceCounter('Memory','Available MBytes')).NextValue() }catch{ }
}
$up=0
try{ $sys=Get-Process -Id 4 -ErrorAction Stop; if($sys.StartTime){$up=[int]((Get-Date)-$sys.StartTime).TotalSeconds} }catch{ }
if($up -le 0){ try{ $c=New-Object System.Diagnostics.PerformanceCounter('System','System Up Time'); $c.NextValue()|Out-Null; Start-Sleep -Milliseconds 300; $up=[int]$c.NextValue() }catch{ } }
$cpu=0
try{ $c2=New-Object System.Diagnostics.PerformanceCounter('Processor','% Processor Time','_Total'); $c2.NextValue()|Out-Null; Start-Sleep -Milliseconds 700; $cpu=[math]::Round($c2.NextValue(),1) }catch{ }
$cores=0;[int]::TryParse($env:NUMBER_OF_PROCESSORS,[ref]$cores)|Out-Null
$disks=@()
foreach($d in [System.IO.DriveInfo]::GetDrives()){
  if($d.DriveType -eq 'Fixed' -and $d.IsReady){
    $t=[int64]$d.TotalSize;$f=[int64]$d.AvailableFreeSpace
    $disks+=[PSCustomObject]@{mount=$d.Name;fs=$d.DriveFormat;size_mb=[math]::Round($t/1MB);used_mb=[math]::Round(($t-$f)/1MB);avail_mb=[math]::Round($f/1MB);use_percent=$(if($t -gt 0){[math]::Round(($t-$f)*100/$t)}else{0})}
  }
}
$svc=@{}
try{ foreach($s in Get-Service){ $svc[[string]$s.Name]=[string]$s.Status } }catch{ }
$procs=@{};$pc=0
try{ foreach($p in Get-Process){ $pc++; $k=[string]$p.ProcessName.ToLower(); if($procs.ContainsKey($k)){$procs[$k]=$procs[$k]+1}else{$procs[$k]=1} } }catch{ }
$ports=@{}
try{ foreach($l in (netstat -an)){ if($l -match '^\\s*TCP\\s+\\S+:(\\d+)\\s+\\S+\\s+LISTENING'){ $pt=$Matches[1]; if($ports.ContainsKey($pt)){$ports[$pt]=$ports[$pt]+1}else{$ports[$pt]=1} } } }catch{ }
# 网络吞吐/磁盘IO/事件日志错误不在此处采集：它们依赖 PDH/事件日志，部分环境较慢，
# 改为由 collectRemoteNoWmi 单独 best-effort 调用 extraPsSnippetNoWmi 采集，
# 失败或超时仅令这些指标降级，不影响核心指标（CPU/内存/磁盘/服务/端口）返回。
[PSCustomObject]@{
  hostname=$env:COMPUTERNAME
  os=$os.ProductName
  kernel=$os.CurrentVersion+'.'+$os.CurrentBuild
  uptime_sec=$up
  cpu_percent=$cpu
  cpu_cores=$cores
  mem_total_mb=$mt
  mem_used_mb=$(if($mt -gt 0){$mt-$ma}else{0})
  proc_count=$pc
  disks=$disks
  all_services=$svc
  all_procs=$procs
  listen_ports=$ports
}|ConvertTo-Json -Depth 5 -Compress
`;
}

/** 非 WMI 回退采集：一次调用取回全部系统指标与全量服务/进程/端口表，
 *  再在本地按配置匹配检查项，自定义命令逐条独立执行。
 *  shellType 为远端默认 shell（cmd/powershell），用于决定自定义命令的执行写法。 */
async function collectRemoteNoWmi(server, conn, timeoutMs, shellType) {
  const script = buildNoWmiScript();
  // 不再用 -EncodedCommand 把整段脚本塞进命令行：脚本 base64 后常超过远端 cmd.exe 的
  // 8191 字符上限，会直接报"命令行太长"导致回退失败。改为把脚本经 SSH 通道 stdin 流式
  // 喂入，远端用恒定约 300 字符的短命令读 stdin 再执行，彻底绕开该限制。
  const pr = await runPsScript(conn, script, Math.max(timeoutMs, 45000));
  const data = pr.data;
  if (!data) {
    const detail = psErrorDetail(pr.last);
    return {
      ok: false,
      error: 'PowerShell 非 WMI 回退采集失败'
        + (pr.last && pr.last.timedOut ? '（执行超时）' : '')
        + (detail ? '：' + detail : '：无输出（可能被安全软件拦截 powershell）')
    };
  }

  // 核心系统指标已取到（CPU/内存/磁盘/服务/端口）。
  // 网络吞吐 / 磁盘 IO / 事件日志错误为 best-effort：它们依赖 PDH 计数器与事件日志服务，
  // 在极端情况下可能较慢或不可用；用独立短超时单独采集，失败/超时仅令这些指标降级为空，
  // 不影响核心指标返回。严禁再调用 Get-CimInstance（依赖 WMI 仓库）——目标机 WMI 故障时会
  // 卡死导致整次采集超时，故使用 Get-Counter（走 PDH，独立于 WMI）。
  let extraNet = [];
  let extraDiskio = [];
  let extraLogErrors = null;
  let extraLogWarns = null;
  try {
    const exScript = '$ErrorActionPreference=Continue\n' + extraPsSnippetNoWmi() +
      '\n[PSCustomObject]@{net=$net;diskio=$diskio;log_errors=$log_errors;log_warns=$log_warns}|ConvertTo-Json -Depth 5 -Compress';
    const exPr = await runPsScript(conn, exScript, Math.max(20000, Math.floor(timeoutMs / 2)));
    const ex = exPr.data;
    if (ex) {
      extraNet = normArray(ex.net);
      extraDiskio = normArray(ex.diskio);
      extraLogErrors = num(ex.log_errors);
      extraLogWarns = num(ex.log_warns);
    }
  } catch (e) { /* 忽略，降级为空 */ }

  // 大小写不敏感地建立查找表（PowerShell 哈希表键大小写保留原样）
  const svcMap = {};
  for (const k of Object.keys(data.all_services || {})) svcMap[k.toLowerCase()] = data.all_services[k];
  const procMap = {};
  for (const k of Object.keys(data.all_procs || {})) procMap[k.toLowerCase()] = data.all_procs[k];
  const portMap = data.listen_ports || {};

  const services = normArray(server.services).map((s) => {
    const name = String(s.name);
    if (s.type === 'service') {
      const st = svcMap[name.toLowerCase()];
      return { name, type: 'service', running: st === 'Running', detail: st || '未找到该服务' };
    }
    if (s.type === 'process') {
      const cnt = (procMap[name.toLowerCase()] || 0) + (procMap[(name + '.exe').toLowerCase()] || 0);
      return { name, type: 'process', running: cnt > 0, detail: cnt + ' 个进程' };
    }
    if (s.type === 'port') {
      const p = name.replace(/[^0-9]/g, '');
      const cnt = portMap[p] || 0;
      return { name, type: 'port', running: cnt > 0, detail: cnt + ' 个监听' };
    }
    return { name, type: s.type || 'unknown', running: false, detail: '不支持的检查类型' };
  });

  // 自定义命令逐条独立执行（与 wmic 通道一致，避免脚本体积随配置增长）
  // 按远端默认 shell 决定执行写法（见 detectRemoteShell）：cmd shell 直接执行，
  // 不能再加 cmd /c（否则双重嵌套使 echo %SystemDrive% 输出 C:"，且 ver、set 失败）；
  // powershell shell 则需包一层 cmd /c 才能执行 cmd 语法命令。
  const customs = [];
  const perCmd = Math.max(8000, Math.floor(timeoutMs / 2));
  for (const c of normArray(server.custom_commands)) {
    const cr = await sshExecRaw(conn, wrapCustomCommand(c.command, shellType), Math.min(perCmd, 20000));
    const out = decodeOutput(cr.stdout);
    customs.push({
      name: c.name,
      output: out.length > 2000 ? out.slice(0, 2000) + '...(已截断)' : out,
      code: (cr.code === null || cr.code === undefined || cr.code === -1) ? 1 : cr.code
    });
  }

  return normalize({
    hostname: data.hostname,
    os: data.os,
    kernel: data.kernel,
    uptime_sec: data.uptime_sec,
    cpu_percent: data.cpu_percent,
    cpu_cores: data.cpu_cores,
    proc_count: data.proc_count,
    mem_total_mb: data.mem_total_mb,
    mem_used_mb: data.mem_used_mb,
    disks: data.disks,
    services,
    customs,
    net: extraNet,
    diskio: extraDiskio,
    log_errors: extraLogErrors,
    log_warns: extraLogWarns
  });
}

/** 诊断 wmic 无输出的根因，做确定性分类。
 *  只用 `where wmic`（实测 ~260ms，稳定）判断 wmic 可执行文件是否存在：
 *    - 不存在 → 系统已移除 wmic（Windows 11 24H2+ / Server 2025+）
 *    - 存在但主查询取不到任何行 → WMI 服务/仓库故障（wmic 依赖 WMI，
 *      Get-CimInstance / systeminfo 同样会失效，报"服务器运行失败" 0x80080005）
 *  不使用 Get-CimInstance 探测：WMI 故障时它会卡满 30 秒才抛错，得不偿失。 */
async function diagnoseWmic(conn, wmicErr) {
  const res = { wmicMissing: false, wmiBroken: false, detail: String(wmicErr || '') };
  try {
    // 用 where.exe 而非 where：PowerShell 下 where 是 Where-Object 的别名，
    // 会返回空结果并被误判为"wmic 已移除"；where.exe 在两种 shell 下行为一致
    const w = await sshExecRaw(conn, 'where.exe wmic', 8000);
    const wo = decodeOutput(w.stdout);
    const we = stripClixml(decodeStderr(w));
    const notFound = !wo || /INFO: Could not find files|找不到文件|not recognized|不是内部或外部命令/i.test(we + ' ' + wo);
    res.wmicMissing = notFound;
    // wmic 存在却查不出数据 → WMI 本身故障
    if (!notFound) res.wmiBroken = true;
  } catch (e) {
    // 探测失败时不武断分类，交由调用方按"原因未明"处理
  }
  return res;
}

/** 探测远端 OpenSSH 的默认 shell 类型（cmd.exe 或 powershell.exe）。
 *  两者执行自定义命令的正确写法正好相反：
 *    - 默认 shell = cmd        → 直接执行 cmd 语法命令（不能再加 cmd /c，会双重嵌套导致
 *                                 输出末尾多出引号，且 ver、set 等命令失败）
 *    - 默认 shell = powershell → cmd 语法命令（如 echo %VAR%、ver）必须包一层 cmd /c 才能工作
 *  探测信号：cmd 下 `$PSVersionTable.PSVersion` 不是合法命令 → 退出码非 0 且无输出；
 *  PowerShell 下则能正常输出版本号。探测耗时约 200ms（cmd）/ 5s（PS），每次连接只做一次。 */
async function detectRemoteShell(conn) {
  try {
    const r = await sshExecRaw(conn, '$PSVersionTable.PSVersion', 8000);
    const out = decodeOutput(r.stdout);
    if (r.code === 0 && /\d/.test(out)) return 'powershell';
  } catch (e) { /* 探测失败按 cmd 处理（OpenSSH 默认） */ }
  return 'cmd';
}

/** 按远端默认 shell 包装自定义命令 */
function wrapCustomCommand(command, shellType) {
  return shellType === 'powershell' ? ('cmd /c ' + command) : command;
}

/** 远程 SSH 采集：cmd + wmic/netstat 原生通道，不依赖 powershell */
async function collectRemote(server, timeoutMs) {
  let conn = null;
  try {
    conn = await sshConnect(server, timeoutMs);
    const perCmd = Math.max(8000, Math.floor(timeoutMs / 2));
    // 探测默认 shell，决定自定义命令的执行写法（约 200ms，仅一次）
    const shellType = await detectRemoteShell(conn);

    // 1. 操作系统 + 内存
    const osR = await sshExecRaw(conn,
      'wmic os get Caption,CSName,Version,LastBootUpTime,LocalDateTime,TotalVisibleMemorySize,FreePhysicalMemory /format:csv', perCmd);
    const osText = decodeGbk(osR.stdout);
    const osRows = wmicRows(osText);
    if (osRows.length === 0) {
      // wmic 无输出，两类根因：
      //   a) 系统已移除 wmic（Windows 11 24H2+ / Server 2025+）
      //   b) WMI 仓库或 DCOM 故障（报"服务器运行失败" 0x80080005），此时 Get-CimInstance、
      //      systeminfo 等一切依赖 WMI 的手段同样失效
      // 因此降级到「不依赖 WMI」的采集通道（注册表 + 性能计数器 + DriveInfo + Get-Service + netstat），
      // 它同时覆盖 a 和 b 两种情况。不再回退到 Get-CimInstance：对 b 无效；该通道改为经 SSH stdin
      // 喂脚本给 powershell，不再受 cmd.exe 8191 字符命令行上限约束。
      const wmicErr = stripClixml(decodeStderr(osR)).replace(/\r?\n/g, ' ').trim();
      // wmic 有时不吐错误文本（空输出 + 非 0 退出码），仅凭 stderr 判定不稳定，
      // 故主动探测：wmic 是否存在 + 最小 WMI 查询是否故障，得到确定性分类。
      const diag = await diagnoseWmic(conn, wmicErr);
      const wmiBroken = diag.wmiBroken;
      const wmicMissing = diag.wmicMissing;

      const fb = await collectRemoteNoWmi(server, conn, timeoutMs, shellType);
      if (fb && fb.ok) {
        fb.note = wmiBroken
          ? 'WMI 服务故障，已自动改用不依赖 WMI 的通道采集（注册表 + 性能计数器）'
          : wmicMissing
            ? '目标系统已移除 wmic，已自动改用不依赖 WMI 的通道采集'
            : 'wmic 无输出，已自动改用不依赖 WMI 的通道采集';
        return fb;
      }

      const cause = wmiBroken
        ? '目标机 WMI 服务/仓库故障（' + (diag.detail || wmicErr || '服务器运行失败')
          + '），wmic 与 Get-CimInstance 均不可用'
        : wmicMissing
          ? '目标系统已移除 wmic（Windows 11 24H2+ / Server 2025+）'
          : 'wmic 无输出' + (wmicErr ? '（' + wmicErr.slice(0, 120) + '）' : '') + '，原因未明';
      throw new Error(cause
        + (osR.timedOut ? '（wmic 命令执行超时）' : '')
        + '。非 WMI 回退通道也失败：' + ((fb && fb.error) || '无输出')
        + '。建议：在该机开启 powershell 执行白名单后重试；若为域环境也可改用 WMI 登录方式'
        + (wmiBroken ? '（注意：该方式同样依赖 WMI，需先修复目标机 WMI，可执行 winmgmt /verifyrepository 排查）' : '')
        + '。');
    }
    const o = osRows[0];
    const totalKb = num(o.TotalVisibleMemorySize) || 0;
    const freeKb = num(o.FreePhysicalMemory) || 0;
    const boot = parseWmicTime(o.LastBootUpTime);
    const now = parseWmicTime(o.LocalDateTime);
    const uptimeSec = (boot && now) ? Math.floor((now - boot) / 1000) : null;

    // 2. CPU
    const cpuR = await sshExecRaw(conn,
      'wmic cpu get LoadPercentage,NumberOfLogicalProcessors /format:csv', perCmd);
    const cpuRows = wmicRows(decodeGbk(cpuR.stdout));
    let cpuSum = 0, cpuCnt = 0, cores = 0;
    for (const r of cpuRows) {
      cpuSum += num(r.LoadPercentage) || 0;
      cpuCnt++;
      cores += num(r.NumberOfLogicalProcessors) || 0;
    }
    const cpuPct = cpuCnt ? round1(cpuSum / cpuCnt) : 0;

    // 3. 磁盘
    const diskR = await sshExecRaw(conn,
      'wmic logicaldisk where drivetype=3 get DeviceID,FileSystem,Size,FreeSpace /format:csv', perCmd);
    const disks = wmicRows(decodeGbk(diskR.stdout)).map((r) => {
      const sz = num(r.Size) || 0;
      const fr = num(r.FreeSpace) || 0;
      return {
        mount: r.DeviceID || '',
        fs: r.FileSystem || '',
        size_mb: Math.round(sz / 1048576),
        used_mb: Math.round((sz - fr) / 1048576),
        avail_mb: Math.round(fr / 1048576),
        use_percent: sz > 0 ? Math.round((sz - fr) * 100 / sz) : 0
      };
    });

    // 4. 进程（名称 + 计数）
    const procR = await sshExecRaw(conn, 'wmic process get Name /format:csv', perCmd);
    const procNames = {};
    let procCount = 0;
    for (const r of wmicRows(decodeGbk(procR.stdout))) {
      const n = (r.Name || '').trim();
      if (!n) continue;
      procCount++;
      procNames[n.toLowerCase()] = (procNames[n.toLowerCase()] || 0) + 1;
    }

    // 5. 服务状态
    const svcR = await sshExecRaw(conn, 'wmic service get Name,State /format:csv', perCmd);
    const svcStates = {};
    for (const r of wmicRows(decodeGbk(svcR.stdout))) {
      const n = (r.Name || '').trim();
      if (n) svcStates[n.toLowerCase()] = (r.State || '').trim();
    }

    // 6. 监听端口
    const netR = await sshExecRaw(conn, 'netstat -an', perCmd);
    const netText = decodeGbk(netR.stdout);
    const listenPorts = {};
    const listenRe = /TCP\s+(\S+)\s+LISTENING/gi;
    let m;
    while ((m = listenRe.exec(netText)) !== null) {
      const am = m[1].match(/:(\d+)$/);
      if (am) listenPorts[am[1]] = (listenPorts[am[1]] || 0) + 1;
    }

    // 7. 服务检查项
    const services = normArray(server.services).map((s) => {
      const name = String(s.name);
      if (s.type === 'service') {
        const st = svcStates[name.toLowerCase()];
        return { name, type: 'service', running: st === 'Running', detail: st || '未找到该服务' };
      }
      if (s.type === 'process') {
        const c1 = procNames[name.toLowerCase()] || 0;
        const c2 = procNames[(name + '.exe').toLowerCase()] || 0;
        const cnt = c1 + c2;
        return { name, type: 'process', running: cnt > 0, detail: cnt + ' 个进程' };
      }
      if (s.type === 'port') {
        const p = name.replace(/[^0-9]/g, '');
        const cnt = listenPorts[p] || 0;
        return { name, type: 'port', running: cnt > 0, detail: cnt + ' 个监听' };
      }
      return { name, type: s.type || 'unknown', running: false, detail: '不支持的检查类型' };
    });

    // 8. 自定义命令
    // 按远端默认 shell 决定执行写法（见 detectRemoteShell）：
    //   cmd shell（OpenSSH 默认）→ 直接执行，不能再加 cmd /c，否则双重嵌套会使
    //     echo %SystemDrive% 输出 C:"（多引号），且 ver、set 等命令失败；
    //   powershell shell → cmd 语法命令必须包一层 cmd /c 才能工作。
    const customs = [];
    for (const c of normArray(server.custom_commands)) {
      const r = await sshExecRaw(conn, wrapCustomCommand(c.command, shellType), Math.min(perCmd, 20000));
      const out = decodeOutput(r.stdout);
      customs.push({
        name: c.name,
        output: out.length > 2000 ? out.slice(0, 2000) + '...(已截断)' : out,
        code: (r.code === null || r.code === undefined || r.code === -1) ? 1 : r.code
      });
    }

    // 9. 网络吞吐 / 磁盘 IO / 事件日志错误（best-effort，PowerShell 被 EDR 拦截时降级为空）
    let extraNet = [];
    let extraDiskio = [];
    let extraLogErrors = null;
    let extraLogWarns = null;
    try {
      const exScript = '$ErrorActionPreference=Continue\n' + extraPsSnippet() +
        '\n[PSCustomObject]@{net=$net;diskio=$diskio;log_errors=$log_errors;log_warns=$log_warns}|ConvertTo-Json -Depth 5 -Compress';
      const exPr = await runPsScript(conn, exScript, Math.max(15000, Math.floor(timeoutMs / 2)));
      const ex = exPr.data;
      if (ex) {
        extraNet = normArray(ex.net);
        extraDiskio = normArray(ex.diskio);
        extraLogErrors = num(ex.log_errors);
        extraLogWarns = num(ex.log_warns);
      }
    } catch (e) { /* 忽略，降级为空 */ }

    return normalize({
      hostname: o.CSName || server.host,
      os: o.Caption || '',
      kernel: o.Version || '',
      uptime_sec: uptimeSec,
      cpu_percent: cpuPct,
      cpu_cores: cores,
      proc_count: procCount,
      mem_total_mb: Math.round(totalKb / 1024),
      mem_used_mb: Math.round((totalKb - freeKb) / 1024),
      disks, services, customs,
      net: extraNet,
      diskio: extraDiskio,
      log_errors: extraLogErrors,
      log_warns: extraLogWarns
    });
  } catch (e) {
    return { ok: false, error: friendlySshError(e) };
  } finally {
    if (conn) { try { conn.end(); } catch (e) { /* 忽略 */ } }
  }
}

function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    execFile('powershell.exe', args, {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      env: process.env
    }, (err, stdout, stderr) => {
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** 把 PowerShell 返回的 JSON 整理为统一结构 */
function normalize(d) {
  const total = num(d.mem_total_mb);
  const used = num(d.mem_used_mb);
  return {
    ok: true,
    metrics: {
      hostname: d.hostname || '',
      os: d.os || '',
      kernel: d.kernel || '',
      uptime_sec: num(d.uptime_sec),
      cores: num(d.cpu_cores),
      load1: null, load5: null, load15: null,
      cpu_percent: num(d.cpu_percent),
      mem_total_mb: total,
      mem_used_mb: used,
      mem_percent: (total && total > 0) ? round1(used * 100 / total) : null,
      swap_total_mb: null,
      swap_used_mb: null,
      procs: num(d.proc_count),
      zombies: null,
      disks: normArray(d.disks),
      net: normArray(d.net),
      diskio: normArray(d.diskio),
      log_errors: num(d.log_errors),
      log_warns: num(d.log_warns)
    },
    services: normArray(d.services).map((s) => ({
      name: s.name, type: s.type, running: !!s.running, detail: s.detail || ''
    })),
    customs: normArray(d.customs).map((c) => ({
      name: c.name, output: c.output || '', code: num(c.code) || 0
    }))
  };
}

/** 采集入口 */
async function collectWindows(server, timeoutMs) {
  try {
    const auth = server.auth || {};
    if (auth.type === 'local') {
      const script = buildScript(server);
      const r = await runPowerShell(script, timeoutMs + 20000);
      const data = extractJson(r.stdout);
      if (!data || data.hostname === undefined) {
        const msg = r.stderr.trim().split(/\r?\n/).slice(0, 3).join(' ') || '未知错误（无输出）';
        return { ok: false, error: '本地执行失败: ' + msg };
      }
      return normalize(data);
    }
    if (auth.type === 'wmi') {
      return await collectWmi(server, timeoutMs);
    }
    if (!server.port) server = Object.assign({}, server, { port: 22 });
    return await collectRemote(server, timeoutMs);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** WMI（DCOM）远程采集：域环境下目标机无需任何配置 */
async function collectWmi(server, timeoutMs) {
  const auth = server.auth || {};
  const req = JSON.stringify({
    host: server.host,
    username: auth.username || '',
    password: auth.password || '',
    timeout_ms: timeoutMs,
    services: normArray(server.services).map((s) => ({ type: s.type, name: String(s.name) }))
  });
  // 合并后采集层下沉到 src/inspection/lib/，经 paths.js 从部署根解析
  const tool = require('../paths').wmiQueryExe();
  if (!fs.existsSync(tool)) {
    return { ok: false, error: '未找到 WMI 采集工具（wmitools/WmiQuery.exe）' };
  }
  const r = await new Promise((resolve) => {
    const child = execFile(tool, [], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs + 15000,
      windowsHide: true,
      env: process.env
    }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    // WmiQuery.exe 从 stdin 读取 JSON 请求，必须显式写入，否则子进程会一直等待输入直至超时
    try {
      child.stdin.setEncoding('utf8');
      child.stdin.write(req);
      child.stdin.end();
    } catch (e) {
      // stdin 不可写（极少数情况），交由超时逻辑兜底，避免抛出未捕获异常
      try { child.stdin.end(); } catch (e2) { /* 忽略 */ }
    }
    child.stdin.on('error', () => { /* 忽略 EPIPE：子进程可能已提前退出 */ });
  });
  const data = extractJson(r.stdout);
  if (data && data.hostname !== undefined) return normalize(data);
  const msg = r.stderr.trim().split(/\r?\n/).filter(Boolean).slice(0, 3).join(' ') ||
    (r.err && r.err.message) || '未知错误（无输出）';
  return { ok: false, error: 'WMI 巡检失败: ' + msg };
}

module.exports = { collectWindows, normalize, buildScript, buildNoWmiScript, collectRemoteNoWmi, decodeStderr, decodeOutput, stripClixml, decodePwshJson, detectRemoteShell, wrapCustomCommand, diagnoseWmic };
