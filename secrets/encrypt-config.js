'use strict';
/**
 * encrypt-config.js —— 把 config.json 中的明文设备口令批量加密
 *
 * 为什么需要：
 *   改造前口令以明文存放，任何能读到该文件的人都能直接登录机房设备。
 *   本工具就地加密，加密后文件被拷走也无法还原（主密钥由 Windows DPAPI 封装在本机）。
 *
 * 安全设计：
 *   - 加密前自动备份 config.json.bak_encrypt_<时间戳>，误操作可还原
 *   - 只改口令字段（auth.password / auth.passphrase / db.password），其余字段原样保留
 *   - 已加密的口令（enc:v1: 前缀）跳过，可重复执行（幂等）
 *   - 绝不把明文口令写入日志，统计只报数量
 *   - --dry-run 只报告将发生的变更，不写文件
 *
 * 用法：
 *   node secrets\encrypt-config.js                    加密项目目录下的 config.json
 *   node secrets\encrypt-config.js --config <路径>     指定配置文件
 *   node secrets\encrypt-config.js --dry-run          只预览，不写入
 *   node secrets\encrypt-config.js --audit            只统计加密/明文分布，不做变更
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const secret = require('../lib/secret');

const APP_DIR = path.join(__dirname, '..');
const KEYVAULT = path.join(APP_DIR, 'secrets', 'KeyVault.exe');
const KEY_FILE = path.join(APP_DIR, 'secrets', 'master.key');

function parseArgs(argv) {
  const a = { config: path.join(APP_DIR, 'config.json'), dryRun: false, audit: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--dry-run' || t === '-n') a.dryRun = true;
    else if (t === '--audit') a.audit = true;
    else if (t === '--config' && argv[i + 1]) a.config = path.resolve(argv[++i]);
    else if (t.startsWith('--config=')) a.config = path.resolve(t.slice(9));
    else if (t === '--help' || t === '-h') a.help = true;
  }
  return a;
}

function usage() {
  console.log([
    '用法：node secrets\\encrypt-config.js [选项]',
    '',
    '  --config <路径>   指定配置文件（默认项目目录下的 config.json）',
    '  --dry-run, -n     只预览将发生的变更，不写入文件',
    '  --audit           只统计加密/明文分布，不做任何变更',
    '  --help, -h        显示本帮助',
    '',
    '示例：',
    '  node secrets\\encrypt-config.js --audit      查看当前明文口令分布',
    '  node secrets\\encrypt-config.js --dry-run    预览加密效果',
    '  node secrets\\encrypt-config.js              执行加密（自动备份）'
  ].join('\n'));
}

/**
 * 确保主密钥文件存在。
 * @param {boolean} dryRun 预览模式下不生成密钥文件（避免"只预览"却产生副作用），
 *                         改为返回一把临时内存密钥，仅供计算预览密文使用。
 * @returns {{created:boolean, fingerprint?:string, ephemeral?:boolean}}
 */
