'use strict';
/**
 * 医院信息科一体化管理系统 —— 统一入口
 * 合同台账 + 问题工单 + 机房设备巡检，单进程单端口。
 */
const express = require('express');
const path = require('path');
const config = require('./config');
const issueDb = require('./src/db'); // 问题库（懒初始化）
require('./src/db-contract');         // 合同库（立即初始化，含统一账号体系）
const { getSecret } = require('./src/auth');
const { applyHeaders } = require('./src/middleware/security');

const app = express();
app.disable('x-powered-by');

// 安全响应头与 CSP（继承自巡检系统，原业务系统此前完全没有下发）
app.use(applyHeaders);

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ================= API 路由 =================
// 统一账号体系
app.use('/api/auth', require('./src/routes/auth'));
app.use('/api/users', require('./src/routes/users'));
app.use('/api/roles', require('./src/routes/roles'));
// 合同业务
app.use('/api/contracts', require('./src/routes/contracts'));
app.use('/api/payments', require('./src/routes/payments'));
app.use('/api/files', require('./src/routes/files'));
app.use('/api/docs', require('./src/routes/docs'));
app.use('/api/excel', require('./src/routes/excel'));
app.use('/api/logs', require('./src/routes/logs'));
app.use('/api/dashboard/contracts', require('./src/routes/dashboard-contracts'));
// 问题记录业务
app.use('/api/issues', require('./src/routes/issues'));
app.use('/api/dashboard/issues', require('./src/routes/dashboard-issues'));
// 问题记录 Excel 导入导出
app.use('/api/excel-issues', require('./src/routes/excel-issues'));
// 机房设备巡检（大屏 / 报告 / 触发 / 重载）
const inspectionAvailable = mountInspection(app);

// 静态资源 + SPA 回退
app.use(express.static(config.STATIC_DIR));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(config.STATIC_DIR, 'index.html')));

// 统一错误处理
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ code: 400, message: '附件超过大小限制（最大 50MB）' });
  }
  if (err && err.message && /Unexpected token|multer/i.test(err.message)) {
    return res.status(400).json({ code: 400, message: '请求参数错误：' + err.message });
  }
  console.error('[error]', err);
  res.status(500).json({ code: 500, message: '服务器内部错误：' + (err && err.message ? err.message : '未知错误') });
});

/**
 * 挂载巡检模块。
 *
 * 设计原则：巡检不可用时，业务系统必须照常可用。
 *   合并的目的之一是减少运维复杂度，但代价是故障域扩大了 —— 原本巡检挂了
 *   不影响合同台账。这里用「装载失败即降级」来抵消这个代价：
 *   依赖缺失、配置文件不存在、外部资产缺失都不会导致整个服务起不来，
 *   只在日志里说明原因，前端大屏显示「巡检暂不可用」。
 */
function mountInspection(app) {
  try {
    const scheduler = require('./src/inspection/scheduler');
    const deviceSource = require('./src/inspection/device-source');
    const deviceRepo = require('./src/inspection/device-repo');
    const paths = require('./src/inspection/paths');

    // 阶段 3：数据源改为「台账优先、配置文件兜底」
    scheduler.setDeviceSource(deviceSource.load);
    app.use('/api/inspection', require('./src/routes/inspection'));
    app.use('/api/inspection', require('./src/routes/inspection-devices'));
    app.use('/api/inspection', require('./src/routes/inspection-extra'));
    // 网络流量监控（端口级，复用 SSH，不引入 SNMP）
    app.use('/api/inspection', require('./src/routes/inspection-netflow'));

    // 每轮结束后把结果回写到台账的 last_status，台账页才能显示每台的上次结果
    scheduler.setOnRoundDone(async (ctx) => {
      try { deviceRepo.updateLastStatus(ctx.results || []); }
      catch (e) { console.error('>>> 回写设备状态失败：' + ((e && e.message) || e)); }
    });

    // 全新部署自愈 + 资产审计。
    // 主密钥经 DPAPI(LocalMachine) 封装，无法随包分发，只能在目标机器上现场生成；
    // 必须等生成完成再做审计，否则启动日志会误报「主密钥文件缺失」。
    // 注意：这里只能用异步 execFile —— 实测对该 exe 用 execFileSync 会稳定报 EBUSY。
    const secret = require('./src/inspection/lib/secret');
    const keyFile = secret.keyFilePath();
    const keyExisted = require('fs').existsSync(keyFile);

    secret.ensureKeyFileAsync().then((ok) => {
      if (ok && !keyExisted) console.log('>>> 已为本机生成主密钥：' + keyFile);
      // 外部资产缺失要在启动阶段就暴露，而不是等到巡检失败才让人猜
      const audit = paths.audit();
      if (!audit.ok) {
        console.warn('[警告] 巡检外部资产缺失，相关设备会巡检失败：');
        audit.missing.forEach((m) => console.warn('        - ' + m.label + ' → ' + m.path));
      }
    });
    global.__scheduler = scheduler;
    return true;
  } catch (e) {
    console.error('[警告] 巡检模块装载失败，业务功能不受影响：' + ((e && e.message) || e));
    return false;
  }
}

