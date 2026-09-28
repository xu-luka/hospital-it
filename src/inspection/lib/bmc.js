'use strict';
/**
 * 管理口（BMC）硬件巡检模块：通过 Redfish 标准接口采集硬件健康
 * 兼容自签名证书；会话认证失败时回退 Basic 认证
 * 采集内容：电源状态、温度、风扇、电源模块、内存/CPU 概要、磁盘硬件状态、硬件事件日志
 */

const https = require('https');
const http = require('http');

function req(options, body) {
  return new Promise((resolve, reject) => {
    const lib = options.protocol === 'http:' ? http : https;
    const r = lib.request(options, (res) => {
      let data = '';
      res.on('data', (c) => {
        data += c;
        if (data.length > 2000000) data = data.slice(0, 2000000);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    r.setTimeout(options.timeout || 20000, () => { r.destroy(new Error('请求超时')); });
    if (body) r.write(body);
    r.end();
  });
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

class RedfishClient {
  constructor(server, timeoutMs) {
    const auth = server.auth || {};
    this.host = server.host;
    this.port = server.port || 443;
    this.protocol = server.protocol === 'http' ? 'http:' : 'https:';
    this.user = auth.username || '';
    this.pass = auth.password || '';
    this.timeout = timeoutMs;
    this.token = null;
    this.useBasic = false;
    this.sessionLoc = null;
  }

  _options(method, path, body) {
    const headers = { 'Content-Type': 'application/json', 'Accept': 'application/json' };
    if (this.token) headers['X-Auth-Token'] = this.token;
    else if (this.useBasic) {
      headers['Authorization'] = 'Basic ' + Buffer.from(this.user + ':' + this.pass).toString('base64');
    }
    return {
      protocol: this.protocol,
      host: this.host,
      port: this.port,
      method: method,
      path: path,
      headers: headers,
      timeout: this.timeout,
      rejectUnauthorized: false // BMC 普遍使用自签名证书
    };
  }

  async request(method, path, bodyObj) {
    const body = bodyObj ? JSON.stringify(bodyObj) : null;
    const res = await req(this._options(method, path, body), body);
    return res;
  }

  async get(path) {
    const res = await this.request('GET', path);
    if (res.status === 401) throw new Error('管理口认证失败（401），请检查 BMC 账号密码');
    if (res.status >= 400) throw new Error('管理口返回错误 ' + res.status + '：' + path);
    const data = parseJson(res.body);
    if (!data) throw new Error('管理口返回内容无法解析：' + path);
    return data;
  }

  async connect() {
    // 优先会话认证
    try {
      const res = await this.request('POST', '/redfish/v1/SessionService/Sessions', {
        UserName: this.user, Password: this.pass
      });
      if (res.status >= 200 && res.status < 300) {
        this.token = res.headers['x-auth-token'] || null;
        this.sessionLoc = res.headers['location'] || null;
        if (this.token) return;
      }
      if (res.status === 401) throw new Error('管理口认证失败（401），请检查 BMC 账号密码');
    } catch (e) {
      if (/认证失败/.test(e.message)) throw e;
      // 会话服务不可用 → 回退 Basic
    }
    this.useBasic = true;
    // 验证 Basic 认证可用
    await this.get('/redfish/v1/');
  }

  async close() {
    if (this.token && this.sessionLoc) {
      try {
        const p = this.sessionLoc.replace(/^https?:\/\/[^/]+/, '');
        await this.request('DELETE', p);
      } catch (e) { /* 忽略 */ }
    }
  }

  async firstMember(collPath) {
    try {
      const coll = await this.get(collPath);
      if (coll.Members && coll.Members.length > 0 && coll.Members[0]['@odata.id']) {
        return coll.Members[0]['@odata.id'];
      }
    } catch (e) { /* 集合不存在 */ }
    return null;
  }

  async getAllMembers(collPath) {
    const paths = [];
    try {
      const coll = await this.get(collPath);
      for (const m of coll.Members || []) if (m['@odata.id']) paths.push(m['@odata.id']);
    } catch (e) { /* 集合不存在 */ }
    return paths;
  }
}

function healthOf(obj) {
  if (!obj) return null;
  const st = obj.Status || {};
  return st.Health || null;
}

const WARN_HEALTH = ['Warning', 'Degraded', 'PreFail', 'Minor'];
const CRIT_HEALTH = ['Critical', 'Fatal', 'Major', 'Unrecoverable'];

function levelOfHealth(h) {
  if (!h) return 'normal';
  if (CRIT_HEALTH.indexOf(h) >= 0) return 'critical';
  if (WARN_HEALTH.indexOf(h) >= 0) return 'warning';
  return 'normal';
}

async function collectBmc(server, timeoutMs) {
  const c = new RedfishClient(server, timeoutMs);
  try {
    await c.connect();

    // 系统信息
    const sysPath = await c.firstMember('/redfish/v1/Systems');
    if (!sysPath) throw new Error('管理口未暴露 Systems 资源，可能不支持标准 Redfish');
    const sys = await c.get(sysPath);

    const hw = {
      power: sys.PowerState || null,
      manufacturer: sys.Manufacturer || '',
      model: sys.Model || '',
      bios: sys.BiosVersion || '',
      serial: sys.SerialNumber || '',
      cpu_count: (sys.ProcessorSummary && sys.ProcessorSummary.Count) || null,
      cpu_health: healthOf(sys.ProcessorSummary),
      mem_gib: (sys.MemorySummary && sys.MemorySummary.TotalSystemMemoryGiB) || null,
      mem_health: healthOf(sys.MemorySummary),
      system_health: healthOf(sys),
      temps: [], fans: [], psus: [], drives: [], events: []
    };

    // 机箱：温度/风扇/电源
    const chPaths = await c.getAllMembers('/redfish/v1/Chassis');
    for (const cp of chPaths) {
      const ch = await c.get(cp);
      let thermal = ch.Thermal || null;
      if (!thermal && ch.ThermalSubsystem && ch.ThermalSubsystem['@odata.id']) {
        const ts = await c.get(ch.ThermalSubsystem['@odata.id']);
        thermal = ts;
      } else if (!thermal) {
        try { thermal = await c.get(cp.replace(/\/$/, '') + '/Thermal'); } catch (e) { thermal = null; }
      }
      if (thermal) {
        for (const t of thermal.Temperatures || []) {
          if (t.ReadingCelsius === undefined && t.Reading === undefined) continue;
          hw.temps.push({
            name: t.Name || t.MemberId || '温度',
            reading: t.ReadingCelsius !== undefined ? t.ReadingCelsius : t.Reading,
            health: healthOf(t)
          });
        }
        for (const f of thermal.Fans || []) {
          hw.fans.push({
            name: f.Name || f.MemberId || '风扇',
            reading: f.Reading !== undefined ? f.Reading : (f.ReadingUnits ? f.Reading : null),
            health: healthOf(f)
          });
        }
      }
      let power = ch.Power || null;
      if (!power) {
        try { power = await c.get(cp.replace(/\/$/, '') + '/Power'); } catch (e) { power = null; }
      }
      if (power) {
        for (const p of power.PowerSupplies || []) {
          hw.psus.push({
            name: p.Name || p.MemberId || '电源',
            state: p.State || (p.Status && p.Status.State) || '',
            health: healthOf(p)
          });
        }
      }
    }

    // 存储/磁盘硬件状态（硬盘健康监测）
    // 搜索路径：系统下 Storage、全局 Storage、各机箱下 Storage、
    // 系统下 SimpleStorage（含跟随 sys.SimpleStorage 链接，兼容 Dell iDRAC 的 /Storage/Controllers 结构）
    const storageColls = [
      sysPath.replace(/\/$/, '') + '/Storage',
      '/redfish/v1/Storage',
      sysPath.replace(/\/$/, '') + '/SimpleStorage'
    ];
    if (sys.SimpleStorage && sys.SimpleStorage['@odata.id']) {
      storageColls.push(sys.SimpleStorage['@odata.id']);
    }
    if (sys.Storage && sys.Storage['@odata.id']) {
      storageColls.push(sys.Storage['@odata.id']);
    }
    for (const cp of chPaths) {
      storageColls.push(cp.replace(/\/$/, '') + '/Storage');
      storageColls.push(cp.replace(/\/$/, '') + '/SimpleStorage');
    }
    const seenDrives = {};
    /** 归一化单块硬盘信息（含健康评估） */
    const pushDrive = (d, srcName) => {
      const name = d.Name || d.MemberId || d.Id || srcName || '磁盘';
      // 过滤背板、扩展器等非磁盘设备
      if (/backplane|expander|enclosure/i.test(name)) return;
      const key = (d.SerialNumber || '') + '|' + name;
      if (seenDrives[key]) return;
      seenDrives[key] = true;
      let health = healthOf(d);
      // SSD 剩余寿命评估：PredictedMediaLifeLeftPercent 低于阈值判预警
      let lifeLeft = d.PredictedMediaLifeLeftPercent;
      if (lifeLeft === undefined) lifeLeft = d.LifeLeftPercent;
      let lifeStatus = null;
      if (lifeLeft !== undefined && lifeLeft !== null && !isNaN(Number(lifeLeft))) {
        lifeLeft = Number(lifeLeft);
        if (lifeLeft <= 10) lifeStatus = 'critical';
        else if (lifeLeft <= 25) lifeStatus = 'warning';
        // 健康等级取最严重
        if (lifeStatus && (!health || levelOfHealth(lifeStatus) > levelOfHealth(health))) {
          health = lifeStatus === 'critical' ? 'Critical' : 'Warning';
        }
      }
      hw.drives.push({
        name: name,
        manufacturer: d.Manufacturer || '',
        model: d.Model || '',
        serial: d.SerialNumber || '',
        media_type: d.MediaType || (d.RotationSpeedRPM ? 'HDD' : ''),
        rpm: d.RotationSpeedRPM || null,
        capacity: d.CapacityBytes ? Math.round(d.CapacityBytes / 1073741824) + ' GB' : '',
        life_left: (lifeLeft !== undefined && lifeLeft !== null) ? lifeLeft : null,
        health: health
      });
    };
    for (const sc of storageColls) {
      const paths = await c.getAllMembers(sc);
      for (const sp of paths) {
        let st = null;
        try { st = await c.get(sp); } catch (e) { continue; }
        // Storage 的 Drives 通常是 @odata.id 引用，逐个获取硬盘详情
        for (const d of st.Drives || []) {
          if (d['@odata.id']) {
            try {
              const detail = await c.get(d['@odata.id']);
              pushDrive(detail, d.Name || sp.split('/').pop());
              continue;
            } catch (e) { /* 获取失败则尝试直接用引用对象 */ }
          }
          pushDrive(d, sp.split('/').pop());
        }
        // SimpleStorage 的 Devices
        for (const d of st.Devices || []) {
          if (d['@odata.id']) {
            try {
              const detail = await c.get(d['@odata.id']);
              pushDrive(detail, d.Name || sp.split('/').pop());
              continue;
            } catch (e) { /* 忽略 */ }
          }
          pushDrive(d, sp.split('/').pop());
        }
      }
    }

    // 硬件事件日志（取最近 5 条）
    const logPaths = await c.getAllMembers(sysPath.replace(/\/$/, '') + '/LogServices');
    if (logPaths.length > 0) {
      try {
        const entries = await c.get(logPaths[0].replace(/\/$/, '') + '/Entries');
        const list = entries.Members || [];
        const last = list.slice(-5);
        for (const ep of last) {
          const e = await c.get(ep['@odata.id']);
          hw.events.push({
            time: e.Created || '',
            severity: e.Severity || '',
            message: e.Message || e.MessageId || ''
          });
        }
      } catch (e) { /* 无日志权限则忽略 */ }
    }

    await c.close();

    return {
      ok: true,
      kind: 'bmc',
      metrics: {
        hostname: sys.HostName || sys.Name || server.host,
        os: (hw.manufacturer + ' ' + hw.model).trim(),
        kernel: hw.bios,
        uptime_sec: null, cores: hw.cpu_count,
        load1: null, load5: null, load15: null,
        cpu_percent: null,
        mem_total_mb: hw.mem_gib ? hw.mem_gib * 1024 : null,
        mem_used_mb: null, mem_percent: null,
        swap_total_mb: null, swap_used_mb: null,
        procs: null, zombies: null,
        disks: []
      },
      hw: hw,
      services: [],
      customs: []
    };
  } catch (e) {
    return { ok: false, error: friendlyBmcError(e, server) };
  } finally {
    try { await c.close(); } catch (e) { /* 忽略 */ }
  }
}

function friendlyBmcError(e, server) {
  const m = String((e && e.message) || e);
  if (/认证失败/.test(m)) return m;
  if (/ECONNREFUSED/.test(m)) return '管理口连接被拒绝，请确认 IP 与端口（默认 443）以及管理口服务已启用';
  if (/ETIMEDOUT|请求超时|timed out/i.test(m)) return '管理口连接超时，请检查网络是否可达管理口网段';
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return '无法解析管理口地址';
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) return '管理口网络不可达';
  if (/CERT|certificate/i.test(m)) return '管理口证书校验失败：' + m;
  return m;
}

module.exports = { collectBmc, levelOfHealth };
