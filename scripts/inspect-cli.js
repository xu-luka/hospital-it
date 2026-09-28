'use strict';
/**
 * inspect-cli.js —— 巡检命令行外壳
 *
 * 用途：
 *   1) 排障：服务出问题时单独跑一次，不受 Express 影响，输出完整日志
 *   2) 兜底：即使合并服务因故未运行，仍可在服务器上一键出一版报告
 *   3) 原 C# 桌面端 GUI 若还在用，其「立即巡检」改为调用本脚本
 *
 * 用法：
 *   node scripts/inspect-cli.js --demo         演示数据（不连接任何设备）
 *   node scripts/inspect-cli.js                正常巡检
 *   node scripts/inspect-cli.js --dry-run      只读配置与统计，不连接设备
 *
 * 与原 inspect.js 的关系：本脚本只做参数解析与前置提示，真正的采集、评估、
 * 报告渲染全部调用 src/inspection/inspect.js —— 与 Web 端同为一条口径，
 * 命令行出的报告和大屏看到的完全一致。
 */
const inspect = require('../src/inspection/inspect');
const paths = require('../src/inspection/paths');
const configSource = require('../src/inspection/config-source');

async function main() {
  const argv = process.argv;

  const audit = paths.audit();
  if (!audit.ok) {
    console.log('[警告] 以下外部资产缺失，相关设备会巡检失败：');
    audit.missing.forEach((m) => console.log('        - ' + m.label + ' → ' + m.path));
    console.log('');
  }

  if (argv.indexOf('--dry-run') >= 0 || argv.indexOf('-n') >= 0) {
    const cfg = await configSource.load();
    const servers = cfg.servers || [];
    const errs = [];
    servers.forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
    const byOs = {};
    servers.forEach((s) => { byOs[s.os] = (byOs[s.os] || 0) + 1; });
    console.log('设备 ' + servers.length + ' 台，构成：' +
      Object.keys(byOs).map((k) => k + ' ' + byOs[k]).join(' / '));
    console.log('配置校验：' + (errs.length ? errs.length + ' 项错误' : '通过（0 错误）'));
    errs.slice(0, 20).forEach((e) => console.log('  - ' + e));
    return 0;
  }

  await inspect.main();
  return 0;
}

// CLI 独立运行时的兜底：这里吞异常是可接受的（不牵连任何常驻服务）。
// 注意与 server.js 的区别 —— 常驻服务绝不能静默吞异常。
main().catch((e) => {
  console.error('巡检 CLI 异常：' + ((e && e.stack) || e));
  process.exit(1);
});
