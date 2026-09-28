'use strict';
/**
 * secret.js —— 设备口令的解密与配置脱敏
 *
 * 设计要点：
 * 1. 主密钥不在磁盘上以明文存在：由 secrets/KeyVault.exe 用 Windows DPAPI(LocalMachine)
 *    封装保存，本模块通过一次子进程调用取出，仅驻留内存。
 *    （不用 PowerShell 中转，避免安全软件拦截——本项目 Windows 采集早年正是因此改用 wmic。）
 * 2. 解密在 Node 内完成：取到主密钥后不再反复起子进程。
 *    15 台设备 × 每 60 秒轮询，若每条口令都起一次进程，开销与延迟都不可接受。
 * 3. 向后兼容明文：值不以 enc:v1: 开头时原样返回。
 *    这样加密改造不会让现有配置立刻失效，可以逐台迁移。
 * 4. 口令格式与 C# 侧 KeyVault.exe 完全一致，已做跨语言互通验证：
 *      enc:v1:<base64(salt16 | iv16 | ciphertext | hmac32)>
 *      PBKDF2-HMAC-SHA256(masterKey, salt, 100000) → 64B，前 32 加密、后 32 HMAC
 *      HMAC 覆盖 salt|iv|ct，先验完整性再解密
 */
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const PREFIX = 'enc:v1:';
const ITER = 100000;

// 合并后位置变为 <root>/src/inspection/lib/，故经 paths.js 从部署根解析，
// 不再用 path.join(__dirname, '..') —— 那会指向 src/inspection/secrets（不存在）
const paths = require('../paths');
const KEYVAULT = paths.keyVaultExe();
const KEY_FILE = paths.masterKeyFile();

/** 主密钥缓存：null=未取，Buffer=已取，'error:<msg>'=取失败（缓存错误避免反复起进程） */
let masterKeyCache = null;
let keyFingerprint = null;

/** 是否已存在加密密钥库（用于判断当前部署是否启用了加密） */
function hasKeyFile() {
  try { return fs.existsSync(KEY_FILE); } catch (e) { return false; }
}

/** 密钥文件路径（供提示与工具使用） */
function keyFilePath() { return KEY_FILE; }
function keyVaultPath() { return KEYVAULT; }

/**
 * 全新部署自愈：secrets/master.key 不存在时，用 KeyVault.exe 在本机现场生成一把。
 *
 * 为什么必须现场生成：主密钥经 Windows DPAPI(LocalMachine) 封装，只能被生成它的那台机器解开，
 * 因此部署包里**不能**预置 master.key（拷到别的机器必然报「DPAPI 上下文不匹配」）。
 * 正确做法是包里不带密钥，首次启动时在本机生成 —— 这是「任意电脑可部署」的关键。
 */
let ensurePromise = null;

function ensureKeyFileAsync() {
  if (fs.existsSync(KEY_FILE)) return Promise.resolve(true);
  if (!fs.existsSync(KEYVAULT)) return Promise.resolve(false);
  // 并发去重：启动阶段 server.js 与巡检调度器会同时要密钥，
  // 若各起一次 generate，其中一个必然失败并被缓存成永久错误。
  if (ensurePromise) return ensurePromise;

  ensurePromise = new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const child = execFile(KEYVAULT, ['generate', KEY_FILE], {
      windowsHide: true, timeout: 15000
    }, (err) => fin(!err && fs.existsSync(KEY_FILE)));
    // 吞掉后续错误，避免二次异常导致进程崩溃
    if (child && typeof child.on === 'function') child.on('error', () => fin(false));
  }).then((v) => {
    if (!v) ensurePromise = null; // 失败不缓存，允许后续重试
    return v;
  });
  return ensurePromise;
}

/**
 * 取主密钥（异步、带缓存）。失败时返回 { ok:false, error }，绝不抛异常中断巡检。
 * 整个进程生命周期内只会起一次 KeyVault.exe 子进程，之后走内存缓存。
 * 注意：返回值仅供本模块内部使用，不要把 key 写入日志。
 */