/**
 * 进程级异常兜底。
 *
 * 这里替代了原 inspect.js 顶层的 process.on —— 那个 handler 会无条件吞掉所有异常，
 * 作为独立 CLI 尚可接受，但被 Express require 后会把 Web 服务的致命错误也一并掩盖。
 * 改为记录 + 计数 + 超阈值主动退出（交给计划任务自动重启），绝不静默。
 */
const errWindow = [];
function noteFatal(kind, err) {
  const msg = String((err && (err.stack || err.message)) || err);
  console.error('[' + kind + '] ' + msg);
  const now = Date.now();
  errWindow.push(now);
  while (errWindow.length && now - errWindow[0] > 5 * 60 * 1000) errWindow.shift();
  if (errWindow.length >= 5) {
    console.error('[致命] 5 分钟内累计 ' + errWindow.length + ' 次未处理异常，主动退出交由外部重启');
    process.exit(1);
  }
}
process.on('uncaughtException', (e) => noteFatal('uncaughtException', e));
process.on('unhandledRejection', (e) => noteFatal('unhandledRejection', e));

function sourceLabel(mode) {
  return mode === 'db' ? '设备台账（it_devices）' : '配置文件（data/inspection.json）';
}

issueDb.init();
getSecret();

const server = app.listen(config.PORT, config.HOST, () => {
  const addr = server.address();
  console.log('==============================================');
  console.log('  医院信息科一体化管理系统 已启动');
  console.log('  本机访问:   http://127.0.0.1:' + addr.port);
  console.log('  局域网访问: http://<本机IP>:' + addr.port);
  console.log('  业务模块:   合同台账 + 问题工单');
  console.log('  巡检模块:   ' + (inspectionAvailable ? '已挂载' : '不可用（见上方警告）'));
  console.log('  巡检数据源: ' + (inspectionAvailable
    ? sourceLabel(require('./src/inspection/device-source').currentMode()) : '-'));
  console.log('  数据目录:   data/（合同库 + 问题库 + 密钥 + 巡检报告）');
  console.log('  附件目录:   uploads/（contract + issue）');
  console.log('==============================================');

  // 监听成功后再启动巡检调度：先保证 Web 可用，巡检失败不影响对外服务
  if (inspectionAvailable) {
    const scheduler = global.__scheduler;
    scheduler.start({ interval: config.INSPECTION_INTERVAL_SEC })
      .catch((e) => console.error('>>> 巡检调度启动失败（业务不受影响）：' + ((e && e.message) || e)));
    // 流量监控独立调度（默认 5 分钟一轮，只看交换机端口）
    try {
      require('./src/inspection/netmon').start()
        .catch((e) => console.error('>>> 流量监控启动失败（业务不受影响）：' + ((e && e.message) || e)));
    } catch (e) {
      console.error('>>> 流量监控装载失败（业务不受影响）：' + ((e && e.message) || e));
    }
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error('[错误] 端口 ' + config.PORT + ' 被占用，请用 PORT 环境变量换端口或关闭占用程序');
    process.exit(1);
  }
  console.error('[错误] 服务异常：' + ((e && e.message) || e));
});

/**
 * 优雅退出：先停巡检调度（避免采集中途被杀留下半截状态），再关 HTTP。
 * SIGTERM 是 Windows 服务/任务停止时的常用信号，必须处理。
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('\n>>> 收到 ' + signal + '，正在停止...');
  if (inspectionAvailable && global.__scheduler) {
    Promise.resolve(global.__scheduler.stop()).catch(() => { });
    try { require('./src/inspection/netmon').stop(); } catch (e) { /* 未装载则忽略 */ }
  }
  server.close(() => { console.log('>>> 已停止'); process.exit(0); });
  // 兜底：若 5 秒内没能正常关闭（如还有请求挂着），强制退出
  setTimeout(() => { console.log('>>> 强制退出'); process.exit(0); }, 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));