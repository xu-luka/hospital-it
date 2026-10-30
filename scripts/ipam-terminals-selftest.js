'use strict';
/**
 * ipam-terminals-selftest.js —— 【IP 管理】与【终端资产】联动（只读合并）自测
 *
 * 要钉住的是这几件事（都是「写错了界面照样能开、但数据会骗人」的类型）：
 *   ① 终端资产里有 IP 的设备，会出现在 IP 登记列表里，且不写库（ip_records 条数不变）
 *   ② 这些地址算进「已占用」：空闲地址列表里不会再推荐它、网段剩余数会扣掉、分布图是已使用
 *   ③ 终端改了 IP / 删了设备，IP 管理这边立刻跟着变（因为压根没有副本）
 *   ④ 想手工登记一个已被终端占用的地址 → 明确拒绝并说清是哪台设备
 *   ⑤ 手工登记与终端资产重复时（历史遗留）：手工优先，只算一次，free_count 不被扣两遍
 *
 * ★ 2026-10-30 起台账按 Excel 21 列重建，表里**没有「状态/报废」**了，所以本文件里
 *   原先那组「报废设备的地址算空闲、可以手工登记」的用例已删除 —— 那个口径不存在了。
 *   现在的规则只有一句：设备还在台账里 = 地址被占；要释放就删设备，或把它的内网地址清空。
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
const T_IP3 = '10.99.30.5';
const T_OUT = '10.99.31.3';

const madeTerms = [];
let segId = 0;

/**
 * 造一台终端。名字（展示名）来自「工作组/计算机名」，所以 hostname 一定给出来 ——
 * 否则界面上会显示成「设备 #12」，而自测里所有断言都是按名字认设备的。
 */
