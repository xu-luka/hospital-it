'use strict';
/**
 * paths.js —— 部署根路径解析
 *
 * 为什么需要它：
 *   原巡检程序假设自己就在部署根下，直接用 path.join(__dirname, '..') 去找
 *   secrets/KeyVault.exe 与 wmitools/WmiQuery.exe。合并后采集层下沉到
 *   src/inspection/lib/，那个相对路径会指向 src/inspection/secrets —— 不存在，
 *   结果是全部加密凭据解不开、Windows 采集直接失败。
 *
 *   这里统一从 __dirname 逐级上溯到部署根，并允许用环境变量覆盖，
 *   使采集层无论放在目录树的哪一层都能找到外部资产。
 *
 * 本文件位置约定：<root>/src/inspection/paths.js
 */
const fs = require('fs');
const path = require('path');

/**
 * 部署根 = 向上三级到医院信息科部署根目录。
 * 若设置了环境变量 HOSPITAL_IT_ROOT 则优先使用，便于测试与非常规布局。
 */
function root() {
  const env = process.env.HOSPITAL_IT_ROOT;
  if (env && env.trim()) return path.resolve(env.trim());
  // __dirname = <root>/src/inspection → 上溯两级即为部署根
  // （曾误写三级，导致解析到 D:\，secrets 与 wmitools 全部找不到）
  return path.resolve(__dirname, '..', '..');
}

/** secrets 目录：KeyVault.exe + master.key（DPAPI 主密钥） */
function secretsDir() { return path.join(root(), 'secrets'); }
function keyVaultExe() { return path.join(secretsDir(), 'KeyVault.exe'); }
function masterKeyFile() { return path.join(secretsDir(), 'master.key'); }

/** wmitools 目录：WmiQuery.exe（Windows WMI 采集用） */
function wmitoolsDir() { return path.join(root(), 'wmitools'); }
function wmiQueryExe() { return path.join(wmitoolsDir(), 'WmiQuery.exe'); }

/** 报告输出目录（默认 <root>/data/reports，可被配置覆盖） */
function reportsDir() { return path.join(root(), 'data', 'reports'); }

/** 数据采集层目录：src/inspection/lib */
function inspectionDir() { return path.resolve(__dirname, '..'); }
function libDir() { return path.join(inspectionDir(), 'lib'); }

/**
 * 启动时自检：列出关键的外部资产是否存在。
 * 供 diagnose 与 server.js 的启动检查调用 —— 缺任何一个都意味着
 * 加密凭据或 Windows 采集会失败，必须在启动阶段就明确暴露，而不是等到巡检时才报错。
 */
function audit() {
  const items = [
    { key: 'secretsDir', label: '密钥目录', p: secretsDir() },
    { key: 'KeyVault.exe', label: 'DPAPI 密钥工具', p: keyVaultExe() },
    { key: 'master.key', label: '主密钥文件', p: masterKeyFile() },
    { key: 'wmitoolsDir', label: 'WMI 工具目录', p: wmitoolsDir() },
    { key: 'WmiQuery.exe', label: 'WMI 查询工具', p: wmiQueryExe() }
  ];
  const rows = items.map((it) => {
    let ok = false;
    try { ok = fs.existsSync(it.p); } catch (e) { ok = false; }
    return { key: it.key, label: it.label, path: it.p, exists: ok };
  });
  const missing = rows.filter((r) => !r.exists);
  return { root: root(), rows: rows, missing: missing, ok: missing.length === 0 };
}

module.exports = {
  root, secretsDir, keyVaultExe, masterKeyFile,
  wmitoolsDir, wmiQueryExe, reportsDir,
  inspectionDir, libDir, audit
};
