'use strict';
/**
 * 本次五项需求的真实服务冒烟（HTTP 打真接口 + 自带种子数据 + 精确断言）
 *
 * 用法：node scripts/smoke-new-features.js
 *
 * 为什么要自己种数据：这个库平时几乎是空的，「有返回」什么都证明不了。
 * 超期、按时完成、部分回款这些判定全是边界问题——空库跑一遍，SQL 写错了也看不出来。
 * 所以这里造 5 条工单 / 3 份合同，期望值都是手算好的，跑完按 no 前缀删干净。
 *
 * 覆盖：
 *   1. 合同回款完成率   GET  /api/contracts/payment-summary
 *   2. 工单超期统计     GET  /api/issues/stats/overdue + /api/issues?overdue=1
 *   3. 文档正文索引     POST /api/docs/reindex + 正文关键词命中
 *   4. 日志导出         GET  /api/logs/export（真 xlsx 字节 + 表头计数）
 *   5. 巡检报告打印版   GET  /api/inspection/reports/:name/print（模块未挂载则转 unit 自测）
 *   6. 新增路由不能挡住既有 /:id（这个项目踩过 Express 顺序的坑）
 *
 * 鉴权直接签发 JWT（不依赖账号口令），服务端每次请求都会查库取最新权限。
 */
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.PORT = process.env.PORT || '4311';
process.env.INSPECTION_INTERVAL_SEC = '0';   // 别让巡检定时器在冒烟期间跑起来

const TAG = 'SMOKE-';
let pass = 0;
const fails = [];
function ok(tag, cond, extra) {
  if (cond) { pass++; console.log('  [OK]   ' + tag + (extra !== undefined && extra !== '' ? ' -> ' + extra : '')); }
  else { fails.push(tag + (extra !== undefined ? ' -> ' + extra : '')); console.log('  [FAIL] ' + tag + (extra !== undefined ? ' -> ' + extra : '')); }
}
function skip(tag, why) { console.log('  [SKIP] ' + tag + '（' + why + '）'); }
function eq(tag, actual, expect) { ok(tag, String(actual) === String(expect), 'actual=' + actual + ' expect=' + expect); }
function near(tag, actual, expect, tol) {
  ok(tag, actual !== null && actual !== undefined && Math.abs(Number(actual) - expect) <= (tol || 0.05),
    'actual=' + actual + ' expect≈' + expect);
}

