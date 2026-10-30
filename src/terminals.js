'use strict';
/**
 * 终端资产台账。
 *
 * ★ 表结构严格照信息科那份《信息设备台账》Excel —— 21 列原样落库，一列不多一列不少。
 *
 *   Excel 有三张表，列不完全一样：
 *     计算机   20 列：院区/资产编码/区域/楼层/科室/位置/统计类别/设备性质/工作组计算机名/
 *                     内网地址/外网地址/MAC/SN码/生产日期/型号/操作系统/CPU/硬盘/内存/显示器尺寸
 *     打印机   15 列：前 8 列 + 内网地址/外网地址/MAC/SN码/生产日期/型号/耗材型号
 *     其他设备 15 列：与打印机相同
 *   合并去重正好 21 列（计算机的 20 + 打印机/其他设备独有、以及计算机没有的「耗材型号」）。
 *
 * ★ 2026-10-30 第二轮：这张表**重建**过一次。原先的做法是「Excel 21 列 + 系统自加 9 列
 *   （名称/类型/状态/责任人/保修至/采购日期/品牌/供应商/备注）」= 30 字段，等于在台账上
 *   又盖了一层自造字段。用户明确要求：表就照 Excel 做，系统需要的东西自己算。
 *   于是那 9 列全部去掉，改成**派生**：
 *
 *   · 设备名称 → 不在库里存。用「工作组/计算机名」，空则「统计类别 + 型号」，再空用资产编码。
 *     工单、IP 管理、列表都需要一个能认的名字，但那是**展示**问题，不该进台账。
 *   · 类型     → 从「统计类别」推（kindOfStat），落不到就按导入来源的 sheet 名推。
 *   · 状态/报修可用性/报废 → Excel 里根本没有「报废」。台账里删掉一行 = 这台机器没了，
 *     IP 管理那边也就自然把地址释放出来（ipList 只返回还存在的设备）。
 *
 * ★ 必须保留、但不属于台账的业务字段（都是 bookkeeping，不在界面上当字段出现）：
 *   id / created_by / creator_name / created_at / updated_at —— 审计
 *   src_key / src_sheet / import_at —— 导入查重与溯源（「这台设备来自哪个表第几行」）
 */

const issueDb = require('./db');

/** 设备大类。只用于展示分组与工单下拉，不再是表里的一列 */
const KINDS = [
  'PC', '笔记本', '一体机', '打印机', '自助机', '叫号机',
  '显示屏', '扫码枪', '投影', '网络设备', '其他',
];

/**
 * 台账的 21 列，顺序与 Excel 完全一致（导出时按这个顺序出，用户拿回 Excel 里能直接对）。
 * 刻意保留 Excel 的原词（「统计类别」「设备性质」而不是自造「设备分类」）——
 * 两边用词不一致，用户会以为是两个字段。
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

/** 记账列：不是台账字段，但表里必须有。导出/导入**都不带**它们 */
const INFRA_COLUMNS = [
  { key: 'src_key', type: "TEXT NOT NULL DEFAULT ''" },
  { key: 'src_sheet', type: "TEXT NOT NULL DEFAULT ''" },
  { key: 'import_at', type: "TEXT NOT NULL DEFAULT ''" },
  { key: 'created_by', type: 'INTEGER' },
  { key: 'creator_name', type: "TEXT NOT NULL DEFAULT ''" },
  { key: 'created_at', type: 'TEXT' },
  { key: 'updated_at', type: 'TEXT' },
];

/** 全部可写字段（顺序即 INSERT / UPDATE 的列顺序，改一处两边同时生效） */
const FIELDS = EXCEL_COLUMNS.map((c) => c.key);

/** 上一版表里那 9 个自造列。看到任何一个就说明是老库，需要重建 */
const LEGACY_COLUMNS = [
  'name', 'kind', 'brand', 'owner', 'status',
  'purchase_date', 'warranty_end', 'vendor', 'note',
];

/** 「-」在这个台账里是「没有」的意思（原表大量用它占位），一律按空处理 */
function isBlank(v) {
  const s = trim(v);
  return !s || s === '-' || s === '—' || s === '－' || s === '/';
}

/**
 * 统计类别 → 设备大类。Excel 里「统计类别」有十几种说法（台式计算机 / 黑白打印机 /
 * 多功能一体机 …），大类只用于展示和工单下拉，原始说法始终完整保留在 stat_category 里。
 */
