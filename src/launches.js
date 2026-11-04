'use strict';
/**
 * launches.js —— 新系统上线管理（台账 + 阶段任务清单 + 状态流转）
 *
 * 要解决的问题：新系统上线（HIS 模块、LIS、互联网医院、接口平台…）此前没有统一台账，
 * 哪个系统什么时候上线、厂商是谁、切换方案和回滚预案放在哪、试运行到哪一步，
 * 全靠口头和微信。这里把每一次上线做成一条可追溯的档案：
 *
 *   launches      一行 = 一次上线（系统、厂商、科室、三个日期、方案摘要）
 *   launch_tasks  阶段任务清单（准备/培训/数据迁移/试运行/切换/验收，可勾完成）
 *   launch_events 状态流转流水（谁在什么时候把状态从什么改成了什么、为什么）
 *
 * 存储：表由本模块自建、建在 contract.db（同 bookmarks / ipam 的理由 ——
 * 自带存储、只替换自己这几个文件就能上线，并自动纳入每日备份）。
 *
 * 两个刻意的设计决定：
 * 1) 状态流转**不设硬校验**（允许「筹备中」直接转「已上线」）—— 实际总有补录；
 *    但每一次流转都写 launch_events，事后查得到是谁改的。
 * 2) 转入「已上线」时若实际上线日期为空，自动补为今天；转「已回滚」必须填原因。
 *    日期只自动补、不自动改：手工填过的以手工为准。
 */

const { db } = require('./db-contract');

/* ==================== 常量 ==================== */

const STATUS_TEXT = {
  planned: '筹备中',
  testing: '试运行',
  live: '已上线',
  accepted: '已验收',
  rolledback: '已回滚',
};

/** 阶段的固定顺序（详情里按这个顺序分组显示） */
const PHASES = [
  { key: 'prep', name: '准备' },
  { key: 'train', name: '培训' },
  { key: 'migrate', name: '数据迁移' },
  { key: 'trial', name: '试运行' },
  { key: 'switch', name: '切换' },
  { key: 'accept', name: '验收' },
];
const PHASE_KEYS = PHASES.map((p) => p.key);
const PHASE_NAME = {};
PHASES.forEach((p) => { PHASE_NAME[p.key] = p.name; });

/** 台账列（编辑表单、列表、详情都按这个口径） */
const FIELDS = [
  { key: 'name', label: '系统名称', max: 120 },
  { key: 'vendor', label: '厂商', max: 120 },
  { key: 'dept', label: '使用科室', max: 60 },
  { key: 'it_owner', label: '信息科负责人', max: 60 },
  { key: 'contact', label: '联系人', max: 120 },
  { key: 'plan_date', label: '计划上线日期', date: true },
  { key: 'live_date', label: '实际上线日期', date: true },
  { key: 'accept_date', label: '验收日期', date: true },
  { key: 'switch_plan', label: '切换方案摘要', max: 2000, text: true },
  { key: 'rollback_plan', label: '回滚预案摘要', max: 2000, text: true },
  { key: 'note', label: '备注', max: 2000, text: true },
];
const FIELD_KEYS = FIELDS.map((f) => f.key);

/* ==================== 建表（模块自带存储） ==================== */

