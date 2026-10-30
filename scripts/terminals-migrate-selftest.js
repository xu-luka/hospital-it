'use strict';
/**
 * 老库升级自测 —— terminals 表是「上一版 30 字段」结构时，能不能按 Excel 21 列**重建**。
 *
 * 为什么单独写：e2e 每次都从空库开始建表，永远走「CREATE TABLE 全新建」这条路，
 * 而真实服务器上已经有上一版建好的表。两者的差别正是最容易翻车的地方：
 *
 *   · 2026-10-30 第一次踩到：新列的索引被写进 CREATE 那一段，老库上执行时表里还没有
 *     src_key 列，直接抛「no such column: src_key」，被 ensure() 的 catch 吃掉后
 *     整个终端台账模块对外表现为「未就绪」；
 *   · 2026-10-30 第二轮做表结构重建（30 字段 → 21 列）时风险更大：
 *     重建要 DROP 掉旧表，而 issues.device_id 指着它的 id —— 一旦 id 变了，
 *     全部历史工单的设备关联就散了。所以这里必须钉住「id 不变、工单还连着」。
 *
 * 用法：node scripts/terminals-migrate-selftest.js
 */

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'term-mig-'));
const config = require(path.join(ROOT, 'config'));
config.CONTRACT_DB_FILE = path.join(TMP, 'contract.db');
config.DB_FILE = path.join(TMP, 'his.db');
config.INSPECT_DB_FILE = path.join(TMP, 'inspect.db');
config.DOCS_DB_FILE = path.join(TMP, 'docs.db');

let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra ? ' -> ' + extra : '')); }
}
function eq(tag, a, b) { ok(tag + ' = ' + JSON.stringify(b), JSON.stringify(a) === JSON.stringify(b), JSON.stringify(a)); }

/**
 * 上一版（2026-10-30 第一轮）的建表语句：Excel 21 列 + 系统自造 9 列 = 30 字段。
 * 故意按真实顺序写全，重建逻辑认的就是这 9 个自造列里有没有残留。
 */
const LEGACY_SQL = `
CREATE TABLE terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_no TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'PC',
  brand TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  sn TEXT NOT NULL DEFAULT '',
  mac TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  department TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '在用',
  purchase_date TEXT NOT NULL DEFAULT '',
  warranty_end TEXT NOT NULL DEFAULT '',
  vendor TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  campus TEXT NOT NULL DEFAULT '',
  area TEXT NOT NULL DEFAULT '',
  floor TEXT NOT NULL DEFAULT '',
  stat_category TEXT NOT NULL DEFAULT '',
  nature TEXT NOT NULL DEFAULT '',
  ip_extra TEXT NOT NULL DEFAULT '',
  produce_date TEXT NOT NULL DEFAULT '',
  hostname TEXT NOT NULL DEFAULT '',
  os TEXT NOT NULL DEFAULT '',
  cpu TEXT NOT NULL DEFAULT '',
  disk TEXT NOT NULL DEFAULT '',
  ram TEXT NOT NULL DEFAULT '',
  monitor TEXT NOT NULL DEFAULT '',
  consumable TEXT NOT NULL DEFAULT '',
  src_key TEXT NOT NULL DEFAULT '',
  src_sheet TEXT NOT NULL DEFAULT '',
  import_at TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  creator_name TEXT NOT NULL DEFAULT '',
  created_at TEXT,
  updated_at TEXT
);
`;

/** 重建后不该再出现的 9 列 */
const LEGACY_COLS = ['name', 'kind', 'brand', 'owner', 'status',
  'purchase_date', 'warranty_end', 'vendor', 'note'];

/** 重建后必须有的 21 个台账列 */
const EXCEL_COLS = ['campus', 'asset_no', 'area', 'floor', 'department', 'location',
  'stat_category', 'nature', 'hostname', 'ip', 'ip_extra', 'mac', 'sn', 'produce_date',
  'model', 'os', 'cpu', 'disk', 'ram', 'monitor', 'consumable'];

