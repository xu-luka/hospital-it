'use strict';
/**
 * netmon.js —— 网络流量监控编排（默认 5 分钟一轮）
 *
 * 与设备巡检（scheduler.js）的关系：各跑各的定时器，互不阻塞。
 *   · 巡检 60 秒一轮，看的是 CPU/内存/可用性，设备多、单轮可能几分钟；
 *   · 流量 300 秒一轮，只看交换机端口速率，设备少（一般几台核心/接入交换机）。
 * 合成一个调度会让慢的那个拖着快的那个，也会让「巡检失败」和「流量采不到」混成同一个故障。
 *
 * 只纳管台账里 os = 'switch' 且启用中的设备 —— 服务器没有端口流量可看，
 * 硬要对 Linux 执行 display interface 只会得到一批连接报错。
 *
 * 关于操作日志：正常轮次**不写**日志。5 分钟一条、一天 288 条会把操作日志冲垮，
 * 管理员根本看不到真正需要处理的记录。只有「判定出突发」才写一条，
 * 内容与巡检台账一致（JSON 字符串），点开即可展开看端口与 IP。
 */

const netflow = require('./netflow');
const store = require('./netstore');
const deviceSource = require('./device-source');
const { logAction } = require('../utils');

const state = {
  started: false,
  running: false,
  timer: null,
  roundNo: 0,
  lastRunAt: null,
  lastError: null,
  lastSummary: null,   // { devices, ok, failed, ports, saved, alerts, cooled }
  interval: 300
};

/** 并发上限：核心交换机也就几台，开太大反而容易把设备的 SSH 连接数打满 */
const CONCURRENCY = 3;

