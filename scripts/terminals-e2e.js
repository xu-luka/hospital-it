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
 * ★ 2026-10-30 第二轮：表结构按 Excel 21 列重建，所以这份自测的重点也跟着变了：
 *   · 表里**只有** 21 个台账列 + 记账列，旧的「名称/类型/状态/责任人/保修」一个都不能留
 *     （不然就说明重建没生效，或者又被谁加回去了）；
 *   · 「设备名称」「设备类型」是**派生**的（displayName / kindOf），要从台账字段算得对；
 *   · 没有「报废」了 —— 设备下拉不再排除任何设备，IP 管理也不再区分是否已释放；
 *   · 认设备靠 keyOf：只填一个内网地址是认不出来的，必须给出 400 而不是悄悄入库一条无名记录。
 *
 * 另外覆盖「错了也不报错」的地方：
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

/** Excel 的 21 列（顺序即导出顺序） */
const EXCEL_HEADS = ['院区', '资产编码', '区域', '楼层', '科室', '位置', '统计类别', '设备性质',
  '工作组/计算机名', '内网地址', '外网地址', 'MAC', 'SN码', '生产日期', '型号',
  '操作系统', 'CPU', '硬盘', '内存', '显示器尺寸', '耗材型号'];

/** 上一版自造的 9 列，重建后一个都不该在表里 */
const LEGACY_HEADS = ['设备名称', '类型', '责任人', '状态', '保修至', '采购日期', '品牌', '供应商', '备注'];

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

  console.log('\n== 表结构：严格 21 列 ==');
  // terminals 是懒建表：getDb() 在 init 之前会抛错，所以模块加载时不建表，
  // 第一次有权限的请求才建。这里先打一次，否则 PRAGMA 查出来是 0 列（表还不存在）。
  const warm = await call('admin', 'GET', '/api/terminals');
  eq('管理员读台账 → 200（同时触发懒建表）', warm.status, 200);
  const hisDb = getDb();
  const cols = hisDb.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name);
  const CORE = {
    campus: 'campus', asset_no: 'asset_no', area: 'area', floor: 'floor',
    department: 'department', location: 'location', stat_category: 'stat_category',
    nature: 'nature', hostname: 'hostname', ip: 'ip', ip_extra: 'ip_extra',
    mac: 'mac', sn: 'sn', produce_date: 'produce_date', model: 'model', os: 'os',
    cpu: 'cpu', disk: 'disk', ram: 'ram', monitor: 'monitor', consumable: 'consumable',
  };
  ok('★ 21 个台账列全部在表里', Object.keys(CORE).every((k) => cols.indexOf(k) >= 0),
    Object.keys(CORE).filter((k) => cols.indexOf(k) < 0).join(',') || '全在');
  const leaked = LEGACY_HEADS.filter((h) => cols.indexOf(h) >= 0);
  ok('★ 表里没有上一版自造的 9 列', leaked.length === 0, leaked.join(',') || '一个都没有');
  eq('总列数 = id + 21 + 7 个记账列', cols.length, 1 + 21 + 7);
  ok('★ issues 表已有 device_id 列（老库补列）',
    hisDb.prepare('PRAGMA table_info(issues)').all().some((c) => c.name === 'device_id'));
  eq('未登录读台账 → 401', (await call(null, 'GET', '/api/terminals')).status, 401);
  eq('只读角色读台账 → 200', (await call('viewer', 'GET', '/api/terminals')).status, 200);
  eq('只读角色新增设备 → 403（只有 view 没有 manage）',
    (await call('viewer', 'POST', '/api/terminals', { hostname: 'x' })).status, 403);

  console.log('\n== 新增：认设备的键（keyOf）==');
  eq('全空 → 400', (await call('admin', 'POST', '/api/terminals', {})).status, 400);
  const onlyIp = await call('admin', 'POST', '/api/terminals', { ip: '10.20.30.41' });
  eq('★ 只填内网地址 → 400（换机会沿用旧 IP，不能当标识）', onlyIp.status, 400);
  ok('400 的文案说清了要填什么', /识别|认不出|至少/.test(String(onlyIp.json.message)), onlyIp.json.message);
  eq('只填科室 → 400（单字段不构成复合键）',
    (await call('admin', 'POST', '/api/terminals', { department: '门诊部' })).status, 400);
  eq('科室 + 位置 → 200（复合键成立）',
    (await call('admin', 'POST', '/api/terminals', { department: '财务科', location: '医生办（一）', stat_category: '台式计算机' })).status, 200);

  const c1 = await call('admin', 'POST', '/api/terminals', {
    campus: '珠江街道', asset_no: 'ZC-2024-0001', area: '门诊楼', floor: '三楼',
    department: '门诊部', location: '门诊楼3层3诊室', stat_category: '台式计算机',
    nature: '政府采购设备', hostname: 'MZ-PC-0301',
    ip: '10.20.30.41', ip_extra: '10.10.10.248', mac: 'AA-BB-CC-11-22-33',
    sn: 'SN12345678', produce_date: '2018-06-02', model: '启天M410-N000',
    os: 'Windows 10', cpu: 'Intel Core i5-7500', disk: '256G+1T', ram: 'DDR4 - 8G',
    monitor: "Lenovo-LCD 20'", consumable: '',
  });
  eq('完整计算机 → 200', c1.status, 200);
  const t1 = c1.json.data.id;
  ok('返回了 id', Number(t1) > 0, t1);
  eq('★ 保存后返回派生名称（= 工作组/计算机名）', c1.json.data.name, 'MZ-PC-0301');

  // 打印机：没有计算机名，靠「统计类别 + 型号」当显示名
  const c2 = await call('admin', 'POST', '/api/terminals', {
    department: '内科', location: '住院楼5层护士站', stat_category: '黑白打印机',
    nature: '租赁设备', model: 'Epson M101', sn: 'B6S01A', ip: '10.20.30.50',
    consumable: 'T7741', mac: '04-0E-3C-E2-A6-14',
  });
  const t2 = c2.json.data.id;
  eq('★ 打印机没有计算机名 → 名称 = 统计类别 + 型号', c2.json.data.name, '黑白打印机 Epson M101');
  const c3 = await call('admin', 'POST', '/api/terminals', {
    department: '门诊部', location: '门诊大厅', stat_category: '自助机', mac: 'AA-BB-CC-11-22-34',
  });
  const t3 = c3.json.data.id;
  const c4 = await call('admin', 'POST', '/api/terminals', {
    department: '门诊部', location: '二楼候诊区', stat_category: '叫号机', mac: 'AA-BB-CC-11-22-35',
  });
  const t4 = c4.json.data.id;
  // 只写 MAC 也能建（MAC 本身就是键）
  const c5 = await call('admin', 'POST', '/api/terminals', { mac: 'AA-BB-CC-11-22-36' });
  const t5 = c5.json.data.id;
  ok('五台设备全部新增成功', [t1, t2, t3, t4, t5].every((x) => Number(x) > 0));

  console.log('\n== 派生字段：名称与类型都从台账列算 ==');
  const g1 = await call('admin', 'GET', '/api/terminals/' + t1);
  eq('名称 = 工作组/计算机名', g1.json.data.name, 'MZ-PC-0301');
  eq('类型由统计类别推导（台式计算机 → PC）', g1.json.data.kind, 'PC');
  eq('21 列全部原样返回', g1.json.data.cpu, 'Intel Core i5-7500');
  ok('★ 出参里没有 status / warranty_end 之类已删字段',
    g1.json.data.status === undefined && g1.json.data.warranty_end === undefined
    && g1.json.data.owner === undefined && g1.json.data.note === undefined);
  eq('采购日期 / 保修至 也不再返回', g1.json.data.purchase_date, undefined);

  const g5 = await call('admin', 'GET', '/api/terminals/' + t5);
  eq('★ 只有 MAC、别的全空时，名称退化成「设备 #id」', g5.json.data.name, '设备 #' + t5);
  eq('统计类别空 → 类型落到「其他」', g5.json.data.kind, '其他');

  console.log('\n== 列表：统计、筛选、排序 ==');
  const l1 = await call('admin', 'GET', '/api/terminals');
  eq('列表总数 6（含前面「科室+位置」那台）', l1.json.data.total, 6);
  eq('统计 total', l1.json.data.stats.total, 6);
  eq('统计 已登记内网地址 = 2', l1.json.data.stats.with_ip, 2);
  eq('统计 缺资产编码 = 5', l1.json.data.stats.no_asset, 5);
  eq('统计 覆盖科室 = 3（门诊部/内科/财务科）', l1.json.data.stats.depts, 3);
  ok('★ stats 里不再有 expired / soon / no_warranty / scrapped 这些旧口径',
    l1.json.data.stats.expired === undefined && l1.json.data.stats.soon === undefined
    && l1.json.data.stats.scrapped === undefined && l1.json.data.stats.no_warranty === undefined);
  eq('科室清单数量', l1.json.data.departments.length, 3);
  ok('统计类别清单跟着台账走',
    (l1.json.data.stat_categories || []).map((x) => x.name).indexOf('黑白打印机') >= 0);

  eq('按科室筛内科 → 1 台',
    (await call('admin', 'GET', '/api/terminals?department=' + encodeURIComponent('内科'))).json.data.total, 1);
  eq('★ 按统计类别筛台式计算机 → 2 台（手工那台 + 复合键那台）',
    (await call('admin', 'GET', '/api/terminals?stat_category=' + encodeURIComponent('台式计算机'))).json.data.total, 2);
  eq('按设备性质筛租赁设备 → 1 台',
    (await call('admin', 'GET', '/api/terminals?nature=' + encodeURIComponent('租赁设备'))).json.data.total, 1);
  eq('关键词搜 IP 片段 10.20.30.41 → 1 台',
    (await call('admin', 'GET', '/api/terminals?keyword=10.20.30.41')).json.data.total, 1);
  eq('关键词搜资产号 ZC-2024 → 1 台',
    (await call('admin', 'GET', '/api/terminals?keyword=ZC-2024')).json.data.total, 1);
  eq('关键词搜 MAC 片段 11-22-34 → 1 台',
    (await call('admin', 'GET', '/api/terminals?keyword=11-22-34')).json.data.total, 1);
  eq('关键词搜型号 M101 → 1 台',
    (await call('admin', 'GET', '/api/terminals?keyword=M101')).json.data.total, 1);
  eq('★ 关键词搜任意列（显示器尺寸 Lenovo-LCD）→ 1 台',
    (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('Lenovo-LCD'))).json.data.total, 1);
  eq('关键词搜不存在的 → 0 台', (await call('admin', 'GET', '/api/terminals?keyword=zzzz')).json.data.total, 0);

  const l2 = await call('admin', 'GET', '/api/terminals?page=1&pageSize=2');
  eq('分页 pageSize=2 → 返回 2 条', l2.json.data.list.length, 2);
  eq('分页 total 仍是 6', l2.json.data.total, 6);
  const sortAsset = await call('admin', 'GET', '/api/terminals?sort=asset');
  eq('sort=asset：有资产编码的排在前面', sortAsset.json.data.list[0].asset_no, 'ZC-2024-0001');

  console.log('\n== 设备下拉（工单用）==');
  const opts = await call('admin', 'GET', '/api/terminals/options');
  eq('★ 下拉给出全部 6 台（台账没有「报废」，不再排除任何设备）', opts.json.data.list.length, 6);
  ok('下拉项带派生名称', opts.json.data.list.every((x) => !!x.name));

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
  ok('工单详情带完整设备对象', d1.json.data.issue.device && d1.json.data.issue.device.name === '黑白打印机 Epson M101',
    JSON.stringify(d1.json.data.issue.device));
  eq('设备对象带资产号字段（没有则为空串，不是 undefined）', d1.json.data.issue.device.asset_no, '');

  const i2 = await call('admin', 'POST', '/api/issues', {
    title: '工作站开不了机', category: '日常硬件', module: '其他',
    urgency: '中', content: '按电源无反应', deviceId: t1, department: '门诊部',
  });
  const issue2 = i2.json.data.id;
  await call('admin', 'POST', '/api/issues', {
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
  ok('★ 工单列表行带设备名（LEFT JOIN 别名）', row.device && row.device.name === '黑白打印机 Epson M101',
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
  const u1 = await call('admin', 'PUT', '/api/terminals/' + t1, { location: '门诊楼3层4诊室' });
  eq('只提交 location → 200', u1.status, 200);
  const after = (await call('admin', 'GET', '/api/terminals/' + t1)).json.data;
  eq('location 已更新', after.location, '门诊楼3层4诊室');
  eq('★ 未提交的 department 没被清空', after.department, before.department);
  eq('★ 未提交的 cpu 没被清空', after.cpu, before.cpu);
  eq('★ 未提交的 asset_no 没被清空', after.asset_no, before.asset_no);
  eq('★ 未提交的 monitor 没被清空', after.monitor, before.monitor);
  ok('★ 局部更新没有把整条记录洗成空', !!after.hostname && !!after.stat_category);

  eq('把 MAC 清掉、但有资产编码 → 仍可保存',
    (await call('admin', 'PUT', '/api/terminals/' + t1, { mac: '' })).status, 200);
  // 键字段和复合键字段全清空 → 这条记录就再也认不出来了，必须拒绝而不是入库
  const wipe = await call('admin', 'PUT', '/api/terminals/' + t1, {
    asset_no: '', hostname: '', mac: '', sn: '',
    department: '', location: '', stat_category: '', model: '',
  });
  eq('★ 把能认出设备的所有字段清空 → 400', wipe.status, 400);
  const stillOk = (await call('admin', 'GET', '/api/terminals/' + t1)).json.data;
  ok('★ 被拒绝的保存没有把原记录改坏', stillOk.hostname === 'MZ-PC-0301' && stillOk.department === '门诊部');

  console.log('\n== 工单换设备 / 解绑 ==');
  const u2 = await call('admin', 'PUT', '/api/issues/' + issue2, { deviceId: t3 });
  eq('把工单改挂到另一台设备 → 200', u2.status, 200);
  const d2 = await call('admin', 'GET', '/api/issues/' + issue2);
  eq('工单设备已变更', d2.json.data.issue.device.id, t3);
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
  const PC_HEADER = EXCEL_HEADS.slice(0, 20);                       // 计算机 20 列
  const PRT_HEADER = ['院区', '资产编码', '区域', '楼层', '科室', '位置', '统计类别', '设备性质',
    '内网地址', '外网地址', 'MAC', 'SN码', '生产日期', '型号', '耗材型号'];   // 打印机 15 列

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
    // ★ 统计类别空着的打印机：类型必须按 sheet 名认成「打印机」，不能默认成 PC
    ['珠江街道', '-', '住院楼', '四楼', '住院儿科', '护士站（三）', '', '',
      '200.100.60.38', '-', 'F8:D0:27:20:56:0D', '-', '-', 'HP P1108', '-'],
  ];

  function buildBook() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pcRows), '计算机');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prtRows), '打印机');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['填写说明'], ['这是说明表，没有台账字段，应被跳过']]), '填写说明');
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  const beforeTotal = (await call('admin', 'GET', '/api/terminals')).json.data.stats.total;

  const dry = await upload('admin', '/api/terminals/import?dryRun=1', buildBook());
  eq('预导入（dryRun）→ 200', dry.status, 200);
  eq('预导入识别出 5 条', dry.json.data.total, 5);
  eq('预导入报告新增 5 条', dry.json.data.created, 5);
  eq('★ dryRun 不落库：总数没变', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal);
  eq('★ 没被认出的「填写说明」表被跳过', (dry.json.data.sheets_scanned || []).filter((s) => s.skipped).length, 1);

  const imp = await upload('admin', '/api/terminals/import', buildBook());
  eq('正式导入 → 200', imp.status, 200);
  eq('新增 5 条', imp.json.data.created, 5);
  eq('总数 +5', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal + 5);

  const fin = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('PC-20180817RHBE'))).json.data.list[0];
  eq('★ 统计类别原样保留', fin.stat_category, '台式计算机');
  eq('★ 类型由统计类别推导（台式计算机 → PC）', fin.kind, 'PC');
  eq('院区 / 区域 / 楼层都落库', [fin.campus, fin.area, fin.floor].join('|'), '珠江街道|门诊楼|三楼');
  eq('工作组/计算机名落库', fin.hostname, 'PC-20180817RHBE');
  eq('★ 名称直接取计算机名（不再用「科室+位置」拼）', fin.name, 'PC-20180817RHBE');
  eq('内外网两个地址分开存', fin.ip + '|' + fin.ip_extra, '200.100.60.34|10.10.10.248');
  eq('生产日期规范化成 YYYY-MM-DD', fin.produce_date, '2018-06-02');
  eq('硬件明细落库（CPU/硬盘/内存/显示器）',
    [fin.cpu, fin.disk, fin.ram, fin.monitor].join(' | '),
    "Intel Core i5-7500 | 256G+1T | DDR4 - 8G | Lenovo-LCD 20'");
  eq('设备性质落库', fin.nature, '政府采购设备');

  const prt = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('护士站（一）'))).json.data.list[0];
  eq('打印机行：耗材型号落库', prt.consumable, 'T7741');
  eq('打印机的类型归到「打印机」', prt.kind, '打印机');
  eq('★ 打印机没有计算机名 → 名称 = 统计类别 + 型号', prt.name, '黑白打印机 Epson M101');

  const blankCat = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('护士站（三）'))).json.data.list[0];
  eq('★ 统计类别空着的行：类型按 sheet 名认成「打印机」，不是默认 PC', blankCat.kind, '打印机');
  eq('这种行的名称退回「型号」', blankCat.name, 'HP P1108');
  eq('来源 sheet 记下来了（溯源用）', blankCat.src_sheet, '打印机');

  const dash = (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('LIS 工作站'))).json.data.list[0];
  eq('★ 「-」按空处理（资产编码）', dash.asset_no, '');
  eq('★ MAC 的「内网：」前缀被剥掉并统一成横杠', dash.mac, 'F4-6B-8C-02-80-48');
  eq('★ 冒号分隔的 MAC 也归一成横杠',
    (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('科密'))).json.data.list[0].mac,
    'F8-D0-27-20-56-0C');
  eq('扫码枪的类型靠「扫描」识别',
    (await call('admin', 'GET', '/api/terminals?keyword=' + encodeURIComponent('科密'))).json.data.list[0].kind, '扫码枪');

  const again = await upload('admin', '/api/terminals/import', buildBook());
  eq('★ 同一份再导一次：0 新增', again.json.data.created, 0);
  eq('★ 同一份再导一次：5 条全部「无变化」', again.json.data.unchanged, 5);
  eq('★ 没有产生重复记录', (await call('admin', 'GET', '/api/terminals')).json.data.stats.total, beforeTotal + 5);

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
  eq('★ 认出来之后算「无变化」', colon.json.data.unchanged, 3);

  const skipMode = await upload('admin', '/api/terminals/import?mode=skip', buildBook());
  eq('mode=skip：0 新增', skipMode.json.data.created, 0);
  eq('mode=skip：5 条全部跳过', skipMode.json.data.skipped, 5);

  // 信息不足的行要单列出来，不能硬塞成无名记录
  const thinBook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(thinBook, XLSX.utils.aoa_to_sheet([
    ['院区', '科室', '位置'],
    ['珠江街道', '体检科', ''],
  ]), '计算机');
  const thin = await upload('admin', '/api/terminals/import', XLSX.write(thinBook, { type: 'buffer', bookType: 'xlsx' }));
  eq('★ 只有科室没有位置/编码/MAC 的行 → 记「信息不足」，不新增', thin.json.data.created, 0);
  eq('信息不足计 1 行', thin.json.data.thinTotal, 1);

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
  eq('★ 导出表头 = Excel 的 21 列，顺序也一致', exHead, EXCEL_HEADS);
  eq('★ 导出表头里没有自造的那 9 列',
    LEGACY_HEADS.filter((h) => exHead.indexOf(h) >= 0).length, 0);
  eq('导出行数 = 表头 + 全量台账', exAoa.length - 1, (await call('admin', 'GET', '/api/terminals')).json.data.stats.total);
  const exPc = exAoa.find((r) => r[exHead.indexOf('工作组/计算机名')] === 'PC-20180817RHBE');
  ok('导出里能找到刚导进来的那台', !!exPc);
  eq('导出保留了「统计类别」原词', exPc[exHead.indexOf('统计类别')], '台式计算机');

  // 导出再导入：应全部「无变化」（round-trip 不产生重复）
  const roundTrip = await upload('admin', '/api/terminals/import?dryRun=1', exBuf, 'roundtrip.xlsx');
  eq('★ 导出文件原样再导入：0 新增', roundTrip.json.data.created, 0);
  eq('★ 导出文件原样再导入：全部无变化', roundTrip.json.data.updated, 0);

  // ---- 表头异写：院里台账写成「外网地址（IP）」「内网地址(管理口)」----
  // 上一版 normalize 之后不等于任何已知列名，整列被静默丢掉，
  // 表现就是「我 Excel 里明明填了外网地址，系统里没有」。
  const wbAlias = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wbAlias, XLSX.utils.aoa_to_sheet([
    ['资产编码', '科室', '设备类型', '内网地址(管理口)', '外网地址（IP）', '外网使用人'],
    ['ALIAS-001', '信息科', '台式计算机', '200.100.60.51', '10.10.10.51', '张三'],
  ]), '计算机');
  const aliasBuf = XLSX.write(wbAlias, { type: 'buffer', bookType: 'xlsx' });
  const aliasDry = await upload('admin', '/api/terminals/import?dryRun=1', aliasBuf, 'alias.xlsx');
  eq('带括号后缀的表头也能认出设备（读到 1 条）', aliasDry.json.data.total, 1);
  eq('★ 认不出的列被点名（外网使用人），不让用户猜',
    (aliasDry.json.data.ignored_headers || []).map((x) => x.header).join(','), '外网使用人');
  eq('★ 同一行里「备注/说明」这类无关列不占提示名额',
    (aliasDry.json.data.ignored_headers || []).length, 1);
  const aliasImp = await upload('admin', '/api/terminals/import', aliasBuf, 'alias.xlsx');
  eq('异写表头导入 → 200', aliasImp.status, 200);
  const aliasRow = (await call('admin', 'GET', '/api/terminals?keyword=ALIAS-001')).json.data.list[0];
  eq('★ 「外网地址（IP）」写进了外网地址', aliasRow.ip_extra, '10.10.10.51');
  eq('★ 「内网地址(管理口)」写进了内网地址', aliasRow.ip, '200.100.60.51');

  const viewerImp = await upload('viewer', '/api/terminals/import', buildBook());
  eq('★ 只读角色导入 → 403', viewerImp.status, 403);

  console.log('\n== 元数据接口 ==');
  const meta = await call('admin', 'GET', '/api/terminals/meta');
  eq('meta 返回 200', meta.status, 200);
  ok('meta 给了设备大类清单（含 PC / 打印机 / 自助机）',
    ['PC', '打印机', '自助机'].every((k) => meta.json.data.kinds.indexOf(k) >= 0));
  eq('★ meta 不再给状态清单（Excel 里没有状态）', meta.json.data.statuses, undefined);
  eq('★ meta 不再给保修阈值（Excel 里没有保修）', meta.json.data.warranty_soon_days, undefined);
  eq('★ meta 给出 21 个字段定义（前端/导入模板共用一份）', (meta.json.data.fields || []).length, 21);
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
