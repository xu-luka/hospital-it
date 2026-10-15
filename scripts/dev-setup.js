#!/usr/bin/env node
'use strict';
/**
 * dev-setup.js —— 新人首次拉代码后的一键初始化
 *
 * 做三件事：
 *   1) 检查 Node 版本（必须 ≥ 22.5，带 node:sqlite）
 *   2) npm install（装 express / multer / oracledb / ssh2 / tedious / iconv-lite 等）
 *   3) node scripts/init-deploy.js（生成本机 master.key，DPAPI 绑定本机）
 *
 * 跨平台：Windows / Mac / Linux 都能跑。注意 Mac/Linux 上巡检采集功能跑不全
 * （依赖 wmitools/WmiQuery.exe 与 secrets/KeyVault.exe，这两个是 Windows 可执行文件），
 * 但合同/工单/文档/书签/IP 管理这些模块都能正常开发。
 *
 * 用法：node scripts/dev-setup.js
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REQUIRED_MAJOR = 22;
const REQUIRED_MINOR = 5;

function fail(msg) {
  console.error('[X] ' + msg);
  process.exit(1);
}

function info(msg) { console.log('[i] ' + msg); }
function ok(msg) { console.log('[v] ' + msg); }

// ---- 1) Node 版本 ----
const ver = process.versions.node;
const [maj, min] = ver.split('.').map(Number);
info('Node 版本：' + ver);
if (maj < REQUIRED_MAJOR || (maj === REQUIRED_MAJOR && min < REQUIRED_MINOR)) {
  fail('Node 版本太低，需要 ' + REQUIRED_MAJOR + '.' + REQUIRED_MINOR + '+（带 node:sqlite）。请到 https://nodejs.org/ 装新版。');
}

// 顺带验证 node:sqlite 真的能用（有些精简版 Node 没编进去）
try {
  require('node:sqlite');
  ok('node:sqlite 可用');
} catch (e) {
  fail('这个 Node 不带 node:sqlite，换官方完整版（不是某些精简/精编版本）。');
}

// ---- 2) npm install ----
const nmDir = path.join(ROOT, 'node_modules');
if (fs.existsSync(nmDir) && fs.existsSync(path.join(nmDir, 'express'))) {
  ok('node_modules 已存在，跳过 npm install（要重装就删掉 node_modules 再跑）');
} else {
  info('开始 npm install（首次较慢，需能访问 npm registry）...');
  try {
    execSync('npm install', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    fail('npm install 失败：' + (e.message || e) + '\n    多半是网络问题，配好 npm registry（或代理）再重试。');
  }
  ok('依赖安装完成');
}

// 巡检依赖是可选的，缺了不影响合同/工单等主模块，但要让开发者知道
try {
  require('ssh2'); require('oracledb'); require('tedious'); require('iconv-lite');
  ok('巡检依赖齐全（ssh2/oracledb/tedious/iconv-lite）');
} catch (e) {
  info('巡检依赖缺失：' + (e.message || e));
  info('  合同/工单/文档/书签/IP 管理仍可正常开发；机房巡检采集会不可用。');
  info('  若要开发巡检功能，补装：npm install ssh2 oracledb tedious iconv-lite');
}

// ---- 3) 生成本机 master.key ----
const keyFile = path.join(ROOT, 'secrets', 'master.key');
if (fs.existsSync(keyFile)) {
  ok('secrets/master.key 已存在（本机绑定，不要提交、不要拷给别人）');
} else {
  info('生成本机主密钥（DPAPI 绑定本机，绝不能跨机复用）...');
  try {
    execSync('node scripts/init-deploy.js', { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    // init-deploy.js 在非 Windows 上会失败（没有 KeyVault.exe），这里给个出路
    info('init-deploy.js 执行失败 —— 若你在 Mac/Linux 上，这是正常的（KeyVault.exe 是 Windows 程序）。');
    info('  这种情况下设备口令加解密相关功能开发不了，但其余模块不受影响。');
    info('  若要开发巡检/书签密码相关功能，请在 Windows 上进行。');
  }
}

console.log('');
ok('初始化完成。下一步：');
console.log('    node server.js        （或 Windows 双击 start.bat）');
console.log('    浏览器打开 http://127.0.0.1:3131');
console.log('    用 admin 登录 —— 首次启动会在控制台打印随机初始口令');
console.log('');
console.log('    更详细的开发说明见 DEV.md');
