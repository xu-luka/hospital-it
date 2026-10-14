'use strict';
/**
 * IP 管理离线自测（不连真实库，用 :memory: 顶掉 db-contract）。
 *
 * 为什么要写这么多地址算术的断言：CIDR 这类判断错了**不会报错**，
 * 只会给出一个看着很合理的错答案 —— 比如「这个 IP 不在网段内」把合法的拦下来，
 * 或者「还剩 4 个地址」实际还剩 200 个。所以要拿边界值（/0 /31 /32、网络地址、广播地址）
 * 一个个钉住。
 *
 * 运行：node scripts/ipam-selftest.js
 */
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

// ---- 顶掉 db-contract（CONTRACT_DB_FILE 是硬编码的，造不了临时库，只能换导出）----
const ROOT = path.join(__dirname, '..');
const contractPath = require.resolve(path.join(ROOT, 'src', 'db-contract.js'));
require.cache[contractPath] = {
  id: contractPath, filename: contractPath, loaded: true, exports: { db: new DatabaseSync(':memory:') },
};

const ipam = require('../src/ipam');

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name + ' → ' + e.message); }
}
function eq(a, b, msg) { assert.strictEqual(a, b, (msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

/* ==================== 1. IP 解析 / 格式化 ==================== */
ok('parseIp 正常值', () => {
  eq(ipam.parseIp('192.168.1.10'), 3232235786);
  eq(ipam.parseIp('0.0.0.0'), 0);
  eq(ipam.parseIp('255.255.255.255'), 4294967295);
  eq(ipam.parseIp(' 10.0.0.1 '), 167772161, '应忽略首尾空格');
});
ok('parseIp 非法值一律 null', () => {
  ['256.1.1.1', '192.168.1', '1.2.3.4.5', '', 'abc', '192.168.1.-1', '1.2.3.4/24'].forEach((s) => {
    eq(ipam.parseIp(s), null, JSON.stringify(s) + ' 应判为非法');
  });
});
ok('formatIp 往返一致（含边界）', () => {
  [0, 1, 167772161, 3232235786, 4294967295].forEach((n) => {
    eq(ipam.parseIp(ipam.formatIp(n)), n);
  });
  eq(ipam.formatIp(4294967295), '255.255.255.255');
});
ok('parseIp 前导零归一（001 不是非法，但不能被当八进制）', () => {
  eq(ipam.formatIp(ipam.parseIp('192.168.001.010')), '192.168.1.10');
});

/* ==================== 2. CIDR 解析 ==================== */
ok('/24 主机数 = 254，首尾为可用主机', () => {
  const c = ipam.parseCidr('192.168.1.0/24');
  eq(c.hostCount, 254);
  eq(c.firstHost, '192.168.1.1');
  eq(c.lastHost, '192.168.1.254');
  eq(c.networkIp, '192.168.1.0');
  eq(c.broadcastIp, '192.168.1.255');
});
ok('写主机地址也归一到网络地址（否则「在不在网段内」时对时错）', () => {
  eq(ipam.normalizeCidr('192.168.1.37/24'), '192.168.1.0/24');
  eq(ipam.normalizeCidr('10.1.2.255/16'), '10.1.0.0/16');
});
ok('/30 只有 2 个可用地址', () => {
  const c = ipam.parseCidr('10.0.0.0/30');
  eq(c.hostCount, 2);
  eq(c.firstHost, '10.0.0.1');
  eq(c.lastHost, '10.0.0.2');
});
ok('/31 与 /32 不扣网络/广播地址（RFC3021）', () => {
  const c31 = ipam.parseCidr('10.0.0.0/31');
  eq(c31.hostCount, 2, '/31 两个地址都可用');
  eq(c31.firstHost, '10.0.0.0');
  const c32 = ipam.parseCidr('10.0.0.5/32');
  eq(c32.hostCount, 1);
  eq(c32.firstHost, '10.0.0.5');
  eq(c32.lastHost, '10.0.0.5');
});
ok('/0 不会因为 32 位移位而算错', () => {
  const c = ipam.parseCidr('0.0.0.0/0');
  eq(c.mask, 0);
  eq(c.broadcastIp, '255.255.255.255');
  eq(c.hostCount, 4294967294);
});
ok('非法 CIDR 一律 null', () => {
  ['10.0.0.0/33', '10.0.0.0', '10.0.0.0/', '/24', '10.0.0.0/ab', '10.0.0.0/-1', ''].forEach((s) => {
    eq(ipam.parseCidr(s), null, JSON.stringify(s) + ' 应判为非法');
  });
});

/* ==================== 3. 归属判断 ==================== */
ok('网络地址与广播地址都算「在网段内」', () => {
  eq(ipam.ipInCidr('192.168.1.0', '192.168.1.0/24'), true);
  eq(ipam.ipInCidr('192.168.1.255', '192.168.1.0/24'), true);
});
ok('相邻网段不相互包含（边界不能差一）', () => {
  eq(ipam.ipInCidr('192.168.1.255', '192.168.2.0/24'), false);
  eq(ipam.ipInCidr('192.168.2.0', '192.168.1.0/24'), false);
  eq(ipam.ipInCidr('192.168.1.1', '192.168.1.0/24'), true);
  eq(ipam.ipInCidr('10.0.0.1', '192.168.1.0/24'), false);
});
ok('ipInCidr 吃字符串与整数两种入参', () => {
  eq(ipam.ipInCidr(ipam.parseIp('10.0.0.5'), '10.0.0.0/24'), true);
});
ok('网段重叠判断', () => {
  eq(ipam.rangesOverlap('192.168.1.0/24', '192.168.0.0/16'), true, '包含关系也算重叠');
  eq(ipam.rangesOverlap('10.0.0.0/24', '10.0.1.0/24'), false);
  eq(ipam.rangesOverlap('10.0.0.0/24', '10.0.0.0/24'), true);
});

/* ==================== 4. 空闲地址 ==================== */
ok('freeIps 跳过已登记，且按数值顺序', () => {
  const used = new Set(['10.0.0.1', '10.0.0.2']);
  const list = ipam.freeIps('10.0.0.0/29', used, 10);
  eq(list.join(','), '10.0.0.3,10.0.0.4,10.0.0.5,10.0.0.6');
});
ok('freeIps 的 limit 是硬闸门（/8 不能全量展开）', () => {
  const t0 = Date.now();
  const list = ipam.freeIps('10.0.0.0/8', new Set(), 5);
  eq(list.length, 5);
  eq(list[0], '10.0.0.1', '/8 扣掉网络地址 10.0.0.0，第一个可用是 .1');
  assert.ok(Date.now() - t0 < 1000, '取 5 个不该花掉一秒（说明是全量展开后截断）');
});
ok('freeIps limit 上夹到 5000', () => {
  eq(ipam.freeIps('10.0.0.0/8', new Set(), 999999).length, 5000);
});

/* ==================== 5. 批量文本解析 ==================== */
ok('parseBulk 多行 + 备注', () => {
  const r = ipam.parseBulk('192.168.1.10 门诊自助机1\n192.168.1.11 收费窗口');
  eq(r.items.length, 2);
  eq(r.items[0].ip, '192.168.1.10');
  eq(r.items[0].note, '门诊自助机1');
  eq(r.items[1].note, '收费窗口');
  eq(r.invalid.length, 0);
});
ok('parseBulk 区间展开（含反向书写）', () => {
  const r = ipam.parseBulk('192.168.1.10-192.168.1.12');
  eq(r.items.map((x) => x.ip).join(','), '192.168.1.10,192.168.1.11,192.168.1.12');
  const r2 = ipam.parseBulk('192.168.1.12-192.168.1.10');
  eq(r2.items[0].ip, '192.168.1.10', '倒着写也要能展开');
});
ok('parseBulk 支持 CIDR（只展开可用主机）', () => {
  const r = ipam.parseBulk('10.0.0.0/30');
  eq(r.items.map((x) => x.ip).join(','), '10.0.0.1,10.0.0.2');
});
ok('parseBulk 注释行与空行被忽略', () => {
  const r = ipam.parseBulk('# 门诊\n\n192.168.1.1\n   \n');
  eq(r.items.length, 1);
  eq(r.invalid.length, 0);
});
ok('parseBulk 非法行走 invalid 而不是静默丢掉', () => {
  const r = ipam.parseBulk('192.168.1.1\n不是IP\n10.0.0.300');
  eq(r.items.length, 1);
  eq(r.invalid.length, 2);
  assert.ok(/识别不出/.test(r.invalid[0].reason));
});
ok('parseBulk 逗号/顿号/分号都当分隔符', () => {
  const r = ipam.parseBulk('192.168.1.1, 192.168.1.2、192.168.1.3;192.168.1.4');
  eq(r.items.length, 4);
});
ok('parseBulk 总条数有上限（粘贴 2000 行不会打爆）', () => {
  const r = ipam.parseBulk('10.0.0.0/8', { max: 10 });
  eq(r.items.length, 10);
  assert.ok(r.invalid.length >= 1, '超限要有明确提示');
});

/* ==================== 6. 网段读写（内存库） ==================== */
ok('新建网段：通过 + 重复 CIDR 被拒', () => {
  const r = ipam.createSegment({ name: '门诊内网', cidr: '192.168.10.0/24', gateway: '192.168.10.1' });
  eq(r.ok, true);
  eq(r.cidr, '192.168.10.0/24');
  const dup = ipam.createSegment({ name: '重复', cidr: '192.168.10.37/24' });
  eq(dup.ok, false, '归一化后相同也要算重复');
});
ok('新建网段：CIDR 非法 / 网关不在网段内都要被拒', () => {
  eq(ipam.createSegment({ name: 'x', cidr: '192.168.1.0' }).ok, false);
  const r = ipam.createSegment({ name: 'x', cidr: '192.168.20.0/24', gateway: '192.168.30.1' });
  eq(r.ok, false);
  assert.ok(/不在网段/.test(r.error));
});
ok('新建网段：名称为空被拒', () => {
  eq(ipam.createSegment({ name: '  ', cidr: '172.16.0.0/24' }).ok, false);
});

/* ==================== 7. IP 登记 ==================== */
let segId = 0;
ok('准备：建一个 /29 网段', () => {
  const r = ipam.createSegment({ name: '测试段', cidr: '10.9.9.0/29' });
  eq(r.ok, true);
  segId = r.id;
});
ok('登记成功', () => {
  const r = ipam.createIp({ segment_id: segId, ip: '10.9.9.1', hostname: '测试机' });
  eq(r.ok, true);
  eq(r.ip, '10.9.9.1');
});
ok('登记：IP 不在网段内被拒，且提示里带上网段范围', () => {
  const r = ipam.createIp({ segment_id: segId, ip: '10.9.10.1' });
  eq(r.ok, false);
  assert.ok(/不在网段/.test(r.error));
});
ok('登记：同网段重复被拒', () => {
  const r = ipam.createIp({ segment_id: segId, ip: '10.9.9.1' });
  eq(r.ok, false);
  assert.ok(/已登记/.test(r.error));
});
ok('登记：网络地址与广播地址也能登记（有人确实会占）', () => {
  eq(ipam.createIp({ segment_id: segId, ip: '10.9.9.0' }).ok, true);
  eq(ipam.createIp({ segment_id: segId, ip: '10.9.9.7' }).ok, true);
});
ok('登记：MAC 格式非法被拒', () => {
  const r = ipam.createIp({ segment_id: segId, ip: '10.9.9.2', mac: 'xx-yy' });
  eq(r.ok, false);
  assert.ok(/MAC/.test(r.error));
  eq(ipam.createIp({ segment_id: segId, ip: '10.9.9.2', mac: '00-1A-2B-3C-4D-5E' }).ok, true);
});
ok('登记：状态非法回落为 used', () => {
  const r = ipam.createIp({ segment_id: segId, ip: '10.9.9.3', status: '不存在的状态' });
  eq(r.ok, true);
  const row = ipam.listIps({ segment_id: segId }).list.filter((x) => x.ip === '10.9.9.3')[0];
  eq(row.status, 'used');
});

/* ==================== 8. 排序（字符串排序会错，这里钉住数值排序） ==================== */
ok('列表按 IP 数值排序：.9 在 .10 前（字符串排序会反过来）', () => {
  const s = ipam.createSegment({ name: '排序段', cidr: '172.20.0.0/24' });
  ['172.20.0.10', '172.20.0.9', '172.20.0.2', '172.20.0.100'].forEach((ip) => {
    ipam.createIp({ segment_id: s.id, ip: ip });
  });
  const list = ipam.listIps({ segment_id: s.id }).list.map((x) => x.ip);
  eq(list.join(','), '172.20.0.2,172.20.0.9,172.20.0.10,172.20.0.100');
});
ok('字符串排序确实是错的（反向验证，证明上面那条有判别力）', () => {
  const wrong = ['172.20.0.10', '172.20.0.9', '172.20.0.2'].slice().sort();
  eq(wrong[0], '172.20.0.10', '按字符串排，.10 会排到 .2 前面');
});

/* ==================== 9. 空闲地址与用量 ==================== */
ok('freeIpsOfSegment 统计自洽', () => {
  const s = ipam.createSegment({ name: '空闲段', cidr: '10.20.0.0/29' });
  ipam.createIp({ segment_id: s.id, ip: '10.20.0.1' });
  ipam.createIp({ segment_id: s.id, ip: '10.20.0.4' });
  const r = ipam.freeIpsOfSegment(s.id, 100);
  eq(r.ok, true);
  eq(r.host_count, 6);
  eq(r.registered, 2);
  eq(r.free_count, 4);
  eq(r.ips.join(','), '10.20.0.2,10.20.0.3,10.20.0.5,10.20.0.6');
});
ok('listSegments 的 summary 与各网段用量', () => {
  const d = ipam.listSegments();
  assert.ok(d.list.length >= 4);
  const s = d.list.filter((x) => x.cidr === '10.20.0.0/29')[0];
  eq(s.registered, 2);
  eq(s.free_count, 4);
  eq(s.host_count, 6);
  assert.strictEqual(typeof d.summary.usage_pct, 'number');
  assert.ok(d.summary.registered >= 2);
});
ok('网段重叠会被标出来（全院 /16 + 科室 /24）', () => {
  const big = ipam.createSegment({ name: '全院', cidr: '172.16.0.0/16' });
  const small = ipam.createSegment({ name: '科室A', cidr: '172.16.5.0/24' });
  const d = ipam.listSegments();
  const sm = d.list.filter((x) => x.id === small.id)[0];
  assert.ok(sm.overlaps.indexOf('全院') >= 0, '科室段应提示与全院段重叠');
  const bg = d.list.filter((x) => x.id === big.id)[0];
  assert.ok(bg.overlaps.indexOf('科室A') >= 0);
});
ok('跨网段登记同一地址：允许但给 warn（不硬拦）', () => {
  const d = ipam.listSegments();
  const small = d.list.filter((x) => x.name === '科室A')[0];
  const r = ipam.createIp({ segment_id: small.id, ip: '172.16.5.8' });
  eq(r.ok, true);
  assert.ok(/同时落在网段/.test(r.warn || ''), '应提示该地址也在别的网段里');
});

/* ==================== 10. 改网段 / 删网段的安全阀 ==================== */
ok('改小掩码把已有登记甩出网段 → 拒绝并点名是哪几条', () => {
  const r = ipam.updateSegment(segId, { cidr: '10.9.9.0/30' });
  eq(r.ok, false);
  assert.ok(/落在网段外/.test(r.error));
  assert.ok(/10\.9\.9\./.test(r.error), '错误信息里要能看出是哪个地址');
});
ok('改大掩码（已有登记仍在范围内）→ 允许', () => {
  const r = ipam.updateSegment(segId, { cidr: '10.9.8.0/23' });
  eq(r.ok, true);
  eq(ipam.getSegment(segId).cidr, '10.9.8.0/23');
});
ok('删除还有登记的网段 → 拒绝', () => {
  const r = ipam.removeSegment(segId);
  eq(r.ok, false);
  assert.ok(/还有/.test(r.error));
});
ok('删除空网段 → 允许；不存在 → notFound', () => {
  const s = ipam.createSegment({ name: '空段', cidr: '10.30.0.0/24' });
  eq(ipam.removeSegment(s.id).ok, true);
  eq(ipam.removeSegment(s.id).notFound, true);
});
ok('换网段时 IP 不再属于目标网段 → 拒绝', () => {
  const list = ipam.listIps({ segment_id: segId }).list;
  const target = ipam.createSegment({ name: '别的段', cidr: '10.40.0.0/24' });
  const r = ipam.updateIp(list[0].id, { segment_id: target.id });
  eq(r.ok, false);
  assert.ok(/不在网段/.test(r.error));
});

/* ==================== 11. 批量登记 ==================== */
ok('bulkCreate 逐条报结果（成功数 / 失败原因）', () => {
  const s = ipam.createSegment({ name: '批量段', cidr: '10.50.0.0/28' });
  const text = [
    '10.50.0.1 挂号机',
    '10.50.0.2 挂号机2',
    '10.50.0.1 重复行',
    '10.60.0.9 不属于本网段',
    '这不是IP',
  ].join('\n');
  const r = ipam.bulkCreate(s.id, text, { status: 'used' });
  eq(r.added, 2);
  eq(r.failed.length, 2, '重复行 + 越界行都要进 failed');
  eq(r.invalid.length, 1, '识别不出的行进 invalid');
  assert.ok(r.failed.some((f) => /不属于本网段|不在网段/.test(f.error)));
  assert.ok(r.failed.some((f) => /重复出现/.test(f.error)));
});
ok('bulkCreate 展开后的地址真的都在库里', () => {
  const d = ipam.listIps({ keyword: '挂号机' }).list.map((x) => x.ip).sort();
  eq(d.join(','), '10.50.0.1,10.50.0.2');
  const row = ipam.listIps({ keyword: '挂号机' }).list[0];
  eq(row.status_label, '已使用');
});
ok('bulkCreate 网段不存在 → 明确报错', () => {
  eq(ipam.bulkCreate(99999, '10.0.0.1').ok, false);
});

/* ==================== 12. 状态字典 ==================== */
ok('状态字典与中文名', () => {
  eq(ipam.STATUSES.length, 4);
  eq(ipam.statusLabel('conflict'), '冲突');
  eq(ipam.statusLabel('不存在'), '不存在', '未知状态原样回显，不编一个中文名');
});

/* ==================== 13. 地址分布图（segmentMap） ====================
 * 图形化的东西最容易「看着对就行」，所以这里钉的不是像素而是**格子的语义**：
 * 第几格对应哪个地址、边角两格算不算可用、跨 /24 时最后一段是否重新从 0 开始。
 * 这些错了图照样能画出来，只是画的是另一件事。 */

ok('segmentMap /24 → 逐地址网格，网络与广播单独成格', () => {
  const s = ipam.createSegment({ name: '分布图段', cidr: '172.31.1.0/24' });
  ipam.createIp({ segment_id: s.id, ip: '172.31.1.10', status: 'used', hostname: '自助机1' });
  ipam.createIp({ segment_id: s.id, ip: '172.31.1.200', status: 'conflict' });
  ipam.createIp({ segment_id: s.id, ip: '172.31.1.55', status: 'reserved' });
  const m = ipam.segmentMap(s.id);

  eq(m.mode, 'ip');
  eq(m.cols, 16);
  eq(m.cells.length, 256, '网络地址到广播地址全铺');
  eq(m.cells[0].ip, '172.31.1.0');
  eq(m.cells[0].label, '0');
  eq(m.cells[0].state, 'net', '网络地址不该被当成空闲可用');
  eq(m.cells[255].ip, '172.31.1.255');
  eq(m.cells[255].state, 'bcast');
  eq(m.cells[1].state, 'free');
  eq(m.cells[1].reg, false);
  eq(m.cells[10].state, 'used');
  eq(m.cells[10].label, '10');
  eq(m.cells[10].reg, true);
  assert.ok(m.cells[10].tip.indexOf('自助机1') >= 0, '悬停要带上主机名');
  eq(m.cells[55].state, 'reserved');
  eq(m.cells[200].state, 'conflict');
  eq(m.registered, 3);
  eq(m.used, 1);
  eq(m.conflict, 1);
  eq(m.free_count, 251);
});

ok('segmentMap 16 列排布可心算：第 17 格是 .16', () => {
  const s = ipam.listSegments().list.filter((x) => x.cidr === '172.31.1.0/24')[0];
  const m = ipam.segmentMap(s.id);
  eq(m.cells[16].label, '16');
  eq(m.cells[16].ip, '172.31.1.16');
});

ok('segmentMap 小网段列数跟着缩，不排出一行空白', () => {
  const a = ipam.createSegment({ name: '小1', cidr: '172.31.2.0/28' });
  const m28 = ipam.segmentMap(a.id);
  eq(m28.cells.length, 16);
  eq(m28.cols, 16);
  eq(m28.cells[0].ip, '172.31.2.0');

  const b = ipam.createSegment({ name: '小2', cidr: '172.31.3.0/29' });
  const m29 = ipam.segmentMap(b.id);
  eq(m29.cells.length, 8);
  eq(m29.cols, 8, '/29 只有 8 个地址，用 8 列正好一行');

  const d = ipam.createSegment({ name: '单主机', cidr: '172.31.4.1/32' });
  const m32 = ipam.segmentMap(d.id);
  eq(m32.cells.length, 1);
  eq(m32.cols, 1);
  eq(m32.cells[0].state, 'free', '/32 不扣首尾，唯一那个地址就是可用主机');
});

ok('segmentMap /31 两个地址都算可用，不当成网络/广播', () => {
  const s = ipam.createSegment({ name: '点对点', cidr: '172.31.6.0/31' });
  const m = ipam.segmentMap(s.id);
  eq(m.cells.length, 2);
  eq(m.cells[0].state, 'free');
  eq(m.cells[1].state, 'free');
  eq(m.host_count, 2);
});

ok('segmentMap 255.255.255.252/30 走到末位不会进位回绕成 0', () => {
  const s = ipam.createSegment({ name: '末尾段', cidr: '255.255.255.252/30' });
  const m = ipam.segmentMap(s.id);
  eq(m.cells.length, 4);
  eq(m.cells[0].ip, '255.255.255.252');
  eq(m.cells[0].state, 'net');
  eq(m.cells[3].ip, '255.255.255.255');
  eq(m.cells[3].state, 'bcast');
});

ok('segmentMap /23（512 格）仍是逐地址网格，跨段后最后一段重新从 0 开始', () => {
  const s = ipam.createSegment({ name: '两个C', cidr: '172.30.0.0/23' });
  const m = ipam.segmentMap(s.id);
  eq(m.mode, 'ip');
  eq(m.cells.length, 512);
  eq(m.cells[0].ip, '172.30.0.0');
  eq(m.cells[256].ip, '172.30.1.0');
  eq(m.cells[256].label, '0');
  eq(m.cells[511].state, 'bcast');
});

ok('segmentMap /21 超过 1024 格 → 按 /24 聚合成 8 块', () => {
  const s = ipam.createSegment({ name: '聚合段', cidr: '172.29.0.0/21' });
  ipam.createIp({ segment_id: s.id, ip: '172.29.0.5', status: 'used' });
  ipam.createIp({ segment_id: s.id, ip: '172.29.0.6', status: 'used' });
  ipam.createIp({ segment_id: s.id, ip: '172.29.3.7', status: 'conflict' });
  const m = ipam.segmentMap(s.id);

  eq(m.mode, 'block');
  eq(m.blocks, 8);
  eq(m.cells.length, 8);
  eq(m.cells[0].ip, '172.29.0.0/24');
  eq(m.cells[0].registered, 2, '前两条应落在第一个 /24');
  eq(m.cells[0].used, 2);
  eq(m.cells[0].label, '2', '块数不多时格内直接写登记条数');
  eq(m.cells[1].state, 'free');
  eq(m.cells[1].label, '0');
  eq(m.cells[3].ip, '172.29.3.0/24');
  eq(m.cells[3].registered, 1);
  eq(m.cells[3].state, 'conflict');
  assert.ok(m.cells[3].tip.indexOf('172.29.3.0/24') >= 0, '聚合格必须能悬停问出是哪一段');
});

ok('segmentMap /16 每格一个 /24，共 256 格且顺序与地址一致', () => {
  const s = ipam.createSegment({ name: '大院内网', cidr: '172.28.0.0/16' });
  ipam.createIp({ segment_id: s.id, ip: '172.28.7.9', status: 'used' });
  const m = ipam.segmentMap(s.id);
  eq(m.mode, 'block');
  eq(m.blocks, 256);
  eq(m.cells.length, 256);
  eq(m.cells[0].ip, '172.28.0.0/24');
  eq(m.cells[7].ip, '172.28.7.0/24', '第 8 格必须是 172.28.7.0/24，不能错位');
  eq(m.cells[7].registered, 1);
});

ok('segmentMap 太大（/8）只给结论不给图', () => {
  const s = ipam.createSegment({ name: '超大', cidr: '10.0.0.0/8' });
  const m = ipam.segmentMap(s.id);
  eq(m.mode, 'none');
  eq(m.cells.length, 0);
  assert.ok(m.note.indexOf('10.0.0.0/8') >= 0, '提示里要写明是哪个网段');
  eq(m.host_count, 16777214);
});

ok('segmentMap 网段不存在 → 明确报错，而不是返回一张空图', () => {
  eq(ipam.segmentMap(99999).ok, false);
  assert.ok(/不存在/.test(ipam.segmentMap(99999).error));
  eq(ipam.segmentMap(99999).notFound, true, '要带 notFound，路由才会回 404 而不是 400');
});

ok('segmentMap 不返回明文没用的字段，只给画图要用的', () => {
  const s = ipam.listSegments().list.filter((x) => x.cidr === '172.31.1.0/24')[0];
  const m = ipam.segmentMap(s.id);
  eq(typeof m.truncated, 'boolean');
  const keys = Object.keys(m.cells[10]).sort().join(',');
  eq(keys, 'ip,label,reg,state,tip');
});

/* ==================== 汇总 ==================== */
console.log('ipam-selftest：通过 ' + pass + ' / 失败 ' + fails.length);
if (fails.length) {
  fails.forEach((f) => console.log('  x ' + f));
  process.exit(1);
}