function kindOfStat(cat) {
  const s = trim(cat);
  if (!s) return '';
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

/**
 * 设备大类（派生，不落库）。
 * 统计类别为空的行（原台账里计算机表 74 行、其他设备表 32 行都是空）先看这行是从哪张表导进来的：
 * 「打印机」表的空类别行显然不是 PC，默认成 PC 会让人按类型筛出一堆莫名其妙的机器。
 */
function kindOf(d) {
  const byCat = kindOfStat(d && d.stat_category);
  if (byCat) return byCat;
  const sheet = trim(d && d.src_sheet);
  if (sheet) {
    const bySheet = kindOfStat(sheet);
    if (bySheet && bySheet !== '其他') return bySheet;
    if (/打印机/.test(sheet)) return '打印机';
    if (/计算机|电脑|PC/i.test(sheet)) return 'PC';
  }
  return '其他';
}

/**
 * 展示用名称（派生，不落库）。
 * 优先「工作组/计算机名」—— 台账里这是最能一眼认出是哪台机器的字段；
 * 打印机没有计算机名，退回「统计类别 + 型号」（如「黑白打印机 Epson M101」）；
 * 再不行用资产编码。全空才给「设备 #id」。
 */
function displayName(d) {
  const src = d || {};
  const h = trim(src.hostname);
  if (h) return h;
  const cat = trim(src.stat_category);
  const model = trim(src.model);
  if (cat || model) return [cat, model].filter(Boolean).join(' ');
  const no = trim(src.asset_no);
  if (no) return '资产 ' + no;
  return '';
}

let ready = false;
let initError = '';

const TABLE_SQL = `CREATE TABLE IF NOT EXISTS terminals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
${EXCEL_COLUMNS.map((c) => '  ' + c.key + " TEXT NOT NULL DEFAULT ''").join(',\n')},
${INFRA_COLUMNS.map((c) => '  ' + c.key + ' ' + c.type).join(',\n')}
)`;

/**
 * 按当前表结构建索引。
 * ★ 只能引用「新结构里一定有」的列。放进 CREATE TABLE 那段 exec 里的话，
 *   老库（表已存在但没有这些列）会直接抛 no such column，被外层 catch 吃成
 *   「台账未就绪」—— 新建库一切正常，只有升级过的机器炸（2026-10-30 踩过）。
 */
function createIndexes(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_terminals_dept ON terminals(department);
    CREATE INDEX IF NOT EXISTS idx_terminals_asset ON terminals(asset_no);
    CREATE INDEX IF NOT EXISTS idx_terminals_srckey ON terminals(src_key);
    CREATE INDEX IF NOT EXISTS idx_terminals_area ON terminals(campus, area, floor);
    CREATE INDEX IF NOT EXISTS idx_terminals_host ON terminals(hostname);
  `);
}

/**
 * 把上一版（30 字段）的表重建成 21 列。
 *
 * ★ 必须保留 id：issues.device_id 指向它，换了 id 等于把全部工单的设备关联打散。
 * ★ hostname 由旧的 name 兜底：老数据里「设备名称」是唯一能认人那列，
 *   丢掉它等于整表变成「设备 #12」。
 * ★ 整个重建在一个事务里，中途失败就回滚，绝不留半张表。
 */
function rebuildLegacy(db, have) {
  const old = 'terminals_legacy_v1';
  db.exec('BEGIN');
  try {
    db.exec('DROP TABLE IF EXISTS ' + old);
    db.exec('ALTER TABLE terminals RENAME TO ' + old);
    db.exec(TABLE_SQL);

    const cols = ['id'];
    const exprs = ['id'];
    EXCEL_COLUMNS.forEach((c) => {
      cols.push(c.key);
      if (c.key === 'hostname') {
        if (have.has('hostname')) exprs.push("COALESCE(NULLIF(hostname, ''), NULLIF(name, ''), '')");
        else if (have.has('name')) exprs.push("COALESCE(name, '')");
        else exprs.push("''");
      } else if (have.has(c.key)) {
        exprs.push("COALESCE(" + c.key + ", '')");
      } else {
        exprs.push("''");
      }
    });
    INFRA_COLUMNS.forEach((c) => {
      cols.push(c.key);
      if (!have.has(c.key)) exprs.push(c.key === 'created_by' ? 'NULL' : "''");
      else if (c.key === 'created_by') exprs.push(c.key);
      else exprs.push('COALESCE(' + c.key + ", '')");
    });

    db.exec('INSERT INTO terminals(' + cols.join(', ') + ') SELECT ' + exprs.join(', ') + ' FROM ' + old);
    const n = db.prepare('SELECT COUNT(*) c FROM terminals').get().c;
    db.exec('DROP TABLE ' + old);
    db.exec('COMMIT');
    console.log('[terminals] 已按 Excel 21 列重建表结构，迁移旧记录 ' + n + ' 条'
      + '（旧的 设备名称/类型/状态/责任人/保修 等 9 列已不再保留）');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) { /* 已经回滚过 */ }
    throw e;
  }
}

/**
 * 建表 / 重建 / 补列。幂等，可反复调用。
 * 返回 false 表示库还没就绪（getDb 抛错），调用方据此返回一句人话而不是 500 堆栈堆给用户。
 */
function ensure() {
  if (ready) return true;
  try {
    const db = issueDb.getDb();
    db.exec(TABLE_SQL);

    let have = new Set(db.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name));

    // 上一版的 30 字段表 → 重建
    if (LEGACY_COLUMNS.some((c) => have.has(c))) {
      rebuildLegacy(db, have);
      have = new Set(db.prepare('PRAGMA table_info(terminals)').all().map((c) => c.name));
    }

    // 更老的库（连 Excel 列都没有）→ 补列，不重建（没有要丢弃的列）
    const added = [];
    EXCEL_COLUMNS.forEach((c) => {
      if (have.has(c.key)) return;
      db.exec('ALTER TABLE terminals ADD COLUMN ' + c.key + " TEXT NOT NULL DEFAULT ''");
      added.push(c.key);
    });
    INFRA_COLUMNS.forEach((c) => {
      if (have.has(c.key)) return;
      db.exec('ALTER TABLE terminals ADD COLUMN ' + c.key + ' ' + c.type);
      added.push(c.key);
    });
    if (added.length) console.log('[terminals] terminals 已补列：' + added.join('、'));

    try {
      createIndexes(db);
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
  const s = trim(v).slice(0, 10).replace(/\//g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (!m) return '';
  const mm = ('0' + m[2]).slice(-2);
  const dd = ('0' + m[3]).slice(-2);
  return m[1] + '-' + mm + '-' + dd;
}

/** 出库统一整形：按 FIELDS 逐列搬 + 补派生字段（名称/类型/工单计数） */
function shape(row) {
  if (!row) return null;
  // 按 FIELDS 逐列搬，而不是手写 21 个字段 —— 手写的话每加一列就漏一次，
  // 而漏掉的表现是「导入成功但详情里看不到」，极难查
  const out = { id: row.id };
  FIELDS.forEach((k) => { out[k] = row[k] == null ? '' : row[k]; });

  // 派生：库里没有这两列，但列表/工单/IP 管理都要用
  out.name = displayName(row) || ('设备 #' + row.id);
  out.kind = kindOf(row);

  out.created_by = row.created_by || null;
  out.creator_name = row.creator_name || '';
  out.created_at = row.created_at || '';
  out.updated_at = row.updated_at || '';
  out.src_sheet = row.src_sheet || '';
  out.import_at = row.import_at || '';

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
  dept: "ORDER BY (t.department = '') ASC, t.department ASC, t.location ASC, t.hostname ASC, t.id ASC",
  recent: 'ORDER BY t.id DESC',
  asset: "ORDER BY (t.asset_no = '') ASC, t.asset_no ASC, t.id ASC",
  name: "ORDER BY (t.hostname = '') ASC, t.hostname ASC, t.id ASC",
  issues: 'ORDER BY issue_count DESC, t.id DESC',
};

function list(opts) {
  if (!ensure()) throw new Error('终端台账数据表未就绪：' + initError);
  const o = opts || {};
  const db = issueDb.getDb();
  const kw = trim(o.keyword);
  const dept = trim(o.department);
  const stat = trim(o.stat_category);
  const nature = trim(o.nature);
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(o.pageSize) || 50));

  const where = [];
  const params = [];
  if (kw) {
    const lk = '%' + kw + '%';
    // 关键词要能搜到每一个台账列 —— 用户记不清是哪一列，只知道「那台 Epson」或「08-F9-55」
    where.push("(" + FIELDS.map((k) => 't.' + k + ' LIKE ?').join(' OR ') + ')');
    FIELDS.forEach(() => params.push(lk));
  }
  if (dept) { where.push('t.department = ?'); params.push(dept); }
  if (stat) { where.push('t.stat_category = ?'); params.push(stat); }
  if (nature) { where.push('t.nature = ?'); params.push(nature); }

  const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const order = SORTS[trim(o.sort)] || SORTS.dept;

  const total = db.prepare('SELECT COUNT(*) c FROM terminals t ' + w).get(...params).c;
  const rows = db.prepare(SELECT_WITH_STATS + ' ' + w + ' ' + order + ' LIMIT ? OFFSET ?')
    .all(...params, pageSize, (page - 1) * pageSize);

  // 统计随列表一起给（省一次往返，且始终与当前筛选无关 —— 它反映的是全量家底）。
  // 这几个数都能从 21 列直接算出来，不需要任何自造字段。
  const stat2 = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN TRIM(ip) <> '' THEN 1 ELSE 0 END) AS with_ip,
      SUM(CASE WHEN TRIM(asset_no) = '' THEN 1 ELSE 0 END) AS no_asset,
      COUNT(DISTINCT CASE WHEN TRIM(department) <> '' THEN department END) AS depts
    FROM terminals
  `).get();

  const departments = db.prepare(
    "SELECT department AS name, COUNT(*) AS cnt FROM terminals WHERE department != ''"
    + ' GROUP BY department ORDER BY department ASC'
  ).all().map((d) => ({ name: d.name, cnt: d.cnt }));

  const statCats = db.prepare(
    "SELECT stat_category AS name, COUNT(*) AS cnt FROM terminals WHERE stat_category != ''"
    + ' GROUP BY stat_category ORDER BY cnt DESC, stat_category ASC'
  ).all().map((d) => ({ name: d.name, cnt: d.cnt }));

  return {
    list: rows.map(shape),
    total, page, pageSize,
    stats: {
      total: stat2.total || 0,
      with_ip: stat2.with_ip || 0,
      no_asset: stat2.no_asset || 0,
      depts: stat2.depts || 0,
    },
    departments, stat_categories: statCats,
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

/**
 * 工单表单的设备下拉。
 * 之前排除「报废」—— 现在台账里没有状态，全部设备都可被报修；
 * 真坏到不该再报的，直接从台账删掉即可。
 */
function options(opts) {
  if (!ensure()) return { list: [], total: 0 };
  const db = issueDb.getDb();
  const o = opts || {};
  const kw = trim(o.keyword);
  const dept = trim(o.department);
  const where = [];
  const params = [];
  if (kw) {
    const lk = '%' + kw + '%';
    where.push('(hostname LIKE ? OR asset_no LIKE ? OR location LIKE ? OR ip LIKE ?'
      + ' OR sn LIKE ? OR mac LIKE ? OR stat_category LIKE ? OR model LIKE ?)');
    params.push(lk, lk, lk, lk, lk, lk, lk);
  }
  if (dept) { where.push('department = ?'); params.push(dept); }
  const rows = db.prepare(
    'SELECT id, asset_no, hostname, stat_category, model, department, location, ip'
    + ' FROM terminals'
    + (where.length ? (' WHERE ' + where.join(' AND ')) : '')
    + " ORDER BY (department = '') ASC, department ASC, location ASC, hostname ASC LIMIT 300"
  ).all(...params).map((r) => ({
    id: r.id,
    name: displayName(r) || ('设备 #' + r.id),
    kind: kindOf(r),
    asset_no: r.asset_no || '',
    hostname: r.hostname || '',
    department: r.department || '',
    location: r.location || '',
    ip: r.ip || '',
  }));
  return { list: rows, total: rows.length };
}

/** 下拉用的元数据（科室/院区/区域/楼层/统计类别/设备性质，全部来自台账里真实出现过的值） */
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
    kinds: KINDS.slice(), departments: depts,
    campuses, areas, floors, stat_categories: statCategories, natures,
    fields: EXCEL_COLUMNS.map((c) => ({ key: c.key, name: c.name })),
  };
}