function loadMasterKeyAsync() {
  return new Promise((resolve) => {
    if (masterKeyCache && Buffer.isBuffer(masterKeyCache)) {
      return resolve({ ok: true, key: masterKeyCache, cached: true });
    }
    if (typeof masterKeyCache === 'string' && masterKeyCache.indexOf('error:') === 0) {
      return resolve({ ok: false, error: masterKeyCache.slice(6), cached: true });
    }
    if (!fs.existsSync(KEYVAULT)) {
      const msg = '未找到密钥工具 secrets/KeyVault.exe，无法解密设备口令。' +
        '该工具随程序分发，请确认部署包完整解压（缺失会导致所有加密口令的设备巡检失败）。';
      masterKeyCache = 'error:' + msg;
      return resolve({ ok: false, error: msg });
    }
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; resolve(r); } };

    // 超时兜底：子进程若被安全软件挂起，不能让巡检永久卡死
    const unprotectThenResolve = () => {
      const child = execFile(KEYVAULT, ['unprotect', KEY_FILE], {
        windowsHide: true, timeout: 15000, maxBuffer: 1024 * 64
      }, (err, stdout, stderr) => {
        if (err) {
          // DPAPI 上下文不匹配（密钥来自另一台机器）是最常见原因，给出可操作指引
          const se = String(stderr || '').trim();
          let msg = '读取主密钥失败：' + (se || err.message || String(err));
          if (/另一台机器|LocalMachine|DPAPI|Unprotect/i.test(se + msg)) {
            msg += '（提示：LocalMachine 作用域的密钥不能跨机使用。' +
              '若本机是新服务器，请在原服务器执行 export 导出迁移包，再在本机 import。）';
          }
          masterKeyCache = 'error:' + msg;
          return finish({ ok: false, error: msg });
        }
        const b64 = String(stdout || '').trim();
        if (!b64) {
          const msg = '密钥工具未返回主密钥';
          masterKeyCache = 'error:' + msg;
          return finish({ ok: false, error: msg });
        }
        let key;
        try { key = Buffer.from(b64, 'base64'); } catch (e) {
          const msg = '主密钥格式异常：' + e.message;
          masterKeyCache = 'error:' + msg;
          return finish({ ok: false, error: msg });
        }
        if (key.length !== 32) {
          const msg = '主密钥长度异常（期望 32 字节，实际 ' + key.length + '）';
          masterKeyCache = 'error:' + msg;
          return finish({ ok: false, error: msg });
        }
        masterKeyCache = key;
        // 指纹用于人工核对，不泄露密钥本身
        keyFingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 16);
        finish({ ok: true, key, cached: false });
      });
      // 吞掉后续错误，避免二次异常导致进程崩溃（本项目历史踩过的坑）
      if (child && typeof child.on === 'function') child.on('error', () => {});
    };

    if (!fs.existsSync(KEY_FILE)) {
      // 全新部署：本机还没有主密钥 → 现场生成一把再取（DPAPI 绑定本机，故不随包分发）
      ensureKeyFileAsync().then((ok) => {
        if (!ok) {
          const msg = '未找到主密钥文件 secrets/master.key，且自动生成失败。' +
            '请以管理员身份执行：secrets\\KeyVault.exe generate secrets\\master.key；' +
            '若这是迁移到新服务器：LocalMachine 作用域的密钥不能跨机使用，' +
            '请在原服务器执行 export 导出迁移包，再在本机 import。';
          masterKeyCache = 'error:' + msg;
          return finish({ ok: false, error: msg });
        }
        unprotectThenResolve();
      });
      return;
    }

    unprotectThenResolve();
  });
}

/** 主密钥指纹（仅在成功取到密钥后有值），用于日志中核对密钥身份 */
function fingerprint() { return keyFingerprint; }

/**
 * 解密单个值。
 * - 非 enc:v1: 前缀：原样返回（向后兼容明文）
 * - 解密失败：返回 { error }，调用方决定如何降级
 */