let tablesReady = false;
function ensure() {
  if (tablesReady) return true;
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS launches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        vendor TEXT NOT NULL DEFAULT '',
        dept TEXT NOT NULL DEFAULT '',
        it_owner TEXT NOT NULL DEFAULT '',
        contact TEXT NOT NULL DEFAULT '',
        plan_date TEXT NOT NULL DEFAULT '',
        live_date TEXT NOT NULL DEFAULT '',
        accept_date TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned',
        switch_plan TEXT NOT NULL DEFAULT '',
        rollback_plan TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT,
        updated_at TEXT,
        created_by TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS launch_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        launch_id INTEGER NOT NULL,
        phase TEXT NOT NULL DEFAULT 'prep',
        title TEXT NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        due_date TEXT NOT NULL DEFAULT '',
        done INTEGER NOT NULL DEFAULT 0,
        done_at TEXT NOT NULL DEFAULT '',
        created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS launch_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        launch_id INTEGER NOT NULL,
        from_status TEXT NOT NULL DEFAULT '',
        to_status TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        created_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_launch_tasks_launch ON launch_tasks(launch_id);
      CREATE INDEX IF NOT EXISTS idx_launch_events_launch ON launch_events(launch_id);
    `);
    tablesReady = true;
  } catch (e) {
    console.warn('[launches] 创建上线管理表失败：' + ((e && e.message) || e));
  }
  return tablesReady;
}

/* ==================== 工具 ==================== */

function isBlank(v) { return v == null || String(v).trim() === ''; }
function trim(v) { return String(v == null ? '' : v).trim(); }

/** 只收 YYYY-MM-DD；别的写法（含 datetime）截成日期前先验一遍 */
function normDate(v) {
  const s = trim(v);
  if (!s) return '';
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

function nowStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function todayStr() { return nowStr().slice(0, 10); }

/** 表单输入 → 可入库对象。未提供的键一律落 ''（新建/编辑都是整表单提交，不存在部分提交） */
function pickInput(o) {
  const out = {};
  FIELD_KEYS.forEach((k) => {
    const f = FIELDS.filter((x) => x.key === k)[0];
    let v = trim(o ? o[k] : '');
    if (f.date) v = normDate(v);
    if (f.max && v.length > f.max) v = v.slice(0, f.max);
    out[k] = v;
  });
  return out;
}

function rowShape(r) {
  if (!r) return null;
  return {
    id: Number(r.id),
    name: r.name || '',
    vendor: r.vendor || '',
    dept: r.dept || '',
    it_owner: r.it_owner || '',
    contact: r.contact || '',
    plan_date: r.plan_date || '',
    live_date: r.live_date || '',
    accept_date: r.accept_date || '',
    status: r.status || 'planned',
    status_label: STATUS_TEXT[r.status] || r.status || '筹备中',
    switch_plan: r.switch_plan || '',
    rollback_plan: r.rollback_plan || '',
    note: r.note || '',
    created_at: r.created_at || '',
    updated_at: r.updated_at || '',
    created_by: r.created_by || '',
    task_n: Number(r.task_n || 0),
    task_done: Number(r.task_done || 0),
  };
}

/* ==================== 查询 ==================== */

const STATUS_ORDER_SQL = "CASE status WHEN 'planned' THEN 0 WHEN 'testing' THEN 1 WHEN 'live' THEN 2 WHEN 'accepted' THEN 3 ELSE 4 END";

function emptyStats() {
  return { total: 0, planned: 0, testing: 0, live: 0, accepted: 0, rolledback: 0,
    year_live: 0, upcoming: 0 };
}

/** 列表：进行中的在前，同档按计划日期。stats 里的 upcoming 供筛选提示用 */
function list(opts) {
  if (!ensure()) return { list: [], total: 0, page: 1, pageSize: 20, stats: emptyStats() };
  const o = opts || {};
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(o.pageSize) || 20));

  const where = [];
  const args = [];
  const kw = trim(o.keyword);
  if (kw) {
    where.push('(name LIKE ? OR vendor LIKE ? OR dept LIKE ? OR it_owner LIKE ? OR contact LIKE ? OR note LIKE ?)');
    const like = '%' + kw + '%';
    for (let i = 0; i < 6; i++) args.push(like);
  }
  if (STATUS_TEXT[o.status]) { where.push('status = ?'); args.push(o.status); }
  if (/^\d{4}$/.test(String(o.year || ''))) { where.push("substr(plan_date,1,4) = ?"); args.push(String(o.year)); }
  const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';

  const countSql = 'SELECT COUNT(*) c FROM launches' + whereSql;
  const total = Number(db.prepare(countSql).get(...args).c);

  const rows = db.prepare(`
    SELECT l.*, t.n AS task_n, t.d AS task_done
    FROM launches l
    LEFT JOIN (SELECT launch_id, COUNT(*) n, COALESCE(SUM(done),0) d FROM launch_tasks GROUP BY launch_id) t
      ON t.launch_id = l.id
    ${whereSql}
    ORDER BY ${STATUS_ORDER_SQL} ASC, (plan_date = '') ASC, plan_date ASC, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...args, pageSize, (page - 1) * pageSize);

  return {
    list: rows.map(rowShape),
    total,
    page,
    pageSize,
    stats: stats(),
  };
}

