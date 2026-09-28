'use strict';
/**
 * 数据库巡检模块：SQL Server 2000/2008（tedious TDS）与 Oracle（oracledb thin 模式）
 * 采集：版本、运行时长、连接数、阻塞会话、数据库大小/日志或表空间使用率
 */

const { Connection, Request } = require('tedious');
const oracledb = require('oracledb');
const { round1, truncate } = require('./common');

// TDS 版本映射（version_hint → tedious tdsVersion）
const TDS_BY_HINT = {
  '2000': '7_1',
  '2005': '7_2',
  '2008': '7_3_B',
  '2012': '7_4'
};
// 自动协商降级序列
const TDS_FALLBACK = ['7_4', '7_3_B', '7_2', '7_1'];

function friendlyMssqlError(e, tdsVersion) {
  const m = String((e && e.message) || e);
  const code = e && e.code;
  if (code === 'ESOCKET' || /ECONNREFUSED|getaddrinfo|ETIMEDOUT|ESOCKET/i.test(m)) {
    return '无法连接数据库服务器，请检查地址、端口（SQL Server 默认 1433）与网络/防火墙 (' + truncate(m, 150) + ')';
  }
  if (code === 'ELOGIN' || /Login failed|登录失败/i.test(m)) {
    return '数据库登录失败，请检查账号密码或账号是否被禁用 (' + truncate(m, 150) + ')';
  }
  if (code === 'ETIMEOUT' || /connect timeout|超时/i.test(m)) {
    return '数据库连接超时，请检查网络或数据库负载 (' + truncate(m, 150) + ')';
  }
  if (/protocol|version|negotiat/i.test(m)) {
    return 'TDS 协议协商失败（当前使用 ' + tdsVersion + '），请在配置中明确指定 SQL Server 版本 (' + truncate(m, 150) + ')';
  }
  return 'SQL Server 采集失败: ' + truncate(m, 200);
}

function friendlyOracleError(e) {
  const m = String((e && e.message) || e);
  if (/ORA-12541|no listener|TNS-12541/i.test(m)) return 'Oracle 监听器未启动或地址端口不对（默认 1521）(' + truncate(m, 150) + ')';
  if (/ORA-01017/i.test(m)) return 'Oracle 登录失败：用户名或密码无效 (' + truncate(m, 150) + ')';
  if (/ORA-12170|NJS-510|timed out/i.test(m)) return 'Oracle 连接超时，请检查网络、端口或数据库负载 (' + truncate(m, 150) + ')';
  if (/NJS-503/i.test(m)) return '无法建立到 Oracle 的连接，请检查地址、端口（默认 1521）与网络/防火墙 (' + truncate(m, 150) + ')';
  if (/NJS-500/i.test(m)) return 'Oracle 网络配置无效，请检查 service_name 配置 (' + truncate(m, 150) + ')';
  if (/ORA-12514|ORA-12505|unknown SID|service/i.test(m)) return 'Oracle 服务名或 SID 不正确，请检查 service_name 配置 (' + truncate(m, 150) + ')';
  if (/ORA-01033|ORA-01034|ORA-00600/i.test(m)) return 'Oracle 实例未就绪或存在内部错误 (' + truncate(m, 150) + ')';
  return 'Oracle 采集失败: ' + truncate(m, 200);
}

/* ---------------- SQL Server ---------------- */

function tdsExec(conn, sql) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = new Request(sql, (err) => {
      if (err) reject(err);
      else resolve(rows);
    });
    req.on('row', (columns) => {
      const row = {};
      columns.forEach((c) => { row[c.metadata.colName] = c.value; });
      rows.push(row);
    });
    conn.execSql(req);
  });
}

function tdsConnect(host, port, user, pass, tdsVersion, timeoutMs) {
  return new Promise((resolve, reject) => {
    const conn = new Connection({
      server: host,
      authentication: { type: 'default', options: { userName: user, password: pass } },
      options: {
        port: port,
        tdsVersion: tdsVersion,
        encrypt: false,           // 老版本（2000/2008）不支持 TLS，必须关闭
        trustServerCertificate: true,
        connectTimeout: Math.min(timeoutMs, 30000),
        requestTimeout: Math.min(timeoutMs, 60000),
        packetSize: 4096
      }
    });
    conn.on('connect', (err) => {
      if (err) reject(err);
      else resolve(conn);
    });
    conn.on('error', () => { /* 连接建立后的错误静默，避免崩进程 */ });
    conn.connect();
  });
}