function mkTerm(patch) {
  const row = Object.assign({
    hostname: 'ZS-PC-TEST', ip: '', department: '测试科', location: '测试楼1层',
    stat_category: '台式计算机', model: 'M720t', mac: '', asset_no: '',
  }, patch);
  const r = term.create(row, { id: 1, name: '自测' });
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

  mkTerm({ hostname: 'ZS-PC-0301', ip: T_IP1, department: '门诊部', location: '门诊楼3层3诊室' });
  mkTerm({
    hostname: 'ZS-PRT-0501', ip: T_IP2, department: '内科', location: '住院楼5层护士站',
    stat_category: '激光打印机', model: 'LJ2655DN', mac: 'AA-BB-CC-00-00-04',
  });
  mkTerm({
    hostname: 'ZS-PRJ-OLD', ip: T_IP3, department: '信息科', location: '库房',
    stat_category: '投影仪', model: 'CB-X06',
  });
  mkTerm({ hostname: 'ZS-PC-0101', ip: T_OUT, department: '门诊部', location: '门诊楼1层' });
  console.log('  造了 4 台终端（3 台在自测网段内，1 台在网段外）');

  const beforeCount = db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c;
  eq('起点：本网段手工登记 0 条', beforeCount, 0);

  /* ---------------- ① 列表合并 ---------------- */
  console.log('\n== ① 登记列表里能看到终端资产 ==');
  const all = ipam.listIps({ pageSize: 200, keyword: 'ZS-' });
  const row1 = all.list.filter((r) => r.ip === T_IP1)[0];
  ok('列表里有终端资产那条', !!row1);
  ok('来源标成 terminal', row1 && row1.source === 'terminal', row1 && row1.source);
  ok('名字取「工作组/计算机名」', row1 && row1.hostname === 'ZS-PC-0301', row1 && row1.hostname);
  ok('带科室/位置进备注', row1 && row1.note.indexOf('门诊部') >= 0 && row1.note.indexOf('门诊楼3层3诊室') >= 0, row1 && row1.note);
  ok('命中网段', row1 && Number(row1.segment_id) === segId, row1 && row1.segment_id);
  ok('设备类型由统计类别推出来', row1 && row1.device_type === 'PC', row1 && row1.device_type);
  ok('设备里带着统计类别/型号（界面「设备类型」列要用）',
    row1 && row1.device.stat_category === '台式计算机' && row1.device.model === 'M720t',
    row1 && row1.device);
  ok('id 是字符串 t<设备id>，与 ip_records 的数值 id 不会撞',
    row1 && typeof row1.id === 'string' && row1.id.charAt(0) === 't', row1 && row1.id);

  const onlyTerm = ipam.listIps({ source: 'terminal', pageSize: 200, keyword: 'ZS-' });
  eq('source=terminal 只有终端记录', onlyTerm.list.every((r) => r.source === 'terminal'), true);
  eq('source=terminal 条数（4 台测试设备都带 ZS-）', onlyTerm.total, 4);
  eq('source=manual 一条都没有', ipam.listIps({ source: 'manual', pageSize: 200, keyword: 'ZS-' }).total, 0);

  eq('终端记录没写进 ip_records（这就是「不落库」的判据）',
    db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c, 0);

  const kwHit = ipam.listIps({ pageSize: 200, keyword: '护士站' });
  ok('关键词能按位置搜到', kwHit.list.some((r) => r.ip === T_IP2));

  const segOnly = ipam.listIps({ segment_id: segId, pageSize: 200 });
  eq('按网段筛选：只出这个网段内的 3 台（网段外那台不算）', segOnly.total, 3);

  /* ---------------- ② 算进「已占用」 ---------------- */
  console.log('\n== ② 终端占的地址不能再被当成空闲 ==');
  const segs = ipam.listSegments();
  const one = segs.list.filter((x) => x.id === segId)[0];
  eq('网段统计：终端占用 3 台', one.terminal, 3);
  eq('其中未手工登记 3 个', one.terminal_only, 3);
  eq('剩余可用 = 14 - 3 = 11', one.free_count, 11);
  eq('汇总里的终端占用数不小于 3', segs.summary.terminal >= 3, true);

  const free = ipam.freeIpsOfSegment(segId, 100);
  ok('空闲地址里没有 10.99.30.3', free.ips.indexOf(T_IP1) < 0, free.ips.slice(0, 5));
  ok('空闲地址里没有 10.99.30.4', free.ips.indexOf(T_IP2) < 0);
  ok('空闲地址里没有 10.99.30.5', free.ips.indexOf(T_IP3) < 0);
  eq('终端占用计数', free.terminal, 3);
  eq('空闲 11 个', free.free_count, 11);

  const map = ipam.segmentMap(segId);
  const cell1 = map.cells.filter((c) => c.ip === T_IP1)[0];
  ok('分布图该格是「已使用」', cell1 && cell1.state === 'used', cell1 && cell1.state);
  ok('该格可点击（reg=true）', cell1 && cell1.reg === true);
  ok('该格标记 terminal', cell1 && cell1.terminal === true);
  ok('悬停提示里带设备名', cell1 && cell1.tip.indexOf('ZS-PC-0301') >= 0, cell1 && cell1.tip);
  const cellFree = map.cells.filter((c) => c.ip === '10.99.30.7')[0];
  ok('没被占的格子仍是空闲', cellFree && cellFree.state === 'free', cellFree && cellFree.state);

  /* ---------------- ③ 手工登记撞车 ---------------- */
  console.log('\n== ③ 想手工登记一个已被终端占用的地址 ==');
  const dup = ipam.createIp({ segment_id: segId, ip: T_IP1 });
  ok('被拒绝', dup.ok === false, dup.error);
  ok('提示里点名是哪台设备', (dup.error || '').indexOf('ZS-PC-0301') >= 0, dup.error);
  ok('提示指向终端资产改 IP', (dup.error || '').indexOf('终端资产') >= 0);
  eq('仍然没写库', db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(segId).c, 0);

  const dup3 = ipam.createIp({ segment_id: segId, ip: T_IP3, hostname: '手工登记-库房旧投影' });
  ok('另一台终端占的地址同样被拒（台账里没有「报废」这个豁免）', dup3.ok === false, dup3.error);

  /* ---------------- ④ 批量登记也认这条规则 ---------------- */
  console.log('\n== ④ 批量登记不能绕过 ==');
  const bulk = ipam.bulkCreate(segId, T_IP1 + '\n10.99.30.6');
  eq('批量：成功 1 条（未被占的 .6）', bulk.added, 1);
  eq('批量：失败 1 条（.3 被终端占用）', bulk.failed.length, 1);
  ok('批量失败原因说得清', (bulk.failed[0] || {}).error.indexOf('终端资产') >= 0, bulk.failed[0]);

  /* ---------------- ⑤ 改 IP 不能改到别人的地址上 ---------------- */
  console.log('\n== ⑤ 编辑登记时换地址 ==');
  const six = db.prepare('SELECT id FROM ip_records WHERE segment_id = ? AND ip = ?').get(segId, '10.99.30.6');
  const updBad = ipam.updateIp(six.id, { ip: T_IP2 });
  ok('改成终端占用的地址 → 拒绝', updBad.ok === false, updBad.error);
  const updOk = ipam.updateIp(six.id, { note: '只改备注应该允许' });
  ok('只改备注 → 允许', updOk.ok === true, updOk.error);

  /* ---------------- ⑥ 回收：删设备 / 清空内网地址 ---------------- */
  console.log('\n== ⑥ 回收：终端改了，IP 管理立刻跟着变 ==');
  term.remove(madeTerms[0]);
  madeTerms.shift();
  const free2 = ipam.freeIpsOfSegment(segId, 100);
  ok('删掉设备后 10.99.30.3 立刻回到空闲', free2.ips.indexOf(T_IP1) >= 0);
  eq('终端占用少一台', free2.terminal, 2);

  // 不删设备、只把「内网地址」清空 —— 这台机器还在台账里（比如搬走了），地址该释放
  const clear = term.update(madeTerms[0], { ip: '' });
  ok('把设备的内网地址清空 → 允许', clear.ok === true, clear.error);
  const free3 = ipam.freeIpsOfSegment(segId, 100);
  ok('清空后 10.99.30.4 也算释放', free3.ips.indexOf(T_IP2) >= 0);
  eq('终端占用再少一台', free3.terminal, 1);

  /* ---------------- ⑦ 上线前就存在的重复记录：不重复扣、都看得到 ---------------- */
  console.log('\n== ⑦ 历史遗留的重复记录（直接写库模拟）==');
  // 造一台仍在用的设备，再给它同一个地址插一条手写记录 —— 模拟「上线前两边都登记过」
  const T_DUP = '10.99.30.7';
  mkTerm({ hostname: 'ZS-PC-0701', ip: T_DUP, department: '检验科', location: '医技楼2层' });
  const beforeDup = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  const nowStr = '2026-10-30 12:00:00';
  db.prepare(`INSERT INTO ip_records(segment_id, ip, ip_num, status, hostname, created_at, updated_at)
              VALUES (?, ?, ?, 'used', '历史重复记录', ?, ?)`)
    .run(segId, T_DUP, ipam.parseIp(T_DUP), nowStr, nowStr);
  const afterOne = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  eq('插入一条与终端同 IP 的手工记录后，剩余可用不变（没被扣两遍）', afterOne.free_count, beforeDup.free_count);
  eq('terminal_only 少 1（.7 现在也算手工登记过了）',
    afterOne.terminal_only, beforeDup.terminal_only - 1);
  const dupRows = ipam.listIps({ pageSize: 200, keyword: T_DUP }).list
    .filter((r) => r.ip === T_DUP && (r.source === 'terminal' || r.hostname === '历史重复记录'));
  eq('同一地址在列表里能看到手工 + 终端两条', dupRows.length, 2);
  ok('两条的来源不同', dupRows[0].source !== dupRows[1].source,
    dupRows.map((r) => r.source));
  const updDup = ipam.updateIp(db.prepare('SELECT id FROM ip_records WHERE segment_id = ? AND ip = ?').get(segId, T_DUP).id,
    { note: '历史重复，改备注应该允许' });
  ok('这种历史重复记录仍然能改（不会被永久锁死）', updDup.ok === true, updDup.error);

  /* ---------------- ⑧ 台账「外网地址」列同样并进网段 ----------------
   * 用户报的原始现象：一台机器台账里只填了「外网地址 10.10.10.94」（内网地址空），
   * 建好 10.10.10.0/24 后这个段一个设备都没关联上。根因是 ipList 只按 ip 取。
   * 这里钉住三件事：只填外网也能进列表 / 也算占用 / 手工登记会被拒。
   */
  console.log('\n== ⑧ 外网地址（办公网）也要并进网段 ==');
  const T_WAN = '10.99.30.9';
  // 先拍一份统计（造设备之前），后面的差值才是「这个外网地址带来的变化」
  const beforeWan = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  const wanTerm = mkTerm({
    hostname: 'ZS-OFFICE-0901', ip: '', ip_extra: T_WAN, department: '财务科', location: '行政楼2层',
  });
  const wanRows = term.ipList().filter((t) => t.terminal_id === wanTerm);
  eq('ipList 对「只填外网」的设备也出一条（net=out）', wanRows.map((t) => t.net), ['out']);

  const wanRow = ipam.listIps({ pageSize: 200, keyword: T_WAN }).list.filter((r) => r.ip === T_WAN)[0];
  ok('IP 登记列表里能看到这个外网地址', !!wanRow);
  eq('标成外网', wanRow && wanRow.net, 'out');
  ok('备注点明是「外网地址」', !!wanRow && wanRow.note.indexOf('外网地址') >= 0, wanRow && wanRow.note);
  eq('id 用 tx 前缀，与内网那条不撞', wanRow && wanRow.id, 'tx' + wanTerm);
  eq('落进自测网段', wanRow && Number(wanRow.segment_id), segId);
  eq('外网行不再重复挂 ip_extra（否则备注里同一个值出现两次）', wanRow && wanRow.ip_extra, '');

  const afterWan = ipam.listSegments().list.filter((x) => x.id === segId)[0];
  eq('网段剩余数少 1（外网地址也算占用）', beforeWan.free_count - afterWan.free_count, 1);
  eq('网段终端占用 +1', afterWan.terminal - beforeWan.terminal, 1);
  eq('未登记占用 +1（terminal_only）', afterWan.terminal_only - beforeWan.terminal_only, 1);
  ok('空闲地址里排除了外网地址',
    ipam.freeIpsOfSegment(segId, 100).ips.indexOf(T_WAN) < 0);
  const mapWan = ipam.segmentMap(segId).cells.filter((c) => c.ip === T_WAN)[0];
  ok('分布图该格是「已使用」', mapWan && mapWan.state === 'used', mapWan && mapWan.state);
  ok('悬停提示点明是外网地址', !!mapWan && mapWan.tip.indexOf('外网地址') >= 0, mapWan && mapWan.tip);

  const dupWan = ipam.createIp({ segment_id: segId, ip: T_WAN });
  ok('手工登记一个已被台账外网地址占用的 IP → 拒绝', dupWan.ok === false, dupWan.error);
  ok('拒绝理由里说明是外网地址', (dupWan.error || '').indexOf('外网地址') >= 0, dupWan.error);

  // 一台设备两列都填、且同在一个网段：必须是两行、两个 id，不能只剩一行
  const T_BI = '10.99.30.10';
  const T_BO = '10.99.30.11';
  mkTerm({ hostname: 'ZS-BOTH-1011', ip: T_BI, ip_extra: T_BO, department: '检验科', location: '医技楼3层' });
  const bothRows = ipam.listIps({ pageSize: 200, keyword: 'ZS-BOTH-1011' }).list;
  eq('两列都填 → 两条记录', bothRows.length, 2);
  eq('两条的 net 分别是 in / out', bothRows.map((r) => r.net).sort(), ['in', 'out']);
  eq('两条 id 互不相同（否则 Vue 会把两行认成一行）', new Set(bothRows.map((r) => r.id)).size, 2);
  eq('两个地址各占一格', ipam.freeIpsOfSegment(segId, 100).ips.filter((ip) => ip === T_BI || ip === T_BO).length, 0);
  const kwIn = ipam.listIps({ pageSize: 200, keyword: T_BO }).list;
  eq('搜外网地址只命中外网那一行（不会内外各出一行）',
    kwIn.filter((r) => r.ip === T_BO).length, 1);
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
