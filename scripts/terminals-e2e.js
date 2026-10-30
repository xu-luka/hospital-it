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

  console.log('\n== Excel 导入 / 导出 ==');
  const XLSX = require(path.join(ROOT, 'node_modules', 'xlsx'));

  /** multipart 上传（Node 22 自带 FormData/Blob，不用额外依赖） */
  async function upload(who, url, buf, name) {
    const fd = new FormData();
    fd.append('file', new Blob([buf]), name || 'test.xlsx');
    const headers = {};
    if (who) headers.Authorization = 'Bearer ' + tokens[who];
    const res = await fetch(base + url, { method: 'POST', headers, body: fd });
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    return { status: res.status, json, raw: JSON.stringify(json) };
  }

  // 造一份结构与院里那份台账一致的样例：两个 sheet 列数不同，外加一个「填写说明」表
  const PC_HEADER = ['院区', '资产编码', '区域', '楼层', '科室', '位置', '统计类别', '设备性质',
    '工作组/计算机名', '内网地址', '外网地址', 'MAC', 'SN码', '生产日期', '型号',
    '操作系统', 'CPU', '硬盘', '内存', '显示器尺寸'];
  const PRT_HEADER = ['院区', '资产编码', '区域', '楼层', '科室', '位置', '统计类别', '设备性质',
    '内网地址', '外网地址', 'MAC', 'SN码', '生产日期', '型号', '耗材型号'];

  const pcRows = [
    PC_HEADER,
    ['珠江街道', '0104020101620', '门诊楼', '三楼', '财务科', '医生办（一）', '台式计算机', '政府采购设备',
      'PC-20180817RHBE', '200.100.60.34', '10.10.10.248', '80-3F-5D-08-F9-55', 'M706TL9J', '2018-06-02',
      '启天M410-N000', 'Windows 10', 'Intel Core i5-7500', '256G+1T', 'DDR4 - 8G', "Lenovo-LCD 20'"],
    ['珠江街道', '-', '医技楼', '二楼', '检验科', 'LIS 工作站', '台式计算机', '租赁设备',
      'DESKTOP-3TQGIDB', '200.100.60.25', '-', '内网：F4-6B-8C-02-80-48', 'ABC12345', '2021-10-02',
      'Dell OptiPlex 3080', 'Windows 7', 'Intel Pentium G4500', '500G', 'DDR3 - 8G', "Hp-LCD 24'"],
  ];
  const prtRows = [
    PRT_HEADER,
    ['珠江街道', '0104020101686', '住院楼', '三楼', '住院儿科', '护士站（一）', '黑白打印机', '租赁设备',
      '200.100.60.37', '-', '04-0E-3C-E2-A6-14', 'B6S01A', '2023-07-10', 'Epson M101', 'T7741'],
    ['珠江街道', '-', '住院楼', '三楼', '住院儿科', '护士站（二）', '二维码扫描枪', '设备自带',
      '-', '-', 'F8:D0:27:20:56:0C', '-', '-', '科密 YX-18+', '-'],
  ];

  function buildBook() {
    const wb = XLSX.utils.book_new();
    const mk = (rows) => {
      const ws = XLSX.utils.aoa_to_sheet(rows);
      return ws;
    };
    XLSX.utils.book_append_sheet(wb, mk(pcRows), '计算机');
    XLSX.utils.book_append_sheet(wb, mk(prtRows), '打印机');
    XLSX.utils.book_append_sheet(wb, mk([['填写说明'], ['这是说明表，没有台账字段，应被跳过']]), '填写说明');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const beforeTotal = (await call('admin', 'GET', '/api/terminals')).json.data.stats.total;

  const dry = await upload('admin', '/api/terminals/import?dryRun=1', buildBook());
  eq('预导入（dryRun）→ 200', dry.status, 200);
  eq('预导入识别出 4 条', dry.json.data.total, 4);
  eq('预导入报告新增 4 条', dry.json.data.created, 4);
  eq('★ dryRun 不落库：总数没变', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal);
  eq('★ 没被认出的「填写说明」表被跳过', (dry.json.data.sheets_scanned || []).filter((s) => s.skipped).length, 1);

  const imp = await upload('admin', '/api/terminals/import', buildBook());
  eq('正式导入 → 200', imp.status, 200);
  eq('新增 4 条', imp.json.data.created, 4);
  eq('总数 +4', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal + 4);

  const fin = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('PC-20180817RHBE'))).json.data.list[0];
  eq('★ 计算机行：统计类别原样保留', fin.stat_category, '台式计算机');
  eq('★ 类型由统计类别推导（台式计算机 → PC）', fin.kind, 'PC');
  eq('院区 / 区域 / 楼层都落库', [fin.campus, fin.area, fin.floor].join('|'), '珠江街道|门诊楼|三楼');
  eq('工作组/计算机名落库', fin.hostname, 'PC-20180817RHBE');
  eq('内外网两个地址分开存', fin.ip + '|' + fin.ip_extra, '200.100.60.34|10.10.10.248');
  eq('生产日期规范化成 YYYY-MM-DD', fin.produce_date, '2018-06-02');
  eq('硬件明细落库（CPU/硬盘/内存/显示器）',
    [fin.cpu, fin.disk, fin.ram, fin.monitor].join(' | '),
    "Intel Core i5-7500 | 256G+1T | DDR4 - 8G | Lenovo-LCD 20'");
  eq('设备名称由「科室+位置」自动拼', fin.name, '财务科 医生办（一）');

  const prt = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('护士站（一）'))).json.data.list[0];
  eq('打印机行：耗材型号落库', prt.consumable, 'T7741');
  eq('打印机的类型归到「打印机」', prt.kind, '打印机');

  const dash = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('LIS 工作站'))).json.data.list[0];
  eq('★ 「-」按空处理（资产编码）', dash.asset_no, '');
  eq('★ MAC 的「内网：」前缀被剥掉并统一成横杠', dash.mac, 'F4-6B-8C-02-80-48');
  eq('★ 冒号分隔的 MAC 也归一成横杠', (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('科密'))).json.data.list[0].mac,
    'F8-D0-27-20-56-0C');
  eq('扫码枪的类型靠「扫描」识别', (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('科密'))).json.data.list[0].kind, '扫码枪');

  const again = await upload('admin', '/api/terminals/import', buildBook());
  eq('★ 同一份再导一次：0 新增', again.json.data.created, 0);
  eq('★ 同一份再导一次：4 条全部「无变化」', again.json.data.unchanged, 4);
  eq('★ 没有产生重复记录', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal + 4);

  // 改一处位置再导：应更新而不是新增；空的单元格不能把已有值洗掉
  const changedRows = pcRows.map((r) => r.slice());
  changedRows[1][5] = '医生办（二）';
  changedRows[1][8] = '';           // 计算机名留空 → 不许把已有的 PC-20180817RHBE 清掉
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(changedRows), '计算机');
  const upd = await upload('admin', '/api/terminals/import', XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }));
  eq('改位置后导入：不新增', upd.json.data.created, 0);
  eq('改位置后导入：更新 1 条', upd.json.data.updated, 1);
  const afterUpd = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('PC-20180817RHBE'))).json.data.list[0];
  eq('位置已更新', afterUpd.location, '医生办（二）');
  eq('★ 空单元格没有洗掉已有值（计算机名还在）', afterUpd.hostname, 'PC-20180817RHBE');
  ok('更新明细里列出了「位置」',
    (upd.json.data.samples || []).some((s) => (s.changed || []).indexOf('位置') >= 0));

  // MAC 换个写法（冒号）再导，不该被当成新设备
  const colonRows = prtRows.map((r) => r.slice());
  colonRows[1][10] = '04:0e:3c:e2:a6:14';
  const wb3 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb3, XLSX.utils.aoa_to_sheet(colonRows), '打印机');
  const colon = await upload('admin', '/api/terminals/import', XLSX.write(wb3, { type: 'buffer', bookType: 'xlsx' }));
  eq('★ MAC 换写法后仍然认出是同一台（0 新增）', colon.json.data.created, 0);
  eq('★ 认出来之后算「无变化」', colon.json.data.unchanged, 2);

  const skipMode = await upload('admin', '/api/terminals/import?mode=skip', buildBook());
  eq('mode=skip：0 新增', skipMode.json.data.created, 0);
  eq('mode=skip：4 条全部跳过', skipMode.json.data.skipped, 4);

  const badFile = await upload('admin', '/api/terminals/import', Buffer.from('这不是 excel'), 'bad.xlsx');
  eq('乱传一个文件 → 400', badFile.status, 400);
  const noData = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(noData, XLSX.utils.aoa_to_sheet([['院区'], ['珠江街道']]), '空表');
  const emptyIm = await upload('admin', '/api/terminals/import', XLSX.write(noData, { type: 'buffer', bookType: 'xlsx' }));
  eq('只有「院区」没有数据行 → 400 并说明原因', emptyIm.status, 400);

  // ---- 模板 / 导出 ----
  const tpl = await call('admin', 'GET', '/api/terminals/template');
  eq('模板下载 → 200', tpl.status, 200);
  const exRes = await fetch(base + '/api/terminals/export', { headers: { Authorization: 'Bearer ' + tokens.admin } });
  eq('导出 → 200', exRes.status, 200);
  ok('导出返回 xlsx 的 Content-Type',
    String(exRes.headers.get('content-type') || '').indexOf('spreadsheetml') >= 0);
  ok('导出文件名带日期',
    decodeURIComponent(String(exRes.headers.get('content-disposition') || '')).indexOf('.xlsx') > 0);
  const exBuf = Buffer.from(await exRes.arrayBuffer());
  const exWb = XLSX.read(exBuf, { type: 'buffer', cellDates: true });
  const exAoa = XLSX.utils.sheet_to_json(exWb.Sheets[exWb.SheetNames[0]], { header: 1, defval: '' });
  const exHead = exAoa[0].map((h) => String(h).trim());
  ok('★ 导出表头与 Excel 台账列名一致（院区/统计类别/工作组/计算机名/MAC/SN码…）',
    ['院区', '资产编码', '区域', '楼层', '科室', '位置', '统计类别', '设备性质',
      '工作组/计算机名', '内网地址', '外网地址', 'MAC', 'SN码', '生产日期', '型号',
      '操作系统', 'CPU', '硬盘', '内存', '显示器尺寸', '耗材型号'].every((h) => exHead.indexOf(h) >= 0));
  eq('导出行数 = 表头 + 全量台账', exAoa.length - 1, (await call('admin', 'GET', '/api/terminals')).json.data.stats.total);
  const exPc = exAoa.find((r) => r[exHead.indexOf('工作组/计算机名')] === 'PC-20180817RHBE');
  ok('导出里能找到刚导进来的那台', !!exPc);
  eq('导出保留了「统计类别」原词', exPc[exHead.indexOf('统计类别')], '台式计算机');

  // 导出再导入：应全部「无变化」（round-trip 不产生重复）
  const roundTrip = await upload('admin', '/api/terminals/import?dryRun=1', exBuf, 'roundtrip.xlsx');
  eq('★ 导出文件原样再导入：0 新增', roundTrip.json.data.created, 0);
  eq('★ 导出文件原样再导入：全部无变化', roundTrip.json.data.updated, 0);

  const viewerImp = await upload('viewer', '/api/terminals/import', buildBook());
  eq('★ 只读角色导入 → 403', viewerImp.status, 403);

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
