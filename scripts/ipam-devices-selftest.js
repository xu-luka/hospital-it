'use strict';
/**
 * ipam-devices-selftest.js —— 【IP 管理】与【设备台账】（机房巡检纳管对象）联动自测
 *
 * 背景：用户报「设备台账的 IP 都应该关联上 IP 管理」。
 * 在此之前只并了【终端资产】（PC / 打印机 / 自助机），服务器与交换机虽然在
 * 设备台账里写着地址，分布图上却是空白、空闲地址里还会被推荐出去。
 *
 * 要钉住的是这几件事（都是「写错了界面照样能开、但数据会骗人」的类型）：
 *   ① host 的写法五花八门（带端口 / 带协议 / 带方括号 / 域名），只有真能解析出
 *      IPv4 的才算占用；域名不是地址，不能被当成 0.0.0.0 或乱解析
 *   ② 设备台账的地址算「已占用」：空闲地址不推荐、网段剩余数扣掉、分布图是已使用
 *   ③ **不写库**：ip_records 的条数一条都不变（否则终端改地址、删设备时会漂移）
 *   ④ 优先级 手工登记 > 终端资产 > 设备台账：同一个地址只出一行、只扣一次
 *   ⑤ 停用的设备仍然占着地址（设备还在台账里 = 地址没释放）；软删除（is_deleted=1）才释放
 *   ⑥ 手工登记一个设备台账里也有的地址 → 不拦，但返回一句提醒（两处都要维护）
 *
 * 为什么用真库（dev 的 data/*.db）而不是临时库：
 *   net_segments / it_devices 都在 contract.db，路径是 config 里硬编码的，没法指到临时目录。
 *   所以脚本自己造数据、跑完自己删干净（try/finally），网段用 10.99.40.0/28 这种
 *   一眼看得出是测试的地址，万一没删干净也不会撞上真实网段。
 */
const path = require('path');
process.chdir(path.resolve(__dirname, '..'));

const { init } = require('../src/db');
const ipam = require('../src/ipam');
const term = require('../src/terminals');
const { db } = require('../src/db-contract');

init();

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); }
  else { fail++; console.log('  [FAIL] ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra))); }
}
function eq(name, a, b) { ok(name + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), a); }

const SEG_CIDR = '10.99.40.0/28';
const D_IP1 = '10.99.40.2';
const D_IP2 = '10.99.40.3';
const D_IP3 = '10.99.40.4';
const D_IP4 = '10.99.40.5';
const D_IP5 = '10.99.40.6';     // 停用但没删
const D_IP6 = '10.99.40.9';     // 与终端资产同址
const D_IP7 = '10.99.40.10';    // 与手工登记同址
const D_IP_DEL = '10.99.40.11'; // 软删除

let segId = 0;
const madeDevices = [];
const madeTerms = [];

