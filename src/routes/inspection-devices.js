'use strict';
/**
 * routes/inspection-devices.js —— 设备台账 REST API（阶段 3）
 *
 * 挂载点 /api/inspection，对外路径：
 *   GET    /api/inspection/devices            台账列表（全体登录用户）
 *   GET    /api/inspection/devices/meta       设备类型字典（前端表单用）
 *   GET    /api/inspection/devices/:id
 *   POST   /api/inspection/devices            新增（管理员）
 *   PUT    /api/inspection/devices/:id        修改（管理员）
 *   DELETE /api/inspection/devices/:id        停用并软删除（管理员）
 *   POST   /api/inspection/devices/:id/toggle 启用/停用（管理员）
 *   POST   /api/inspection/devices/:id/check  单台连通性自检（管理员）
 *   POST   /api/inspection/devices/:id/compare 两条通道并排对比（管理员，只读）
 *   GET    /api/inspection/settings           全局采集参数
 *   PUT    /api/inspection/settings           保存（管理员）
 *   GET    /api/inspection/source             当前数据源模式
 *   POST   /api/inspection/source             切换数据源（管理员，应急回退用）
 *
 * 三条铁的约束：
 *   1. 写操作一律限管理员 —— 台账里存着 26 台设备的登录凭据，
 *      改一台设备的主机地址就等于把它的口令发给别的机器。
 *   2. 响应体里绝不出现口令原文或密文（repo.publicView 已保证），这里不再解包一次。
 *   3. 审计日志只记「谁改了哪台设备的哪些字段」，不记字段值。
 */
const express = require('express');
const { authRequired, guardModule, hasPerm } = require('../auth');
const { logAction } = require('../utils');
const repo = require('../inspection/device-repo');
const secret = require('../inspection/lib/secret');
const inspect = require('../inspection/inspect');
const compare = require('../inspection/compare');
const scheduler = require('../inspection/scheduler');

const router = express.Router();
// 台账查询要 设备台账.查看；增删改、启停用、测试连接、巡检参数与数据源设置要 设备台账.管理
router.use(authRequired, guardModule('devices'));

function isAdmin(u) { return hasPerm(u && u.perms, 'devices.manage'); }
function deny(res) { return res.status(403).json({ code: 403, message: '没有权限执行该操作' }); }
function bad(res, errors) {
  return res.status(400).json({ code: 400, message: '参数校验未通过', errors: errors });
}

/**
 * 台账变更后立即重载调度器。
 *
 * 阶段 2 删掉了 fs.watch 热重载，所以这里是唯一的生效入口 —— 不调它的话，
 * 改完设备要等下一次 /reload 或服务重启才会被采集层看到，
 * 而 applyConfig 里的 pruneResults 也不会跑，停用的设备仍留在大屏上。
 */
function touch() {
  scheduler.reloadConfig().catch((e) => {
    console.error('>>> 台账变更后重载失败（不影响数据已落库）：' + ((e && e.message) || e));
  });
}

/** 审计明细里剔除凭据相关字段，只留字段名，避免明文口令进日志 */
function changeDetail(payload) {
  const safe = {};
  if (!payload || typeof payload !== 'object') return safe;
  for (const k of Object.keys(payload)) {
    if (k === 'auth_password' || k === 'auth_passphrase') { safe[k] = '（已设置）'; continue; }
    if (typeof payload[k] === 'object') { safe[k] = '（对象）'; continue; }
    safe[k] = payload[k];
  }
  return safe;
}

/* ---------------- 字典 ---------------- */

