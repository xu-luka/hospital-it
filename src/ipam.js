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

/* ==================== 与【终端资产】的联动 ====================
 *
 * 终端资产（terminals，在 his.db）里登记过 IP 的机器，不该再到 IP 管理里手工登记一遍 ——
 * 那样会有两份记录，改一处忘一处，最后谁都说不清哪个是准的。所以这里走**读时合并**：
 *
 *   · terminals 是唯一事实来源，本模块**不往 ip_records 写任何东西**；
 *   · 只在「列登记 / 算空闲 / 画分布图」时把终端 IP 当成已被占用，并带上设备名、
 *     科室、位置，让人一眼看出这个地址是谁在用；
 *   · 于是终端改 IP、删设备，IP 管理这边立刻跟着变，永远不会漂移。
 *
 * 为什么不用写时同步（保存终端时往 ip_records 插一条）：
 *   ① 终端常常在还没建网段时就有 IP，那时根本没地方插；
 *   ② ip_records 有 (segment_id, ip) 唯一索引，写冲突会把「保存设备」这种正常操作变成报错；
 *   ③ 双写必然漂移，而漂移在这里的代价是「空闲地址里推荐一个其实已被占的 IP」。
 *
 * ★ 2026-10-30 表结构重建后，台账里**没有「状态/报废」这一项**了（Excel 没有这列），
 *   所以这里不再区分「是否已释放」：设备在台账里 = 地址被占着；
 *   机器不用了就从台账删掉，地址自然回到空闲。
 *
 * ★ 台账的「外网地址」列同样要并进来（2026-10-30 修）：
 *   院内说的「外网」= 办公网，「内网」= 医疗业务网，两列都是真实占用着的地址。
 *   只按 `ip` 合并的话，一台机器只填了办公网地址（如 10.10.10.94）就完全进不来 ——
 *   用户建好 10.10.10.0/24 后看到的是「已登记 0、剩余 0」的空段，来报「没关联」。
 *   现在 ipList 把两列摊成两行（net='in'/'out'），本模块一视同仁地算占用，
 *   只是虚拟记录多带一个 net，界面据此把外网那条标成「终端·外网」。
 */

/** 读终端资产里「有 IP」的记录。任何异常都降级成空数组 —— IP 管理不能因此不可用。 */
function terminalIps() {
  try {
    // 懒 require：terminals 用的是 his.db，加载期互相牵连没必要，也让本模块能单独自测
    const repo = require('./terminals');
    return (repo && repo.ipList && repo.ipList()) || [];
  } catch (e) {
    console.warn('[ipam] 读取终端资产 IP 失败（IP 管理仍可用，只是不显示终端占用）：'
      + ((e && e.message) || e));
    return [];
  }
}

/** 落在某网段内、算作「被占用」的终端地址 */
function terminalIn(cidr) {
  const out = [];
  terminalIps().forEach((t) => {
    if (!ipInCidr(t.ip, cidr)) return;
    out.push(t);
  });
  return out;
}

/** 这个地址是不是已经被终端资产占了；被占则返回那台设备（可能多台共用） */
function terminalAt(ip, exceptIp) {
  const v = String(ip == null ? '' : ip).trim();
  if (!v) return null;
  const hits = terminalIps().filter((t) => t.ip === v && t.ip !== exceptIp);
  return hits.length ? { first: hits[0], count: hits.length, all: hits } : null;
}

/** 拼一句人话：「门诊3号诊室工作站（门诊部 / 门诊楼3层3诊室）·外网地址」 */
function terminalLabel(t) {
  if (!t) return '';
  const where = [t.department, t.location].filter(Boolean).join(' / ');
  // 外网地址那条要点明是哪一列的地址 —— 否则用户会以为这台机器的「内网地址」是 10.10.10.94
  return '「' + t.name + '」' + (where ? '（' + where + '）' : '')
    + (t.net === 'out' ? '·外网地址' : '');
}

/**
 * 终端资产 → 一条虚拟的「IP 登记」记录。
 * id 用字符串 't<设备id>'（外网地址那条用 'tx<设备id>'）：前端 v-for 的 key 需要唯一，
 * 而数值 id 会跟 ip_records 的 id 撞上（撞上之后的后果是：删除一条手工登记，界面上删掉的是另一台终端）。
 * 同一台设备的两条记录也必须不同 id，否则列表里两行会被 Vue 认成同一行。
 */
