// B 站粉丝牌数据诊断（只读）
// 用途：验证 fansMedal/panel 返回的真实字段，特别是 today_feed / medal_id / room_info
// 安全：全程只发 GET 请求，不做任何写操作（不签到、不佩戴、不点赞、不发弹幕）
//       不回传 cookie、uid、昵称，只回传统计数字和字段名
// 用法：登录 B 站后打开任意直播间 → F12 → Console → 粘贴执行
//       若提示 "Warning: Don't paste code..."，先手动输入 allow pasting 回车

(async () => {
  const j = async (u) => (await fetch(u, { credentials: 'include' })).json();
  const out = { login: false };

  const nav = await j('https://api.bilibili.com/x/web-interface/nav');
  out.login = !!(nav.data && nav.data.isLogin);
  if (!out.login) {
    console.log('%c未登录，请先在 B 站登录再跑', 'color:#e33;font-weight:bold');
    return;
  }

  // 勋章列表，翻页取全
  let medals = [], page = 1, guard = 0;
  while (guard++ < 50) {
    const r = await j(`https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel?page=${page}&page_size=50`);
    if (!r.data) { out.panelError = r.code + ' ' + r.message; break; }
    if (Array.isArray(r.data.list)) medals = medals.concat(r.data.list);
    if (Array.isArray(r.data.special_list)) medals = medals.concat(r.data.special_list);
    const pi = r.data.page_info || {};
    if (!pi.total_page || pi.current_page >= pi.total_page) break;
    page++;
    await new Promise(s => setTimeout(s, 800));
  }

  const m0 = medals[0] || {};
  out.medalCount = medals.length;
  out.medalFields = Object.keys(m0.medal || {});
  out.roomInfoFields = Object.keys(m0.room_info || {});
  out.anchorInfoFields = Object.keys(m0.anchor_info || {});

  const feeds = medals.map(x => Number(x.medal && x.medal.today_feed)).filter(v => !isNaN(v));
  out.hasTodayFeed = feeds.length;
  out.feedBuckets = {
    '==0': feeds.filter(v => v === 0).length,
    '1-299': feeds.filter(v => v > 0 && v < 300).length,
    '300-1199': feeds.filter(v => v >= 300 && v < 1200).length,
    '1200-1499': feeds.filter(v => v >= 1200 && v < 1500).length,
    '>=1500': feeds.filter(v => v >= 1500).length,
  };
  out.levelAtLeast20 = medals.filter(x => x.medal && x.medal.level >= 20).length;
  out.medalIdPresent = medals.filter(x => x.medal && x.medal.medal_id).length;
  out.roomIdValid = medals.filter(x => x.room_info && x.room_info.room_id > 0).length;
  // 实测：佩戴字段是 wearing_status（不是 wear），1 = 当前佩戴
  out.wearingStatus = {
    worn: medals.filter(x => x.medal && Number(x.medal.wearing_status) === 1).length,
    notWorn: medals.filter(x => x.medal && Number(x.medal.wearing_status) !== 1).length,
  };
  // 实测：is_lighted 才决定有没有 watchLive 任务，与等级无关
  out.isLighted = {
    lit: medals.filter(x => x.medal && Number(x.medal.is_lighted) === 1).length,
    unlit: medals.filter(x => x.medal && Number(x.medal.is_lighted) !== 1).length,
  };
  out.dayLimitValues = [...new Set(medals.map(x => x.medal && x.medal.day_limit))];

  // 应援团只拉列表，不签到
  try {
    const g = await j('https://api.vc.bilibili.com/link_group/v1/member/my_groups?build=0&mobi_app=web');
    out.fansClubGroups = (g.code === 0 && g.data && Array.isArray(g.data.list)) ? g.data.list.length : ('code=' + g.code);
  } catch (e) {
    out.fansClubGroups = 'error';
  }

  console.log('%c诊断结果（不含 uid / 昵称 / cookie）', 'color:#06aed5;font-weight:bold;font-size:14px');
  console.table(out.feedBuckets);
  console.log(JSON.stringify(out, null, 2));
  try { copy(JSON.stringify(out)); console.log('已复制到剪贴板，直接粘贴回来即可'); } catch (e) {}
})();