// 放在 /:id 之前，否则会被当成 id=meta
router.get('/devices/meta', authRequired, (req, res) => {
  res.json({
    code: 0,
    data: {
      osTypes: repo.OS_TYPES.map((k) => ({ value: k, label: repo.OS_LABELS[k] || k })),
      authTypes: {
        linux: ['password', 'key'],
        // exporter = 目标机装 windows_exporter，走只读 HTTP 拉 /metrics。
        // 不依赖 sshd / 密码 / DCOM，是去 SSH 化时最省事的一条通道。
        // 注意：windows_exporter 0.30+ 只支持 Server 2016 及以上（2008R2/2012R2 用 wmi）。
        windows: ['password', 'wmi', 'key', 'exporter', 'local'],
        bmc: ['bmc'],
        switch: ['password'],
        database: ['password'],
        esxi: ['password']
      },
      dbEngines: ['mssql', 'oracle'],
      protocols: ['https', 'http']
    }
  });
});

/* ---------------- 列表与详情 ---------------- */

router.get('/devices', authRequired, (req, res) => {
  // 台账页顶部过滤控件：kw（名称/地址/备注/位置模糊）、os（类型精确）、enabled（'1'/'0'）。
  // 前端 load() 会把这三个参数拼进 query；此前这里从未读取，导致过滤器形同虚设。
  const items = repo.listDevices({
    includeDeleted: false,
    kw: req.query.kw,
    os: req.query.os,
    enabled: req.query.enabled
  });
  res.json({ code: 0, data: { items, total: items.length, stats: repo.stats() } });
});

router.get('/devices/:id', authRequired, (req, res) => {
  const d = repo.getDevice(Number(req.params.id));
  if (!d) return res.status(404).json({ code: 404, message: '设备不存在' });
  res.json({ code: 0, data: d });
});

/* ---------------- 新增 ---------------- */

router.post('/devices', authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  let r;
  try {
    r = await repo.createDevice(req.body || {}, req.user.id);
  } catch (e) {
    console.error('>>> 新增设备异常：' + ((e && e.stack) || e));
    return res.status(500).json({ code: 500, message: '新增失败：' + ((e && e.message) || e) });
  }
  if (!r.ok) return bad(res, r.errors);
  logAction(req.user, '台账.新增设备', { id: r.id, name: r.device.name, detail: changeDetail(req.body) }, req.ip);
  touch();
  res.json({ code: 0, message: '设备已新增，已纳入巡检', data: r.device });
});

/* ---------------- 修改 ---------------- */

router.put('/devices/:id', authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const id = Number(req.params.id);
  if (!repo.getRow(id)) return res.status(404).json({ code: 404, message: '设备不存在' });
  let r;
  try {
    r = await repo.updateDevice(id, req.body || {}, req.user.id);
  } catch (e) {
    console.error('>>> 修改设备异常：' + ((e && e.stack) || e));
    return res.status(500).json({ code: 500, message: '保存失败：' + ((e && e.message) || e) });
  }
  if (!r.ok) return bad(res, r.errors);
  logAction(req.user, '台账.修改设备', { id: id, name: r.device.name, detail: changeDetail(req.body) }, req.ip);
  touch();
  res.json({ code: 0, message: '已保存，下一轮巡检生效', data: r.device });
});

/* ---------------- 删除 / 启停 ---------------- */

router.delete('/devices/:id', authRequired, (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const id = Number(req.params.id);
  const row = repo.getRow(id);
  if (!row) return res.status(404).json({ code: 404, message: '设备不存在' });
  repo.deleteDevice(id);
  logAction(req.user, '台账.删除设备', { id: id, name: row.name, host: row.host }, req.ip);
  touch();
  res.json({ code: 0, message: '设备已停用并移出台账' });
});

