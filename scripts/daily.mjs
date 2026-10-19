#!/usr/bin/env node
/**
 * B 站每日任务（GitHub Actions 版）
 *
 * 只做「一次性、几分钟能跑完」的任务：
 *   1. 大会员权益领取（含漫画福利）
 *   2. 大会员每日经验包
 *   3. 大会员积分签到
 *   4. 粉丝牌点亮（点赞，未点亮的牌子）
 *   5. 主站观看 + 分享
 *
 * 不做直播挂机 —— 需要连续 30~60 分钟，是 B 站风控最敏感的部分，
 * 数据中心 IP 上风险太高，挂机请留在本地浏览器。
 *
 * 环境变量（必填）：
 *   SESSDATA / BILI_JCT
 * 可选：
 *   MAX_LIGHT   每次最多点亮多少枚牌子，默认 30
 *   DELAY_MS    请求间隔毫秒，默认 2000
 *   DRY_RUN     =1 时只打印计划，不发请求
 */

import crypto from 'node:crypto';

const CFG = {
  SESSDATA: process.env.SESSDATA || '',
  BILI_JCT: process.env.BILI_JCT || '',
  MAX_LIGHT: Number(process.env.MAX_LIGHT || 30),
  DELAY_MS: Number(process.env.DELAY_MS || 2000),
  DRY: process.env.DRY_RUN === '1',
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIXIN_V = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const state = { mid: 0, uname: '', buvid3: '', mixin: '' };
const stat = { ok: 0, skip: 0, fail: 0 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const log = (...a) => console.log(...a);
const warn = (...a) => console.warn(...a);

function cookieHeader() {
  const p = [`SESSDATA=${CFG.SESSDATA}`, `bili_jct=${CFG.BILI_JCT}`];
  if (state.buvid3) p.push(`buvid3=${state.buvid3}`);
  return p.join('; ');
}

async function http(url, { method = 'GET', headers = {}, body, retry = 2, referer = 'https://live.bilibili.com/' } = {}) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'user-agent': UA, referer, cookie: cookieHeader(), ...headers },
        body,
        signal: AbortSignal.timeout(15000),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`非 JSON 响应 (HTTP ${res.status}): ${text.slice(0, 120)}`);
      }
      return json;
    } catch (e) {
      lastErr = e;
      if (i < retry) await sleep(1200 * (i + 1));
    }
  }
  throw lastErr;
}

const form = (obj) => new URLSearchParams(obj).toString();
const FORM_HEADER = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_HEADER = { 'content-type': 'application/json' };

function wbiQuery(params) {
  const all = { ...params, wts: Math.floor(Date.now() / 1000) };
  const q = Object.keys(all).sort().map((k) => `${k}=${encodeURIComponent(all[k])}`).join('&');
  return `${q}&w_rid=${md5(q + state.mixin)}`;
}

// ────────────────────────────── 登录 & 准备 ──────────────────────────────

async function bootstrap() {
  if (!CFG.SESSDATA || !CFG.BILI_JCT) {
    throw new Error('缺少 SESSDATA 或 BILI_JCT 环境变量');
  }
  log('[1/5] 登录检查 …');
  const nav = await http('https://api.bilibili.com/x/web-interface/nav', { referer: 'https://www.bilibili.com/' });
  if (nav.code !== 0 || !nav.data || !nav.data.isLogin) {
    throw new Error(`登录失效（code=${nav.code} ${nav.message}），请更新 SESSDATA / BILI_JCT`);
  }
  state.mid = nav.data.mid;
  state.uname = nav.data.uname;
  const imgKey = nav.data.wbi_img.img_url.split('/').pop().split('.')[0];
  const subKey = nav.data.wbi_img.sub_url.split('/').pop().split('.')[0];
  const raw = imgKey + subKey;
  state.mixin = MIXIN_V.map((i) => raw.charAt(i)).filter(Boolean).join('').slice(0, 32);

  // 无头环境没有 LIVE_BUVID，用 SPI 接口现取一个（与 asoul-support 同做法）
  try {
    const spi = await http('https://api.bilibili.com/x/frontend/finger/spi', { referer: 'https://www.bilibili.com/' });
    if (spi.code === 0 && spi.data && spi.data.b_3) state.buvid3 = spi.data.b_3;
  } catch (e) {
    warn('  ⚠️  取 buvid3 失败，继续（部分接口可能受限）:', e.message);
  }

  const vip = nav.data.vipStatus === 1;
  log(`  ✅ ${state.uname} (mid=${state.mid})｜${vip ? nav.data.vip_label.text : '非大会员'}｜buvid3 ${state.buvid3 ? '已获取' : '缺失'}`);
  log(`  ✅ wbi mixin key ${state.mixin.length === 32 ? '已生成' : '异常'}`);
  return { vip };
}

