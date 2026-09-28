'use strict';
/**
 * worker.js —— 采集子进程脚本（阶段 5 的隔离边界）
 *
 * 被 collector.js fork 出来长期驻留，一轮一轮地接收采集任务。
 *
 * 为什么要把 SSH / Redfish / vSphere 采集挪出主进程：
 *   一轮 26 台设备，单台超时上限 30 秒、并发 5，最坏约 8 分钟。这段时间内
 *   inspectOne 大量发起网络连接、等待命令回包、拉起 WmiQuery.exe 子进程。
 *   虽然网络 IO 本身不阻塞事件循环，但
 *     - CPU 占用集中在一份 MIC 报告解析、HTML 报告拼装上，会拖慢同进程里
 *       的合同台账与问题工单接口；
 *     - spawn 出来的 WmiQuery 子进程需要与主循环争抢调度；
 *     - 任何一处采集代码里的同步死循环 / 原生模块崩溃，会连带把 Web 服务拖死。
 *   合并前巡检崩了业务照常；合并后若在同一进程，一次采集事故就是全院业务中断。
 *   隔离出去以后，最坏结果只是大屏显示「采集中止」，业务完好。
 *
 * 边界划分：
 *   主进程负责：读台账、解密口令（KeyVault.exe 走 DPAPI，必须留在主进程且只跑一次）、
 *              写报告、写库、对外 HTTP
 *   本进程负责：连设备、跑命令、解析结果（纯 IO，无状态），结果 JSON 回传
 *
 * 本进程不写文件、不连数据库、不碰 KeyVault —— 拿到手的 servers 凭据已是明文。
 */
const inspect = require('./inspect');

// 子进程里不要再注册吞异常逻辑：宁可崩溃被外层的自愈机制捕获重启，
// 也不要带着半损坏的状态继续产出不可信的巡检数据。
let seq = 0;

/**
 * 采集一批设备。
 * 用 inspect.runWithConcurrency 保证返回顺序与入参顺序一致 ——
 * 调度器依赖这个顺序把台账 ID 回填到结果上，顺序错位会导致状态记到别的设备名下。
 */
async function run(task) {
  const servers = task.servers || [];
  const tasks = servers.map((s) => () =>
    inspect.inspectOne(s, task.timeoutMs).then((r) => inspect.evaluateResult(r, task.thresholds)));
  const results = await inspect.runWithConcurrency(tasks, task.concurrency, (done, total) => {
    process.send({ type: 'progress', roundId: task.roundId, done: done, total: total });
  });
  return results || [];
}

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'run') { await runRound(msg); return; }
  if (msg.type === 'weekly') { await runWeekly(msg); return; }
});

/** 常规巡检轮次 */
async function runRound(msg) {
  const roundId = msg.roundId;
  seq++;
  // 同一批次内由 runWithConcurrency 控制并发；批次之间不叠加 ——
  // 主进程的 collector 本来就不会在上一轮返回前再下发任务，这里是最后一道保险。
  try {
    const t0 = Date.now();
    const results = await run(msg);
    process.send({ type: 'done', roundId: roundId, results: results, durationMs: Date.now() - t0, batch: seq });
  } catch (e) {
    process.send({
      type: 'error', roundId: roundId, batch: seq,
      message: String((e && e.message) || e),
      stack: String((e && e.stack) || '').split('\n').slice(0, 6).join('\n')
    });
  }
}

/**
 * 生成巡检报告（周报 / 手工导出）。
 * 与采集走同一个子进程：报告本身要先采一轮 26 台，耗时同样是分钟级，
 * 放主进程会把 Web 一起拖住。日志逐行回传，管理员在页面上能看到进度。
 */
async function runWeekly(msg) {
  const weekly = require('./weekly');
  seq++;
  const emit = (payload) => {
    try { process.send(payload); } catch (e) { /* 主进程可能已不在 */ }
  };
  try {
    const r = await weekly.generate({
      servers: msg.servers || [],
      global: msg.global || {},
      outDir: msg.outDir || '',
      source: msg.source || 'web',
      log: (line) => emit({ type: 'log', batch: seq, text: String(line) })
    });
    emit({ type: 'weekly-done', roundId: msg.roundId, batch: seq, result: r });
  } catch (e) {
    emit({ type: 'error', roundId: msg.roundId, batch: seq, message: String((e && e.message) || e) });
  }
}

// 告诉主进程我准备好了
process.send({ type: 'ready', pid: process.pid, node: process.version });
