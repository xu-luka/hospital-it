'use strict';
/**
 * 巡检通道对比 —— 同一台 Windows 设备，两条通道的数字并排核对
 *
 * 用途：把一台机器的采集从 SSH 切到 exporter 之前，先证明「新通道采到的数
 * 跟老通道是一样的」。没有这一步，切换就是在赌 —— 切完发现磁盘少一个盘、
 * 服务全被判成没在跑，问题要等到下一轮巡检（最坏 8 分钟）才暴露。
 *
 * 三条设计原则：
 *   1. 纯函数，不碰网络、不碰数据库。采集由调用方（路由）负责，这里只做
 *      「结果 → 快照 → 逐项差分」。这样才能在没有设备的环境里跑全分支自测。
 *   2. 判定分三档而不是「等/不等」：两侧采样窗口不同（SSH 一次 PowerShell 要
 *      两三秒，exporter 是隔 1 秒抓两次），CPU 相差几个百分点完全正常。
 *      一刀切判「不一致」会让用户不再相信这个功能。
 *   3. 一侧没有的指标判「不适用」，不判「不一致」。exporter 不出事件日志计数、
 *      没开 service 收集器就没有服务状态 —— 这是能力差异，不是数据错误。
 */

/**
 * 通道显示名。★ 不再自己维护一份映射 —— 曾经这里是「SSH 私钥」、
 *   inspect 里是「SSH 密钥」，同一个通道两个名字。统一走 common.connectLabelOf。
 *   对比功能只出现在 Windows 设备上，所以 os 固定传 windows。
 */
const { connectLabelOf: channelLabel } = require('./lib/common');
function channelLabelOf(t) { return channelLabel('windows', t || ''); }

/**
 * 判定容差。数值是「允许差多少还算一致」。
 * same = 一致，close = 接近（可接受），超过 close 判不一致。
 *
 * 定这套数的依据：CPU 是瞬时值，两侧采样窗口差几百毫秒到两秒，空载时差 1~2，
 * 满载抖动时差 10 也见过；内存是缓变的，差 3 个百分点以上通常是取数口径不同
 * （比如一边算 available 一边算 free）；磁盘几乎不变，差 2 个点就该查。
 */
const TOL = {
  cpu: { same: 10, close: 25 },
  mem: { same: 3, close: 8 },
  disk: { same: 2, close: 5 },
  uptime: { same: 180, close: 900 },
  memTotalRel: 0.02,
  diskSizeRel: 0.02
};

/* ---------------- 小工具 ---------------- */