/** 极简并发池：不引第三方依赖，保持与 inspect.runWithConcurrency 一样的语义 */
async function pool(tasks, limit) {
  const out = new Array(tasks.length);
  let i = 0;
  const workers = [];
  const n = Math.max(1, Math.min(limit, tasks.length || 1));
  for (let w = 0; w < n; w++) {
    workers.push((async () => {
      while (i < tasks.length) {
        const idx = i++;
        try { out[idx] = await tasks[idx](); }
        catch (e) { out[idx] = { ok: false, error: String((e && e.message) || e) }; }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

/** 把逐条命令的执行情况压成一行，便于在日志/页面里一眼看出是卡在哪条命令 */
function fmtDiag(diag) {
  if (!Array.isArray(diag) || !diag.length) return '';
  return diag.map((x) => (x.cmd || '?') + '→' + (x.ok ? 'ok' : '超时') + '(' + (x.bytes || 0) + 'B)').join('  ');
}

/**
 * 跑一轮流量采集。
 * @param {object} opt { force, deviceId, timeoutMs }
 */
async function runOnce(opt) {
  const o = opt || {};
  if (state.running) return { ok: false, skipped: true, reason: '上一轮尚未结束' };
  const cfg = store.getConfig();
  if (!cfg.enabled && !o.force) {
    return { ok: false, skipped: true, reason: '流量采集已关闭' };
  }
  state.running = true;
  // 单台 45 秒：display interface 在 48 口交换机上输出上百 KB，给慢了会被超时截断
  const timeoutMs = Math.max(5000, Number(o.timeoutMs) || 45000);
  const at = store.now();
  const summary = {
    at: at, devices: 0, ok: 0, failed: 0, ports: 0,
    saved: 0, alerts: 0, cooled: 0, perDevice: []
  };
  try {
    const src = await deviceSource.load();
    let servers = (src.servers || []).filter((s) => s && s.os === 'switch');
    if (o.deviceId) {
      const id = Number(o.deviceId);
      servers = servers.filter((s) => Number(s._device_id) === id);
    }
    summary.devices = servers.length;
    if (!servers.length) {
      state.lastError = '台账中没有可采集的交换机（需在设备台账里添加类型为「网络交换机」的设备并启用）';
      state.lastSummary = summary;
      state.lastRunAt = at;
      return { ok: true, skipped: true, reason: state.lastError, summary: summary };
    }

    const results = await pool(servers.map((s) => async () => {
      const r = await netflow.collectNetflow(s, { timeoutMs: timeoutMs });
      return { server: s, res: r };
    }), CONCURRENCY);

    const alertsAll = [];
    for (const item of results) {
      const s = item && item.server;
      const r = (item && item.res) || { ok: false, error: '未知错误' };
      const deviceId = Number(s && s._device_id) || 0;
      const deviceName = (s && s.name) || '';
      const host = (s && s.host) || '';
      if (!r.ok) {
        summary.failed++;
        summary.perDevice.push({
          deviceId: deviceId, name: deviceName, host: host, ok: false,
          error: r.error || '未知原因',
          via: r.via || '',
          diag: fmtDiag(r.diag)
        });
        continue;
      }
      summary.ok++;
      summary.ports += r.rows.length;
      const w = store.saveSamples({
        deviceId: deviceId, device: deviceName, host: host, rows: r.rows, at: at, cfg: cfg
      });
      summary.saved += w.saved || 0;
      // 判定必须发生在入库之后：基线要读「本轮之前」的历史样本
      const alerts = store.detectBursts({
        deviceId: deviceId, device: deviceName, host: host, rows: r.rows, cfg: cfg
      });
      if (alerts.length) {
        const sa = store.saveAlerts({ alerts: alerts, at: at, cfg: cfg });
        summary.alerts += sa.saved || 0;
        summary.cooled += sa.cooled || 0;
        alertsAll.push(...alerts.filter((a, i) => i < (sa.saved || 0)));
      }
      summary.perDevice.push({
        deviceId: deviceId, name: deviceName, host: host, ok: true,
        style: r.style, via: r.via || '', ports: r.rows.length, saved: w.saved || 0,
        arp: r.arpCount, mac: r.macCount,
        // 输出被超时截断的，端口数会偏少，标出来免得当成设备只挂了这几个口
        truncated: !!r.truncated,
        note: r.note || ''
      });
    }

    // 失败明细必须落到日志里：控制台上这一行往往是管理员唯一的线索，
    // 只报「0/8 台」等于什么都没说。
    if (summary.failed) {
      console.warn('>>> [流量] ' + summary.failed + '/' + summary.devices + ' 台交换机采集失败：');
      for (const d of summary.perDevice) {
        if (d.ok) continue;
        console.warn('      · ' + ((d.name || '未命名') + ' (' + d.host + ')：') + d.error
          + (d.diag ? '\n        命令明细：' + d.diag : ''));
      }
    }

    // 只在真的判定出突发时写日志 —— 正常轮次不写，否则操作日志会被 5 分钟一条的记录淹没
    if (alertsAll.length) {
      logAction({ id: null, username: '自动任务' }, '流量突发告警', {
        id: null, name: '网络流量监控',
        detail: alertsAll.map((a) => a.detail).join('；'),
        host: alertsAll[0].host || ''
      });
      console.log('>>> [流量] 判定出 ' + alertsAll.length + ' 条突发：'
        + alertsAll.map((a) => (a.ip || a.iface) + ' ' + store.fmtBps(a.peakBps)).join('；'));
    }

    state.roundNo++;
    state.lastRunAt = at;
    // 一台都没采到时把第一条真实原因顶到页面上，别让页面只显示「0/8 台」这种无从下手的数字
    state.lastError = (summary.ok === 0 && summary.failed > 0)
      ? ('全部 ' + summary.failed + ' 台交换机采集失败：' + ((summary.perDevice[0] && summary.perDevice[0].error) || '未知原因'))
      : null;
    state.lastSummary = summary;
    console.log('>>> [流量] 第 ' + state.roundNo + ' 轮完成：' + summary.ok + '/' + summary.devices
      + ' 台交换机，' + summary.ports + ' 个端口，入库 ' + summary.saved
      + ' 条，告警 ' + summary.alerts + ' 条'
      + (summary.failed ? '，失败 ' + summary.failed + ' 台（原因见上方明细）' : ''));
    return { ok: true, summary: summary };
  } catch (e) {
    state.lastError = String((e && e.message) || e);
    console.error('>>> [流量] 本轮采集异常：' + state.lastError);
    return { ok: false, error: state.lastError, summary: summary };
  } finally {
    state.running = false;
  }
}

/* ---------------- 调度 ---------------- */

let stopped = false;

function scheduleNext() {
  if (stopped) return;
  if (state.timer) clearTimeout(state.timer);
  // 每轮都重读间隔，页面上改了立即生效，不必重启服务
  const sec = Math.max(60, Number(store.getConfig().interval_sec) || 300);
  state.interval = sec;
  state.timer = setTimeout(async () => {
    state.timer = null;
    try { await runOnce(); } catch (e) { console.error('>>> [流量] 定时采集异常：' + ((e && e.message) || e)); }
    // 每小时顺带清一次过期采样，避免表无限膨胀
    if (state.roundNo % 12 === 1) {
      const cl = store.cleanup();
      if (cl.ok && cl.deleted) console.log('>>> [流量] 已清理 ' + cl.deleted + ' 条超过 ' + cl.days + ' 天的采样');
    }
    scheduleNext();
  }, sec * 1000);
  if (state.timer.unref) state.timer.unref();
}

async function start() {
  stopped = false;
  if (!store.init()) {
    console.error('>>> [流量] 存储不可用，流量监控未启动：' + (store.stats().error || '未知原因'));
    return { ok: false, message: '流量库不可用' };
  }
  state.started = true;
  const cfg = store.getConfig();
  state.interval = Math.max(60, Number(cfg.interval_sec) || 300);
  console.log('>>> [流量] 监控已启动：每 ' + state.interval + ' 秒一轮'
    + (cfg.enabled ? '' : '（当前配置为关闭，仅支持手动触发）'));
  if (cfg.enabled) {
    // 启动后稍等 20 秒再采第一轮：让巡检首轮与台账装载先跑完，
    // 避免开机动瞬间一堆 SSH 同时握手把交换机连接数占满
    setTimeout(() => { runOnce().catch(() => { }); scheduleNext(); }, 20000).unref?.();
  } else {
    scheduleNext();
  }
  return { ok: true, interval: state.interval, enabled: !!cfg.enabled };
}

function stop() {
  stopped = true;
  state.started = false;
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
}

/** 供接口与大屏使用的运行态 */
function status() {
  const st = store.stats();
  return {
    started: state.started,
    running: state.running,
    round: state.roundNo,
    interval: state.interval,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    lastSummary: state.lastSummary,
    config: store.getConfig(),
    store: st
  };
}

/** 改了采集间隔后立刻重排下一轮，不用等服务重启 */
function reschedule() {
  if (!state.started) return false;
  scheduleNext();
  return true;
}

module.exports = { start, stop, runOnce, reschedule, status, state, store };
