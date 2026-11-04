'use strict';
/**
 * 工单重复清理（默认只扫描，不改数据）
 *
 * 判定口径（与真实数据的成因对应，见 更新说明.txt）：
 *   · 优先用正文里的「【来源：xxx表·序号N】」当唯一键 —— 同表同序号 = 同一条源记录；
 *     没有序号的老记录，退回「标题 + 问题记录时间 + 报障科室」。
 *   · 每组只保留一条，保留优先级：
 *       ① 有附件的（附件不能丢）
 *       ② 不是「created_at = 报障日 00:00:00 且 created_by=admin」的二次重导批
 *       ③ 真人跟进条数多的
 *       ④ 创建时间早的
 *   · 组内只有 1 条的记录不动。
 *
 * 用法：
 *   runtime\node.exe scripts\issue-dedup-clean.js                       # 只扫描，打印决策
 *   runtime\node.exe scripts\issue-dedup-clean.js --csv 清单.csv         # 顺便导出清单
 *   runtime\node.exe scripts\issue-dedup-clean.js --db D:\data\his.db --apply   # 真正执行（会先备份）
 *
 * ★ 执行前会自动把库备份到 data\_backup_dedup_YYYYMMDD-HHMMSS\（含 -wal/-shm），
 *   失败自动回滚整段事务。删除的每条记录会写进 audit CSV，可追溯。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = { db: '', csv: '', apply: false, backupDir: '', keepKey: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') o.db = argv[++i];
    else if (a === '--csv') o.csv = argv[++i];
    else if (a === '--apply') o.apply = true;
    else if (a === '--backup-dir') o.backupDir = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
  }
  if (!o.db) o.db = path.join(__dirname, '..', 'data', 'his.db');
  return o;
}

const norm = (s) => String(s || '').replace(/[\s\u3000]+/g, '').trim();
const srcNo = (r) => { const m = /序号\s*(\d+)/.exec(String(r.content || '')); return m ? m[1] : ''; };
const srcSheet = (r) => { const m = /【来源：([^·】]+)/.exec(String(r.content || '')); return m ? m[1] : ''; };
const isBackfill = (r) => String(r.created_at || '').endsWith(' 00:00:00') && String(r.created_by || '') === 'admin';
/** 导入机器生成的跟进（没有信息量） */
const isAutoLog = (c) => {
  const t = String(c || '').trim();
  return t === '' || t === '（Excel 导入）' || t === '（Excel 历史记录导入）'
    || t.indexOf('创建问题') === 0 || t.indexOf('指派给') === 0
    || t.indexOf('（Excel 历史记录导入：') === 0;
};

function stamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help) { console.log(fs.readFileSync(__filename, 'utf-8').split('*/')[0]); return; }
  if (!fs.existsSync(o.db)) { console.error('找不到数据库：' + o.db); process.exit(2); }

  // 扫描阶段只读；--apply 才用读写连接，避免误改
  const db = new DatabaseSync(o.db, { readOnly: !o.apply });
  const q = (s, ...a) => db.prepare(s).all(...a);
  const one = (s, ...a) => db.prepare(s).get(...a);

  const rows = q('SELECT * FROM issues');
  if (!rows.length) { console.log('库里没有工单，退出。'); return; }

  // 1) 分组
  const groups = new Map();
  rows.forEach((r) => {
    const n = srcNo(r);
    const k = n ? 'NO|' + srcSheet(r) + '#' + n : 'TT|' + norm(r.title) + '|' + r.report_time + '|' + norm(r.department);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });

  const score = (r) => {
    const files = one('SELECT COUNT(*) c FROM files WHERE issue_id=?', r.id).c;
    const realLogs = one(`SELECT COUNT(*) c FROM issue_logs WHERE issue_id=?`, r.id).c
      ? q('SELECT content FROM issue_logs WHERE issue_id=?', r.id).filter((l) => !isAutoLog(l.content)).length : 0;
    return [files > 0 ? 1 : 0, isBackfill(r) ? 0 : 1, realLogs, -new Date(r.created_at || 0).getTime()];
  };
  const better = (a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] > sb[i] ? a : b;
    return a.id < b.id ? a : b;
  };

  const plan = [];      // 待删
  const keepList = [];  // 保留（有重复的组里的幸存者）
  [...groups.entries()].forEach(([k, items]) => {
    if (items.length < 2) return;
    let keep = items[0];
    for (let i = 1; i < items.length; i++) keep = better(keep, items[i]);
    keepList.push({ key: k, keep, items });
    items.forEach((r) => { if (r.id !== keep.id) plan.push({ key: k, del: r, keep }); });
  });

  // 2) 安全检查：附件 / 独有跟进
  const problems = [];
  plan.forEach((p) => {
    const f = one('SELECT COUNT(*) c FROM files WHERE issue_id=?', p.del.id).c;
    if (f > 0) problems.push('待删 ' + p.del.no + ' 有 ' + f + ' 个附件，不能直接删');
    const dl = q('SELECT content FROM issue_logs WHERE issue_id=?', p.del.id).filter((l) => !isAutoLog(l.content));
    const kl = new Set(q('SELECT content FROM issue_logs WHERE issue_id=?', p.keep.id).filter((l) => !isAutoLog(l.content))
      .map((l) => norm(l.content)));
    // 「解决方法：xxx」若幸存者正文里已有，视为不丢
    const kc = norm(p.keep.content);
    const lost = dl.filter((l) => {
      const c = norm(l.content);
      if (kl.has(c)) return false;
      const body = norm(String(l.content).replace(/^解决方法[:：]?/, ''));
      return !(body && kc.indexOf(body) >= 0);
    });
    if (lost.length) problems.push('待删 ' + p.del.no + ' 有 ' + lost.length + ' 条独有跟进：' + JSON.stringify(lost[0].content).slice(0, 60));
  });

  // 3) 输出
  const lines = [];
  lines.push('工单重复清理' + (o.apply ? '（执行）' : '（仅扫描，未修改任何数据）'));
  lines.push('数据库：' + o.db);
  lines.push('工单总数：' + rows.length + '，重复组：' + keepList.length + '，计划清理：' + plan.length + ' 条');
  lines.push('清理后预计：' + (rows.length - plan.length) + ' 条');
  lines.push('');
  if (problems.length) {
    lines.push('！安全检查未通过（' + problems.length + ' 项）：');
    problems.forEach((p) => lines.push('   ' + p));
    lines.push('');
  } else {
    lines.push('✓ 安全检查通过：待删记录均无附件、无独有跟进内容。');
    lines.push('');
  }
  lines.push('保留优先级：有附件 > 非二次重导批 > 真人跟进多 > 创建早');
  lines.push('—'.repeat(72));
  keepList.forEach((g, i) => {
    lines.push('[' + (i + 1) + '] ' + g.key);
    g.items.forEach((r) => {
      lines.push('    ' + (r.id === g.keep.id ? '√ 保留 ' : '× 删除 ') + String(r.no).padEnd(18)
        + r.status.padEnd(10) + ' ' + String(r.created_at).slice(0, 16)
        + '  附件' + one('SELECT COUNT(*) c FROM files WHERE issue_id=?', r.id).c
        + ' 跟进' + one('SELECT COUNT(*) c FROM issue_logs WHERE issue_id=?', r.id).c
        + (isBackfill(r) ? ' [二次重导批]' : '')
        + '  「' + String(r.title).slice(0, 24) + '」');
    });
  });
  console.log(lines.join('\n'));

  // 4) CSV
  if (o.csv) {
    const head = ['组号', '分组键', '处置', '记录ID', '单号', '标题', '问题记录时间', '状态', '处理人',
      '创建时间', '创建人', '附件数', '跟进数', '是否二次重导批', '保留单号'];
    const out = [head.map(csvCell).join(',')];
    keepList.forEach((g, i) => {
      g.items.forEach((r) => {
        out.push([i + 1, g.key, r.id === g.keep.id ? '保留' : '删除', r.id, r.no, r.title, r.report_time, r.status,
          r.assignee_name || '', r.created_at, r.created_by || '',
          one('SELECT COUNT(*) c FROM files WHERE issue_id=?', r.id).c,
          one('SELECT COUNT(*) c FROM issue_logs WHERE issue_id=?', r.id).c,
          isBackfill(r) ? '是' : '', g.keep.no].map(csvCell).join(','));
      });
    });
    fs.writeFileSync(o.csv, '\ufeff' + out.join('\r\n'), 'utf-8');
    console.log('\n清单已导出：' + o.csv + '（' + (out.length - 1) + ' 行）');
  }

  if (!o.apply) {
    console.log('\n这是扫描模式，未改动任何数据。确认无误后加 --apply 执行（会先自动备份）。');
    return;
  }
  if (problems.length) {
    console.error('\n安全检查未通过，已中止，未做任何修改。');
    process.exit(3);
  }
  if (!plan.length) { console.log('\n没有需要清理的记录。'); return; }

  // 5) 备份
  const dir = o.backupDir || path.join(path.dirname(o.db), '_backup_dedup_' + stamp(new Date()));
  fs.mkdirSync(dir, { recursive: true });
  ['', '-wal', '-shm'].forEach((suf) => {
    const s = o.db + suf;
    if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dir, path.basename(o.db) + suf));
  });
  console.log('\n已备份到：' + dir);

  // 6) 执行（单事务）
  const audit = [['记录ID', '单号', '标题', '问题记录时间', '状态', '创建时间', '创建人', '删除原因', '保留单号']];
  db.exec('BEGIN IMMEDIATE');
  try {
    const delLog = db.prepare('DELETE FROM issue_logs WHERE issue_id=?');
    const delIssue = db.prepare('DELETE FROM issues WHERE id=?');
    const updStatus = db.prepare('UPDATE issues SET status=?, closed_at=?, updated_at=? WHERE id=?');
    const RANK = { pending: 0, processing: 1, resolved: 2, closed: 3 };
    plan.forEach((p) => {
      const nLog = one('SELECT COUNT(*) c FROM issue_logs WHERE issue_id=?', p.del.id).c;
      // 待删那条的状态更靠后（如「已关闭」vs「已解决」）→ 先把状态挪到保留的那条上，
      // 否则清理完这条工单看着像还没关，统计里的「未关闭数」也会虚高。
      const rs = RANK[p.del.status] || 0, rk = RANK[p.keep.status] || 0;
      if (rs > rk) {
        updStatus.run(p.del.status, p.del.closed_at || p.del.updated_at || p.del.created_at,
          p.del.updated_at || p.del.created_at, p.keep.id);
        console.log('  状态随迁：' + p.keep.no + ' ' + p.keep.status + ' → ' + p.del.status);
      }
      delLog.run(p.del.id);
      delIssue.run(p.del.id);
      audit.push([p.del.id, p.del.no, p.del.title, p.del.report_time, p.del.status,
        p.del.created_at, p.del.created_by || '', '与 ' + p.keep.no + ' 重复（' + p.key + '）', p.keep.no]);
      console.log('  删除 ' + p.del.no + '（含 ' + nLog + ' 条跟进）← 保留 ' + p.keep.no);
    });
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { }
    console.error('\n执行失败已回滚：' + ((e && e.message) || e));
    console.error('备份在：' + dir);
    process.exit(4);
  }

  const after = one('SELECT COUNT(*) c FROM issues').c;
  const auditFile = path.join(dir, 'deleted-audit.csv');
  fs.writeFileSync(auditFile, '\ufeff' + audit.map((r) => r.map(csvCell).join(',')).join('\r\n'), 'utf-8');
  console.log('\n完成：' + rows.length + ' → ' + after + ' 条（删除 ' + plan.length + '）。');
  console.log('删除明细：' + auditFile);
  console.log('如需回滚：停服务 → 把备份目录里的 ' + path.basename(o.db) + ' 覆盖回原位（连同 -wal/-shm）→ 重启。');
}

main();
