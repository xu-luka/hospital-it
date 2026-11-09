'use strict';
/**
 * 通道对比（compare.js）离线自测
 *
 * 对比这件事最容易出错的地方不是「算不算得对」，而是「判定分档是否合理」：
 * 把瞬时值差 12 个百分点判成「不一致」，运维看两次就不再相信这个功能；
 * 反过来放得太宽，切换后少一个盘也发现不了。
 * 所以这里的用例全围绕容差边界展开，每条都按同一台机器的真实形状造数据。
 *
 * 不连任何设备、不起服务：compare.js 是纯函数，这组用例跑完 1 秒内。
 */

const path = require('path');
const cmp = require(path.join(__dirname, '..', 'src', 'inspection', 'compare'));

let pass = 0;
const fails = [];
function ok(title, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + title + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra))); }
  else { fails.push(title); console.log('  [FAIL] ' + title + '  -> ' + JSON.stringify(extra)); }
}
function eq(title, a, b) { ok(title + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), a); }
function sec(t) { console.log('\n== ' + t); }

/** 一台典型 Windows 库服务器的采集结果（两条通道结构一致） */
function sample() {
  return {
    ok: true,
    metrics: {
      hostname: 'HIS-DB',
      uptime_sec: 7200,
      cores: 4,
      cpu_percent: 30,
      mem_total_mb: 8192,
      mem_percent: 50,
      disks: [
        { mount: 'C:', size_mb: 102400, use_percent: 60 },
        { mount: 'D:', size_mb: 204800, use_percent: 40 }
      ],
      net: [{ iface: 'Ethernet0' }, { iface: 'Ethernet1' }],
      log_errors: 3
    },
    services: [
      { name: 'Spooler', running: true },
      { name: 'sshd', running: false }
    ]
  };
}
function clone(o) { return JSON.parse(JSON.stringify(o)); }
function row(d, key) { return d.rows.filter((r) => r.key === key)[0] || {}; }

/* ---------------- 1. 快照归一化 ---------------- */

sec('1. 快照归一化');
{
  const s = cmp.snapshotOf({
    ok: true,
    metrics: { hostname: '  HIS-DB  ', cpu_percent: '30', mem_percent: 'abc', cores: null, disks: null, net: null },
    services: [{ name: '', running: true }, { name: 'Spooler', running: 1 }]
  });
  eq('hostname 去首尾空格', s.hostname, 'HIS-DB');
  eq('数字字符串转数字', s.cpu, 30);
  eq('非数字 -> null', s.memPct, null);
  eq('null 保持 null', s.cores, null);
  eq('缺 disks -> 空数组', s.disks, []);
  eq('缺 net -> 空数组', s.net, []);
  eq('空服务名被丢掉', s.services.length, 1);
  eq('running 转布尔', s.services[0].running, true);

  const bad = cmp.snapshotOf({ ok: false, error: '连不上' });
  eq('失败结果 ok', bad.ok, false);
  eq('失败结果带 error', bad.error, '连不上');
  eq('失败结果 hostname 为空串', bad.hostname, '');
}

/* ---------------- 2. 完全一致 ---------------- */

sec('2. 完全一致');
{
  const d = cmp.diffOf(sample(), sample(), { leftLabel: 'SSH 密码', rightLabel: 'exporter' });
  eq('总体判定', d.verdict, 'same');
  eq('不一致项 0', d.counts.diff, 0);
  eq('接近项 0', d.counts.close, 0);
  eq('计数之和 = 行数', d.counts.same + d.counts.close + d.counts.diff + d.counts.na, d.rows.length);
  ok('建议里写明「一致」', /数据一致/.test(d.tips.join(' ')), d.tips[0]);
  ok('建议里提醒别急着关 sshd', /sshd/.test(d.tips.join(' ')));
  ok('行 key 不重复（v-for 不能撞车）',
    new Set(d.rows.map((r) => r.key)).size === d.rows.length);
}

/* ---------------- 3. 主机名 ---------------- */

