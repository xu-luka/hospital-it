'use strict';
/**
 * ipam-terminals-selftest.js —— 【IP 管理】与【终端资产】联动（只读合并）自测
 *
 * 要钉住的是这几件事（都是「写错了界面照样能开、但数据会骗人」的类型）：
 *   ① 终端资产里有 IP 的设备，会出现在 IP 登记列表里，且不写库（ip_records 条数不变）
 *   ② 这些地址算进「已占用」：空闲地址列表里不会再推荐它、网段剩余数会扣掉、分布图是已使用
 *   ③ 终端改 IP / 删设备 / 改成报废，IP 管理这边立刻跟着变（因为压根没有副本）
 *   ④ 报废设备的地址不算占用（可以被手工登记），但仍会列出来
 *   ⑤ 手工登记与终端资产重复时：手工优先，只算一次，free_count 不被扣两遍
 *   ⑥ 想手工登记一个已被终端占用的地址 → 明确拒绝并说清是哪台设备
 *
 * 为什么用真库（dev 的 data/*.db）而不是临时库：
 *   ipam 的表在 contract.db、terminals 在 his.db，两个路径都是 config 里硬编码的，
 *   没法给它们指一个临时目录。所以脚本自己造数据、跑完自己删干净（带上 try/finally）。
 *   网段用 10.99.30.0/28 这种一眼看得出是测试的地址，删不干净也不会撞上真实网段。
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

const SEG_CIDR = '10.99.30.0/28';
const T_IP1 = '10.99.30.3';
const T_IP2 = '10.99.30.4';
const T_DEAD = '10.99.30.5';
const T_OUT = '10.99.31.3';

const madeTerms = [];
let segId = 0;

function mkTerm(name, ip, status, dept, loc) {
  const r = term.create({
    name, ip, status: status || '在用', kind: 'PC', department: dept || '测试科',
    location: loc || '测试楼1层', owner: '张三', mac: '', hostname: '',
  }, { id: 1, name: '自测' });
  if (!r.ok) throw new Error('造终端失败：' + r.error);
  madeTerms.push(r.id);
  return r.id;
}

function cleanup() {
  try {
    madeTerms.forEach((id) => term.remove(id));
  } catch (e) { /* 忽略 */ }
  try {
    if (segId) {
      db.prepare('DELETE FROM ip_records WHERE segment_id = ?').run(segId);
      db.prepare('DELETE FROM net_segments WHERE id = ?').run(segId);
    }
    // 兜底：万一中途换了 id
    db.prepare('DELETE FROM net_segments WHERE cidr = ?').run(SEG_CIDR);
  } catch (e) { /* 忽略 */ }
}

