'use strict';
/**
 * 书签管理离线自测（内存库 + 假密钥模块，不碰真实数据、不需要 KeyVault.exe）。
 *
 * 重点钉住三件「错了也不报错」的事：
 *   ① 密码字段的更新语义（不传=不动 / 传空=清空 / 传值=覆盖）——
 *      写错的话「只改个备注」就会把密码抹掉，而且没有任何提示；
 *   ② 出库整形里绝不能带 password_enc —— 一旦漏了，密码密文就随列表接口发给所有人；
 *   ③ 密钥不可用时要明确报错，绝不能回一个空字符串（那会被当成真实密码）。
 *
 * 运行：node scripts/bookmarks-selftest.js
 */
const path = require('path');
const assert = require('assert');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');

// ---- 顶掉 db-contract（CONTRACT_DB_FILE 硬编码，造不了临时库）----
const contractPath = require.resolve(path.join(ROOT, 'src', 'db-contract.js'));
require.cache[contractPath] = {
  id: contractPath, filename: contractPath, loaded: true, exports: { db: new DatabaseSync(':memory:') },
};

// ---- 顶掉密钥模块。假实现只做一次 base64，跑通的是调用链而不是密码学本身
//      （真实算法的互通性另有一批测试，见 secret 相关脚本）----
const secretPath = require.resolve(path.join(ROOT, 'src', 'inspection', 'lib', 'secret.js'));
const FAKE = {
  PREFIX: 'enc:v1:',
  ITER: 1000,
  loadMasterKeyAsync: () => Promise.resolve({ ok: true, key: Buffer.alloc(32, 7) }),
  encryptValue: (plain) => 'enc:v1:' + Buffer.from(String(plain), 'utf8').toString('base64'),
  decryptValue: (v) => {
    if (String(v).indexOf('enc:v1:') !== 0) return { ok: true, value: v, encrypted: false };
    try {
      return { ok: true, value: Buffer.from(String(v).slice(7), 'base64').toString('utf8'), encrypted: true };
    } catch (e) { return { ok: false, error: 'bad' }; }
  },
};
require.cache[secretPath] = { id: secretPath, filename: secretPath, loaded: true, exports: FAKE };

const repo = require('../src/bookmarks');