function shapeTerminalRecord(t, seg) {
  const segName = seg ? (seg.name || '') : '';
  const isOut = t.net === 'out';
  const where = [t.department, t.location].filter(Boolean).join(' / ');
  return {
    id: (isOut ? 'tx' : 't') + t.terminal_id,
    source: 'terminal',
    terminal_id: t.terminal_id,
    /* 这一行代表的是哪一类地址：in = 内网地址（医疗网），out = 外网地址（办公网）。
       两者都参与占用统计 —— 都是院内真实被占的地址，只是登记在台账的不同列。 */
    net: isOut ? 'out' : 'in',
    segment_id: seg ? seg.id : 0,
    segment_name: segName,
    segment_cidr: seg ? seg.cidr : '',
    ip: t.ip,
    /* 外网那条自身就是外网地址，若再带 ip_extra，界面会在备注里又标一次「外网 x」，
       变成「外网 10.10.10.94 / 外网 10.10.10.94」式的重复 —— 所以外网行留空。 */
    ip_extra: isOut ? '' : (t.ip_extra || ''),
    ip_num: parseIp(t.ip) === null ? 0 : parseIp(t.ip),
    status: 'used',
    status_label: '已使用',
    hostname: t.hostname || t.name,
    mac: t.mac || '',
    // 台账 21 列里没有「责任人」，留空字段保证前端不用改判断分支
    owner: '',
    device_type: t.kind || '',
    note: '终端资产 · ' + (isOut ? '外网地址 · ' : '') + where,
    created_at: '',
    updated_at: '',
    device: {
      id: t.terminal_id, name: t.name, kind: t.kind,
      department: t.department, location: t.location, hostname: t.hostname,
      stat_category: t.stat_category || '', model: t.model || '',
      /* 台账「外网地址」列：内网那条要在备注里带出来（这台机器还有哪个办公网地址），
         外网那条自己就是，不再重复。 */
      ip_extra: isOut ? '' : (t.ip_extra || ''),
    },
  };
}

/** 某个 IP 落在哪些网段里（可能没有，也可能多个 —— 全院 /16 与科室 /24 并存很常见） */
function segmentOfIp(ip, segs) {
  const list = (segs || db.prepare('SELECT * FROM net_segments ORDER BY id ASC').all());
  let hit = null;
  for (const s of list) {
    if (ipInCidr(ip, s.cidr)) { hit = s; break; }   // 取第一个（id 最小的那层）
  }
  return hit;
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
  /* ★ 没登记过、也没有终端占用的网段，segmentStats() 里根本没有这个 key（它是按
     segment_id 分组出来的）。原先这里直接用 `stats && c ? … : 0`，于是「一条都没登记」
     的网段被算成 free_count = 0 —— 界面上写「已登记 0 · 剩余 0」，
     用户看到的就是「这个网段是空的、一个地址都没有」，完全不敢往里加设备
     （2026-10-30 用户就是拿这个当证据说 10.10.10.0/24 没关联上终端）。
     缺省应当是「满额空闲」：hostCount - 0 - 0。 */
  const st = stats || { registered: 0, used: 0, conflict: 0, terminal: 0, terminal_only: 0 };
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
    registered: st.registered || 0,
    used: st.used || 0,
    conflict: st.conflict || 0,
    free_count: c
      ? Math.max(0, c.hostCount - (st.registered || 0) - (st.terminal_only || 0))
      : 0,
    // 终端资产里登记了 IP、且落在这个网段里的地址数（只读联动，不落库；内网 + 外网各算一个）
    terminal: st.terminal || 0,
    // 其中「没在本网段手工登记过」的那部分 —— 空闲地址计算要扣掉的就是它
    terminal_only: st.terminal_only || 0,
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
    source: 'manual',
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

  /* 终端资产占用（只读 his.db，不写库）。
     分两个数：
       terminal      = 落在这个网段里的终端设备数
       terminal_only = 其中「本网段还没手工登记过」的，空闲地址要扣的正是这部分
     注意手动登记优先：同一个 IP 两边都有时只算一次，否则 free_count 会被扣两遍。 */
  try {
    const terms = terminalIps();
    if (terms.length) {
      const manual = {};
      db.prepare('SELECT segment_id, ip FROM ip_records').all().forEach((r) => {
        const k = String(r.segment_id);
        (manual[k] || (manual[k] = new Set())).add(String(r.ip));
      });
      db.prepare('SELECT id, cidr FROM net_segments').all().forEach((s) => {
        const k = String(s.id);
        const hit = terms.filter((t) => ipInCidr(t.ip, s.cidr));
        if (!hit.length) return;
        const cur = map[k] || (map[k] = { registered: 0, used: 0, conflict: 0 });
        const set = manual[k];
        cur.terminal = hit.length;
        cur.terminal_only = hit.filter((t) => !(set && set.has(t.ip))).length;
      });
    }
  } catch (e) {
    console.warn('[ipam] 统计终端占用失败（按未占用计算）：' + ((e && e.message) || e));
  }
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
    terminal: out.reduce((s, x) => s + (x.terminal || 0), 0),
    terminal_only: out.reduce((s, x) => s + (x.terminal_only || 0), 0),
  };
  summary.free_count = Math.max(0, summary.host_count - summary.registered - summary.terminal_only);
  // 使用率按「真占了几个地址」算：手工登记的在用 + 终端资产里认领的（去掉重复计算的）
  const occupied = summary.used + summary.terminal_only;
  summary.usage_pct = summary.host_count
    ? Math.round(occupied / summary.host_count * 1000) / 10 : 0;
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