router.post('/devices/:id/toggle', authRequired, (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const id = Number(req.params.id);
  const row = repo.getRow(id);
  if (!row) return res.status(404).json({ code: 404, message: '设备不存在' });
  const want = req.body && (req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1');
  repo.setEnabled(id, want);
  logAction(req.user, want ? '台账.启用设备' : '台账.停用设备', { id: id, name: row.name }, req.ip);
  touch();
  res.json({ code: 0, message: want ? '已纳入巡检' : '已暂停巡检，大屏不再显示' });
});

/* ---------------- 单台连通性自检 ---------------- */

/**
 * 改完凭据立刻验证通不通，是台账最有价值的一个按钮 ——
 * 否则配置写错了要等到下一轮巡检结束（最坏 8 分钟）才发现。
 *
 * 只跑一台设备，网络等待为主，对事件循环影响可控；再套一层 race 保证一定会有响应。
 */
router.post('/devices/:id/check', authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const id = Number(req.params.id);
  const row = repo.getRow(id);
  if (!row) return res.status(404).json({ code: 404, message: '设备不存在' });

  const t0 = Date.now();
  const timeoutMs = scheduler.state.timeoutMs || 30000;
  try {
    const server = Object.assign(repo.toServer(row), {});
    const kr = await secret.loadMasterKeyAsync();
    let target = server;
    if (kr.ok) {
      const d = secret.decryptServer(server, kr.key);
      target = d.server;
    } else if (String((server.auth || {}).password || '').indexOf('enc:v1:') === 0) {
      return res.json({ code: 400, message: '主密钥不可用，无法解开该设备口令：' + kr.error });
    }

    const work = inspect.inspectOne(target, timeoutMs)
      .then((r) => inspect.evaluateResult(r, scheduler.state.thresholds || inspect.DEFAULT_THRESHOLDS));
    const guard = new Promise((_r, rej) =>
      setTimeout(() => rej(new Error('自检超时（上限 ' + Math.round(timeoutMs / 1000) + ' 秒）')), timeoutMs + 8000));
    const r = await Promise.race([work, guard]);

    logAction(req.user, '台账.设备自检', { id: id, name: row.name, ok: !!r.ok }, req.ip);
    res.json({
      code: 0,
      message: r.ok ? '连接正常' : '连接失败',
      data: {
        id: id, name: row.name, host: row.host, os: row.os,
        ok: !!r.ok, status: r.ok ? r.status : 'error',
        error: r.error || (r.reasons || []).join('；') || null,
        cpu: r.metrics ? r.metrics.cpu_percent : null,
        mem: r.metrics ? r.metrics.mem_percent : null,
        hostname: r.metrics ? r.metrics.hostname : null,
        durationMs: Date.now() - t0
      }
    });
  } catch (e) {
    res.json({
      code: 0,
      message: '自检失败',
      data: { id: id, name: row.name, ok: false, status: 'error', error: String((e && e.message) || e), durationMs: Date.now() - t0 }
    });
  }
});

/* ---------------- 通道对比 ---------------- */

/** 可参与对比的通道（local 除外：本机采集只对巡检服务器自己有意义） */
const CMP_CHANNELS = ['exporter', 'password', 'key', 'wmi'];

function cmpLabel(t) { return compare.channelLabelOf(String(t || '')); }

/**
 * 同一台设备、两条通道，各采一次，把数字并排摆出来。
 *
 * 存在的理由：把采集从 SSH 切到 exporter 之前，得先证明「新通道的数字跟老通道一样」。
 * 没有这一步，切换就是赌 —— 切完发现少一个盘、服务全判成没在跑，
 * 要等下一轮巡检（最坏 8 分钟）才暴露，而且多半会被当成「巡检系统坏了」。
 *
 * 四条约束：
 *   1. 只读：不写台账、不改设备配置、不写 last_status。对比失败不影响巡检结果。
 *   2. 对比通道的凭据是「临时」的：请求体传入，用完即弃，不落库、不进审计日志。
 *      这样即使设备当前配的是 exporter，也能临时用 SSH 账号反向核对一次。
 *   3. 两侧并行采集，各自独立超时兜底 —— 一侧卡住不能把另一侧的结果也拖没。
 *   4. 只支持 Windows：Linux / 交换机 / 数据库只有一条采集通道，没有可对比的对象。
 */