/** 汇总（统计卡 + 工作台提醒条共用）。upcoming = 30 天内计划上线且还没转已上线/已回滚 */
function stats() {
  if (!ensure()) return emptyStats();
  const out = emptyStats();
  db.prepare('SELECT status, COUNT(*) c FROM launches GROUP BY status').all().forEach((r) => {
    if (r.status in STATUS_TEXT) out[r.status] = Number(r.c);
    out.total += Number(r.c);
  });
  out.year_live = Number(db.prepare(
    "SELECT COUNT(*) c FROM launches WHERE live_date <> '' AND substr(live_date,1,4) = ?").get(todayStr().slice(0, 4)).c);
  out.upcoming = Number(db.prepare(
    "SELECT COUNT(*) c FROM launches WHERE status IN ('planned','testing') AND plan_date <> '' AND plan_date >= ? AND plan_date <= ?"
  ).get(todayStr(), plusDays(todayStr(), 30)).c);
  return out;
}

function plusDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  const p = (x) => (x < 10 ? '0' : '') + x;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 工作台提醒条的数据：30 天内计划上线（最紧的 5 个）+ 试运行中的（最多 5 个） */
function summary() {
  if (!ensure()) return { upcoming: [], testing: [] };
  const today = todayStr();
  const upRows = db.prepare(`
    SELECT id, name, vendor, dept, plan_date, status FROM launches
    WHERE status IN ('planned','testing') AND plan_date <> '' AND plan_date >= ? AND plan_date <= ?
    ORDER BY plan_date ASC LIMIT 5
  `).all(today, plusDays(today, 30)).map((r) => Object.assign(rowShape(r), {
    days: Math.round((new Date(r.plan_date + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000),
  }));
  const teRows = db.prepare(`
    SELECT id, name, vendor, dept, plan_date, status FROM launches
    WHERE status = 'testing' ORDER BY plan_date ASC, id ASC LIMIT 5
  `).all().map(rowShape);
  const s = stats();
  return { upcoming: upRows, upcomingTotal: s.upcoming, testing: teRows, testingTotal: s.testing };
}

/** 详情：基本信息 + 按阶段分组的任务 + 状态流转流水 */
function get(id) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(id);
  if (!nId || nId < 1) return { notFound: true, error: '记录不存在' };
  const r = db.prepare(`
    SELECT l.*, t.n AS task_n, t.d AS task_done
    FROM launches l
    LEFT JOIN (SELECT launch_id, COUNT(*) n, COALESCE(SUM(done),0) d FROM launch_tasks GROUP BY launch_id) t
      ON t.launch_id = l.id
    WHERE l.id = ?
  `).get(nId);
  if (!r) return { notFound: true, error: '记录不存在' };

  const tasks = db.prepare('SELECT * FROM launch_tasks WHERE launch_id = ?').all(nId).map(taskShape)
    .sort((a, b) => (PHASE_KEYS.indexOf(a.phase) - PHASE_KEYS.indexOf(b.phase)) || (a.id - b.id));
  const events = db.prepare('SELECT * FROM launch_events WHERE launch_id = ? ORDER BY id DESC').all(nId)
    .map((e) => ({
      id: Number(e.id),
      from_status: e.from_status || '',
      from_label: STATUS_TEXT[e.from_status] || (e.from_status ? e.from_status : '（新建）'),
      to_status: e.to_status || '',
      to_label: STATUS_TEXT[e.to_status] || e.to_status || '',
      reason: e.reason || '',
      username: e.username || '',
      created_at: e.created_at || '',
    }));

  const out = rowShape(r);
  out.tasks = tasks;
  out.events = events;
  return out;
}

function taskShape(t) {
  return {
    id: Number(t.id),
    launch_id: Number(t.launch_id),
    phase: PHASE_NAME[t.phase] ? t.phase : 'prep',
    phase_label: PHASE_NAME[t.phase] || '准备',
    title: t.title || '',
    owner: t.owner || '',
    due_date: t.due_date || '',
    done: Number(t.done) === 1,
    done_at: t.done_at || '',
  };
}

/* ==================== 写入 ==================== */

function validate(data) {
  if (isBlank(data.name)) return '系统名称必填';
  return '';
}

function create(o, username) {
  if (!ensure()) return { error: '模块未就绪' };
  const d = pickInput(o);
  const err = validate(d);
  if (err) return { error: err };
  const now = nowStr();
  const r = db.prepare(`
    INSERT INTO launches (name, vendor, dept, it_owner, contact, plan_date, live_date, accept_date,
      status, switch_plan, rollback_plan, note, created_at, updated_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?, ?, ?, ?)
  `).run(d.name, d.vendor, d.dept, d.it_owner, d.contact, d.plan_date, d.live_date, d.accept_date,
    d.switch_plan, d.rollback_plan, d.note, now, now, username || '');
  const id = Number(r.lastInsertRowid);
  db.prepare('INSERT INTO launch_events (launch_id, from_status, to_status, reason, username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, '', 'planned', '', username || '', now);
  return get(id);
}

/** 编辑只改台账字段；状态走 setStatus（要留痕）
 *  ★ 未出现在提交体里的字段一律保留原值：接口层面允许部分提交，
 *    否则一个只改名称的 PUT 会把「实际上线日期」这类关键字段悄悄清空
 *    （前端整表单提交不会出问题，但接口被别处调用时这个坑迟早会踩）。 */
function update(id, o, username) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(id);
  const old = db.prepare('SELECT * FROM launches WHERE id = ?').get(nId);
  if (!old) return { notFound: true, error: '记录不存在' };
  const d = pickInput(o);
  FIELD_KEYS.forEach((k) => {
    if (!o || !(k in o)) d[k] = old[k] || '';
  });
  const err = validate(d);
  if (err) return { error: err };
  db.prepare(`
    UPDATE launches SET name=?, vendor=?, dept=?, it_owner=?, contact=?,
      plan_date=?, live_date=?, accept_date=?, switch_plan=?, rollback_plan=?, note=?, updated_at=?
    WHERE id=?
  `).run(d.name, d.vendor, d.dept, d.it_owner, d.contact,
    d.plan_date, d.live_date, d.accept_date, d.switch_plan, d.rollback_plan, d.note,
    nowStr(), nId);
  return get(nId);
}

/** 删除：任务与流水一起删（这本就是同一条档案的一部分，留着只会变孤儿） */
function remove(id) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(id);
  const old = db.prepare('SELECT * FROM launches WHERE id = ?').get(nId);
  if (!old) return { notFound: true, error: '记录不存在' };
  db.prepare('DELETE FROM launch_tasks WHERE launch_id = ?').run(nId);
  db.prepare('DELETE FROM launch_events WHERE launch_id = ?').run(nId);
  db.prepare('DELETE FROM launches WHERE id = ?').run(nId);
  return { ok: true, name: old.name };
}