/** 关键词命中（终端虚拟记录用，字段与手工登记的搜索范围对齐） */
function terminalMatch(t, kw) {
  if (!kw) return true;
  const k = kw.toLowerCase();
  /* 搜「本行代表的那个地址」+ 设备身份字段。刻意**不搜** ip_extra：
     外网地址现在自己就有一行，把它也算进内网那行的搜索范围，搜一个地址会出两行。 */
  return [t.ip, t.name, t.hostname, t.mac, t.kind, t.stat_category, t.model,
    t.department, t.location, t.asset_no].join(' ').toLowerCase().indexOf(k) >= 0;
}

// 合并模式下「取全量再切片」的上限。超过这个量说明手工登记本身已经过万，
// 那就退回 SQL 分页、只列手工登记（并显式告知），绝不能悄悄把终端那部分丢掉。
const MERGE_MAX = 5000;

/**
 * 登记列表。source: all（默认）/ manual / terminal。
 *
 * ★ 为什么改成「取全量 → 内存合并 → 切片」：
 *   终端资产的 IP 存在另一个库（his.db），SQL 里 JOIN 不了；
 *   而如果只在当前页拼终端记录，总数、分页、排序全都会错位
 *   —— 用户翻到第 3 页，看到的条数跟页脚写的对不上，比不显示更糟。
 */