router.post('/devices/:id/compare', authRequired, async (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const id = Number(req.params.id);
  const row = repo.getRow(id);
  if (!row) return res.status(404).json({ code: 404, message: '设备不存在' });

  if (String(row.os) !== 'windows') {
    return res.status(400).json({
      code: 400,
      message: '通道对比只支持 Windows 设备（Linux / 交换机 / 数据库只有一条采集通道，没有可对比的对象）'
    });
  }

  const body = req.body || {};
  const curType = String(row.auth_type || '');
  const otherType = String(body.channel || (curType === 'exporter' ? '' : 'exporter')).toLowerCase();

  if (!otherType) {
    return res.status(400).json({ code: 400, message: '当前设备已配成 exporter，请选择要对比的通道（如 SSH 密码）' });
  }
  if (otherType === curType) {
    return res.status(400).json({ code: 400, message: '两侧通道相同，没有可对比的内容' });
  }
  if (CMP_CHANNELS.indexOf(otherType) < 0) {
    return res.status(400).json({ code: 400, message: '对比通道只能是 exporter、SSH 密码、SSH 私钥或 WMI' });
  }

  const tmpUser = String(body.username || '').trim();
  const tmpPass = String(body.password || '');
  if (otherType !== 'exporter') {
    if (!tmpUser) {
      return res.status(400).json({
        code: 400,
        message: '对比 ' + cmpLabel(otherType) + ' 通道需要临时输入登录账号（只用于本次对比，不会保存）'
      });
    }
    if (otherType === 'key' && !String(body.private_key_path || '').trim()) {
      return res.status(400).json({ code: 400, message: '对比 SSH 私钥通道需要填写私钥文件路径' });
    }
  }

  const t0 = Date.now();
  const timeoutMs = Math.min(60000, Math.max(5000, Number(body.timeout_ms) || scheduler.state.timeoutMs || 30000));

  try {
    /* 当前通道：用台账里存的凭据（口径与自检完全一致） */
    const base = repo.toServer(row);
    const kr = await secret.loadMasterKeyAsync();
    let cur = base;
    if (kr.ok) {
      cur = secret.decryptServer(base, kr.key).server;
    } else if (String((base.auth || {}).password || '').indexOf('enc:v1:') === 0) {
      return res.status(400).json({ code: 400, message: '主密钥不可用，无法解开该设备口令：' + kr.error });
    }

    /* 对比通道：临时构造，不落库 */
    const other = {
      name: base.name,
      host: base.host,
      os: 'windows',
      auth: { type: otherType },
      // 服务检查清单沿用台账里那一份 —— 否则两侧服务集合不同，比对没有意义
      services: base.services || [],
      custom_commands: []
    };

    if (otherType === 'exporter') {
      other.port = Number(body.port) || 9182;
      other.protocol = String(body.protocol || 'http').toLowerCase() === 'https' ? 'https' : 'http';
      if (tmpUser) { other.auth.username = tmpUser; other.auth.password = tmpPass; }
    } else if (otherType === 'wmi') {
      other.auth.username = tmpUser;
      other.auth.password = tmpPass;
    } else {
      other.auth.username = tmpUser;
      other.auth.password = tmpPass;
      if (otherType === 'key') {
        other.auth.private_key_path = String(body.private_key_path || '').trim();
        if (body.passphrase) other.auth.passphrase = String(body.passphrase);
      }
      // 当前是 exporter 时台账里的端口是 9182，不能拿来当 SSH 端口
      other.port = Number(body.port) || (curType === 'exporter' ? 22 : (Number(base.port) || 22));
    }

    /** 采一侧：独立超时，永不 reject（失败也返回 ok:false，好让另一侧的结论还能看） */
    const run = async (server) => {
      const s = Date.now();
      let timer = null;
      try {
        const work = inspect.inspectOne(server, timeoutMs)
          .then((r) => inspect.evaluateResult(r, scheduler.state.thresholds || inspect.DEFAULT_THRESHOLDS));
        const guard = new Promise((_r, rej) => {
          timer = setTimeout(
            () => rej(new Error('采集超时（上限 ' + Math.round((timeoutMs + 8000) / 1000) + ' 秒）')),
            timeoutMs + 8000);
        });
        const r = await Promise.race([work, guard]);
        r.ms = Date.now() - s;
        return r;
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e), ms: Date.now() - s, metrics: null, services: [] };
      } finally {
        // 不 clear 的话，这个定时器会把进程多留几十秒（也拖慢测试进程退出）
        if (timer) clearTimeout(timer);
      }
    };

    const [rl, rr] = await Promise.all([run(cur), run(other)]);
    const d = compare.diffOf(rl, rr, { leftLabel: cmpLabel(curType), rightLabel: cmpLabel(otherType) });

    const brief = (r, type) => ({
      channel: type,
      label: cmpLabel(type),
      ok: !!r.ok,
      status: r.ok ? (r.status || 'normal') : 'error',
      error: r.ok ? null : (r.error || '采集失败'),
      note: r.note || null,
      ms: r.ms || 0,
      hostname: r.metrics ? r.metrics.hostname : null,
      cpu: r.metrics ? r.metrics.cpu_percent : null,
      mem: r.metrics ? r.metrics.mem_percent : null
    });

    logAction(req.user, '台账.通道对比', {
      id: id, name: row.name, left: curType, right: otherType,
      verdict: d.verdict, diff: d.counts.diff
    }, req.ip);

    res.json({
      code: 0,
      message: '对比完成',
      data: {
        id: id,
        name: row.name,
        host: row.host,
        left: brief(rl, curType),
        right: brief(rr, otherType),
        diff: { verdict: d.verdict, counts: d.counts, rows: d.rows, tips: d.tips },
        durationMs: Date.now() - t0
      }
    });
  } catch (e) {
    res.status(500).json({ code: 500, message: '对比失败：' + String((e && e.message) || e) });
  }
});

