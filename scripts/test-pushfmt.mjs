/**
 * pushfmt 的断言测试。
 * 样本全部来自真实运行 40279688731 的日志（2026-10-26），不是手编的理想数据。
 * 跑：node scripts/test-pushfmt.mjs
 */
import assert from 'node:assert/strict';
import { digestOf, renderDigest, accountHead } from './lib/pushfmt.mjs';

/* ── 样本：账号 1（年度大会员，9 项失败）── */
const A1 = [
  '[1/6] 登录检查 …',
  '  ✅ 神の麒零 (mid=7322072)｜年度大会员｜buvid3 已获取',
  '[2/6] 大会员权益 …',
  '  ⏭️  漫画福利已领或未达条件',
  '  ⏭️  type=14 已领过',
  '  ⚠️  type=18 code=69825 淘宝账号查询异常，请退出重试',
  '  ⚠️  type=20 code=6034019 饿了么领取活动已经过期~',
  '  ⚠️  type=21 code=6034021 超大会员身份状态异常',
  '  ⚠️  type=24 code=-400 请求错误',
  '  ⚠️  type=25 code=-400 请求错误',
  '  ⚠️  type=26 code=-400 请求错误',
  '  ⚠️  type=27 code=-400 请求错误',
  '[3/6] 大会员经验 / 积分签到 …',
  '  ⏭️  经验包 今日已领',
  '  ⚠️  积分签到 code=6007000 请求错误',
  '[4/6] 粉丝牌点亮 …',
  '  共 87 枚｜已点亮 25｜未点亮 62',
  '  其中 62 枚主播未开播，点亮无效，跳过（等开播后自动补）',
  '  ⏭️  没有可点亮的（未点亮的都不在播）',
  '[5/6] 银瓜子兑换硬币 …',
  '  银瓜子 522｜硬币 304｜今日剩余兑换次数 1',
  '  ⚠️  兑换失败 code=403 银瓜子余额不足',
  '[6/6] 主站观看 + 分享 …',
  '  ✅ 观看上报 av=117409121834906',
  '  ✅ 分享 av=117409121834906',
];

/* ── 样本：账号 2（非大会员，1 项失败）── */
const A2 = [
  '[1/6] 登录检查 …',
  '  ✅ 煜晓晓晓 (mid=130262187)｜非大会员｜buvid3 已获取',
  '[2/6] 大会员权益 …',
  '  ⏭️  非大会员，跳过',
  '[3/6] 大会员经验 / 积分签到 …',
  '  ⏭️  非大会员，跳过',
  '[4/6] 粉丝牌点亮 …',
  '  共 2 枚｜已点亮 0｜未点亮 2',
  '  ⏭️  没有可点亮的（未点亮的都不在播）',
  '[5/6] 银瓜子兑换硬币 …',
  '  ⚠️  兑换失败 code=403 银瓜子余额不足',
  '[6/6] 主站观看 + 分享 …',
  '  ✅ 观看上报 av=117393217099733',
  '  ✅ 分享 av=117393217099733',
];

const d1 = digestOf(A1);
const out1 = renderDigest(d1);
const d2 = digestOf(A2);
const out2 = renderDigest(d2);

/* ① 身份抽出来当小标题，不混进条目 */
assert.equal(d1.identity.name, '神の麒零');
assert.equal(d1.identity.tier, '年度大会员');
assert.equal(d2.identity.name, '煜晓晓晓');
assert.equal(d2.identity.tier, '非大会员');
assert.ok(!/buvid3/.test(accountHead(0, { name: 'x', ok: 0, skip: 0, fail: 0 }, d1)), '小标题不该带 buvid3');

assert.equal(
  accountHead(0, { name: 'x', ok: 2, skip: 3, fail: 9 }, d1),
  '1. 神の麒零（年度大会员） 成功 2｜跳过 3｜失败 9',
);

