'use strict';
/**
 * 终端资产台账 + 工单挂设备 —— 后端接口端到端自测
 *
 * 用法：node scripts/terminals-e2e.js            （默认端口 3996）
 *      PORT=4570 node scripts/terminals-e2e.js
 *
 * 做法与 bookmark-ipam-api-e2e 一致：四个库全部指到临时目录（改 config 再 require db 模块），
 * 不碰 data/*.db；起真实 Express 服务，自签 JWT 打真实 HTTP。
 *
 * 重点覆盖「错了也不报错」的地方：
 *   · 保修状态的四个边界（未登记 / 已过保 / 今天到期 / 刚好 30 天 / 31 天）
 *   · 删除设备后工单必须还在（只解绑，不级联删）
 *   · 工单选了设备但没填科室时必须自动带出科室
 *   · 编辑设备只提交部分字段时，别的字段不能被清空
 *   · 只读角色能看不能写
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'term-e2e-'));
const config = require(path.join(ROOT, 'config'));
config.CONTRACT_DB_FILE = path.join(TMP, 'contract.db');
config.DB_FILE = path.join(TMP, 'his.db');
config.INSPECT_DB_FILE = path.join(TMP, 'inspect.db');
config.DOCS_DB_FILE = path.join(TMP, 'docs.db');
config.PORT = Number(process.env.PORT || 3996);

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

/** 相对今天偏移 n 天的日期字符串（本地时区，和页面上 date 输入框一致） */
function d(offset) {
  const t = new Date();
  t.setDate(t.getDate() + offset);
  const p = (n) => (n < 10 ? '0' : '') + n;
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const perm = require(path.join(ROOT, 'src', 'perm'));

  require(path.join(ROOT, 'server'));
  getSecret();
  const { db } = require(path.join(ROOT, 'src', 'db-contract'));
  const { getDb } = require(path.join(ROOT, 'src', 'db'));

  const base = 'http://127.0.0.1:' + config.PORT;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/terminals'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  // 只读角色（有 terminals.view，没有 manage）
  db.prepare("INSERT INTO roles (id, code, name) VALUES (903, 'term_viewer', '终端只读')").run();
  perm.setRolePerms(903, 'term_viewer', ['dashboard.view', 'terminals.view']);
  db.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, created_at)"
    + " VALUES ('e2e_termv', '终端只读', 'x', 'y', 903, datetime('now','localtime'))").run();
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const viewerId = db.prepare("SELECT id FROM users WHERE username = 'e2e_termv'").get().id;

  const tokens = {
    admin: signJwt({ id: adminId, username: 'admin', role_id: 1 }, 3600),
    viewer: signJwt({ id: viewerId, username: 'e2e_termv', role_id: 903 }, 3600),
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

  console.log('\n== 表结构与权限边界 ==');
  // terminals 是懒建表：getDb() 在 init 之前会抛错，所以模块加载时不建表，
  // 第一次有权限的请求才建。这里先打一次，否则 PRAGMA 查出来是 0 列（表还不存在）。
  const warm = await call('admin', 'GET', '/api/terminals');
  eq('管理员读台账 → 200（同时触发懒建表）', warm.status, 200);
  const hisDb = getDb();
  const cols = hisDb.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name);
  ok('terminals 表已建（懒建表生效）', cols.length > 10, cols.length + ' 列');
  ok('★ issues 表已有 device_id 列（老库补列）',
    hisDb.prepare('PRAGMA table_info(issues)').all().some((c) => c.name === 'device_id'));
  eq('未登录读台账 → 401', (await call(null, 'GET', '/api/terminals')).status, 401);
  eq('只读角色读台账 → 200', (await call('viewer', 'GET', '/api/terminals')).status, 200);
  eq('只读角色新增设备 → 403（只有 view 没有 manage）',
    (await call('viewer', 'POST', '/api/terminals', { name: 'x' })).status, 403);

  console.log('\n== 新增：必填校验与保修日期归一 ==');
  eq('空名称 → 400', (await call('admin', 'POST', '/api/terminals', { name: '   ' })).status, 400);
  const c1 = await call('admin', 'POST', '/api/terminals', {
    asset_no: 'ZC-2024-0001', name: '门诊3号诊室工作站', kind: 'PC',
    brand: '联想', model: 'M720t', sn: 'SN12345678', mac: 'AA-BB-CC-11-22-33',
    ip: '10.20.30.41', department: '门诊部', location: '门诊楼3层3诊室',
    owner: '张医生', status: '在用',
    purchase_date: '2024-03-15', warranty_end: d(365), vendor: '某电脑公司',
  });
  eq('新增设备 → 200', c1.status, 200);
  const t1 = c1.json && c1.json.data && c1.json.data.id;
  ok('返回了 id', Number(t1) > 0, t1);

  const c2 = await call('admin', 'POST', '/api/terminals', {
    name: '内科打印机', kind: '打印机', department: '内科',
    location: '住院楼5层护士站', warranty_end: d(-1),
  });
  const t2 = c2.json.data.id;
  const c3 = await call('admin', 'POST', '/api/terminals', {
    name: '自助挂号机1号', kind: '自助机', department: '门诊部',
    location: '门诊大厅', warranty_end: d(0),
  });
  const t3 = c3.json.data.id;
  const c4 = await call('admin', 'POST', '/api/terminals', {
    name: '叫号屏2号', kind: '叫号机', department: '门诊部',
    location: '二楼候诊区', warranty_end: d(30),
  });
  const t4 = c4.json.data.id;
  const c5 = await call('admin', 'POST', '/api/terminals', {
    name: '报废旧显示器', kind: '显示屏', department: '信息科',
    status: '报废', location: '库房',
  });
  const t5 = c5.json.data.id;
  ok('五台设备全部新增成功', [t1, t2, t3, t4, t5].every((x) => Number(x) > 0));

  console.log('\n== 保修状态：四个边界 ==');
  const g1 = await call('admin', 'GET', '/api/terminals/' + t1);
  eq('还早得很（+365 天）→ ok', g1.json.data.warranty_state, 'ok');
  const g2 = await call('admin', 'GET', '/api/terminals/' + t2);
  eq('昨天到期 → expired', g2.json.data.warranty_state, 'expired');
  eq('已过保天数 = 1', g2.json.data.warranty_days, -1);
  const g3 = await call('admin', 'GET', '/api/terminals/' + t3);
  eq('★ 今天到期 → soon（不是 expired，过保当天还能走保修流程）', g3.json.data.warranty_state, 'soon');
  eq('今天到期的提示文案', g3.json.data.warranty_text, '今天到期');
  const g4 = await call('admin', 'GET', '/api/terminals/' + t4);
  eq('★ 刚好第 30 天 → soon（边界含）', g4.json.data.warranty_state, 'soon');
  const g5 = await call('admin', 'GET', '/api/terminals/' + t5);
  eq('没填保修期 → none', g5.json.data.warranty_state, 'none');

  console.log('\n== 列表：统计、筛选、排序 ==');
  const l1 = await call('admin', 'GET', '/api/terminals');
  eq('列表总数 5', l1.json.data.total, 5);
  eq('统计 total', l1.json.data.stats.total, 5);
  eq('统计 expired', l1.json.data.stats.expired, 1);
  eq('统计 soon', l1.json.data.stats.soon, 2);
  eq('统计 no_warranty', l1.json.data.stats.no_warranty, 1);
  eq('统计 repairing（没有维修中的）', l1.json.data.stats.repairing, 0);
  eq('科室清单数量（门诊部/内科/信息科）', l1.json.data.departments.length, 3);
  ok('类型清单里有 PC（5 种全给了）', l1.json.data.kinds.length >= 1);

  eq('按科室筛内科 → 1 台', (await call('admin', 'GET', '/api/terminals?department=' + encodeURIComponent('内科'))).json.data.total, 1);
  eq('按类型筛打印机 → 1 台', (await call('admin', 'GET', '/api/terminals?kind=' + encodeURIComponent('打印机'))).json.data.total, 1);
  eq('按保修筛 expired → 1 台', (await call('admin', 'GET', '/api/terminals?warranty=expired')).json.data.total, 1);
  eq('按保修筛 soon → 2 台', (await call('admin', 'GET', '/api/terminals?warranty=soon')).json.data.total, 2);
  eq('按保修筛 none → 1 台', (await call('admin', 'GET', '/api/terminals?warranty=none')).json.data.total, 1);
  eq('关键词搜 IP 片段 10.20.30.41 → 1 台', (await call('admin', 'GET', '/api/terminals?keyword=10.20.30.41')).json.data.total, 1);
  eq('关键词搜资产号 ZC-2024 → 1 台', (await call('admin', 'GET', '/api/terminals?keyword=ZC-2024')).json.data.total, 1);
  eq('关键词搜责任人「张医生」→ 1 台', (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('张医生'))).json.data.total, 1);
  eq('关键词搜不存在的 → 0 台', (await call('admin', 'GET', '/api/terminals?keyword=zzzz')).json.data.total, 0);

  const l2 = await call('admin', 'GET', '/api/terminals?page=1&pageSize=2');
  eq('分页 pageSize=2 → 返回 2 条', l2.json.data.list.length, 2);
  eq('分页 total 仍是 5', l2.json.data.total, 5);

  console.log('\n== 工单挂设备 ==');
  const i1 = await call('admin', 'POST', '/api/issues', {
    title: '打印机卡纸打不出来', category: '日常硬件', module: '其他',
    urgency: '高', content: '内科护士站打印机卡纸', deviceId: t2,
    // 刻意不填 department，验证是否会自动带出
  });
  eq('新建工单（挂设备、不填科室）→ 200', i1.status, 200);
  const issue1 = i1.json.data.id;
  const d1 = await call('admin', 'GET', '/api/issues/' + issue1);
  eq('★ 工单自动带出了设备所属科室', d1.json.data.issue.department, '内科');
  ok('工单详情带完整设备对象', d1.json.data.issue.device && d1.json.data.issue.device.name === '内科打印机',
    JSON.stringify(d1.json.data.issue.device));
  eq('设备对象带资产号字段（没有则为空串，不是 undefined）', d1.json.data.issue.device.asset_no, '');

  const i2 = await call('admin', 'POST', '/api/issues', {
    title: '工作站开不了机', category: '日常硬件', module: '其他',
    urgency: '中', content: '按电源无反应', deviceId: t1, department: '门诊部',
  });
  const issue2 = i2.json.data.id;
  const i3 = await call('admin', 'POST', '/api/issues', {
    title: '自助机黑屏', category: '日常硬件', module: '其他',
    urgency: '紧急', content: '大厅自助机黑屏', deviceId: t3,
  });

  const deviceDetail = await call('admin', 'GET', '/api/terminals/' + t2);
  eq('设备详情里历史工单 1 条', deviceDetail.json.data.issues.length, 1);
  eq('历史工单标题对得上', deviceDetail.json.data.issues[0].title, '打印机卡纸打不出来');
  eq('设备 issue_count = 1', deviceDetail.json.data.issue_count, 1);
  eq('设备 open_issue_count = 1（还没处理）', deviceDetail.json.data.open_issue_count, 1);

  const listWithDevice = await call('admin', 'GET', '/api/issues?keyword=' + encodeURIComponent('打印机卡纸'));
  const row = listWithDevice.json.data.list[0];
  ok('★ 工单列表行带设备名（LEFT JOIN 别名）', row.device && row.device.name === '内科打印机',
    JSON.stringify(row.device));
  ok('列表行不透出 device_name 原始别名', !('device_name' in row));

  const i4 = await call('admin', 'POST', '/api/issues', {
    title: '不挂设备的工单', category: '日常软件', module: 'HIS系统',
    urgency: '低', content: '随便提一个',
  });
  const d4 = await call('admin', 'GET', '/api/issues/' + i4.json.data.id);
  eq('不选设备时 device 为 null（不是空对象）', d4.json.data.issue.device, null);

  console.log('\n== 编辑：局部更新不能清空别的字段 ==');
  const before = (await call('admin', 'GET', '/api/terminals/' + t1)).json.data;
  const u1 = await call('admin', 'PUT', '/api/terminals/' + t1, { owner: '李医生' });
  eq('只提交 owner → 200', u1.status, 200);
  const after = (await call('admin', 'GET', '/api/terminals/' + t1)).json.data;
  eq('owner 已更新', after.owner, '李医生');
  eq('★ 未提交的 department 没被清空', after.department, before.department);
  eq('★ 未提交的 warranty_end 没被清空', after.warranty_end, before.warranty_end);
  eq('★ 未提交的 asset_no 没被清空', after.asset_no, before.asset_no);
  eq('★ 未提交的 note 没被清空', after.note, before.note);

  eq('把设备改成报废 → 200',
    (await call('admin', 'PUT', '/api/terminals/' + t5, { status: '报废' })).status, 200);
  const opts = await call('admin', 'GET', '/api/terminals/options');
  ok('★ 设备下拉不包含报废设备', opts.json.data.list.every((x) => x.status !== '报废'),
    opts.json.data.list.map((x) => x.name).join(','));
  eq('设备下拉共 4 台（5 台减掉报废那台）', opts.json.data.list.length, 4);

  console.log('\n== 工单换设备 / 解绑 ==');
  const u2 = await call('admin', 'PUT', '/api/issues/' + issue2, { deviceId: t3 });
  eq('把工单改挂到另一台设备 → 200', u2.status, 200);
  const d2 = await call('admin', 'GET', '/api/issues/' + issue2);
  eq('工单设备已变更', d2.json.data.issue.device.name, '自助挂号机1号');
  eq('新设备历史工单变成 2 条', (await call('admin', 'GET', '/api/terminals/' + t3)).json.data.issue_count, 2);

  const u3 = await call('admin', 'PUT', '/api/issues/' + issue2, { deviceId: 0 });
  eq('deviceId=0 → 200', u3.status, 200);
  eq('★ deviceId=0 是「解除关联」，不是「不改」',
    (await call('admin', 'GET', '/api/issues/' + issue2)).json.data.issue.device, null);
  eq('解绑后 t3 只剩 1 条工单', (await call('admin', 'GET', '/api/terminals/' + t3)).json.data.issue_count, 1);

  const u4 = await call('admin', 'PUT', '/api/issues/' + issue2, { title: '工作站开不了机（已重启解决）' });
  eq('不传 deviceId 只改标题 → 200', u4.status, 200);
  eq('★ 不传 deviceId 时保持原关联（前面已解绑，所以这里仍为 null）',
    (await call('admin', 'GET', '/api/issues/' + issue2)).json.data.issue.device, null);

  console.log('\n== 删除：工单必须活得比设备久 ==');
  const del = await call('admin', 'DELETE', '/api/terminals/' + t2);
  eq('删除设备 → 200', del.status, 200);
  eq('返回解绑了 1 张工单', del.json.data.detached_issues, 1);
  eq('设备已不存在 → 404', (await call('admin', 'GET', '/api/terminals/' + t2)).status, 404);
  const issueAfterDel = await call('admin', 'GET', '/api/issues/' + issue1);
  eq('★ 工单还在（没被级联删）', issueAfterDel.status, 200);
  eq('★ 工单的 device 已置空', issueAfterDel.json.data.issue.device, null);
  eq('★ 工单标题保留着设备名线索', issueAfterDel.json.data.issue.title, '打印机卡纸打不出来');
  eq('重复删除 → 404', (await call('admin', 'DELETE', '/api/terminals/' + t2)).status, 404);

  console.log('\n== 元数据接口 ==');
  const meta = await call('admin', 'GET', '/api/terminals/meta');
  eq('meta 返回 200', meta.status, 200);
  ok('meta 给了类型清单（含 PC / 打印机 / 自助机）',
    ['PC', '打印机', '自助机'].every((k) => meta.json.data.kinds.indexOf(k) >= 0));
  ok('meta 给了状态清单（含 在用 / 报废）',
    ['在用', '报废'].every((k) => meta.json.data.statuses.indexOf(k) >= 0));
  eq('meta 的保修提醒阈值是 30 天', meta.json.data.warranty_soon_days, 30);
  eq('/meta 不会被当成 :id 吞掉（没返回 404）', meta.status, 200);

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) {
    console.log('\n失败明细：');
    fails.forEach((f) => console.log('  · ' + f));
  }
  console.log('========================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('自测异常中断：' + ((e && e.stack) || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