/* ==================== 写 ==================== */

/** 各字段落库前的长度上限（Excel 里「显示器尺寸」这类值带单引号和品牌，给宽一点） */
const LIMITS = {
  campus: 40, asset_no: 60, area: 40, floor: 20, department: 60, location: 80,
  stat_category: 40, nature: 40, hostname: 80, ip: 60, ip_extra: 60,
  mac: 60, sn: 80, model: 80, os: 40,
  cpu: 80, disk: 40, ram: 40, monitor: 40, consumable: 120,
};

function pickInput(b) {
  const src = b || {};
  const d = {};
  FIELDS.forEach((k) => {
    if (k === 'produce_date') d[k] = normDate(src[k]);
    else d[k] = trim(src[k], LIMITS[k] || 80);
  });
  d.mac = normMac(d.mac);
  return d;
}

/** 认不出是哪台设备时给一句能照做的提示 */
const KEY_HINT = '认不出这是哪台设备：请至少填写 MAC、SN码、资产编码、工作组/计算机名 之一，'
  + '或者「科室 + 位置」都填上。内网地址不能单独作为标识（换机会沿用旧 IP）。';

function create(data, user) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const d = pickInput(data || {});
  const key = keyOf(d);
  if (!key) return { ok: false, error: KEY_HINT };
  const now = nowLocal();
  const cols = FIELDS.concat(['src_key', 'created_by', 'creator_name', 'created_at', 'updated_at']);
  const vals = FIELDS.map((k) => d[k]).concat([
    key, (user && user.id) || null, (user && (user.real_name || user.username)) || '', now, now,
  ]);
  const info = db.prepare(
    'INSERT INTO terminals(' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')'
  ).run(...vals);
  return { ok: true, id: Number(info.lastInsertRowid), name: displayName(d) };
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
  const key = keyOf(d);
  if (!key) return { ok: false, error: KEY_HINT };
  // src_key 一并刷新：改了 MAC/资产编码之后旧键就失效了，
  // 留着旧键会让下一次导入匹配到「改之前的那台」，把用户手改的内容又写回去
  db.prepare(
    'UPDATE terminals SET ' + FIELDS.map((k) => k + ' = ?').join(', ')
    + ', src_key = ?, updated_at = ? WHERE id = ?'
  ).run(...FIELDS.map((k) => d[k]), key, nowLocal(), Number(id));
  return { ok: true, id: Number(id), name: displayName(d) };
}