/* ② 编号噪音必须消失，错误码保留在括号里 */
const joined = out1.join('\n');
assert.ok(!/type=\d/.test(joined), `不该出现 type= 编号：\n${joined}`);
assert.ok(!/code=/.test(joined), `不该出现 code= 原文：\n${joined}`);
assert.ok(joined.includes('淘宝账号查询异常(69825)'), joined);
assert.ok(joined.includes('饿了么领取活动已经过期(6034019)'), joined);
assert.ok(joined.includes('请求错误(-400)×4'), `4 个 -400 应合并：\n${joined}`);
assert.ok(!/undefined|NaN|\[object/.test(joined), joined);

/* ③ 失败排在最前，成功和跳过在后面 */
const firstOk = out1.findIndex((l) => l.startsWith('✓'));
const firstSkip = out1.findIndex((l) => l.startsWith('⏭'));
const lastFail = out1.map((l) => l.startsWith('✗')).lastIndexOf(true);
assert.ok(lastFail >= 0 && lastFail < firstOk, `失败应在成功之前：\n${joined}`);
assert.ok(firstOk >= 0 && firstOk < firstSkip, `成功应在跳过之前：\n${joined}`);

/* ④ 环节名要带上，不然「请求错误」不知道错在哪 */
assert.ok(out1.some((l) => l.startsWith('✗ 大会员权益：')), joined);
assert.ok(out1.some((l) => l.startsWith('✗ 银瓜子兑换硬币：')), joined);
assert.ok(out1.some((l) => l.startsWith('✓ 主站观看 + 分享：')), joined);

/* ⑤ 粉丝牌带上下文（87 枚｜点亮 25） */
assert.ok(out1.some((l) => l.includes('87 枚｜点亮 25')), joined);

/* ⑥ 同一环节内重复结论合并成 ×N；跨环节保留（各自说清是哪个环节跳过的） */
const nonVipOut = out2.filter((l) => l.includes('非大会员，跳过'));
assert.equal(nonVipOut.length, 2, `两个环节各自一行：\n${out2.join('\n')}`);
assert.ok(nonVipOut.every((l) => /^⏭ .+：非大会员，跳过$/.test(l)), nonVipOut.join('\n'));
const dup = digestOf(['[2/6] 大会员权益 …', '  ⏭️  非大会员，跳过', '  ⏭️  非大会员，跳过']);
assert.ok(renderDigest(dup)[0].includes('非大会员，跳过×2'), renderDigest(dup).join('\n'));

/* ⑦ 上下文行不该泄漏成条目 */
assert.ok(!joined.includes('银瓜子 522'), `过程数据不该进推送：\n${joined}`);
assert.ok(!joined.includes('其中 62 枚'), joined);

/* ⑧ 长度：真实一天必须在 800 字以内，否则微信里看不全 */
const bodyLen = [...out1, ...out2].join('\n').length;
assert.ok(bodyLen < 800, `正文 ${bodyLen} 字，太长了`);

/* ⑨ 点亮逐枚刷屏要合并 */
const lit = digestOf([
  '[4/6] 粉丝牌点亮 …',
  ...['张三', '李四', '王五', '赵六', '钱七', '孙八'].map((n) => `  ✅ 点亮 ${n}`),
]);
const litOut = renderDigest(lit);
assert.equal(litOut.length, 1, litOut.join('\n'));
assert.ok(litOut[0].includes('点亮 6 枚：'), litOut[0]);
assert.ok(litOut[0].includes('等'), litOut[0]);

/* ⑩ 空明细 / 只有过程行都不能崩 */
assert.deepEqual(renderDigest(digestOf([])), []);
assert.deepEqual(renderDigest(digestOf(['  wbi mixin key ok', '  随便一行'])), []);

/* ⑪ 行数超限时按序截断、尾部注明还剩几行，且总行数不超上限 */
const many = [];
for (let i = 1; i <= 12; i++) many.push(`[${i}/12] 环节${i} …`, `  ⚠️  第 ${i} 项失败`);
const cut = renderDigest(digestOf(many), { maxLines: 4 });
assert.equal(cut.length, 4, cut.join('\n'));
assert.equal(cut.filter((l) => l.startsWith('✗')).length, 3, cut.join('\n'));
assert.ok(cut.at(-1).includes('见运行记录'), cut.at(-1));

/* ⑫ 单个环节条目过多时只列前 4 条，其余折成「另 N 项」 */
const burst = ['[2/6] 大会员权益 …'];
for (let i = 0; i < 9; i++) burst.push(`  ⚠️  type=${i} code=${100 + i} 第 ${i} 项失败`);
const burstOut = renderDigest(digestOf(burst));
assert.equal(burstOut.length, 1, burstOut.join('\n'));
assert.ok(burstOut[0].includes('…另 5 项'), burstOut[0]);

console.log('━━━ 账号 1 ━━━');
console.log(out1.join('\n'));
console.log('━━━ 账号 2 ━━━');
console.log(out2.join('\n'));
console.log(`\n正文 ${bodyLen} 字`);
console.log('✅ pushfmt 12 组断言全部通过');