// ────────────────────────────── 1. 大会员权益 ──────────────────────────────

async function taskVipPrivilege(isVip) {
  log('[2/5] 大会员权益 …');
  if (!isVip) {
    log('  ⏭️  非大会员，跳过');
    return;
  }

  // 漫画福利（独立接口）
  if (CFG.DRY) {
    log('  [dry] 漫画 GetVipReward');
  } else {
    try {
      const r = await http('https://manga.bilibili.com/twirp/user.v1.User/GetVipReward', {
        method: 'POST',
        headers: JSON_HEADER,
        body: JSON.stringify({ reason_id: 1 }),
        referer: 'https://manga.bilibili.com/',
      });
      if (r.code === 0) {
        stat.ok++;
        log(`  ✅ 漫画漫读券 +${r.data?.amount ?? '?'}`);
      } else if (r.code === 1) {
        stat.skip++;
        log('  ⏭️  漫画福利已领或未达条件');
      } else {
        stat.fail++;
        warn(`  ⚠️  漫画福利 code=${r.code} ${r.msg || r.message}`);
      }
    } catch (e) {
      stat.fail++;
      warn('  ⚠️  漫画福利异常:', e.message);
    }
    await sleep(CFG.DELAY_MS);
  }

  // 权益列表：只看 recive_state（1=未领，2=已领）。state 字段不能当判据。
  let list = [];
  try {
    const my = await http('https://api.bilibili.com/x/vip/privilege/my', { referer: 'https://www.bilibili.com/' });
    if (my.code === 0 && my.data && Array.isArray(my.data.list)) list = my.data.list;
  } catch (e) {
    warn('  ⚠️  取权益列表失败:', e.message);
    return;
  }

  // B币券过期提醒
  const coupon = list.find((x) => Number(x.type) === 1);
  if (coupon && coupon.expire_time) {
    const days = Math.ceil((coupon.expire_time * 1000 - Date.now()) / 86400000);
    if (days >= 0 && days <= 3) {
      const d = new Date(coupon.expire_time * 1000);
      warn(`  🔔 B币券还有 ${days} 天过期（${d.getMonth() + 1}月${d.getDate()}日），记得去充电用掉`);
    }
  }

  const pending = list.filter((x) => Number(x.recive_state) === 1);
  if (!pending.length) {
    log('  ⏭️  当前无可领权益');
    return;
  }

  for (const item of pending) {
    const t = item.type;
    if (CFG.DRY) {
      log(`  [dry] 领取 type=${t}`);
      continue;
    }
    try {
      const r = await http(`https://api.bilibili.com/x/vip/privilege/receive?${form({ type: t, platform: 'web', csrf: CFG.BILI_JCT })}`, {
        method: 'POST',
        headers: FORM_HEADER,
        referer: 'https://www.bilibili.com/',
      });
      if (r.code === 0) {
        stat.ok++;
        log(`  ✅ type=${t} 领取成功`);
      } else if (r.code === 69801 || r.code === 69818) {
        stat.skip++;
        log(`  ⏭️  type=${t} 已领过`);
      } else {
        stat.fail++;
        // 69825 需绑淘宝 / 6034021 需超大会员 / 6034019 活动过期 / -400 不支持网页端
        warn(`  ⚠️  type=${t} code=${r.code} ${r.message}`);
      }
    } catch (e) {
      stat.fail++;
      warn(`  ⚠️  type=${t} 异常: ${e.message}`);
    }
    await sleep(CFG.DELAY_MS);
  }
}