/**
 * 状态流转。规则只有两条硬的：
 *   · 转入 rolledback 必须给原因（回滚没原因，档案就没价值了）；
 *   · 转入 live / accepted 时对应日期为空则自动补今天（手工填过的不动）。
 */
function setStatus(id, status, reason, username) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(id);
  const old = db.prepare('SELECT * FROM launches WHERE id = ?').get(nId);
  if (!old) return { notFound: true, error: '记录不存在' };
  if (!STATUS_TEXT[status]) return { error: '未知状态：' + status };
  if (old.status === status) return { error: '已经是「' + STATUS_TEXT[status] + '」了' };
  const why = trim(reason);
  if (status === 'rolledback' && !why) return { error: '转「已回滚」必须填写原因' };

  const now = nowStr();
  const patch = { status, live_date: old.live_date, accept_date: old.accept_date };
  if (status === 'live' && !old.live_date) patch.live_date = todayStr();
  if (status === 'accepted' && !old.accept_date) patch.accept_date = todayStr();
  db.prepare('UPDATE launches SET status=?, live_date=?, accept_date=?, updated_at=? WHERE id=?')
    .run(patch.status, patch.live_date, patch.accept_date, now, nId);
  db.prepare('INSERT INTO launch_events (launch_id, from_status, to_status, reason, username, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nId, old.status, status, why, username || '', now);
  return get(nId);
}

