/**
 * B 站扫码登录 → 取回 cookie（SESSDATA / bili_jct）
 *
 * 为什么不用账号密码登录：B 站 passport 对「无浏览器设备历史」的密码登录一律返回
 * status=2「本次登录环境存在风险, 需使用手机号进行验证或绑定」，
 * 即使极验打码通过、即使带上 buvid3/buvid4 指纹也一样（本地与 Actions 均已实测）。
 * 扫码登录走手机端确认，不受这条风控限制。
 *
 * 用法：
 *   node scripts/qr-login.mjs --acct 1            出二维码，扫完把 cookie 存到 .qr/
 *   node scripts/qr-login.mjs --acct 1 --push     扫完顺便写进 GitHub Secrets
 *   node scripts/qr-login.mjs --acct 1 --push --reuse   复用上次扫码结果，只做推送
 *
 * 产物：.qr/acct<N>.json（已在 .gitignore 内，不进版本库）
 */
import fs from 'node:fs';
import path from 'node:path';
import { exec, execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const PASSPORT = 'https://passport.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// ── 参数 ──
const argv = process.argv.slice(2);
const argOf = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const ACCT = argOf('acct', '1');
const TIMEOUT_S = Number(argOf('timeout', '240'));
const PUSH = argv.includes('--push');
const REUSE = argv.includes('--reuse');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..');
const OUT_DIR = path.join(ROOT, '.qr');
fs.mkdirSync(OUT_DIR, { recursive: true });
const savedFile = path.join(OUT_DIR, `acct${ACCT}.json`);

const log = (...a) => console.log(...a);

// qrcode 装在托管工作区；ESM 不认 NODE_PATH，用 createRequire 直接定位
function loadQRCode() {
  for (const base of ['C:/Users/Echo/.workbuddy/binaries/node/workspace/', ROOT]) {
    try {
      return createRequire(base)('qrcode');
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

const openFile = (p) => {
  if (process.platform === 'win32') exec(`start "" "${p}"`, { windowsHide: true });
};

const save = (c) => fs.writeFileSync(savedFile, JSON.stringify(c, null, 2), 'utf-8');

// ── 1. 取 cookie ──
let cookies = null;

if (REUSE && fs.existsSync(savedFile)) {
  cookies = JSON.parse(fs.readFileSync(savedFile, 'utf-8'));
  log(`复用上次扫码结果：${savedFile}`);
}

if (!cookies) {
  log(`\n=========== 账号 ${ACCT} 扫码登录 ===========`);

  const gen = await (
    await fetch(`${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`, {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
    })
  ).json();
  if (gen.code !== 0 || !gen.data?.qrcode_key) throw new Error(`取二维码失败 code=${gen.code} ${gen.message || ''}`);

  const qrKey = gen.data.qrcode_key;
  const qrUrl = gen.data.url;
  const pngPath = path.join(OUT_DIR, `acct${ACCT}.png`);
  const qr = loadQRCode();

  if (qr) {
    await qr.toFile(pngPath, qrUrl, { width: 420, margin: 2 });
    log(`二维码已生成：${pngPath}`);
    openFile(pngPath);
    log('已自动打开图片，请用 B 站手机客户端「扫一扫」扫描');
  } else {
    log('未找到 qrcode 模块，请手动打开下面的链接用手机扫描：');
    log(qrUrl);
  }
  log(`（${TIMEOUT_S} 秒内有效）`);

  // ── 2. 轮询扫码状态 ──
  const POLL = { 86101: '等待扫码…', 86090: '已扫码，请在手机上点「确认登录」…', 86038: '二维码已过期' };
  let lastMsg = '';
  const deadline = Date.now() + TIMEOUT_S * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    let poll;
    try {
      const r = await fetch(`${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${qrKey}&source=main-fe-header`, {
        headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/' },
      });
      poll = { json: await r.json(), headers: r.headers };
    } catch {
      continue; // 网络抖动，下一轮
    }

    const d = poll.json?.data || {};
    if (POLL[d.code] && POLL[d.code] !== lastMsg) {
      lastMsg = POLL[d.code];
      log(`  ${POLL[d.code]}`);
    }
    if (d.code === 86038) throw new Error('二维码已过期，请重新运行');

    if (d.code === 0) {
      // 优先从 Set-Cookie 取，其次从 data.url 的查询串取
      const bag = {};
      const setCookies = typeof poll.headers.getSetCookie === 'function' ? poll.headers.getSetCookie() : [];
      for (const c of setCookies) {
        const m = c.match(/^([^=]+)=([^;]*)/);
        if (m) bag[m[1].trim()] = m[2];
      }
      if (d.url) {
        const u = new URL(d.url);
        for (const [k, v] of u.searchParams) if (!bag[k]) bag[k] = v;
      }
      if (bag.SESSDATA) {
        cookies = { SESSDATA: bag.SESSDATA, BILI_JCT: bag.bili_jct || bag.BILI_JCT || '', DedeUserID: bag.DedeUserID || '' };
        break;
      }
    }
  }

  if (!cookies?.SESSDATA) throw new Error('扫码超时或未取到 SESSDATA');
  save(cookies);
}

// ── 3. 校验并打印身份（供人核对） ──
const nav = await (
  await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      cookie: `SESSDATA=${cookies.SESSDATA}; bili_jct=${cookies.BILI_JCT}`,
    },
  })
).json();
if (nav.code !== 0 || !nav.data?.isLogin) throw new Error(`登录校验失败 code=${nav.code} ${nav.message || ''}`);

