'use strict';
/**
 * routes/inspection-extra.js —— 巡检的历史趋势与报告生成任务（阶段 4b / 5b）
 *
 * 单独成一个文件：inspection.js 承载的是状态查询这类瞬时请求，
 * 这里放的是「要靠子进程跑几分钟」的重任务，生命周期模型完全不同。
 */
const express = require('express');
const { authRequired } = require('../auth');
const scheduler = require('../inspection/scheduler');
const collector = scheduler.collector;
const history = scheduler.history;
const { logAction } = require('../utils');

const router = express.Router();

/** 写操作：1 管理员 / 2 工程师 */
function canOperate(u) { return u && (u.role_id === 1 || u.role_id === 2); }

/* ---------------- 历史趋势 ---------------- */

/** 单台设备的趋势序列：GET /api/inspection/trend?deviceId=1&limit=200 */
router.get('/trend', authRequired, (req, res) => {
  const id = Number(req.query.deviceId || 0);
  if (!id) return res.status(400).json({ code: 400, message: '缺少 deviceId' });
  if (!history.available()) {
    return res.json({ code: 0, data: { ready: false, items: [], message: '巡检历史库不可用' } });
  }
  res.json({
    code: 0,
    data: { ready: true, items: history.trend(id, Number(req.query.limit || 200)) }
  });
});

/** 各设备可用率（默认近 7 天）：GET /api/inspection/availability?days=7 */
router.get('/availability', authRequired, (req, res) => {
  if (!history.available()) {
    return res.json({ code: 0, data: { ready: false, items: [] } });
  }
  res.json({
    code: 0,
    data: {
      ready: true,
      days: Number(req.query.days || 7),
      items: history.availability(Number(req.query.days || 7))
    }
  });
});

/** 最近若干轮汇总：GET /api/inspection/rounds?limit=50 */
router.get('/rounds', authRequired, (req, res) => {
  if (!history.available()) return res.json({ code: 0, data: { ready: false, items: [] } });
  res.json({
    code: 0,
    data: { ready: true, items: history.recentRounds(Number(req.query.limit || 50)) }
  });
});

/* ---------------- 报告生成任务 ---------------- */

/**
 * 报告生成要重新采一遍 26 台设备，耗时以分钟计，绝不能让 HTTP 请求挂在那儿等。
 * 这里做成「提交 → 拿任务号 → 轮询」的模型。
 *
 * 任务状态存在进程内存里，够用：重启服务时没有用户正在等待生成报告的情况下重来的成本很低，
 * 而落库会带来一套永不过期的脏数据表。
 */
const tasks = new Map();
let taskSeq = 0;
// 任务记录保留 30 分钟，之后自动丢弃，避免长期堆积
const TASK_TTL_MS = 30 * 60 * 1000;
// 每个任务最多累积多少行日志（防止子进程日志刷爆内存）
const MAX_LOG_LINES = 500;

function sweepTasks() {
  const now = Date.now();
  for (const [id, t] of tasks) {
    if (t.doneAt && now - t.doneAt > TASK_TTL_MS) tasks.delete(id);
  }
}

/** 提交一次报告生成：POST /api/inspection/reports/generate */
router.post('/reports/generate', authRequired, async (req, res) => {
  if (!canOperate(req.user)) return res.status(403).json({ code: 403, message: '没有权限执行该操作' });
  const cfg = scheduler.state.cfg;
  if (!cfg || !(cfg.servers || []).length) {
    return res.status(400).json({ code: 400, message: '当前没有可巡检的设备' });
  }
  if (!collector.state.enabled) {
    // 禁用了子进程时，生成报告会在主进程里跑几分钟并阻塞所有人的请求 —— 直接拒绝，
    // 让管理员改用命令行执行，而不是悄悄拖垮整个系统。
    return res.status(409).json({
      code: 409,
      message: '未启用采集子进程，无法在 Web 端生成报告。请改用命令行 weekly-cli.js。'
    });
  }
  if (!collector.available()) {
    return res.status(503).json({
      code: 503,
      message: '采集子进程当前不可用：' + (collector.state.lastError || '尚未就绪')
    });
  }

  const id = 'r' + (++taskSeq) + '_' + Date.now();
  const task = {
    id: id, status: 'running', logs: [], result: null,
    startedAt: new Date().toISOString(), doneAt: null,
    by: (req.user && req.user.username) || ''
  };
  tasks.set(id, task);

  // 不 await —— 立即返回任务号，由前端轮询进度
  (async () => {
    try {
      const r = await collector.generateReport({
        servers: cfg.servers, global: cfg.global || {},
        outDir: scheduler.state.reportsDir, source: 'web'
      }, (line) => {
        if (task.logs.length < MAX_LOG_LINES) task.logs.push(line);
      });
      task.result = r;
      task.status = r && r.ok ? 'done' : 'failed';
    } catch (e) {
      task.result = { ok: false, error: String((e && e.message) || e) };
      task.status = 'failed';
    } finally {
      task.doneAt = Date.now();
      logAction(req.user, '报告.生成', {
        taskId: id,
        status: task.status,
        file: (task.result && task.result.file) || '',
        error: (task.result && task.result.error) || ''
      }, req.ip);
    }
  })();

  res.json({ code: 0, message: '报告生成任务已提交', data: { taskId: id } });
});

/** 查询任务进度：GET /api/inspection/reports/task/:id */
router.get('/reports/task/:id', authRequired, (req, res) => {
  const t = tasks.get(String(req.params.id || ''));
  if (!t) return res.status(404).json({ code: 404, message: '任务不存在或已过期' });
  res.json({
    code: 0,
    data: {
      id: t.id, status: t.status, result: t.result,
      logs: t.logs, startedAt: t.startedAt,
      // 只推增量：前端记住已读行数，避免每轮重复渲染历史日志
      total: t.logs.length
    }
  });
});

sweepTasks();
setInterval(sweepTasks, 5 * 60 * 1000).unref();

module.exports = router;
