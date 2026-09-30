'use strict';
/**
 * register-backup.js —— 注册「每日自动数据备份」的 Windows 计划任务
 *
 * 背景：备份脚本 backup.js 一直只有手动入口（backup.bat），DEPLOY.md 里
 * 写的「建议挂计划任务」实际没人执行 —— 没有自动备份 = 数据裸奔。
 * 本脚本仿 register-weekly.js，把备份命令挂进 Windows 计划任务。
 *
 * 用法：
 *   node scripts/register-backup.js                  每天 02:30 备份到 backups\（保留 30 份）
 *   node scripts/register-backup.js --time 03:00     指定时间
 *   node scripts/register-backup.js --dir "D:\hosp-backup" --keep 14
 *   node scripts/register-backup.js --remove         删除任务
 *   node scripts/register-backup.js --dry-run        只打印将要执行的 schtasks 命令
 */
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node.exe');
const TASK = '医院信息科-每日数据备份';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.indexOf(n) >= 0;

const time = arg('--time', '02:30');
const dir = arg('--dir', '');
const keep = arg('--keep', '');
const dry = has('--dry-run');
const remove = has('--remove');

if (!/^\d{2}:\d{2}$/.test(time)) {
  console.error('时间格式应为 HH:MM，例如 02:30');
  process.exit(2);
}
if (keep && !/^\d+$/.test(keep)) {
  console.error('--keep 应为正整数（备份保留份数）');
  process.exit(2);
}

function build() {
  // backup.js 的参数是「目标目录 保留份数」，都是位置参数
  const extras = [];
  if (dir) extras.push(dir);
  if (keep) { if (!dir) extras.push(''); extras.push(keep); }
  let cmd = '"' + NODE + '" "' + path.join(ROOT, 'scripts', 'backup.js') + '"';
  if (extras.length) cmd += ' ' + extras.map((x) => '"' + x + '"').join(' ');
  return ['/Create', '/TN', TASK, '/TR', cmd, '/ST', time, '/SC', 'DAILY', '/F'];
}

function run(args) {
  if (dry) {
    console.log('schtasks ' + args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
    return;
  }
  try {
    const out = execFileSync('schtasks', args, { encoding: 'utf8' });
    console.log(String(out || '').trim());
  } catch (e) {
    console.error('执行 schtasks 失败：' + ((e && e.stderr) || e.message || e));
    console.error('\n若当前终端不是管理员权限，请「以管理员身份运行」后重试，或手动执行：');
    console.error('  schtasks ' + args.map((a) => (/\s/.test(a) ? '"' + a + '"' : a)).join(' '));
    process.exit(1);
  }
}

if (remove) {
  console.log('>>> 删除计划任务：' + TASK);
  run(['/Delete', '/TN', TASK, '/F']);
  process.exit(0);
}

console.log('>>> 注册计划任务：' + TASK);
console.log('    每天 ' + time + ' 备份全部数据库 + secrets + 附件' + (dir ? ' 到 ' + dir : ''));
run(build());
if (!dry) {
  console.log('\n可用 schtasks /Query /TN "' + TASK + '" 查看任务状态。');
  console.log('手动立即跑一次验证：runtime\\node.exe scripts\\backup.js');
  console.log('备份覆盖：contract.db / his.db / docs.db / inspect.db / .secret / secrets / uploads');
  console.log('不覆盖：data\\reports（巡检报告，可再生）、uploads\\docs\\.converted（预览缓存，可再生）');
}
