'use strict';
/**
 * device-source.js —— 调度器的数据源（阶段 3）
 *
 * 对外只有一个函数，返回 { servers, global }，与阶段 2 的 config.json 读取器完全同形，
 * 调度器因此不需要知道数据到底来自数据库还是文件。
 *
 * 选择逻辑：
 *   1. 环境变量 INSPECTION_SOURCE=json  → 强制文件模式（应急用，无需改代码）
 *   2. it_inspect_settings.config_version > 0 且能读到设备 → 数据库模式
 *   3. 其余情况 → 回退文件模式（阶段 2 的行为，保证巡检不会因为台账出问题就停摆）
 *
 * 为什么不以「表里有数据」作为判据：管理员完全可能合法地把设备全部停用或删空，
 * 那时若自动切回 config.json，反而会重新纳管一批本已下线的机器。
 * 因此用显式的 config_version 作为开关 —— 想回滚就把它清零，语义明确。
 */
const repo = require('./device-repo');
const jsonSource = require('./config-source');

function forcedMode() {
  return String(process.env.INSPECTION_SOURCE || '').toLowerCase();
}

async function loadJson() {
  const cfg = await jsonSource.load();
  const out = { servers: cfg.servers || [], global: cfg.global || {} };
  out.__source = 'json';
  return out;
}

async function loadDb() {
  const cfg = await repo.buildConfig();
  cfg.__source = 'db';
  return cfg;
}

async function load() {
  const mode = forcedMode();
  if (mode === 'json') {
    console.log('>>> [巡检数据源] 环境变量指定文件模式');
    return loadJson();
  }
  if (mode === 'db') return loadDb();

  if (repo.dbModeReady()) {
    try {
      const cfg = await loadDb();
      if (cfg.__keyError) {
        console.error('>>> [巡检数据源] 主密钥异常（设备仍会返回，但加密口令的那几台会各自报错）：' + cfg.__keyError);
      }
      return cfg;
    } catch (e) {
      console.error('>>> [巡检数据源] 台账读取失败，回退文件模式：' + ((e && e.message) || e));
      return loadJson();
    }
  }
  return loadJson();
}

/**
 * 当前生效模式，供健康检查与启动横幅提示。
 * 必须保持同步：实现里只有一次布尔判断，加 async 会让它返回 Promise，
 * 调用方拿到的就不是 'db'/'json' 而是对象 —— 启动横幅因此永远显示"配置文件"。
 */
function currentMode() {
  const mode = forcedMode();
  if (mode === 'json') return 'json';
  if (mode === 'db') return 'db';
  return repo.dbModeReady() ? 'db' : 'json';
}

module.exports = { load, currentMode, createSource: () => load, loadDb, loadJson };
