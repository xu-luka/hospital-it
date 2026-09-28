'use strict';
/**
 * weekly-cli.js —— 命令行生成一次巡检报告（供 Windows 计划任务每周调用）
 *
 * 与 Web 端「生成巡检报告」的区别只是数据来源的获取方式：
 *   本脚本自己从设备台账读一个尚在 maintainer 的数据源并完成口令解密；
 *   Web 端则由已在运行的服务进程提供（避免重复启动 KeyVault 子进程）。
 * 两处共用 weekly.generate()，采集口径完全一致。
 *
 * 用法：
 *   node scripts/weekly-cli.js
 *   node scripts/weekly-cli.js --dry-run       只核对数据源与设备，不连接设备、不写报告
 *   node scripts/weekly-cli.js --json          强制走 data/inspection.json（台账出问题时应急）
 */
const argv = process.argv.slice(2);
if (argv.indexOf('--json') >= 0) process.env.INSPECTION_SOURCE = 'json';
const dryRun = argv.indexOf('--dry-run') >= 0 || argv.indexOf('-n') >= 0;

const deviceSource = require('../src/inspection/device-source');
const weekly = require('../src/inspection/weekly');

async function main() {
  let cfg;
  try {
    cfg = await deviceSource.load();
  } catch (e) {
    weekly.logLine('[失败] 读取设备数据失败：' + ((e && e.message) || e));
    process.exit(1);
  }
  const servers = cfg.servers || [];
  weekly.logLine('数据源：' + (cfg.__source === 'db' ? '设备台账（it_devices）' : '配置文件（data/inspection.json）'));

  if (dryRun) {
    const inspect = require('../src/inspection/inspect');
    const errs = [];
    servers.forEach((s, i) => errs.push(...inspect.validateServer(s, i)));
    weekly.logLine('[dry-run] 设备 ' + servers.length + ' 台，启用校验错误 ' + errs.length + ' 项，未连接任何设备、未生成报告。');
    errs.slice(0, 8).forEach((e) => weekly.logLine('  - ' + e));
    process.exit(errs.length ? 1 : 0);
  }

  const r = await weekly.generate({ servers: servers, global: cfg.global || {}, source: 'scheduler' });
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  weekly.logLine('[异常] ' + ((e && e.stack) || e));
  process.exit(1);
});
