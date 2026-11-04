'use strict';
/**
 * 上线管理 —— 后端接口端到端自测
 *
 * 用法：node scripts/launches-e2e.js          （默认端口 3997）
 *      PORT=4571 node scripts/launches-e2e.js
 *
 * 做法与 terminals-e2e 一致：四个库全指到临时目录（改 config 再 require db 模块），
 * 不碰 data/*.db；起真实 Express 服务，自签 JWT 打真实 HTTP。
 *
 * 重点覆盖「错了也不报错」的地方：
 *   · 名称必填（空名称入库 = 列表里一行空白，谁都不知道那是哪个系统）
 *   · 转「已回滚」没原因必须 400（回滚原因是唯一的事故复盘材料）
 *   · 转「已上线 / 已验收」自动补日期，但手工填过的不能被覆盖
 *   · 阶段任务勾完成 → 主表进度跟着变；删任务不影响主表
 *   · 只读角色能看列表与详情，但改状态 / 勾任务 / 增删一律 403
 *   · 删档案时任务与流转流水一起清掉，不留孤儿
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'launch-e2e-'));
const config = require(path.join(ROOT, 'config'));
config.CONTRACT_DB_FILE = path.join(TMP, 'contract.db');
config.DB_FILE = path.join(TMP, 'his.db');
config.INSPECT_DB_FILE = path.join(TMP, 'inspect.db');
config.DOCS_DB_FILE = path.join(TMP, 'docs.db');
config.PORT = Number(process.env.PORT || 3997);

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

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function plusDays(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const perm = require(path.join(ROOT, 'src', 'perm'));

  require(path.join(ROOT, 'server'));
  getSecret();
  const { db } = require(path.join(ROOT, 'src', 'db-contract'));

  const base = 'http://127.0.0.1:' + config.PORT;
  for (let i = 0; i < 60; i++) {
    try { await fetch(base + '/api/launches'); break; }
    catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  // 只读角色：有 launches.view，没有 manage
  db.prepare("INSERT INTO roles (id, code, name) VALUES (904, 'launch_viewer', '上线只读')").run();
  perm.setRolePerms(904, 'launch_viewer', ['dashboard.view', 'launches.view']);
  db.prepare("INSERT INTO users (username, real_name, password_hash, salt, role_id, created_at)"
    + " VALUES ('e2e_launchv', '上线只读', 'x', 'y', 904, datetime('now','localtime'))").run();
  const adminId = db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const viewerId = db.prepare("SELECT id FROM users WHERE username = 'e2e_launchv'").get().id;

  const tokens = {
    admin: signJwt({ id: adminId, username: 'admin', role_id: 1 }, 3600),
    viewer: signJwt({ id: viewerId, username: 'e2e_launchv', role_id: 904 }, 3600),
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

  console.log('\n== ① 表结构 ==');
  const warm = await call('admin', 'GET', '/api/launches');
  eq('管理员读列表 → 200（模块可用）', warm.status, 200);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  ['launches', 'launch_tasks', 'launch_events'].forEach((t) => {
    ok('表存在：' + t, tables.indexOf(t) >= 0);
  });
  const cols = db.prepare('PRAGMA table_info(launches)').all().map((c) => c.name);
  ['name', 'vendor', 'dept', 'it_owner', 'contact', 'plan_date', 'live_date', 'accept_date',
    'status', 'switch_plan', 'rollback_plan', 'note', 'created_at', 'updated_at', 'created_by']
    .forEach((c) => ok('launches 列：' + c, cols.indexOf(c) >= 0));
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  ok('任务表有索引（按 launch_id 查）', idx.indexOf('idx_launch_tasks_launch') >= 0);
  ok('流水表有索引（按 launch_id 查）', idx.indexOf('idx_launch_events_launch') >= 0);

  console.log('\n== ② 权限：view 能看、manage 才能写 ==');
  eq('未登录读列表 → 401', (await call(null, 'GET', '/api/launches')).status, 401);
  eq('只读角色读列表 → 200', (await call('viewer', 'GET', '/api/launches')).status, 200);
  eq('只读角色读汇总 → 200', (await call('viewer', 'GET', '/api/launches/summary')).status, 200);
  eq('只读角色新增 → 403', (await call('viewer', 'POST', '/api/launches', { name: 'x' })).status, 403);
  ok('★ 默认权限：工程师有 launches.manage',
    perm.DEFAULT_ROLE_PERMS.engineer.indexOf('launches.manage') >= 0);
  ok('★ 默认权限：普通用户有 launches.view（全员可看）',
    perm.DEFAULT_ROLE_PERMS.user.indexOf('launches.view') >= 0);
  ok('权限矩阵里有上线管理模块',
    perm.describeModules().some((m) => m.code === 'launches' && m.acts.length === 2));

  console.log('\n== ③ 新增：名称必填 ==');
  const noName = await call('admin', 'POST', '/api/launches', { vendor: '东软' });
  eq('空名称 → 400', noName.status, 400);
  ok('400 文案说清缺什么', /名称/.test(String(noName.json.message)), noName.json.message);
  const blankName = await call('admin', 'POST', '/api/launches', { name: '   ' });
  eq('纯空格名称 → 400', blankName.status, 400);

  const c1 = await call('admin', 'POST', '/api/launches', {
    name: '  LIS 检验系统  ', vendor: '卫宁健康', dept: '检验科', it_owner: '张工',
    contact: '王实施 13800000000', plan_date: '2026-12-01',
    switch_plan: '周五 22:00 停旧系统 → 数据同步 → 验证 → 次日 6:00 前完成',
    rollback_plan: '旧系统只读保留 7 天', note: '含微生物模块',
  });
  eq('完整表单 → 200', c1.status, 200);
  const id1 = c1.json.data.id;
  eq('名称首尾空格被去掉', c1.json.data.name, 'LIS 检验系统');
  eq('初始状态 = 筹备中', c1.json.data.status_label, '筹备中');
  eq('新建就有一条流水（（新建）→ 筹备中）', c1.json.data.events.length, 1);
  eq('流水起点是（新建）', c1.json.data.events[0].from_label, '（新建）');

  console.log('\n== ④ 列表：搜索 / 筛选 / 排序 / 统计 ==');
  const c2 = await call('admin', 'POST', '/api/launches', {
    name: '互联网医院小程序', vendor: '东华', dept: '门诊部', plan_date: plusDays(10),
  });
  const c3 = await call('admin', 'POST', '/api/launches', {
    name: 'PACS 影像升级', vendor: '联影', dept: '放射科', plan_date: '2027-03-15',
  });
  const id2 = c2.json.data.id; const id3 = c3.json.data.id;

  const all = await call('admin', 'GET', '/api/launches?pageSize=20');
  eq('列表共 3 条', all.json.data.total, 3);
  // 进行中在前 + 计划日期早的在前：互联网医院（+10 天）应在 LIS（12-01）之前
  eq('排序：进行中 + 计划日期早的在前', all.json.data.list[0].name, '互联网医院小程序');

  eq('按厂商搜索', (await call('admin', 'GET', '/api/launches?keyword=' + encodeURIComponent('联影'))).json.data.total, 1);
  eq('按科室搜索', (await call('admin', 'GET', '/api/launches?keyword=' + encodeURIComponent('检验科'))).json.data.total, 1);
  eq('按年份筛选（2027）', (await call('admin', 'GET', '/api/launches?year=2027')).json.data.total, 1);
  eq('按状态筛选（筹备中）', (await call('admin', 'GET', '/api/launches?status=planned')).json.data.total, 3);
  eq('状态未知时忽略筛选（不返回 0 条）', (await call('admin', 'GET', '/api/launches?status=nope')).json.data.total, 3);

  const st = all.json.data.stats;
  eq('统计：筹备中 3', st.planned, 3);
  ok('统计：upcoming ≥ 2（有两条落在 30 天内）', st.upcoming >= 2, JSON.stringify(st));
  eq('统计：总数 3', st.total, 3);

  console.log('\n== ⑤ 详情与阶段任务 ==');
  const badId = await call('admin', 'GET', '/api/launches/99999');
  eq('不存在的 id → 404', badId.status, 404);
  eq('非数字 id → 404', (await call('admin', 'GET', '/api/launches/abc')).status, 404);

  eq('空任务名 → 400', (await call('admin', 'POST', '/api/launches/' + id1 + '/tasks', { phase: 'prep' })).status, 400);
  const t1 = await call('admin', 'POST', '/api/launches/' + id1 + '/tasks', {
    phase: 'migrate', title: '历史数据迁移演练', owner: '张工', due_date: plusDays(5),
  });
  eq('加任务 → 200', t1.status, 200);
  eq('未知阶段落回「准备」', (await call('admin', 'POST', '/api/launches/' + id1 + '/tasks',
    { phase: 'zzz', title: '兜底阶段' })).status, 200);
  await call('admin', 'POST', '/api/launches/' + id1 + '/tasks', { phase: 'train', title: '护士站培训' });

  const d1 = await call('admin', 'GET', '/api/launches/' + id1);
  eq('详情里 3 条任务', d1.json.data.tasks.length, 3);
  eq('任务按阶段顺序排（准备 → 培训 → 数据迁移）',
    d1.json.data.tasks.map((t) => t.phase), ['prep', 'train', 'migrate']);
  eq('主表进度 0 / 3', [d1.json.data.task_done, d1.json.data.task_n], [0, 3]);

  eq('勾完成 → 200', (await call('admin', 'PUT', '/api/launches/tasks/' + t1.json.data.id, { done: 1 })).status, 200);
  const d2 = await call('admin', 'GET', '/api/launches/' + id1);
  eq('勾完成后进度 1 / 3', [d2.json.data.task_done, d2.json.data.task_n], [1, 3]);
  ok('完成时间被记下', !!d2.json.data.tasks.filter((t) => t.id === t1.json.data.id)[0].done_at);

  eq('任务改名 → 200', (await call('admin', 'PUT', '/api/launches/tasks/' + t1.json.data.id, { title: '数据迁移演练（第二轮）' })).status, 200);
  eq('改名后内容正确', (await call('admin', 'GET', '/api/launches/' + id1)).json.data.tasks
    .filter((t) => t.id === t1.json.data.id)[0].title, '数据迁移演练（第二轮）');
  eq('任务名改空 → 400', (await call('admin', 'PUT', '/api/launches/tasks/' + t1.json.data.id, { title: '  ' })).status, 400);
  eq('删任务 → 200', (await call('admin', 'DELETE', '/api/launches/tasks/' + t1.json.data.id)).status, 200);
  eq('删完剩 2 条', (await call('admin', 'GET', '/api/launches/' + id1)).json.data.tasks.length, 2);
  eq('删不存在的任务 → 404', (await call('admin', 'DELETE', '/api/launches/tasks/99999')).status, 404);

  console.log('\n== ⑥ 状态流转（这次模块的核心规则）==');
  eq('未知状态 → 400', (await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'zzz' })).status, 400);
  eq('重复设置当前状态 → 400', (await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'planned' })).status, 400);
  const rbNo = await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'rolledback' });
  eq('★ 转已回滚不带原因 → 400', rbNo.status, 400);
  ok('文案点明要填原因', /原因/.test(String(rbNo.json.message)), rbNo.json.message);

  const toTest = await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'testing' });
  eq('筹备中 → 试运行', toTest.json.data.status_label, '试运行');

  const toLive = await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'live' });
  eq('转已上线 → 200', toLive.status, 200);
  eq('★ 实际上线日期自动补今天', toLive.json.data.live_date, todayStr());

  // 手工填过的日期不能被自动覆盖
  const manual = await call('admin', 'PUT', '/api/launches/' + id2, { name: '互联网医院小程序', live_date: '2026-10-01' });
  eq('手工填实际上线日期 → 200', manual.status, 200);
  await call('admin', 'POST', '/api/launches/' + id2 + '/status', { status: 'live' });
  eq('★ 再转已上线不会覆盖手工日期',
    (await call('admin', 'GET', '/api/launches/' + id2)).json.data.live_date, '2026-10-01');

  const toAccept = await call('admin', 'POST', '/api/launches/' + id1 + '/status', { status: 'accepted' });
  eq('已上线 → 已验收', toAccept.json.data.status_label, '已验收');
  eq('验收日期自动补今天', toAccept.json.data.accept_date, todayStr());

  const rbOk = await call('admin', 'POST', '/api/launches/' + id3 + '/status',
    { status: 'rolledback', reason: '接口超时率超标，厂商回退版本' });
  eq('带原因可回滚', rbOk.json.data.status_label, '已回滚');
  const ev3 = (await call('admin', 'GET', '/api/launches/' + id3)).json.data.events;
  eq('回滚原因进了流水', ev3[0].reason, '接口超时率超标，厂商回退版本');
  ok('流水记录了操作人', ev3[0].username === 'admin', ev3[0].username);

  const ev1 = (await call('admin', 'GET', '/api/launches/' + id1)).json.data.events;
  eq('★ 一条档案的完整流水（新建 + 3 次流转）', ev1.length, 4);
  eq('流水倒序（最新在前）', ev1[0].to_status, 'accepted');
  eq('回滚的档案不计入 upcoming',
    (await call('admin', 'GET', '/api/launches?status=rolledback')).json.data.total, 1);

  console.log('\n== ⑦ 工作台提醒条数据 ==');
  // 造一条真正落在 30 天内的记录，才能验倒计时天数（前面的都转成终态了）
  const c4 = await call('admin', 'POST', '/api/launches', {
    name: '电子病历评级改造', vendor: '嘉和', dept: '医务科', plan_date: plusDays(5),
  });
  const id4 = c4.json.data.id;
  const sm = await call('admin', 'GET', '/api/launches/summary');
  eq('summary → 200', sm.status, 200);
  ok('upcoming 里有 5 天后上线的那条',
    (sm.json.data.upcoming || []).some((x) => x.id === id4), JSON.stringify(sm.json.data.upcoming));
  eq('★ 倒计时天数算对了', (sm.json.data.upcoming || []).filter((x) => x.id === id4)[0].days, 5);
  ok('upcoming 里不含已验收 / 已回滚的',
    (sm.json.data.upcoming || []).every((x) => x.status === 'planned' || x.status === 'testing'),
    JSON.stringify((sm.json.data.upcoming || []).map((x) => x.name)));
  eq('已回滚的档案不在 upcoming',
    (sm.json.data.upcoming || []).filter((x) => x.id === id3).length, 0);
  eq('summary 的 upcomingTotal 与列表口径一致', sm.json.data.upcomingTotal, 1);
  await call('admin', 'DELETE', '/api/launches/' + id4);

  console.log('\n== ⑧ 只读角色：能看不能写 ==');
  eq('只读看详情 → 200', (await call('viewer', 'GET', '/api/launches/' + id1)).status, 200);
  eq('只读改状态 → 403', (await call('viewer', 'POST', '/api/launches/' + id1 + '/status', { status: 'testing' })).status, 403);
  eq('只读加任务 → 403', (await call('viewer', 'POST', '/api/launches/' + id1 + '/tasks', { title: 'x' })).status, 403);
  eq('只读勾任务 → 403', (await call('viewer', 'PUT', '/api/launches/tasks/1', { done: 1 })).status, 403);
  eq('只读删除档案 → 403', (await call('viewer', 'DELETE', '/api/launches/' + id1)).status, 403);

  console.log('\n== ⑨ 编辑与删除 ==');
  const upd = await call('admin', 'PUT', '/api/launches/' + id1, {
    name: 'LIS 检验系统（二期）', vendor: '卫宁健康', dept: '检验科',
    plan_date: '2026-12-20', switch_plan: '分两批切换', note: '加了微生物模块',
  });
  eq('编辑 → 200', upd.status, 200);
  eq('名称已改', upd.json.data.name, 'LIS 检验系统（二期）');
  eq('★ 编辑不动状态（已验收）', upd.json.data.status_label, '已验收');
  eq('编辑保留实际上线日期', upd.json.data.live_date, todayStr());
  eq('编辑清空备注是允许的（表单整提交）',
    (await call('admin', 'PUT', '/api/launches/' + id1, { name: 'LIS 检验系统（二期）', note: '' })).json.data.note, '');

  const delTasks = (await call('admin', 'GET', '/api/launches/' + id1)).json.data.tasks.length;
  ok('删除前有任务', delTasks === 2, delTasks);
  eq('删除档案 → 200', (await call('admin', 'DELETE', '/api/launches/' + id1)).status, 200);
  eq('删除后列表少一条', (await call('admin', 'GET', '/api/launches')).json.data.total, 2);
  eq('★ 任务一并清掉（不留孤儿）',
    Number(db.prepare('SELECT COUNT(*) c FROM launch_tasks WHERE launch_id = ?').get(id1).c), 0);
  eq('★ 流转流水一并清掉',
    Number(db.prepare('SELECT COUNT(*) c FROM launch_events WHERE launch_id = ?').get(id1).c), 0);
  eq('删不存在的档案 → 404', (await call('admin', 'DELETE', '/api/launches/99999')).status, 404);

  console.log('\n== ⑩ 操作日志留痕 ==');
  const logs = db.prepare("SELECT COUNT(*) c FROM logs WHERE action LIKE '%上线%'").get().c;
  ok('★ 新增/编辑/流转/删除都写进了操作日志', Number(logs) >= 9, '共 ' + logs + ' 条');

  console.log('\n============================================================');
  if (fails.length) {
    console.log('失败 ' + fails.length + ' 项：');
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('全部通过：' + pass + ' 项');
  process.exit(0);
})().catch((e) => {
  console.error('e2e 异常：', e);
  process.exit(2);
});