(async () => {
  // ---- 1) 把库文件造成「上一版」的样子：30 字段表 + 2 条老记录 ----
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(TMP, { recursive: true });
  const raw = new DatabaseSync(config.DB_FILE);
  raw.exec(LEGACY_SQL);

  // 造数据一律走占位符 + 参数绑定：显示器尺寸写的是 19"（英寸符号），
  // 内联进 SQL 会被当成标识符，报「no such column: "19'"」。
  function insertLegacy(row) {
    const keys = Object.keys(row);
    raw.prepare('INSERT INTO terminals(' + keys.join(',') + ') VALUES ('
      + keys.map(() => '?').join(',') + ')').run(...keys.map((k) => row[k]));
  }

  insertLegacy({
    asset_no: 'OLD-001', name: '历史遗留工作站', kind: 'PC', brand: '联想', model: 'M720t',
    sn: 'SN-OLD', mac: 'AA-BB-CC-DD-EE-FF', ip: '10.1.1.9', department: '老科室',
    location: '一楼东', owner: '陈工', status: '在用', purchase_date: '2020-01-01',
    warranty_end: '2026-12-31', vendor: '某电脑公司', note: '升级前就有的备注',
    campus: '珠江街道', area: '老楼', floor: '一楼', stat_category: '台式计算机',
    nature: '政府采购设备', ip_extra: '', produce_date: '2019-05-06',
    hostname: 'PC-OLD-001', os: 'Windows 7', cpu: 'i3-8100', disk: '500G',
    ram: 'DDR4-8G', monitor: '19"', consumable: '', src_sheet: '计算机',
    created_at: '2026-01-01 08:00:00', updated_at: '2026-01-01 08:00:00',
  });
  // 第二条：hostname 为空，只有旧的 name —— 重建时要用 name 兜底成 hostname
  insertLegacy({
    asset_no: 'OLD-002', name: '旧打印机', kind: '打印机', department: '老科室',
    location: '二楼西', mac: '11-22-33-44-55-66', status: '报废',
  });
  raw.close();

  console.log('== 准备：terminals 是上一版 30 字段结构，已有 2 条记录，其中 1 条挂着工单 ==');

  const repo = require(path.join(ROOT, 'src', 'terminals'));
  const { init, getDb } = require(path.join(ROOT, 'src', 'db'));
  init();    // 让 his.db 走一遍正常初始化（建 issues 等表），模拟服务启动
  const db = getDb();

  // 老记录 1 挂一张工单（模拟「升级前就报过修」）
  const oldId = db.prepare("SELECT id FROM terminals WHERE asset_no = 'OLD-001'").get().id;
  db.prepare("INSERT INTO issues(no, title, content, status, device_id, report_time, created_at)"
    + " VALUES ('OLD-ISSUE-1', '升级前报的修', '换过电源', 'pending', ?, '2026-01-05', '2026-01-05')")
    .run(oldId);
  eq('准备：工单已挂到老设备上', db.prepare('SELECT device_id FROM issues WHERE no = ?').get('OLD-ISSUE-1').device_id, oldId);

  // ---- 2) ensure() 必须成功，且把表重建成 21 列 ----
  const r = repo.ensure();
  ok('★ 老库上 ensure() 返回成功（不是「未就绪」）', r === true);

  const cols = db.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name);
  const missing = EXCEL_COLS.filter((c) => cols.indexOf(c) < 0);
  ok('★ 21 个台账列全部在', missing.length === 0, missing.join(',') || '全在');
  const leaked = LEGACY_COLS.filter((c) => cols.indexOf(c) >= 0);
  ok('★ 上一版自造的 9 列已被删除', leaked.length === 0, leaked.join(',') || '全部清除');
  eq('重建后总列数 = id + 21 + 7 个记账列', cols.length, 1 + 21 + 7);

  // ---- 3) 老数据必须原样还在，id 不能变 ----
  const old = db.prepare("SELECT * FROM terminals WHERE asset_no = 'OLD-001'").get();
  ok('★ 老记录还在', !!old);
  eq('★ id 没变（工单还指着它）', old.id, oldId);
  eq('台账字段原样保留：科室', old.department, '老科室');
  eq('台账字段原样保留：院区/区域/楼层', [old.campus, old.area, old.floor].join('|'), '珠江街道|老楼|一楼');
  eq('台账字段原样保留：CPU', old.cpu, 'i3-8100');
  eq('台账字段原样保留：MAC', old.mac, 'AA-BB-CC-DD-EE-FF');
  eq('带引号的值原样搬过去：显示器尺寸', old.monitor, '19"');
  eq('★ hostname 原本就有 → 保持原值', old.hostname, 'PC-OLD-001');
  eq('旧的备注等字段不再存在（表里没这列了）', old.note, undefined);

  const old2 = db.prepare("SELECT * FROM terminals WHERE asset_no = 'OLD-002'").get();
  eq('★ hostname 原本为空 → 用旧的「设备名称」兜底，不会变成一串空', old2.hostname, '旧打印机');
  eq('旧的「状态=报废」不再保留（Excel 里没有状态）', old2.status, undefined);

  // ---- 4) 工单关联没断 ----
  const issue = db.prepare('SELECT device_id FROM issues WHERE no = ?').get('OLD-ISSUE-1');
  eq('★ 升级后工单仍连着同一台设备', issue.device_id, oldId);
  const brief = repo.brief(oldId);
  ok('★ 升级后 brief() 能取到设备（工单详情靠它）', !!brief, JSON.stringify(brief && brief.name));
  eq('brief 的派生名称 = hostname', brief.name, 'PC-OLD-001');

  // ---- 5) 升级后照常能用：列表 / 派生字段 / 导入 ----
  const list = repo.list({ keyword: '老科室' });
  eq('升级后能查到老记录', list.total, 2);
  ok('★ 派生字段都算得出来（name / kind）',
    list.list.every((x) => !!x.name && !!x.kind), JSON.stringify(list.list.map((x) => x.name)));
  ok('★ 出参里不再有 warranty_* / status 这些已删字段',
    list.list.every((x) => x.warranty_text === undefined && x.status === undefined));

  const imp = repo.importRows([{
    __sheet: '计算机', __row: 2,
    department: '儿科', location: '护士站（一）', stat_category: '台式计算机',
    mac: '内网：11-22-33-44-55-77', asset_no: '-',
  }], { dryRun: false });
  ok('★ 升级后能正常导入', imp.ok === true, JSON.stringify({ created: imp.created }));
  eq('导入新增 1 条', imp.created, 1);
  eq('「-」按空处理', db.prepare("SELECT asset_no FROM terminals WHERE department = '儿科'").get().asset_no, '');
  eq('MAC 前缀被剥掉', db.prepare("SELECT mac FROM terminals WHERE department = '儿科'").get().mac, '11-22-33-44-55-77');

  // AUTOINCREMENT 在重建后必须继续往上走，不能复用旧 id
  const newRow = db.prepare("SELECT id FROM terminals WHERE department = '儿科'").get();
  ok('★ 重建后新增记录的 id 继续往上走（没复用旧 id）', newRow.id > old2.id, newRow.id + ' > ' + old2.id);

  // ---- 6) 再 ensure() 一次必须幂等（每次请求都会调用） ----
  eq('重复 ensure() 不再改结构', repo.ensure(), true);
  eq('列数没变（没重复重建）', db.prepare('PRAGMA table_info(terminals)').all().length, cols.length);
  eq('记录数没变（没把数据搬丢）', db.prepare('SELECT COUNT(*) c FROM terminals').get().c, 3);
  ok('没有残留的临时表（terminals_legacy_v1 已删）',
    !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='terminals_legacy_v1'").get());

  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) { console.log('\n失败明细：'); fails.forEach((f) => console.log('  · ' + f)); }
  console.log('========================================');
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  process.exit(fails.length ? 1 : 0);
})().catch((e) => {
  console.error('自测异常中断：' + ((e && e.stack) || e));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (x) {}
  process.exit(1);
});