sec('3. 主机名');
{
  const b = clone(sample()); b.metrics.hostname = 'HIS-DB2';
  const d = cmp.diffOf(sample(), b, {});
  eq('主机名不同 -> diff', row(d, 'hostname').verdict, 'diff');
  eq('总体判定随之 diff', d.verdict, 'diff');
  ok('提示指向「可能连到了另一台机器」', /另一台机器/.test(row(d, 'hostname').note), row(d, 'hostname').note);

  const c = clone(sample()); c.metrics.hostname = 'his-db';
  eq('大小写不同不算差异', row(cmp.diffOf(sample(), c, {}), 'hostname').verdict, 'same');

  const e = clone(sample()); e.metrics.hostname = '';
  eq('一侧没有主机名 -> 不适用', row(cmp.diffOf(sample(), e, {}), 'hostname').verdict, 'na');
}

/* ---------------- 4. 运行时长 ---------------- */

sec('4. 运行时长（容差 3 分钟 / 15 分钟）');
{
  const mk = (gap) => { const b = clone(sample()); b.metrics.uptime_sec += gap; return cmp.diffOf(sample(), b, {}); };
  eq('差 60 秒 -> 一致', row(mk(60), 'uptime').verdict, 'same');
  eq('差 200 秒 -> 接近', row(mk(200), 'uptime').verdict, 'close');
  eq('差 1000 秒 -> 不一致', row(mk(1000), 'uptime').verdict, 'diff');
  ok('格式化：2 小时 0 分', /2 小时/.test(row(mk(0), 'uptime').a), row(mk(0), 'uptime').a);
  eq('一侧没有运行时长 -> 不适用',
    row(cmp.diffOf(sample(), Object.assign(clone(sample()), { metrics: Object.assign(clone(sample()).metrics, { uptime_sec: null }) }), {}), 'uptime').verdict,
    'na');
}

/* ---------------- 5. CPU ---------------- */

sec('5. CPU（容差 10 / 25 个百分点）');
{
  const mk = (v) => { const b = clone(sample()); b.metrics.cpu_percent = v; return cmp.diffOf(sample(), b, {}); };
  eq('差 5 -> 一致', row(mk(35), 'cpu').verdict, 'same');
  eq('差 15 -> 接近', row(mk(45), 'cpu').verdict, 'close');
  eq('差 40 -> 不一致', row(mk(70), 'cpu').verdict, 'diff');
  eq('核数差 1 -> 不一致', (function () { const b = clone(sample()); b.metrics.cores = 8; return row(cmp.diffOf(sample(), b, {}), 'cores').verdict; })(), 'diff');
  eq('exporter 没算 CPU（null）-> 不适用', (function () { const b = clone(sample()); b.metrics.cpu_percent = null; return row(cmp.diffOf(sample(), b, {}), 'cpu').verdict; })(), 'na');
}

/* ---------------- 6. 内存 ---------------- */

sec('6. 内存（总量 2% / 使用率 3、8 个百分点）');
{
  const mkPct = (v) => { const b = clone(sample()); b.metrics.mem_percent = v; return cmp.diffOf(sample(), b, {}); };
  eq('使用率差 2 -> 一致', row(mkPct(52), 'mem_pct').verdict, 'same');
  eq('使用率差 6 -> 接近', row(mkPct(56), 'mem_pct').verdict, 'close');
  eq('使用率差 20 -> 不一致', row(mkPct(70), 'mem_pct').verdict, 'diff');

  const m1 = clone(sample()); m1.metrics.mem_total_mb = 8250;  // 差 0.7%
  eq('总量差 0.7% -> 一致', row(cmp.diffOf(sample(), m1, {}), 'mem_total').verdict, 'same');
  const m2 = clone(sample()); m2.metrics.mem_total_mb = 16384; // 差一倍
  eq('总量差一倍 -> 不一致', row(cmp.diffOf(sample(), m2, {}), 'mem_total').verdict, 'diff');
}

/* ---------------- 7. 磁盘 ---------------- */

