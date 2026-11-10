'use strict';
/**
 * P2 历史趋势离线自测。
 * 全部在临时 SQLite 上跑（history.useDbFile），不碰 data/ 下任何真实库。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const H = require('../src/inspection/history');

let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  else { fail++; console.error('FAIL  ' + name + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)); }
}
function ok(name, cond, extra) {
  if (cond) pass++;
  else { fail++; console.error('FAIL  ' + name + (extra === undefined ? '' : '  ' + JSON.stringify(extra))); }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'his-hist-'));
const file = path.join(tmp, 'inspect.db');

try {
  /* ---------- ① 老库补列：这是最容易静默失败的一环 ---------- */
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE it_inspect_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT, round_id INTEGER, round_no INTEGER,
    device_id INTEGER, name TEXT, host TEXT, os TEXT, ok INTEGER, status TEXT,
    cpu_percent REAL, mem_percent REAL, error TEXT, reasons TEXT, checked_at TEXT
  );`);
  old.close();
  H.useDbFile(file);
  ok('临时库 init 成功', H.init());
  const cols = H.db.prepare('PRAGMA table_info(it_inspect_history)').all().map((c) => c.name);
  ok('老库补出 metrics_json 列', cols.includes('metrics_json'), cols);
  ok('补列后原有列没丢', cols.includes('cpu_percent') && cols.includes('checked_at'));

  /* ---------- ② 展平：只收数值，中文元数据单独挂 __meta ---------- */
  const sample = {
    deviceId: 1, name: 'HIS-DB-01', host: '10.0.0.5', os: 'windows', ok: true, status: 'normal',
    metrics: {
      cpu_percent: 34.2, mem_percent: 61.5, cores: 8, procs: 210, load1: 1.2,
      zombies: 0, log_errors: 3,
      disks: [{ used_percent: 62 }, { used_percent: 78 }],
      net: [{ rx_kbps: 100, tx_kbps: 50, errs: 2 }, { rx_kbps: 30, tx_kbps: 10, errs: 0 }],
      hostname: 'HIS-DB-01', bad: NaN, str: 'x'
    },
    extra: {
      system: { threads: 1234, handles: 5000, context_switches_per_sec: 890, note: '不该入库' },
      network: { tcp_established: 42 },
      disk_io: { disk_read_iops: 12.5 },
      textfile: { items: [
        { key: 'his_settle_ms', name: '医保结算耗时', unit: 'ms', value: 342.5 },
        { key: 'his_cert_days_left', name: '证书剩余天数', unit: '天', value: 26 }
      ] }
    }
  };
  const flat = H.flattenMetrics(sample);
  eq('cpu', flat.cpu_percent, 34.2);
  eq('磁盘取最大使用率', flat.disk_percent_max, 78);
  eq('网卡速率求和', flat.net_total_kbps, 190);
  eq('网卡错包求和', flat.net_errs, 2);
  eq('extra.system 线程', flat['x.threads'], 1234);
  eq('extra.network', flat['x.tcp_established'], 42);
  eq('extra.disk_io', flat['x.disk_read_iops'], 12.5);
  eq('textfile 按 key 展开', flat['tf.his_settle_ms'], 342.5);
  ok('字符串字段不入库', !('hostname' in flat) && !('str' in flat) && !('x.note' in flat));
  ok('NaN 不入库', !('bad' in flat));
  eq('空结果安全', H.flattenMetrics(null), {});

  /* ---------- ③ 落三轮，时间手工错开 10 分钟 ---------- */
  function mk(cpu, tf) {
    const s = JSON.parse(JSON.stringify(sample));
    s.metrics.cpu_percent = cpu;
    s.extra.textfile.items[0].value = tf;
    return s;
  }
  const base = Date.now();
  for (let i = 1; i <= 3; i++) {
    const r = H.saveRound({
      roundNo: i, source: 'selftest',
      results: [mk(30 + i * 20, 100 + i * 40)],
      summary: { total: 1, normal: 1, warning: 0, critical: 0, error: 0 }
    });
    ok('第 ' + i + ' 轮写入成功', r.ok, r);
    H.db.prepare('UPDATE it_inspect_history SET checked_at = ? WHERE round_no = ?')
      .run(H.nowAt(base - (4 - i) * 10 * 60000), i);
  }
  const st = H.stats();
  ok('轮次数', st.rounds === 3, st);
  ok('快照数（不拆行，一台一轮一条）', st.snapshots === 3, st);
  const raw = H.db.prepare('SELECT metrics_json FROM it_inspect_history ORDER BY id').all();
  ok('每行都带 metrics_json', raw.every((r) => r.metrics_json && r.metrics_json.length > 10));
  ok('__meta 单独挂中文名', JSON.parse(raw[0].metrics_json).__meta['tf.his_settle_ms'].name === '医保结算耗时');

  /* ---------- ④ 指标目录 ---------- */
  const cat = H.catalog();
  ok('catalog ready', cat.ready);
  const keys = cat.items.map((x) => x.key);
  ok('目录含 cpu / 磁盘 / 网卡', ['cpu_percent', 'disk_percent_max', 'net_total_kbps'].every((k) => keys.includes(k)), keys);
  ok('目录含 exporter 扩展指标', keys.includes('x.threads') && keys.includes('x.tcp_established'), keys);
  ok('目录含 textfile 指标', keys.includes('tf.his_settle_ms') && keys.includes('tf.his_cert_days_left'), keys);
  ok('__meta 不作为指标出现在目录', !keys.includes('__meta'), keys);
  const tf = cat.items.find((x) => x.key === 'tf.his_settle_ms');
  eq('textfile 中文名来自 HELP', tf && tf.label, '医保结算耗时');
  eq('textfile 单位来自 HELP', tf && tf.unit, 'ms');
  ok('目录带设备列表', tf && tf.devices.length === 1 && tf.devices[0].id === 1);

  /* ---------- ⑤ 最近一轮 ---------- */
  const latest = H.latestRound();
  ok('latest 只回最后一轮', latest.roundNo === 3 && latest.items.length === 1, latest.roundNo);
  eq('latest 的 CPU 是第 3 轮', latest.items[0].metrics.cpu_percent, 90);
  ok('latest 不暴露 __meta', !('__meta' in latest.items[0].metrics));

  /* ---------- ⑥ 序列与分桶 ---------- */
  const s1 = H.seriesFor(1, 'cpu_percent', '1h');
  ok('1h 有 3 个原始点', s1.count === 3, s1.count);
  eq('1h 序列值正序', s1.items.map((x) => x.value), [50, 70, 90]);
  eq('1h min / max / avg 自洽', [s1.min, s1.max, s1.avg], [50, 90, 70]);
  eq('1h label', s1.labelCn, 'CPU 使用率');
  const s24 = H.seriesFor(1, 'cpu_percent', '24h');
  ok('24h 点数不多于 1h（5m 桶）', s24.count <= s1.count && s24.count >= 1, s24.count);
  const s7 = H.seriesFor(1, 'cpu_percent', '7d');
  ok('7d 点数不多于 24h（1h 桶）', s7.count <= s24.count && s7.count >= 1, s7.count);
  const stf = H.seriesFor(1, 'tf.his_settle_ms', '1h');
  ok('textfile 指标也能出趋势', stf.count === 3, stf.count);
  eq('textfile 单位', stf.unit, 'ms');
  ok('不存在的指标返回空序列', H.seriesFor(1, 'nope', '1h').count === 0);
  ok('不存在的设备返回空序列', H.seriesFor(999, 'cpu_percent', '1h').count === 0);
  ok('未知 range 由路由挡，函数内部退回 24h 不抛错', H.seriesFor(1, 'cpu_percent', '99y').count >= 1);
  ok('RANGES 四档齐全', ['1h', '6h', '24h', '7d'].every((k) => H.RANGES[k]));

  /* ---------- ⑦ 老接口保持兼容 ---------- */
  const tr = H.trend(1, 200);
  ok('trend 仍是数组且 3 条', Array.isArray(tr) && tr.length === 3, tr.length);
  ok('trend 字段结构没变', tr[0] && 'checkedAt' in tr[0] && 'cpu' in tr[0] && 'mem' in tr[0]);
  ok('availability 可用', H.availability(7).length === 1);
  ok('recentRounds 可用', H.recentRounds(50).length === 3);
  ok('cleanup 不误删最近数据', H.cleanup(90).ok && H.stats().snapshots === 3);

  /* ---------- ⑧ 边界：脏 metrics_json 不能让目录/序列崩 ---------- */
  H.db.prepare("UPDATE it_inspect_history SET metrics_json = '{坏 JSON' WHERE round_no = 1").run();
  ok('坏 JSON 不抛错', H.catalog().ready === true);
  ok('坏 JSON 只丢那一行', H.seriesFor(1, 'cpu_percent', '1h').count === 2);
} catch (e) {
  fail++;
  console.error('FAIL  未捕获异常：' + (e && e.stack || e));
} finally {
  H.useDbFile(null);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

console.log('history-trend-selftest: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