function decryptValue(value, masterKey) {
  if (typeof value !== 'string') return { ok: true, value, encrypted: false };
  if (value.indexOf(PREFIX) !== 0) return { ok: true, value, encrypted: false };

  let blob;
  try { blob = Buffer.from(value.slice(PREFIX.length), 'base64'); }
  catch (e) { return { ok: false, error: '密文 base64 解码失败：' + e.message }; }
  if (blob.length < 16 + 16 + 32) return { ok: false, error: '密文长度不足，数据可能已损坏' };

  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 32);
  const ct = blob.subarray(32, blob.length - 32);
  const mac = blob.subarray(blob.length - 32);

  let derived;
  try { derived = crypto.pbkdf2Sync(masterKey, salt, ITER, 64, 'sha256'); }
  catch (e) { return { ok: false, error: '密钥派生失败：' + e.message }; }
  const encKey = derived.subarray(0, 32);
  const macKey = derived.subarray(32, 64);

  // 先验 HMAC 再解密：密文被篡改时立即失败，不会把垃圾数据当口令去登录设备
  const covered = Buffer.concat([salt, iv, ct]);
  let expect;
  try { expect = crypto.createHmac('sha256', macKey).update(covered).digest(); }
  catch (e) { return { ok: false, error: '完整性校验计算失败：' + e.message }; }
  if (expect.length !== mac.length || !crypto.timingSafeEqual(expect, mac)) {
    return { ok: false, error: '完整性校验失败：口令数据被篡改，或主密钥与加密时不一致' };
  }

  try {
    const dec = crypto.createDecipheriv('aes-256-cbc', encKey, iv);
    const pt = Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
    return { ok: true, value: pt, encrypted: true };
  } catch (e) {
    return { ok: false, error: '解密失败：' + e.message };
  }
}

/** 加密单个值（与 C# 侧同约定），供迁移工具与测试使用 */
function encryptValue(plain, masterKey) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(16);
  const derived = crypto.pbkdf2Sync(masterKey, salt, ITER, 64, 'sha256');
  const encKey = derived.subarray(0, 32);
  const macKey = derived.subarray(32, 64);
  const cip = crypto.createCipheriv('aes-256-cbc', encKey, iv);
  const ct = Buffer.concat([cip.update(Buffer.from(String(plain == null ? '' : plain), 'utf8')), cip.final()]);
  const covered = Buffer.concat([salt, iv, ct]);
  const mac = crypto.createHmac('sha256', macKey).update(covered).digest();
  return PREFIX + Buffer.concat([covered, mac]).toString('base64');
}

/** 需要解密的字段路径（auth 段与 db 段） */
const SECRET_PATHS = [
  ['auth', 'password'],
  ['auth', 'passphrase'],
  ['db', 'password']
];

/**
 * 解密一台设备配置中的所有口令字段（就地修改传入对象的深拷贝）。
 * 返回 { server, errors:[{field,error}] }
 * 解密失败的字段置为 null 并记录错误——宁可让该设备巡检失败并给出明确原因，
 * 也不要把密文当口令去登录设备（那会产生难以理解的认证失败）。
 */
function decryptServer(rawServer, masterKey) {
  const s = JSON.parse(JSON.stringify(rawServer || {}));
  const errors = [];
  for (const [sec, field] of SECRET_PATHS) {
    if (!s[sec] || typeof s[sec] !== 'object') continue;
    const v = s[sec][field];
    if (typeof v !== 'string' || !v) continue;
    const r = decryptValue(v, masterKey);
    if (r.ok) {
      s[sec][field] = r.value;
    } else {
      s[sec][field] = null;
      errors.push({ field: sec + '.' + field, error: r.error });
      // 就地标记，理由同 decryptConfig 的主密钥不可用分支：
      // 避免该设备拿 null 口令去登录而报出误导性的"认证失败"。
      s._secretError = sec + '.' + field + ' 解密失败：' + r.error;
    }
  }
  return { server: s, errors };
}

/**
 * 对整个配置做解密，返回 { config, errors:[{server,field,error}], usedEncryption, plaintext }
 * usedEncryption: 实际解开了多少条加密口令
 * plaintext: 仍为明文的口令条数（用于提示用户迁移）
 */