function ensureKeyFile(dryRun) {
  if (!fs.existsSync(KEYVAULT)) {
    throw new Error('未找到密钥工具：' + KEYVAULT + '\n请确认部署包完整解压（secrets 目录应包含 KeyVault.exe）。');
  }
  if (fs.existsSync(KEY_FILE)) return { created: false };
  if (dryRun) {
    // 预览模式：不落盘生成密钥，用随机临时密钥演示加密效果
    return { created: false, ephemeral: true };
  }
  let out;
  try {
    out = execFileSync(KEYVAULT, ['generate', KEY_FILE], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  } catch (e) {
    const se = (e && e.stderr ? String(e.stderr) : '').trim();
    throw new Error('生成主密钥失败：' + (se || (e && e.message) || e));
  }
  return { created: true, fingerprint: String(out || '').trim() };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return 0; }

  console.log('>>> 配置文件：' + args.config);
  if (!fs.existsSync(args.config)) {
    console.error('配置文件不存在：' + args.config);
    return 1;
  }

  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (e) {
    console.error('配置文件解析失败（JSON 格式错误）：' + e.message);
    return 1;
  }

  const servers = Array.isArray(cfg.servers) ? cfg.servers : [];
  if (!servers.length) {
    console.error('配置中没有设备（servers 为空），无需加密。');
    return 1;
  }

  const audit = secret.auditConfig(cfg);
  console.log('>>> 设备 ' + audit.devices + ' 台，口令共 ' + audit.total + ' 条：已加密 ' + audit.encrypted + '，明文 ' + audit.plaintext);

  if (args.audit) {
    if (audit.plainServers.length) {
      console.log('>>> 仍为明文的设备：');
      audit.plainServers.forEach((n, i) => console.log('    ' + (i + 1) + '. ' + n));
    } else {
      console.log('>>> 所有口令均已加密，无明文残留。');
    }
    console.log('>>> 主密钥文件：' + (fs.existsSync(KEY_FILE) ? '存在（' + KEY_FILE + '）' : '不存在（尚未生成）'));
    return 0;
  }

  if (audit.plaintext === 0) {
    console.log('>>> 没有需要加密的明文口令，配置未变更。');
    return 0;
  }

  // 确保主密钥存在（预览模式不落盘）
  let kr;
  try {
    kr = ensureKeyFile(args.dryRun);
  } catch (e) {
    console.error(e.message);
    return 1;
  }

  let master;
  if (kr.ephemeral) {
    // 预览模式：用一次性随机密钥演示加密结果，不读写 secrets/master.key。
    // 这样「只预览」不会在磁盘上留下任何文件，符合 --dry-run 的承诺。
    master = require('crypto').randomBytes(32);
    console.log('>>> [dry-run] 使用一次性临时密钥预览，不会生成 secrets\\master.key');
  } else {
    if (kr.created) {
      console.log('>>> 已生成主密钥：' + KEY_FILE);
      console.log('    指纹：' + kr.fingerprint + '（记录此指纹，便于日后核对密钥身份）');
    } else {
      console.log('>>> 使用已存在的主密钥：' + KEY_FILE);
    }
    // 取主密钥用于加密
    secret.resetCache();
    const res = await secret.loadMasterKeyAsync();
    if (!res.ok) {
      console.error('读取主密钥失败：' + res.error);
      return 1;
    }
    master = res.key;
    console.log('>>> 主密钥指纹：' + secret.fingerprint());
  }

  let encCount = 0;
  const touched = [];
  for (const s of servers) {
    const hit = [];
    for (const [sec, field] of secret.SECRET_PATHS) {
      if (!s[sec] || typeof s[sec] !== 'object') continue;
      const v = s[sec][field];
      if (typeof v !== 'string' || !v) continue;
      if (v.indexOf(secret.PREFIX) === 0) continue;   // 已加密，幂等跳过
      s[sec][field] = secret.encryptValue(v, master);
      encCount++;
      hit.push(sec + '.' + field);
    }
    if (hit.length) touched.push(((s && s.name) || '(未命名)') + '：' + hit.join('、'));
  }

  console.log('>>> 本次加密 ' + encCount + ' 条口令，涉及 ' + touched.length + ' 台设备：');
  touched.forEach((t, i) => console.log('    ' + (i + 1) + '. ' + t));

  if (args.dryRun) {
    console.log('');
    console.log('>>> [dry-run] 未写入任何文件。去掉 --dry-run 参数即可执行加密。');
    return 0;
  }

  // 备份后写入
  const backup = args.config + '.bak_encrypt_' + stamp();
  try {
    fs.copyFileSync(args.config, backup);
  } catch (e) {
    console.error('备份原配置失败，为安全起见不写入：' + e.message);
    return 1;
  }
  console.log('>>> 已备份原配置：' + backup);

  // 加密后自检：立刻用主密钥解回一条，确认写入的密文可用
  // （防止因编码/换行等问题写出损坏的密文，导致之后全部设备巡检失败）
  let selfCheck = null;
  for (const s of servers) {
    for (const [sec, field] of secret.SECRET_PATHS) {
      const v = s[sec] && s[sec][field];
      if (typeof v === 'string' && v.indexOf(secret.PREFIX) === 0) { selfCheck = v; break; }
    }
    if (selfCheck) break;
  }
  if (selfCheck) {
    const rc = secret.decryptValue(selfCheck, master);
    if (!rc.ok) {
      console.error('加密自检失败，已回滚到备份：' + rc.error);
      try { fs.copyFileSync(backup, args.config); } catch (e) { /* 忽略 */ }
      return 1;
    }
  }

  try {
    fs.writeFileSync(args.config, JSON.stringify(cfg, null, 2), 'utf8');
  } catch (e) {
    console.error('写入配置失败（原文件未被修改）：' + e.message);
    return 1;
  }

  // 落盘后再次确认文件中已无明文口令
  let after;
  try {
    after = JSON.parse(fs.readFileSync(args.config, 'utf8'));
  } catch (e) {
    console.error('写入后无法解析配置，请立即用备份还原：' + backup + '\n原因：' + e.message);
    return 1;
  }
  const audit2 = secret.auditConfig(after);
  if (audit2.plaintext !== 0) {
    console.error('警告：写入后仍有 ' + audit2.plaintext + ' 条明文口令，请检查配置结构。备份在：' + backup);
    return 1;
  }

  console.log('');
  console.log('>>> 加密完成。当前状态：已加密 ' + audit2.encrypted + ' 条，明文 ' + audit2.plaintext + ' 条。');
  console.log('>>> 主密钥由 Windows DPAPI 封装在本机（LocalMachine 作用域），磁盘上没有明文密钥。');
  console.log('');
  console.log('重要提示：');
  console.log('  1. 请妥善备份主密钥，否则口令无法恢复：');
  console.log('       secrets\\KeyVault.exe export secrets\\master.key <迁移包路径> <传输口令>');
  console.log('     迁移包本身经传输口令加密，但请用安全方式保存，不要与 config.json 放在同一处。');
  console.log('  2. 迁移到新服务器时，需先 import 迁移包，再拷贝 config.json，顺序不能反。');
  console.log('  3. 确认巡检正常后再删除备份文件：' + backup);
  console.log('  4. 在图形界面里修改设备口令后，需重新执行本工具加密新口令。');
  return 0;
}

// 入口
main()
  .then((code) => process.exit(code || 0))
  .catch((e) => {
    console.error('执行异常：' + ((e && e.message) || e));
    process.exit(1);
  });
