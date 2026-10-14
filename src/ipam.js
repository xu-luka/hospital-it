'use strict';
/**
 * ipam.js —— IP 地址管理（自建网段 + 按网段登记已用 IP）
 *
 * 要解决的问题：院内哪些 IP 已经被占了、留给谁了、还剩哪些空着，此前全靠人脑和 Excel。
 * 这里让管理员先建「网段」（CIDR），再在网段里登记 IP；系统负责三件人容易算错的事：
 *   ① 地址是否真的属于这个网段；② 同一个 IP 有没有被登记两次；
 *   ③ 这个网段还剩多少个未登记的地址（能直接列出来）。
 *
 * 存储：表由本模块自建、建在 contract.db（同 bookmarks 的理由 —— 自带存储、
 * 只替换自己这几个文件就能上线，并自动纳入每日备份）。
 *
 * 地址一律按 32 位无符号整数比较，不做字符串比较（字符串比大小会把
 * .9 排在 .10 后面，'192.168.1.100' < '192.168.1.9'，据此判「在不在网段内」必错）。
 */

const { db } = require('./db-contract');

/* ==================== 建表 ==================== */

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS net_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      cidr TEXT NOT NULL DEFAULT '',
      gateway TEXT NOT NULL DEFAULT '',
      vlan TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS ip_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      segment_id INTEGER NOT NULL,
      ip TEXT NOT NULL DEFAULT '',
      -- 排序用的整数形式：SQLite 没有 inet_aton，按字符串排会把 .9 排在 .10 后面
      ip_num INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'used',
      hostname TEXT NOT NULL DEFAULT '',
      mac TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      device_type TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT,
      updated_at TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ip_records_seg_ip ON ip_records(segment_id, ip);
    CREATE INDEX IF NOT EXISTS idx_ip_records_seg ON ip_records(segment_id);
  `);
} catch (e) {
  console.warn('[ipam] 创建 IP 管理表失败：' + ((e && e.message) || e));
}

/** 老库补列（同 bookmarks.js 的理由：IF NOT EXISTS 不会给已存在的表加列） */
function ensureColumns(table, spec) {
  const added = [];
  try {
    const have = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name));
    Object.keys(spec).forEach((col) => {
      if (have.has(col)) return;
      db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + col + ' ' + spec[col]);
      added.push(col);
    });
  } catch (e) {
    console.warn('[ipam] ' + table + ' 补列失败：' + ((e && e.message) || e));
  }
  if (added.length) console.log('[ipam] ' + table + ' 已补列：' + added.join('、'));
  return added;
}

ensureColumns('net_segments', {
  gateway: "TEXT NOT NULL DEFAULT ''",
  vlan: "TEXT NOT NULL DEFAULT ''",
  location: "TEXT NOT NULL DEFAULT ''",
  note: "TEXT NOT NULL DEFAULT ''",
  created_at: 'TEXT',
  updated_at: 'TEXT',
});
ensureColumns('ip_records', {
  ip_num: 'INTEGER NOT NULL DEFAULT 0',
  status: "TEXT NOT NULL DEFAULT 'used'",
  hostname: "TEXT NOT NULL DEFAULT ''",
  mac: "TEXT NOT NULL DEFAULT ''",
  owner: "TEXT NOT NULL DEFAULT ''",
  device_type: "TEXT NOT NULL DEFAULT ''",
  note: "TEXT NOT NULL DEFAULT ''",
  created_at: 'TEXT',
  updated_at: 'TEXT',
});

// 补列后老行的 ip_num 是默认值 0，排序会全乱 → 这里按 ip 文本回填一遍。
// 只处理「明显还没算过」的行（0 且不是 0.0.0.0），避免每次启动都全表写一遍。
try {
  const stale = db.prepare("SELECT id, ip FROM ip_records WHERE (ip_num IS NULL OR ip_num = 0) AND ip <> '0.0.0.0'").all();
  if (stale.length) {
    const upd = db.prepare('UPDATE ip_records SET ip_num = ? WHERE id = ?');
    stale.forEach((r) => {
      const n = parseIp(r.ip);
      if (n !== null) upd.run(n, r.id);
    });
    console.log('[ipam] 已回填 ip_num 排序字段：' + stale.length + ' 条');
  }
} catch (e) {
  console.warn('[ipam] 回填 ip_num 失败（排序可能不准）：' + ((e && e.message) || e));
}

/* ==================== 登记状态 ==================== */

const STATUSES = [
  { code: 'used', label: '已使用' },
  { code: 'reserved', label: '保留' },
  { code: 'free', label: '空闲' },
  { code: 'conflict', label: '冲突' },
];
const STATUS_CODES = STATUSES.map((s) => s.code);

function statusLabel(code) {
  const s = STATUSES.filter((x) => x.code === code)[0];
  return s ? s.label : String(code || '');
}

/* ==================== IPv4 / CIDR 纯函数（离线自测覆盖） ==================== */

const IP_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** '192.168.1.10' → 3232235786；非法返回 null（逐段校验 0-255，且不许前导零以外的花活） */
function parseIp(s) {
  const v = String(s == null ? '' : s).trim();
  const m = IP_RE.exec(v);
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const seg = Number(m[i]);
    if (seg > 255) return null;
    n = n * 256 + seg;
  }
  return n >>> 0;
}

/** 3232235786 → '192.168.1.10' */
function formatIp(n) {
  const v = Number(n) >>> 0;
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join('.');
}

/**
 * '192.168.1.0/24' → 网段描述。
 * 允许把主机地址写进来（'192.168.1.37/24'）—— 自动归一到网络地址，
 * 否则「在不在网段内」的比较会拿一个非网络地址当基准，结果时对时错。
 */
function parseCidr(s) {
  const v = String(s == null ? '' : s).trim();
  const parts = v.split('/');
  if (parts.length !== 2) return null;
  const ip = parseIp(parts[0]);
  const prefix = Number(parts[1]);
  if (ip === null) return null;
  if (!/^\d{1,2}$/.test(parts[1]) || prefix < 0 || prefix > 32) return null;

  // 掩码：prefix=0 时左移 32 位在 JS 里是恒等位移（移位数按 32 取模），必须单独处理
  const mask = prefix === 0 ? 0 : ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  const network = (ip & mask) >>> 0;
  const broadcast = (network | ((~mask) >>> 0)) >>> 0;
  const size = Math.pow(2, 32 - prefix);

  // /31 与 /32 没有「网络地址/广播地址」可浪费（RFC3021 点对点与单主机），
  // 全部地址都算可用；其它前缀扣掉首尾两个。算错这两个会让「还剩几个」少报/多报。
  let first;
  let last;
  let hostCount;
  if (prefix >= 31) {
    first = network; last = broadcast; hostCount = size;
  } else {
    first = (network + 1) >>> 0; last = (broadcast - 1) >>> 0; hostCount = size - 2;
  }
  return {
    cidr: formatIp(network) + '/' + prefix,
    prefix,
    mask,
    network,
    broadcast,
    networkIp: formatIp(network),
    broadcastIp: formatIp(broadcast),
    firstHost: formatIp(first),
    lastHost: formatIp(last),
    first,
    last,
    hostCount,
  };
}

/** 归一化写成 '192.168.1.0/24'；非法返回 null */
function normalizeCidr(s) {
  const c = parseCidr(s);
  return c ? c.cidr : null;
}

/** IP 是否落在网段内（网段字符串或 parseCidr 的结果都能吃） */
function ipInCidr(ip, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const n = typeof ip === 'string' ? parseIp(ip) : (Number(ip) >>> 0);
  if (!c || n === null || !Number.isFinite(n)) return false;
  return n >= c.network && n <= c.broadcast;
}

/** 网段是否包含另一个网段的整个范围（用于提示「这两个网段是包含关系」） */
function rangesOverlap(a, b) {
  const ca = typeof a === 'string' ? parseCidr(a) : a;
  const cb = typeof b === 'string' ? parseCidr(b) : b;
  if (!ca || !cb) return false;
  return ca.network <= cb.broadcast && cb.network <= ca.broadcast;
}

/**
 * 从网段里顺序取地址（跳过已登记集合）。
 * limit 是硬闸门：/8 有 1600 万个地址，无上限地铺开会直接把响应和内存打爆。
 * 所以这里是「从前往后找，凑够 limit 就停」，不是「先把全量算出来再截断」。
 */
function freeIps(cidr, usedSet, limit) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c) return [];
  const max = Math.max(1, Math.min(Number(limit) || 100, 5000));
  const out = [];
  const used = usedSet instanceof Set ? usedSet : new Set(usedSet || []);
  for (let n = c.first; n <= c.last; n++) {
    const s = formatIp(n);
    if (used.has(s)) continue;
    out.push(s);
    if (out.length >= max) break;
    if (n === 0xFFFFFFFF) break; // 防溢出回绕
  }
  return out;
}

/** 已登记的 IP 集合（按网段的网络/广播范围收，避免把整个表读进内存） */
function usedSetOf(segmentId) {
  const rows = db.prepare('SELECT ip FROM ip_records WHERE segment_id = ?').all(Number(segmentId));
  return new Set(rows.map((r) => String(r.ip)));
}

/**
 * 批量粘贴解析：一行一个，支持
 *   · `192.168.1.10`                      —— 只有 IP
 *   · `192.168.1.10 门诊自助机1 张工`      —— IP + 后面的文字一律并入备注
 *   · `192.168.1.10-192.168.1.20`         —— 区间展开
 *   · `192.168.1.0/28`                    —— 网段展开（只展开可用主机）
 * 行内与行间都允许 , 、 ; 分隔；# 开头的行是注释。
 * 返回 { items:[{ip, note}], invalid:[{line, text, reason}] }，展开上限 2000 条。
 */
function parseBulk(text, opts) {
  const max = Math.max(1, Math.min(Number((opts && opts.max)) || 2000, 20000));
  const items = [];
  const invalid = [];
  const raw = String(text == null ? '' : text).replace(/\r\n?/g, '\n');

  const pushIp = (ip, note) => {
    if (parseIp(ip) === null) return false;
    items.push({ ip: formatIp(parseIp(ip)), note: note || '' });
    return true;
  };

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.charAt(0) === '#') continue;
    // 逗号/顿号/分号当分隔符，但空格留给「IP + 备注」的语义
    for (const piece of line.split(/[,，、;；]+/)) {
      const t = piece.trim();
      if (!t) continue;
      const tok = t.split(/\s+/);
      const head = tok[0];
      const rest = tok.slice(1).join(' ').trim();

      const range = /^(.+?)\s*-\s*(.+)$/.exec(head);
      const cidr = head.indexOf('/') >= 0 ? parseCidr(head) : null;

      if (cidr) {
        for (let n = cidr.first; n <= cidr.last; n++) {
          if (items.length >= max) { invalid.push({ line: rawLine, text: t, reason: '超过单次展开上限 ' + max + ' 条' }); break; }
          pushIp(formatIp(n), rest);
        }
      } else if (range && parseIp(range[1]) !== null && parseIp(range[2]) !== null) {
        let a = parseIp(range[1]);
        let b = parseIp(range[2]);
        if (a > b) { const t2 = a; a = b; b = t2; }
        if (b - a > max) { invalid.push({ line: rawLine, text: t, reason: '区间过大（>' + max + ' 个地址）' }); continue; }
        for (let n = a; n <= b; n++) {
          if (items.length >= max) { invalid.push({ line: rawLine, text: t, reason: '超过单次展开上限 ' + max + ' 条' }); break; }
          pushIp(formatIp(n), rest);
        }
      } else if (parseIp(head) !== null) {
        if (items.length >= max) { invalid.push({ line: rawLine, text: t, reason: '超过单次展开上限 ' + max + ' 条' }); break; }
        pushIp(head, rest);
      } else {
        invalid.push({ line: rawLine, text: t, reason: '识别不出 IP 地址或区间' });
      }
    }
  }
  return { items, invalid };
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

function shapeSegment(row, stats) {
  if (!row) return null;
  const c = parseCidr(row.cidr);
  return {
    id: row.id,
    name: row.name || '',
    cidr: row.cidr || '',
    cidr_ok: !!c,
    prefix: c ? c.prefix : null,
    network: c ? c.networkIp : '',
    broadcast: c ? c.broadcastIp : '',
    first_host: c ? c.firstHost : '',
    last_host: c ? c.lastHost : '',
    host_count: c ? c.hostCount : 0,
    gateway: row.gateway || '',
    vlan: row.vlan || '',
    location: row.location || '',
    note: row.note || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
    registered: stats ? stats.registered : 0,
    used: stats ? stats.used : 0,
    conflict: stats ? stats.conflict : 0,
    free_count: stats && c ? Math.max(0, c.hostCount - stats.registered) : 0,
  };
}

function shapeRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    segment_id: row.segment_id,
    ip: row.ip || '',
    ip_num: parseIp(row.ip) || 0,
    status: row.status || 'used',
    status_label: statusLabel(row.status),
    hostname: row.hostname || '',
    mac: row.mac || '',
    owner: row.owner || '',
    device_type: row.device_type || '',
    note: row.note || '',
    created_at: row.created_at || '',
    updated_at: row.updated_at || '',
  };
}

/* ==================== 网段 ==================== */

function segmentStats() {
  const map = {};
  db.prepare(
    `SELECT segment_id,
            COUNT(*) AS registered,
            SUM(CASE WHEN status = 'used' THEN 1 ELSE 0 END) AS used,
            SUM(CASE WHEN status = 'conflict' THEN 1 ELSE 0 END) AS conflict
     FROM ip_records GROUP BY segment_id`
  ).all().forEach((r) => {
    map[String(r.segment_id)] = {
      registered: Number(r.registered) || 0,
      used: Number(r.used) || 0,
      conflict: Number(r.conflict) || 0,
    };
  });
  return map;
}

function listSegments() {
  const rows = db.prepare('SELECT * FROM net_segments ORDER BY id ASC').all();
  const stats = segmentStats();
  const out = rows.map((r) => shapeSegment(r, stats[String(r.id)]));

  // 网段重叠提示：包含关系本身不是错（全院 /16 + 科室 /24 很常见），
  // 但它决定了「同一个 IP 会不会在两个网段里都合法」，所以要显式告诉用户。
  out.forEach((a) => {
    const overlaps = [];
    out.forEach((b) => {
      if (a.id === b.id) return;
      if (rangesOverlap(a.cidr, b.cidr)) overlaps.push(b.name || ('#' + b.id));
    });
    a.overlaps = overlaps;
  });

  const summary = {
    segments: out.length,
    host_count: out.reduce((s, x) => s + x.host_count, 0),
    registered: out.reduce((s, x) => s + x.registered, 0),
    used: out.reduce((s, x) => s + x.used, 0),
    conflict: out.reduce((s, x) => s + x.conflict, 0),
  };
  summary.free_count = Math.max(0, summary.host_count - summary.registered);
  summary.usage_pct = summary.host_count
    ? Math.round(summary.used / summary.host_count * 1000) / 10 : 0;
  return { list: out, summary, statuses: STATUSES };
}

function getSegment(id) {
  return db.prepare('SELECT * FROM net_segments WHERE id = ?').get(Number(id)) || null;
}

/** 网段重叠时提示「这些网段里也能看到该 IP」，仅提示、不拦（有人就是按科室+全院两层登记） */
function crossSegmentHint(ip, segmentId) {
  const hit = [];
  db.prepare('SELECT * FROM net_segments WHERE id <> ?').all(Number(segmentId)).forEach((s) => {
    if (ipInCidr(ip, s.cidr)) hit.push(s.name || ('#' + s.id));
  });
  if (!hit.length) return '';
  return '注意：该地址同时落在网段「' + hit.join('、') + '」内，请确认登记在哪一层更合适。';
}

function createSegment(data) {
  const name = trim(data.name, 60);
  if (!name) return { ok: false, error: '网段名称不能为空' };
  const cidr = normalizeCidr(data.cidr);
  if (!cidr) return { ok: false, error: '网段格式不正确，应形如 192.168.1.0/24（掩码 0-32）' };
  const gw = trim(data.gateway, 40);
  if (gw && parseIp(gw) === null) return { ok: false, error: '网关地址格式不正确' };
  if (gw && !ipInCidr(gw, cidr)) return { ok: false, error: '网关 ' + gw + ' 不在网段 ' + cidr + ' 内' };
  if (db.prepare('SELECT id FROM net_segments WHERE cidr = ?').get(cidr)) {
    return { ok: false, error: '网段 ' + cidr + ' 已经登记过了' };
  }
  const info = db.prepare(
    `INSERT INTO net_segments(name, cidr, gateway, vlan, location, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, cidr, gw, trim(data.vlan, 20), trim(data.location, 60), trim(data.note, 500),
    nowLocal(), nowLocal());
  return { ok: true, id: Number(info.lastInsertRowid), cidr };
}

