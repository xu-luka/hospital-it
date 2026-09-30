'use strict';
/**
 * netmon 调度层自测：采集范围（排除名单）是否真的生效
 *
 * 为什么要单独测这一层：netstore.setExcludes 能存能读、接口能改，都不等于
 * 「轮次里真的不再去连这台设备」。真正决定要不要发 SSH 请求的是 netmon.runOnce
 * 里那段过滤 —— 它错了，页面上的失败数还是会一直往上跳。
 *
 * 这层以前没有自测，是因为它依赖真实设备与真实 SSH。这里把 device-source（台账）
 * 与 netflow（采集）两个模块用假实现顶掉，只留下 netmon 自己的编排逻辑：
 * 谁被排除了、失败数算不算它、手动点名还能不能采。
 *
 * 用法: node scripts/netmon-exclude-selftest.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), 'netmon-exclude-' + Date.now() + '.db');
process.env.INSPECT_DB_FILE = TMP_DB;

const NETFLOW = require.resolve(path.join(ROOT, 'src', 'inspection', 'netflow'));
const DEVSOURCE = require.resolve(path.join(ROOT, 'src', 'inspection', 'device-source'));
const realNetflow = require(NETFLOW);
const realDevSource = require(DEVSOURCE);

/* ---------------- 假台账 ---------------- */

// 三台「交换机」：其中 902 是那台被登记成交换机的防火墙
const SERVERS = [
  { _device_id: 901, name: '门诊楼汇聚交换机', host: '10.99.0.2', os: 'switch' },
  { _device_id: 902, name: '360防火墙-边界', host: '10.99.0.9', os: 'switch' },
  { _device_id: 903, name: '住院楼汇聚交换机', host: '10.99.0.3', os: 'switch' }
];

require.cache[DEVSOURCE].exports = Object.assign({}, realDevSource, {
  load: async () => ({ servers: SERVERS })
});

/* ---------------- 假采集器 ---------------- */

let collected = [];   // 本轮实际去连的设备 id

require.cache[NETFLOW].exports = Object.assign({}, realNetflow, {
  collectNetflow: async (server) => {
    collected.push(Number(server._device_id));
    return {
      ok: true, style: 'display', vendor: '华为/H3C 风格', via: 'shell',
      ports: 2, arpCount: 1, macCount: 1,
      rows: [{
        iface: 'GigabitEthernet0/0/1', ifaceKey: 'gigabitethernet0/0/1',
        ip: '10.99.9.10', ipCount: 1, linkUp: true,
        inBps: 1000000, outBps: 500000, totalBps: 1500000
      }]
    };
  }
});

const netmon = require(path.join(ROOT, 'src', 'inspection', 'netmon'));
const store = require(path.join(ROOT, 'src', 'inspection', 'netstore'));

/* ---------------- 断言 ---------------- */

let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
  else { fails.push(name); console.log('  [FAIL] ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : '')); }
}
function eq(name, got, want) { ok(name, got === want, got); }

(async () => {
  console.log('netmon 采集范围自测（假台账 + 假采集器）');

  console.log('\n== 基线：没有排除名单时三台全采 ==');
  store.setExcludes([]);
  collected = [];
  let r = await netmon.runOnce({ force: true });
  eq('本轮成功', r.ok, true);
  eq('采了 3 台', collected.length, 3);
  eq('无一失败', r.summary.failed, 0);
  eq('跳过 0 台', r.summary.skipped, 0);
  eq('页面不再报错', netmon.status().lastError, null);

  console.log('\n== 把防火墙那台设为不参与采集 ==');
  store.setExcludes([902]);
  collected = [];
  r = await netmon.runOnce({ force: true });
  eq('只剩 2 台要采', r.summary.devices, 2);
  eq('实际连了 2 台', collected.length, 2);
  ok('防火墙没被连', collected.indexOf(902) < 0, collected);
  eq('失败数不含它', r.summary.failed, 0);
  eq('跳过计数为 1', r.summary.skipped, 1);
  const skipped = (r.summary.perDevice || []).filter((d) => d.skipped);
  eq('明细里有一条跳过', skipped.length, 1);
  eq('跳过的正是它', skipped[0] && skipped[0].deviceId, 902);
  ok('跳过原因写清楚巡检不受影响', /巡检不受影响/.test((skipped[0] && skipped[0].error) || ''),
    skipped[0] && skipped[0].error);
  eq('这一轮没有故障', netmon.status().lastError, null);

  console.log('\n== 手动点名：即使被排除也要允许试一次 ==');
  collected = [];
  r = await netmon.runOnce({ force: true, deviceId: 902 });
  eq('手动指定时不被名单挡住', collected.length, 1);
  eq('采的就是那台', collected[0], 902);
  eq('手动轮次不记跳过', r.summary.skipped, 0);

  console.log('\n== 全部排除：要给出能看懂的提示，而不是「没有可采集的交换机」 ==');
  store.setExcludes([901, 902, 903]);
  collected = [];
  r = await netmon.runOnce({ force: true });
  eq('跳过 3 台', r.summary.skipped, 3);
  ok('提示里点明可以重新勾选', /采集范围/.test(r.reason || ''), r.reason);
  ok('不再让人去台账加交换机', !/添加类型为/.test(r.reason || ''), r.reason);

  store.setExcludes([]);

  /* 收尾 */
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* 忽略 */ }
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('全部通过（临时库已清理）');
  process.exit(0);
})().catch((e) => {
  console.error('自测异常：', e);
  process.exit(1);
});
