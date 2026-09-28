'use strict';
const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { db } = require('../db-contract');
const { authRequired } = require('../auth');
const { logAction } = require('../utils');

router.use(authRequired);

// ---------- 列定义（模板 / 导出 / 导入三端共用） ----------
// stat: true 表示仅导出统计列，导入时忽略
const COLUMNS = [
  { key: 'contract_no',   name: '合同编号',     required: true },
  { key: 'title',         name: '合同名称',     required: true },
  { key: 'category',      name: '分类' },
  { key: 'party_a',       name: '甲方' },
  { key: 'party_b',       name: '乙方' },
  { key: 'amount',        name: '合同金额(元)', num: true },
  { key: 'sign_date',     name: '签订日期',     date: true },
  { key: 'start_date',    name: '开始日期',     date: true },
  { key: 'end_date',      name: '到期日期',     date: true },
  { key: 'status',        name: '状态' },
  { key: 'delivery_req',  name: '交货要求' },
  { key: 'accept_date',   name: '验收日期',     date: true },
  { key: 'service_start', name: '服务生效日期', date: true },
  { key: 'service_end',   name: '服务结束日期', date: true },
  { key: 'pay_method',    name: '付款方式' },
  { key: 'invoice_date',  name: '发票日期',     date: true },
  { key: 'invoice_no',    name: '发票编号' },
  { key: 'fund_type',     name: '资金性质' },
  { key: 'agency',        name: '代理公司' },
  { key: 'fund_source',   name: '资金来源' },
  { key: 'remark',        name: '备注' },
  // 设备明细列（同一合同编号多行 = 多台设备）
  { key: 'dev_name',      name: '设备名称' },
  { key: 'dev_model',     name: '设备型号' },
  { key: 'dev_qty',       name: '设备数量',     num: true },
  { key: 'dev_price',     name: '设备单价(元)', num: true },
  { key: 'dev_remark',    name: '设备备注' },
  // 统计列（仅导出）
  { key: 'paid_amount',   name: '已付金额(元)', num: true, stat: true },
  { key: 'unpaid_amount', name: '未付金额(元)', num: true, stat: true }
];

// ---------- 值清洗工具 ----------
function safeNum(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return (typeof n === 'number' && isFinite(n)) ? n : 0;
}
function safeText(v) {
  if (v === null || v === undefined || typeof v === 'object') return '';
  return String(v).trim();
}
// 日期规范化：支持 Date 对象 / 2026-06-30 / 2026/6/30 / 2026.6.30
function normDate(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date && !isNaN(v.getTime())) {
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  const s = safeText(v);
  if (!s) return null;
  const m1 = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m1) return `${m1[1]}-${m1[2].padStart(2, '0')}-${m1[3].padStart(2, '0')}`;
  return s;
}

// 响应 xlsx 文件
function sendWorkbook(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(filename));
  res.send(buf);
}

