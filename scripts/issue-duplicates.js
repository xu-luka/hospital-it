'use strict';
/**
 * 重复工单检测（只读，不改任何数据）
 *
 * 判定口径：问题记录时间（report_time 的日期）相同 + 标题完全相同 + 报障科室相同。
 * 输出两份东西：
 *   - 控制台：按组打印摘要，附「建议保留哪条」的依据
 *   - CSV：每组每行一条明细，Excel 直接打开
 *
 * 用法：
 *   runtime\node.exe scripts\issue-duplicates.js                      # 只看摘要
 *   runtime\node.exe scripts\issue-duplicates.js --csv 清单.csv        # 同时导出明细
 *   runtime\node.exe scripts\issue-duplicates.js --db D:\data\his.db
 *
 * ★ 只读打开。node:sqlite 的 readOnly 会让所有写语句直接抛错，
 *   比「小心点别写」可靠 —— 这份脚本是要放到真实库上跑的。
 */
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = { db: '', csv: '', minRows: 2 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') o.db = argv[++i];
    else if (a === '--csv') o.csv = argv[++i];
    else if (a === '--min') o.minRows = Math.max(2, Number(argv[++i]) || 2);
  }
  if (!o.db) o.db = path.join(__dirname, '..', 'data', 'his.db');
  return o;
}

