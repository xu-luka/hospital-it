'use strict';
/**
 * terminals.js —— 终端资产台账（PC / 打印机 / 自助机 / 叫号机 这类「连不上也管不了」的设备）
 *
 * 与【设备台账】(it_devices, contract.db) 的分工：
 *   it_devices     = 巡检对象。必须有 host/port/协议/认证，能被 WMI/SSH/SNMP 采集。
 *   terminals      = 资产。几百台终端机器，装完就没人再登进去过，
 *                    但信息科 80% 的报障来自它们（打印不出来、开不了机、屏幕没信号）。
 * 两套刻意不合并：一张表既要装「能采的服务器」又要装「不能采的打印机」，
 * 会造出一半字段永远为空的两不像，且巡检那套的认证字段对终端毫无意义。
 *
 * 三个设计决定：
 * 1) **表建在 his.db**（与 issues 同库），而不是 contract.db。
 *    因为这张表存在的唯一理由就是把工单挂到设备上，跨库没法 JOIN，
 *    「这台机器历史上修过几次」就只能靠两次查询在内存里拼，容易漏且慢。
 *    his.db 同样在 scripts/backup.js 的每日备份范围内（快照为 his.db），不会丢。
 * 2) **懒建表**：src/db.js 的 getDb() 在未 init() 时直接抛错，
 *    而路由模块在 server.js 顶部就被 require（那时 db 还没 init）。
 *    所以不能在模块加载时建表，改成首次调用时建一次、结果缓存。
 * 3) **不设外键、删终端不删工单**：工单是排查依据，必须活得比设备久。
 *    删除时把 issues.device_id 置空（保留标题里的设备名），而不是级联删除。
 */

const issueDb = require('./db');

/** 类型清单：按医院信息科实际见过的终端归类，前端下拉直接用 */
const KINDS = ['PC', '笔记本', '打印机', '一体机', '自助机', '叫号机', '显示屏', '扫码枪', '投影', '网络设备', '其他'];
/** 状态清单。「报废」不删记录，历史工单还要能看出来是哪台 */
const STATUSES = ['在用', '备用', '维修中', '借出', '报废'];
/** 保修提醒阈值（天）。与合同「到期提醒」的 30 天口径保持一致，避免两个地方说法不同 */
const WARRANTY_SOON_DAYS = 30;

let ready = false;
let initError = '';

/**
 * 建表 + 补列。幂等，可反复调用。
 * 返回 false 表示库还没就绪（getDb 抛错），调用方据此返回一句人话而不是 500 堆栈堆给用户。
 */
function ensure() {
  if (ready) return true;
  try {
    const db = issueDb.getDb();
    db.exec(`
      CREATE TABLE IF NOT EXISTS terminals (
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
        created_by INTEGER,
        creator_name TEXT NOT NULL DEFAULT '',
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_terminals_dept ON terminals(department);
      CREATE INDEX IF NOT EXISTS idx_terminals_kind ON terminals(kind);
      CREATE INDEX IF NOT EXISTS idx_terminals_status ON terminals(status);
      CREATE INDEX IF NOT EXISTS idx_terminals_asset ON terminals(asset_no);
      CREATE INDEX IF NOT EXISTS idx_terminals_warranty ON terminals(warranty_end);
    `);
    // 老库补列：CREATE TABLE IF NOT EXISTS 对已存在的表不做任何事，缺列会在某个具体操作上才炸
    const have = new Set(db.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name));
    const spec = {
      asset_no: "TEXT NOT NULL DEFAULT ''", name: "TEXT NOT NULL DEFAULT ''",
      kind: "TEXT NOT NULL DEFAULT 'PC'", brand: "TEXT NOT NULL DEFAULT ''",
      model: "TEXT NOT NULL DEFAULT ''", sn: "TEXT NOT NULL DEFAULT ''",
      mac: "TEXT NOT NULL DEFAULT ''", ip: "TEXT NOT NULL DEFAULT ''",
      department: "TEXT NOT NULL DEFAULT ''", location: "TEXT NOT NULL DEFAULT ''",
      owner: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT '在用'",
      purchase_date: "TEXT NOT NULL DEFAULT ''", warranty_end: "TEXT NOT NULL DEFAULT ''",
      vendor: "TEXT NOT NULL DEFAULT ''", note: "TEXT NOT NULL DEFAULT ''",
      created_by: 'INTEGER', creator_name: "TEXT NOT NULL DEFAULT ''",
      created_at: 'TEXT', updated_at: 'TEXT',
    };
    const added = [];
    Object.keys(spec).forEach((col) => {
      if (have.has(col)) return;
      db.exec('ALTER TABLE terminals ADD COLUMN ' + col + ' ' + spec[col]);
      added.push(col);
    });
    if (added.length) console.log('[terminals] terminals 已补列：' + added.join('、'));
    ready = true;
    return true;
  } catch (e) {
    initError = (e && e.message) || String(e);
    return false;
  }
}