let pass = 0;
const fails = [];
function ok(name, fn) {
  try { fn(); pass++; } catch (e) { fails.push(name + ' → ' + e.message); }
}
async function okAsync(name, fn) {
  try { await fn(); pass++; } catch (e) { fails.push(name + ' → ' + e.message); }
}
function eq(a, b, msg) { assert.strictEqual(a, b, (msg || '') + ' 期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a)); }

(async () => {
  /* ==================== 1. 打开地址 ==================== */
  ok('openUrlOf：已带协议的原样保留', () => {
    eq(repo.openUrlOf('http://10.1.1.5:8080/his'), 'http://10.1.1.5:8080/his');
    eq(repo.openUrlOf('HTTPS://His.Hospital.Local'), 'HTTPS://His.Hospital.Local', '大小写不敏感');
  });
  ok('openUrlOf：只写 IP:端口 / 域名 时补 http://（内网系统几乎都是 http）', () => {
    eq(repo.openUrlOf('10.1.1.5:8080'), 'http://10.1.1.5:8080');
    eq(repo.openUrlOf('his.hospital.local/lis'), 'http://his.hospital.local/lis');
  });
  ok('openUrlOf：//host 形式不乱补', () => {
    eq(repo.openUrlOf('//10.1.1.5/oa'), '//10.1.1.5/oa');
  });
  ok('openUrlOf：空值回空串', () => {
    eq(repo.openUrlOf(''), '');
    eq(repo.openUrlOf('   '), '');
    eq(repo.openUrlOf(null), '');
  });
  ok('出库整形绝不带 password_enc', () => {
    const s = repo.shape({ id: 1, name: 'a', url: 'b', password_enc: 'enc:v1:secret' });
    assert.ok(!('password_enc' in s), '整形结果里出现了 password_enc —— 密文会随列表发给所有人');
    eq(s.has_password, 1);
    eq(s.open_url, 'http://b');
  });
  ok('无密码时 has_password 为 0', () => {
    eq(repo.shape({ id: 1, name: 'a', url: '', password_enc: '' }).has_password, 0);
  });

  /* ==================== 2. 密钥不可用时的降级 ==================== */
  await okAsync('加密：空密码不取密钥，直接存空', async () => {
    const r = await repo.encryptSecret('');
    eq(r.ok, true);
    eq(r.value, '');
  });
  await okAsync('加密 / 解密往返一致', async () => {
    const e = await repo.encryptSecret('P@ssw0rd 中文');
    eq(e.ok, true);
    assert.ok(e.value.indexOf('enc:v1:') === 0);
    const d = await repo.decryptSecret(e.value);
    eq(d.ok, true);
    eq(d.value, 'P@ssw0rd 中文');
    eq(d.encrypted, true);
  });
  await okAsync('解密：非密文（历史明文）原样返回，老数据不会立刻失效', async () => {
    const d = await repo.decryptSecret('老系统留下的明文口令');
    eq(d.ok, true);
    eq(d.value, '老系统留下的明文口令');
    eq(d.encrypted, false);
  });
  await okAsync('解密：空值返回空串而不是报错', async () => {
    const d = await repo.decryptSecret('');
    eq(d.ok, true);
    eq(d.value, '');
  });

  // 把假密钥模块换成「取不到主密钥」，验证失败分支 —— 换机器（DPAPI 不匹配）就是这个情形
  const realLoader = FAKE.loadMasterKeyAsync;
  FAKE.loadMasterKeyAsync = () => Promise.resolve({ ok: false, error: '主密钥不可用（模拟）' });
  await okAsync('密钥不可用时加密失败，且带出原因', async () => {
    const r = await repo.encryptSecret('x');
    eq(r.ok, false);
    assert.ok(/主密钥不可用/.test(r.error));
  });
  await okAsync('密钥不可用时解密密文要报错，绝不能回空口令', async () => {
    const r = await repo.decryptSecret('enc:v1:abc');
    eq(r.ok, false);
    assert.notStrictEqual(r.value, '', '返回了空字符串 —— 上游会把它当成真实密码');
    assert.ok(/主密钥不可用/.test(r.error));
  });
  await okAsync('密钥不可用时历史明文仍可读', async () => {
    const r = await repo.decryptSecret('plain-text');
    eq(r.ok, true);
    eq(r.value, 'plain-text');
  });
  FAKE.loadMasterKeyAsync = realLoader;

  /* ==================== 3. 增删改查 ==================== */
  let id1 = 0;
  await okAsync('新增：名称为空被拒', async () => {
    const e = await repo.encryptSecret('p');
    const r = repo.create({ name: '  ', url: 'x', password_enc: e.value }, { id: 1, username: 'admin' });
    eq(r.ok, false);
  });
  await okAsync('新增成功并落库（密码为密文）', async () => {
    const e = await repo.encryptSecret('HIS@2026');
    const r = repo.create({
      name: 'HIS 住院系统', url: '10.1.1.5:8080', group_name: '业务系统',
      username: 'hisadmin', note: '仅内网', password_enc: e.value,
    }, { id: 7, username: 'zhangsan', real_name: '张三' });
    eq(r.ok, true);
    id1 = r.id;
    const raw = repo.get(id1);
    assert.ok(String(raw.password_enc).indexOf('enc:v1:') === 0, '库里必须是密文');
    eq(raw.creator_name, '张三', '记录创建人应优先用中文名');
  });
  ok('列表：不返回密码，只给 has_password', () => {
    const d = repo.list({});
    eq(d.total, 1);
    const row = d.list[0];
    assert.ok(!('password_enc' in row));
    eq(row.has_password, 1);
    eq(row.username, 'hisadmin');
    eq(row.open_url, 'http://10.1.1.5:8080');
  });
  ok('列表：关键词能搜到 URL / 账号 / 备注', () => {
    eq(repo.list({ keyword: 'hisadmin' }).total, 1);
    eq(repo.list({ keyword: '内网' }).total, 1);
    eq(repo.list({ keyword: '10.1.1.5' }).total, 1);
    eq(repo.list({ keyword: '不存在的东西' }).total, 0);
  });

  await okAsync('编辑：不传 password → 原密码保持不动（只改备注不能把密码弄丢）', async () => {
    const before = repo.get(id1).password_enc;
    const r = repo.update(id1, { name: 'HIS 住院系统', url: '10.1.1.5:8080', note: '改一下备注' }, {});
    eq(r.ok, true);
    eq(repo.get(id1).password_enc, before, '密码被改动了');
    eq(repo.get(id1).note, '改一下备注');
  });
  await okAsync('编辑：传空串 → 清空密码', async () => {
    const e = await repo.encryptSecret('');
    const r = repo.update(id1, {}, { password: '', password_enc: e.value });
    eq(r.ok, true);
    const d = repo.list({});
    eq(d.list.filter((x) => x.id === id1)[0].has_password, 0);
  });
  await okAsync('编辑：传新值 → 覆盖', async () => {
    const e = await repo.encryptSecret('NewPwd!');
    repo.update(id1, {}, { password: 'NewPwd!', password_enc: e.value });
    const d = await repo.decryptSecret(repo.get(id1).password_enc);
    eq(d.value, 'NewPwd!');
  });
  await okAsync('编辑不存在的书签 → notFound', async () => {
    const r = repo.update(99999, { name: 'x' }, {});
    eq(r.ok, false);
    eq(r.notFound, true);
  });

  ok('分组清单与统计', () => {
    repo.create({ name: 'OA', url: 'oa.local', group_name: '业务系统' }, {});
    repo.create({ name: '交换机管理', url: 'sw.local', group_name: '网络设备' }, {});
    repo.create({ name: '无分组', url: 'x.local' }, {});
    const d = repo.list({});
    eq(d.total, 4);
    const names = d.groups.map((g) => g.name + ':' + g.cnt).join(',');
    // 有分组的按名称排在前，空分组（模板显示为「未分组」）排在最后
    eq(names, '业务系统:2,网络设备:1,:1');
  });
  ok('按分组筛选', () => {
    eq(repo.list({ group: '业务系统' }).total, 2);
    eq(repo.list({ group: '网络设备' }).total, 1);
  });
  ok('分页不影响 total', () => {
    const d = repo.list({ page: 1, pageSize: 2 });
    eq(d.list.length, 2);
    eq(d.total, 4);
    eq(repo.list({ page: 2, pageSize: 2 }).list.length, 2);
  });
  ok('长度上限：名称超长被截断而不是报错', () => {
    const long = 'x'.repeat(200);
    repo.create({ name: long, url: 'y' }, {});
    const row = repo.list({ keyword: 'xxxx' }).list[0];
    eq(row.name.length, 80);
  });
  ok('删除', () => {
    const r = repo.remove(id1);
    eq(r.ok, true);
    eq(repo.remove(id1).ok, false, '再删一次应返回未删除');
    eq(repo.list({}).total, 4);
  });

  /* ==================== 4. 老库补列 ==================== */
  ok('ensureColumns 能给缺列的老表补上（CREATE TABLE IF NOT EXISTS 不会加列）', () => {
    const { db } = require('../src/db-contract');
    db.exec('CREATE TABLE legacy_bm (id INTEGER PRIMARY KEY, name TEXT)');
    const added = repo.ensureColumns('legacy_bm', { note: "TEXT NOT NULL DEFAULT ''", owner: 'TEXT' });
    eq(added.sort().join(','), 'note,owner');
    const cols = db.prepare('PRAGMA table_info(legacy_bm)').all().map((c) => c.name);
    assert.ok(cols.indexOf('note') >= 0 && cols.indexOf('owner') >= 0);
    // 再跑一次不该重复加（幂等）
    eq(repo.ensureColumns('legacy_bm', { note: "TEXT NOT NULL DEFAULT ''" }).length, 0);
  });

  /* ==================== 汇总 ==================== */
  console.log('bookmarks-selftest：通过 ' + pass + ' / 失败 ' + fails.length);
  if (fails.length) {
    fails.forEach((f) => console.log('  x ' + f));
    process.exit(1);
  }
})();