// ────────────────────────────── 2. 大会员经验 + 积分 ──────────────────────────────

async function taskVipMisc(isVip) {
  log('[3/5] 大会员经验 / 积分签到 …');
  if (!isVip) {
    log('  ⏭️  非大会员，跳过');
    return;
  }
  for (const [label, url] of [
    ['经验包', 'https://api.bilibili.com/x/vip/experience/add'],
    ['积分签到', 'https://api.bilibili.com/pgc/activity/score/task/sign'],
  ]) {
    if (CFG.DRY) {
      log(`  [dry] ${label}`);
      continue;
    }
    try {
      const r = await http(url, { method: 'POST', headers: FORM_HEADER, body: form({ csrf: CFG.BILI_JCT }), referer: 'https://www.bilibili.com/' });
      if (r.code === 0) {
        stat.ok++;
        log(`  ✅ ${label} 完成`);
      } else if (r.code === 69198) {
        stat.skip++;
        log(`  ⏭️  ${label} 今日已领`);
      } else {
        stat.fail++;
        warn(`  ⚠️  ${label} code=${r.code} ${r.message}`);
      }
    } catch (e) {
      stat.fail++;
      warn(`  ⚠️  ${label} 异常: ${e.message}`);
    }
    await sleep(CFG.DELAY_MS);
  }
}

// ────────────────────────────── 3. 粉丝牌点亮 ──────────────────────────────

async function getMedals() {
  let all = [];
  for (let page = 1; page <= 20; page++) {
    const r = await http(`https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=50`);
    if (r.code !== 0 || !r.data) break;
    if (Array.isArray(r.data.list)) all = all.concat(r.data.list);
    if (Array.isArray(r.data.special_list)) all = all.concat(r.data.special_list);
    const pi = r.data.page_info || {};
    if (!pi.total_page || pi.current_page >= pi.total_page) break;
    await sleep(600);
  }
  return all;
}

/** 点赞点亮：实测 click_time=30 一次即可让 is_lighted 从 0 变 1 */
async function likeMedal(roomId, ruid, clickTime = 30) {
  const q = wbiQuery({ anchor_id: ruid, click_time: clickTime, csrf: CFG.BILI_JCT, room_id: roomId, uid: state.mid, web_location: 444.8 });
  return http(`https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3?${q}`, {
    method: 'POST',
    referer: `https://live.bilibili.com/${roomId}`,
  });
}

async function taskMedalLight() {
  log('[4/5] 粉丝牌点亮 …');
  let medals = [];
  try {
    medals = await getMedals();
  } catch (e) {
    warn('  ⚠️  取勋章列表失败:', e.message);
    return;
  }
  if (!medals.length) {
    log('  ⏭️  没有勋章');
    return;
  }

  const unlit = medals.filter((m) => Number(m.medal.is_lighted) === 0);
  const lit = medals.length - unlit.length;
  log(`  共 ${medals.length} 枚｜已点亮 ${lit}｜未点亮 ${unlit.length}`);

  if (!unlit.length) {
    log('  ⏭️  全部已点亮');
    return;
  }

  const todo = unlit.slice(0, CFG.MAX_LIGHT);
  if (unlit.length > todo.length) {
    log(`  本轮只处理 ${todo.length} 枚（MAX_LIGHT=${CFG.MAX_LIGHT}），其余留到下次`);
  }

  for (const m of todo) {
    const roomId = m.room_info && m.room_info.room_id;
    const lv = m.medal.level;
    const name = m.anchor_info ? m.anchor_info.nick_name : '?';
    if (!roomId) {
      stat.skip++;
      log(`  ⏭️  ${name} 无房间号，跳过`);
      continue;
    }
    if (CFG.DRY) {
      log(`  [dry] 点亮 ${name} (Lv${lv})`);
      continue;
    }
    try {
      const r = await likeMedal(roomId, m.medal.target_id, 30);
      if (r.code === 0) {
        stat.ok++;
        log(`  ✅ 点亮 ${name} (Lv${lv})`);
      } else {
        stat.fail++;
        warn(`  ⚠️  点亮 ${name} code=${r.code} ${r.message}`);
      }
    } catch (e) {
      stat.fail++;
      warn(`  ⚠️  点亮 ${name} 异常: ${e.message}`);
    }
    await sleep(CFG.DELAY_MS);
  }
}

