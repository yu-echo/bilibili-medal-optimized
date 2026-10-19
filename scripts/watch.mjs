/**
 * 直播亲密度挂机（对齐上游 BiliBiliToolPro 的 LiveFansMedal 任务）
 *
 * 上游逻辑：
 *   1. 只处理「已点亮 + 开播中」的牌子，开播状态在入场前和每轮心跳前各查一次
 *   2. 每枚牌子独立心跳，默认 HeartBeatNumber=15 轮（60 秒一轮 = 15 分钟）
 *   3. 多枚牌子并行，并发上限 8
 *   4. 单枚失败只记日志，不影响其它
 *
 * 2026-04 改版后的规则：观看直播满 15 分钟 +1 亲密度，每日上限 10 次。
 * 所以每枚牌子要占满 15 分钟才有收益，默认按上游 16 轮（留一轮余量）。
 *
 * 用法：
 *   node scripts/watch.mjs                 # 默认每枚 16 轮、并发 4、最多 4 枚
 *   WATCH_HEARTBEATS=16 WATCH_TOP=4 node scripts/watch.mjs
 *   DRY_RUN=1 node scripts/watch.mjs       # 只打印会挂哪些房间
 */
import { getLiveBuvid, getWbiMixin, watchRoom } from './heartbeat.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://api.live.bilibili.com';
const HEARTBEATS = Number(process.env.WATCH_HEARTBEATS || '16');
const TOP = Number(process.env.WATCH_TOP || '4');
const DRY = process.env.DRY_RUN === '1';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function loadAccounts() {
  const out = [];
  for (let i = 1; i <= 9; i++) {
    const sess = process.env[`SESSDATA_${i}`] || (i === 1 ? process.env.SESSDATA : '');
    const jct = process.env[`BILI_JCT_${i}`] || (i === 1 ? process.env.BILI_JCT : '');
    if (sess) out.push({ no: i, sess, jct });
  }
  return out;
}

async function panel(cookie) {
  const H = { 'user-agent': UA, referer: 'https://live.bilibili.com/', cookie };
  let all = [];
  for (let p = 1; p <= 20; p++) {
    const r = await (await fetch(`${API}/xlive/app-ucenter/v1/fansMedal/panel?page=${p}&page_size=50`, { headers: H })).json();
    if (r.code !== 0) break;
    all = all.concat(r.data.list || [], r.data.special_list || []);
    const pi = r.data.page_info || {};
    if (!pi.total_page || pi.current_page >= pi.total_page) break;
  }
  return all;
}

/** 该牌子今天的观看任务进度；已完成或没有该任务都返回 done */
async function watchTask(cookie, ruid) {
  const r = await (
    await fetch(`${API}/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo?target_id=${ruid}`, {
      headers: { 'user-agent': UA, referer: 'https://live.bilibili.com/', cookie },
    })
  ).json();
  const t = (r?.data?.task_info || []).find((x) => x.jump_type === 'watchLive');
  return { done: !t ? true : !!t.is_done, sub: t?.sub_title || '-', intimacy: r?.data?.intimacy };
}

async function runAccount(acct) {
  const cookie = `SESSDATA=${acct.sess}; bili_jct=${acct.jct}`;
  log(`\n===== 账号 ${acct.no} =====`);

  const medals = await panel(cookie);
  if (!medals.length) {
    log('  拿不到牌子列表，cookie 可能失效');
    return;
  }
  const liveLit = medals.filter(
    (m) => m.room_info?.room_id && m.medal?.target_id && Number(m.room_info.living_status) === 1 && Number(m.medal.is_lighted) === 1
  );
  log(`  牌子 ${medals.length} 枚｜开播且已点亮 ${liveLit.length} 枚`);
  if (!liveLit.length) {
    log('  没有可挂的房间，跳过');
    return;
  }

  // 高等级优先：等级越高升级越慢，越值得先喂
  liveLit.sort((a, b) => Number(b.medal.level) - Number(a.medal.level));

  const picked = [];
  for (const m of liveLit) {
    if (picked.length >= TOP) break;
    const t = await watchTask(cookie, m.medal.target_id);
    if (t.done) {
      log(`  跳过 Lv${m.medal.level} ${m.anchor_info?.nick_name}：今天观看任务已满（${t.sub}）`);
      continue;
    }
    picked.push({ roomId: m.room_info.room_id, ruid: m.medal.target_id, lv: m.medal.level, name: m.anchor_info?.nick_name, before: t });
  }
  if (!picked.length) {
    log('  所有开播牌子的观看任务都满了，跳过');
    return;
  }
  log(`  本轮挂 ${picked.length} 枚（每枚 ${HEARTBEATS} 轮 ≈ ${HEARTBEATS} 分钟）`);
  picked.forEach((p) => log(`    Lv${p.lv} ${p.name}（房间 ${p.roomId}，当前 ${p.before.sub}）`));
  if (DRY) return;

  const buvid = await getLiveBuvid(cookie, UA);
  const mixin = await getWbiMixin(cookie, UA);
  if (!buvid) log('  ⚠️ 拿不到 LIVE_BUVID，心跳不会被计入时长');
  if (!mixin) log('  ⚠️ 拿不到 wbi mixin，签名会失败');

  const results = await Promise.all(
    picked.map(async (p) => {
      const r = await watchRoom({
        roomId: p.roomId,
        ruid: p.ruid,
        minutes: HEARTBEATS,
        UA,
        cookie,
        buvid,
        csrf: acct.jct,
        mixin,
      });
      return { ...p, r };
    })
  );

  for (const x of results) {
    const after = await watchTask(cookie, x.ruid);
    const gain = (after.intimacy ?? 0) - (x.before.intimacy ?? 0);
    const tag = x.r.err ? `中断：${x.r.err}` : `心跳 成功 ${x.r.ok}｜失败 ${x.r.fail}`;
    log(`  Lv${x.lv} ${x.name}：${tag}｜任务 ${x.before.sub} → ${after.sub}｜亲密度 ${x.before.intimacy} → ${after.intimacy}（+${gain}）`);
  }
}

const accounts = loadAccounts();
if (!accounts.length) {
  console.error('没有可用账号（缺少 SESSDATA_1 等环境变量）');
  process.exit(1);
}
log(`启动：${accounts.length} 个账号｜每枚 ${HEARTBEATS} 轮｜每账号最多 ${TOP} 枚${DRY ? '｜DRY_RUN' : ''}`);
for (const a of accounts) await runAccount(a);
log('\n挂机结束');
