'use strict';
/**
 * 终端资产台账路由。
 *
 * 权限：整个路由 guardModule('terminals') —— 读要 view、写要 manage（要处理报障的人本来就要能查设备）。
 * 刻意不设「看序列号」之类的独立权限点：终端台账里没有凭据，SN/资产号是找人修机器必需的，
 * 拆开只会造出「能看到设备但看不到是哪台」的角色。
 *
 * 路由顺序：/meta、/options 必须排在 /:id 之前，否则会被当成 id="meta" 吞掉。
 */
const express = require('express');
const { authRequired, guardModule } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../terminals');

const router = express.Router();
router.use(authRequired, guardModule('terminals'));

function fail(res, r, fallback) {
  const code = r && r.notFound ? 404 : 400;
  res.status(code).json({ code, message: (r && r.error) || fallback || '操作失败' });
}

// GET /api/terminals/meta —— 科室/院区/区域/楼层/统计类别/设备性质清单（新增、筛选下拉用）
router.get('/meta', (req, res) => {
  try {
    res.json({ code: 0, data: repo.meta() });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取台账元数据失败：' + ((e && e.message) || e) });
  }
});

// GET /api/terminals/options —— 工单表单的设备下拉（最多 300 条）
router.get('/options', (req, res) => {
  try {
    res.json({ code: 0, data: repo.options({ keyword: req.query.keyword, department: req.query.department }) });
  } catch (e) {
    // 台账不可用不该挡住报修：返回空清单 + 原因，前端会退回「手动填写」
    res.json({ code: 0, message: '设备清单读取失败：' + ((e && e.message) || e), data: { list: [], total: 0 } });
  }
});