// ---------- GET /api/excel/template - 下载导入模板 ----------
router.get('/template', (req, res) => {
  const header = COLUMNS.filter(c => !c.stat).map(c => c.name);

  // 示例数据：两行 = 一份合同两台设备（演示多设备写法）
  const examples = [
    ['HT-2026-0001', '办公电脑采购合同', '采购', '本单位', '某某科技公司', 128000,
     '2026-06-28', '2026-06-29', '2027-06-28', '进行中',
     '合同签订后10个工作日内交货', '2026-07-10', '', '', '验收后付款',
     '2026-07-15', '00000000000000000000', '财政资金', '', '项目预算', '三年质保',
     '笔记本电脑', 'ThinkPad T14', 10, 6500, ''],
    ['HT-2026-0001', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '',
     '显示器', 'Dell U2723QE', 10, 1800, '']
  ];

  const ws = XLSX.utils.aoa_to_sheet([header, ...examples]);
  ws['!cols'] = header.map(h => ({ wch: Math.max(10, h.length * 2 + 4) }));

  const guide = [
    ['合同导入模板填写说明'],
    [''],
    ['1. 第一行为表头，请勿修改列名和列顺序'],
    ['2. 一行 = 一份合同 或 一台设备；同一合同有多台设备时，复制多行并保持"合同编号"一致，合同字段填第一行即可，后续行只填设备五列'],
    ['3. 必填列：合同编号、合同名称'],
    ['4. 日期格式：2026-06-30 或 2026/6/30 均可'],
    ['5. 状态可选：进行中 / 已完成 / 已终止 / 草稿；留空默认"进行中"'],
    ['6. 金额与数量请填纯数字（不要千分位逗号、不要"元"等单位）'],
    ['7. 系统中已存在的合同编号将被跳过，不会重复导入'],
    ['8. 导入完成后会显示每条记录的成功 / 跳过 / 失败明细'],
    ['9. 请删除两行示例数据后再导入']
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(guide);
  wsGuide['!cols'] = [{ wch: 100 }];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '合同数据');
  XLSX.utils.book_append_sheet(wb, wsGuide, '填写说明');

  logAction(req, '下载导入模板', '');
  sendWorkbook(res, wb, '合同导入模板.xlsx');
});