/** 转数字：空值 / 非数字一律 null —— null 在判定里代表「该通道没这个数」 */
function num(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function fmtPct(v) {
  return v === null ? '—' : (Math.round(v * 10) / 10) + '%';
}

function fmtMb(v) {
  return v === null ? '—' : Math.round(v) + ' MB';
}

function fmtInt(v) {
  return v === null ? '—' : String(Math.round(v));
}

function fmtUptime(sec) {
  if (sec === null) return '—';
  const s = Math.max(0, Math.round(sec));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + ' 天 ' + h + ' 小时';
  if (h > 0) return h + ' 小时 ' + m + ' 分';
  return m + ' 分钟';
}

/** 绝对容差判定 */
function judgeAbs(a, b, tol) {
  if (a === null || b === null) return 'na';
  const d = Math.abs(a - b);
  if (d <= tol.same) return 'same';
  if (d <= tol.close) return 'close';
  return 'diff';
}

/** 相对容差判定（容量这类大数用它，差 1MB 不该报警） */
function judgeRel(a, b, rel) {
  if (a === null || b === null) return 'na';
  if (a === 0 && b === 0) return 'same';
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base <= rel ? 'same' : 'diff';
}

/* ---------------- 结果 → 快照 ---------------- */

/**
 * 把 collectWindows / collectExporter 的返回压成一张可比较的快照。
 * 两条通道结构一致（ok / metrics / services），所以这里不需要区分来源。
 */
function snapshotOf(r) {
  const res = r || {};
  const m = res.metrics || {};
  return {
    ok: !!res.ok,
    error: res.ok ? '' : String(res.error || '未知错误'),
    note: String(res.note || ''),
    hostname: String(m.hostname || '').trim(),
    uptime: num(m.uptime_sec),
    cores: num(m.cores),
    cpu: num(m.cpu_percent),
    memTotal: num(m.mem_total_mb),
    memPct: num(m.mem_percent),
    disks: (Array.isArray(m.disks) ? m.disks : []).map((d) => ({
      mount: String((d && d.mount) || ''),
      size: num(d && d.size_mb),
      pct: num(d && d.use_percent)
    })).filter((d) => d.mount),
    net: (Array.isArray(m.net) ? m.net : []).map((n) => String((n && n.iface) || '')).filter(Boolean),
    logErrors: num(m.log_errors),
    services: (Array.isArray(res.services) ? res.services : []).map((s) => ({
      name: String((s && s.name) || '').trim(),
      running: !!(s && s.running)
    })).filter((s) => s.name)
  };
}

/* ---------------- 差分 ---------------- */

/**
 * 逐项比较两张快照。
 *
 * @param {object} left  collectWindows 的原始结果（当前通道）
 * @param {object} right collectExporter 的原始结果（对比通道）
 * @param {object} [opts] { leftLabel, rightLabel }
 * @returns {{verdict, counts, rows, tips, left, right}}
 *   verdict: same | close | diff | blocked（有一侧没采到，无从对比）
 *   rows[].verdict: same | close | diff | na
 */
function diffOf(left, right, opts) {
  const o = opts || {};
  const A = snapshotOf(left);
  const B = snapshotOf(right);
  const rows = [];
  const push = (key, label, a, b, verdict, note) => {
    rows.push({ key: key, label: label, a: a, b: b, verdict: verdict, note: note || '' });
  };

  /* 主机名：不一致往往意味着「连到了另一台机器」，是最高价值的告警 */
  const ha = A.hostname.toLowerCase();
  const hb = B.hostname.toLowerCase();
  push('hostname', '主机名',
    A.hostname || '—', B.hostname || '—',
    (!ha || !hb) ? 'na' : (ha === hb ? 'same' : 'diff'),
    (ha && hb && ha !== hb) ? '两侧主机名不同：可能连到了另一台机器（检查地址/端口），或一台机有多个机器名' : '');

  push('uptime', '运行时长',
    fmtUptime(A.uptime), fmtUptime(B.uptime),
    judgeAbs(A.uptime, B.uptime, TOL.uptime),
    '两侧采样时刻不同，允许几分钟偏差');

  push('cores', 'CPU 核数',
    fmtInt(A.cores), fmtInt(B.cores),
    (A.cores === null || B.cores === null) ? 'na' : (A.cores === B.cores ? 'same' : 'diff'),
    '');

  push('cpu', 'CPU 使用率',
    fmtPct(A.cpu), fmtPct(B.cpu),
    judgeAbs(A.cpu, B.cpu, TOL.cpu),
    '容差 ±' + TOL.cpu.same + ' 个百分点（瞬时值，采样窗口不同）');

  push('mem_total', '内存总量',
    fmtMb(A.memTotal), fmtMb(B.memTotal),
    judgeRel(A.memTotal, B.memTotal, TOL.memTotalRel),
    '两侧都应读到物理内存总量，差超过 2% 说明取数口径不同');

  push('mem_pct', '内存使用率',
    fmtPct(A.memPct), fmtPct(B.memPct),
    judgeAbs(A.memPct, B.memPct, TOL.mem),
    '容差 ±' + TOL.mem.same + ' 个百分点');

  /* 磁盘：按盘符求并集。一侧少一个盘 = 真实差异（最典型的「拿不到 D 盘」） */
  const mounts = [];
  const seen = {};
  const addMount = (m) => { if (m && !seen[m]) { seen[m] = 1; mounts.push(m); } };
  A.disks.forEach((d) => addMount(d.mount));
  B.disks.forEach((d) => addMount(d.mount));
  mounts.sort();

  const diskA = {};
  const diskB = {};
  A.disks.forEach((d) => { diskA[d.mount] = d; });
  B.disks.forEach((d) => { diskB[d.mount] = d; });

  mounts.forEach((m) => {
    const da = diskA[m] || null;
    const db = diskB[m] || null;
    const onlyOne = !da || !db;
    const who = !da ? '当前通道' : '对比通道';

    push('disk:' + m + ':pct', '磁盘 ' + m + ' 使用率',
      da ? fmtPct(da.pct) : '—', db ? fmtPct(db.pct) : '—',
      onlyOne ? 'na' : judgeAbs(da.pct, db.pct, TOL.disk),
      onlyOne ? (who + '没有返回这个卷') : '');

    push('disk:' + m + ':size', '磁盘 ' + m + ' 容量',
      da ? fmtMb(da.size) : '—', db ? fmtMb(db.size) : '—',
      onlyOne ? 'na' : judgeRel(da.size, db.size, TOL.diskSizeRel),
      onlyOne ? (who + '没有返回这个卷') : '');
  });

  if (!mounts.length) {
    push('disk:none', '磁盘', '未采集到', '未采集到', 'na', '两侧都没有磁盘数据，检查采集权限或 logical_disk 收集器');
  }

  /* 网卡：只比清单。速率是区间值，两侧窗口不同，比了也只会是噪音 */
  const setA = A.net.map((x) => x.toLowerCase()).sort();
  const setB = B.net.map((x) => x.toLowerCase()).sort();
  const netSame = setA.length && setB.length && setA.join('|') === setB.join('|');
  push('net', '网卡清单',
    A.net.join(' / ') || '—', B.net.join(' / ') || '—',
    (!A.net.length || !B.net.length) ? 'na' : (netSame ? 'same' : 'diff'),
    '只比对网卡清单，速率不对比（两侧采样窗口不同，波动正常）');

  /* 服务：按名字求并集。这是切换前最该确认的一项 —— 服务名写错/收集器没开都在这暴露 */
  const svcMap = {};
  const svcOrder = [];
  const addSvc = (s, side) => {
    const k = s.name.toLowerCase();
    if (!svcMap[k]) { svcMap[k] = { name: s.name, left: null, right: null }; svcOrder.push(k); }
    svcMap[k][side] = s.running;
  };
  A.services.forEach((s) => addSvc(s, 'left'));
  B.services.forEach((s) => addSvc(s, 'right'));

  svcOrder.forEach((k) => {
    const it = svcMap[k];
    const hasL = it.left !== null;
    const hasR = it.right !== null;
    let v = 'na';
    let note = '';
    if (hasL && hasR) {
      v = it.left === it.right ? 'same' : 'diff';
      if (v === 'diff') note = '一侧在跑、一侧没在跑：先看是不是服务名写错，或该通道的 service 收集器没启用';
    } else if (!hasL) {
      note = '当前通道没有返回这个服务';
    } else {
      note = '对比通道没有返回这个服务（exporter 是否启用了 service 收集器？）';
    }
    const txt = (x) => (x === null ? '—' : (x ? '运行中' : '已停止'));
    push('svc:' + k, '服务 ' + it.name, txt(it.left), txt(it.right), v, note);
  });

  if (!svcOrder.length) {
    push('svc:none', '服务检查', '未配置', '未配置', 'na', '这台设备没有配置服务检查项，如需对比请先在台账里加上服务名');
  }

  /* 事件日志：exporter 天然拿不到，判「不适用」而不是「不一致」 */
  push('log_errors', '事件日志错误数',
    fmtInt(A.logErrors), fmtInt(B.logErrors),
    judgeAbs(A.logErrors, B.logErrors, { same: 5, close: 20 }),
    (A.logErrors === null || B.logErrors === null)
      ? '一侧不提供事件日志计数（exporter 是只读指标端点，没有这个能力）'
      : '');

  /* 计数与结论 */
  const counts = { same: 0, close: 0, diff: 0, na: 0 };
  rows.forEach((r) => { counts[r.verdict] = (counts[r.verdict] || 0) + 1; });

  let verdict = 'same';
  if (!A.ok || !B.ok) verdict = 'blocked';
  else if (counts.diff > 0) verdict = 'diff';
  else if (counts.close > 0) verdict = 'close';

  return {
    verdict: verdict,
    counts: counts,
    rows: rows,
    tips: adviceOf(verdict, counts, A, B, o, rows),
    left: A,
    right: B
  };
}

/** 按结论给出可执行的建议（不是「请检查」，而是「下一步做什么」） */
function adviceOf(verdict, counts, A, B, o, rows) {
  const ln = (o && o.leftLabel) || '当前通道';
  const rn = (o && o.rightLabel) || '对比通道';
  const tips = [];

  if (verdict === 'blocked') {
    const bad = [];
    if (!A.ok) bad.push(ln + '：' + (A.error || '采集失败'));
    if (!B.ok) bad.push(rn + '：' + (B.error || '采集失败'));
    tips.push('两侧都要能采到数才能对比，先修好失败的一侧 —— ' + bad.join('；'));
    return tips;
  }

  if (verdict === 'diff') {
    // 点名不一致的项（最多 4 条），省得用户自己在表里找
    const names = (rows || []).filter((r) => r.verdict === 'diff').map((r) => r.label);
    const brief = names.slice(0, 4).join('、') + (names.length > 4 ? ' 等 ' + names.length + ' 项' : '');
    tips.push('有 ' + counts.diff + ' 项不一致：' + brief + '。先看表格里标红的那几行，确认是哪一侧取数不对。');
    tips.push('最常见的原因：exporter 的收集器没启用（service / logical_disk）、服务名大小写或显示名不符、盘符映射方式不同。');
    tips.push('★ 在差异解释清楚之前不要切换认证方式 —— 切完巡检数据会静默变样。');
    return tips;
  }

  if (verdict === 'close') {
    tips.push('数值接近（差异都在容差内），可以切换；建议在业务高峰期再对比一次，确认高负载下也一致。');
    tips.push('切换步骤：台账里把认证方式改成「exporter 指标端点」→ 端口 9182 → 保存 → 下一轮巡检生效。');
    return tips;
  }

  tips.push('两条通道数据一致，可以按计划切换认证方式并退役 SSH。');
  tips.push('切换后先保留一段时间的 SSH 账号（别急着关 sshd），确认连续几轮巡检都正常再收回。');
  return tips;
}

module.exports = {
  channelLabelOf,
  TOL,
  snapshotOf,
  diffOf,
  // 导出给自测用
  _num: num,
  _judgeAbs: judgeAbs,
  _judgeRel: judgeRel,
  _fmtUptime: fmtUptime
};
