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

/**
 * 台账登记字段（对应信息科那份《信息设备台账》Excel 的列，逐个对齐、不改名）。
 * 刻意保留 Excel 的原词（「统计类别」「设备性质」而不是自造「设备分类」），
 * 因为导出的文件还要能被人拿回 Excel 里对着看，两边用词不一致会被当成两个字段。
 *
 * 与「系统自己用」的字段分开：
 *   登记字段 = 台账里有的东西，导入时按列名直接落库；
 *   系统字段 = 名称/类型/状态/责任人/保修至/备注，Excel 里没有，由系统维护。
 */
const EXCEL_COLUMNS = [
  { key: 'campus', name: '院区' },
  { key: 'asset_no', name: '资产编码' },
  { key: 'area', name: '区域' },
  { key: 'floor', name: '楼层' },
  { key: 'department', name: '科室' },
  { key: 'location', name: '位置' },
  { key: 'stat_category', name: '统计类别' },
  { key: 'nature', name: '设备性质' },
  { key: 'hostname', name: '工作组/计算机名' },
  { key: 'ip', name: '内网地址' },
  { key: 'ip_extra', name: '外网地址' },
  { key: 'mac', name: 'MAC' },
  { key: 'sn', name: 'SN码' },
  { key: 'produce_date', name: '生产日期', date: true },
  { key: 'model', name: '型号' },
  { key: 'os', name: '操作系统' },
  { key: 'cpu', name: 'CPU' },
  { key: 'disk', name: '硬盘' },
  { key: 'ram', name: '内存' },
  { key: 'monitor', name: '显示器尺寸' },
  { key: 'consumable', name: '耗材型号' },
];

/** 系统字段：Excel 里没有，导出时追加在末尾（导入时也认这几列，便于导出→改→再导入） */
const SYSTEM_COLUMNS = [
  { key: 'name', name: '设备名称' },
  { key: 'kind', name: '类型' },
  { key: 'owner', name: '责任人' },
  { key: 'status', name: '状态' },
  { key: 'warranty_end', name: '保修至', date: true },
  { key: 'purchase_date', name: '采购日期', date: true },
  { key: 'brand', name: '品牌' },
  { key: 'vendor', name: '供应商' },
  { key: 'note', name: '备注' },
];

/** 全部可写字段（顺序即 INSERT / UPDATE 的列顺序，改一处两边同时生效） */
const FIELDS = EXCEL_COLUMNS.map((c) => c.key).concat(SYSTEM_COLUMNS.map((c) => c.key));

/** 「-」在这个台账里是「没有」的意思（原表大量用它占位），一律按空处理 */
function isBlank(v) {
  const s = trim(v);
  return !s || s === '-' || s === '—' || s === '－' || s === '/';
}

/**
 * 统计类别 → 系统里的类型。Excel 有 11 种统计类别，系统的 KINDS 是 11 个粗类，
 * 两者不是一一对应（黑白/彩色/网络/针式/其他打印机都归「打印机」）。
 * 原始值仍完整存在 stat_category 里，不丢信息。
 */
