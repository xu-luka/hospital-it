'use strict';
/**
 * 流量监控后端接口端到端自测
 *
 * 用法：
 *   node scripts/netflow-api-e2e.js        （默认临时端口 3999）
 *   PORT=4567 node scripts/netflow-api-e2e.js
 *
 * 做了什么：
 *   1) 用临时流量库起一个真实的 Express 服务（不碰 data/inspect.db）；
 *   2) 直接签发一个 id=1 的 JWT，绕开登录页；
 *   3) 往流量库灌一批假采样与告警，逐个打真实 HTTP 接口，校验返回结构。
 *
 * 为什么灌假数据而不连真交换机：这里要验证的是「路由 → 存储 → 序列化」这条链路，
 * 不是设备可达性。设备侧由 scripts/netflow-selftest.js 用真实输出样本覆盖。
 * 全部为虚构数据：10.99.x 网段、测试交换机名。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP_DB = path.join(os.tmpdir(), 'netflow-e2e-' + Date.now() + '.db');

process.env.INSPECT_DB_FILE = TMP_DB;
process.env.PORT = process.env.PORT || '3999';

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}
function eq(tag, a, b) {
  const x = JSON.stringify(a);
  const y = JSON.stringify(b);
  if (x === y) { pass++; console.log('  [OK]   ' + tag + ' = ' + x); }
  else { fails.push(tag + ' 期望 ' + y + '，实际 ' + x); console.log('  [FAIL] ' + tag + ' 期望 ' + y + '，实际 ' + x); }
}

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const store = require(path.join(ROOT, 'src', 'inspection', 'netstore'));

  require(path.join(ROOT, 'server'));
  getSecret();
  const token = signJwt({ id: 1, username: 'e2e', role_id: 1 }, 3600);
  const base = 'http://127.0.0.1:' + process.env.PORT;

  async function call(method, url, body) {
    const opt = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opt);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json: json };
  }

  // 等服务起来
  for (let i = 0; i < 50; i++) {
    try { await fetch(base + '/api/inspection/netflow/status'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  console.log('\n== 灌入假采样（虚构设备） ==');
  const DEV = { id: 9901, name: '测试交换机-门诊楼', host: '10.99.0.2' };
  const ports = [
    { iface: 'GigabitEthernet0/0/1', ip: '10.99.9.10', n: 1 },
    { iface: 'GigabitEthernet0/0/2', ip: '10.99.9.11', n: 1 },
    { iface: 'GigabitEthernet0/0/3', ip: '', n: 3 }
  ];
  for (let i = 12; i >= 1; i--) {
    const at = store.agoText(i * 5);
    const rows = ports.map((p, idx) => ({
      iface: p.iface, ifaceKey: p.iface.toLowerCase().replace(/-/g, ''),
      ip: p.ip, ipCount: p.n, linkUp: true,
      inBps: 1000000 * (idx + 1), outBps: 500000 * (idx + 1),
      totalBps: 1500000 * (idx + 1)
    }));
    store.saveSamples({ deviceId: DEV.id, device: DEV.name, host: DEV.host, rows: rows, at: at });
  }
  // 最新一轮：0/0/1 突然冲到 800 Mbps
  store.saveSamples({
    deviceId: DEV.id, device: DEV.name, host: DEV.host,
    rows: [{
      iface: 'GigabitEthernet0/0/1', ifaceKey: 'gigabitethernet0/0/1',
      ip: '10.99.9.10', ipCount: 1, linkUp: true,
      inBps: 600000000, outBps: 200000000, totalBps: 800000000
    }]
  });
  const st0 = store.stats();
  ok('采样已入库', st0.samples >= 30, st0.samples + ' 条');

  const alerts = store.detectBursts({
    deviceId: DEV.id, device: DEV.name, host: DEV.host,
    rows: [{
      iface: 'GigabitEthernet0/0/1', ifaceKey: 'gigabitethernet0/0/1',
      ip: '10.99.9.10', ipCount: 1, linkUp: true,
      inBps: 600000000, outBps: 200000000, totalBps: 800000000
    }]
  });
  ok('判定出突发', alerts.length === 1, alerts.length + ' 条');
  store.saveAlerts({ alerts: alerts });

  console.log('\n== GET /netflow/status ==');
  let r = await call('GET', '/api/inspection/netflow/status');
  eq('status 200', r.status, 200);
  eq('code 0', r.json && r.json.code, 0);
  ok('含 config', !!(r.json && r.json.data && r.json.data.config), JSON.stringify(r.json.data.config.interval_sec));
  ok('含 store 统计', !!(r.json && r.json.data && r.json.data.store), 'samples=' + (r.json.data.store.samples));

  console.log('\n== GET /netflow/devices ==');
  r = await call('GET', '/api/inspection/netflow/devices');
  eq('code 0', r.json && r.json.code, 0);
  ok('返回数组', Array.isArray(r.json.data.items), (r.json.data.items || []).length + ' 台');
  ok('只含交换机', (r.json.data.items || []).every((d) => !d.os || d.os === 'switch'));

  console.log('\n== 采集范围（不参与流量采集的设备） ==');
  // 台账
  // 设备台账在 contract.db 里，而 config.CONTRACT_DB_FILE 是硬编码的、
  // 不认环境变量 —— 没法给它造一个临时库，往开发库里插数据更不行。
  // 所以这里用「替换模块导出」的办法喂假台账：路由拿到的是 module 对象本身，
  // 改它上面的 listRows 就够了，测完必须还原，否则会污染后面的用例。
  const deviceRepo = require(path.join(ROOT, 'src', 'inspection', 'device-repo'));
  const realListRows = deviceRepo.listRows;
  const fwId = 902;   // 假台账里那台「360 防火墙」
  deviceRepo.listRows = () => ([
    { id: 901, name: '测试交换机-门诊楼', host: '10.99.0.2', os: 'switch', location: '', remark: '' },
    { id: fwId, name: '360防火墙-边界', host: '10.99.0.9', os: 'switch', location: '边界', remark: '' }
  ]);

  r = await call('GET', '/api/inspection/netflow/devices');
  eq('台账里两台交换机', ((r.json.data && r.json.data.items) || []).length, 2);
  const dv = (r.json.data && r.json.data.items) || [];
  ok('设备都带 enabled 字段', dv.length > 0 && dv.every((d) => typeof d.enabled === 'boolean'),
    dv.map((d) => d.name + '=' + d.enabled).join(','));
  ok('默认全都参与采集', dv.every((d) => d.enabled === true));

  r = await call('GET', '/api/inspection/netflow/excludes');
  eq('code 0', r.json && r.json.code, 0);
  ok('初始名单为空', Array.isArray(r.json.data.ids) && !r.json.data.ids.length, JSON.stringify(r.json.data.ids));

  // 把防火墙那台摘出去 —— 这正是本次要解决的问题
  r = await call('PUT', '/api/inspection/netflow/excludes', { ids: [fwId, fwId, 'bad', 0] });
  eq('保存成功', r.json && r.json.code, 0);
  ok('去重并过滤脏值', JSON.stringify(r.json.data.ids) === '[' + fwId + ']', JSON.stringify(r.json.data.ids));

  r = await call('GET', '/api/inspection/netflow/devices');
  const dv2 = (r.json.data && r.json.data.items) || [];
  ok('防火墙那台 enabled=false', dv2.some((d) => d.id === fwId && d.enabled === false));
  ok('其余仍为 true', dv2.some((d) => d.id !== fwId && d.enabled === true));
  ok('回显 excludes', (r.json.data.excludes || []).indexOf(fwId) >= 0, JSON.stringify(r.json.data.excludes));

  r = await call('PUT', '/api/inspection/netflow/excludes', { ids: 'not-an-array' });
  eq('非数组返回 400', r.json && r.json.code, 400);
  await call('PUT', '/api/inspection/netflow/excludes', { ids: [] });
  deviceRepo.listRows = realListRows;   // 还原，别影响后面的用例
  r = await call('GET', '/api/inspection/netflow/excludes');
  ok('可清空', ((r.json.data && r.json.data.ids) || []).length === 0);

  console.log('\n== GET /netflow/top ==');
  r = await call('GET', '/api/inspection/netflow/top?type=ip&minutes=120&limit=10');
  eq('code 0', r.json && r.json.code, 0);
  const ipTop = (r.json.data && r.json.data.items) || [];
  ok('按 IP 有结果', ipTop.length >= 2, ipTop.map((x) => x.ip).join(','));
  ok('按 IP 不含多终端端口', ipTop.every((x) => !!x.ip));
  ok('第一行是突发那个 IP', ipTop[0] && ipTop[0].ip === '10.99.9.10', ipTop[0] && ipTop[0].peakText);

  r = await call('GET', '/api/inspection/netflow/top?type=port&minutes=120&limit=10');
  const portTop = (r.json.data && r.json.data.items) || [];
  ok('按端口有结果', portTop.length >= 3, portTop.length + ' 条');
  ok('按端口含多终端端口', portTop.some((x) => x.ipCount === 3));

  console.log('\n== GET /netflow/latest ==');
  r = await call('GET', '/api/inspection/netflow/latest?deviceId=' + DEV.id + '&limit=50');
  eq('code 0', r.json && r.json.code, 0);
  const latest = (r.json.data && r.json.data.items) || [];
  ok('返回最新一轮', latest.length === 1, latest.length + ' 行 @ ' + r.json.data.at);
  ok('速率已格式化', latest[0] && latest[0].totalText === '800.00 Mbps', latest[0] && latest[0].totalText);

  console.log('\n== GET /netflow/series ==');
  r = await call('GET', '/api/inspection/netflow/series?deviceId=' + DEV.id
    + '&iface=' + encodeURIComponent('GigabitEthernet0/0/1') + '&minutes=120');
  eq('code 0', r.json && r.json.code, 0);
  const ser = (r.json.data && r.json.data.items) || [];
  ok('时序有点位', ser.length >= 12, ser.length + ' 点');
  eq('端口名被归一', r.json.data.ifaceKey, 'gigabitethernet0/0/1');
  r = await call('GET', '/api/inspection/netflow/series?deviceId=1');
  eq('缺参数返回 400', r.json && r.json.code, 400);

  console.log('\n== GET /netflow/trend（大屏用·全网合计趋势） ==');
  r = await call('GET', '/api/inspection/netflow/trend?minutes=120');
  eq('code 0', r.json && r.json.code, 0);
  const tr = (r.json.data && r.json.data.items) || [];
  ok('有趋势点位', tr.length >= 13, tr.length + ' 点');
  ok('时间升序', tr.every((p, i) => i === 0 || String(tr[i - 1].at) <= String(p.at)));
  ok('每点带收发数值', tr.every((p) => typeof p.totalBps === 'number' && typeof p.inBps === 'number' && typeof p.outBps === 'number'));
  ok('合计 = 入 + 出', tr.every((p) => p.totalBps === p.inBps + p.outBps));
  ok('同刻多设备并成一点', tr[0] && tr[0].devices === 1, 'devices=' + (tr[0] && tr[0].devices));
  eq('minutes 回显', r.json.data.minutes, 120);
  // 最后一轮只灌了 0/0/1 一个端口：800M in+out -> 600M in + 200M out
  const lastPt = tr[tr.length - 1];
  ok('最新点对应最新一轮', lastPt && lastPt.totalBps === 800000000, lastPt && (lastPt.inBps + '/' + lastPt.outBps));
  ok('最新点入向 600M', lastPt && lastPt.inBps === 600000000, lastPt && lastPt.inBps);
  // 历史轮次每轮 3 个端口：(1+2+3)*1.5M = 9M
  ok('历史点合计 9M', tr.some((p) => p.totalBps === 9000000), tr.slice(0, 3).map((p) => p.totalBps).join(','));
  r = await call('GET', '/api/inspection/netflow/trend?minutes=abc');
  eq('非法 minutes 降级为默认', r.json && r.json.data.minutes, 60);
  r = await call('GET', '/api/inspection/netflow/trend?minutes=1');
  ok('短窗口不报错', r.status === 200 && Array.isArray(r.json.data.items), ((r.json.data.items) || []).length + ' 点');

  console.log('\n== GET /netflow/alerts ==');
  r = await call('GET', '/api/inspection/netflow/alerts?limit=50');
  eq('code 0', r.json && r.json.code, 0);
  const al = (r.json.data && r.json.data.items) || [];
  ok('有告警', al.length >= 1, al.length + ' 条');
  ok('告警含可读文案', al[0] && /10\.99\.9\.10/.test(al[0].detail), al[0] && al[0].peakText);
  const alertId = al[0] && al[0].id;

  console.log('\n== POST 确认告警 ==');
  r = await call('POST', '/api/inspection/netflow/alerts/' + alertId + '/ack', {});
  eq('确认成功', r.json && r.json.code, 0);
  r = await call('GET', '/api/inspection/netflow/alerts?unack=1&limit=50');
  eq('未确认已归零', ((r.json.data && r.json.data.items) || []).length, 0);

  console.log('\n== PUT /netflow/config ==');
  r = await call('PUT', '/api/inspection/netflow/config', { config: { ratio: 6, min_bps: 80000000, 非法键: 1 } });
  eq('保存成功', r.json && r.json.code, 0);
  eq('ratio 已生效', r.json.data.config.ratio, 6);
  eq('min_bps 已生效', r.json.data.config.min_bps, 80000000);
  ok('非法键被忽略', r.json.data.config.非法键 === undefined);
  await call('PUT', '/api/inspection/netflow/config', { config: { ratio: 5, min_bps: 50000000 } });

  console.log('\n== POST /netflow/run（无交换机时不应 500） ==');
  r = await call('POST', '/api/inspection/netflow/run', { deviceId: 0 });
  ok('不返回 500', r.status !== 500, 'status=' + r.status + ' code=' + (r.json && r.json.code));

  console.log('\n== 未认证访问 ==');
  const anon = await fetch(base + '/api/inspection/netflow/status');
  eq('未带 token 返回 401', anon.status, 401);

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch (e) { /* 忽略 */ }
  }
  if (fails.length) {
    for (const f of fails) console.log('  x ' + f);
    process.exit(1);
  }
  console.log('全部通过（临时库已清理）');
  process.exit(0);
})().catch((e) => {
  console.error('E2E 异常：', e);
  process.exit(1);
});