// ---------- GET /api/excel/export - 按当前筛选导出 ----------
router.get('/export', (req, res) => {
  const { keyword, category, status } = req.query;
  const where = [];
  const params = [];
  if (keyword) {
    const k = `%${keyword}%`;
    where.push('(c.title LIKE ? OR c.contract_no LIKE ? OR c.party_a LIKE ? OR c.party_b LIKE ?)');
    params.push(k, k, k, k);
  }
  if (category) { where.push('c.category = ?'); params.push(category); }
  if (status) { where.push('c.status = ?'); params.push(status); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const contracts = db.prepare(
    `SELECT c.*,
       (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.contract_id=c.id) AS paid_amount
     FROM contracts c ${whereSql} ORDER BY c.id DESC`
  ).all(...params);

  const devStmt = db.prepare('SELECT * FROM devices WHERE contract_id=? ORDER BY id ASC');

  const header = COLUMNS.map(c => c.name);
  const rows = [header];
  for (const c of contracts) {
    const paid = safeNum(c.paid_amount);
    const total = safeNum(c.amount);
    const base = [
      c.contract_no, c.title, c.category || '', c.party_a || '', c.party_b || '',
      safeNum(c.amount), c.sign_date, c.start_date, c.end_date, c.status || '进行中',
      c.delivery_req || '', c.accept_date, c.service_start, c.service_end,
      c.pay_method || '', c.invoice_date, c.invoice_no || '', c.fund_type || '', c.agency || '', c.fund_source || '',
      c.remark || ''
    ];
    const stats = [paid, Math.max(total - paid, 0)];
    const devs = devStmt.all(c.id);
    if (!devs.length) {
      rows.push([...base, '', '', '', '', '', ...stats]);
    } else {
      for (const d of devs) {
        rows.push([...base, d.name, d.model || '', d.quantity, safeNum(d.unit_price), d.remark || '', ...stats]);
      }
    }
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = header.map(h => ({ wch: Math.max(10, h.length * 2 + 4) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '合同台账');

  logAction(req, '导出Excel', `共 ${contracts.length} 份合同`);
  sendWorkbook(res, wb, `合同台账_${new Date().toISOString().slice(0, 10)}.xlsx`);
});

// ---------- POST /api/excel/import - 上传 Excel 导入 ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, message: '未接收到文件' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return res.status(400).json({ code: 400, message: '无法识别的 Excel 文件，请使用系统提供的模板' });
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return res.status(400).json({ code: 400, message: 'Excel 中没有工作表' });

  const headerRow = (XLSX.utils.sheet_to_json(ws, { header: 1 })[0] || []).map(h => safeText(h));
  if (!headerRow.includes('合同编号')) {
    return res.status(400).json({ code: 400, message: '表头缺少"合同编号"列，请使用系统提供的模板' });
  }

  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
  if (!rows.length) return res.status(400).json({ code: 400, message: '表格中没有数据行（请删除示例后填写真实数据）' });

  // 按合同编号分组：{fields, devices, firstRow}
  const groups = new Map();
  const failed = [];
  const skipped = [];

  rows.forEach((r, idx) => {
    const rowNo = idx + 2; // Excel 实际行号（第1行是表头）
    const no = safeText(r['合同编号']);
    if (!no) {
      // 整行是否有内容
      const hasContent = Object.values(r).some(v => safeText(v));
      if (hasContent) failed.push({ row: rowNo, contract_no: '', reason: '合同编号为空' });
      return;
    }
    if (!groups.has(no)) {
      groups.set(no, { firstRow: rowNo, fields: r, devices: [] });
    } else {
      const g = groups.get(no);
      const devName = safeText(r['设备名称']);
      if (devName) {
        g.devices.push({
          name: devName,
          model: safeText(r['设备型号']),
          quantity: Math.max(1, Math.round(safeNum(r['设备数量']) || 1)),
          unit_price: Math.max(0, safeNum(r['设备单价(元)'])),
          remark: safeText(r['设备备注'])
        });
      }
      // 后续行若填写了设备以外的字段，忽略（以第一行为准）
    }
  });

  // 处理第一行的设备 + 合同级校验与入库
  const insertContract = db.prepare(
    `INSERT INTO contracts (contract_no,title,category,party_a,party_b,amount,sign_date,start_date,end_date,status,remark,
       delivery_req,accept_date,service_start,service_end,pay_method,invoice_date,invoice_no,fund_type,agency,fund_source,created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insertDevice = db.prepare(
    'INSERT INTO devices (contract_id, name, model, quantity, unit_price, remark) VALUES (?,?,?,?,?,?)'
  );

  let success = 0;
  for (const [no, g] of groups) {
    const r = g.fields;
    const title = safeText(r['合同名称']);
    if (!title) {
      failed.push({ row: g.firstRow, contract_no: no, reason: '合同名称为空' });
      continue;
    }
    // 已存在则跳过
    const exists = db.prepare('SELECT id FROM contracts WHERE contract_no=?').get(no);
    if (exists) {
      skipped.push({ row: g.firstRow, contract_no: no, reason: '合同编号已存在' });
      continue;
    }

    // 第一行的设备
    const firstDevName = safeText(r['设备名称']);
    if (firstDevName) {
      g.devices.unshift({
        name: firstDevName,
        model: safeText(r['设备型号']),
        quantity: Math.max(1, Math.round(safeNum(r['设备数量']) || 1)),
        unit_price: Math.max(0, safeNum(r['设备单价(元)'])),
        remark: safeText(r['设备备注'])
      });
    }

    try {
      const info = insertContract.run(
        no, title,
        safeText(r['分类']), safeText(r['甲方']), safeText(r['乙方']),
        safeNum(r['合同金额(元)']),
        normDate(r['签订日期']), normDate(r['开始日期']), normDate(r['到期日期']),
        safeText(r['状态']) || '进行中', safeText(r['备注']),
        safeText(r['交货要求']), normDate(r['验收日期']), normDate(r['服务生效日期']), normDate(r['服务结束日期']),
        safeText(r['付款方式']), normDate(r['发票日期']), safeText(r['发票编号']),
        safeText(r['资金性质']), safeText(r['代理公司']), safeText(r['资金来源']),
        req.user.id
      );
      for (const d of g.devices) {
        insertDevice.run(info.lastInsertRowid, d.name, d.model, d.quantity, d.unit_price, d.remark);
      }
      success++;
    } catch (e) {
      failed.push({ row: g.firstRow, contract_no: no, reason: e.message.slice(0, 100) });
    }
  }

  logAction(req, '导入Excel', `成功 ${success} 份，跳过 ${skipped.length} 份，失败 ${failed.length} 条（文件：${req.file.originalname}）`);
  res.json({ code: 0, data: { success, skipped, failed, total: groups.size } });
});

module.exports = router;