function listIps(opts) {
  const o = opts || {};
  const segId = Number(o.segment_id) || 0;
  const kw = trim(o.keyword);
  const status = trim(o.status);
  const src = trim(o.source);
  const source = (src === 'manual' || src === 'terminal') ? src : 'all';
  const page = Math.max(1, Number(o.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(o.pageSize) || 100));

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
  const manualTotal = db.prepare('SELECT COUNT(*) c FROM ip_records r ' + w).get(...params).c;

  const selectSql = `SELECT r.* FROM ip_records r ${w}
     ORDER BY r.segment_id ASC, r.ip_num ASC, r.id ASC`;

  // 只列手工登记：保持原来的 SQL 分页，行为一字不变
  if (source === 'manual') {
    const rows = db.prepare(selectSql + ' LIMIT ? OFFSET ?')
      .all(...params, pageSize, (page - 1) * pageSize);
    return {
      list: rows.map(shapeRecord), total: manualTotal, page, pageSize,
      statuses: STATUSES, manual_total: manualTotal, terminal_total: 0,
    };
  }

  // 手工登记太多 → 退回分页，明确告知没有合并（不静默丢数据）
  if (source === 'all' && manualTotal > MERGE_MAX) {
    const rows = db.prepare(selectSql + ' LIMIT ? OFFSET ?')
      .all(...params, pageSize, (page - 1) * pageSize);
    return {
      list: rows.map(shapeRecord), total: manualTotal, page, pageSize,
      statuses: STATUSES, manual_total: manualTotal, terminal_total: 0,
      merge_skipped: true,
      merge_note: '手工登记已有 ' + manualTotal + ' 条，超过单次合并上限，本页只列手工登记。'
        + '可以按网段筛选后再看，或切到「终端资产」来源单独查看。',
    };
  }

  // ---- 终端资产侧：按同样的筛选条件生成虚拟记录 ----
  const segs = db.prepare('SELECT * FROM net_segments ORDER BY id ASC').all();
  const terms = terminalIps()
    .filter((t) => {
      if (!terminalMatch(t, kw)) return false;
      if (segId) {
        const s = segmentOfIp(t.ip, segs);
        if (!s || Number(s.id) !== segId) return false;
      }
      if (status && status !== 'used') return false;   // 终端记录一律是「已使用」
      return true;
    })
    .map((t) => shapeTerminalRecord(t, segmentOfIp(t.ip, segs)));

  if (source === 'terminal') {
    terms.sort((a, b) => (a.segment_id - b.segment_id) || (a.ip_num - b.ip_num));
    const start = (page - 1) * pageSize;
    return {
      list: terms.slice(start, start + pageSize), total: terms.length, page, pageSize,
      statuses: STATUSES, manual_total: 0, terminal_total: terms.length,
    };
  }

  // ---- 合并 ----
  const manualAll = db.prepare(selectSql).all(...params).map(shapeRecord);
  const all = manualAll.concat(terms);
  all.sort((a, b) => (a.segment_id - b.segment_id) || (a.ip_num - b.ip_num)
    || String(a.ip).localeCompare(String(b.ip)));
  const start = (page - 1) * pageSize;
  return {
    list: all.slice(start, start + pageSize), total: all.length, page, pageSize,
    statuses: STATUSES,
    manual_total: manualAll.length, terminal_total: terms.length,
  };
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
  // 终端资产已经认领了这个地址 → 不再手工登记一条，否则两份记录一定漂移
  const owner = terminalAt(ip);
  if (owner) {
    return {
      ok: false,
      error: 'IP ' + ip + ' 已被终端资产' + terminalLabel(owner.first)
        + (owner.count > 1 ? '等 ' + owner.count + ' 台设备' : '') + ' 占用，无需重复登记。'
        + '要改这个地址，请到【终端资产】改那台设备的 IP。',
      terminal_owner: owner.first,
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
  // 只在「换成另一个地址」时检查终端占用：老数据里可能本来就有和终端重复的地址，
  // 那种记录改备注、改使用人不该被永久拦住（否则只能删了重建）
  if (ip !== String(row.ip || '')) {
    const owner = terminalAt(ip);
    if (owner) {
      return {
        ok: false,
        error: 'IP ' + ip + ' 已被终端资产' + terminalLabel(owner.first)
          + (owner.count > 1 ? '等 ' + owner.count + ' 台设备' : '') + ' 占用，不能再登记给别的设备。',
        terminal_owner: owner.first,
      };
    }
  }
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
  if (!seg) return { ok: false, error: '网段不存在', notFound: true };
  const c = parseCidr(seg.cidr);
  if (!c) return { ok: false, error: '该网段的 CIDR 无法解析：' + seg.cidr };
  const used = usedSetOf(seg.id);
  // ★ 终端资产占着的地址也要算「已占」，否则这里会把一个其实已经被
  //   门诊那台自助机用掉的地址推荐给新设备，装完就撞 IP
  const terms = terminalIn(seg.cidr);
  let extra = 0;
  terms.forEach((t) => { if (!used.has(t.ip)) { used.add(t.ip); extra++; } });
  const list = freeIps(c, used, limit);
  return {
    ok: true,
    cidr: c.cidr,
    host_count: c.hostCount,
    registered: used.size,
    terminal: terms.length,
    terminal_only: extra,
    free_count: Math.max(0, c.hostCount - used.size),
    ips: list,
    truncated: list.length < Math.max(0, c.hostCount - used.size),
  };
}

/* ==================== 图形化：地址分布图 ====================
 *
 * 把「一个网段里哪些地址被占了」铺成格子交给前端画。
 * 为什么算在服务端而不是前端：
 *   · 32 位整数进位（n + 1 到 0xFFFFFFFF 会溢出）、网络/广播地址的归属、
 *     /31 与 /32 不扣首尾——这些边界已经在本文件的纯函数里测过了，前端再写一遍
 *     必然出现「两边不一致」，而且前端写错只会表现成「图看着怪」；
 *   · 一次算完，前端拿到的就是可以直接 v-for 的数组，不需要它懂 CIDR。 */

// 逐地址网格的上限：/22 = 1024 格（16 列 × 64 行）。再大就不是「一眼看清」而是刷屏。
const MAP_IP_MAX = 1024;
// 按 /24 聚合时最多铺多少块：/12 是 4096 块，再往下就只剩一堵没有信息的墙。
const MAP_BLOCK_MAX = 4096;
// 单次最多读多少条登记：防止某个 /8 网段里塞了几万条把内存和响应打爆。
const MAP_ROWS_MAX = 20000;
// 格子固定按 16 列排：IPv4 最后一段 0-255 正好 16 行 16 列，与「.10 在第 2 行第 11 格」
// 这种心算习惯对得上（小于 16 个地址的小网段退化成 size 列，见下）。
const MAP_COLS = 16;

function segmentMap(segmentId, opts) {
  const seg = getSegment(segmentId);
  // notFound 让路由回 404 而不是笼统的 400：网段不存在是「你找的东西没有」，
  // 不是「你传的参数不对」。freeIpsOfSegment 之前漏了这个标记，一并补上。
  if (!seg) return { ok: false, error: '网段不存在', notFound: true };
  const c = parseCidr(seg.cidr);
  if (!c) return { ok: false, error: '该网段的 CIDR 无法解析：' + seg.cidr };

  const totalRows = db.prepare('SELECT COUNT(*) c FROM ip_records WHERE segment_id = ?')
    .get(Number(seg.id)).c;
  const rows = db.prepare(
    `SELECT ip, status, hostname, owner, device_type, note
     FROM ip_records WHERE segment_id = ? ORDER BY ip_num ASC, id ASC LIMIT ?`
  ).all(Number(seg.id), MAP_ROWS_MAX);

  // 同一个网段里不允许重复登记（有唯一索引），这里再兜一层是防止历史数据绕过索引写入
  const byIp = {};
  rows.forEach((r) => {
    const k = String(r.ip);
    if (!byIp[k]) byIp[k] = r;
  });

  // 终端资产占着的地址：手工登记优先，这里只补那些没手工登记的
  const termByIp = {};
  terminalIn(seg.cidr).forEach((t) => { if (!byIp[t.ip]) termByIp[t.ip] = t; });

  const info = shapeSegment(seg, segmentStats()[String(seg.id)]);
  const base = {
    ok: true,
    id: seg.id,
    name: info.name,
    cidr: info.cidr,
    cols: MAP_COLS,
    host_count: info.host_count,
    registered: info.registered,
    used: info.used,
    conflict: info.conflict,
    terminal: info.terminal,
    terminal_only: info.terminal_only,
    free_count: info.free_count,
    truncated: Number(totalRows) > rows.length,
  };

  /* ---- 模式一：逐地址网格（/22 及更小） ---- */
  if (c.hostCount <= MAP_IP_MAX) {
    // 小网段（/29 只有 8 个地址）用 16 列会排出一行大部分是空白，
    // 所以列数取「16 与该网段地址数的较小者」；size 一定是 2 的幂，
    // 于是 /28 及以上都是 16 的整数倍，行首自然对齐到 .0 / .16 / .32…
    const size = Math.pow(2, 32 - c.prefix);
    const cols = Math.max(1, Math.min(MAP_COLS, size));
    const cells = [];
    let n = c.network;
    for (;;) {
      const ip = formatIp(n);
      const rec = byIp[ip];
      const term = termByIp[ip];
      const isEdge = c.prefix <= 30 && (n === c.network || n === c.broadcast);
      let state = 'free';
      let tip = ip + ' · 未登记';
      if (rec) {
        state = String(rec.status || 'used');
        tip = ip + ' · ' + statusLabel(rec.status);
        if (rec.hostname) tip += ' · ' + rec.hostname;
        if (rec.owner) tip += ' · ' + rec.owner;
        if (rec.device_type) tip += ' · ' + rec.device_type;
        if (rec.note) tip += ' · ' + rec.note;
      } else if (term) {
        // 终端资产里认领的地址：照样算「已使用」，点一下能跳到列表里看到是哪台机器
        state = 'used';
        tip = ip + ' · 终端资产' + terminalLabel(term);
        if (term.hostname) tip += ' · ' + term.hostname;
        if (term.mac) tip += ' · ' + term.mac;
      } else if (isEdge) {
        const edge = n === c.network ? '网络地址' : '广播地址';
        state = n === c.network ? 'net' : 'bcast';
        tip = ip + ' · ' + edge + '（不参与登记）';
      }
      cells.push({ ip, label: String(n & 255), state, reg: !!(rec || term), terminal: !!term, tip });
      if (n === c.broadcast) break; // 先判后加，避免 0xFFFFFFFF 进位回绕成 0
      n = (n + 1) >>> 0;
    }
    return Object.assign(base, { mode: 'ip', cols, cells });
  }

  /* ---- 模式二：按 /24 聚合（/21 ~ /12） ---- */
  const blocks = Math.pow(2, 24 - c.prefix);
  if (blocks <= MAP_BLOCK_MAX) {
    const agg = [];
    for (let i = 0; i < blocks; i++) agg.push({ registered: 0, used: 0, conflict: 0, terminal: 0 });
    rows.forEach((r) => {
      const n = parseIp(r.ip);
      if (n === null) return;
      const idx = Math.floor((n - c.network) / 256);
      if (idx < 0 || idx >= blocks) return;
      agg[idx].registered++;
      if (r.status === 'used') agg[idx].used++;
      if (r.status === 'conflict') agg[idx].conflict++;
    });
    // 终端资产的地址也算进这一块（这些 IP 在本网段还没手工登记过，不会重复计数）
    Object.keys(termByIp).forEach((ip) => {
      const n = parseIp(ip);
      if (n === null) return;
      const idx = Math.floor((n - c.network) / 256);
      if (idx < 0 || idx >= blocks) return;
      agg[idx].terminal++;
    });

    // 块数多到格子放不下数字时就不写字，只留颜色（悬停仍有完整信息）
    const showCount = blocks <= 256;
    const cells = agg.map((a, i) => {
      const net = formatIp((c.network + i * 256) >>> 0);
      const cidr = net + '/24';
      const occupied = a.registered + a.terminal;
      let state = 'free';
      if (a.conflict > 0) state = 'conflict';
      else if (occupied > 0) state = 'used';
      let tip = cidr + ' · 已登记 ' + a.registered + ' / 256';
      if (a.terminal) tip += '（另含终端资产 ' + a.terminal + ' 个）';
      if (a.used) tip += '（已使用 ' + a.used + '）';
      if (a.conflict) tip += ' · 冲突 ' + a.conflict;
      return {
        ip: cidr,
        // 格内写「这个 /24 里登记了几条」而不是第三段：块数一多，
        // 「哪一块在涨」比「这是哪一块」更值得一眼看到，后者交给悬停。
        label: showCount ? String(occupied) : '',
        state,
        reg: occupied > 0,
        registered: a.registered,
        terminal: a.terminal,
        used: a.used,
        conflict: a.conflict,
        tip,
      };
    });
    return Object.assign(base, {
      mode: 'block', cols: MAP_COLS, cells, blocks,
    });
  }

  /* ---- 模式三：太大，只给结论不给图 ---- */
  return Object.assign(base, {
    mode: 'none',
    cols: MAP_COLS,
    cells: [],
    note: '该网段是 ' + info.cidr + '，有 ' + c.hostCount + ' 个可用地址，'
      + '铺成格子只会是一堵没有信息的墙，所以这里只显示上方的使用率。'
      + '想看图，可以按科室/楼层另建更小的网段（/22 以内能逐地址展示，/24 最合适）再登记。',
  });
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
  segmentMap, MAP_IP_MAX, MAP_BLOCK_MAX, MAP_ROWS_MAX, MAP_COLS,
  shapeSegment, shapeRecord, ensureColumns,
  // 与终端资产的联动（只读）：自测与路由都可能要用
  terminalIps, terminalIn, terminalAt, shapeTerminalRecord,
};
