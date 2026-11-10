'use strict';
/**
 * P3 阈值告警离线自测。
 * 规则库与事件库都通过 alerts.useDb() 指向临时 SQLite，不碰 data/ 下任何真实库。
 * 重点验：全局+按设备覆盖、连续 N 轮、冷却、恢复、升级重确认、坏输入拒绝。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const A = require('../src/inspection/alerts');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error('FAIL  ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.error('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'his-alert-'));
const c = new DatabaseSync(path.join(tmp, 'contract.db'));
const h = new DatabaseSync(path.join(tmp, 'inspect.db'));

function dev(id, name, metrics) {
  return { deviceId: id, name: name, host: '10.0.0.' + id, os: 'windows',
    ok: true, status: 'normal', metrics: metrics, extra: {}, reasons: [] };
}

try {
  A.useDb(c, h);
  ok('ensure 成功', A.ensure());
  const st0 = A.status();
  ok('规则库与事件库都就绪', st0.ready && st0.eventsReady, st0);

  /* ---------- ① 默认规则 ---------- */
  const rules = A.listRules();
  eq('默认 9 条规则', rules.length, A.DEFAULT_RULES.length);
  ok('默认规则全是全局', rules.every((r) => r.device_id === 0));
  ok('默认规则含 textfile 存活位', rules.some((r) => r.metric_key === 'tf.his_collector_up'));
  ok('默认规则含数据年龄（age_seconds）', rules.some((r) => r.mode === 'age_seconds'));
  ok('JOIN it_devices 失败也能读规则（离线库没该表）', rules.length === 9);

  /* ---------- ② 纯函数：规则选取与判级 ---------- */
  const g = rules.find((r) => r.metric_key === 'cpu_percent');
  const override = Object.assign({}, g, { id: 9001, device_id: 1, warn: 50, crit: 60 });
  const picked1 = A.pickRules([g, override], 1);
  const picked2 = A.pickRules([g, override], 2);
  eq('设备 1 用覆盖值', picked1.find((r) => r.metric_key === 'cpu_percent').warn, 50);
  eq('设备 2 退回全局值', picked2.find((r) => r.metric_key === 'cpu_percent').warn, 70);
  eq('停用规则不生效', A.pickRules([Object.assign({}, g, { enabled: 0 })], 1).length, 0);
  eq('up 方向：低于警告线', A.levelOf(69, g), 'normal');
  eq('up 方向：等于警告线', A.levelOf(70, g), 'warning');
  eq('up 方向：等于严重线', A.levelOf(90, g), 'critical');
  const up = rules.find((r) => r.metric_key === 'tf.his_collector_up');
  eq('down 方向：正常值 1 不告警（严格小于）', A.levelOf(1, up), 'normal');
  eq('down 方向：0 判严重', A.levelOf(0, up), 'critical');
  const cert = rules.find((r) => r.metric_key === 'tf.his_cert_days_left');
  eq('down 方向：证书 26 天判警告', A.levelOf(26, cert), 'warning');
  eq('down 方向：证书 6 天判严重', A.levelOf(6, cert), 'critical');
  eq('age_seconds 换算', A.valueOf({ tf: 1000 }, { metric_key: 'tf', mode: 'age_seconds' }, 1300000), 300);
  eq('普通模式原值返回', A.valueOf({ a: 42 }, { metric_key: 'a' }, 0), 42);
  eq('缺失指标返回 null', A.valueOf({}, { metric_key: 'a' }, 0), null);

  /* ---------- ③ 纯函数：连续 N 轮 / 冷却 / 恢复 ---------- */
  const T0 = Date.parse('2026-11-10T09:00:00+08:00');
  const hot = [dev(1, 'HIS-DB-01', { cpu_percent: 95 })];
  const e1 = A.evaluateRound(hot, rules, {}, {}, T0);
  eq('第 1 轮只累计不告警', e1.decisions[0].action, 'none');
  eq('第 1 轮 hits=1', e1.nextStates[g.id + ':1'].hits, 1);
  const s1 = e1.nextStates;
  const e2 = A.evaluateRound(hot, rules, s1, {}, T0 + 60000);
  eq('第 2 轮触发 open', e2.decisions[0].action, 'open');
  eq('第 2 轮判严重', e2.decisions[0].level, 'critical');
  ok('消息里带设备名与阈值', e2.decisions[0].message.includes('HIS-DB-01') && e2.decisions[0].message.includes('90'));
  const s2 = e2.nextStates;
  const open = {};
  open[g.id + ':1'] = { id: 77, status: 'open', level: 'critical' };
  const e3 = A.evaluateRound(hot, rules, s2, open, T0 + 2 * 60000);
  eq('冷却期内不重复告警', e3.decisions[0].action, 'none');
  ok('冷却原因可读', String(e3.decisions[0].reason).includes('冷却'));
  const e4 = A.evaluateRound([dev(1, 'HIS-DB-01', { cpu_percent: 30 })], rules, s2, open, T0 + 3 * 60000);
  eq('指标恢复正常 -> resolve', e4.decisions[0].action, 'resolve');
  eq('恢复后连续计数归零', e4.nextStates[g.id + ':1'].hits, 0);
  const e5 = A.evaluateRound([dev(1, 'X', { cpu_percent: 95 })], rules, {}, {}, T0);
  eq('采集失败的机器不评估', A.evaluateRound(
    [Object.assign(dev(1, 'X', { cpu_percent: 95 }), { ok: false })], rules, {}, {}, T0).decisions.length, 0);
  eq('没有该指标的设备不评估', A.evaluateRound([dev(1, 'X', {})], rules, {}, {}, T0).decisions.length, 0);
  ok('无 deviceId 的结果跳过', A.evaluateRound([{ ok: true, name: 'X', metrics: { cpu_percent: 99 } }], rules, {}, {}, T0).decisions.length === 0);

  /* ---------- ④ 落库：applyRound 全流程 ---------- */
  const a1 = A.applyRound(hot, T0);
  ok('第 1 轮落库成功', a1.ok, a1);
  eq('第 1 轮不产生事件', a1.opened, 0);
  const a2 = A.applyRound(hot, T0 + 60000);
  ok('第 2 轮落库成功', a2.ok, a2);
  eq('第 2 轮新增 1 条事件', a2.opened, 1);
  const evs = A.listEvents({ status: 'unresolved' });
  eq('未恢复事件 1 条', evs.items.length, 1);
  eq('事件等级', evs.items[0].level, 'critical');
  eq('事件规则关联', evs.items[0].rule_id, g.id);
  const sum = A.summary();
  eq('summary 未恢复', sum.open, 1);
  eq('summary 未确认', sum.unacked, 1);
  eq('summary 严重数', sum.critical, 1);
  const a3 = A.applyRound(hot, T0 + 2 * 60000);
  eq('冷却轮不新增事件', a3.opened, 0);
  const evId = A.listEvents({}).items[0].id;
  ok('确认成功', A.ackEvent(evId, { username: 'admin' }, '已处理').ok);
  eq('确认后未确认数归零', A.summary().unacked, 0);
  ok('重复确认已确认事件不报错', A.ackEvent(evId, { username: 'admin' }).ok);
  const a4 = A.applyRound([dev(1, 'HIS-DB-01', { cpu_percent: 30 })], T0 + 3 * 60000);
  eq('恢复 1 条事件', a4.resolved, 1);
  eq('恢复后未恢复 0 条', A.listEvents({ status: 'unresolved' }).items.length, 0);
  eq('resolved 列表可查', A.listEvents({ status: 'resolved' }).items.length, 1);

  /* ---------- ⑤ 按设备覆盖真实生效 ---------- */
  const add = A.upsertRule({
    metric_key: 'cpu_percent', device_id: 1, label: 'CPU 使用率', unit: '%',
    direction: 'up', warn: 50, crit: 60, consecutive: 1, cooldown_min: 0, enabled: 1
  }, { id: 1 });
  ok('新增覆盖规则成功', add.ok, add);
  eq('规则数 +1', A.listRules().length, 10);
  const two = [dev(1, 'HIS-DB-01', { cpu_percent: 55 }), dev(2, 'APP-02', { cpu_percent: 55 })];
  const ov = A.evaluateRound(two, A.listRules(), {}, {}, T0 + 10 * 60000);
  const fired = ov.decisions.filter((d) => d.action === 'open');
  eq('只有设备 1 触发（覆盖值 50）', fired.length, 1, fired.map((d) => d.device.deviceId));
  eq('触发的是设备 1', fired[0] && fired[0].device.deviceId, 1);
  eq('连续 1 轮即触发', fired[0] && fired[0].hits, 1);
  ok('设备 2 仍按全局 70 判正常', !ov.decisions.some((d) => d.device.deviceId === 2 && d.action === 'open'));

  /* ---------- ⑥ 坏输入与删除保护 ---------- */
  ok('严重线比警告线宽松被拒', !A.upsertRule({ metric_key: 'cpu_percent', warn: 90, crit: 70, direction: 'up' }, {}).ok);
  ok('非数字阈值被拒', !A.upsertRule({ metric_key: 'cpu_percent', warn: 'abc', crit: 90 }, {}).ok);
  ok('缺 metric_key 被拒', !A.upsertRule({ warn: 1, crit: 2 }, {}).ok);
  ok('全局规则不能删', !A.deleteRule(g.id).ok);
  ok('覆盖规则可以删', A.deleteRule(add.id).ok);
  eq('删完回到 9 条', A.listRules().length, 9);

  /* ---------- ⑦ 降级：事件库不可用不拖垮规则 ---------- */
  A.useDb(c, null);
  ok('重新 ensure 成功', A.ensure());
  ok('规则仍可读', A.listRules().length === 9);
  eq('事件接口降级为空', A.listEvents({}).items.length, 0);
} catch (e) {
  fail++;
  console.error('FAIL  未捕获异常：' + (e && e.stack || e));
} finally {
  A.useDb(null, null);
  try { c.close(); h.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('alert-selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