function updateSegment(id, data) {
  const row = getSegment(id);
  if (!row) return { ok: false, error: '网段不存在', notFound: true };
  const name = data.name === undefined ? row.name : trim(data.name, 60);
  if (!name) return { ok: false, error: '网段名称不能为空' };
  const cidr = data.cidr === undefined ? row.cidr : normalizeCidr(data.cidr);
  if (!cidr) return { ok: false, error: '网段格式不正确，应形如 192.168.1.0/24' };
  if (db.prepare('SELECT id FROM net_segments WHERE cidr = ? AND id <> ?').get(cidr, Number(id))) {
    return { ok: false, error: '网段 ' + cidr + ' 已经登记过了' };
  }
  const gw = data.gateway === undefined ? row.gateway : trim(data.gateway, 40);
  if (gw && parseIp(gw) === null) return { ok: false, error: '网关地址格式不正确' };
  if (gw && !ipInCidr(gw, cidr)) return { ok: false, error: '网关 ' + gw + ' 不在网段 ' + cidr + ' 内' };

  // 改小掩码会把已有登记甩到网段外 → 先查出来，明确告诉用户是哪几条，别默默留下脏数据
  const outside = db.prepare('SELECT ip FROM ip_records WHERE segment_id = ?').all(Number(id))
    .map((r) => String(r.ip)).filter((ip) => !ipInCidr(ip, cidr));
  if (outside.length) {
    return {
      ok: false,
      error: '改成 ' + cidr + ' 后，本网段已登记的 ' + outside.length + ' 个地址会落在网段外（'
        + outside.slice(0, 8).join('、') + (outside.length > 8 ? ' 等' : '') + '），请先处理这些登记。',
    };
  }
  db.prepare(
    `UPDATE net_segments SET name = ?, cidr = ?, gateway = ?, vlan = ?, location = ?, note = ?, updated_at = ?
     WHERE id = ?`
  ).run(name, cidr, gw,
    data.vlan === undefined ? row.vlan : trim(data.vlan, 20),
    data.location === undefined ? row.location : trim(data.location, 60),
    data.note === undefined ? row.note : trim(data.note, 500),
    nowLocal(), Number(id));
  return { ok: true, id: Number(id), cidr };
}

