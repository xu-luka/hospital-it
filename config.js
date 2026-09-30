'use strict';
const path = require('path');

const ROOT = __dirname;

module.exports = {
  // ---- 服务 ----
  PORT: process.env.PORT || 3131,
  HOST: process.env.HOST || '0.0.0.0',
  TOKEN_TTL_SEC: 12 * 3600, // token 有效期 12 小时

  // ---- 机房巡检 ----
  // 自动巡检间隔（秒），最小 30 —— 单轮最坏耗时约 8 分钟，调度器会自动顺延
  INSPECTION_INTERVAL_SEC: parseInt(process.env.INSPECTION_INTERVAL_SEC || '60', 10),

  // ---- 目录 ----
  ROOT,
  DATA_DIR: path.join(ROOT, 'data'),
  STATIC_DIR: path.join(ROOT, 'static'),

  // ---- 问题记录库（his）----
  DB_FILE: path.join(ROOT, 'data', 'his.db'),
  UPLOAD_DIR: path.join(ROOT, 'uploads', 'issue'), // 问题附件

  // 巡检历史库：独立于业务库，避免巡检数据（每天数百条快照）把合同/问题库撑大，
  // 也便于单独清理与单独备份保留策略
  // 可用环境变量覆盖，便于离线自测时指向临时库而不污染生产数据
  INSPECT_DB_FILE: process.env.INSPECT_DB_FILE || path.join(ROOT, 'data', 'inspect.db'),
  // 历史快照保留天数，超出的在每轮完成后自动清理。默认 90 天足够看长期趋势
  INSPECT_HISTORY_DAYS: parseInt(process.env.INSPECT_HISTORY_DAYS || '90', 10),

  // ---- 合同库（contract）----
  CONTRACT_DB_FILE: path.join(ROOT, 'data', 'contract.db'),
  CONTRACT_UPLOAD_DIR: path.join(ROOT, 'uploads', 'contract'), // 合同附件

  // ---- 技术文档库（docs）----
  DOCS_DB_FILE: path.join(ROOT, 'data', 'docs.db'),
  DOCS_UPLOAD_DIR: path.join(ROOT, 'uploads', 'docs'), // 技术文档（Word/PDF）
  // 旧版 .doc 的转换产物目录（LibreOffice 转出的 docx），与原始文件分开存放
  DOCS_CONVERT_DIR: path.join(ROOT, 'uploads', 'docs', '.converted'),
  // 可选：LibreOffice 的 soffice(.exe) 路径。留空则自动探测常见安装位置；
  // 装了它，旧版 .doc 可转成 docx 保留排版预览；没装则自动降级为"文本模式"预览。
  DOC_SOFFICE_PATH: process.env.DOC_SOFFICE_PATH || '',
  // 合同到期提醒阈值（天）
  EXPIRE_WARN_DAYS: 30,

  // ---- 认证 ----
  SECRET_FILE: path.join(ROOT, 'data', '.secret'),
  ADMIN_USERNAME: process.env.ADMIN_USERNAME || 'admin',
  // 初始管理员口令：优先取环境变量 ADMIN_PASSWORD；
  // 留空时首次启动由程序随机生成一个并打印在启动日志里
  // （公开仓库不内置固定默认可登录口令，部署前也可自行填入本行）
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',

  // ---- 附件 ----
  MAX_FILE_SIZE: 50 * 1024 * 1024,

  // ---- 操作日志 ----
  // 与流量采样（7 天）、巡检历史（90 天）对齐的做法：给 logs 表一个保留上限，
  // 由 src/logclean.js 启动时 + 每 12 小时自动清理，审计追溯 180 天足够
  LOG_KEEP_DAYS: parseInt(process.env.LOG_KEEP_DAYS || '180', 10),

  // ---- 登录保护 ----
  // 同一用户名连续失败 LOGIN_LOCK_MAX 次，锁定 LOGIN_LOCK_MINUTES 分钟（src/loginlock.js）。
  // 锁定期间连正确密码也不放行，登录成功立即清零
  LOGIN_LOCK_MAX: parseInt(process.env.LOGIN_LOCK_MAX || '5', 10),
  LOGIN_LOCK_MINUTES: parseInt(process.env.LOGIN_LOCK_MINUTES || '10', 10),

  // ---- 问题分类 ----
  CATEGORIES: ['日常软件', '日常硬件', '政策性接口'],
  SUB_MODULES: {
    '日常软件': [
      'HIS系统', 'HIS系统/PACS系统', '自助机/HIS系统', 'LIS系统',
      '门诊医生系统', '门诊医生工作站', '门诊收费系统', '门诊收费系统/PACS系统', '门诊药房系统',
      '住院系统', '住院医生系统', '住院护士系统', '药库系统',
      '职检系统', '体检系统', '手麻系统', '物资系统', '健康通',
      '报卡系统', '报卡更新', '传染病接口', '医保接口',
      '基础数据', '报表系统', '新增报表', '格式调整', '其他',
    ],
    '日常硬件': ['其他'],
    '政策性接口': ['医保接口', '传染病接口', '其他'],
  },
  URGENCY: ['低', '中', '高', '紧急'],
  STATUS: { pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭' },
};