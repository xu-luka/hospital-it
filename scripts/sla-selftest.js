'use strict';
/**
 * 工单超期（SLA）自测
 *
 * 为什么必须自测：超期判定全是边界 —— 正好到截止点、已解决但没关闭、
 * 时间字段为空、跨天跨时区。这些在页面上肉眼根本看不出来（一条工单显示
 * 「超期 0.1 小时」和「剩 0.1 小时」长得一样），但结论完全相反。
 * 所以这里把「现在」钉死成一个固定时刻，用相对时间造数据逐个断言。
 *
 * 纯函数测试，不碰数据库、不依赖系统当前时间。
 *
 * 用法: node scripts/sla-selftest.js
 */

const path = require('path');
const ROOT = path.join(__dirname, '..');
const sla = require(path.join(ROOT, 'src', 'issue-sla'));

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
  else { fails.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}

// 固定的「现在」：2026-10-30 12:00:00 本地时间
const NOW = new Date(2026, 9, 30, 12, 0, 0).getTime();
const H = 3600 * 1000;

/** 相对 NOW 往前推 h 小时的本地时间字符串（与 SQLite datetime('now','localtime') 同格式） */
function ago(h) {
  const d = new Date(NOW - h * H);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

console.log('\n=== 1. 时间字符串解析（不能依赖引擎的“实现相关格式”）===');
{
  const t = sla.parseLocalTime('2026-10-30 12:00:00');
  ok('空格分隔的本地时间按本地解析', t === NOW, new Date(t).toString());
  const t2 = sla.parseLocalTime('2026-10-30');
  ok('纯日期按当天 00:00', t2 === new Date(2026, 9, 30, 0, 0, 0).getTime());
  const t3 = sla.parseLocalTime('2026-10-30T04:00:00.000Z');
  ok('带时区的 ISO 串按内置解析', t3 === Date.UTC(2026, 9, 30, 4, 0, 0));
  ok('空串 → null', sla.parseLocalTime('') === null);
  ok('null → null', sla.parseLocalTime(null) === null);
  ok('非法串 → null', sla.parseLocalTime('昨天下午') === null);
  ok('数字时间戳原样返回', sla.parseLocalTime(123456789) === 123456789);
}

console.log('\n=== 2. 时限表 ===');
{
  ok('紧急 = 4 小时', sla.slaHoursOf('紧急') === 4, sla.slaHoursOf('紧急'));
  ok('高 = 24 小时', sla.slaHoursOf('高') === 24);
  ok('中 = 72 小时', sla.slaHoursOf('中') === 72);
  ok('低 = 120 小时', sla.slaHoursOf('低') === 120);
  ok('认不出的紧急度按「中」兜底', sla.slaHoursOf('特急') === 72, sla.slaHoursOf('特急'));
  ok('空紧急度也兜底', sla.slaHoursOf('') === 72);
  ok('可被外部覆盖', sla.slaHoursOf('高', { '高': 8 }) === 8);
  ok('覆盖值非法（0/负数）被忽略', sla.slaHoursOf('高', { '高': 0 }) === 24);
}

console.log('\n=== 3. 单条判定 ===');
{
  // 中优先级 72 小时
  const at73 = sla.slaStateOf({ urgency: '中', status: 'pending', created_at: ago(73) }, NOW);
  ok('超 1 小时 → overdue', at73.state === 'overdue', at73.state_text);
  ok('超期时长约 1 小时', Math.abs(at73.overdue_hours - 1) < 0.05, at73.overdue_hours);

  const at72 = sla.slaStateOf({ urgency: '中', status: 'pending', created_at: ago(72) }, NOW);
  ok('正好到截止点不算超期（diff=0）', at72.state !== 'overdue', at72.state_text);

  const at60 = sla.slaStateOf({ urgency: '中', status: 'processing', created_at: ago(60) }, NOW);
  ok('剩 12 小时：72 的 1/4 是 18 小时 → 预警', at60.state === 'warning', at60.state_text);
  ok('预警时 overdue_hours 必须为 0', at60.overdue_hours === 0);

  const at20 = sla.slaStateOf({ urgency: '中', status: 'pending', created_at: ago(20) }, NOW);
  ok('剩 52 小时 → 正常', at20.state === 'ok', at20.state_text);

  // 高优先级 24 小时：预警阈值 min(6,24)=6
  const u19 = sla.slaStateOf({ urgency: '高', status: 'pending', created_at: ago(19) }, NOW);
  ok('高优先级剩 5 小时 → 预警', u19.state === 'warning', u19.state_text);
  const u10 = sla.slaStateOf({ urgency: '高', status: 'pending', created_at: ago(10) }, NOW);
  ok('高优先级剩 14 小时 → 正常', u10.state === 'ok', u10.state_text);

  // 低优先级 120 小时：1/4 是 30，但封顶 24 → 剩 25 小时应为正常
  const l95 = sla.slaStateOf({ urgency: '低', status: 'pending', created_at: ago(95) }, NOW);
  ok('低优先级剩 25 小时 → 正常（预警封顶 24 小时）', l95.state === 'ok', l95.state_text);
  const l100 = sla.slaStateOf({ urgency: '低', status: 'pending', created_at: ago(100) }, NOW);
  ok('低优先级剩 20 小时 → 预警', l100.state === 'warning', l100.state_text);

  // 已完成
  const doneOk = sla.slaStateOf({ urgency: '中', status: 'closed', created_at: ago(100), closed_at: ago(90) }, NOW);
  ok('按时关闭 → done', doneOk.state === 'done', doneOk.state_text);
  const doneLate = sla.slaStateOf({ urgency: '中', status: 'closed', created_at: ago(200), closed_at: ago(100) }, NOW);
  ok('超时关闭 → done_late', doneLate.state === 'done_late', doneLate.state_text);
  ok('超时关闭给出超期时长', Math.abs(doneLate.overdue_hours - (100 - 72)) < 0.05, doneLate.overdue_hours);

  const resolved = sla.slaStateOf({ urgency: '中', status: 'resolved', created_at: ago(200) }, NOW);
  ok('已解决但未关闭 → 不再计时（done）', resolved.state === 'done', resolved.state_text);

  // 时间缺失
  const noTime = sla.slaStateOf({ urgency: '中', status: 'pending' }, NOW);
  ok('没有任何时间字段 → unknown（不误判成超期）', noTime.state === 'unknown', noTime.state_text);

  // report_time 优先于 created_at
  const withReport = sla.slaStateOf({
    urgency: '中', status: 'pending', report_time: ago(80), created_at: ago(1),
  }, NOW);
  ok('report_time 优先（报障时间更早 → 已超期）', withReport.state === 'overdue', withReport.state_text);
}

console.log('\n=== 4. fmtHours ===');
{
  ok('0.5 小时 → 分钟', sla.fmtHours(0.5) === '30 分钟', sla.fmtHours(0.5));
  ok('3 小时', sla.fmtHours(3) === '3 小时', sla.fmtHours(3));
  ok('72 小时 → 天', sla.fmtHours(72) === '3 天', sla.fmtHours(72));
}

console.log('\n=== 5. 汇总统计 ===');
{
  const rows = [
    // 未完成且超期（中，80h → 超 8h）
    { id: 1, no: 'A-1', title: '超期一条', status: 'pending', urgency: '中', assignee_name: '张三', created_at: ago(80) },
    // 未完成且正常
    { id: 2, no: 'A-2', title: '正常一条', status: 'processing', urgency: '中', assignee_name: '李四', created_at: ago(5) },
    // 未指派且超期（紧急，10h → 超 6h）
    { id: 3, no: 'A-3', title: '紧急超期', status: 'pending', urgency: '紧急', assignee_name: '', created_at: ago(10) },
    // 按时关闭（中，20h → 关闭于 19h 前）
    { id: 4, no: 'A-4', title: '按时完成', status: 'closed', urgency: '中', assignee_name: '张三', created_at: ago(20), closed_at: ago(1) },
    // 超时关闭（高，30h → 关闭于 2h 前，SLA 24h）
    { id: 5, no: 'A-5', title: '超时完成', status: 'closed', urgency: '高', assignee_name: '张三', created_at: ago(30), closed_at: ago(2) },
  ];
  const s = sla.summarize(rows, NOW);

  ok('总数 5', s.total === 5, s.total);
  ok('未完成 3 条', s.open === 3, s.open);
  ok('已完成 2 条', s.done === 2, s.done);
  ok('超期 2 条', s.overdue === 2, s.overdue);
  ok('超时完成 1 条', s.done_late === 1, s.done_late);
  ok('按时完成率 = 1/2 = 50%', s.on_time_rate === 50, s.on_time_rate);
  ok('最大超期时长取最久那条（中优先级 80h → 超 8h）', Math.abs(s.max_overdue_hours - 8) < 0.05, s.max_overdue_hours);
  ok('TOP 超期按超期时长降序', s.top_overdue[0].overdue_hours >= s.top_overdue[1].overdue_hours, s.top_overdue.map((x) => x.overdue_hours));
  ok('TOP 超期里包含超时完成的工单', s.top_overdue.some((x) => x.no === 'A-5'), s.top_overdue.map((x) => x.no));
  ok('按处理人统计：未指派单独一档', s.by_assignee.some((a) => a.name === '未指派' && a.overdue === 1), s.by_assignee);
  ok('按处理人：张三压着 1 条超期', s.by_assignee.some((a) => a.name === '张三' && a.overdue === 1), s.by_assignee);
  ok('按紧急度分档齐全（4 档）', s.by_urgency.length === 4, s.by_urgency.map((u) => u.urgency));
  ok('平均关闭周期 ≈ (19+28)/2 = 23.5 小时', Math.abs(s.avg_close_hours - 23.5) < 0.2, s.avg_close_hours);

  const empty = sla.summarize([], NOW);
  ok('空数据不报错', empty.total === 0 && empty.overdue === 0);
  ok('空数据时按时完成率为 null（不是 0）', empty.on_time_rate === null, empty.on_time_rate);
}

console.log('\n=== 6. SQL 超期条件 ===');
{
  const od = sla.overdueSql();
  ok('生成 CASE 表达式', /CASE i\.urgency/.test(od.sql));
  ok('参数个数 = 紧急度档数 + 兜底 1', od.params.length === Object.keys(sla.DEFAULT_SLA_HOURS).length + 1, od.params.length);
  ok('不含未转义的单引号注入面（参数化）', od.sql.indexOf("'紧急'") >= 0);
  ok('只统计未完成工单的条件存在', sla.OPEN_STATUS_SQL.indexOf('NOT IN') >= 0);
}

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('全部通过');
process.exit(0);
