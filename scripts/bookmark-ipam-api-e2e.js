'use strict';
/**
 * 网页书签 / IP 管理 后端接口端到端自测
 *
 * 用法：node scripts/bookmark-ipam-api-e2e.js         （默认端口 3998）
 *      PORT=4568 node scripts/bookmark-ipam-api-e2e.js
 *
 * 做了什么：
 *   1) 把四个库全部指到临时目录（改 config 再 require db 模块），**不碰 data/*.db**；
 *   2) 起真实 Express 服务，自签 JWT 打真实 HTTP；
 *   3) 密码加解密走的是真 KeyVault.exe + secrets/master.key（不是桩）——
 *      这样「密文是否真的落库」「解密是否真能还原」才有意义。
 *
 * 重点覆盖的不是 CRUD 本身，而是三条容易写错、错了也不报错的规则：
 *   · bookmarks.secret 必须**独立于** manage（能改书签 ≠ 能看别人的密码）；
 *   · 密码明文绝不随列表接口出去；
 *   · IP 登记必须校验「属于该网段」与「同网段不重复」。
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// ---- 先把四个库指到临时目录，再加载任何 db 模块 ----
// config.js 是普通对象导出，db-contract / db / db-docs 都在 require 时才读这些值，
// 所以这里就地改掉是有效的（也是本项目做接口级自测的既有做法）。
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bmipam-e2e-'));
const config = require(path.join(ROOT, 'config'));
config.CONTRACT_DB_FILE = path.join(TMP, 'contract.db');
config.DB_FILE = path.join(TMP, 'his.db');
config.INSPECT_DB_FILE = path.join(TMP, 'inspect.db');
config.DOCS_DB_FILE = path.join(TMP, 'docs.db');
config.PORT = Number(process.env.PORT || 3998);

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}
function eq(tag, a, b) {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) { pass++; console.log('  [OK]   ' + tag + ' = ' + x); }
  else { fails.push(tag + ' 期望 ' + y + '，实际 ' + x); console.log('  [FAIL] ' + tag + ' 期望 ' + y + '，实际 ' + x); }
}

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const perm = require(path.join(ROOT, 'src', 'perm'));

  require(path.join(ROOT, 'server'));
  getSecret();
  const { db } = require(path.join(ROOT, 'src', 'db-contract'));
  const { getDb } = require(path.join(ROOT, 'src', 'db'));
  // 保留：确认问题库也起得来（合同库之外的第二条依赖链）
  const hisUp = !!getDb();

  const base = 'http://127.0.0.1:' + config.PORT;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/bookmarks'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  // 三个身份：管理员（*）、只读角色（有 view 没 secret/manage）、无权限角色
  db.prepare("INSERT INTO roles (id, code, name) VALUES (901, 'bm_viewer', '书签只读')").run();
  db.prepare("INSERT INTO roles (id, code, name) VALUES (902, 'bm_none', '书签无权限')").run();
  perm.setRolePerms(901, 'bm_viewer', ['bookmarks.view', 'ipam.view']);
  perm.setRolePerms(902, 'bm_none', ['dashboard.view']);
  db.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, created_at)"
    + " VALUES ('e2e_viewer', '只读', 'x', 'y', 901, datetime('now','localtime'))").run();
  db.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, created_at)"
    + " VALUES ('e2e_none', '无权限', 'x', 'y', 902, datetime('now','localtime'))").run();
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const viewerId = db.prepare("SELECT id FROM users WHERE username = 'e2e_viewer'").get().id;
  const noneId = db.prepare("SELECT id FROM users WHERE username = 'e2e_none'").get().id;

  const tokens = {
    admin: signJwt({ id: adminId, username: 'admin', role_id: 1 }, 3600),
    viewer: signJwt({ id: viewerId, username: 'e2e_viewer', role_id: 901 }, 3600),
    none: signJwt({ id: noneId, username: 'e2e_none', role_id: 902 }, 3600),
  };

  async function call(who, method, url, body) {
    const opt = { method, headers: {} };
    if (who) opt.headers.Authorization = 'Bearer ' + tokens[who];
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(base + url, opt);
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json, raw: JSON.stringify(json) };
  }

  console.log('\n== 鉴权：三个身份的边界 ==');
  ok('问题库（his.db）也正常初始化（合同库不是唯一的库）', hisUp);
  eq('未登录读书签 → 401', (await call(null, 'GET', '/api/bookmarks')).status, 401);
  eq('无权限角色读书签 → 403', (await call('none', 'GET', '/api/bookmarks')).status, 403);
  eq('无权限角色读 IP → 403', (await call('none', 'GET', '/api/ipam/segments')).status, 403);
  eq('只读角色读书签 → 200', (await call('viewer', 'GET', '/api/bookmarks')).status, 200);
  eq('只读角色新增书签 → 403（只有 view 没有 manage）', (await call('viewer', 'POST', '/api/bookmarks', { name: 'x' })).status, 403);
  eq('只读角色新增 IP 登记 → 403', (await call('viewer', 'POST', '/api/ipam/ips', { segment_id: 1, ip: '192.168.77.1' })).status, 403);

  console.log('\n== 书签：增改查 + 密码不出现在列表里 ==');
  const PLAIN = 'P@ssw0rd-中文-测试';
  const c1 = await call('admin', 'POST', '/api/bookmarks', {
    name: 'HIS 住院系统', url: '10.1.1.5:8080', group_name: '业务系统',
    username: 'hisadmin', password: PLAIN, note: '仅内网',
  });
  eq('新增书签 → 200', c1.status, 200);
  const bmId = c1.json && c1.json.data && c1.json.data.id;
  ok('新增返回了 id', Number(bmId) > 0, bmId);

  const list1 = await call('admin', 'GET', '/api/bookmarks');
  eq('列表返回 1 条', list1.json.data.total, 1);
  ok('列表里 has_password = 1', list1.json.data.list[0].has_password === 1);
  ok('★ 列表响应里不含明文密码', list1.raw.indexOf(PLAIN) < 0);
  ok('★ 列表响应里不含 password_enc 字段', !('password_enc' in list1.json.data.list[0]));
  ok('open_url 自动补了协议', list1.json.data.list[0].open_url === 'http://10.1.1.5:8080',
    list1.json.data.list[0].open_url);

  // 落库的必须是密文，且解不回原文以外的任何东西
  const rawRow = db.prepare('SELECT password_enc FROM bookmarks WHERE id = ?').get(bmId);
  ok('★ 库里存的是 enc:v1: 密文', String(rawRow.password_enc).indexOf('enc:v1:') === 0);
  ok('★ 密文里不含明文片段', String(rawRow.password_enc).indexOf('P@ssw0rd') < 0);

  console.log('\n== 书签：看密码是独立权限点 ==');
  eq('只读角色（无 secret）取密码 → 403', (await call('viewer', 'GET', '/api/bookmarks/' + bmId + '/secret')).status, 403);
  const sec = await call('admin', 'GET', '/api/bookmarks/' + bmId + '/secret');
  eq('管理员取密码 → 200', sec.status, 200);
  eq('★ 真密钥解密还原明文', sec.json.data.password, PLAIN);
  eq('标记为密文', sec.json.data.encrypted, true);

  // 操作日志要留痕。★ 注意 logs 表在**合同库**里，不在问题库（his.db）——
  //   src/utils.js 的 logAction 是从 './db-contract' 取 db 的。
  //   一开始我查的是 his.db，得到「无记录」，差点误判成日志没写。
  const logRow = db.prepare("SELECT * FROM logs WHERE action = '查看书签凭据' ORDER BY id DESC LIMIT 1").get();
  ok('★ 查看密码写入了操作日志', !!logRow, logRow ? logRow.detail : '无记录');
  ok('日志里记下了是谁看的', !!logRow && logRow.username === 'admin', logRow ? logRow.username : '');

  console.log('\n== 书签：密码字段的更新语义 ==');
  const u1 = await call('admin', 'PUT', '/api/bookmarks/' + bmId, { name: 'HIS 住院系统', note: '只改备注' });
  eq('不传 password 的编辑 → 200', u1.status, 200);
  const sec2 = await call('admin', 'GET', '/api/bookmarks/' + bmId + '/secret');
  eq('★ 不传 password 时原密码保持不变', sec2.json.data.password, PLAIN);

  await call('admin', 'PUT', '/api/bookmarks/' + bmId, { password: 'NewPwd!2026' });
  eq('传新密码后覆盖', (await call('admin', 'GET', '/api/bookmarks/' + bmId + '/secret')).json.data.password, 'NewPwd!2026');

  await call('admin', 'PUT', '/api/bookmarks/' + bmId, { password: '' });
  const list2 = await call('admin', 'GET', '/api/bookmarks');
  eq('传空串清空密码 → has_password = 0', list2.json.data.list[0].has_password, 0);
  const sec3 = await call('admin', 'GET', '/api/bookmarks/' + bmId + '/secret');
  eq('清空后取密码得到空串（不报错）', sec3.json.data.password, '');

  console.log('\n== 书签：分组 / 搜索 / 删除 ==');
  await call('admin', 'POST', '/api/bookmarks', { name: 'OA 办公', url: 'oa.local', group_name: '办公' });
  await call('admin', 'POST', '/api/bookmarks', { name: '无分组书签', url: 'x.local' });
  const g = await call('admin', 'GET', '/api/bookmarks');
  eq('共 3 条', g.json.data.total, 3);
  eq('分组数（含未分组）', g.json.data.groups.length, 3);
  eq('按分组筛选', (await call('admin', 'GET', '/api/bookmarks?group=' + encodeURIComponent('办公'))).json.data.total, 1);
  eq('关键词搜索 url', (await call('admin', 'GET', '/api/bookmarks?keyword=oa.local')).json.data.total, 1);
  eq('删除 → 200', (await call('admin', 'DELETE', '/api/bookmarks/' + bmId)).status, 200);
  eq('删除后 404', (await call('admin', 'GET', '/api/bookmarks/' + bmId + '/secret')).status, 404);

  console.log('\n== IP 管理：网段 ==');
  const s1 = await call('admin', 'POST', '/api/ipam/segments', {
    name: '测试内网', cidr: '192.168.77.0/24', gateway: '192.168.77.1', vlan: '77', location: '测试',
  });
  eq('新增网段 → 200', s1.status, 200);
  const segId = s1.json.data.id;
  eq('CIDR 归一化后返回', s1.json.data.cidr, '192.168.77.0/24');
  eq('重复 CIDR → 400', (await call('admin', 'POST', '/api/ipam/segments', { name: '重复', cidr: '192.168.77.9/24' })).status, 400);
  eq('非法 CIDR → 400', (await call('admin', 'POST', '/api/ipam/segments', { name: 'x', cidr: '192.168.77.0' })).status, 400);
  eq('网关不在网段内 → 400', (await call('admin', 'POST', '/api/ipam/segments', { name: 'x', cidr: '10.10.0.0/24', gateway: '10.20.0.1' })).status, 400);

  console.log('\n== IP 管理：登记校验 ==');
  eq('越界 IP → 400', (await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip: '192.168.78.5' })).status, 400);
  const bad = await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip: '192.168.78.5' });
  ok('错误信息说明了不在哪个网段', /不在网段/.test(bad.json.message), bad.json.message);
  eq('非法 IP → 400', (await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip: '192.168.77.999' })).status, 400);
  eq('MAC 非法 → 400', (await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip: '192.168.77.5', mac: 'zz' })).status, 400);
  eq('正常登记 → 200', (await call('admin', 'POST', '/api/ipam/ips', {
    segment_id: segId, ip: '192.168.77.5', hostname: '测试机', owner: '信息科', device_type: 'PC',
    mac: '00-1A-2B-3C-4D-5E',
  })).status, 200);
  const dup = await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip: '192.168.77.5' });
  eq('同网段重复登记 → 400', dup.status, 400);
  ok('重复提示指出已登记的主机名', /测试机/.test(dup.json.message), dup.json.message);

  console.log('\n== IP 管理：统计与空闲地址 ==');
  const segs = await call('admin', 'GET', '/api/ipam/segments');
  const seg = segs.json.data.list.filter((x) => x.id === segId)[0];
  eq('该网段可用地址数 = 254', seg.host_count, 254);
  eq('已登记 1 条', seg.registered, 1);
  eq('剩余 253', seg.free_count, 253);
  eq('首尾可用地址', seg.first_host + '~' + seg.last_host, '192.168.77.1~192.168.77.254');
  ok('summary 有汇总', segs.json.data.summary.segments >= 1);
  const free = await call('admin', 'GET', '/api/ipam/segments/' + segId + '/free?limit=5');
  eq('空闲地址恰好返回 5 个（受 limit 限制）', free.json.data.ips.length, 5);
  ok('空闲地址里不含已登记的 .5', free.json.data.ips.indexOf('192.168.77.5') < 0, free.json.data.ips.join(','));
  eq('free_count 为 253', free.json.data.free_count, 253);

  console.log('\n== IP 管理：排序按数值（字符串排序会错） ==');
  for (const ip of ['192.168.77.10', '192.168.77.9', '192.168.77.100']) {
    await call('admin', 'POST', '/api/ipam/ips', { segment_id: segId, ip });
  }
  const ips = await call('admin', 'GET', '/api/ipam/ips?segment_id=' + segId);
  eq('按数值排序', ips.json.data.list.map((x) => x.ip).join(','),
    '192.168.77.5,192.168.77.9,192.168.77.10,192.168.77.100');

  console.log('\n== IP 管理：批量登记 ==');
  const dry = await call('admin', 'POST', '/api/ipam/ips/bulk', {
    segment_id: segId, text: '192.168.77.20 自助机\n192.168.99.1 越界\n这不是IP', dry_run: 1,
  });
  eq('预览 → 200', dry.status, 200);
  eq('预览 total = 2', dry.json.data.total, 2);
  eq('预览 valid = 1', dry.json.data.valid, 1);
  eq('预览 outside 1 个', dry.json.data.outside.length, 1);
  eq('预览 invalid 1 行', dry.json.data.invalid.length, 1);
  eq('★ 预览不落库（仍是 4 条）', (await call('admin', 'GET', '/api/ipam/ips?segment_id=' + segId)).json.data.total, 4);

  const bulk = await call('admin', 'POST', '/api/ipam/ips/bulk', {
    segment_id: segId, text: '192.168.77.20 自助机\n192.168.77.20 重复\n192.168.99.1 越界\n192.168.77.21-192.168.77.23 诊室',
  });
  eq('批量登记 → 200', bulk.status, 200);
  eq('新增 4 条（.20 + .21~.23）', bulk.json.data.added, 4);
  eq('失败 2 条（重复 + 越界）', bulk.json.data.failed.length, 2);
  ok('失败逐条给出原因', bulk.json.data.failed.every((f) => !!f.error), JSON.stringify(bulk.json.data.failed));

  console.log('\n== IP 管理：改网段 / 删网段的安全阀 ==');
  const shrink = await call('admin', 'PUT', '/api/ipam/segments/' + segId, { cidr: '192.168.77.0/28' });
  eq('缩小掩码把已有登记甩出网段 → 400', shrink.status, 400);
  ok('错误信息点出是哪些地址', /落在网段外/.test(shrink.json.message), shrink.json.message);
  eq('改成更大的掩码 → 200', (await call('admin', 'PUT', '/api/ipam/segments/' + segId, { cidr: '192.168.76.0/23' })).status, 200);
  eq('删除还有登记的网段 → 400', (await call('admin', 'DELETE', '/api/ipam/segments/' + segId)).status, 400);

  console.log('\n== IP 管理：跨网段重叠只提示不拦 ==');
  const s2 = await call('admin', 'POST', '/api/ipam/segments', { name: '全院', cidr: '192.168.0.0/16' });
  const cw = await call('admin', 'POST', '/api/ipam/ips', { segment_id: s2.json.data.id, ip: '192.168.77.5' });
  eq('在全院段里再登记同一地址 → 200', cw.status, 200);
  ok('带出「同时落在别的网段」提示', /同时落在网段/.test(String(cw.json.message)), cw.json.message);
  const segs2 = await call('admin', 'GET', '/api/ipam/segments');
  const big = segs2.json.data.list.filter((x) => x.name === '全院')[0];
  ok('网段列表标出了重叠', big.overlaps.length >= 1, JSON.stringify(big.overlaps));

  console.log('\n== IP 管理：地址分布图（/segments/:id/map） ==');
  const mseg = await call('admin', 'POST', '/api/ipam/segments', { name: '分布图测试', cidr: '10.88.0.0/24' });
  const mId = mseg.json.data.id;
  await call('admin', 'POST', '/api/ipam/ips', { segment_id: mId, ip: '10.88.0.7', hostname: '图-自助机' });
  await call('admin', 'POST', '/api/ipam/ips', { segment_id: mId, ip: '10.88.0.200', status: 'conflict' });

  const mp = await call('admin', 'GET', '/api/ipam/segments/' + mId + '/map');
  eq('取分布图 → 200', mp.status, 200);
  eq('模式 = 逐地址', mp.json.data.mode, 'ip');
  eq('16 列', mp.json.data.cols, 16);
  eq('铺满 256 格（网络地址到广播地址）', mp.json.data.cells.length, 256);
  eq('第 1 格是网络地址，不是可用的空闲格',
    mp.json.data.cells[0].ip + '/' + mp.json.data.cells[0].state, '10.88.0.0/net');
  eq('最后一格是广播地址', mp.json.data.cells[255].state, 'bcast');
  eq('第 8 格（.7）是已使用且格内写 7',
    mp.json.data.cells[7].state + '/' + mp.json.data.cells[7].label, 'used/7');
  ok('已登记格悬停带上主机名', /图-自助机/.test(mp.json.data.cells[7].tip), mp.json.data.cells[7].tip);
  eq('冲突格单独标色', mp.json.data.cells[200].state, 'conflict');
  eq('未登记的格是空闲', mp.json.data.cells[1].state, 'free');
  eq('统计与网段表口径一致：已登记 2', mp.json.data.registered, 2);

  const bigMap = await call('admin', 'GET', '/api/ipam/segments/' + s2.json.data.id + '/map');
  eq('大网段（/16）→ 按 /24 聚合', bigMap.json.data.mode, 'block');
  eq('聚合成 256 块', bigMap.json.data.cells.length, 256);
  ok('聚合格悬停能问出是哪一段 /24', /\/24/.test(bigMap.json.data.cells[0].tip), bigMap.json.data.cells[0].tip);

  eq('不存在的网段取图 → 404', (await call('admin', 'GET', '/api/ipam/segments/99999/map')).status, 404);
  eq('只读角色也能看图（读权限足够）→ 200',
    (await call('viewer', 'GET', '/api/ipam/segments/' + mId + '/map')).status, 200);

  console.log('\n== 只读角色：能看到列表、看不到密码、改不了 ==');
  eq('只读角色读 IP 列表 → 200', (await call('viewer', 'GET', '/api/ipam/ips')).status, 200);
  eq('只读角色读网段 → 200', (await call('viewer', 'GET', '/api/ipam/segments')).status, 200);
  eq('只读角色删 IP → 403', (await call('viewer', 'DELETE', '/api/ipam/ips/1')).status, 403);
  eq('只读角色删网段 → 403', (await call('viewer', 'DELETE', '/api/ipam/segments/' + segId)).status, 403);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) fails.forEach((f) => console.log('  [FAIL] ' + f));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('自测异常：', e);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (er) { /* 忽略 */ }
  process.exit(1);
});