/* ==================== 阶段任务 ==================== */

function addTask(launchId, o) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(launchId);
  const launch = db.prepare('SELECT id FROM launches WHERE id = ?').get(nId);
  if (!launch) return { notFound: true, error: '上线记录不存在' };
  const title = trim(o && o.title);
  if (!title) return { error: '任务名必填' };
  const phase = PHASE_NAME[o && o.phase] ? (o && o.phase) : 'prep';
  const r = db.prepare('INSERT INTO launch_tasks (launch_id, phase, title, owner, due_date, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(nId, phase, title, trim(o && o.owner), normDate(o && o.due_date), nowStr());
  return { ok: true, id: Number(r.lastInsertRowid) };
}

function updateTask(taskId, o) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(taskId);
  const t = db.prepare('SELECT * FROM launch_tasks WHERE id = ?').get(nId);
  if (!t) return { notFound: true, error: '任务不存在' };
  const patch = {};
  if (o && 'title' in o) {
    const title = trim(o.title);
    if (!title) return { error: '任务名不能为空' };
    patch.title = title;
  }
  if (o && 'phase' in o && PHASE_NAME[o.phase]) patch.phase = o.phase;
  if (o && 'owner' in o) patch.owner = trim(o.owner);
  if (o && 'due_date' in o) patch.due_date = normDate(o.due_date);
  if (o && 'done' in o) {
    const done = o.done === 1 || o.done === true || o.done === '1';
    patch.done = done ? 1 : 0;
    patch.done_at = done ? nowStr() : '';
  }
  const keys = Object.keys(patch);
  if (!keys.length) return { ok: true };
  const sets = keys.map((k) => k + '=?').join(', ');
  db.prepare('UPDATE launch_tasks SET ' + sets + ' WHERE id=?')
    .run(...keys.map((k) => patch[k]), nId);
  db.prepare('UPDATE launches SET updated_at=? WHERE id=?').run(nowStr(), t.launch_id);
  return { ok: true };
}

function removeTask(taskId) {
  if (!ensure()) return { notFound: true, error: '模块未就绪' };
  const nId = Number(taskId);
  const t = db.prepare('SELECT * FROM launch_tasks WHERE id = ?').get(nId);
  if (!t) return { notFound: true, error: '任务不存在' };
  db.prepare('DELETE FROM launch_tasks WHERE id = ?').run(nId);
  return { ok: true };
}

module.exports = {
  STATUS_TEXT, PHASES, PHASE_NAME, FIELDS, FIELD_KEYS,
  ensure, list, stats, summary, get,
  create, update, remove, setStatus,
  addTask, updateTask, removeTask,
};