/* ---------------- 全局设置 ---------------- */

router.get('/settings', authRequired, (req, res) => {
  res.json({ code: 0, data: repo.getSettings() });
});

router.put('/settings', authRequired, (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const p = req.body || {};
  const nConc = parseInt(p.concurrency, 10);
  const nTimeout = parseInt(p.timeout_ms, 10);
  const errors = [];
  if (p.concurrency !== undefined && (!Number.isFinite(nConc) || nConc < 1 || nConc > 32)) errors.push('并发数需在 1-32 之间');
  if (p.timeout_ms !== undefined && (!Number.isFinite(nTimeout) || nTimeout < 10000 || nTimeout > 600000)) errors.push('超时需在 10-600000 毫秒之间');
  if (errors.length) return bad(res, errors);

  const st = repo.saveSettings(p, req.user.id);
  // 改完立即生效，不必等下一轮
  touch();
  logAction(req.user, '台账.修改巡检参数', changeDetail(p), req.ip);
  res.json({ code: 0, message: '参数已保存并生效', data: st });
});

/* ---------------- 数据源模式 ---------------- */

router.get('/source', authRequired, (req, res) => {
  const st = repo.stats();
  res.json({
    code: 0,
    data: {
      mode: scheduler.state.sourceMode || 'json',
      want: String(process.env.INSPECTION_SOURCE || '').toLowerCase() || 'auto',
      dbReady: repo.dbModeReady(),
      devices: st.total,
      enabled: st.enabled,
      encrypted: st.encrypted,
      plaintext: st.plaintext,
      keyAvailable: !scheduler.state.keyError,
      keyError: scheduler.state.keyError
    }
  });
});

router.post('/source', authRequired, (req, res) => {
  if (!isAdmin(req.user)) return deny(res);
  const mode = String((req.body || {}).mode || '').toLowerCase();
  if (mode !== 'db' && mode !== 'json') return bad(res, ["mode 只能是 'db' 或 'json'"]);
  const v = repo.setDbMode(mode === 'db');
  // 切换后立刻重载，让 sourceMode 反映新状态
  touch();
  logAction(req.user, '台账.切换数据源', { mode: mode, config_version: v }, req.ip);
  res.json({
    code: 0,
    message: mode === 'db' ? '已切到设备台账' : '已切回配置文件模式',
    data: { mode, config_version: v }
  });
});

module.exports = router;
