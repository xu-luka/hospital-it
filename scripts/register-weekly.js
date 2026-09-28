'use strict';
/**
 * register-weekly.js —— 注册「每周生成巡检报告」的 Windows 计划任务
 *
 * 替代原巡检系统 deploy/register-weekly.ps1。合并后周报走的不再是
 *   node weekly.js（读 config.json），
 * 而是 node scripts/weekly-cli.js（读设备台账），本脚本负责把这个命令挂进计划任务。
 *
 * 用法：
 *   node scripts/register-weekly.js                每周一 07:30 生成
 *   node scripts/register-weekly.js --time 08:00   指定时间
 *   node scripts/register-weekly.js --day SAT      指定星期（MON..SUN / * 表示每天）
 *   node scripts/register-weekly.js --remove       删除任务
 *   node scripts/register-weekly.js --dry-run      只打印将要执行的 schtasks 命令
 */
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = path.join(ROOT, 'runtime', 'node.exe');
const TASK = '医院信息科-每周巡检报告';

const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const has = (n) => process.argv.indexOf(n) >= 0;

const time = arg('--time', '07:30');
const day = String(arg('--day', 'MON')).toUpperCase();
const dry = has('--dry-run');
const remove = has('--remove');

if (!/^\d{2}:\d{2}$/.test(time)) {
  console.error('时间格式应为 HH:MM，例如 07:30');
  process.exit(2);
}
if (day !== '*' && days.indexOf(day) < 0) {
  console.error('星期应为 ' + days.join(' / ') + ' 或 *');
  process.exit(2);
}

function build() {
  const cmd = '"' + NODE + '" "' + path.join(ROOT, 'scripts', 'weekly-cli.js') + '"';
  // 每天的场景比「每周」少见但也有人要（例如想保留每周 7 份对比），这里用 DAILY 表示
  if (day === '*') {
    return ['/Create', '/TN', TASK, '/TR', cmd, '/ST', time, '/SC', 'DAILY', '/F'];
  }
  return ['/Create', '/TN', TASK, '/TR', cmd, '/ST', time, '/SC', 'WEEKLY', '/D', day, '/F'];
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
console.log('    每 ' + (day === '*' ? '天' : '周' + day) + ' ' + time + ' 生成一份巡检周报');
console.log('    命令：' + NODE + ' scripts/weekly-cli.js');
run(build());
if (!dry) {
  console.log('\n可用 schtasks /Query /TN "' + TASK + '" 查看任务状态。');
  console.log('手动立即跑一次验证：runtime\\node.exe scripts\\weekly-cli.js');
}
