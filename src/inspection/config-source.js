'use strict';
/**
 * config-source.js —— 阶段 2 的设备数据源：从 JSON 配置文件读取
 *
 * 阶段 3 设备台账入库后，会被 device-repo 的 data source 替换；
 * 两者返回相同的形状 { servers, global }，调度器无需感知差异。
 *
 * 保留文件读取是为了回退能力：台账出问题（表空 / config_version=0）时，
 * 仍可退回文件模式，不至于让巡检整体停摆。
 */
const fs = require('fs');
const path = require('path');
const inspect = require('./inspect');
const secret = require('./lib/secret');

const DEFAULT_FILE = path.join(require('./paths').root(), 'data', 'inspection.json');

/**
 * 读取配置并完成凭据解密。
 * 注意：解密必须在主进程完成（KeyVault.exe 走 DPAPI，进程内缓存只起一次子进程），
 * 明文口令不应出现在任何磁盘文件或日志中。
 */
async function load(file) {
  const f = file || process.env.INSPECTION_CONFIG || DEFAULT_FILE;
  if (!fs.existsSync(f)) {
    throw new Error('巡检配置文件不存在：' + f + '（阶段 3 后将改为读设备台账）');
  }
  const cfg = inspect.loadConfig(f);
  const r = await secret.decryptConfig(cfg);
  return r.config;
}

function createSource(file) {
  return async function deviceSource() {
    const cfg = await load(file);
    return { servers: cfg.servers || [], global: cfg.global || {} };
  };
}

module.exports = { load, createSource, DEFAULT_FILE };
