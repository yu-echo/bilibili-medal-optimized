/**
 * 把「逐行日志」压成「按环节分组的结论」，给推送正文用。
 *
 * 为什么要有这一层：2026-10-26 用户两次反馈「成功失败的具体内容没显示」。
 * 直接回显日志有两个问题 —— 一是长（一个账号 25 行，两条推送近 1200 字，
 * 微信里看不完也不好扫），二是噪音大（`type=18 code=69825` 这种编号比结论还长）。
 * 所以这里按 emoji 前缀归类（✅ 成功 / ⏭️ 跳过 / ⚠️ 失败），同环节合并成一行，
 * 编号去掉、错误码挪到末尾括号里。
 *
 * 输出保持「失败在最前」：跳过和成功大多不用管，失败才要动手。
 */

const ICON = { fail: '✗', ok: '✓', skip: '⏭' };

/** 段名里去掉结尾的省略号，`[3/6] 大会员经验 / 积分签到 …` → `大会员经验 / 积分签到` */
const SECTION_RE = /^\[\d+\/\d+\]\s*(.+?)\s*(?:…|\.\.\.)?$/u;
const ITEM_RE = /^(✅|⏭️|⏭|⚠️|⚠|❌)\s*(.+)$/u;
const LIT_RE = /^点亮\s+(.+)$/u;
const IDENTITY_RE = /^(.+?)\s*\(mid=(\d+)\)(?:\s*｜\s*(.+))?$/u;
const CONTEXT_RE = /^共\s*(\d+)\s*枚｜已点亮\s*(\d+)/u;

/**
 * 单条消息洗掉噪音。
 * - `type=18` 是内部枚举，对人不产生信息，删掉
 * - `code=69825` 保留但挪到末尾括号：`淘宝账号查询异常(69825)`
 * - `，请退出重试` 这类尾巴在摘要里是噪音
 */
function clean(s) {
  const codes = [...s.matchAll(/code=\s*(-?\d+)/g)].map((m) => m[1]);
  let t = s
    .replace(/｜buvid3 (?:已获取|缺失)/g, '')
    .replace(/\btype=\s*\d+\s*/g, '')
    .replace(/\s*code=\s*-?\d+/g, '')
    .replace(/，请退出重试/g, '')
    .replace(/[，、。~～\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (codes.length) t += `(${codes.join('/')})`;
  return t;
}

/** 相同结论合并成 `请求错误(-400)×4` */
function collapse(items) {
  const seen = new Map();
  for (const it of items) seen.set(it, (seen.get(it) || 0) + 1);
  return [...seen.entries()].map(([k, n]) => (n > 1 ? `${k}×${n}` : k));
}

/**
 * @param {string[]} detail  runAccount 捕获的日志行
 * @returns {{identity: {name:string,tier:string,mid:string}|null, order: string[], groups: Map, dropped: number}}
 */
export function digestOf(detail) {
  const groups = new Map();
  const order = [];
  let section = '';
  let identity = null;
  let dropped = 0;
  const lit = new Map(); // section -> 点亮的牌子名

  const get = (k) => {
    if (!groups.has(k)) {
      groups.set(k, { ok: [], skip: [], fail: [], context: '' });
      order.push(k);
    }
    return groups.get(k);
  };

  for (const raw of detail || []) {
    const s = String(raw).replace(/\r/g, '').trim();
    if (!s) continue;
    if (/wbi mixin key/i.test(s)) continue;

    const sec = s.match(SECTION_RE);
    if (sec) {
      section = sec[1].trim();
      get(section);
      continue;
    }

    const ctx = s.match(CONTEXT_RE);
    if (ctx) {
      get(section || '其他').context = `${ctx[1]} 枚｜点亮 ${ctx[2]}`;
      continue;
    }

    const m = s.match(ITEM_RE);
    if (!m) {
      dropped++;
      continue;
    }

    const kind = m[1].startsWith('✅') ? 'ok' : m[1].startsWith('⏭') ? 'skip' : 'fail';
    const body = m[2].trim();

    // 登录检查那行是账号身份，抽出来当小标题，不混进条目
    if (kind === 'ok' && /登录/.test(section || '')) {
      // 尾巴的 `｜buvid3 已获取` 是过程细节，别带进小标题
      const id = body.replace(/\s*｜\s*buvid3\s*(?:已获取|缺失)/, '').match(IDENTITY_RE);
      if (id) {
        identity = { name: id[1].trim(), mid: id[2], tier: (id[3] || '').trim() };
        continue;
      }
    }

    // 点亮逐枚刷屏，合并成一条「点亮 N 枚：a、b 等」
    const litMatch = kind === 'ok' && body.match(LIT_RE);
    if (litMatch) {
      const key = section || '其他';
      if (!lit.has(key)) lit.set(key, []);
      lit.get(key).push(litMatch[1].trim());
      continue;
    }

    const text = clean(body);
    if (!text) {
      dropped++;
      continue;
    }
    get(section || '其他')[kind].push(text);
  }

  for (const [key, names] of lit) {
    const g = get(key);
    const head = names.slice(0, 4).join('、');
    g.ok.push(`点亮 ${names.length} 枚：${head}${names.length > 4 ? ' 等' : ''}`);
  }

  return { identity, order, groups, dropped };
}

/**
 * @param {object} d      digestOf 的结果
 * @param {{perGroup?:number, maxLines?:number}} opt
 * @returns {string[]} 推送正文里的几行
 */
export function renderDigest(d, { perGroup = 4, maxLines = 14 } = {}) {
  const bucket = { fail: [], ok: [], skip: [] };

  for (const sec of d.order) {
    const g = d.groups.get(sec);
    if (!g) continue;
    const label = g.context ? `${sec || '其他'}（${g.context}）` : sec || '其他';
    for (const kind of ['fail', 'ok', 'skip']) {
      const list = g[kind];
      if (!list || !list.length) continue;
      const items = collapse(list);
      const shown = items.slice(0, perGroup);
      const restN = items.length - shown.length;
      const rest = restN > 0 ? ` …另 ${restN} 项` : '';
      bucket[kind].push(`${ICON[kind]} ${label}：${shown.join('、')}${rest}`);
    }
  }

  const lines = [...bucket.fail, ...bucket.ok, ...bucket.skip];
  if (lines.length <= maxLines) return lines;

  // 失败优先占位（本来就排在前面），放不下就少列，但绝不超行
  const kept = lines.slice(0, maxLines - 1);
  return [...kept, `  …（另有 ${lines.length - kept.length} 行，见运行记录）`];
}

/** 一行账号小标题：`1. 神の麒零（年度大会员） 成功 2｜跳过 3｜失败 9` */
export function accountHead(idx, r, d) {
  const who = d.identity
    ? `${d.identity.name}${d.identity.tier ? `（${d.identity.tier}）` : ''}`
    : r.name || `账号${idx + 1}`;
  return `${idx + 1}. ${who} 成功 ${r.ok}｜跳过 ${r.skip}｜失败 ${r.fail}`;
}
