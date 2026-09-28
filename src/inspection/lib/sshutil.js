'use strict';
/**
 * SSH 连接与命令执行工具（Linux / Windows-OpenSSH 共用）
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('ssh2');

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * 建立 SSH 连接，支持密码与私钥两种认证方式
 */
function sshConnect(server, timeoutMs) {
  return new Promise((resolve, reject) => {
    const auth = server.auth || {};
    const baseCfg = {
      host: server.host,
      port: server.port || 22,
      username: auth.username,
      readyTimeout: Math.max(5000, timeoutMs),
      authTimeout: Math.max(5000, timeoutMs),
      keepaliveInterval: 15000
    };
    if (auth.type === 'key') {
      const keyPath = expandHome(auth.private_key_path);
      try {
        baseCfg.privateKey = fs.readFileSync(keyPath);
      } catch (e) {
        reject(new Error('无法读取私钥文件: ' + keyPath + ' (' + e.message + ')'));
        return;
      }
      if (auth.passphrase) baseCfg.passphrase = auth.passphrase;
    } else {
      baseCfg.password = auth.password;
      baseCfg.tryKeyboard = true;
      baseCfg.onKeyboardInteractive = (name, instr, lang, prompts, cb) => {
        cb(prompts.map(() => auth.password));
      };
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('SSH 连接超时 (' + Math.round(timeoutMs / 1000) + '秒)'));
    }, timeoutMs + 5000);
    const fail = (e) => { clearTimeout(timer); if (!settled) { settled = true; reject(e); } };
    const ok = (c) => { clearTimeout(timer); if (!settled) { settled = true; resolve(c); } };

    function tryConnect(cfg) {
      return new Promise((res, rej) => {
        const conn = new Client();
        let failed = false;
        // 持久监听：连接各阶段的 socket 错误都被接住，避免未捕获异常崩掉进程
        conn.on('error', (err) => {
          if (!failed) {
            failed = true;
            try { conn.end(); } catch (e) { /* 忽略 */ }
            rej(err);
          }
          // 后续错误静默吞掉（如清理期间的二次重置）
        });
        conn.on('keyboard-interactive', (name, instr, lang, prompts, cb) => {
          cb(prompts.map(() => (auth.password || '')));
        });
        conn.once('ready', () => res(conn));
        conn.connect(cfg);
      });
    }

    // 先默认算法；握手算法不匹配时（老设备/网络设备）回退兼容算法集重试
    tryConnect(Object.assign({}, baseCfg)).then(ok).catch((e1) => {
      if (settled) return;
      const msg = String((e1 && e1.message) || e1);
      if (!/handshake|key exchange|no matching|HANDSHAKE_FAILED|algorithms/i.test(msg)) {
        fail(e1);
        return;
      }
      const legacy = Object.assign({}, baseCfg, {
        algorithms: {
          kex: ['diffie-hellman-group14-sha256', 'diffie-hellman-group16-sha512', 'diffie-hellman-group15-sha512', 'diffie-hellman-group-exchange-sha256', 'diffie-hellman-group-exchange-sha1', 'diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1', 'ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'],
          serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ssh-dss', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'],
          cipher: ['aes128-ctr', 'aes192-ctr', 'aes256-ctr', 'aes128-cbc', '3des-cbc'],
          hmac: ['hmac-sha2-256', 'hmac-sha1', 'hmac-md5'],
          compress: ['none', 'zlib@openssh.com']
        }
      });
      tryConnect(legacy).then(ok).catch((e2) => fail(e2));
    });
  });
}

/**
 * 在已连接的 SSH 会话上执行命令，永不 reject，统一返回 { stdout, stderr, code }
 */