sec('7. 磁盘（按盘符求并集；使用率 2、5 个百分点）');
{
  const d0 = cmp.diffOf(sample(), sample(), {});
  eq('两个盘各两行', d0.rows.filter((r) => /^disk:/.test(r.key)).length, 4);
  eq('C 盘使用率一致', row(d0, 'disk:C::pct').verdict, 'same');

  const b = clone(sample());
  b.metrics.disks[0].use_percent = 63;   // 差 3
  eq('使用率差 3 -> 接近', row(cmp.diffOf(sample(), b, {}), 'disk:C::pct').verdict, 'close');
  b.metrics.disks[0].use_percent = 75;   // 差 15
  eq('使用率差 15 -> 不一致', row(cmp.diffOf(sample(), b, {}), 'disk:C::pct').verdict, 'diff');

  const c = clone(sample());
  c.metrics.disks[0].size_mb = 103936;  // 差 1.5%
  eq('容量差 1.5% -> 一致', row(cmp.diffOf(sample(), c, {}), 'disk:C::size').verdict, 'same');
  c.metrics.disks[0].size_mb = 204800;  // 差一倍
  eq('容量差一倍 -> 不一致', row(cmp.diffOf(sample(), c, {}), 'disk:C::size').verdict, 'diff');

  // exporter 少一个 D 盘：这是切换前最该发现的问题
  const e = clone(sample());
  e.metrics.disks = [e.metrics.disks[0]];
  const de = cmp.diffOf(sample(), e, {});
  eq('少一个盘 -> 使用率不适用', row(de, 'disk:D::pct').verdict, 'na');
  eq('少一个盘 -> 容量不适用', row(de, 'disk:D::size').verdict, 'na');
  ok('说明是「对比通道没有返回这个卷」', /对比通道没有返回这个卷/.test(row(de, 'disk:D::pct').note),
    row(de, 'disk:D::pct').note);
  eq('少一个盘不判成不一致（能力差异不是数据错误）', de.counts.diff, 0);

  const f = clone(sample()); f.metrics.disks = [];
  const g2 = clone(sample()); g2.metrics.disks = [];
  const df = cmp.diffOf(g2, f, {});
  ok('两侧都没磁盘时有兜底行', df.rows.some((r) => r.key === 'disk:none'), df.rows.map((r) => r.key));
}

/* ---------------- 8. 网卡 ---------------- */

sec('8. 网卡（只比清单，不比速率）');
{
  const b = clone(sample());
  b.metrics.net = [{ iface: 'Ethernet0' }];
  eq('少一张网卡 -> 不一致', row(cmp.diffOf(sample(), b, {}), 'net').verdict, 'diff');
  ok('说明里写清「速率不对比」', /速率不对比/.test(row(cmp.diffOf(sample(), b, {}), 'net').note));

  const c = clone(sample());
  c.metrics.net = [];
  eq('一侧没网卡 -> 不适用', row(cmp.diffOf(sample(), c, {}), 'net').verdict, 'na');
}

/* ---------------- 9. 服务 ---------------- */

sec('9. 服务（按名字求并集）');
{
  const b = clone(sample());
  b.services[0].running = false;
  const d = cmp.diffOf(sample(), b, {});
  eq('Spooler 状态不同 -> 不一致', row(d, 'svc:spooler').verdict, 'diff');
  ok('提示指向「服务名写错 / 收集器没开」', /服务名写错/.test(row(d, 'svc:spooler').note), row(d, 'svc:spooler').note);

  // exporter 没开 service 收集器：一个服务都查不到
  const e = clone(sample());
  e.services = [];
  const de = cmp.diffOf(sample(), e, {});
  eq('对比通道没有服务 -> 不适用', row(de, 'svc:spooler').verdict, 'na');
  ok('提示问「service 收集器是否启用」', /service 收集器/.test(row(de, 'svc:spooler').note), row(de, 'svc:spooler').note);
  eq('服务缺失不判成不一致', de.counts.diff, 0);

  // 服务名大小写不同不该算两台
  const f = clone(sample());
  f.services[0].name = 'SPOOLER';
  eq('服务名大小写不同仍能配上', row(cmp.diffOf(sample(), f, {}), 'svc:spooler').verdict, 'same');

  const g = clone(sample());
  g.services = [];
  const dg = cmp.diffOf(Object.assign(clone(sample()), { services: [] }), g, {});
  ok('两侧都没配服务时有兜底行', dg.rows.some((r) => r.key === 'svc:none'));
}