/** 'YYYY-MM-DD HH:mm:ss'，按本地时间 —— 不能用 Date.parse 的隐式格式，各实现不一致 */
function stamp(msAgo) {
  const d = new Date(Date.now() - msAgo);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
    p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
const H = 3600 * 1000;
const D = 24 * H;

(async () => {
  const { signJwt, getSecret } = require(path.join(ROOT, 'src', 'auth'));
  const { db } = require(path.join(ROOT, 'src', 'db-contract'));   // 账号 / 角色 / 合同
  const his = require(path.join(ROOT, 'src', 'db'));
  his.init();
  const hisDb = his.getDb();                                        // 工单库
  const docsDb = require(path.join(ROOT, 'src', 'db-docs')).raw;     // 文档库
  require(path.join(ROOT, 'server'));
  getSecret();

  const base = 'http://127.0.0.1:' + process.env.PORT;
  for (let i = 0; i < 80; i++) {
    try { await fetch(base + '/api/health'); break; } catch (e) { await new Promise((r) => setTimeout(r, 200)); }
  }

  const admin = db.prepare(
    "SELECT u.id, u.username FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.is_active = 1 AND (r.code = 'admin' OR u.role_id = 1) ORDER BY u.id LIMIT 1"
  ).get();
  if (!admin) { console.log('找不到可用管理员账号，冒烟无法进行'); process.exit(2); }
  const token = signJwt({ id: admin.id, username: admin.username });

  async function call(method, url, body) {
    const opt = { method: method, headers: { Authorization: 'Bearer ' + token } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(base + url, opt);
    const ct = String(res.headers.get('content-type') || '');
    let json = null, buf = null, text = null;
    if (ct.includes('json')) { try { json = await res.json(); } catch (e) {} }
    else if (ct.includes('html')) { text = await res.text(); }
    else { buf = Buffer.from(await res.arrayBuffer()); }
    return { status: res.status, json, buf, text, headers: res.headers };
  }

  function cleanup() {
    const cs = db.prepare("SELECT id FROM contracts WHERE contract_no LIKE ?").all(TAG + '%');
    for (const c of cs) {
      db.prepare('DELETE FROM payments WHERE contract_id = ?').run(c.id);
      db.prepare('DELETE FROM contracts WHERE id = ?').run(c.id);
    }
    hisDb.prepare("DELETE FROM issues WHERE no LIKE ?").run(TAG + '%');
  }

  function seed() {
    cleanup();   // 上次跑崩留下的，先清

    // --- 工单：每条期望状态都是手算的 ---
    // SLA：紧急 4h / 高 24h / 中 72h / 低 120h；预警线 = min(时限/4, 24h)
    const ins = hisDb.prepare(
      `INSERT INTO issues (no,title,category,module,urgency,content,department,reporter,status,assignee_name,report_time,created_at,closed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    // 1) 紧急，10 小时前报，未完成 → 超期约 6 小时
    ins.run(TAG + '1', '冒烟-紧急超期', '日常软件', '', '紧急', '', '信息科', '张三', 'pending', '李工', stamp(10 * H), stamp(10 * H), null);
    // 2) 高，23 小时前报，未完成 → 时限 24h，只剩 1h，落在预警线内
    ins.run(TAG + '2', '冒烟-临近超期', '日常软件', '', '高', '', '信息科', '张三', 'processing', '李工', stamp(23 * H), stamp(23 * H), null);
    // 3) 中，2 小时前报、1 小时前解决 → 按时完成
    ins.run(TAG + '3', '冒烟-按时完成', '日常软件', '', '中', '', '信息科', '张三', 'resolved', '李工', stamp(2 * H), stamp(2 * H), stamp(1 * H));
    // 4) 中，100 小时前报、10 小时前关闭 → 用了 90h > 72h，超时完成
    ins.run(TAG + '4', '冒烟-超时完成', '日常软件', '', '中', '', '信息科', '张三', 'closed', '李工', stamp(100 * H), stamp(100 * H), stamp(10 * H));
    // 5) 低，1 小时前报，未完成 → 剩 119h，正常计时
    ins.run(TAG + '5', '冒烟-正常计时', '日常软件', '', '低', '', '信息科', '张三', 'pending', '李工', stamp(1 * H), stamp(1 * H), null);

    // --- 合同：已付清 / 部分付 / 一分未付且已到期 ---
    const cin = db.prepare(
      `INSERT INTO contracts (contract_no,title,category,amount,end_date,status,created_at,updated_at)
       VALUES (?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`
    );
    const c1 = cin.run(TAG + 'C1', '冒烟-已付清', '软件服务', 100000, stamp(-200 * D).slice(0, 10), '进行中').lastInsertRowid;
    const c2 = cin.run(TAG + 'C2', '冒烟-部分付', '硬件采购', 200000, stamp(-100 * D).slice(0, 10), '进行中').lastInsertRowid;
    const c3 = cin.run(TAG + 'C3', '冒烟-未付款且已到期', '运维服务', 50000, stamp(5 * D).slice(0, 10), '进行中').lastInsertRowid;
    const pin = db.prepare('INSERT INTO payments (contract_id,amount,pay_date,method,remark) VALUES (?,?,?,?,?)');
    pin.run(c1, 100000, stamp(0).slice(0, 10), '转账', '冒烟-本月回款');      // 本月回款 10 万
    pin.run(c2, 50000, stamp(70 * D).slice(0, 10), '转账', '冒烟-往期回款');   // 往期回款 5 万
    return { c1: c1, c2: c2, c3: c3 };
  }

  let seeded;
  try {
    seeded = seed();
    console.log('已种入冒烟数据：5 条工单 + 3 份合同（跑完自动删除）');

    // ---------------------------------------------------------------- 1. 合同回款
    console.log('\n== 1. 合同付款完成率 ==');
    const ps = await call('GET', '/api/contracts/payment-summary');
    ok('接口 200', ps.status === 200, 'status=' + ps.status);
    const d1 = ps.json && ps.json.data;
    ok('返回 code 0', !!ps.json && ps.json.code === 0);
    eq('合同份数', d1 && d1.contracts, 3);
    near('应付总额', d1 && d1.total_amount, 350000);
    near('已回款', d1 && d1.paid_amount, 150000);
    near('未回款', d1 && d1.unpaid_amount, 200000);
    near('完成率(%)', d1 && d1.pay_percent, 42.9, 0.15);
    near('本月回款', d1 && d1.month_paid, 100000);
    eq('分档-未付', d1 && d1.buckets.none, 1);
    eq('分档-部分付', d1 && d1.buckets.partial, 1);
    eq('分档-已付清', d1 && d1.buckets.full, 1);
    eq('已到期未付清', d1 && d1.overdue_unpaid, 1);
    // 欠款最多的是 C2（20 万 - 5 万 = 15 万），C3 只欠 5 万，所以首条应是 C2
    ok('Top 未回款首条是 C2', !!d1 && d1.top_unpaid[0] && String(d1.top_unpaid[0].contract_no) === TAG + 'C2',
      d1 && d1.top_unpaid[0] ? (d1.top_unpaid[0].contract_no + ' 欠 ' + d1.top_unpaid[0].unpaid) : '');
    ok('按分类汇总 3 类', !!d1 && d1.by_category.length === 3,
      d1 ? d1.by_category.map((x) => x.name + ':' + x.pay_percent + '%').join(' | ') : '');

    // ---------------------------------------------------------------- 2. 工单超期
    console.log('\n== 2. 工单超期统计 ==');
    const ov = await call('GET', '/api/issues/stats/overdue');
    ok('接口 200', ov.status === 200, 'status=' + ov.status);
    const d2 = ov.json && ov.json.data;
    eq('工单总数', d2 && d2.total, 5);
    eq('未完成', d2 && d2.open, 3);
    eq('超期未完成', d2 && d2.overdue, 1);
    eq('即将超期', d2 && d2.warning, 1);
    // done 的口径是「已完成的全部」= 按时 1 + 迟到 1，done_late 是其中迟到的子集
    eq('已完成合计', d2 && d2.done, 2);
    eq('其中超时完成', d2 && d2.done_late, 1);
    near('按时完成率(%)', d2 && d2.on_time_rate, 50, 0.5);
    near('平均关闭周期(小时)', d2 && d2.avg_close_hours, 45.5, 0.2);
    ok('最长超期约 6 小时', !!d2 && Math.abs(d2.max_overdue_hours - 6) < 0.1, d2 ? d2.max_overdue_hours + 'h' : '');
    ok('SLA 四档口径齐全', !!d2 && ['紧急', '高', '中', '低'].every((k) => d2.sla_table[k] > 0), d2 ? JSON.stringify(d2.sla_table) : '');
    // 排行按「超期时长」降序：SMOKE-4 迟到 18h，比 SMOKE-1 当前超期 6h 更靠前
    ok('超期排行首条是 SMOKE-4（迟到 18h）', !!d2 && d2.top_overdue[0] && String(d2.top_overdue[0].no) === TAG + '4',
      d2 && d2.top_overdue[0] ? (d2.top_overdue[0].no + ':' + d2.top_overdue[0].sla_text) : '');
    ok('排行里两种性质都带中文说明（不会渲染成空）',
      !!d2 && d2.top_overdue.length === 2 && d2.top_overdue.every((x) => !!x.sla_text && !!x.sla_state),
      d2 ? d2.top_overdue.map((x) => x.sla_state + ':' + x.sla_text).join(' | ') : '');

    const l1 = await call('GET', '/api/issues?page=1&pageSize=50&keyword=' + TAG);
    const rows1 = (l1.json && l1.json.data && l1.json.data.list) || [];
    ok('列表每行都带 sla_state / sla_text',
      rows1.length === 5 && rows1.every((r) => typeof r.sla_state === 'string' && !!r.sla_text),
      rows1.map((r) => r.no.slice(-1) + ':' + r.sla_state).join(' '));
    const byNo = {};
    rows1.forEach((r) => { byNo[r.no] = r; });
    eq('SMOKE-1 状态', byNo[TAG + '1'] && byNo[TAG + '1'].sla_state, 'overdue');
    eq('SMOKE-2 状态', byNo[TAG + '2'] && byNo[TAG + '2'].sla_state, 'warning');
    eq('SMOKE-3 状态', byNo[TAG + '3'] && byNo[TAG + '3'].sla_state, 'done');
    eq('SMOKE-4 状态', byNo[TAG + '4'] && byNo[TAG + '4'].sla_state, 'done_late');
    eq('SMOKE-5 状态', byNo[TAG + '5'] && byNo[TAG + '5'].sla_state, 'ok');

    const l2 = await call('GET', '/api/issues?page=1&pageSize=50&keyword=' + TAG + '&overdue=1');
    const rows2 = (l2.json && l2.json.data && l2.json.data.list) || [];
    eq('只看超期-条数', rows2.length, 1);
    eq('只看超期-是哪条', rows2[0] && rows2[0].no, TAG + '1');
    eq('只看超期-总数一致（下推到 SQL）', l2.json && l2.json.data && l2.json.data.total, 1);

    // ---------------------------------------------------------------- 3. 文档正文索引
    console.log('\n== 3. 文档正文索引 ==');
    const cats = await call('GET', '/api/docs/categories');
    const d3 = cats.json && cats.json.data;
    ok('类型接口带索引概况', !!d3 && !!d3.index && d3.index.pending !== undefined,
      d3 ? ('已索引 ' + d3.index.ok + ' / 待索引 ' + d3.index.pending + ' / 共 ' + d3.index.total) : '无 index');

    const re = await call('POST', '/api/docs/reindex', {});
    ok('重建索引返回 200', re.status === 200, 'status=' + re.status);
    ok('返回统计与中文提示', !!(re.json && re.json.data && re.json.data.total !== undefined) && !!re.json.message,
      re.json ? re.json.message : '');
    const after = await call('GET', '/api/docs/categories');
    eq('重建后待索引归零', after.json && after.json.data && after.json.data.index.pending, 0);

    const dl = await call('GET', '/api/docs?page=1&pageSize=50');
    const docs = (dl.json && dl.json.data && dl.json.data.list) || [];
    ok('列表带 content_status', docs.length ? docs.every((r) => r.content_status !== undefined) : true,
      docs.length ? docs.map((r) => (r.content_status || '未索引') + '/' + r.content_len + '字').join(',') : '（库里没有文档）');

    // 正文命中：关键词必须「只出现在正文里」才算数 —— 搜索同时匹配标题/文件名/标签/备注，
    // 随便抓个词去搜，命中了也可能是文件名命中的，那就什么都没证明。
    let hitChecked = false;
    const candRows = docsDb.prepare(
      "SELECT id, title, original_name, tags, remark, content_text FROM documents WHERE content_status='ok' AND length(content_text) >= 6 LIMIT 10"
    ).all();
    for (const c of candRows) {
      const text = String(c.content_text || '');
      const meta = [c.title, c.original_name, c.tags, c.remark].map((x) => String(x || '')).join('\u0001').toLowerCase();
      const toks = text.match(/[\u4e00-\u9fa5]{3,8}|[A-Za-z][A-Za-z0-9_\-]{4,12}/g) || [];
      // 从后往前挑：正文靠后的词更不可能出现在标题里
      const kw = toks.slice().reverse().find((t) => meta.indexOf(t.toLowerCase()) < 0);
      if (!kw) continue;
      const rs = await call('GET', '/api/docs?page=1&pageSize=50&keyword=' + encodeURIComponent(kw));
      const list = (rs.json && rs.json.data && rs.json.data.list) || [];
      ok('按正文关键词能搜到该文档（该词不在标题/文件名/标签/备注里）',
        list.some((r) => r.id === c.id), '关键词「' + kw + '」→ 命中 ' + list.length + ' 条');
      // 反证：把正文清空后同一个词必须搜不到，才能排除「其实是别的字段命中的」
      const keep = text;
      docsDb.prepare("UPDATE documents SET content_text='' WHERE id = ?").run(c.id);
      const rs2 = await call('GET', '/api/docs?page=1&pageSize=50&keyword=' + encodeURIComponent(kw));
      const list2 = (rs2.json && rs2.json.data && rs2.json.data.list) || [];
      ok('清空正文后同词搜不到（证明是正文命中）', !list2.some((r) => r.id === c.id), '命中 ' + list2.length + ' 条');
      docsDb.prepare('UPDATE documents SET content_text=? WHERE id = ?').run(keep, c.id);
      hitChecked = true;
      break;
    }
    if (!hitChecked) skip('按正文关键词搜索', '没有「只出现在正文里」的可用关键词');

    // ---------------------------------------------------------------- 4. 日志导出
    console.log('\n== 4. 日志导出 ==');
    const now = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const from = (now.getFullYear() - 1) + '-01-01';
    const to = now.getFullYear() + '-' + p2(now.getMonth() + 1) + '-' + p2(now.getDate());
    const ex = await call('GET', '/api/logs/export?from=' + from + '&to=' + to);
    const isZip = ex.buf && ex.buf.length > 4 && ex.buf[0] === 0x50 && ex.buf[1] === 0x4b;
    ok('导出返回 xlsx（zip 魔数 PK）', !!isZip, ex.buf ? (ex.buf.length + ' 字节') : '空响应');
    ok('带导出条数表头', !!ex.headers.get('x-exported-count'),
      '导出 ' + ex.headers.get('x-exported-count') + ' / 匹配 ' + ex.headers.get('x-total-count'));
    const ex2 = await call('GET', '/api/logs/export?from=2020-01-01&to=2020-01-02');
    ok('无数据区间也能导出（不报 500）', ex2.status === 200 && !!(ex2.buf && ex2.buf.length > 4), 'status=' + ex2.status);
    const ex3 = await call('GET', '/api/logs/export?from=2024-13-99');
    ok('非法日期不崩（该条件被忽略）', ex3.status === 200, 'status=' + ex3.status);

    // ---------------------------------------------------------------- 5. 巡检报告打印版
    console.log('\n== 5. 巡检报告导出 PDF ==');
    const reps = await call('GET', '/api/inspection/reports');
    if (reps.status === 404) {
      // 巡检是「整块 try/catch 挂载」：设备数据源为空时整套路由都不注册（设计如此）。
      // 这种情况由 scripts/report-print-selftest.js 直接验 store 来覆盖。
      skip('打印版接口', '本机巡检模块未挂载（data/inspection.json 的 servers 为空）');
    } else if (reps.json && reps.json.code === 0) {
      const items = (reps.json.data && reps.json.data.items) || [];
      if (items.length) {
        const name = items[0].name;
        const pr = await call('GET', '/api/inspection/reports/' + encodeURIComponent(name) + '/print');
        ok('打印版返回 200 html', pr.status === 200 && !!pr.text, name);
        const h = pr.text || '';
        ok('含 A4 打印页面规则', h.indexOf('@page') >= 0 && h.indexOf('A4') >= 0);
        ok('强制展开折叠卡片（否则只有标题没数据）', h.indexOf('card-body') >= 0 && h.indexOf('display:block') >= 0);
        ok('颜色打印保真', h.indexOf('print-color-adjust') >= 0);
        ok('表头逐页重复', h.indexOf('table-header-group') >= 0);
        ok('注入 beforeprint 处理', h.indexOf('beforeprint') >= 0);
        const bad = await call('GET', '/api/inspection/reports/' + encodeURIComponent('../../config.js') + '/print');
        ok('路径穿越被拒', bad.status === 400 || bad.status === 404, 'status=' + bad.status);
      } else skip('打印版', '报告目录里没有报告');
    } else skip('打印版接口', '巡检接口未就绪（status=' + reps.status + '）');

    // ---------------------------------------------------------------- 6. 路由顺序回归
    console.log('\n== 6. 新增路由没挡住既有 /:id ==');
    const cd = await call('GET', '/api/contracts/' + seeded.c1);
    ok('/api/contracts/:id 仍可用', cd.status === 200 && !!cd.json && cd.json.code === 0, 'id=' + seeded.c1);
    const iss = await call('GET', '/api/issues?page=1&pageSize=1&keyword=' + TAG);
    const iid = iss.json && iss.json.data && iss.json.data.list[0] && iss.json.data.list[0].id;
    if (iid) {
      const idtl = await call('GET', '/api/issues/' + iid);
      ok('/api/issues/:id 仍可用', idtl.status === 200 && !!idtl.json && idtl.json.code === 0, 'id=' + iid);
    } else skip('/api/issues/:id', '没有工单');
    if (docs.length) {
      const dd = await call('GET', '/api/docs/' + docs[0].id);
      ok('/api/docs/:id 仍可用', dd.status === 200 && !!dd.json && dd.json.code === 0, 'id=' + docs[0].id);
    } else skip('/api/docs/:id', '没有文档');
    const lg = await call('GET', '/api/logs?page=1&pageSize=5');
    ok('/api/logs 列表仍可用', lg.status === 200 && !!lg.json && lg.json.code === 0);
  } finally {
    cleanup();
    console.log('\n冒烟数据已清理（' + TAG + '*）');
  }

  console.log('\n----------------------------------------');
  console.log('通过 ' + pass + ' 项，失败 ' + fails.length + ' 项');
  if (fails.length) { console.log('失败项：\n  - ' + fails.join('\n  - ')); process.exit(1); }
  console.log('全部通过');
  process.exit(0);
})().catch((e) => {
  console.error('冒烟脚本异常：', e);
  process.exit(3);
});