// GET /api/terminals —— 列表（关键词/科室/统计类别/设备性质/排序/分页）
router.get('/', (req, res) => {
  try {
    res.json({ code: 0, data: repo.list({
      keyword: req.query.keyword,
      department: req.query.department,
      stat_category: req.query.stat_category,
      nature: req.query.nature,
      sort: req.query.sort,
      page: req.query.page,
      pageSize: req.query.pageSize,
    }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取终端台账失败：' + ((e && e.message) || e) });
  }
});

// NOTE: GET /:id 不在这里，故意挪到文件末尾 —— /template、/export 也是 GET，
// 若 /:id 先声明会把它们当成 id="template" 吞掉（接口一访问就 404，看着像功能没做）。

// POST /api/terminals —— 新增
router.post('/', (req, res) => {
  try {
    const r = repo.create(req.body || {}, req.user);
    if (!r.ok) return fail(res, r);
    logAction(req, '新增终端设备', (r.name || '') + ' #' + r.id);
    res.json({ code: 0, data: { id: r.id, name: r.name || '' } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// PUT /api/terminals/:id —— 编辑（未传的字段保持原值）
router.put('/:id', (req, res) => {
  try {
    const r = repo.update(req.params.id, req.body || {});
    if (!r.ok) return fail(res, r);
    logAction(req, '修改终端设备', (r.name || '') + ' #' + req.params.id);
    res.json({ code: 0 });
  } catch (e) {
    res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
});

// DELETE /api/terminals/:id —— 删除（关联工单只解绑，不删）
router.delete('/:id', (req, res) => {
  try {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ code: 404, message: '设备不存在' });
    const r = repo.remove(req.params.id);
    if (!r.ok) return fail(res, r);
    logAction(req, '删除终端设备', String(t.name || '') + ' #' + t.id
      + (r.detached_issues ? '（解绑 ' + r.detached_issues + ' 张工单）' : ''));
    res.json({ code: 0, data: { detached_issues: r.detached_issues || 0 } });
  } catch (e) {
    res.status(500).json({ code: 500, message: '删除失败：' + ((e && e.message) || e) });
  }
});

// ---------- Excel 导入 / 导出 ----------
const multer = require('multer');
const XLSX = require('xlsx');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const ALL_COLUMNS = repo.EXCEL_COLUMNS;

/** 表头归一化：去空格、全角括号转半角、英文转小写 —— 用户从 Excel 里拷来拷去很容易带空格 */
function normHeader(h) {
  return String(h == null ? '' : h)
    .replace(/\s+/g, '')
    .replace(/[（]/g, '(').replace(/[）]/g, ')')
    .replace(/[：:]/g, '')
    .toLowerCase();
}

/**
 * 表头 → 内部字段。除了我们自己写出去的 21 个列名，还认一批常见异写（台账在院里被改过好几版）。
 * ★ 只映射到 21 列里的字段。以前这里还认「设备名称 / 状态 / 责任人 / 保修期 / 备注」，
 *   表结构重建后这几列已经不存在，再映射过去会让导入静默丢字段 —— 不如不认，
 *   多出来的列按「系统不认识的列」忽略掉（导入说明里已写明这一点）。
 */
const HEADER_MAP = (() => {
  const m = {};
  ALL_COLUMNS.forEach((c) => { m[normHeader(c.name)] = c.key; });
  const alias = {
    '资产编号': 'asset_no', '资产号': 'asset_no', '固定资产编码': 'asset_no', '固定资产编号': 'asset_no',
    '设备编码': 'asset_no', '设备编号': 'asset_no',
    '计算机名': 'hostname', '工作组': 'hostname', '计算机名/工作组': 'hostname', '主机名': 'hostname',
    'ip': 'ip', 'ip地址': 'ip', '内网ip': 'ip', '内网': 'ip', '内网ip地址': 'ip',
    '外网ip': 'ip_extra', '外网': 'ip_extra', '外网ip地址': 'ip_extra',
    'mac地址': 'mac', '物理地址': 'mac',
    'sn': 'sn', '序列号': 'sn', 'sn号': 'sn',
    '出厂日期': 'produce_date', '生产时间': 'produce_date',
    '所属科室': 'department', '使用科室': 'department', '部门': 'department',
    '安装位置': 'location', '房间': 'location', '具体位置': 'location',
    // 「类型／设备类型」在院里那份表里指的就是统计类别，不是系统自造的大类
    '设备类型': 'stat_category', '类型': 'stat_category', '设备类别': 'stat_category', '统计分类': 'stat_category',
    '产权性质': 'nature', '来源': 'nature',
    '显示器': 'monitor', '显示器尺寸(inch)': 'monitor',
    '耗材': 'consumable', '耗材规格': 'consumable', '硒鼓型号': 'consumable',
  };
  Object.keys(alias).forEach((k) => { m[normHeader(k)] = alias[k]; });
  return m;
})();

/** 这些列出现任意一个，才认为这张表是设备台账（用来跳过「填写说明」之类的表）。
 *  刻意不含「院区」—— 一张只有院区的表没有任何可用信息，认了也没法建记录。 */
const IDENTIFY_COLS = ['统计类别', '设备性质', '资产编码', '科室', 'mac', 'sn码', '内网地址'];

function sendWorkbook(res, wb, filename) {
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(filename));
  res.send(buf);
}

function colWidths(header) {
  return header.map((h) => ({ wch: Math.max(10, Math.min(28, h.length * 2 + 4)) }));
}

// GET /api/terminals/template —— 下载导入模板（含填写说明）
router.get('/template', (req, res) => {
  try {
    const header = ALL_COLUMNS.map((c) => c.name);
    const idx = (name) => header.indexOf(name);
    const mk = (obj) => {
      const row = new Array(header.length).fill('');
      Object.keys(obj).forEach((k) => { if (idx(k) >= 0) row[idx(k)] = obj[k]; });
      return row;
    };

    const examples = [
      mk({
        '院区': '珠江街道', '资产编码': '0104020101620', '区域': '门诊楼', '楼层': '三楼',
        '科室': '财务科', '位置': '医生办（一）', '统计类别': '台式计算机', '设备性质': '政府采购设备',
        '工作组/计算机名': 'PC-20180817RHBE', '内网地址': '200.100.60.34', '外网地址': '10.10.10.248',
        'MAC': '80-3F-5D-08-F9-55', 'SN码': 'M706TL9J', '生产日期': '2018-06-02',
        '型号': '启天M410-N000', '操作系统': 'Windows 10', 'CPU': 'Intel Core i5-7500',
        '硬盘': '256G+1T', '内存': 'DDR4 - 8G', '显示器尺寸': "Lenovo-LCD 20'",
      }),
      mk({
        '院区': '珠江街道', '资产编码': '0104020101686', '区域': '住院楼', '楼层': '三楼',
        '科室': '住院儿科', '位置': '护士站（一）', '统计类别': '黑白打印机', '设备性质': '租赁设备',
        '内网地址': '200.100.60.37', 'MAC': '04-0E-3C-E2-A6-14', 'SN码': 'B6S01A',
        '生产日期': '2023-07-10', '型号': 'Epson M101', '耗材型号': 'T7741',
      }),
    ];

    const ws = XLSX.utils.aoa_to_sheet([header, ...examples]);
    ws['!cols'] = colWidths(header);

    const guide = [
      ['终端资产台账 导入说明'],
      [''],
      ['一、表头怎么放'],
      ['1. 第一行必须是表头（列名），第二行起是数据；列的顺序不限，系统按列名认。'],
      ['2. 系统只认下面 21 个列名，多出来的列（比如自己加的「验收人」「备注」）会被忽略，不会报错：'],
      ['   院区 / 资产编码 / 区域 / 楼层 / 科室 / 位置 / 统计类别 / 设备性质 / 工作组/计算机名 /'],
      ['   内网地址 / 外网地址 / MAC / SN码 / 生产日期 / 型号 / 操作系统 / CPU / 硬盘 / 内存 /'],
      ['   显示器尺寸 / 耗材型号'],
      ['3. 列名少几个也没关系：这台设备没有的字段留空就行（比如打印机不会填 CPU）。'],
      ['4. 支持把院里现成的台账直接拿来导入 —— 计算机 / 打印机 / 其他设备分成几个 sheet 也行，'],
      ['   系统会逐个 sheet 读，只跳过它一个字段都认不出的表（例如「填写说明」）。'],
      [''],
      ['二、怎么判断「同一台设备」（查重顺序）'],
      ['1. 先比 MAC（会先把「内网：/外网：」前缀去掉、冒号和横杠统一，所以两种写法算同一台）；'],
      ['2. 再比 SN 码；3. 再比资产编码；4. 再比「工作组/计算机名」；'],
      ['5. 都没有时按「科室+位置+统计类别+型号」比（这四项里至少要有两项）。'],
      ['所以同一份台账导第二次不会翻倍，只会更新。'],
      [''],
      ['三、已有设备怎么处理'],
      ['1. 默认「更新」：只覆盖表里有值的字段，空白格不会把系统里已有的内容清掉。'],
      ['2. 想先看看会改什么：导入时页面上会给预览（新增多少、更新多少、每个字段改了什么），'],
      ['   确认后才真正写库。'],
      ['3. 也可以选「只新增，跳过已有」，用于第一次摸底。'],
      [''],
      ['四、几个容易填错的列'],
      ['1. 生产日期：YYYY-MM-DD（2023-07-10），也接受 2023/7/10。'],
      ['2. MAC：横杠、冒号、带不带「内网：」前缀都能认。'],
      ['3. 「-」会被当成「没有」，与原台账的习惯一致。'],
      ['4. 统计类别：照院里原来的说法填（台式计算机 / 黑白打印机 / 多功能一体机 …），'],
      ['   系统会自己归到「PC / 打印机 / 一体机」这类大类型里，原始说法仍然保留。'],
      ['5. 工作组/计算机名：列表里「设备」那一列优先显示它；没这一列的设备（打印机等）'],
      ['   显示「统计类别 + 型号」，再空就显示资产编码。所以尽量别全空着。'],
      [''],
      ['五、导入前请删掉本表的两行示例数据。'],
    ];
    const wsGuide = XLSX.utils.aoa_to_sheet(guide);
    wsGuide['!cols'] = [{ wch: 110 }];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '终端资产');
    XLSX.utils.book_append_sheet(wb, wsGuide, '填写说明');

    logAction(req, '下载终端资产导入模板', '');
    sendWorkbook(res, wb, '终端资产导入模板.xlsx');
  } catch (e) {
    res.status(500).json({ code: 500, message: '生成模板失败：' + ((e && e.message) || e) });
  }
});

// GET /api/terminals/export —— 按当前筛选导出（不传筛选就是全量）
router.get('/export', (req, res) => {
  try {
    const rows = repo.exportList({
      keyword: req.query.keyword,
      department: req.query.department,
      stat_category: req.query.stat_category,
      nature: req.query.nature,
      sort: req.query.sort,
    });

    const header = ALL_COLUMNS.map((c) => c.name);
    const data = [header];
    rows.forEach((r) => {
      data.push(ALL_COLUMNS.map((c) => {
        const v = r[c.key];
        return v == null ? '' : v;
      }));
    });

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = colWidths(header);
    if (data.length > 1) {
      ws['!autofilter'] = {
        ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: header.length - 1 } }),
      };
    }

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '终端资产');

    const d = new Date();
    const p = (n) => (n < 10 ? '0' : '') + n;
    const stamp = d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());

    logAction(req, '导出终端资产Excel', '共 ' + rows.length + ' 台'
      + (req.query.keyword || req.query.department ? '（按当前筛选）' : '（全量）'));
    sendWorkbook(res, wb, '终端资产台账_' + stamp + '.xlsx');
  } catch (e) {
    res.status(500).json({ code: 500, message: '导出失败：' + ((e && e.message) || e) });
  }
});