function kindOfStat(cat) {
  const s = trim(cat);
  if (!s) return 'PC';
  if (KINDS.indexOf(s) >= 0) return s;              // 已经是系统类型词（导出再导入时）
  if (/笔记本|便携/.test(s)) return '笔记本';
  if (/一体机|多功能/.test(s)) return '一体机';
  if (/打印机|复印机|传真/.test(s)) return '打印机';
  if (/自助/.test(s)) return '自助机';
  if (/叫号/.test(s)) return '叫号机';
  if (/显示器|显示屏|大屏/.test(s)) return '显示屏';
  if (/扫描|扫码/.test(s)) return '扫码枪';
  if (/投影/.test(s)) return '投影';
  if (/交换|路由|网关|防火墙/.test(s)) return '网络设备';
  if (/台式|计算机|电脑|工作站/.test(s)) return 'PC';
  return '其他';
}

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
      campus: "TEXT NOT NULL DEFAULT ''", area: "TEXT NOT NULL DEFAULT ''",
      floor: "TEXT NOT NULL DEFAULT ''", stat_category: "TEXT NOT NULL DEFAULT ''",
      nature: "TEXT NOT NULL DEFAULT ''", ip_extra: "TEXT NOT NULL DEFAULT ''",
      produce_date: "TEXT NOT NULL DEFAULT ''", hostname: "TEXT NOT NULL DEFAULT ''",
      os: "TEXT NOT NULL DEFAULT ''", cpu: "TEXT NOT NULL DEFAULT ''",
      disk: "TEXT NOT NULL DEFAULT ''", ram: "TEXT NOT NULL DEFAULT ''",
      monitor: "TEXT NOT NULL DEFAULT ''", consumable: "TEXT NOT NULL DEFAULT ''",
      src_key: "TEXT NOT NULL DEFAULT ''", src_sheet: "TEXT NOT NULL DEFAULT ''",
      import_at: "TEXT NOT NULL DEFAULT ''",
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

    // ★ 新列的索引必须放在补列**之后**建。
    //   放进上面那段 exec 的话，老库（表已存在但没有这些列）会在这里直接抛
    //   「no such column: src_key」，被外层 catch 吃成「台账未就绪」——整个模块下线，
    //   而且新建库一切正常，只有升级的机器才会炸（2026-10-30 实测踩到）。
    try {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_terminals_srckey ON terminals(src_key);
        CREATE INDEX IF NOT EXISTS idx_terminals_area ON terminals(campus, area, floor);
      `);
    } catch (e) {
      console.warn('[terminals] 建索引失败（不影响使用）：' + ((e && e.message) || e));
    }

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
  // 按 FIELDS 逐列搬，而不是手写 30 个字段 —— 手写的话每加一列就漏一次，
  // 而漏掉的表现是「导入成功但详情里看不到」，极难查
  const out = { id: row.id };
  FIELDS.forEach((k) => { out[k] = row[k] == null ? '' : row[k]; });
  if (!out.kind) out.kind = 'PC';
  if (!out.status) out.status = '在用';
  const w = warrantyOf(out.warranty_end || '');
  out.created_by = row.created_by || null;
  out.creator_name = row.creator_name || '';
  out.created_at = row.created_at || '';
  out.updated_at = row.updated_at || '';
  out.src_sheet = row.src_sheet || '';
  out.import_at = row.import_at || '';
  out.warranty_state = w.state;
  out.warranty_days = w.days;
  out.warranty_text = w.text;
  out.issue_count = row.issue_count === undefined ? undefined : Number(row.issue_count || 0);
  out.open_issue_count = row.open_issue_count === undefined ? undefined : Number(row.open_issue_count || 0);
  out.last_issue_at = row.last_issue_at === undefined ? undefined : (row.last_issue_at || '');
  return out;
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
      + ' OR t.ip LIKE ? OR t.ip_extra LIKE ? OR t.department LIKE ? OR t.location LIKE ? OR t.owner LIKE ?'
      + ' OR t.brand LIKE ? OR t.model LIKE ? OR t.campus LIKE ? OR t.area LIKE ? OR t.floor LIKE ?'
      + ' OR t.hostname LIKE ? OR t.stat_category LIKE ? OR t.os LIKE ?)');
    params.push(lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk, lk);
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

/** 下拉用的元数据（类型/状态/科室清单，以及台账里出现过的院区/区域/楼层/统计类别/设备性质） */
function meta() {
  const depts = [];
  const campuses = [];
  const areas = [];
  const floors = [];
  const statCategories = [];
  const natures = [];
  const distinct = (sql, arr) => {
    try { issueDb.getDb().prepare(sql).all().forEach((r) => arr.push(r.v)); }
    catch (e) { /* 读不到就给空清单，前端仍能手填 */ }
  };
  if (ensure()) {
    distinct("SELECT DISTINCT department AS v FROM terminals WHERE department != '' ORDER BY v", depts);
    distinct("SELECT DISTINCT campus AS v FROM terminals WHERE campus != '' ORDER BY v", campuses);
    distinct("SELECT DISTINCT area AS v FROM terminals WHERE area != '' ORDER BY v", areas);
    distinct("SELECT DISTINCT floor AS v FROM terminals WHERE floor != '' ORDER BY v", floors);
    distinct("SELECT DISTINCT stat_category AS v FROM terminals WHERE stat_category != '' ORDER BY v", statCategories);
    distinct("SELECT DISTINCT nature AS v FROM terminals WHERE nature != '' ORDER BY v", natures);
  }
  return {
    kinds: KINDS.slice(), statuses: STATUSES.slice(), departments: depts,
    campuses, areas, floors, stat_categories: statCategories, natures,
    warranty_soon_days: WARRANTY_SOON_DAYS,
  };
}

/* ==================== 写 ==================== */

/** 各字段落库前的长度上限（Excel 里「显示器尺寸」这类值带单引号和品牌，给宽一点） */
const LIMITS = {
  asset_no: 60, name: 80, brand: 60, model: 60, sn: 80, mac: 60,
  ip: 60, ip_extra: 60, department: 60, location: 80, owner: 40,
  vendor: 80, note: 500, campus: 40, area: 40, floor: 20,
  stat_category: 40, nature: 40, hostname: 80, os: 40,
  cpu: 80, disk: 40, ram: 40, monitor: 40, consumable: 120,
};

function pickInput(b) {
  const src = b || {};
  const d = {};
  FIELDS.forEach((k) => {
    if (k === 'status') d[k] = STATUSES.indexOf(trim(src.status)) >= 0 ? trim(src.status) : '在用';
    else if (k === 'purchase_date' || k === 'warranty_end' || k === 'produce_date') d[k] = normDate(src[k]);
    else d[k] = trim(src[k], LIMITS[k] || 80);
  });
  // 类型：先认系统类型词，认不出再从「统计类别」推（Excel 导入的行往往只有统计类别）
  d.kind = KINDS.indexOf(d.kind) >= 0 ? d.kind : kindOfStat(d.stat_category);
  d.mac = normMac(d.mac);
  return d;
}

function create(data, user) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const d = pickInput(data || {});
  if (!d.name) return { ok: false, error: '设备名称不能为空（建议写清位置，如「门诊3号诊室工作站」）' };
  const now = nowLocal();
  const cols = FIELDS.concat(['src_key', 'created_by', 'creator_name', 'created_at', 'updated_at']);
  const vals = FIELDS.map((k) => d[k]).concat([
    keyOf(d),
    (user && user.id) || null, (user && (user.real_name || user.username)) || '', now, now,
  ]);
  const info = db.prepare(
    'INSERT INTO terminals(' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')'
  ).run(...vals);
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function update(id, data) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const row = db.prepare('SELECT * FROM terminals WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '设备不存在', notFound: true };
  // 未传的字段保持原值（与 bookmarks.update 同一套语义），避免前端只提交部分字段时把别的清空
  const b = data || {};
  const merged = {};
  FIELDS.forEach((k) => { merged[k] = b[k] === undefined ? row[k] : b[k]; });
  const d = pickInput(merged);
  if (!d.name) return { ok: false, error: '设备名称不能为空' };
  // src_key 一并刷新：改了科室/位置/MAC 之后旧键就失效了，
  // 留着旧键会让下一次导入匹配到「改之前的那台」，把用户手改的内容又写回去
  db.prepare(
    'UPDATE terminals SET ' + FIELDS.map((k) => k + ' = ?').join(', ')
    + ', src_key = ?, updated_at = ? WHERE id = ?'
  ).run(...FIELDS.map((k) => d[k]), keyOf(d), nowLocal(), Number(id));
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

/**
 * 供【IP 管理】用：只取「填了 IP」的终端，字段精简、不分页。
 *
 * 那边要的是一张「这个地址被谁占着」的对照表，工单统计、保修状态一律用不上，
 * 所以不套 SELECT_WITH_STATS —— 每行三个子查询乘几百行是白费。
 *
 * 报废设备也返回（released=true）：机器报废了地址通常已经回收，算不算占用由调用方定，
 * 但**必须能让用户看见**，否则同一台机器的旧 IP 会静静地挡住新设备。
 */
function ipList() {
  if (!ensure()) return [];
  try {
    return issueDb.getDb().prepare(
      `SELECT id, name, kind, department, location, owner, ip, ip_extra, mac, hostname, status
       FROM terminals
       WHERE TRIM(ip) <> ''
       ORDER BY id ASC`
    ).all().map((r) => ({
      terminal_id: Number(r.id),
      name: r.name || '',
      kind: r.kind || '',
      department: r.department || '',
      location: r.location || '',
      owner: r.owner || '',
      ip: String(r.ip || '').trim(),
      ip_extra: r.ip_extra || '',
      mac: r.mac || '',
      hostname: r.hostname || '',
      status: r.status || '',
      released: r.status === '报废',
    }));
  } catch (e) {
    console.warn('[terminals] 读取终端 IP 清单失败（IP 管理仍可用）：' + ((e && e.message) || e));
    return [];
  }
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

/* ==================== 导入 / 导出 ==================== */

/**
 * MAC 归一化。原表里有三种写法混着：
 *   「外网：80-3F-5D-08-F9-55」（带内外网前缀）
 *   「F8:D0:27:20:56:0C」（冒号分隔）
 *   纯「04-0E-3C-E2-A6-14」
 * 不归一化的话，同一台机器换个写法就会被当成新设备重复入库。
 * 认不出 12 位十六进制的就原样保留大写，不硬编造。
 */
function normMac(v) {
  let s = trim(v);
  if (!s) return '';
  s = s.replace(/^(内网|外网|有线|无线)\s*[:：]\s*/, '');
  s = s.split(/[\s/、,;；]+/)[0] || s;
  const hex = s.replace(/[^0-9A-Fa-f]/g, '').toUpperCase();
  if (hex.length === 12) return hex.replace(/(.{2})(?=.)/g, '$1-');
  return s.toUpperCase();
}

/** 名称由台账字段推出来：Excel 没有「设备名称」列，但工单/列表里必须有个能认的名字 */
function deriveName(d) {
  const dept = d.department, loc = d.location;
  const extra = d.stat_category || d.model;
  if (dept && loc) return dept + ' ' + loc;
  if (dept) return extra ? dept + ' ' + extra : dept;
  if (loc) return extra ? extra + ' ' + loc : loc;
  if (extra) return [d.stat_category, d.model].filter(Boolean).join(' ');
  return '';
}

/**
 * 查重键。优先级 MAC → SN → 资产编码 →（都没有时）科室+位置+统计类别+型号。
 * 原表 373 行里只有 94 行有真实资产编码（182 行写着「-」），
 * 所以绝不能拿资产编码当主键，但也不能不用它 —— 它毕竟是院里贴标签认的那串。
 *
 * ★ 复合键要求这四个字段里**至少有两个非空**。真实台账里有七十多行只写了「体检科」
 *   这样的占位行，若允许单字段成立，它们会互相认成同一台 —— 第一次新增、后面全变成
 *   「更新」，把几十条不同的记录压成一条。这类行统一记为「信息不足」交给人看。
 */
function keyOf(d) {
  if (d.mac) return 'M:' + d.mac;
  if (d.sn) return 'S:' + d.sn.toUpperCase();
  if (d.asset_no) return 'A:' + d.asset_no.toUpperCase();
  const parts = [d.department, d.location, d.stat_category, d.model].map((x) => trim(x));
  if (parts.filter(Boolean).length >= 2) return 'C:' + parts.join('|');
  return '';
}

/** 一行 Excel（已按列名映射成内部字段名）→ 可落库的对象 */
function fromImport(raw) {
  const src = raw || {};
  const o = {};
  FIELDS.forEach((k) => { o[k] = isBlank(src[k]) ? '' : trim(src[k]); });
  o.mac = normMac(src.mac);
  return o;
}

/**
 * 批量导入。dryRun 时整批做完再 ROLLBACK —— 这样「预览」和「真导入」走的是同一段代码，
 * 不会出现「预览说新增 300、真导入了 297」这种对不上的情况。
 *
 * 合并规则（刻意如此）：
 *   · 只覆盖非空值。Excel 里大量空白格，若连空值一起写，手工补的信息会被台账洗掉。
 *   · 一个字段都没变 → 记为「无变化」，不刷新 updated_at，避免整表看起来刚被改过。
 *   · mode='skip' 时已存在的直接跳过（第一次摸清数据时用，避免误改）。
 */
function importRows(rows, opts) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const o = opts || {};
  const dryRun = !!o.dryRun;
  const mode = o.mode === 'skip' ? 'skip' : 'update';
  const user = o.user || null;
  const userName = (user && (user.real_name || user.username)) || '';
  const now = nowLocal();

  const res = {
    dryRun, mode, total: rows.length,
    created: 0, updated: 0, unchanged: 0, skipped: 0,
    thin: [], failed: [], samples: [], sheets: {},
  };

  const label = {};
  EXCEL_COLUMNS.concat(SYSTEM_COLUMNS).forEach((c) => { label[c.key] = c.name; });

  const cols = FIELDS.concat(['src_key', 'src_sheet', 'import_at']);
  const insertSql = 'INSERT INTO terminals(' + cols.join(', ')
    + ', created_by, creator_name, created_at, updated_at) VALUES ('
    + cols.map(() => '?').join(', ') + ', ?, ?, ?, ?)';
  const selByKey = db.prepare('SELECT * FROM terminals WHERE src_key = ? ORDER BY id LIMIT 1');
  const selByCol = {
    mac: db.prepare('SELECT * FROM terminals WHERE mac = ? ORDER BY id LIMIT 1'),
    sn: db.prepare('SELECT * FROM terminals WHERE sn = ? ORDER BY id LIMIT 1'),
    asset_no: db.prepare('SELECT * FROM terminals WHERE asset_no = ? ORDER BY id LIMIT 1'),
  };

  db.exec('BEGIN');
  try {
    rows.forEach((raw, i) => {
      const sheet = trim(raw && raw.__sheet) || '未命名';
      const rowNo = Number(raw && raw.__row) || (i + 2);
      const bucket = res.sheets[sheet] || (res.sheets[sheet] = { created: 0, updated: 0, unchanged: 0, skipped: 0, thin: 0, failed: 0 });

      const d = pickInput(fromImport(raw));
      const key = keyOf(d);
      if (!key) {
        // 整行空（Excel 底部一大片带格式的空行）直接忽略，不算任何账
        if (!FIELDS.some((k) => d[k])) return;
        // 只写了科室 / 只写了位置 的占位行：不够认，也不该硬塞一条无从辨认的记录
        res.thin.push({
          sheet, row: rowNo,
          hint: [d.department, d.location, d.stat_category, d.model].filter(Boolean).join(' / ') || '（无内容）',
          reason: '信息不足：至少要有「位置」或「统计类别/型号」其中之一，才能确认是哪台设备',
        });
        bucket.thin++;
        return;
      }

      let hit = selByKey.get(key);
      if (!hit && d.mac) hit = selByCol.mac.get(d.mac);
      if (!hit && d.sn) hit = selByCol.sn.get(d.sn);
      if (!hit && d.asset_no) hit = selByCol.asset_no.get(d.asset_no);
      // 兜底：手工录入的设备没有 src_key（它只在导入时写），光靠 src_key 会认不出来，
      // 于是「导出 → 原样再导入」会整份复制一遍。按业务键再查一次。
      if (!hit && key.charAt(0) === 'C:') {
        hit = db.prepare('SELECT * FROM terminals WHERE department = ? AND location = ?'
          + ' AND stat_category = ? AND model = ? ORDER BY id LIMIT 1')
          .get(d.department, d.location, d.stat_category, d.model);
      }

      const showName = d.name || deriveName(d) || '(未命名)';

      if (hit) {
        if (mode === 'skip') {
          res.skipped++; bucket.skipped++;
          res.samples.push({ action: '跳过', name: hit.name || showName, sheet, row: rowNo, changed: [] });
          return;
        }
        const changed = [];
        FIELDS.forEach((k) => {
          if (k === 'kind') return;               // 类型由统计类别派生，不单独报「改了类型」
          const nv = d[k];
          if (!nv) return;                        // ★ 空值不覆盖已有值
          const ov = hit[k] == null ? '' : hit[k];
          if (nv !== ov) changed.push(k);
        });
        if (!changed.length) {
          res.unchanged++; bucket.unchanged++;
          // 老记录（手工录入）没有 src_key，顺手补上，下次导入就不用再全表比
          if (hit.src_key !== key) {
            db.prepare('UPDATE terminals SET src_key = ? WHERE id = ?').run(key, hit.id);
          }
          return;
        }
        const sets = changed.map((k) => k + ' = ?').concat(['src_key = ?', 'src_sheet = ?', 'import_at = ?', 'updated_at = ?']);
        const vals = changed.map((k) => d[k]).concat([key, sheet, now, now, hit.id]);
        db.prepare('UPDATE terminals SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
        res.updated++; bucket.updated++;
        res.samples.push({
          action: '更新', name: hit.name || showName, sheet, row: rowNo,
          changed: changed.map((k) => label[k] || k),
        });
        return;
      }

      // 新增：名称推不出来就没法在列表/工单里被认出来，算失败而不是硬塞一条无名记录
      if (!d.name) d.name = deriveName(d);
      if (!d.name) {
        res.failed.push({ sheet, row: rowNo, reason: '无法生成设备名称（科室、位置、统计类别、型号全为空）' });
        bucket.failed++;
        return;
      }
      const vals = FIELDS.map((k) => d[k]).concat([key, sheet, now, (user && user.id) || null, userName, now, now]);
      db.prepare(insertSql).run(...vals);
      res.created++; bucket.created++;
      res.samples.push({ action: '新增', name: d.name, sheet, row: rowNo, changed: [] });
    });

    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已经回滚过 */ }
    return { ok: false, error: '导入失败，已全部回滚：' + ((e && e.message) || e) };
  }

  res.ok = true;
  res.sampleTotal = res.samples.length;
  res.samples = res.samples.slice(0, 40);
  res.thinTotal = res.thin.length;
  res.thin = res.thin.slice(0, 60);
  res.failedTotal = res.failed.length;
  res.failed = res.failed.slice(0, 60);
  return res;
}

/** 导出用：按当前列表的同一套筛选取全量（内部按 500 一页翻，避免再写一遍筛选逻辑） */
function exportList(o) {
  const src = o || {};
  const out = [];
  let page = 1;
  for (;;) {
    const r = list(Object.assign({}, src, { page, pageSize: 500 }));
    out.push(...r.list);
    if (!r.list.length || out.length >= r.total) break;
    page++;
    if (page > 40) break;   // 兜底：两万条以上就别再翻了，避免死循环
  }
  return out;
}

module.exports = {
  KINDS, STATUSES, WARRANTY_SOON_DAYS, EXCEL_COLUMNS, SYSTEM_COLUMNS, FIELDS,
  ensure, list, get, issuesOf, options, meta, exportList,
  create, update, remove, brief, shape, warrantyOf, daysBetween,
  importRows, keyOf, normMac, deriveName, kindOfStat, ipList,
};