/** 造一台巡检设备。名字统一 ZT- 前缀，清理时按前缀兜底删。 */
function mkDevice(patch) {
  const row = Object.assign({
    name: 'ZT-测试设备', host: '10.99.40.2', os: 'linux', port: 22,
    location: '测试机房', enabled: 1, remark: '',
  }, patch);
  const info = db.prepare(
    `INSERT INTO it_devices(name, host, os, port, location, enabled, remark)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(row.name, row.host, row.os, row.port, row.location, row.enabled, row.remark);
  const id = Number(info.lastInsertRowid);
  madeDevices.push(id);
  return id;
}

function cleanup() {
  try {
    madeDevices.forEach((id) => {
      try { db.prepare('DELETE FROM it_devices WHERE id = ?').run(id); } catch (e) { /* 忽略 */ }
    });
    // 兜底：万一中途 id 没记上
    db.prepare("DELETE FROM it_devices WHERE name LIKE 'ZT-%'").run();
  } catch (e) { /* 忽略 */ }
  try {
    madeTerms.forEach((id) => { try { term.remove(id); } catch (e) { /* 忽略 */ } });
    db.prepare("DELETE FROM terminals WHERE hostname LIKE 'ZT-%'").run();
  } catch (e) { /* 忽略 */ }
  try {
    if (segId) {
      db.prepare('DELETE FROM ip_records WHERE segment_id = ?').run(segId);
      db.prepare('DELETE FROM net_segments WHERE id = ?').run(segId);
    }
    db.prepare('DELETE FROM net_segments WHERE cidr = ?').run(SEG_CIDR);
  } catch (e) { /* 忽略 */ }
}

try {
  /* ==================== ① host 解析 ==================== */
  console.log('\n① host 的写法（设备台账的 host 是连接串，不是纯地址）');
  eq('纯 IP', ipam.parseHostIp('10.99.40.2'), '10.99.40.2');
  eq('带端口', ipam.parseHostIp('10.99.40.2:22'), '10.99.40.2');
  eq('带协议 + 端口 + 路径', ipam.parseHostIp('https://10.99.40.2:8443/status'), '10.99.40.2');
  eq('方括号写法', ipam.parseHostIp('[10.99.40.2]:22'), '10.99.40.2');
  eq('前后空格', ipam.parseHostIp('  10.99.40.2  '), '10.99.40.2');
  eq('域名不是地址（不能占地址）', ipam.parseHostIp('his-test.local'), '');
  eq('八位组越界的不能当地址', ipam.parseHostIp('10.99.40.999'), '');
  eq('空值', ipam.parseHostIp(''), '');
  eq('只有端口', ipam.parseHostIp(':22'), '');

  /* ==================== ② 造数据 ==================== */
  console.log('\n② 造一个测试网段与几台设备');
  const seg = ipam.createSegment({ name: 'ZT测试网段', cidr: SEG_CIDR, gateway: '10.99.40.1' });
  ok('网段创建成功', seg.ok, seg);
  segId = seg.id;

  const beforeIps = db.prepare('SELECT COUNT(*) c FROM ip_records').get().c;

  mkDevice({ name: 'ZT-HIS应用服务器', host: D_IP1, os: 'windows', port: 5985, location: '机房A03' });
  mkDevice({ name: 'ZT-核心交换机', host: D_IP2 + ':22', os: 'switch', port: 22, location: '弱电间' });
  mkDevice({ name: 'ZT-PACS影像服务器', host: 'https://' + D_IP3 + ':443/', os: 'linux', port: 443 });
  mkDevice({ name: 'ZT-虚拟化ESXi', host: '[' + D_IP4 + ']:22', os: 'esxi', port: 443 });
  mkDevice({ name: 'ZT-停用备份机', host: D_IP5, os: 'linux', port: 22, enabled: 0, remark: '已停用' });
  mkDevice({ name: 'ZT-域名设备', host: 'zt-db.local', os: 'database', port: 3306 });
  const delId = mkDevice({ name: 'ZT-已删设备', host: D_IP_DEL, os: 'linux', port: 22 });
  db.prepare('UPDATE it_devices SET is_deleted = 1 WHERE id = ?').run(delId);

  const list = ipam.deviceIps();
  const mine = list.filter((d) => d.ip.indexOf('10.99.40.') === 0);
  eq('落在这个网段的设备数', mine.length, 5);
  ok('域名设备没有进清单', !list.some((d) => d.name === 'ZT-域名设备'));
  ok('软删除的设备没有进清单', !list.some((d) => d.name === 'ZT-已删设备'));
  eq('os 有中文名', mine.filter((d) => d.ip === D_IP2)[0].os_label, '网络交换机');

  /* ==================== ③ 列表与「不写库」 ==================== */
  console.log('\n③ IP 登记列表：出现在列表里，但不写库');
  const rq = ipam.listIps({ segment_id: segId, source: 'device', pageSize: 50 });
  eq('来源=设备台账的条数', rq.total, 5);
  eq('返回体里的 device_total', rq.device_total, 5);
  ok('id 用字符串 d<id>（不能与 ip_records 的数值 id 撞）',
    rq.list.every((r) => typeof r.id === 'string' && r.id.charAt(0) === 'd'));
  ok('每行都带 dev（前端「查看台账」要用）', rq.list.every((r) => r.dev && r.dev.id));
  eq('停用的设备仍算占用，备注里标出来',
    rq.list.filter((r) => r.ip === D_IP5)[0].note.indexOf('已停用') >= 0, true);
  eq('ip_records 条数没有变化（只读合并）',
    db.prepare('SELECT COUNT(*) c FROM ip_records').get().c, beforeIps);

  /* ==================== ④ 算作占用 ==================== */
  console.log('\n④ 这些地址算「已占用」：空闲地址 / 剩余数 / 分布图');
  const free = ipam.freeIpsOfSegment(segId, 50);
  ok('空闲地址里没有设备占着的地址',
    !free.ips.some((ip) => [D_IP1, D_IP2, D_IP3, D_IP4, D_IP5].indexOf(ip) >= 0), free.ips);
  eq('device 数', free.device, 5);
  eq('device_only 数', free.device_only, 5);
  eq('剩余数 = 14 - 5', free.free_count, 9);

  const map = ipam.segmentMap(segId);
  const cell = (ip) => map.cells.filter((c) => c.ip === ip)[0];
  eq('分布图：HIS 服务器那格是已使用', cell(D_IP1).state, 'used');
  eq('分布图：该格标记为 device', cell(D_IP1).device, true);
  ok('分布图：悬停提示里点出设备名', cell(D_IP1).tip.indexOf('ZT-HIS应用服务器') >= 0, cell(D_IP1).tip);
  ok('分布图：悬停提示里带机房位置', cell(D_IP1).tip.indexOf('机房A03') >= 0, cell(D_IP1).tip);
  eq('分布图：域名设备不占格子（.7 仍是空闲）', cell('10.99.40.7').state, 'free');

  const segRow = ipam.listSegments().list.filter((s) => s.id === segId)[0];
  eq('网段表：device', segRow.device, 5);
  eq('网段表：device_only', segRow.device_only, 5);
  eq('网段表：剩余数', segRow.free_count, 9);

  /* ==================== ⑤ 优先级：手工 > 终端 > 设备 ==================== */
  console.log('\n⑤ 同一个地址：手工登记 / 终端资产 / 设备台账 只出一行、只扣一次');
  // 手工登记（设备台账里也有一台，故意撞）
  const manual = ipam.createIp({ segment_id: segId, ip: D_IP7, hostname: 'ZT-手工登记', status: 'used' });
  ok('手工登记成功', manual.ok, manual);
  mkDevice({ name: 'ZT-与手工同址', host: D_IP7, os: 'linux', port: 22 });
  const afterManual = ipam.listIps({ segment_id: segId, source: 'all', pageSize: 100 });
  eq('同一地址只出一行', afterManual.list.filter((r) => r.ip === D_IP7).length, 1);
  eq('这一行是手工登记（手工优先）',
    afterManual.list.filter((r) => r.ip === D_IP7)[0].source, 'manual');

  // 终端资产与设备台账撞同一个地址
  const t = term.create({
    hostname: 'ZT-PC-同址', ip: D_IP6, department: '测试科', location: '测试楼',
    stat_category: '台式计算机',
  }, { id: 1, name: 'selftest' });
  ok('终端创建成功', !!t && !!t.id, t);
  if (t && t.id) madeTerms.push(t.id);
  mkDevice({ name: 'ZT-与终端同址', host: D_IP6, os: 'linux', port: 22 });
  const afterTerm = ipam.listIps({ segment_id: segId, source: 'all', pageSize: 100 });
  eq('终端与设备同址时只出一行', afterTerm.list.filter((r) => r.ip === D_IP6).length, 1);
  eq('这一行是终端资产（终端优先于设备）',
    afterTerm.list.filter((r) => r.ip === D_IP6)[0].source, 'terminal');

  // 剩余数不能被扣两遍：.7 手工登记 + 设备占、.9 终端 + 设备占
  const free2 = ipam.freeIpsOfSegment(segId, 50);
  eq('剩余数仍然只扣一次（14 - 5 - 1 - 1）', free2.free_count, 7);

  /* ==================== ⑥ 手工登记设备台账里的地址：不拦，但提醒 ==================== */
  console.log('\n⑥ 手工登记一个设备台账里也有的地址');
  const dup = ipam.createIp({ segment_id: segId, ip: D_IP1, hostname: 'ZT-重复登记', status: 'used' });
  ok('不拦（设备台账不是登记表，用户可能有补充信息）', dup.ok, dup);
  ok('但返回提醒，并说清是哪台设备',
    String(dup.warn || '').indexOf('ZT-HIS应用服务器') >= 0, dup.warn);
  ok('device_owner 一并返回', !!(dup.device_owner && dup.device_owner.name), dup.device_owner);
  if (dup.ok) db.prepare('DELETE FROM ip_records WHERE id = ?').run(dup.id);

  /* ==================== ⑦ 关键词 ==================== */
  console.log('\n⑦ 搜索能按设备名 / 类型 / 位置找到');
  const kw1 = ipam.listIps({ segment_id: segId, source: 'device', keyword: '核心交换机' });
  eq('按设备名搜到 1 条', kw1.total, 1);
  eq('搜到的是 .3', kw1.list[0].ip, D_IP2);
  const kw2 = ipam.listIps({ segment_id: segId, source: 'device', keyword: '弱电间' });
  eq('按位置搜到 1 条', kw2.total, 1);
  const kw3 = ipam.listIps({ segment_id: segId, keyword: D_IP3 });
  ok('按地址搜也能搜到（合并模式）',
    kw3.list.some((r) => r.ip === D_IP3 && r.source === 'device'));

  /* ==================== ⑧ 删设备即释放 ==================== */
  console.log('\n⑧ 设备删了 / 地址改了就立刻跟着变（没有副本）');
  const dev2 = db.prepare('SELECT id FROM it_devices WHERE name = ?').get('ZT-核心交换机');
  db.prepare('UPDATE it_devices SET host = ? WHERE id = ?').run('10.99.40.13', dev2.id);
  const map2 = ipam.segmentMap(segId);
  eq('旧地址 .3 释放回空闲',
    map2.cells.filter((c) => c.ip === D_IP2)[0].state, 'free');
  eq('新地址 .13 变成已使用',
    map2.cells.filter((c) => c.ip === '10.99.40.13')[0].state, 'used');
  db.prepare('DELETE FROM it_devices WHERE id = ?').run(dev2.id);
  eq('删掉设备后新地址也释放',
    ipam.segmentMap(segId).cells.filter((c) => c.ip === '10.99.40.13')[0].state, 'free');
} catch (e) {
  fail++;
  console.log('  [FAIL] 抛出异常：' + ((e && e.stack) || e));
} finally {
  cleanup();
}

console.log('\n========================================');
console.log('ipam-devices-selftest：通过 ' + pass + ' / 失败 ' + fail);
console.log('========================================');
process.exit(fail ? 1 : 0);