log('');
log(`✅ ${nav.data.uname}（UID ${nav.data.mid}）cookie 有效`);
log(`   SESSDATA 长度 ${cookies.SESSDATA.length} | bili_jct ${cookies.BILI_JCT ? '有' : '缺失'}`);

// ── 4. 可选：写入 GitHub Secrets ──
if (PUSH) {
  log('\n写入 GitHub Secrets …');

  let tok = process.env.GH_TOKEN || '';
  if (!tok) {
    // 从本机 GCM 取 PAT（值不打印、不落盘）
    const out = execSync('git credential fill', { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf-8' });
    tok = (out.match(/^password=(.+)$/m) || [])[1] || '';
  }
  if (!tok) throw new Error('取不到 GitHub 令牌，无法写入 Secrets');

  const sealedbox = createRequire('C:/Users/Echo/.workbuddy/binaries/node/workspace/')('tweetnacl-sealedbox-js');
  const OWNER = process.env.REPO_OWNER || 'yu-echo';
  const REPO = process.env.REPO_NAME || 'bilibili-medal-optimized';
  const H = {
    authorization: `Bearer ${tok}`,
    'user-agent': 'wb',
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
  };

  const pk = await (
    await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/public-key`, { headers: H })
  ).json();
  if (!pk.key || !pk.key_id) throw new Error(`取仓库公钥失败：${JSON.stringify(pk).slice(0, 160)}`);
  const pubKey = Buffer.from(pk.key, 'base64');

  const put = async (name, value) => {
    const enc = sealedbox.seal(Buffer.from(String(value), 'utf8'), pubKey);
    const r = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/actions/secrets/${name}`, {
      method: 'PUT',
      headers: H,
      body: JSON.stringify({ encrypted_value: Buffer.from(enc).toString('base64'), key_id: pk.key_id }),
    });
    if (r.status !== 201 && r.status !== 204) throw new Error(`HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
    log(`   ✅ ${name}`);
  };

  await put(`SESSDATA_${ACCT}`, cookies.SESSDATA);
  if (cookies.BILI_JCT) await put(`BILI_JCT_${ACCT}`, cookies.BILI_JCT);
  log('   完成，下次 Actions 运行会直接用新 cookie');
}

log('\n下一步：Actions → 「B站每日任务」→ Run workflow');
