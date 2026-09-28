'use strict';
/**
 * init-deploy.js —— 新机器首次部署初始化（可选，start.bat 启动时也会自动做）
 *
 * 作用：
 *   1) 本机没有 secrets/master.key 时，用 KeyVault.exe 生成一把（DPAPI 绑定本机）
 *   2) 打印主密钥指纹，便于人工核对
 *   3) 提示下一步
 *
 * 用法：runtime\node.exe scripts\init-deploy.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const secret = require(path.join(ROOT, 'src', 'inspection', 'lib', 'secret.js'));

(async () => {
  const keyFile = secret.keyFilePath();
  const existed = fs.existsSync(keyFile);

  if (!existed) {
    process.stdout.write('未发现主密钥，正在为本机生成（DPAPI 绑定本机，不能跨机复用）...\n');
    const ok = await secret.ensureKeyFileAsync();
    if (!ok) {
      process.stdout.write('[失败] 主密钥生成失败。请以管理员身份运行本脚本，或手动执行：\n');
      process.stdout.write('  secrets\\KeyVault.exe generate secrets\\master.key\n');
      process.exit(1);
    }
    process.stdout.write('  已生成：' + keyFile + '\n');
    process.stdout.write('  [注意] 请离线备份一份该文件（U盘）。丢了它，所有已保存的设备口令都无法恢复。\n');
  } else {
    process.stdout.write('主密钥已存在：' + keyFile + '\n');
  }

  const kr = await secret.loadMasterKeyAsync();
  if (!kr.ok) {
    process.stdout.write('[失败] 主密钥不可用：' + kr.error + '\n');
    process.exit(1);
  }
  process.stdout.write('主密钥可用，指纹：' + secret.fingerprint() + '\n');
  process.stdout.write('\n初始化完成。下一步：\n');
  process.stdout.write('  1) 双击 start.bat 启动服务（默认 http://127.0.0.1:3131）\n');
  process.stdout.write('  2) 用 admin 登录，在「设备台账」里逐台录入设备与口令\n');
  process.stdout.write('  3) 口令会用本机的主密钥加密保存，换机器需重新录入或走 export/import\n');
})();
