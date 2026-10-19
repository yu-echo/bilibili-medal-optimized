/**
 * B 站直播观看心跳（X25Kn 协议）
 *
 * 流程：get_info 拿分区 → POST /E 握手拿 secret_key + secret_rule + 间隔
 *      → 等 heartbeat_interval 秒 → POST /X 上报（HMAC 链签名）→ 循环
 * 每上报一次算观看 1 分钟；每 5 分钟得 6 亲密度，单枚牌子每日封顶 30（=25 分钟）。
 *
 * 移植自用户脚本 RoomHeart（源 https://github.com/lzghzr/TampermonkeyJS）
 */
import crypto from 'node:crypto';

const TRACE = 'https://live-trace.bilibili.com/xlive/data-interface/v1/x25Kn';
const ALGO = { 0: 'md5', 1: 'sha1', 2: 'sha256', 3: 'sha224', 4: 'sha512', 5: 'sha384' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** secret_rule 描述的是 HMAC 链，逐层套用 */
function sign(fields, rule, key) {
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
 * @returns {Promise<{ok:number, fail:number, lastCode:number}>}
 */
export async function watchRoom({ roomId, ruid, minutes, UA, cookie, buvid, csrf, onTick, signal }) {
  const H = { 'user-agent': UA, referer: `https://live.bilibili.com/${roomId}`, cookie };

  const info = await (await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${roomId}&from=room`, { headers: H })).json();
  if (info.code !== 0) return { ok: 0, fail: 0, lastCode: info.code, err: `get_info ${info.code} ${info.message || ''}` };
  const { area_id, parent_area_id } = info.data;
  if (!area_id || !parent_area_id) return { ok: 0, fail: 0, lastCode: -1, err: 'get_info 缺分区' };

  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });

  let seq = 0;
  let interval = 60;
  let secretKey = '';
  let secretRule = [];
  let ets = 0;

  const post = async (path, body) => {
    const r = await fetch(`${TRACE}/${path}`, {
      method: 'POST',
      headers: { ...H, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    return r.json().catch(() => ({ code: -1 }));
  };

  // E 握手
  const eFields = {
    id: JSON.stringify([parent_area_id, area_id, seq, roomId]),
    device: JSON.stringify([buvid, uuid]),
    ruid: String(ruid),
    ts: Date.now(),
    is_patch: 0,
    heart_beat: '[]',
    ua: UA,
  };
  const eBody = Object.entries(eFields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const eRes = await post('E', `${eBody}&csrf_token=${csrf}&csrf=${csrf}&visit_id=`);
  if (eRes.code !== 0) return { ok: 0, fail: 0, lastCode: eRes.code, err: `E ${eRes.code} ${eRes.message || ''}` };

  ({ heartbeat_interval: interval, secret_key: secretKey, secret_rule: secretRule, timestamp: ets } = eRes.data);
  seq += 1;

  let ok = 0;
  let fail = 0;
  let lastCode = 0;
  const need = Math.max(1, minutes);

  for (let i = 0; i < need; i++) {
    // 服务端要求等满一个间隔才认，早发会签不过
    await sleep(interval * 1000);
    if (signal?.aborted) break;

    const payload = {
      id: JSON.stringify([parent_area_id, area_id, seq, roomId]),
      device: JSON.stringify([buvid, uuid]),
      ruid: String(ruid),
      ets,
      benchmark: secretKey,
      time: interval,
      ts: Date.now(),
      ua: UA,
    };
    const s = sign(
      {
        parent_id: parent_area_id,
        area_id,
        seq_id: seq,
        room_id: roomId,
        buvid,
        uuid,
        ets,
        time: interval,
        ts: payload.ts,
      },
      secretRule,
      secretKey
    );
    const body = Object.entries({ ...payload, s }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const xRes = await post('X', `${body}&csrf_token=${csrf}&csrf=${csrf}&visit_id=`);

    if (xRes.code === 0) {
      ok += 1;
      lastCode = 0;
      ({ heartbeat_interval: interval, secret_key: secretKey, secret_rule: secretRule, timestamp: ets } = xRes.data);
      seq += 1;
    } else {
      fail += 1;
      lastCode = xRes.code;
      // 时间戳失效就重新握手一次
      if (xRes.code === 1012002 || xRes.code === 1012001) {
        const re = await post(
          'E',
          `${Object.entries({
            id: JSON.stringify([parent_area_id, area_id, 0, roomId]),
            device: JSON.stringify([buvid, uuid]),
            ruid: String(ruid),
            ts: Date.now(),
            is_patch: 0,
            heart_beat: '[]',
            ua: UA,
          })
            .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
            .join('&')}&csrf_token=${csrf}&csrf=${csrf}&visit_id=`
        );
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