async function collectMssql(server, timeoutMs) {
  const auth = server.auth || {};
  const dbCfg = server.db || {};
  const host = server.host;
  const port = server.port || 1433;
  const hint = String(dbCfg.version_hint || 'auto').toLowerCase();
  const instance = dbCfg.instance || '';
  const target = instance ? host + '\\' + instance : host;

  const tryVersions = hint !== 'auto' && TDS_BY_HINT[hint] ? [TDS_BY_HINT[hint]] : TDS_FALLBACK;
  let conn = null;
  let lastErr = null;
  let usedTds = null;

  for (const tv of tryVersions) {
    try {
      conn = await tdsConnect(host, port, auth.username, auth.password, tv, timeoutMs);
      usedTds = tv;
      break;
    } catch (e) {
      lastErr = e;
      // 登录失败类错误不再降级重试（协议没问题，是账号问题）
      if (e && (e.code === 'ELOGIN' || /Login failed/i.test(String(e.message)))) {
        return { ok: false, error: friendlyMssqlError(e, tv) };
      }
    }
  }
  if (!conn) return { ok: false, error: friendlyMssqlError(lastErr, tryVersions[0]) };

  try {
    const db = {
      engine: 'mssql',
      engineLabel: 'SQL Server',
      instance: instance,
      tdsVersion: usedTds,
      version: '', uptime_sec: null,
      conn_total: null, conn_active: null, conn_max: null,
      blocked: null,
      databases: [],
      last_backup_ms: null,
      buffer_hit_pct: null,
      lock_waiters: null,
      max_wait_ms: null
    };

    // 1. 版本
    try {
      const vr = await tdsExec(conn, 'SELECT @@VERSION AS v');
      if (vr.length) {
        db.version = String(vr[0].v || '').split('\n')[0].trim();
        const m = db.version.match(/(\d+\.\d+\.\d+)/);
        if (m) {
          const major = parseInt(m[1].split('.')[0], 10);
          const labelMap = { 8: 'SQL Server 2000', 9: 'SQL Server 2005', 10: 'SQL Server 2008', 11: 'SQL Server 2012', 12: 'SQL Server 2014' };
          if (labelMap[major]) db.engineLabel = labelMap[major] + ' (' + m[1] + ')';
          else db.engineLabel = 'SQL Server (' + m[1] + ')';
        }
      }
    } catch (e) { /* 忽略 */ }

    // 2. 运行时长：tempdb 创建时间 ≈ 实例启动时间（2000 兼容写法）
    try {
      const ur = await tdsExec(conn, "SELECT crdate AS t FROM master..sysdatabases WHERE name='tempdb'");
      if (ur.length && ur[0].t) {
        db.uptime_sec = Math.max(0, Math.floor((Date.now() - new Date(ur[0].t).getTime()) / 1000));
      }
    } catch (e) { /* 忽略 */ }

    // 3. 连接数与阻塞
    try {
      const cr = await tdsExec(conn, 'SELECT COUNT(*) AS total, SUM(CASE WHEN status <> \'sleeping\' THEN 1 ELSE 0 END) AS active, SUM(CASE WHEN blocked > 0 THEN 1 ELSE 0 END) AS blocked FROM master..sysprocesses WHERE spid >= 51');
      if (cr.length) {
        db.conn_total = Number(cr[0].total) || 0;
        db.conn_active = Number(cr[0].active) || 0;
        db.blocked = Number(cr[0].blocked) || 0;
      }
      const mr = await tdsExec(conn, 'SELECT @@MAX_CONNECTIONS AS mc');
      if (mr.length) db.conn_max = Number(mr[0].mc) || null;
    } catch (e) { /* 忽略 */ }

    // 4. 数据库大小（sp_msforeachdb + sysfiles，2000/2008 兼容）
    try {
      const dr = await tdsExec(conn, "EXEC sp_msforeachdb 'USE [?]; SELECT DB_NAME() AS dbname, SUM(size)*8.0/1024 AS sizemb FROM sysfiles'");
      db.databases = dr.map((r) => ({
        name: String(r.dbname || ''),
        size_mb: Math.round(Number(r.sizemb) || 0),
        log_used_pct: null
      })).filter((d) => d.name);
    } catch (e) { /* 忽略 */ }

    // 5. 日志使用率（DBCC SQLPERF(LOGSPACE)，2000/2008 兼容）
    try {
      const lr = await tdsExec(conn, 'DBCC SQLPERF(LOGSPACE)');
      const logMap = {};
      for (const r of lr) {
        const keys = Object.keys(r);
        if (keys.length >= 3) logMap[String(r[keys[0]]).trim()] = round1(Number(r[keys[2]]) || 0);
      }
      for (const d of db.databases) {
        if (logMap[d.name] !== undefined) d.log_used_pct = logMap[d.name];
      }
    } catch (e) { /* 忽略 */ }

    // 6. 最近备份时间 / 缓冲命中率 / 锁等待（无权限或版本不支持时跳过）
    try {
      const br = await tdsExec(conn, "SELECT DATEDIFF(second, '19700101', MAX(backup_finish_date)) AS last_backup_sec FROM msdb.dbo.backupset WHERE type IN ('D','I')");
      if (br.length && br[0].last_backup_sec !== null && br[0].last_backup_sec !== undefined) {
        db.last_backup_ms = Number(br[0].last_backup_sec) * 1000;
      }
    } catch (e) { /* 忽略 */ }
    try {
      const hr = await tdsExec(conn,
        "SELECT CAST(SUM(CASE WHEN counter_name='Buffer cache hit ratio' THEN CAST(cntr_value AS float) END) / " +
        "NULLIF(SUM(CASE WHEN counter_name='Buffer cache hit ratio base' THEN CAST(cntr_value AS float) END),0) * 100 AS decimal(6,2)) AS hit_pct " +
        "FROM sys.dm_os_performance_counters WHERE object_name LIKE '%Buffer Manager%' AND counter_name IN ('Buffer cache hit ratio','Buffer cache hit ratio base')");
      if (hr.length && hr[0].hit_pct !== null && hr[0].hit_pct !== undefined) {
        db.buffer_hit_pct = round1(Number(hr[0].hit_pct));
      }
    } catch (e) { /* 忽略 */ }
    try {
      const wr = await tdsExec(conn,
        "SELECT COUNT(*) AS waiters, MAX(waittime) AS max_wait FROM master..sysprocesses " +
        "WHERE (blocked > 0 OR (waittype <> 0x00 AND waittype NOT IN (0x0200,0x0400,0x0800))) AND waittime > 0");
      if (wr.length) {
        db.lock_waiters = Number(wr[0].waiters) || 0;
        db.max_wait_ms = Number(wr[0].max_wait) || 0;
      }
    } catch (e) { /* 忽略 */ }

    try { conn.close(); } catch (e) { /* 忽略 */ }
    return {
      ok: true,
      kind: 'database',
      db: db,
      metrics: {
        hostname: target, os: db.engineLabel, kernel: db.version,
        uptime_sec: db.uptime_sec, cores: null,
        load1: null, load5: null, load15: null,
        cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null,
        swap_total_mb: null, swap_used_mb: null, procs: db.conn_total, zombies: db.blocked,
        disks: []
      },
      services: [],
      customs: []
    };
  } catch (e) {
    try { conn.close(); } catch (e2) { /* 忽略 */ }
    return { ok: false, error: friendlyMssqlError(e, usedTds) };
  }
}