function sshExec(conn, command, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    conn.exec(command, (err, stream) => {
      if (err) {
        done({ stdout: '', stderr: String((err && err.message) || err), code: -1 });
        return;
      }
      let stdout = '';
      let stderr = '';
      let lastLen = 0;
      let lastChange = Date.now();
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) { /* 忽略 */ }
        const got = stdout.length;
        done({ stdout, stderr: stderr + '\n[命令执行超时，已截断' + (got > 0 ? '，已收到 ' + got + ' 字节部分输出]' : ']'), code: -1, timedOut: true });
      }, timeoutMs);
      // 静默检测：已有输出且 4 秒无新数据（部分设备输出完毕后不关闭流），视为命令完成
      const silence = setInterval(() => {
        if (stdout.length > lastLen) { lastLen = stdout.length; lastChange = Date.now(); return; }
        if (/----\s*More\s*----/i.test(stdout.slice(-80))) {
          try { stream.write(' '); } catch (e) { /* 忽略 */ }
          lastChange = Date.now();
        }
        if (stdout.length > 0 && Date.now() - lastChange > 4000) {
          clearInterval(silence);
          clearTimeout(timer);
          try { stream.close(); } catch (e) { /* 忽略 */ }
          done({ stdout, stderr, code: 0 });
        }
      }, 500);
      stream.on('data', (d) => {
        stdout += d.toString();
        if (stdout.length > 500000) stdout = stdout.slice(0, 500000);
      });
      stream.stderr.on('data', (d) => { stderr += d.toString(); });
      stream.on('error', (e2) => {
        clearInterval(silence);
        clearTimeout(timer);
        done({ stdout, stderr: stderr + '\n[命令流异常：' + ((e2 && e2.message) || e2) + ']', code: -1 });
      });
      stream.stderr.on('error', () => { /* 静默 */ });
      stream.on('close', (code) => {
        clearInterval(silence);
        clearTimeout(timer);
        done({ stdout, stderr, code });
      });
    });
  });
}

/** 与 sshExec 相同，但返回原始字节 Buffer，便于按目标系统编码（如 GBK）解码 */
function sshExecRaw(conn, command, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    conn.exec(command, (err, stream) => {
      if (err) {
        done({ stdout: Buffer.alloc(0), stderr: String((err && err.message) || err), code: -1 });
        return;
      }
      const chunks = [];
      let total = 0;
      let stderr = '';
      // 同时保留 stderr 原始字节：中文 Windows 的 cmd/powershell 错误信息是 GBK，
      // 按 UTF-8 拼串会产生乱码，调用方可用 stderrRaw 自行按 GBK 解码
      const errChunks = [];
      let errTotal = 0;
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) { /* 忽略 */ }
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr: stderr + '\n[命令执行超时，已截断]', code: -1, timedOut: true });
      }, timeoutMs);
      stream.on('data', (d) => {
        if (total < 500000) { chunks.push(d); total += d.length; }
      });
      stream.stderr.on('data', (d) => {
        stderr += d.toString();
        if (errTotal < 200000) { errChunks.push(d); errTotal += d.length; }
      });
      stream.on('error', (e2) => {
        clearTimeout(timer);
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr: stderr + '\n[命令流异常：' + ((e2 && e2.message) || e2) + ']', code: -1 });
      });
      stream.stderr.on('error', () => { /* 静默 */ });
      stream.on('close', (code) => {
        clearTimeout(timer);
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr, code });
      });
    });
  });
}

/**
 * 与 sshExecRaw 相同，但通过 channel 的 stdin 把文本写入远端进程（发送 EOF），
 * 再读取 stdout/stderr。用于"脚本体过长、放不进命令行"的场景：把脚本经 stdin 喂给
 * `powershell -Command -`，命令行本身只有几十字符，绕开远端 cmd.exe 的 8191 字符上限。
 * 永不 reject，统一返回 { stdout(Buffer), stderrRaw(Buffer), stderr, code }。
 */