/* ==================== 工具 ==================== */

function nowLocal() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function trim(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/** 日期只认 YYYY-MM-DD，别的一律存空串（date 输入框回填 '' 才不会显示 1970） */
function normDate(v) {
  const s = trim(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** 两个日期相差的天数（b - a）。用 UTC 零点算，避开夏令时与本地时区把天数算成 29.7 的问题 */
function daysBetween(a, b) {
  const pa = Date.parse(a + 'T00:00:00Z');
  const pb = Date.parse(b + 'T00:00:00Z');
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return Math.round((pb - pa) / 86400000);
}

function todayStr() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' : '') + n;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/**
 * 保修状态（返回给前端直接决定颜色）：
 *   none    没填保修期
 *   expired 已过保（days 为负）
 *   soon    30 天内到期
 *   ok      还在保
 * 注意「今天到期」算 soon 而不是 expired —— 过保当天往往还能走保修流程。
 */
function warrantyOf(end) {
  if (!end) return { state: 'none', days: null, text: '未登记保修' };
  const days = daysBetween(todayStr(), end);
  if (days === null) return { state: 'none', days: null, text: '未登记保修' };
  if (days < 0) return { state: 'expired', days, text: '已过保 ' + (-days) + ' 天' };
  if (days <= WARRANTY_SOON_DAYS) return { state: 'soon', days, text: days === 0 ? '今天到期' : '还剩 ' + days + ' 天' };
  return { state: 'ok', days, text: '还剩 ' + days + ' 天' };
}

/** 出库统一整形：补派生字段（保修状态、工单计数） */
function shape(row) {
  if (!row) return null;
  const w = warrantyOf(row.warranty_end || '');
  return {
    id: row.id,
    asset_no: row.asset_no || '',
    name: row.name || '',
    kind: row.kind || 'PC',
    brand: row.brand || '',
    model: row.model || '',
    sn: row.sn || '',
    mac: row.mac || '',
    ip: row.ip || '',
    department: row.department || '',
    location: row.location || '',
    owner: row.owner || '',
    status: row.status || '在用',
    purchase_date: row.purchase_date || '',
    warranty_end: row.warranty_end || '',
    vendor: row.vendor || '',
    note: row.note || '',
    created_by: row.created_by || null,
    creator_name: row.creator_name || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    warranty_state: w.state,
    warranty_days: w.days,
    warranty_text: w.text,
    issue_count: row.issue_count === undefined ? undefined : Number(row.issue_count || 0),
    open_issue_count: row.open_issue_count === undefined ? undefined : Number(row.open_issue_count || 0),
    last_issue_at: row.last_issue_at === undefined ? undefined : (row.last_issue_at || ''),
  };
}

/** 列表基础 SELECT：带工单计数的相关子查询。
 *  用子查询而不是 GROUP BY + LEFT JOIN：一个终端挂多条工单时 JOIN 会让行数膨胀、
 *  分页 LIMIT 直接错位（第 2 页看到的可能是第 1 页的尾巴）。 */
const SELECT_WITH_STATS = `
  SELECT t.*,
    (SELECT COUNT(*) FROM issues i WHERE i.device_id = t.id) AS issue_count,
    (SELECT COUNT(*) FROM issues i WHERE i.device_id = t.id
       AND i.status NOT IN ('resolved','closed')) AS open_issue_count,
    (SELECT MAX(i.report_time) FROM issues i WHERE i.device_id = t.id) AS last_issue_at
  FROM terminals t
`;

/* ==================== 查询 ==================== */

const SORTS = {
  // 默认按科室 + 位置排：现场找人时是按「哪个科室哪一层」找的，不是按录入时间
  dept: 'ORDER BY (t.department = \'\') ASC, t.department ASC, t.location ASC, t.name ASC, t.id ASC',
  recent: 'ORDER BY t.id DESC',
  warranty: "ORDER BY (t.warranty_end = '') ASC, t.warranty_end ASC, t.id ASC",
  issues: 'ORDER BY issue_count DESC, t.id DESC',
  name: 'ORDER BY t.name ASC, t.id ASC',
};

function list(opts) {
  if (!ensure()) throw new Error('终端台账数据表未就绪：' + initError);
  const o = opts || {};
  const db = issueDb.getDb();
  const kw = trim(o.keyword);
  const dept = trim(o.department);
  const kind = trim(o.kind);
  const status = trim(o.status);
  const warranty = trim(o.warranty);
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(o.pageSize) || 50));

  const where = [];
  const params = [];
  if (kw) {
    const lk = '%' + kw + '%';
    where.push('(t.asset_no LIKE ? OR t.name LIKE ? OR t.sn LIKE ? OR t.mac LIKE ?'
      + ' OR t.ip LIKE ? OR t.department LIKE ? OR t.location LIKE ? OR t.owner LIKE ?'
      + ' OR t.brand LIKE ? OR t.model LIKE ?)');
    params.push(lk, lk, lk, lk, lk, lk, lk, lk, lk, lk);
  }
  if (dept) { where.push('t.department = ?'); params.push(dept); }
  if (kind) { where.push('t.kind = ?'); params.push(kind); }
  if (status) { where.push('t.status = ?'); params.push(status); }
  // 保修筛选放在 SQL 里没法复用 warrantyOf 的口径，这里按同一套边界手写一遍，
  // 并在自测里用「今天 / 今天+30 / 今天-1」三个边界钉住
  if (warranty === 'expired') {
    where.push("t.warranty_end != '' AND t.warranty_end < date('now','localtime')");
  } else if (warranty === 'soon') {
    where.push("t.warranty_end != '' AND t.warranty_end >= date('now','localtime')"
      + " AND t.warranty_end <= date('now','localtime','+" + WARRANTY_SOON_DAYS + " days')");
  } else if (warranty === 'none') {
    where.push("t.warranty_end = ''");
  }
  const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const order = SORTS[trim(o.sort)] || SORTS.dept;

  const total = db.prepare('SELECT COUNT(*) c FROM terminals t ' + w).get(...params).c;
  const rows = db.prepare(SELECT_WITH_STATS + ' ' + w + ' ' + order + ' LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize);

  // 统计随列表一起给（省一次往返，且始终与当前筛选无关 —— 它反映的是全量家底）
  const stat = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = '在用' THEN 1 ELSE 0 END) AS in_use,
      SUM(CASE WHEN status = '维修中' THEN 1 ELSE 0 END) AS repairing,
      SUM(CASE WHEN status = '报废' THEN 1 ELSE 0 END) AS scrapped,
      SUM(CASE WHEN warranty_end != '' AND warranty_end < date('now','localtime') THEN 1 ELSE 0 END) AS expired,
      SUM(CASE WHEN warranty_end != '' AND warranty_end >= date('now','localtime')
                AND warranty_end <= date('now','localtime','+${WARRANTY_SOON_DAYS} days') THEN 1 ELSE 0 END) AS soon,
      SUM(CASE WHEN warranty_end = '' THEN 1 ELSE 0 END) AS no_warranty
    FROM terminals
  `).get();

  const kinds = db.prepare(
    'SELECT kind AS name, COUNT(*) AS cnt FROM terminals GROUP BY kind ORDER BY cnt DESC, kind ASC'
  ).all().map((k) => ({ name: k.name, cnt: k.cnt }));

  const departments = db.prepare(
    "SELECT department AS name, COUNT(*) AS cnt FROM terminals WHERE department != ''"
    + ' GROUP BY department ORDER BY department ASC'
  ).all().map((d) => ({ name: d.name, cnt: d.cnt }));

  return {
    list: rows.map(shape),
    total, page, pageSize,
    stats: {
      total: stat.total || 0,
      in_use: stat.in_use || 0,
      repairing: stat.repairing || 0,
      scrapped: stat.scrapped || 0,
      expired: stat.expired || 0,
      soon: stat.soon || 0,
      no_warranty: stat.no_warranty || 0,
    },
    kinds, departments,
  };
}

function get(id) {
  if (!ensure()) throw new Error('终端台账数据表未就绪：' + initError);
  const db = issueDb.getDb();
  const row = db.prepare(SELECT_WITH_STATS + ' WHERE t.id = ?').get(Number(id));
  return row ? shape(row) : null;
}

/**
 * 这台设备的历史工单。刻意不做时间窗限制：
 * 「这台打印机装了三年修了十一次」这个结论本身就是换新的依据，截断反而看不到。
 */
function issuesOf(id, limit) {
  if (!ensure()) return [];
  const db = issueDb.getDb();
  const n = Math.min(500, Math.max(1, Number(limit) || 100));
  return db.prepare(`
    SELECT id, no, title, status, urgency, department, reporter, assignee_name,
           report_time, created_at, closed_at
    FROM issues WHERE device_id = ? ORDER BY report_time DESC, id DESC LIMIT ?
  `).all(Number(id), n).map((r) => ({
    id: r.id, no: r.no, title: r.title, status: r.status, urgency: r.urgency,
    department: r.department || '', reporter: r.reporter || '',
    assignee_name: r.assignee_name || '',
    report_time: r.report_time || '', created_at: r.created_at || '',
    closed_at: r.closed_at || '',
  }));
}

/** 工单表单的下拉候选：默认只给「在用/维修中/备用」，报废的不该再被报障选到 */
function options(opts) {
  if (!ensure()) return { list: [], total: 0 };
  const db = issueDb.getDb();
  const o = opts || {};
  const kw = trim(o.keyword);
  const dept = trim(o.department);
  const where = ["status != '报废'"];
  const params = [];
  if (kw) {
    const lk = '%' + kw + '%';
    where.push('(name LIKE ? OR asset_no LIKE ? OR location LIKE ? OR ip LIKE ? OR sn LIKE ?)');
    params.push(lk, lk, lk, lk, lk);
  }
  if (dept) { where.push('department = ?'); params.push(dept); }
  const rows = db.prepare(
    'SELECT id, asset_no, name, kind, department, location, ip, owner, status'
    + ' FROM terminals WHERE ' + where.join(' AND ')
    + ' ORDER BY (department = \'\') ASC, department ASC, location ASC, name ASC LIMIT 300'
  ).all(...params);
  return { list: rows, total: rows.length };
}

/** 下拉用的元数据（类型/状态/科室清单） */
function meta() {
  const depts = [];
  if (ensure()) {
    try {
      const db = issueDb.getDb();
      db.prepare("SELECT DISTINCT department FROM terminals WHERE department != '' ORDER BY department")
        .all().forEach((r) => depts.push(r.department));
    } catch (e) { /* 读不到就给空清单，前端仍能手填 */ }
  }
  return { kinds: KINDS.slice(), statuses: STATUSES.slice(), departments: depts, warranty_soon_days: WARRANTY_SOON_DAYS };
}

/* ==================== 写 ==================== */

function pickInput(b) {
  return {
    asset_no: trim(b.asset_no, 60),
    name: trim(b.name, 80),
    kind: KINDS.indexOf(trim(b.kind)) >= 0 ? trim(b.kind) : 'PC',
    brand: trim(b.brand, 60),
    model: trim(b.model, 60),
    sn: trim(b.sn, 80),
    mac: trim(b.mac, 60),
    ip: trim(b.ip, 60),
    department: trim(b.department, 60),
    location: trim(b.location, 80),
    owner: trim(b.owner, 40),
    status: STATUSES.indexOf(trim(b.status)) >= 0 ? trim(b.status) : '在用',
    purchase_date: normDate(b.purchase_date),
    warranty_end: normDate(b.warranty_end),
    vendor: trim(b.vendor, 80),
    note: trim(b.note, 500),
  };
}

function create(data, user) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const d = pickInput(data || {});
  if (!d.name) return { ok: false, error: '设备名称不能为空（建议写清位置，如「门诊3号诊室工作站」）' };
  const now = nowLocal();
  const info = db.prepare(`
    INSERT INTO terminals(asset_no, name, kind, brand, model, sn, mac, ip, department, location,
                          owner, status, purchase_date, warranty_end, vendor, note,
                          created_by, creator_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    d.asset_no, d.name, d.kind, d.brand, d.model, d.sn, d.mac, d.ip, d.department, d.location,
    d.owner, d.status, d.purchase_date, d.warranty_end, d.vendor, d.note,
    (user && user.id) || null, (user && (user.real_name || user.username)) || '', now, now
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function update(id, data) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const row = db.prepare('SELECT * FROM terminals WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '设备不存在', notFound: true };
  // 未传的字段保持原值（与 bookmarks.update 同一套语义），避免前端只提交部分字段时把别的清空
  const b = data || {};
  const d = pickInput({
    asset_no: b.asset_no === undefined ? row.asset_no : b.asset_no,
    name: b.name === undefined ? row.name : b.name,
    kind: b.kind === undefined ? row.kind : b.kind,
    brand: b.brand === undefined ? row.brand : b.brand,
    model: b.model === undefined ? row.model : b.model,
    sn: b.sn === undefined ? row.sn : b.sn,
    mac: b.mac === undefined ? row.mac : b.mac,
    ip: b.ip === undefined ? row.ip : b.ip,
    department: b.department === undefined ? row.department : b.department,
    location: b.location === undefined ? row.location : b.location,
    owner: b.owner === undefined ? row.owner : b.owner,
    status: b.status === undefined ? row.status : b.status,
    purchase_date: b.purchase_date === undefined ? row.purchase_date : b.purchase_date,
    warranty_end: b.warranty_end === undefined ? row.warranty_end : b.warranty_end,
    vendor: b.vendor === undefined ? row.vendor : b.vendor,
    note: b.note === undefined ? row.note : b.note,
  });
  if (!d.name) return { ok: false, error: '设备名称不能为空' };
  db.prepare(`
    UPDATE terminals SET asset_no = ?, name = ?, kind = ?, brand = ?, model = ?, sn = ?, mac = ?,
      ip = ?, department = ?, location = ?, owner = ?, status = ?, purchase_date = ?,
      warranty_end = ?, vendor = ?, note = ?, updated_at = ?
    WHERE id = ?
  `).run(
    d.asset_no, d.name, d.kind, d.brand, d.model, d.sn, d.mac, d.ip, d.department, d.location,
    d.owner, d.status, d.purchase_date, d.warranty_end, d.vendor, d.note, nowLocal(), Number(id)
  );
  return { ok: true, id: Number(id) };
}

/**
 * 删除。**先把工单的 device_id 置空**再删本体：
 * 工单要看得出「当初是这台机器报的」，但设备记录删了就不该再被任何地方引用。
 * 置空而不是级联删工单 —— 工单是运维历史，不能因为清理台账而消失。
 */
function remove(id) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const row = db.prepare('SELECT id, name FROM terminals WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '设备不存在', notFound: true };
  const n = db.prepare('UPDATE issues SET device_id = NULL WHERE device_id = ?').run(Number(id)).changes;
  db.prepare('DELETE FROM terminals WHERE id = ?').run(Number(id));
  return { ok: true, detached_issues: n };
}

/** 供工单侧使用：传 device_id 时取一条精简信息（自动带科室/位置用） */
function brief(id) {
  if (!id || !ensure()) return null;
  try {
    const db = issueDb.getDb();
    const r = db.prepare('SELECT id, asset_no, name, kind, department, location, ip, owner, status FROM terminals WHERE id = ?')
      .get(Number(id));
    return r || null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  KINDS, STATUSES, WARRANTY_SOON_DAYS,
  ensure, list, get, issuesOf, options, meta,
  create, update, remove, brief, shape, warrantyOf, daysBetween,
};