function removeSegment(id) {
  const n = db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?').get(Number(id)).c;
  if (n > 0) return { ok: false, error: '该网段下还有 ' + n + ' 条 IP 登记，请先删除或转移后再删网段' };
  const r = db.prepare('DELETE FROM net_segments WHERE id = ?').run(Number(id));
  return { ok: r.changes > 0, notFound: r.changes === 0 };
}

/* ==================== IP 登记 ==================== */

function listIps(opts) {
  const o = opts || {};
  const segId = Number(o.segment_id) || 0;
  const kw = trim(o.keyword);
  const status = trim(o.status);
  const where = [];
  const params = [];
  if (segId) { where.push('r.segment_id = ?'); params.push(segId); }
  if (status && STATUS_CODES.indexOf(status) >= 0) { where.push('r.status = ?'); params.push(status); }
  if (kw) {
    const lk = '%' + kw + '%';
    where.push('(r.ip LIKE ? OR r.hostname LIKE ? OR r.owner LIKE ? OR r.mac LIKE ? OR r.note LIKE ? OR r.device_type LIKE ?)');
    params.push(lk, lk, lk, lk, lk, lk);
  }
  const w = where.length ? ('WHERE ' + where.join(' AND ')) : '';
  const total = db.prepare('SELECT COUNT(*) c FROM ip_records r ' + w).get(...params).c;

  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(o.pageSize) || 100));
  const rows = db.prepare(
    `SELECT r.*, s.name AS segment_name, s.cidr AS segment_cidr
     FROM ip_records r LEFT JOIN net_segments s ON s.id = r.segment_id
     ${w} ORDER BY r.segment_id ASC, r.ip_num ASC, r.id ASC LIMIT ? OFFSET ?`
  ).all(...params, pageSize, (page - 1) * pageSize);
  return { list: rows.map(shapeRecord), total, page, pageSize, statuses: STATUSES };
}