try {
  console.log('== 准备数据 ==');
  // 先把同名测试网段/设备清掉，避免上次中断留下的脏数据干扰
  try {
    const old = db.prepare('SELECT id FROM net_segments WHERE cidr = ?').get(SEG_CIDR);
    if (old) {
      db.prepare('DELETE FROM ip_records WHERE segment_id = ?').run(old.id);
      db.prepare('DELETE FROM net_segments WHERE id = ?').run(old.id);
    }
  } catch (e) { /* 忽略 */ }

  const s = ipam.createSegment({ name: '自测网段', cidr: SEG_CIDR, gateway: '10.99.30.1' });
  ok('建测试网段', s.ok, s.error || s.cidr);
  segId = s.id;

  mkTerm('自测-门诊3号诊室工作站', T_IP1, '在用', '门诊部', '门诊楼3层3诊室');
  mkTerm('自测-内科护士站打印机', T_IP2, '在用', '内科', '住院楼5层');
  mkTerm('自测-已报废投影', T_DEAD, '报废', '信息科', '库房');
  mkTerm('自测-网段外设备', T_OUT, '在用', '门诊部', '门诊楼1层');
  console.log('  造了 4 台终端（3 台在网段内，1 台报废，1 台在网段外共用 4 个对象）');

  const beforeCount = db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c;
  eq('起点：本网段手工登记 0 条', beforeCount, 0);

  /* ---------------- ① 列表合并 ---------------- */
  console.log('\n== ① 登记列表里能看到终端资产 ==');
  const all = ipam.listIps({ pageSize: 200, keyword: '自测' });
  const row1 = all.list.filter((r) => r.ip === T_IP1)[0];
  ok('列表里有终端资产那条', !!row1);
  ok('来源标成 terminal', row1 && row1.source === 'terminal', row1 && row1.source);
  ok('带设备名', row1 && row1.hostname === '自测-门诊3号诊室工作站', row1 && row1.hostname);
  ok('带科室/位置进备注', row1 && row1.note.indexOf('门诊部') >= 0 && row1.note.indexOf('门诊楼3层3诊室') >= 0, row1 && row1.note);
  ok('命中网段', row1 && Number(row1.segment_id) === segId, row1 && row1.segment_id);
  ok('id 是字符串 t<设备id>，与 ip_records 的数值 id 不会撞',
    row1 && typeof row1.id === 'string' && row1.id.charAt(0) === 't', row1 && row1.id);

  const onlyTerm = ipam.listIps({ source: 'terminal', pageSize: 200, keyword: '自测' });
  eq('source=terminal 只有终端记录', onlyTerm.list.every((r) => r.source === 'terminal'), true);
  // 关键词「自测」会命中 4 台（3 台在网段内 + 1 台在网段外）；报废的也算「终端记录」，只是不占地址
  eq('source=terminal 条数（4 台测试设备都带「自测」）', onlyTerm.total, 4);
  eq('source=manual 一条都没有', ipam.listIps({ source: 'manual', pageSize: 200, keyword: '自测' }).total, 0);

  eq('终端记录没写进 ip_records（这就是「不落库」的判据）',
    db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c, 0);

  const kwHit = ipam.listIps({ pageSize: 200, keyword: '护士站' });
  ok('关键词能按设备名搜到', kwHit.list.some((r) => r.ip === T_IP2));

  const segOnly = ipam.listIps({ segment_id: segId, pageSize: 200 });
  eq('按网段筛选：只出这个网段内的 3 台（网段外那台不算）', segOnly.total, 3);

  /* ---------------- ② 算进「已占用」 ---------------- */
  console.log('\n== ② 终端占的地址不能再被当成空闲 ==');
  const segs = ipam.listSegments();
  const one = segs.list.filter((x) => x.id === segId)[0];
  // ★ 口径：terminal 只数「算占用」的，报废那台不算（它的地址已经算释放）
  eq('网段统计：终端占用 2 台（报废那台不算）', one.terminal, 2);
  eq('其中未手工登记 2 个', one.terminal_only, 2);
  eq('剩余可用 = 14 - 2 = 12', one.free_count, 12);
  eq('汇总里的终端占用数不小于 2', segs.summary.terminal >= 2, true);

  const free = ipam.freeIpsOfSegment(segId, 100);
  ok('空闲地址里没有 10.99.30.3', free.ips.indexOf(T_IP1) < 0, free.ips.slice(0, 5));
  ok('空闲地址里没有 10.99.30.4', free.ips.indexOf(T_IP2) < 0);
  ok('空闲地址里【有】报废设备的 10.99.30.5（报废不算占用）', free.ips.indexOf(T_DEAD) >= 0);
  eq('终端占用计数', free.terminal, 2);
  eq('空闲 12 个', free.free_count, 12);

  const map = ipam.segmentMap(segId);
  const cell1 = map.cells.filter((c) => c.ip === T_IP1)[0];
  ok('分布图该格是「已使用」', cell1 && cell1.state === 'used', cell1 && cell1.state);
  ok('该格可点击（reg=true）', cell1 && cell1.reg === true);
  ok('该格标记 terminal', cell1 && cell1.terminal === true);
  ok('悬停提示里带设备名', cell1 && cell1.tip.indexOf('自测-门诊3号诊室工作站') >= 0, cell1 && cell1.tip);
  const cellFree = map.cells.filter((c) => c.ip === '10.99.30.7')[0];
  ok('没被占的格子仍是空闲', cellFree && cellFree.state === 'free', cellFree && cellFree.state);
  const cellDead = map.cells.filter((c) => c.ip === T_DEAD)[0];
  ok('报废设备的格子仍是空闲（不挡登记）', cellDead && cellDead.state === 'free', cellDead && cellDead.state);

  /* ---------------- ③ 手工登记撞车 ---------------- */
  console.log('\n== ③ 想手工登记一个已被终端占用的地址 ==');
  const dup = ipam.createIp({ segment_id: segId, ip: T_IP1 });
  ok('被拒绝', dup.ok === false, dup.error);
  ok('提示里点名是哪台设备', (dup.error || '').indexOf('自测-门诊3号诊室工作站') >= 0, dup.error);
  ok('提示指向终端资产改 IP', (dup.error || '').indexOf('终端资产') >= 0);
  eq('仍然没写库', db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c, 0);

  const deadOk = ipam.createIp({ segment_id: segId, ip: T_DEAD, hostname: '手工登记-旧投影' });
  ok('报废设备的地址可以手工登记', deadOk.ok === true, deadOk.error);
  const deadRecId = deadOk.id;

  /* ---------------- ④ 同一个地址两边都有时都显示、只算一次 ---------------- */
  console.log('\n== ④ 同一个地址两边都有时都显示、只算一次 ==');
  const allAfter = ipam.listIps({ pageSize: 200, keyword: '10.99.30.5' });
  const hits5 = allAfter.list.filter((r) => r.ip === T_DEAD);
  eq('10.99.30.5 同时出现手工与终端各一条', hits5.length, 2);
  const one4 = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  // 手工 1 条（.5，报废设备的地址，本来空闲）+ 终端占用 2 个（.3 .4）
  eq('剩余可用 = 14 - 1 - 2 = 11', one4.free_count, 11);

  /* ---------------- ⑤ 批量登记也认这条规则 ---------------- */
  console.log('\n== ⑤ 批量登记不能绕过 ==');
  const bulk = ipam.bulkCreate(segId, T_IP1 + '\n10.99.30.6');
  eq('批量：成功 1 条（未被占的 .6）', bulk.added, 1);
  eq('批量：失败 1 条（.3 被终端占用）', bulk.failed.length, 1);
  ok('批量失败原因说得清', (bulk.failed[0] || {}).error.indexOf('终端资产') >= 0, bulk.failed[0]);

  /* ---------------- ⑥ 改 IP 不能改到别人的地址上 ---------------- */
  console.log('\n== ⑥ 编辑登记时换地址 ==');
  const six = db.prepare('SELECT id FROM ip_records WHERE segment_id = ? AND ip = ?').get(segId, '10.99.30.6');
  const updBad = ipam.updateIp(six.id, { ip: T_IP2 });
  ok('改成终端占用的地址 → 拒绝', updBad.ok === false, updBad.error);
  const updOk = ipam.updateIp(six.id, { note: '只改备注应该允许' });
  ok('只改备注 → 允许', updOk.ok === true, updOk.error);

  /* ---------------- ⑦ 删设备后立刻不再占用 ---------------- */
  console.log('\n== ⑦ 回收：终端改了，IP 管理立刻跟着变 ==');
  term.remove(madeTerms[0]);
  madeTerms.shift();
  const free2 = ipam.freeIpsOfSegment(segId, 100);
  ok('删掉设备后 10.99.30.3 立刻回到空闲', free2.ips.indexOf(T_IP1) >= 0);
  eq('终端占用少一台', free2.terminal, 1);

  term.update(madeTerms[0], { status: '报废' });
  const free3 = ipam.freeIpsOfSegment(segId, 100);
  ok('把设备改成报废后，它的地址也算释放', free3.ips.indexOf(T_IP2) >= 0);
  eq('终端占用再少一台', free3.terminal, 0);

  /* ---------------- ⑧ 上线前就存在的重复记录：不重复扣、都看得到 ---------------- */
  console.log('\n== ⑧ 历史遗留的重复记录（直接写库模拟）==');
  // 造一台仍在用的设备，再给它同一个地址插一条手写记录 —— 模拟「上线前两边都登记过」
  const T_DUP = '10.99.30.7';
  mkTerm('自测-地址重复设备', T_DUP, '在用', '检验科', '医技楼2层');
  const beforeDup = ipam.listSegments().list.filter((x) => x.id === segId)[0].free_count;
  const nowStr = '2026-10-30 12:00:00';
  db.prepare(`INSERT INTO ip_records(segment_id, ip, ip_num, status, hostname, created_at, updated_at)
              VALUES (?, ?, ?, 'used', '历史重复记录', ?, ?)`)
    .run(segId, T_DUP, ipam.parseIp(T_DUP), nowStr, nowStr);
  const afterOne = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  eq('插入一条与终端同 IP 的手工记录后，剩余可用不变（没被扣两遍）', afterOne.free_count, beforeDup);
  const dupRows = ipam.listIps({ pageSize: 200, keyword: T_DUP }).list
    .filter((r) => r.ip === T_DUP && (r.source === 'terminal' || r.hostname === '历史重复记录'));
  eq('同一地址在列表里能看到手工 + 终端两条', dupRows.length, 2);
  ok('两条的来源不同', dupRows[0].source !== dupRows[1].source,
    dupRows.map((r) => r.source));
  eq('terminal_only 归零（.7 现在也算手工登记过了）', afterOne.terminal_only, 0);
  const updDup = ipam.updateIp(db.prepare('SELECT id FROM ip_records WHERE segment_id = ? AND ip = ?').get(segId, T_DUP).id,
    { note: '历史重复，改备注应该允许' });
  ok('这种历史重复记录仍然能改（不会被永久锁死）', updDup.ok === true, updDup.error);
} catch (e) {
  fail++;
  console.log('\n[异常] ' + (e && e.stack ? e.stack : e));
} finally {
  cleanup();
  try {
    eq('清理：本网段手工登记已删空',
      db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c, 0);
    ok('清理：测试网段已删', !db.prepare('SELECT id FROM net_segments WHERE cidr = ?').get(SEG_CIDR));
  } catch (e) { /* 忽略 */ }
}

console.log('\n========================================');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
console.log('========================================');
process.exit(fail ? 1 : 0);
