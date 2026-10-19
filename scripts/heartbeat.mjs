/**
 * B 站直播观看心跳（X25Kn 协议）
 *
 * 参考实现：BiliBiliToolPro 的 LiveFansMedalTaskRunner / HeartBeatRequest /
 * WridEncryptionDelegatingHandler。三处关键点，缺一个心跳就不被计入观看时长：
 *   1. buvid 必须用 LIVE_BUVID（从 news/v1/notice/recom 的 Set-Cookie 取），不是 buvid3
 *   2. 进房间和心跳的 body 都要带 web_location=444.8，心跳另带 trackid=-99998
 *   3. 两个请求都对 form body 做 wbi 签名，即 body 里补 wts + w_rid
 *
 * 流程：getRoomPlayInfo 拿分区 → POST /E 入场 → 等 heartbeat_interval → POST /X 循环
 */
import crypto from 'node:crypto';

const TRACE = 'https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn';
const ALGO = { 0: 'md5', 1: 'sha1', 2: 'sha256', 3: 'sha224', 4: 'sha512', 5: 'sha384' };
const MIXIN_V = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
  29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** LIVE_BUVID：直播域专用设备标识，没有它心跳不会被计入时长 */
export async function getLiveBuvid(cookie, UA) {
  const r = await fetch('https://api.live.bilibili.com/news/v1/notice/recom?product=live', {
    headers: { 'user-agent': UA, referer: 'https://live.bilibili.com/', cookie },
  });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  for (const c of sc) {
    const m = c.match(/^LIVE_BUVID=([^;]+)/);
    if (m) return m[1];
  }
  return '';
}

/** wbi mixin key（nav 的 img_key + sub_key 按固定表重排后取前 32 位） */
export async function getWbiMixin(cookie, UA) {
  const nav = await (
    await fetch('https://api.bilibili.com/x/web-interface/nav', {
      headers: { 'user-agent': UA, referer: 'https://www.bilibili.com/', cookie },
    })
  ).json();
  const img = nav?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0] || '';
  const sub = nav?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0] || '';
  const raw = img + sub;
  if (raw.length < 64) return '';
  return MIXIN_V.map((i) => raw.charAt(i)).join('').slice(0, 32);
}

/** 把 wts + w_rid 加进参数表；B 站签名前会剔除 !'()* 这些字符 */
function signWbi(params, mixin) {
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const clean = {};
  for (const [k, v] of Object.entries(withTs)) clean[k] = String(v).replace(/[!'()*]/g, '');
  const q = Object.keys(clean)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(clean[k])}`)
    .join('&');
  return { ...clean, w_rid: md5(q + mixin) };
}

/** secret_rule 描述 HMAC 链，逐层套用 */
function sypder(fields, rule, key) {
  const m = {
    platform: 'web',
    parent_id: fields.parent_id,
    area_id: fields.area_id,
    seq_id: fields.seq_id,
    room_id: fields.room_id,
    buvid: fields.buvid,
    uuid: fields.uuid,
    ets: fields.ets,
    time: fields.time,
    ts: fields.ts,
  };
  let d = JSON.stringify(m);
  for (const r of rule) d = crypto.createHmac(ALGO[r], key).update(d).digest('hex');
  return d;
}

/**
 * 在单个直播间挂机 minutes 分钟。
 * @returns {Promise<{ok:number, fail:number, lastCode:number, err?:string}>}
 */
export async function watchRoom({ roomId, ruid, minutes, UA, cookie, buvid, csrf, mixin, onTick, signal }) {
  const H = { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, cookie };

  // 分区信息在 room/v1/Room/get_info 里（getRoomPlayInfo 不返回）
  const info = await (
    await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}&from=room`, { headers: H })
  ).json();
  if (info.code !== 0) return { ok: 0, fail: 0, lastCode: info.code, err: `get_info ${info.code}` };
  if (Number(info.data?.live_status) !== 1) return { ok: 0, fail: 0, lastCode: -1, err: '主播未开播' };

  const parentId = Number(info.data?.parent_area_id);
  const areaId = Number(info.data?.area_id);
  if (!parentId || !areaId) return { ok: 0, fail: 0, lastCode: -1, err: '缺分区信息' };

  const uuid = crypto.randomUUID();
  const device = JSON.stringify([buvid, uuid]);

  const post = async (path, params) => {
    const signed = mixin ? signWbi(params, mixin) : params;
    const body = Object.entries(signed).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const r = await fetch(`${TRACE}/${path}`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return r.json().catch(() => ({ code: -1 }));
  };

  // 入场
  const eRes = await post('E', {
    id: JSON.stringify([parentId, areaId, 0, roomId]),
    ruid: String(ruid),
    ts: Date.now(),
    is_patch: 0,
    heart_beat: '[]',
    ua: UA,
    csrf_token: csrf,
    csrf,
    visit_id: '',
    device,
    web_location: '444.8',
  });
  if (eRes.code !== 0) return { ok: 0, fail: 0, lastCode: eRes.code, err: `E ${eRes.code} ${eRes.message || ''}` };

  let {
    heartbeat_interval: interval,
    secret_key: secretKey,
    secret_rule: secretRule,
    timestamp: ets,
  } = eRes.data;
  let seq = 1;
  let ok = 0;
  let fail = 0;
  let lastCode = 0;
  const need = Math.max(1, minutes);

  for (let i = 0; i < need; i++) {
    // 服务端要求等满一个间隔才认，早发会签不过
    await sleep(interval * 1000);
    if (signal?.aborted) break;

    // 对齐上游：每轮心跳前复查开播状态，中途下播立刻退出
    const chk = await (
      await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}&from=room`, { headers: H })
    ).json();
    if (chk.code !== 0 || Number(chk.data?.live_status) !== 1) {
      return { ok, fail, lastCode, err: '主播已下播' };
    }

    const ts = Date.now();
    const s = sypder(
      { parent_id: parentId, area_id: areaId, seq_id: seq, room_id: roomId, buvid, uuid, ets, time: interval, ts },
      secretRule,
      secretKey
    );
    const xRes = await post('X', {
      s,
      id: JSON.stringify([parentId, areaId, seq, roomId]),
      device,
      ruid: String(ruid),
      ets,
      benchmark: secretKey,
      time: interval,
      ts,
      ua: UA,
      csrf_token: csrf,
      csrf,
      visit_id: '',
      trackid: '-99998',
      web_location: '444.8',
    });

    if (xRes.code === 0) {
      ok += 1;
      lastCode = 0;
      ({ heartbeat_interval: interval, secret_key: secretKey, secret_rule: secretRule, timestamp: ets } = xRes.data);
      seq += 1;
    } else {
      fail += 1;
      lastCode = xRes.code;
      // 时间戳/签名失效 → 重新入场
      if (xRes.code === 1012002 || xRes.code === 1012001) {
        const re = await post('E', {
          id: JSON.stringify([parentId, areaId, 0, roomId]),
          ruid: String(ruid),
          ts: Date.now(),
          is_patch: 0,
          heart_beat: '[]',
          ua: UA,
          csrf_token: csrf,
          csrf,
          visit_id: '',
          device,
          web_location: '444.8',
        });
        if (re.code === 0) {
          ({ heartbeat_interval: interval, secret_key: secretKey, secret_rule: secretRule, timestamp: ets } = re.data);
          seq = 1;
        }
      }
    }
    onTick?.(i + 1, need, ok, fail, lastCode);
  }

  return { ok, fail, lastCode };
}