// POST /api/terminals/import?dryRun=1&mode=update —— 上传 Excel 导入（dryRun=1 只预览不落库）
router.post('/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ code: 400, message: '未接收到文件' });

  let wb;
  try {
    wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
  } catch (e) {
    return res.status(400).json({ code: 400, message: '无法识别的 Excel 文件，请使用 .xlsx 格式（或先下载导入模板）' });
  }

  const records = [];
  const scanned = [];
  try {
    wb.SheetNames.forEach((name) => {
      const ws = wb.Sheets[name];
      if (!ws) return;
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!aoa.length) return;

      const rawHeader = (aoa[0] || []).map((h) => normHeader(h));
      const mapped = rawHeader.map((h) => HEADER_MAP[h] || '');
      const hit = rawHeader.filter((h) => IDENTIFY_COLS.some((c) => normHeader(c) === h)).length;
      if (!hit) {
        scanned.push({ sheet: name, skipped: true, reason: '表头里没有任何台账字段，已跳过' });
        return;
      }

      let used = 0;
      for (let i = 1; i < aoa.length; i++) {
        const line = aoa[i] || [];
        const obj = { __sheet: name, __row: i + 1 };
        let any = false;
        mapped.forEach((key, ci) => {
          if (!key) return;
          const v = line[ci];
          if (v === undefined || v === null || v === '') return;
          obj[key] = v;
          any = true;
        });
        if (any) { records.push(obj); used++; }
      }
      scanned.push({ sheet: name, rows: used });
    });
  } catch (e) {
    return res.status(400).json({ code: 400, message: '解析 Excel 失败：' + ((e && e.message) || e) });
  }

  if (!records.length) {
    return res.status(400).json({
      code: 400,
      message: '表格里没有读到数据行。请确认第一行是表头（至少要有「科室」「统计类别」「MAC」「资产编码」其中之一），'
        + '且数据从第二行开始',
    });
  }

  try {
    const r = repo.importRows(records, {
      dryRun: String(req.query.dryRun || '') === '1',
      mode: req.query.mode === 'skip' ? 'skip' : 'update',
      user: req.user,
    });
    if (!r.ok) return res.status(400).json({ code: 400, message: r.error });

    if (!r.dryRun) {
      logAction(req, '导入终端资产Excel',
        '新增 ' + r.created + ' / 更新 ' + r.updated + ' / 无变化 ' + r.unchanged
        + ' / 跳过 ' + r.skipped + ' / 信息不足 ' + r.thinTotal + ' / 失败 ' + r.failedTotal
        + '（文件：' + req.file.originalname + '）');
    }
    res.json({ code: 0, data: Object.assign({}, r, { sheets_scanned: scanned, filename: req.file.originalname }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '导入失败：' + ((e && e.message) || e) });
  }
});

// GET /api/terminals/:id —— 详情（含这台设备的全部历史工单）
// ★ 必须留在所有 GET 定值路径（/meta /options /template /export）之后
router.get('/:id', (req, res) => {
  try {
    const t = repo.get(req.params.id);
    if (!t) return res.status(404).json({ code: 404, message: '设备不存在' });
    res.json({ code: 0, data: Object.assign({}, t, { issues: repo.issuesOf(t.id, 200) }) });
  } catch (e) {
    res.status(500).json({ code: 500, message: '读取设备详情失败：' + ((e && e.message) || e) });
  }
});

module.exports = router;
