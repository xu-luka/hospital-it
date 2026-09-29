'use strict';
/**
 * 流量存储与突发判定离线自测
 *
 * 用法：
 *   node scripts/netstore-selftest.js
 *
 * 用临时库跑（环境变量 INSPECT_DB_FILE 指向系统临时目录），不碰生产 data/inspect.db。
 * 重点验证三件事：
 *   1) 基线用中位数，一次突发不会把基线抬上去（用平均值就会）；
 *   2) 不到绝对下限的低流量不告警（0.2 Mbps → 2 Mbps 是 10 倍，但不是事故）；
 *   3) 冷却期生效，同一端口不会连续重复告警。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDb = path.join(os.tmpdir(), 'netstore-selftest-' + Date.now() + '.db');
process.env.INSPECT_DB_FILE = tmpDb;

const ns = require(path.join(__dirname, '..', 'src', 'inspection', 'netstore'));

let pass = 0;
const fails = [];
function eq(tag, actual, expect) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  if (a === e) { pass++; console.log('  [OK]   ' + tag + ' = ' + a); }
  else { fails.push(tag + ' 期望 ' + e + '，实际 ' + a); console.log('  [FAIL] ' + tag + ' 期望 ' + e + '，实际 ' + a); }
}
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}

const DEV = { id: 7, name: '核心交换机-门诊楼', host: '10.0.0.2' };

/** 造一条端口采样行 */
function row(iface, inBps, outBps, ip, ipCount) {
  return {
    iface: iface, ifaceKey: iface.replace(/\//g, '_'),
    inBps: inBps, outBps: outBps, totalBps: inBps + outBps,
    ip: ip || '', ipCount: ipCount == null ? (ip ? 1 : 0) : ipCount,
    linkUp: true
  };
}

console.log('\n== 初始化 ==');
ok('init()', ns.init() === true);
eq('默认配置：间隔 300 秒', ns.getConfig().interval_sec, 300);
eq('默认配置：倍数 5', ns.getConfig().ratio, 5);
eq('默认配置：绝对下限 50 Mbps', ns.getConfig().min_bps, 50000000);

console.log('\n== 配置读写 ==');
const cr = ns.setConfig({ ratio: 8, min_bps: 100000000, 未知键: '应被忽略' });
eq('setConfig 只接受已知键', cr.updated, 2);
eq('ratio 已改为 8', ns.getConfig().ratio, 8);
ok('未知键未落库', ns.getConfig().未知键 === undefined);
ns.setConfig({ ratio: 5, min_bps: 50000000 }); // 还原

console.log('\n== 中位数不受单点污染 ==');
eq('median([1,2,3,4,5])', ns.median([1, 2, 3, 4, 5]), 3);
eq('median([1,2,3,4])', ns.median([1, 2, 3, 4]), 2.5);
eq('median([1,1,1,1,1000]) —— 一次突发抬不动中位数', ns.median([1, 1, 1, 1, 1000]), 1);
eq('median([])', ns.median([]), null);

console.log('\n== 采样写入（空闲口默认丢弃） ==');
const t0 = ns.now();
const w = ns.saveSamples({
  deviceId: DEV.id, device: DEV.name, host: DEV.host, at: t0,
  rows: [
    row('GE0/0/1', 1000000, 500000, '172.16.9.10'),
    row('GE0/0/2', 0, 0, ''),                        // 空闲 -> 丢弃
    Object.assign(row('GE0/0/3', 0, 0, ''), { linkUp: false }) // DOWN -> 丢弃
  ]
});
eq('只写入 1 条（空闲与 DOWN 被丢弃）', w.saved, 1);

console.log('\n== 冷启动：样本不足不告警 ==');
const cold = ns.detectBursts({
  deviceId: DEV.id, device: DEV.name, host: DEV.host,
  rows: [row('GE0/0/1', 900000000, 10000000, '172.16.9.10')]
});
eq('第 1 个样本不告警', cold.length, 0);

console.log('\n== 造 6 个历史样本（基线约 2 Mbps） ==');
const base = 2 * 1000 * 1000; // 2 Mbps
for (let i = 6; i >= 1; i--) {
  ns.saveSamples({
    deviceId: DEV.id, device: DEV.name, host: DEV.host,
    at: ns.agoText(i * 5),
    rows: [row('GE0/0/1', base * 0.6 + i * 1000, base * 0.4, '172.16.9.10')]
  });
}
const b = ns.baseline(DEV.id, 'GE0_0_1', 60);
ok('基线窗口内有样本', b.samples.length >= 5, '样本数 ' + b.samples.length);
ok('基线量级在 2 Mbps 附近', Math.abs(b.median - base) < base * 0.2, ns.fmtBps(b.median));

console.log('\n== 场景 1：基线 2 Mbps，突到 200 Mbps -> 应告警 ==');
const hot = ns.detectBursts({
  deviceId: DEV.id, device: DEV.name, host: DEV.host,
  rows: [row('GE0/0/1', 150 * 1000 * 1000, 50 * 1000 * 1000, '172.16.9.10')]
});
eq('判定出 1 条告警', hot.length, 1);
ok('主导方向为入站', hot[0] && hot[0].kind === 'in', hot[0] && hot[0].kind);
ok('倍数约 100 倍', hot[0] && hot[0].ratio >= 50, hot[0] && hot[0].ratio);
ok('告警文案含 IP', hot[0] && /172\.16\.9\.10/.test(hot[0].detail), hot[0] && hot[0].detail);

console.log('\n== 场景 2：低流量翻 10 倍但没到绝对下限 -> 不告警 ==');
ns.saveSamples({
  deviceId: DEV.id, device: DEV.name, host: DEV.host,
  at: ns.agoText(20), rows: [row('GE0/0/9', 100000, 100000, '172.16.9.30')]
});
for (let i = 5; i >= 1; i--) {
  ns.saveSamples({
    deviceId: DEV.id, device: DEV.name, host: DEV.host,
    at: ns.agoText(i * 5 + 20), rows: [row('GE0/0/9', 100000, 100000, '172.16.9.30')]
  });
}
const tiny = ns.detectBursts({
  deviceId: DEV.id, device: DEV.name, host: DEV.host,
  rows: [row('GE0/0/9', 1000000, 1000000, '172.16.9.30')] // 0.2M -> 2M，10 倍，但只有 2 Mbps
});
eq('未到 50 Mbps 绝对下限 -> 不告警', tiny.length, 0);

console.log('\n== 场景 3：多终端端口不归属 IP ==');
for (let i = 5; i >= 1; i--) {
  ns.saveSamples({
    deviceId: DEV.id, device: DEV.name, host: DEV.host,
    at: ns.agoText(i * 5), rows: [row('GE0/0/20', 1000000, 1000000, '', 2)]
  });
}
const multi = ns.detectBursts({
  deviceId: DEV.id, device: DEV.name, host: DEV.host,
  rows: [row('GE0/0/20', 400 * 1000 * 1000, 10 * 1000 * 1000, '', 2)]
});
eq('多终端端口仍会告警（是端口级突发）', multi.length, 1);
eq('但 ip 为空，不把总流量摊给某个 IP', multi[0] && multi[0].ip, '');
ok('文案说明是端口下有 2 个终端', multi[0] && /2 个终端/.test(multi[0].detail), multi[0] && multi[0].detail);

console.log('\n== 告警落库与冷却 ==');
const s1 = ns.saveAlerts({ alerts: hot.concat(multi) });
eq('首次落库 2 条', s1.saved, 2);
const s2 = ns.saveAlerts({ alerts: hot.concat(multi) });
eq('冷却期内重复告警被拦下', s2.saved, 0);
eq('冷却计数', s2.cooled, 2);
eq('未确认告警数', ns.listAlerts({ unack: true }).length, 2);

console.log('\n== 告警确认 ==');
const firstId = ns.listAlerts({ limit: 1 })[0].id;
eq('确认 1 条', ns.ackAlert(firstId, 'admin').changes, 1);
eq('剩余未确认 1 条', ns.listAlerts({ unack: true }).length, 1);
const ac = ns.ackAll('admin');
ok('全部确认', ac.changes >= 1, 'changes=' + ac.changes);
eq('未确认归零', ns.listAlerts({ unack: true }).length, 0);
ok('历史告警仍在（供复盘）', ns.listAlerts({}).length >= 2, ns.listAlerts({}).length + ' 条');

console.log('\n== 查询：TopN / 时序 ==');
const topIp = ns.topIp({ minutes: 120, limit: 10 });
ok('TopIP 有结果', topIp.length >= 1, topIp.length + ' 条');
ok('TopIP 只含精确到单终端的 IP', topIp.every((r) => !!r.ip), topIp.map((r) => r.ip).join(','));
const topPort = ns.topPort({ minutes: 120, limit: 10 });
ok('TopPort 含多终端端口', topPort.some((r) => r.ipCount === 2), topPort.length + ' 条');
const ser = ns.series(DEV.id, 'GE0_0_1', 120);
ok('单端口时序有点位', ser.length >= 6, ser.length + ' 点');
ok('时序按时间正序', ser.length < 2 || ser[0].at <= ser[ser.length - 1].at);

console.log('\n== 最新快照 ==');
const lt = ns.latest(DEV.id);
ok('有最新时间戳', !!lt.at, lt.at);
ok('最新快照有行', lt.rows.length >= 1, lt.rows.length + ' 行');
ok('行内带可读速率', lt.rows[0] && !!lt.rows[0].totalText, lt.rows[0] && lt.rows[0].totalText);

console.log('\n== 清理与统计 ==');
const cl = ns.cleanup(0); // days<1 会被夹到 1
ok('cleanup 可执行', cl.ok === true, 'deleted=' + cl.deleted);
const st = ns.stats();
ok('stats.ready', st.ready === true, 'samples=' + st.samples + ' alerts=' + st.alerts);

/* 收尾 */
try { fs.unlinkSync(tmpDb); } catch (e) { /* 忽略 */ }
try { fs.unlinkSync(tmpDb + '-wal'); } catch (e) { /* 忽略 */ }
try { fs.unlinkSync(tmpDb + '-shm'); } catch (e) { /* 忽略 */ }

console.log('\n----------------------------------------');
console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
if (fails.length) {
  for (const f of fails) console.log('  x ' + f);
  process.exit(1);
}
console.log('全部通过（临时库已清理）');