function openReadOnly(file) {
  if (!fs.existsSync(file)) {
    console.error('找不到数据库：' + file);
    console.error('请在服务器上指定实际路径，例如 --db D:\\hospital-it\\data\\his.db');
    process.exit(2);
  }
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    // 老版本 Node 不认 readOnly 时退化为普通连接，但只执行 SELECT
    console.warn('[提示] 只读模式不可用（' + e.message + '），已退化为普通连接，脚本内只执行查询。');
    return new DatabaseSync(file);
  }
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const db = openReadOnly(o.db);

  // 同一「日期 + 标题 + 科室」出现 2 次以上 = 一组
  const groups = db.prepare(`
    SELECT date(report_time) AS d, TRIM(title) AS title, TRIM(department) AS dept,
           COUNT(*) AS n
    FROM issues
    WHERE report_time IS NOT NULL AND TRIM(report_time) <> ''
    GROUP BY date(report_time), TRIM(title), TRIM(department)
    HAVING COUNT(*) >= ?
    ORDER BY COUNT(*) DESC, d DESC
  `).all(o.minRows);

  const detail = db.prepare(`
    SELECT i.id, i.no, i.title, i.status, i.urgency, i.department, i.reporter,
           i.assignee_name, i.report_time, i.created_at, i.closed_at,
           (SELECT COUNT(*) FROM issue_logs l WHERE l.issue_id = i.id) AS log_n,
           (SELECT COUNT(*) FROM files f WHERE f.issue_id = i.id) AS file_n
    FROM issues i
    WHERE date(i.report_time) = ? AND TRIM(i.title) = ? AND TRIM(i.department) = ?
    ORDER BY i.report_time ASC, i.id ASC
  `);

  const STATUS_LABEL = { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' };
  const rows = [];
  let dupCount = 0;
  let riskGroups = 0;

  const lines = [];
  lines.push('');
  lines.push('重复工单检测报告（口径：同一天 + 同标题 + 同科室）');
  lines.push('数据库：' + o.db);
  lines.push('检测时间：' + new Date().toLocaleString('zh-CN'));
  lines.push('='.repeat(72));

  if (!groups.length) {
    lines.push('');
    lines.push('没有发现符合口径的重复工单。');
  }

  groups.forEach((g, gi) => {
    const items = detail.all(g.d, g.title, g.dept);
    dupCount += items.length - 1; // 每组多出来的条数 = 可清理的条数

    // 建议保留：跟进记录最多 → 附件最多 → 最早创建。
    // ★ 不按「已关闭优先」排序 —— 那会让一条填满记录的旧单盖掉还在处理的新单。
    const score = (r) => [r.log_n, r.file_n, -new Date(r.created_at).getTime()];
    const keep = items.slice().sort((a, b) => {
      const sa = score(a), sb = score(b);
      for (let k = 0; k < sa.length; k++) if (sa[k] !== sb[k]) return sb[k] - sa[k];
      return 0;
    })[0];

    // 风险：组内还有没关的单。删之前必须确认那个故障到底解决了没有。
    const ALIVE = ['pending', 'processing', 'resolved'];
    const alive = items.filter((r) => ALIVE.indexOf(r.status) >= 0);
    const aliveDropped = alive.filter((r) => r.id !== keep.id);
    let risk = '';
    if (aliveDropped.length) {
      risk = '⚠ 组内有 ' + aliveDropped.length + ' 条未关闭（'
        + aliveDropped.map((r) => r.no + ' ' + (STATUS_LABEL[r.status] || r.status)).join('、')
        + '），清理前先确认该故障是否已解决';
    } else if (alive.length && keep.status === 'closed') {
      risk = '⚠ 保留的是已关闭单，但组内还有未关闭记录，注意别漏掉待办';
    }

    lines.push('');
    lines.push('[' + (gi + 1) + '] ' + g.d + '  「' + g.title + '」  ' + (g.dept || '（无科室）') + '  — 共 ' + items.length + ' 条');
    items.forEach((r) => {
      const mark = r.id === keep.id ? ' ← 建议保留' : '';
      lines.push('    ' + String(r.no).padEnd(18)
        + (STATUS_LABEL[r.status] || r.status).padEnd(6)
        + ' 创建 ' + String(r.created_at || '').slice(0, 16)
        + ' 跟进 ' + r.log_n + ' 条'
        + ' 附件 ' + r.file_n + ' 个'
        + ' 报障人 ' + (r.reporter || '—')
        + (r.assignee_name ? ' 处理人 ' + r.assignee_name : '')
        + mark);
    });
    if (risk) { riskGroups++; lines.push('    ' + risk); }

    items.forEach((r) => {
      rows.push([
        gi + 1, g.d, g.title, g.dept, items.length,
        r.no, STATUS_LABEL[r.status] || r.status, r.urgency,
        r.reporter, r.assignee_name, r.report_time, r.created_at, r.closed_at,
        r.log_n, r.file_n,
        r.id === keep.id ? '建议保留' : '候选清理',
        risk ? '是' : '否',
        r.id,
      ]);
    });
  });

  lines.push('');
  lines.push('='.repeat(72));
  lines.push('合计：' + groups.length + ' 组重复，涉及 ' + (groups.reduce((a, g) => a + g.n, 0))
    + ' 条工单，按「每组留 1 条」计可清理 ' + dupCount + ' 条。');
  if (riskGroups) {
    lines.push('其中 ' + riskGroups + ' 组含未关闭工单（报告里标了 ⚠），清理前务必先确认故障是否已解决。');
  }
  lines.push('说明：「建议保留」只是按跟进记录/附件/创建时间的推荐，最终以你人工确认为准。');
  lines.push('本脚本为只读，未修改任何数据。');
  console.log(lines.join('\n'));

  if (o.csv) {
    const head = ['组号', '日期', '标题', '科室', '组内条数', '单号', '状态', '紧急程度',
      '报障人', '处理人', '记录时间', '创建时间', '关闭时间', '跟进条数', '附件数',
      '建议', '组内有未关闭', '记录ID'];
    const out = [head.map(csvCell).join(',')].concat(rows.map((r) => r.map(csvCell).join(','))).join('\r\n');
    // 加 BOM，Excel 双击打开不乱码（内网用户不会去改编码设置）
    fs.writeFileSync(o.csv, '\ufeff' + out, 'utf8');
    console.log('\n明细已导出：' + o.csv + '（' + rows.length + ' 行）');
  }
  db.close();
}

main();