/* ---------------- 10. 事件日志 ---------------- */

sec('10. 事件日志错误数（exporter 天然拿不到）');
{
  const b = clone(sample());
  b.metrics.log_errors = null;
  const d = cmp.diffOf(sample(), b, {});
  eq('一侧为 null -> 不适用', row(d, 'log_errors').verdict, 'na');
  ok('说明是「只读指标端点没有这个能力」', /只读指标端点/.test(row(d, 'log_errors').note));

  const c = clone(sample()); c.metrics.log_errors = 8;
  eq('差 5 -> 一致', row(cmp.diffOf(sample(), c, {}), 'log_errors').verdict, 'same');
  const e = clone(sample()); e.metrics.log_errors = 15;
  eq('差 12 -> 接近', row(cmp.diffOf(sample(), e, {}), 'log_errors').verdict, 'close');
}

/* ---------------- 11. 一侧失败 ---------------- */

sec('11. 一侧采集失败');
{
  const bad = { ok: false, error: '拉取 http://10.0.0.5:9182/metrics 失败：ECONNREFUSED' };
  const d = cmp.diffOf(sample(), bad, { leftLabel: 'SSH 密码', rightLabel: 'exporter' });
  eq('总体判定 blocked', d.verdict, 'blocked');
  ok('建议里点名失败的一侧和原因', /exporter：拉取/.test(d.tips.join(' ')), d.tips[0]);
  ok('仍返回行（表格不至于空白）', d.rows.length > 0);

  const d2 = cmp.diffOf(bad, bad, {});
  eq('两侧都失败仍 blocked', d2.verdict, 'blocked');
  eq('snapshot 里 error 保留', d2.left.error.indexOf('ECONNREFUSED') >= 0, true);
}

/* ---------------- 12. 结论与建议的对应关系 ---------------- */

sec('12. 结论 / 建议');
{
  const b = clone(sample()); b.metrics.cpu_percent = 45;      // 接近
  const dc = cmp.diffOf(sample(), b, {});
  eq('只有接近项 -> close', dc.verdict, 'close');
  ok('close 的建议是「可以切换，但建议高峰再测一次」', /高峰期再对比一次/.test(dc.tips.join(' ')), dc.tips[0]);

  const c = clone(sample()); c.metrics.hostname = 'X'; c.metrics.cpu_percent = 90;
  const dd = cmp.diffOf(sample(), c, {});
  eq('有不一致项 -> diff', dd.verdict, 'diff');
  ok('diff 的建议点名了不一致项', /主机名/.test(dd.tips.join(' ')), dd.tips[0]);
  ok('diff 的建议明确「不要切换」', /不要切换/.test(dd.tips.join(' ')));
  ok('diff 的建议给到常见原因', /收集器没启用/.test(dd.tips.join(' ')));
}

/* ---------------- 13. 结构约束 ---------------- */

sec('13. 结构约束');
{
  const d = cmp.diffOf(sample(), sample(), {});
  d.rows.forEach((r) => {
    if (['same', 'close', 'diff', 'na'].indexOf(r.verdict) < 0) {
      ok('非法判定值 ' + r.verdict, false);
    }
  });
  ok('所有行的判定值合法', true);
  ok('每行都有 label / a / b', d.rows.every((r) => r.label && r.a !== undefined && r.b !== undefined));
  ok('label 是给人看的，没把内部 key 前缀带出来',
    d.rows.every((r) => r.label.indexOf('svc:') < 0 && r.label.indexOf('disk:') < 0));

  // 输入不被修改（路由里同一份 server 对象还会被别处用到）
  const a = sample(); const before = JSON.stringify(a);
  cmp.diffOf(a, sample(), {});
  eq('diffOf 不修改入参', JSON.stringify(a), before);
}

/* ---------------- 收尾 ---------------- */

console.log('\n────────────────────────');
console.log('compare-selftest：通过 ' + pass + '，失败 ' + fails.length);
if (fails.length) {
  fails.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
