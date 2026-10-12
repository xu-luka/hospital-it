'use strict';
// 统一认证：JWT 校验查合同库用户表（全系统唯一账号体系）
const crypto = require('crypto');
const fs = require('fs');
const config = require('../config');
const { db } = require('./db-contract');
// 权限判定与中间件都从 perm.js 再导出一份，路由侧只需 require('../auth') 一处
const { getRolePerms, requirePerm, guardModule, hasPerm } = require('./perm');

let secret = null;
function getSecret() {
  if (secret) return secret;
  if (process.env.JWT_SECRET) { secret = process.env.JWT_SECRET; return secret; }
  if (fs.existsSync(config.SECRET_FILE)) {
    secret = fs.readFileSync(config.SECRET_FILE, 'utf8').trim();
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(config.SECRET_FILE, secret, 'utf8');
    console.log('[auth] 已生成并持久化 JWT secret');
  }
  return secret;
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signJwt(payload, ttlSec) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = Object.assign({}, payload, { iat: now, exp: now + (ttlSec || config.TOKEN_TTL_SEC) });
  const h = base64url(Buffer.from(JSON.stringify(header)));
  const b = base64url(Buffer.from(JSON.stringify(body)));
  const sig = crypto.createHmac('sha256', getSecret()).update(h + '.' + b).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return h + '.' + b + '.' + sig;
}

function verifyJwt(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', getSecret()).update(parts[0] + '.' + parts[1]).digest('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!payload || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (e) { return null; }
}

// 认证中间件：Authorization: Bearer xxx
function authRequired(req, res, next) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  const payload = m ? verifyJwt(m[1]) : null;
  const userId = payload ? Number(payload.id) : 0;
  // 未登录 / token 无效 / payload 缺 id（旧系统 token 等）→ 统一 401
  if (!payload || !Number.isInteger(userId) || userId <= 0) {
    return res.status(401).json({ code: 401, message: '未登录或登录已过期' });
  }
  const row = db.prepare(
    `SELECT u.*, r.name AS role_name, r.code AS role_code FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.id = ?`
  ).get(userId);
  if (!row || row.is_active !== 1) return res.status(401).json({ code: 401, message: '账号不存在或已停用' });
  // 权限集合随请求带出（每次查库，不用缓存）：角色权限改了立刻生效，
  // 不需要让用户重新登录，也不用担心缓存不一致
  const permInfo = getRolePerms(row.role_id, row.role_code);
  // 兼容两套路由字段：合同系用 id/username/roleId/realName，问题系用 role_id/real_name/active
  req.user = {
    id: row.id,
    username: row.username,
    real_name: row.real_name || '',
    realName: row.real_name || '',
    role_id: row.role_id,
    roleId: row.role_id,
    role_name: row.role_name || '',
    roleName: row.role_name || '',
    role_code: row.role_code || '',
    roleCode: row.role_code || '',
    is_active: row.is_active,
    isActive: row.is_active === 1,
    active: row.is_active,
    phone: row.phone || '',
    created_at: row.created_at,
    perms: permInfo.perms,
    permsSource: permInfo.source,
  };
  next();
}

// 角色校验（旧写法，按写死的角色 ID 判断）。
// 新代码请用 requirePerm('模块.动作')：角色可以自由新增，写死 ID 的判定迟早会漏。
// 保留此函数只为兼容历史调用，勿在新路由中使用。
function requireRole(...roleIds) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ code: 401, message: '未登录' });
    const rid = req.user.role_id !== undefined ? req.user.role_id : req.user.roleId;
    if (roleIds.indexOf(rid) < 0) return res.status(403).json({ code: 403, message: '没有权限执行该操作' });
    next();
  };
}

module.exports = { signJwt, verifyJwt, authRequired, requireRole, requirePerm, guardModule, hasPerm, getRolePerms, getSecret };