/* ---------------- Oracle ---------------- */

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label + ' 超时（' + Math.round(ms / 1000) + ' 秒）')), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function oracleQuery(conn, sql) {
  const r = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });
  return r.rows || [];
}

async function collectOracle(server, timeoutMs) {
  const auth = server.auth || {};
  const dbCfg = server.db || {};
  const host = server.host;
  const port = server.port || 1521;
  const svc = dbCfg.service_name || 'ORCL';

  // service_name 形如 ORCL / orcl.domain；若含 ( 则当作完整 connect descriptor
  const connectString = /\(/.test(svc)
    ? svc.replace(/HOST\s*=\s*[^)]+/i, 'HOST=' + host).replace(/PORT\s*=\s*\d+/i, 'PORT=' + port)
    : host + ':' + port + '/' + svc;

  let conn = null;
  try {
    conn = await withTimeout(oracledb.getConnection({
      user: auth.username,
      password: auth.password,
      connectString: connectString
    }), Math.min(timeoutMs, 30000), 'Oracle 连接');
  } catch (e) {
    return { ok: false, error: friendlyOracleError(e) };
  }

  try {
    const db = {
      engine: 'oracle',
      engineLabel: 'Oracle',
      instance: '',
      tdsVersion: null,
      version: '', uptime_sec: null,
      conn_total: null, conn_active: null, conn_max: null,
      blocked: null,
      databases: [],
      tablespaces: [],
      last_backup_ms: null,
      buffer_hit_pct: null,
      lock_waiters: null,
      max_wait_ms: null
    };

    // 1. 版本与实例
    try {
      const vr = await withTimeout(oracleQuery(conn, 'SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1'), 15000, '版本查询');
      if (vr.length) {
        db.version = String(vr[0].BANNER || '').trim();
        const m = db.version.match(/(\d+\.\d+\.\d+\.\d+)/);
        if (m) db.engineLabel = 'Oracle ' + m[1];
      }
    } catch (e) { /* 忽略 */ }
    try {
      const ir = await withTimeout(oracleQuery(conn, 'SELECT INSTANCE_NAME, STATUS FROM V$INSTANCE'), 15000, '实例查询');
      if (ir.length) {
        db.instance = String(ir[0].INSTANCE_NAME || '');
        db.engineLabel += ' (' + String(ir[0].STATUS || '') + ')';
      }
    } catch (e) { /* 忽略 */ }

    // 2. 运行时长
    try {
      const ur = await withTimeout(oracleQuery(conn, 'SELECT ROUND((SYSDATE - STARTUP_TIME) * 86400) AS SEC FROM V$INSTANCE'), 15000, '运行时长查询');
      if (ur.length) db.uptime_sec = Number(ur[0].SEC) || 0;
    } catch (e) { /* 忽略 */ }

    // 3. 会话数与阻塞
    try {
      const sr = await withTimeout(oracleQuery(conn, 'SELECT COUNT(*) AS TOTAL, SUM(CASE WHEN STATUS = \'ACTIVE\' THEN 1 ELSE 0 END) AS ACTIVE, SUM(CASE WHEN BLOCKING_SESSION IS NOT NULL THEN 1 ELSE 0 END) AS BLOCKED FROM V$SESSION WHERE TYPE = \'USER\''), 15000, '会话查询');
      if (sr.length) {
        db.conn_total = Number(sr[0].TOTAL) || 0;
        db.conn_active = Number(sr[0].ACTIVE) || 0;
        db.blocked = Number(sr[0].BLOCKED) || 0;
      }
    } catch (e) {
      // V$SESSION 没权限时降级
      try {
        const sr2 = await withTimeout(oracleQuery(conn, 'SELECT COUNT(*) AS TOTAL FROM V$SESSION'), 15000, '会话查询');
        if (sr2.length) db.conn_total = Number(sr2[0].TOTAL) || 0;
      } catch (e2) { /* 忽略 */ }
    }
    // 进程上限
    try {
      const pr = await withTimeout(oracleQuery(conn, "SELECT TO_NUMBER(VALUE) AS V FROM V$PARAMETER WHERE NAME = 'processes'"), 15000, '参数查询');
      if (pr.length) db.conn_max = Number(pr[0].V) || null;
    } catch (e) { /* 忽略 */ }

    // 4. 表空间使用率（需 DBA 权限，无权限时跳过）
    try {
      const tr = await withTimeout(oracleQuery(conn,
        'SELECT A.TABLESPACE_NAME AS NAME, ROUND(A.BYTES / 1048576) AS SIZE_MB, ROUND((A.BYTES - NVL(B.FREE_BYTES, 0)) / 1048576) AS USED_MB, ' +
        'ROUND((A.BYTES - NVL(B.FREE_BYTES, 0)) * 100 / A.BYTES, 1) AS USE_PCT ' +
        'FROM (SELECT TABLESPACE_NAME, SUM(BYTES) AS BYTES FROM DBA_DATA_FILES GROUP BY TABLESPACE_NAME) A ' +
        'LEFT JOIN (SELECT TABLESPACE_NAME, SUM(BYTES) AS FREE_BYTES FROM DBA_FREE_SPACE GROUP BY TABLESPACE_NAME) B ' +
        'ON A.TABLESPACE_NAME = B.TABLESPACE_NAME ORDER BY A.TABLESPACE_NAME'), 30000, '表空间查询');
      db.tablespaces = tr.map((r) => ({
        name: String(r.NAME || ''),
        size_mb: Number(r.SIZE_MB) || 0,
        used_mb: Number(r.USED_MB) || 0,
        use_pct: Number(r.USE_PCT) || 0
      }));
    } catch (e) { /* 权限不足则忽略 */ }

    // 5. 最近备份时间 / 缓冲命中率 / 锁等待（无权限或版本不支持时跳过）
    try {
      const br = await withTimeout(oracleQuery(conn,
        "SELECT (MAX(completion_time) - DATE '1970-01-01') * 86400 AS last_backup_sec FROM V$BACKUP_DATAFILE"),
        15000, '备份时间查询');
      if (br.length && br[0].LAST_BACKUP_SEC !== null && br[0].LAST_BACKUP_SEC !== undefined) {
        db.last_backup_ms = Number(br[0].LAST_BACKUP_SEC) * 1000;
      }
    } catch (e) { /* 忽略 */ }
    try {
      const hr = await withTimeout(oracleQuery(conn,
        "SELECT ROUND((1 - (phy.VALUE / NULLIF(g.VALUE + c.VALUE, 0))) * 100, 2) AS HIT_PCT " +
        "FROM V$SYSSTAT phy, V$SYSSTAT g, V$SYSSTAT c " +
        "WHERE phy.NAME='physical reads' AND g.NAME='db block gets' AND c.NAME='consistent gets'"),
        15000, '缓冲命中率查询');
      if (hr.length && hr[0].HIT_PCT !== null && hr[0].HIT_PCT !== undefined) {
        db.buffer_hit_pct = round1(Number(hr[0].HIT_PCT));
      }
    } catch (e) { /* 忽略 */ }
    try {
      const wr = await withTimeout(oracleQuery(conn,
        "SELECT COUNT(*) AS WAITERS, MAX(SECONDS_IN_WAIT) AS MAX_WAIT FROM V$SESSION " +
        "WHERE STATE='WAITING' AND (WAIT_CLASS IN ('Application','Concurrency') OR EVENT LIKE 'enq%')"),
        15000, '锁等待查询');
      if (wr.length) {
        db.lock_waiters = Number(wr[0].WAITERS) || 0;
        db.max_wait_ms = (Number(wr[0].MAX_WAIT) || 0) * 1000;
      }
    } catch (e) { /* 忽略 */ }

    try { await conn.close(); } catch (e) { /* 忽略 */ }
    return {
      ok: true,
      kind: 'database',
      db: db,
      metrics: {
        hostname: host, os: db.engineLabel, kernel: db.version,
        uptime_sec: db.uptime_sec, cores: null,
        load1: null, load5: null, load15: null,
        cpu_percent: null, mem_total_mb: null, mem_used_mb: null, mem_percent: null,
        swap_total_mb: null, swap_used_mb: null, procs: db.conn_total, zombies: db.blocked,
        disks: []
      },
      services: [],
      customs: []
    };
  } catch (e) {
    try { await conn.close(); } catch (e2) { /* 忽略 */ }
    return { ok: false, error: friendlyOracleError(e) };
  }
}

/* ---------------- 入口 ---------------- */

async function collectDatabase(server, timeoutMs) {
  try {
    const dbCfg = server.db || {};
    const engine = String(dbCfg.engine || '').toLowerCase();
    if (engine === 'oracle') return await collectOracle(server, timeoutMs);
    return await collectMssql(server, timeoutMs);
  } catch (e) {
    return { ok: false, error: '数据库采集失败: ' + truncate(String((e && e.message) || e), 200) };
  }
}

module.exports = { collectDatabase };