async function decryptConfig(config) {
  const out = { config, errors: [], usedEncryption: 0, plaintext: 0, keyError: null };
  const servers = (config && Array.isArray(config.servers)) ? config.servers : [];
  if (!servers.length) return out;

  // 先统计有多少条口令、其中多少是密文——决定要不要去取主密钥
  let total = 0, encCount = 0;
  for (const s of servers) {
    for (const [sec, field] of SECRET_PATHS) {
      const v = s && s[sec] ? s[sec][field] : null;
      if (typeof v === 'string' && v) { total++; if (v.indexOf(PREFIX) === 0) encCount++; }
    }
  }
  out.plaintext = total - encCount;
  if (encCount === 0) return out;   // 全明文：完全不碰密钥工具，保持原有行为

  // 统一在深拷贝上操作：无论解密成功还是失败，都不得就地修改调用方传入的对象。
  // 这一点对 monitor.js 尤其重要——配置重载失败时它要"继续使用当前配置"，
  // 若传入对象已被置空口令并注入标记，旧配置也就一起被破坏了。
  const cfg = JSON.parse(JSON.stringify(config));
  const outServers = Array.isArray(cfg.servers) ? cfg.servers : [];

  const kr = await loadMasterKeyAsync();
  if (!kr.ok) {
    out.keyError = kr.error;
    // 有密文却取不到主密钥：逐台标记错误，让报告与大屏能明确显示原因
    for (const s of outServers) {
      for (const [sec, field] of SECRET_PATHS) {
        const v = s && s[sec] ? s[sec][field] : null;
        if (typeof v === 'string' && v.indexOf(PREFIX) === 0) {
          out.errors.push({
            server: (s && s.name) || '(未命名)', host: s && s.host,
            field: sec + '.' + field, error: kr.error
          });
          if (s[sec]) s[sec][field] = null;
          // 就地标记该设备：口令已不可用。
          // 标记必须在本模块完成（而非调用方），否则 monitor.js 这类
          // 直接使用解密结果的入口拿不到标记，会退化成拿 null 口令去登录设备，
          // 报出误导性的"认证失败"而不是真实的主密钥问题。
          s._secretError = field + ' 解密失败：' + kr.error;
        }
      }
    }
    out.config = cfg;
    return out;
  }

  for (let i = 0; i < (cfg.servers || []).length; i++) {
    const r = decryptServer(cfg.servers[i], kr.key);
    cfg.servers[i] = r.server;
    for (const e of r.errors) {
      out.errors.push({
        server: (r.server && r.server.name) || '(未命名)', host: r.server && r.server.host,
        field: e.field, error: e.error
      });
    }
  }
  out.config = cfg;
  out.usedEncryption = encCount;
  return out;
}

/**
 * 生成「可安全展示」的配置副本：所有口令字段替换为掩码。
 * 用于配置导出（不含凭据）、日志输出、网页展示，避免口令意外外泄。
 */
function redactConfig(config) {
  const c = JSON.parse(JSON.stringify(config || {}));
  for (const s of (c.servers || [])) {
    for (const [sec, field] of SECRET_PATHS) {
      if (!s[sec] || typeof s[sec] !== 'object') continue;
      const v = s[sec][field];
      if (typeof v !== 'string' || !v) continue;
      s[sec][field] = v.indexOf(PREFIX) === 0 ? '(已加密)' : '(明文)';
    }
  }
  return c;
}

/** 统计配置中的口令情况，供自检与迁移工具使用 */
function auditConfig(config) {
  const servers = (config && Array.isArray(config.servers)) ? config.servers : [];
  let total = 0, enc = 0, plain = 0;
  const plainServers = [];
  for (const s of servers) {
    let hasPlain = false;
    for (const [sec, field] of SECRET_PATHS) {
      const v = s && s[sec] ? s[sec][field] : null;
      if (typeof v === 'string' && v) {
        total++;
        if (v.indexOf(PREFIX) === 0) enc++;
        else { plain++; hasPlain = true; }
      }
    }
    if (hasPlain) plainServers.push((s && s.name) || '(未命名)');
  }
  return { devices: servers.length, total, encrypted: enc, plaintext: plain, plainServers };
}

/** 清除主密钥缓存（配置重载或测试时调用） */
function resetCache() { masterKeyCache = null; keyFingerprint = null; }

module.exports = {
  PREFIX, ITER, SECRET_PATHS,
  hasKeyFile, keyFilePath, keyVaultPath, fingerprint,
  loadMasterKeyAsync, ensureKeyFileAsync, decryptValue, encryptValue,
  decryptServer, decryptConfig, redactConfig, auditConfig, resetCache
};
