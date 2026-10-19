/**
 * 用真实浏览器挂直播间（Playwright）
 *
 * 为什么不用 API 心跳：实测纯接口心跳上报 10 次只记 1 分钟观看时长（约 10% 效率），
 * 因为 B 站靠播放器自身的上报判断「真的在看」。这里直接开真浏览器让播放器工作。
 *
 * 用法：
 *   node scripts/watch-browser.mjs --acct 1 --hours 5 --concurrency 3
 *
 * 环境变量：SESSDATA_N / BILI_JCT_N / PUSHPLUS_TOKEN
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire('C:/Users/Echo/.workbuddy/binaries/node/workspace/');
let chromium;
try {
  ({ chromium } = req('playwright'));
} catch {
  ({ chromium } = await import('playwright'));
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const API = 'https://api.live.bilibili.com';

// ── 参数 ──
const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ACCT = argOf('acct', '1');
const HOURS = Number(argOf('hours', '5'));
const POLL_MIN = Number(argOf('poll', '10'));
const WATCH_MIN = Number(argOf('watch', '10'));
const CONCURRENCY = Number(argOf('concurrency', '3'));
const HEADLESS = argOf('headless', '1') === '1';
const DRY = argv.includes('--dry');

const SESSDATA = process.env[`SESSDATA_${ACCT}`] || process.env.SESSDATA || '';
const BILI_JCT = process.env[`BILI_JCT_${ACCT}`] || process.env.BILI_JCT || '';
if (!SESSDATA) {
  console.error(`缺少 SESSDATA_${ACCT}`);
  process.exit(1);
}
const cookie = `SESSDATA=${SESSDATA}; bili_jct=${BILI_JCT}`;
const H = { 'user-agent': UA, referer: 'https://live.bilibili.com/', cookie };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── B 站接口（走 HTTP，只有「看」这一步交给浏览器）──
async function medals() {
  let all = [];
  for (let p = 1; p <= 20; p++) {
    const r = await (await fetch(`${API}/xlive/app-ucenter/v1/fansMedal/panel?page=${p}&page_size=50`, { headers: H })).json();
    if (r.code !== 0) break;
    if (Array.isArray(r.data.list)) all = all.concat(r.data.list);
    if (Array.isArray(r.data.special_list)) all = all.concat(r.data.special_list);
    const pi = r.data.page_info || {};
    if (!pi.total_page || pi.current_page >= pi.total_page) break;
  }
  return all;
}

/** 该牌子的 watchLive 任务是否已完成 + 当前进度文本 */
async function watchTask(ruid) {
  const r = await (await fetch(`${API}/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo?target_id=${ruid}`, { headers: H })).json();
  const t = (r?.data?.task_info || []).find((x) => x.jump_type === 'watchLive');
  return t ? { done: !!t.is_done, sub: t.sub_title } : { done: true, sub: '(无观看任务)' };
}

/** 挑本轮要挂的房间：开播中 + 已点亮 + 观看任务未完成，等级升序 */
async function pickTargets(taken) {
  const all = await medals();
  const out = [];
  for (const m of all) {
    const roomId = m.room_info?.room_id;
    const ruid = m.medal?.target_id;
    if (!roomId || !ruid) continue;
    if (Number(m.medal.is_lighted) !== 1) continue;
    if (Number(m.room_info?.living_status) !== 1) continue;
    if (taken.has(ruid)) continue;
    out.push({ roomId, ruid, lv: Number(m.medal.level), name: m.anchor_info?.nick_name || '?' });
  }
  out.sort((a, b) => a.lv - b.lv);
  // 逐个确认观看任务未完成（避免白挂）
  const ready = [];
  for (const t of out) {
    const w = await watchTask(t.ruid);
    if (!w.done) ready.push({ ...t, sub: w.sub });
    if (ready.length >= CONCURRENCY) break;
  }
  return ready;
}

// ── 浏览器里挂一个房间 ──
async function watchOne(ctx, t) {
  const page = await ctx.newPage();
  const keepPlaying = async () => {
    try {
      await page.evaluate(() => {
        const v = document.querySelector('video');
        if (!v) return false;
        v.muted = true;
        v.play().catch(() => {});
        return !v.paused;
      });
    } catch {
      /* 页面可能已跳转 */
    }
  };
  try {
    // 拦掉图片/字体/CSS，只留脚本和视频，省流量也让页面更快稳定
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'font' || type === 'stylesheet' || type === 'media') {
        // media 必须放行，视频流就是 media
        if (type === 'media') return route.continue();
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(`https://live.bilibili.com/${t.roomId}?broadcast_type=0&is_room_feed=1`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(4000);
    await keepPlaying();

    const endsAt = Date.now() + WATCH_MIN * 60 * 1000;
    let alive = 0;
    while (Date.now() < endsAt) {
      await page.waitForTimeout(30000);
      await keepPlaying();
      const paused = await page.evaluate(() => {
        const v = document.querySelector('video');
        return !v || v.paused;
      });
      if (!paused) alive += 1;
    }
    const w = await watchTask(t.ruid);
    log(`  ⏹ Lv${t.lv} ${t.name} 挂完 ${WATCH_MIN} 分钟，进度 ${w.sub}${w.done ? '（已满）' : ''}`);
    return { ok: true, done: w.done };
  } catch (e) {
    log(`  ⚠️ Lv${t.lv} ${t.name} 挂机异常：${e.message.split('\n')[0]}`);
    return { ok: false, done: false };
  } finally {
    await page.close().catch(() => {});
  }
}

// ── 主循环 ──
const deadline = Date.now() + HOURS * 3600 * 1000;
log(`启动：账号 ${ACCT}｜计划跑 ${HOURS} 小时｜每 ${POLL_MIN} 分钟扫一次｜并发 ${CONCURRENCY}｜每枚 ${WATCH_MIN} 分钟｜headless=${HEADLESS}`);
if (DRY) {
  const t = await pickTargets(new Set());
  log('挑到的目标：', JSON.stringify(t, null, 1));
  process.exit(0);
}

const browser = await chromium.launch({
  headless: HEADLESS,
  args: [
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--mute-audio',
    '--no-sandbox',
    '--disable-dev-shm-usage',
  ],
});
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
await ctx.addCookies([
  { name: 'SESSDATA', value: SESSDATA, domain: '.bilibili.com', path: '/' },
  { name: 'bili_jct', value: BILI_JCT, domain: '.bilibili.com', path: '/' },
]);

const done = new Set(); // 本轮已挂满的
let round = 0;

try {
  while (Date.now() < deadline) {
    round += 1;
    const left = Math.round((deadline - Date.now()) / 60000);
    log(`\n===== 第 ${round} 轮（剩余 ${left} 分钟）=====`);

    const targets = await pickTargets(done);
    if (!targets.length) {
      log('  当前没有「在播 + 未挂满」的牌子');
    } else {
      log(`  挑中 ${targets.length} 个：${targets.map((t) => `Lv${t.lv}${t.name}(${t.sub})`).join('，')}`);
      const res = await Promise.all(targets.map((t) => watchOne(ctx, t)));
      res.forEach((r, i) => {
        if (r.done) done.add(targets[i].ruid);
      });
    }

    const waitMs = POLL_MIN * 60 * 1000;
    if (Date.now() + waitMs > deadline) break;
    log(`  下一轮 ${POLL_MIN} 分钟后`);
    await sleep(waitMs);
  }
} finally {
  await browser.close().catch(() => {});
  log(`\n结束：共 ${round} 轮，挂满 ${done.size} 枚`);
}