/**
 * 登记一条 IP。三道校验缺一不可：
 *   ① 格式合法；② 属于所选网段；③ 同一网段内不重复。
 * 第 ③ 条只在本网段内判重：全院 /16 与科室 /24 并存时，同一个地址在两层都登记是合理的，
 * 这种情况给一句提示（crossSegmentHint），不拦。
 */
function createIp(data) {
  const seg = getSegment(data.segment_id);
  if (!seg) return { ok: false, error: '请选择网段' };
  const ip = parseIp(data.ip) === null ? null : formatIp(parseIp(data.ip));
  if (!ip) return { ok: false, error: 'IP 地址格式不正确' };
  if (!ipInCidr(ip, seg.cidr)) {
    return { ok: false, error: 'IP ' + ip + ' 不在网段 ' + seg.cidr + '（' + (seg.name || '') + '）内' };
  }
  const dup = db.prepare('SELECT id, hostname FROM ip_records WHERE segment_id = ? AND ip = ?')
    .get(Number(seg.id), ip);
  if (dup) {
    return {
      ok: false,
      error: 'IP ' + ip + ' 在该网段内已登记' + (dup.hostname ? '（' + dup.hostname + '）' : '') + '，请直接编辑那一条',
    };
  }
  const status = STATUS_CODES.indexOf(trim(data.status)) >= 0 ? trim(data.status) : 'used';
  const mac = trim(data.mac, 40);
  if (mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac.replace(/\s/g, ''))) {
    return { ok: false, error: 'MAC 地址格式不正确（应形如 00-1A-2B-3C-4D-5E）' };
  }
  const info = db.prepare(
    `INSERT INTO ip_records(segment_id, ip, ip_num, status, hostname, mac, owner, device_type, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(Number(seg.id), ip, parseIp(ip), status, trim(data.hostname, 80), mac,
    trim(data.owner, 60), trim(data.device_type, 30), trim(data.note, 500), nowLocal(), nowLocal());
  return { ok: true, id: Number(info.lastInsertRowid), ip, warn: crossSegmentHint(ip, seg.id) };
}

function updateIp(id, data) {
  const row = db.prepare('SELECT * FROM ip_records WHERE id = ?').get(Number(id));
  if (!row) return { ok: false, error: '登记记录不存在', notFound: true };
  const segId = data.segment_id === undefined ? row.segment_id : Number(data.segment_id);
  const seg = getSegment(segId);
  if (!seg) return { ok: false, error: '目标网段不存在' };
  const ip = data.ip === undefined ? row.ip
    : (parseIp(data.ip) === null ? null : formatIp(parseIp(data.ip)));
  if (!ip) return { ok: false, error: 'IP 地址格式不正确' };
  if (!ipInCidr(ip, seg.cidr)) {
    return { ok: false, error: 'IP ' + ip + ' 不在网段 ' + seg.cidr + '（' + (seg.name || '') + '）内' };
  }
  const dup = db.prepare('SELECT id FROM ip_records WHERE segment_id = ? AND ip = ? AND id <> ?')
    .get(Number(segId), ip, Number(id));
  if (dup) return { ok: false, error: 'IP ' + ip + ' 在该网段内已被其它记录登记' };
  const mac = data.mac === undefined ? row.mac : trim(data.mac, 40);
  if (mac && !/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(mac.replace(/\s/g, ''))) {
    return { ok: false, error: 'MAC 地址格式不正确（应形如 00-1A-2B-3C-4D-5E）' };
  }
  const status = data.status === undefined ? row.status
    : (STATUS_CODES.indexOf(trim(data.status)) >= 0 ? trim(data.status) : row.status);
  db.prepare(
    `UPDATE ip_records SET segment_id = ?, ip = ?, ip_num = ?, status = ?, hostname = ?, mac = ?, owner = ?,
            device_type = ?, note = ?, updated_at = ? WHERE id = ?`
  ).run(Number(segId), ip, parseIp(ip), status,
    data.hostname === undefined ? row.hostname : trim(data.hostname, 80),
    mac,
    data.owner === undefined ? row.owner : trim(data.owner, 60),
    data.device_type === undefined ? row.device_type : trim(data.device_type, 30),
    data.note === undefined ? row.note : trim(data.note, 500),
    nowLocal(), Number(id));
  return { ok: true, id: Number(id), ip, warn: crossSegmentHint(ip, segId) };
}

function removeIp(id) {
  const r = db.prepare('DELETE FROM ip_records WHERE id = ?').run(Number(id));
  return { ok: r.changes > 0, notFound: r.changes === 0 };
}

/** 某网段还空着的地址（顺序取前 limit 个） */
function freeIpsOfSegment(segmentId, limit) {
  const seg = getSegment(segmentId);
  if (!seg) return { ok: false, error: '网段不存在' };
  const c = parseCidr(seg.cidr);
  if (!c) return { ok: false, error: '该网段的 CIDR 无法解析：' + seg.cidr };
  const used = usedSetOf(seg.id);
  const list = freeIps(c, used, limit);
  return {
    ok: true,
    cidr: c.cidr,
    host_count: c.hostCount,
    registered: used.size,
    free_count: Math.max(0, c.hostCount - used.size),
    ips: list,
    truncated: list.length < Math.max(0, c.hostCount - used.size),
  };
}

/**
 * 批量登记：解析文本 → 逐条走 createIp 的同一套校验 → 汇总成功/失败/跳过。
 * 失败要逐条说原因（用户粘 200 行，只说「失败 12 条」等于没说）。
 */
function bulkCreate(segmentId, text, preset) {
  const seg = getSegment(segmentId);
  if (!seg) return { ok: false, error: '请选择网段' };
  const parsed = parseBulk(text);
  const p = preset || {};
  const out = { ok: true, added: 0, failed: [], invalid: parsed.invalid, total: parsed.items.length, warn: [] };
  const seen = new Set();
  parsed.items.forEach((it) => {
    if (seen.has(it.ip)) {
      out.failed.push({ ip: it.ip, error: '本次粘贴里重复出现' });
      return;
    }
    seen.add(it.ip);
    const r = createIp({
      segment_id: seg.id,
      ip: it.ip,
      status: p.status,
      hostname: it.note || p.hostname,
      owner: p.owner,
      device_type: p.device_type,
      note: p.note,
    });
    if (r.ok) {
      out.added++;
      if (r.warn && out.warn.indexOf(r.warn) < 0) out.warn.push(r.warn);
    } else {
      out.failed.push({ ip: it.ip, error: r.error });
    }
  });
  return out;
}

module.exports = {
  STATUSES, STATUS_CODES, statusLabel,
  parseIp, formatIp, parseCidr, normalizeCidr, ipInCidr, rangesOverlap, freeIps, parseBulk,
  listSegments, getSegment, createSegment, updateSegment, removeSegment,
  listIps, createIp, updateIp, removeIp, freeIpsOfSegment, bulkCreate,
  shapeSegment, shapeRecord, ensureColumns,
};