/**
 * 删除。**先把工单的 device_id 置空**再删本体：
 * 工单要看得出「当初是这台机器报的」，但设备记录删了就不该再被任何地方引用。
 * 置空而不是级联删工单 —— 工单是运维历史，不能因为清理台账而消失。
 */
function remove(id) {
  if (!ensure()) return { ok: false, error: '终端台账数据表未就绪：' + initError };
  const db = issueDb.getDb();
  const row = db.prepare('SELECT * FROM terminals WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '设备不存在', notFound: true };
  const n = db.prepare('UPDATE issues SET device_id = NULL WHERE device_id = ?').run(Number(id)).changes;
  db.prepare('DELETE FROM terminals WHERE id = ?').run(Number(id));
  return { ok: true, detached_issues: n, name: displayName(row) };
}

/**
 * 供【IP 管理】用：只取「填了内网地址」的设备，字段精简、不分页。
 *
 * 那边要的是一张「这个地址被谁占着」的对照表，工单统计一律用不上，
 * 所以不套 SELECT_WITH_STATS —— 每行三个子查询乘几百行是白费。
 *
 * ★ 台账里没有「报废」这一项，所以这里不再区分「是否已释放」：
 *   设备还在台账里 = 这个地址被占着；不再用了就从台账删掉，地址自然回到空闲。
 */
function ipList() {
  if (!ensure()) return [];
  try {
    return issueDb.getDb().prepare(
      `SELECT id, asset_no, hostname, stat_category, model, nature,
              department, location, ip, ip_extra, mac, src_sheet
       FROM terminals
       WHERE TRIM(ip) <> ''
       ORDER BY id ASC`
    ).all().map((r) => ({
      terminal_id: Number(r.id),
      name: displayName(r) || ('设备 #' + r.id),
      kind: kindOf(r),
      stat_category: r.stat_category || '',
      model: r.model || '',
      nature: r.nature || '',
      department: r.department || '',
      location: r.location || '',
      ip: String(r.ip || '').trim(),
      ip_extra: r.ip_extra || '',
      mac: r.mac || '',
      hostname: r.hostname || '',
      asset_no: r.asset_no || '',
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
    const r = db.prepare('SELECT id, asset_no, hostname, stat_category, model, department, location, ip FROM terminals WHERE id = ?')
      .get(Number(id));
    if (!r) return null;
    return Object.assign({}, r, {
      name: displayName(r) || ('设备 #' + r.id),
      kind: kindOf(r),
    });
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

/**
 * 查重键。优先级 MAC → SN → 资产编码 → 工作组/计算机名 →（都没有时）科室+位置+统计类别+型号。
 * 原表 373 行里只有 94 行有真实资产编码（182 行写着「-」），
 * 所以绝不能拿资产编码当主键，但也不能不用它 —— 它毕竟是院里贴标签认的那串。
 *
 * 「工作组/计算机名」放在资产编码之后：它是 PC 的机器名，通常是唯一的，
 * 但打印机没有这一列，靠它单独当主键会让同一台打印机每次导入都新增。
 *
 * ★ 复合键要求这四个字段里**至少有两个非空**。真实台账里有七十多行只写了「体检科」
 *   这样的占位行，若允许单字段成立，它们会互相认成同一台 —— 第一次新增、后面全变成
 *   「更新」，把几十条不同的记录压成一条。这类行统一记为「信息不足」交给人看。
 */
function keyOf(d) {
  if (d.mac) return 'M:' + d.mac;
  if (d.sn) return 'S:' + d.sn.toUpperCase();
  if (d.asset_no) return 'A:' + d.asset_no.toUpperCase();
  if (trim(d.hostname)) return 'H:' + trim(d.hostname).toUpperCase();
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
  o.produce_date = normDate(src.produce_date);
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
  EXCEL_COLUMNS.forEach((c) => { label[c.key] = c.name; });

  const cols = FIELDS.concat(['src_key', 'src_sheet', 'import_at']);
  const insertSql = 'INSERT INTO terminals(' + cols.join(', ')
    + ', created_by, creator_name, created_at, updated_at) VALUES ('
    + cols.map(() => '?').join(', ') + ', ?, ?, ?, ?)';
  const selByKey = db.prepare('SELECT * FROM terminals WHERE src_key = ? ORDER BY id LIMIT 1');
  const selByCol = {
    mac: db.prepare("SELECT * FROM terminals WHERE mac = ? AND mac != '' ORDER BY id LIMIT 1"),
    sn: db.prepare("SELECT * FROM terminals WHERE sn = ? AND sn != '' ORDER BY id LIMIT 1"),
    asset_no: db.prepare("SELECT * FROM terminals WHERE asset_no = ? AND asset_no != '' ORDER BY id LIMIT 1"),
    hostname: db.prepare("SELECT * FROM terminals WHERE hostname = ? AND hostname != '' ORDER BY id LIMIT 1"),
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
          reason: '信息不足：至少要有 MAC / SN码 / 资产编码 / 工作组计算机名 之一，'
            + '或「科室+位置+统计类别+型号」里至少两项',
        });
        bucket.thin++;
        return;
      }

      let hit = selByKey.get(key);
      if (!hit && d.mac) hit = selByCol.mac.get(d.mac);
      if (!hit && d.sn) hit = selByCol.sn.get(d.sn);
      if (!hit && d.asset_no) hit = selByCol.asset_no.get(d.asset_no);
      if (!hit && d.hostname) hit = selByCol.hostname.get(d.hostname);
      // 兜底：手工录入的设备没有 src_key（它只在导入时写），光靠 src_key 会认不出来，
      // 于是「导出 → 原样再导入」会整份复制一遍。按业务键再查一次。
      if (!hit && key.charAt(0) === 'C:') {
        hit = db.prepare('SELECT * FROM terminals WHERE department = ? AND location = ?'
          + ' AND stat_category = ? AND model = ? ORDER BY id LIMIT 1')
          .get(d.department, d.location, d.stat_category, d.model);
      }

      const showName = displayName(d) || displayName(hit || {}) || '(未命名)';

      if (hit) {
        if (mode === 'skip') {
          res.skipped++; bucket.skipped++;
          res.samples.push({ action: '跳过', name: showName, sheet, row: rowNo, changed: [] });
          return;
        }
        const changed = [];
        FIELDS.forEach((k) => {
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
          action: '更新', name: showName, sheet, row: rowNo,
          changed: changed.map((k) => label[k] || k),
        });
        return;
      }

      const vals = FIELDS.map((k) => d[k]).concat([key, sheet, now, (user && user.id) || null, userName, now, now]);
      db.prepare(insertSql).run(...vals);
      res.created++; bucket.created++;
      res.samples.push({ action: '新增', name: showName, sheet, row: rowNo, changed: [] });
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
  KINDS, EXCEL_COLUMNS, INFRA_COLUMNS, FIELDS,
  ensure, list, get, issuesOf, options, meta, exportList,
  create, update, remove, brief, shape, ipList,
  importRows, keyOf, normMac, kindOfStat, kindOf, displayName, normDate,
};