function sshExecStdin(conn, command, stdinText, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    conn.exec(command, (err, stream) => {
      if (err) {
        done({ stdout: Buffer.alloc(0), stderr: String((err && err.message) || err), code: -1 });
        return;
      }
      const chunks = [];
      let total = 0;
      let stderr = '';
      const errChunks = [];
      let errTotal = 0;
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) { /* 忽略 */ }
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr: stderr + '\n[命令执行超时，已截断]', code: -1, timedOut: true });
      }, timeoutMs);
      stream.on('data', (d) => { if (total < 500000) { chunks.push(d); total += d.length; } });
      stream.stderr.on('data', (d) => {
        stderr += d.toString();
        if (errTotal < 200000) { errChunks.push(d); errTotal += d.length; }
      });
      stream.on('error', (e2) => {
        clearTimeout(timer);
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr: stderr + '\n[命令流异常：' + ((e2 && e2.message) || e2) + ']', code: -1 });
      });
      stream.stderr.on('error', () => { /* 静默 */ });
      stream.on('close', (code) => {
        clearTimeout(timer);
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr, code });
      });
      // 写入 stdin 并发送 EOF；脚本为 ASCII，按 UTF-8 写入到远端后字节逐位一致
      try {
        stream.end(Buffer.from(stdinText, 'utf8'));
      } catch (e) {
        clearTimeout(timer);
        done({ stdout: Buffer.concat(chunks, total), stderrRaw: Buffer.concat(errChunks, errTotal), stderr: stderr + '\n[stdin 写入失败：' + ((e && e.message) || e) + ']', code: -1 });
      }
    });
  });
}

/** 用 shell 通道（交互式）执行单条命令，兼容不支持 exec 通道的网络设备 */
function sshShellExec(conn, command, timeoutMs) {
  timeoutMs = timeoutMs || 20000;
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    conn.shell({ term: 'vt100', cols: 200, rows: 50 }, (err, stream) => {
      if (err) {
        done({ stdout: '', stderr: String((err && err.message) || err), code: -1 });
        return;
      }
      let out = '';
      const timer = setTimeout(() => {
        try { stream.close(); } catch (e) { /* 忽略 */ }
        done({ stdout: out, stderr: '', code: 0 });
      }, timeoutMs);
      stream.on('data', (d) => {
        out += d.toString();
        if (out.length > 300000) out = out.slice(-300000);
      });
      stream.stderr.on('data', () => { /* 静默 */ });
      stream.stderr.on('error', () => { /* 静默 */ });
      stream.on('error', (e2) => {
        clearTimeout(timer);
        done({ stdout: out, stderr: String((e2 && e2.message) || e2), code: -1 });
      });
      stream.on('close', () => {
        clearTimeout(timer);
        done({ stdout: out, stderr: '', code: 0 });
      });
      stream.write(command + '\n');
    });
  });
}

/** 去掉 shell 通道输出中的命令回显行与结尾提示符行 */
function stripShellEcho(text, command) {
  const lines = String(text || '').split(/\r?\n/);
  const cmdTrim = String(command).trim();
  const filtered = lines.filter((l) => {
    const t = l.trim();
    if (t === cmdTrim) return false;
    if (/^[<\[][^\n]{0,80}[>\]]$/.test(t)) return false; // 设备提示符 <xxx> / [xxx]
    if (/^[\w.\-()]+[>#]\s*$/.test(t)) return false;     // 通用提示符 xxx# / xxx>
    return true;
  });
  return filtered.join('\n');
}

/** 把常见 SSH 错误翻译成更易懂的中文提示 */
function friendlySshError(e) {
  const m = String((e && e.message) || e);
  if (/all configured authentication methods failed|authentication/i.test(m)) {
    return '认证失败，请检查用户名/密码/私钥是否正确 (' + m + ')';
  }
  if (/timed out|timeout/i.test(m)) {
    return '连接超时，请检查网络、IP 和 SSH 端口 (' + m + ')';
  }
  if (/ECONNREFUSED/.test(m)) {
    return '连接被拒绝，目标服务器可能未开启 SSH 服务或端口不对 (' + m + ')';
  }
  if (/ECONNRESET/.test(m)) {
    return '连接被对方重置（网络中断或设备主动断开），请检查网络稳定性或稍后重试 (' + m + ')';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) {
    return '无法解析主机名，请检查 host 填写是否正确 (' + m + ')';
  }
  if (/EHOSTUNREACH|ENETUNREACH/.test(m)) {
    return '网络不可达，请检查本机到目标服务器的网络 (' + m + ')';
  }
  if (/ECONNRESET/.test(m)) {
    return '连接被目标服务器重置，可能触发了对方的安全策略 (' + m + ')';
  }
  return m;
}

module.exports = { sshConnect, sshExec, sshExecRaw, sshExecStdin, sshShellExec, stripShellEcho, friendlySshError, expandHome };