// ────────────────────────────── 4. 主站观看 + 分享 ──────────────────────────────

async function taskWatchShare() {
  log('[5/5] 主站观看 + 分享 …');
  let item;
  try {
    const rcm = await http('https://api.bilibili.com/x/web-interface/index/top/rcmd', { referer: 'https://www.bilibili.com/' });
    if (rcm.code !== 0 || !rcm.data || !Array.isArray(rcm.data.item) || !rcm.data.item.length) {
      log(`  ⏭️  取推荐视频失败（code=${rcm.code}），跳过`);
      return;
    }
    item = rcm.data.item[0];
  } catch (e) {
    warn('  ⚠️  取推荐视频异常:', e.message);
    return;
  }

  if (CFG.DRY) {
    log(`  [dry] 观看+分享 av=${item.id}`);
    return;
  }

  try {
    const w = await http('https://api.bilibili.com/x/report/web/heartbeat', {
      method: 'POST',
      headers: FORM_HEADER,
      body: form({ aid: item.id, cid: item.cid, mid: state.mid, start_ts: Math.floor(Date.now() / 1000), played_time: 0, realtime: 0, type: 3, play_type: 1, dt: 2, csrf: CFG.BILI_JCT }),
      referer: 'https://www.bilibili.com/',
    });
    if (w.code === 0) { stat.ok++; log(`  ✅ 观看上报 av=${item.id}`); }
    else { stat.fail++; warn(`  ⚠️  观看上报 code=${w.code} ${w.message}`); }
  } catch (e) {
    stat.fail++;
    warn('  ⚠️  观看上报异常:', e.message);
  }
  await sleep(CFG.DELAY_MS);

  try {
    const s = await http('https://api.bilibili.com/x/web-interface/share/add', {
      method: 'POST',
      headers: FORM_HEADER,
      body: form({ aid: item.id, csrf: CFG.BILI_JCT, jsonp: 'jsonp' }),
      referer: `https://www.bilibili.com/video/av${item.id}`,
    });
    if (s.code === 0) { stat.ok++; log(`  ✅ 分享 av=${item.id}`); }
    else { stat.skip++; log(`  ⏭️  分享 av=${item.id} code=${s.code} ${s.message}`); }
  } catch (e) {
    stat.fail++;
    warn('  ⚠️  分享异常:', e.message);
  }
}

// ────────────────────────────── main ──────────────────────────────

async function main() {
  log('════════ B 站每日任务 ════════');
  if (CFG.DRY) log('⚠️  DRY_RUN 模式：不会发出任何写请求');
  const t0 = Date.now();

  const { vip } = await bootstrap();
  await taskVipPrivilege(vip);
  await taskVipMisc(vip);
  await taskMedalLight();
  await taskWatchShare();

  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  log('════════ 完成 ════════');
  log(`成功 ${stat.ok}｜跳过 ${stat.skip}｜失败 ${stat.fail}｜耗时 ${sec}s`);

  if (stat.fail > 0 && stat.ok === 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('❌ 任务终止:', e.message);
  process.exitCode = 1;
});
