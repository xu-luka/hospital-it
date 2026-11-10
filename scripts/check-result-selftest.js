'use strict';
/**
 * 自检结果格式化自测（2026-11-10）
 *
 * 回归现场：一台 exporter 设备连得上（ok=true），但有两条阈值告警，
 * 自检弹窗却显示 "[object Object]；[object Object]" 的红色错误框，
 * 并把主机名 / CPU / 内存 / 扩展采集摘要全遮住了。
 * 根因：evaluateResult 的 reasons 是 [{level,text}]，路由却直接 .join('；')，
 * 还把告警当 error 返回。这里守住「规整 + 分离」两件事。
 */
const C = require('../src/inspection/lib/common');

let pass = 0;
let fail = 0;
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { pass++; return; }
  fail++;
  console.error('FAIL ' + name + '\n  实际 ' + a + '\n  期望 ' + b);
}
function ok(name, v) { eq(name, !!v, true); }

/* ---------- reasonList ---------- */
const raw = [
  { level: 'warning', text: '磁盘 D: 使用 86%' },
  { level: 'critical', text: '服务「HIS-Interface」未运行' }
];
const list = C.reasonList(raw);
eq('对象数组条数', list.length, 2);
eq('第一条 level', list[0].level, 'warning');
eq('第一条 text', list[0].text, '磁盘 D: 使用 86%');
eq('第二条 level', list[1].level, 'critical');
eq('规整后拼接不再出现 [object Object]',
  list.map((x) => x.text).join('；').indexOf('[object Object]') >= 0, false);
ok('拼接后含真实告警文案', list.map((x) => x.text).join('；').indexOf('磁盘 D:') >= 0);

eq('纯字符串数组按 warning 兜底',
  C.reasonList(['CPU 高', '内存高']),
  [{ level: 'warning', text: 'CPU 高' }, { level: 'warning', text: '内存高' }]);
eq('未知 level 归 warning', C.reasonList([{ level: 'info', text: '提示' }])[0].level, 'warning');
eq('混合输入过滤空项',
  C.reasonList([null, undefined, '', { level: 'critical', text: 'x' }, 42, { foo: 1 }]),
  [{ level: 'critical', text: 'x' }, { level: 'warning', text: '42' }]);
eq('非数组返回空', C.reasonList(null), []);
eq('undefined 返回空', C.reasonList(undefined), []);
eq('对象里的 message 也能当文本',
  C.reasonList([{ level: 'critical', message: '采集超时' }])[0].text, '采集超时');
eq('原数组不被改写', raw[0].level, 'warning');

/* ---------- errorText ---------- */
eq('字符串原样', C.errorText('拉取失败'), '拉取失败');
eq('null 返回空', C.errorText(null), '');
eq('undefined 返回空', C.errorText(undefined), '');
eq('Error 取 message', C.errorText(new Error('超时')), '超时');
eq('普通对象取 message', C.errorText({ code: 500, message: '服务不可用' }), '服务不可用');
eq('普通对象取 text', C.errorText({ text: '缺收集器' }), '缺收集器');
eq('无 message/text 的对象序列化', C.errorText({ a: 1 }), '{"a":1}');
eq('不产生 [object Object]', C.errorText({}).indexOf('[object Object]') >= 0, false);
eq('数字转文本', C.errorText(404), '404');

/* ---------- 模拟 /devices/:id/check 的拼装 ---------- */
function build(r) {
  const reasons = C.reasonList(r.reasons);
  return {
    ok: !!r.ok,
    error: r.ok ? null : (C.errorText(r.error) || reasons.map((x) => x.text).join('；') || '采集失败'),
    reasons: reasons
  };
}
const good = build({ ok: true, reasons: raw, error: undefined });
eq('连接正常时 error 必须为 null', good.error, null);
eq('连接正常时告警仍要透出', good.reasons.length, 2);
ok('连接正常时不会走红色错误框', good.error === null);
const bad1 = build({ ok: false, error: 'HTTP 401', reasons: [] });
eq('连接失败优先用真实错误', bad1.error, 'HTTP 401');
const bad2 = build({ ok: false, reasons: raw });
eq('连接失败无 error 时用告警文本', bad2.error, '磁盘 D: 使用 86%；服务「HIS-Interface」未运行');
ok('连接失败文案里没有 [object Object]', bad2.error.indexOf('[object Object]') < 0);
const bad3 = build({ ok: false, error: { message: '主密钥不可用' }, reasons: [] });
eq('对象型 error 也能读出文本', bad3.error, '主密钥不可用');
const bad4 = build({ ok: false, reasons: [] });
eq('什么都没有时给兜底文案', bad4.error, '采集失败');

console.log('check-result-selftest: ' + pass + ' passed, ' + fail + ' failed');
if (fail) process.exit(1);
