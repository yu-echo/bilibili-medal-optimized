// ==UserScript==
// @name         哔哩哔哩勋章粉丝牌升级
// @version      1.16-opt
// @description  哔哩哔哩获取亲密度（社区优化版）
// @author       无夏不春风orz
// @iconURL      https://www.bilibili.com/favicon.ico
// @match        https://live.bilibili.com/*
// @match        https://www.bilibili.com/blackboard/live/*
// @connect      bilibili.com
// @connect      api.bilibili.com
// @connect      api.live.bilibili.com
// @connect      live-trace.bilibili.com
// @require      https://unpkg.com/jquery@3.7.1/dist/jquery.js
// @require      https://unpkg.com/crypto-js@4.2.0/crypto-js.js
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// @license      MIT
// @namespace http://tampermonkey.net/
// ==/UserScript==


(function () {
    var NAME
    var BAPI
    var Live_info = {
        coin: undefined,
        room_id: undefined,
        uid: undefined,
        csrf_token: undefined,
        ruid: undefined,
        uname: undefined,
        Blever: undefined,
        vipType: undefined,
        face_url: undefined,
        vipTypetext: undefined,
        vipStatus: undefined,
        cost: undefined,
        img_key: undefined,
        sub_key: undefined,
    };
    const ts_ms = () => Date.now();
    const ts_s = () => Math.round(ts_ms() / 1000);
    function sleep(ms) {
        return new Promise(resolve => setTimeout(() => resolve('sleep'), ms));
    }
    // B 站接口返回的昵称等字段可能含 HTML 特殊字符，插入 innerHTML 前统一转义
    function esc(s) {
        return String(s === undefined || s === null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }
    function shuffle(arr) {
        var length = arr.length,
            randomIndex,
            temp;
        while (length) {
            randomIndex = Math.floor(Math.random() * (length--));
            temp = arr[randomIndex];
            arr[randomIndex] = arr[length];
            arr[length] = temp
        }
        return arr;
    }
    // 从任务副标题里安全取分钟数，取不到返回 null
    function parseMinutes(sub_title) {
        if (!sub_title) return null;
        const m = String(sub_title).match(/\d+/);
        return m ? parseInt(m[0], 10) : null;
    }
    // 当前打开的是哪个直播间（优先用 BilibiliLive 的真实房间号，短号匹配不上就算了）
    function currentRoomId() {
        try {
            if (typeof BilibiliLive !== 'undefined' && BilibiliLive && BilibiliLive.ROOMID) {
                return Number(BilibiliLive.ROOMID) || 0;
            }
        } catch (e) { }
        const m = location.pathname.match(/^\/(\d+)/);
        return m ? Number(m[1]) : 0;
    }
    // 把当前直播间的勋章提到队首，剩下的保持原有顺序
    function prioritizeCurrentRoom(list) {
        const cur = currentRoomId();
        if (!cur || !Array.isArray(list)) return list;
        const idx = list.findIndex(x => x.room_info && Number(x.room_info.room_id) === cur);
        if (idx <= 0) return list;
        const out = list.slice();
        const item = out.splice(idx, 1)[0];
        out.unshift(item);
        return out;
    }
    // 每枚粉丝牌每日亲密度上限：实测 day_limit 返回 20000（接口占位值），
    // 真实自然获取上限是 1500，取更小者；字段缺失时按未满处理，保持原有行为
    // 注意：实测今日点赞获得的亲密度不进 today_feed（点满 10/10 后 today_feed 仍是 0），
    //       所以这个函数只能当兜底，能否再做某任务以 task_info 的 is_done 为准
    function isFeedFull(item) {
        const m = item && item.medal;
        if (!m) return false;
        const feed = Number(m.today_feed);
        if (isNaN(feed)) return false;
        const limit = Number(m.day_limit);
        const cap = (!isNaN(limit) && limit > 0 && limit < 1500) ? limit : 1500;
        return feed >= cap;
    }
    const newWindow = {
        init: () => {
            return newWindow.Toast.init();
        },
        Toast: {
            init: () => {
                try {
                    const list = [];
                    window.toast = (msg, type = 'info', timeout = 5e3) => {
                        console.log(msg)
                        switch (type) {
                            case 'success':
                            case 'info':
                            case 'error':
                                break;
                            default:
                                type = 'info';
                        }
                        const a = $(`<div class="link-toast ${type} fixed" style="z-index:2001;text-align: left;"><span class="toast-text"></span></div>`)[0];
                        // 用 textContent 写入，避免消息里的 < > 被当成标签
                        a.querySelector('.toast-text').textContent = String(msg);
                        document.body.appendChild(a);
                        a.style.top = (document.body.scrollTop + list.length * 40 + 10) + 'px';
                        a.style.left = 10 + 'px';
                        list.push(a);
                        setTimeout(() => {
                            a.className += ' out';
                            setTimeout(() => {
                                list.shift();
                                list.forEach((v) => {
                                    v.style.top = (parseInt(v.style.top, 10) - 40) + 'px';
                                });
                                $(a).remove();
                            }, 200);
                        }, timeout);
                    };
                    return $.Deferred().resolve();
                } catch (err) {
                    return $.Deferred().reject();
                }
            }
        }
    }
    const getCookie = (name) => {
        let arr = document.cookie.match(new RegExp("(^| )" + name + "=([^;]*)(;|$)"));
        if (arr != null)
            return unescape(arr[2]);
        return false;
    }
    $(function () { //DOM完毕，等待弹幕加载完成
        if ((typeof BilibiliLive) == "undefined") {
            BilibiliLive = undefined;
        }
        let retry = 0;
        let loadInfo = (delay) => {
            setTimeout(async function () {
                GM_xmlhttpRequest({
                    method: "GET",
                    url: "https://api.bilibili.com/x/web-interface/nav",
                    onload: async function (response) {
                        let data;
                        try {
                            data = JSON.parse(response.response);
                        } catch (e) {
                            loadInfo(10000);
                            return;
                        }
                        if (!data.data || !data.data.isLogin) {
                            retry++;
                            if (retry > 30) {
                                window.toast('未登录超过 30 次重试，已停止。请先登录 B 站后刷新页面', 'error', 15000);
                                return;
                            }
                            loadInfo(10000);
                            window.toast('无账号登陆信息,请先登录或检查网络', 'error', 8000);
                        } else {
                            if (BilibiliLive == undefined || BilibiliLive.ROOMID == undefined) return loadInfo(5000);
                            Live_info.room_id = BilibiliLive.ROOMID;
                            Live_info.ruid = BilibiliLive.ANCHOR_UID
                            Live_info.uid = data.data.mid
                            Live_info.coin = parseInt(data.data.money)
                            Live_info.Blever = data.data.level_info.current_level
                            Live_info.vipType = data.data.vipType
                            Live_info.vipStatus = data.data.vipStatus
                            Live_info.uname = data.data.uname
                            Live_info.face_url = data.data.face
                            Live_info.vipTypetext = data.data.vip_label.text
                            if (Live_info.vipTypetext == '') Live_info.vipTypetext = '普通用户'
                            if (data.data.wbi_img) {
                                let img_url = data.data.wbi_img.img_url
                                let sub_url = data.data.wbi_img.sub_url
                                Live_info.img_key = img_url.slice(img_url.lastIndexOf('/') + 1, img_url.lastIndexOf('.'))
                                Live_info.sub_key = sub_url.slice(sub_url.lastIndexOf('/') + 1, sub_url.lastIndexOf('.'))
                                // 关键修复：把接口下发的最新签名密钥交给 BilibiliAPI，不再用硬编码 key
                                if (typeof BilibiliAPI !== 'undefined') {
                                    BilibiliAPI.setWbiKeys(Live_info.img_key, Live_info.sub_key)
                                }
                            }
                            NAME = 'BILI' + Live_info.uid
                            Live_info.csrf_token = getCookie('bili_jct');
                            window.toast('登陆信息获取成功', 'success');
                            init();
                        }
                    },
                    onerror: function () {
                        retry++;
                        if (retry > 30) {
                            window.toast('获取登录信息连续失败，已停止重试', 'error', 15000);
                            return;
                        }
                        loadInfo(10000);
                        window.toast('无账号登陆信息,请先登录或检查网络', 'error', 8000);
                    }
                });
            }, delay);
        };
        newWindow.init();
        loadInfo(5000);
    });

    async function init() { //API初始化
        const right_ctnr = $('.right-ctnr');
        const share = right_ctnr.find('.v-middle.icon-font.icon-share').parent();
        const remove_button = $(
            `<div data-v-6d89404b="" data-v-42ea937d="" title="" class="icon-ctnr live-skin-normal-a-text pointer" id = "blth_like_button" style="line-height: 16px;margin-left: 15px;"><i data-v-6d89404b="" class="v-middle icon-font icon-delete" style="font-size: 16px;"></i><span data-v-6d89404b="" class="action-text v-middle" style="font-size: 12px;margin-left: 5px;">去掉直播水印</span></div>`
        );
        remove_button.click(() => {
            $('.web-player-icon-roomStatus').remove()
        });
        const blanc_button = $(
            `<div data-v-6d89404b="" data-v-42ea937d="" title="" class="icon-ctnr live-skin-normal-a-text pointer" id = "blth_like_button" style="line-height: 16px;margin-left: 15px;"><i data-v-6d89404b="" class="v-middle icon-font icon-top" style="font-size: 16px;"></i><span data-v-6d89404b="" class="action-text v-middle" style="font-size: 12px;margin-left: 5px;">回到默认界面</span></div>`
        );
        blanc_button.click(() => {
            window.top.location.href = 'https://live.bilibili.com/blanc/' + Live_info.room_id
        })
        if (right_ctnr.length !== 0 && share.length !== 0) {
            right_ctnr[0].insertBefore(remove_button[0], share[0]);
            right_ctnr[0].insertBefore(blanc_button[0], remove_button[0]);
        }
        BAPI = BilibiliAPI;
        const MY_API = {
            CONFIG_DEFAULT: {
                auto_medal_task: true,
                auto_sendmsg: false,
                auto_like: true,
                medal_level_pass: true,
                medal_pass_level: 999,
                js_running_mark: 0,
                medal_pass_uid: [],
                sort: true,
                hide_Toast: true,
                medal_first_uid: [],
                auto_share_watch: true,
                auto_coin_add: false,
                auto_vip_privilege: true,
            },
            CONFIG: {},
            loadConfig: async function () {
                // 原版靠 JSON.parse(null) 抛异常走 catch 来兜底，且 reject 后无人 catch 会产生
                // unhandled rejection。这里改成显式判空，永远 resolve，返回是否成功读到用户配置。
                let ok = true;
                try {
                    MY_API.CONFIG = JSON.parse(JSON.stringify(MY_API.CONFIG_DEFAULT));
                    const raw = localStorage.getItem(`${NAME}_CONFIG`);
                    const config = raw ? JSON.parse(raw) : null;
                    if (config && typeof config === 'object') {
                        for (let item in MY_API.CONFIG) {
                            if (!MY_API.CONFIG.hasOwnProperty(item)) continue;
                            if (config[item] !== undefined && config[item] !== null)
                                MY_API.CONFIG[item] = config[item];
                        }
                    } else {
                        ok = false;
                        MY_API.saveConfig();
                    }
                } catch (e) {
                    console.log('[勋章升级] 配置解析失败，使用默认配置', e);
                    MY_API.CONFIG = JSON.parse(JSON.stringify(MY_API.CONFIG_DEFAULT));
                    MY_API.saveConfig();
                    ok = false;
                }
                // 脏配置修正：数组型必须是数组、数字型必须是数字，否则后续 .indexOf / 比较会抛错
                ['medal_pass_uid', 'medal_first_uid'].forEach(k => {
                    if (!Array.isArray(MY_API.CONFIG[k])) MY_API.CONFIG[k] = [];
                });
                MY_API.CONFIG.medal_pass_level = Number(MY_API.CONFIG.medal_pass_level) || 999;
                MY_API.CONFIG.js_running_mark = Number(MY_API.CONFIG.js_running_mark) || 0;
                return ok;
            },
            saveConfig: function () {
                try {
                    localStorage.setItem(`${NAME}_CONFIG`, JSON.stringify(MY_API.CONFIG));
                    return true
                } catch (e) {
                    console.log('API保存出错', e);
                    return false
                }
            },
            creatSetBox: function () { // 创建设置框
                const heightmax = $('.chat-history-panel').height();

                const div = $("<div class='xzsjzsdiv'>");

                div.css({
                    'width': '400px',
                    'min-width': '400px',
                    'height': '600px',
                    'max-height': (heightmax && heightmax > 400 ? heightmax : 600) + 'px',
                    'position': 'absolute',
                    'top': '100px',
                    'right': '10px',
                    'background': 'rgba(255,255,255,.95)',
                    'padding': '10px',
                    'z-index': '99',
                    'border-radius': '12px',
                    'box-shadow': '0 4px 12px rgba(0,0,0,0.15)',
                    'transition': 'all .3s ease',
                    'overflow': 'auto',
                    'line-height': '1.2',
                    'font-family': 'system-ui, -apple-system, sans-serif'
                });

                div.append(`
        <div class="settings-header">
            <h3 style="margin:0;color:#06aed5;text-align:center;">勋章升级设置</h3>
        </div>
        <fieldset class="settings-fieldset">
            <legend class="settings-legend">用户信息</legend>
            <div id="user_info" class="user-info">
                <img src="${esc(Live_info.face_url)}" width="50" height="50" class="user-avatar">
                <div class="user-details">
                    <div><span class="detail-label">昵称：</span>${esc(Live_info.uname)}</div>
                    <div><span class="detail-label">UID：</span>${esc(Live_info.uid)}</div>
                    <div><span class="detail-label">直播消费：</span>${esc(Live_info.cost)}</div>
                    <div><span class="detail-label">会员等级：</span>${esc(Live_info.vipTypetext)}</div>
                    <div><span class="detail-label">主站等级：</span>Lv${esc(Live_info.Blever)}</div>
                    <div><span class="detail-label">硬币数量：</span>${esc(Live_info.coin)}</div>
                </div>
            </div><br>
            <div class="user-details">
            <div class="setting-item" data-toggle="auto_share_watch">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">主站升级（观看分享）</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="auto_coin_add">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">主站升级（随机投币）</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="auto_vip_privilege">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">大会员权益自动领取</span>
                </label>
            </div>
            </div>
        </fieldset>

        <fieldset class="settings-fieldset">
            <legend class="settings-legend">勋章升级参数设置</legend>
            <div class="setting-item" data-toggle="auto_medal_task">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">自动直播观看任务</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="auto_like">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">自动直播点赞任务</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="auto_sendmsg">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">自动非播弹幕任务</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="medal_level_pass">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">高级勋章任务跳过</span>
                </label>
            </div>
            <div class="setting-item" data-toggle="medal_level_pass_num">
                <span class="setting-label">跳过</span>
                <input class="setting-input num" type="number" min="1">
                <span class="setting-label">级及以上勋章</span>
                <button class="setting-button" data-action="save">保存</button>
            </div>
            <div class="setting-item" data-toggle="medal_pass_uid">
                <div class="setting-label">不执行观看任务主播UID [逗号隔开]</div>
                <div class="input-group">
                    <input class="setting-input keyword" type="text" placeholder="输入UID，多个用逗号分隔">
                    <button class="setting-button" data-action="save">保存</button>
                </div>
            </div>

            <div class="setting-item" data-toggle="medal_first_uid">
                <div class="setting-label">优先执行观看任务主播UID [逗号隔开]</div>
                <div class="input-group">
                    <input class="setting-input keyword" type="text" placeholder="输入UID，多个用逗号分隔">
                    <button class="setting-button" data-action="save">保存</button>
                </div>
            </div>

            <div class="setting-item" data-toggle="sort">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">按等级升序/降序顺序执行</span>
                </label>
            </div>

            <div class="setting-item" data-toggle="hide_Toast">
                <label class="checkbox-container">
                    <input type="checkbox">
                    <span class="checkmark"></span>
                    <span class="setting-label">运行提示信息弹出显示</span>
                </label>
            </div>

            <div class="settings-note">
                <ul>
                <p><strong>注意事项：</strong></p>
                    <li>同一时间仅一个勋章可获得亲密度，故每日观看总亲密度有上限，可适当排序或过滤。部分设置需要刷新后生效。
                </ul>
            </div>
        </fieldset>
        <div class="settings-footer" data-toggle="ui_hide">
            <button class="setting-button toggle-button" data-action="save">隐藏设置面板</button>
        </div>
    `);

                $('head').append(`
        <style>
            .xzsjzsdiv {
                scrollbar-width: thin;
                scrollbar-color: #06aed5 rgba(0,0,0,0.1);
            }
            .xzsjzsdiv::-webkit-scrollbar {
                width: 6px;
            }
            .xzsjzsdiv::-webkit-scrollbar-thumb {
                background-color: #06aed5;
                border-radius: 3px;
            }
            .settings-fieldset {
                border: 1px solid #ddd;
                border-radius: 8px;
                margin-bottom: 5px;
                padding: 10px;
            }
            .settings-legend {
                color: #06aed5;
                font-weight: bold;
                padding: 0 8px;
                font-size: 14px;
            }
            .user-info {
                display: flex;
                gap: 10px;
                align-items: flex-start;
            }
            .user-avatar {
                border-radius: 50%;
                border: 2px solid #06aed5;
            }
            .user-details {
                display: grid;
                grid-template-columns: 1fr 1fr;
                gap: 4px;
                font-size: 12px;
            }
            .detail-label {
                color: #666;
                font-weight: bold;
            }
            .setting-item {
                margin-bottom: 2px;
                padding: 0px 0;
                border-bottom: 1px dashed #eee;
            }
            .setting-item:last-child {
                border-bottom: none;
            }
            .checkbox-container {
                display: flex;
                align-items: center;
                cursor: pointer;
                position: relative;
                user-select: none;
            }
            .checkbox-container input {
                position: absolute;
                opacity: 0;
                cursor: pointer;
                height: 0;
                width: 0;
            }
            .checkmark {
                position: relative;
                height: 18px;
                width: 18px;
                background-color: #fff;
                border: 1px solid #06aed5;
                border-radius: 4px;
                margin-right: 8px;
            }
            .checkbox-container input:checked ~ .checkmark {
                background-color: #06aed5;
            }
            .checkmark:after {
                content: "";
                position: absolute;
                display: none;
            }
            .checkbox-container input:checked ~ .checkmark:after {
                display: block;
            }
            .checkbox-container .checkmark:after {
                left: 6px;
                top: 2px;
                width: 5px;
                height: 10px;
                border: solid white;
                border-width: 0 2px 2px 0;
                transform: rotate(45deg);
            }
            .setting-label {
                font-size: 14px;
                color: #333;
            }
            .setting-input {
                padding: 6px 8px;
                border: 1px solid #ddd;
                border-radius: 4px;
                font-size: 14px;
                margin: 0 5px;
                width: 50px;
            }
            .setting-input.keyword {
                width: 220px;
                margin-right: 8px;
            }
            .setting-button {
                background-color: #06aed5;
                color: white;
                border: none;
                padding: 6px 12px;
                border-radius: 4px;
                cursor: pointer;
                font-size: 13px;
                transition: all 0.2s;
            }
            .setting-button:hover {
                background-color: #0589b0;
            }
            .input-group {
                display: flex;
                align-items: center;
                margin-top: 5px;
            }
            .settings-note {
                font-size: 12px;
                color: #666;
                margin-top: 15px;
                background: #f8f8f8;
                padding: 0px;
                border-radius: 6px;
            }
            .settings-note ul {
                margin: 5px 0 0 15px;
                padding: 0;
            }
            .settings-note li {
                margin-bottom: 3px;
            }
            .toggle-button {
                display: block;
                width: 100%;
                margin-top: 10px;
                background-color: #888;
            }
            .toggle-button:hover {
                background-color: #666;
            }
        </style>
    `);

                // 原版强依赖 .player-ctnr 这串 B 站内部类名，改版后找不到会整块不渲染
                const mount = $('.player-ctnr.left-container.p-relative.z-player-ctnr');
                (mount.length ? mount : $('body')).append(div);

                div.find('div[data-toggle="ui_hide"] [data-action="save"]').click(function () {
                    $('.xzsjzsdiv').toggle();
                    $(this).text($('.xzsjzsdiv').is(':visible') ? '隐藏设置面板' : '显示设置面板');
                });

                const initCheckbox = (toggle, configKey) => {
                    const checkbox = div.find(`div[data-toggle="${toggle}"] input`);
                    if (MY_API.CONFIG[configKey]) {
                        checkbox.prop('checked', true);
                    }
                    checkbox.change(function () {
                        MY_API.CONFIG[configKey] = $(this).prop('checked');
                        MY_API.saveConfig();
                        window.toast(`${configKey.replace(/_/g, ' ')} 设置: ${MY_API.CONFIG[configKey]}`);
                        if (configKey === 'auto_medal_task' && MY_API.CONFIG[configKey]) {
                            window.location.reload();
                        }
                    });
                };

                initCheckbox('auto_medal_task', 'auto_medal_task');
                initCheckbox('auto_sendmsg', 'auto_sendmsg')
                initCheckbox('auto_like', 'auto_like')
                initCheckbox('auto_coin_add', 'auto_coin_add');
                initCheckbox('auto_share_watch', 'auto_share_watch');
                initCheckbox('auto_vip_privilege', 'auto_vip_privilege');
                initCheckbox('medal_level_pass', 'medal_level_pass');
                initCheckbox('sort', 'sort');
                // 注意：hide_Toast 这个键名语义是反的（true = 弹出提示），保留原键名以兼容已保存配置
                initCheckbox('hide_Toast', 'hide_Toast');

                div.find('div[data-toggle="medal_level_pass_num"] .num').val(parseInt(MY_API.CONFIG.medal_pass_level.toString()));
                div.find('div[data-toggle="medal_level_pass_num"] [data-action="save"]').click(function () {
                    const level = parseInt(div.find('div[data-toggle="medal_level_pass_num"] .num').val());
                    if (isNaN(level) || level < 1) {
                        window.toast('请输入1以上的有效数字');
                        return;
                    }
                    MY_API.CONFIG.medal_pass_level = level;
                    MY_API.saveConfig();
                    window.toast(`勋章跳过等级已设置为: ${MY_API.CONFIG.medal_pass_level}`);
                });

                const handleUidSave = (toggle, configKey, message) => {
                    const input = div.find(`div[data-toggle="${toggle}"] .keyword`);
                    input.val(MY_API.CONFIG[configKey].join(', '));

                    div.find(`div[data-toggle="${toggle}"] [data-action="save"]`).click(function () {
                        let val = input.val().trim();
                        if (!val) {
                            MY_API.CONFIG[configKey] = [];
                            MY_API.saveConfig();
                            window.toast(`${message} 已清空`);
                            return;
                        }

                        val = val.replaceAll('，', ',');
                        const uids = val.split(",")
                            .map(uid => uid.trim())
                            .filter(uid => uid !== '')
                            .map(uid => Number(uid))
                            .filter(uid => !isNaN(uid));

                        const uniqueUids = [...new Set(uids)];
                        MY_API.CONFIG[configKey] = uniqueUids;
                        MY_API.saveConfig();
                        window.toast(`${message} 已设置: ${uniqueUids.join(', ')}`);
                    });
                };

                handleUidSave('medal_pass_uid', 'medal_pass_uid', '【观看跳过】主播UID');
                handleUidSave('medal_first_uid', 'medal_first_uid', '【观看优先】主播UID');
            },
            getMedalList: async () => {
                let medal_list_now = [];
                let break_mark = false
                for (let page = 1; page < 999; page++) {
                    if (break_mark) break
                    await BAPI.fansMedal_panel(page).then(async (data) => {
                        const d = data && data.data;
                        if (!d) { break_mark = true; return; }
                        if (Array.isArray(d.list)) medal_list_now = medal_list_now.concat(d.list);
                        // 原版直接 d.special_list.length，接口少字段就抛错并中断整个循环
                        if (Array.isArray(d.special_list) && d.special_list.length) medal_list_now = medal_list_now.concat(d.special_list);
                        window.toast(`正在获取勋章数据：已获取${medal_list_now.length}个`, 'success');
                        if (!d.page_info || d.page_info.current_page >= d.page_info.total_page) {
                            break_mark = true;
                        } else {
                            await sleep(2000)
                        }
                    }, () => {
                        break_mark = true;
                    });
                }
                return medal_list_now
            },
            auto_heartbert: async () => {
                window.toast(`【勋章升级】开始获取勋章数据...`);
                try {
                    let medal_list_now = await MY_API.getMedalList()
                    if (!Array.isArray(medal_list_now)) medal_list_now = [];
                    if (MY_API.CONFIG.sort && medal_list_now.length) medal_list_now.sort(function (a, b) { return a.medal.level - b.medal.level; });
                    if (!MY_API.CONFIG.sort && medal_list_now.length) medal_list_now.sort(function (a, b) { return b.medal.level - a.medal.level; });
                    if (MY_API.CONFIG.medal_first_uid.length && medal_list_now.length) {
                        let new_medal_list_now = []
                        let first_medal_list = []
                        for (let i = 0; i < medal_list_now.length; i++) {
                            if (MY_API.CONFIG.medal_first_uid.indexOf(medal_list_now[i].medal.target_id) > -1) {
                                first_medal_list.push(medal_list_now[i])
                            } else {
                                new_medal_list_now.push(medal_list_now[i])
                            }
                        }
                        medal_list_now = [].concat(first_medal_list).concat(new_medal_list_now)
                    }
                    // 当前打开直播间的牌子排到队首，优先观看
                    medal_list_now = prioritizeCurrentRoom(medal_list_now)
                    let start_ts = ts_s()
                    if (medal_list_now.length) {
                        for (let i = 0; i < medal_list_now.length; i++) {
                            let dotime = 30
                            let ndotime = 30
                            let task_info_mark = true
                            let hasWatchTask = false
                            await BAPI.task_info(medal_list_now[i].medal.target_id).then(async (data) => {
                                let task_info = data && data.data && data.data.task_info
                                if (Array.isArray(task_info)) {
                                    for (let t = 0; t < task_info.length; t++) {
                                        if (task_info[t].jump_type == "watchLive") {
                                            hasWatchTask = true
                                            if (task_info[t].is_done) task_info_mark = false
                                            const mins = parseMinutes(task_info[t].sub_title)
                                            if (mins === null) continue
                                            ndotime = (10 - mins) * 15
                                            if (ndotime < dotime) dotime = ndotime
                                        }
                                    }
                                } else {
                                    task_info_mark = false
                                }
                            }, () => { task_info_mark = false })
                            if (!task_info_mark) {
                                await sleep(5000)
                                continue
                            }
                            // 实测：20 级以上的牌子任务里已没有 watchLive，只剩"仅点亮"，
                            // 这种牌子挂机 30 分钟一点亲密度都不涨，必须跳过
                            if (!hasWatchTask) {
                                if (MY_API.CONFIG.hide_Toast) window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}][${medal_list_now[i].medal.level}] 无观看任务，跳过`)
                                continue
                            }
                            if (MY_API.CONFIG.medal_level_pass && medal_list_now[i].medal.level >= MY_API.CONFIG.medal_pass_level) {
                                if (MY_API.CONFIG.hide_Toast) window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}][${medal_list_now[i].medal.level}] 超出等级跳过`)
                                continue
                            }
                            if (MY_API.CONFIG.medal_pass_uid.indexOf(medal_list_now[i].medal.target_id) > -1) {
                                if (MY_API.CONFIG.hide_Toast) window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}][${medal_list_now[i].medal.level}] 不执行名单跳过`)
                                continue
                            }
                            // 每枚牌子每日亲密度上限 1500，已满再挂就是纯浪费（原版没有这个判断）
                            if (isFeedFull(medal_list_now[i])) {
                                if (MY_API.CONFIG.hide_Toast) window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 今日亲密度已满 1500，跳过`)
                                continue
                            }
                            for (let t = 0; t < dotime; t++) {
                                setTimeout(async () => {
                                    if (MY_API.CONFIG.hide_Toast) window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}][${medal_list_now[i].medal.level}] 进度${t + 1}/${dotime}/${ndotime}`, 'info', 60000)
                                }, t * 60 * 1000)
                            }
                            let roomHeart = new RoomHeart(medal_list_now[i].room_info.room_id, dotime, medal_list_now[i].medal.target_id)
                            // 原版不管心跳是否启动成功都白等 dotime 分钟
                            const started = await roomHeart.start()
                            if (!started) {
                                window.toast(`【观看任务】[${medal_list_now[i].anchor_info.nick_name}] 房间信息获取失败，跳过`, 'error');
                                continue
                            }
                            await sleep(dotime * 60 * 1000)
                        }
                    }
                    if (ts_s() - start_ts < 10 * 60) {
                        window.toast(`【观看任务】将在10分钟后重新运行...`)
                        await sleep(10 * 60 * 1000)
                    }
                } catch (e) {
                    // 任一接口异常不再让整条自动任务链断掉
                    console.error('[勋章升级] 观看任务异常', e);
                    window.toast(`【观看任务】异常：${e && e.message ? e.message : e}，60秒后继续`, 'error', 10000);
                    await sleep(60 * 1000)
                }
                return MY_API.auto_heartbert()
            },
            like_msg: async () => {
                window.toast(`【点赞弹幕】1分钟后执行...`);
                await sleep(60000)
                window.toast(`【点赞弹幕】开始获取勋章直播状态...`);
                let start_ts = ts_s()
                // 表情包列表整轮只取一次，原版是每个勋章都请求一遍同一个接口
                let dmlist = []
                if (MY_API.CONFIG.auto_sendmsg) {
                    await BAPI.GetEmoticons().then((re) => {
                        if (re && re.code == 0 && re.data && re.data.data && re.data.data[0] && Array.isArray(re.data.data[0].emoticons)) {
                            let emlist = re.data.data[0].emoticons
                            for (let i = 0; i < emlist.length; i++) {
                                if (emlist[i].emoji) dmlist.push(emlist[i].emoji)
                            }
                        }
                    }, () => { })
                }
                let medal_list_now = []
                try {
                    medal_list_now = await MY_API.getMedalList()
                } catch (e) {
                    console.error('[点赞弹幕] 获取勋章失败', e);
                }
                if (!Array.isArray(medal_list_now)) medal_list_now = [];
                // 当前打开直播间的牌子排到队首，优先点赞/点亮
                medal_list_now = prioritizeCurrentRoom(medal_list_now);
                try {
                    for (let i = 0; i < medal_list_now.length; i++) {
                        if (MY_API.CONFIG.medal_level_pass && medal_list_now[i].medal.level >= MY_API.CONFIG.medal_pass_level) {
                            continue
                        }
                        if (MY_API.CONFIG.medal_pass_uid.indexOf(medal_list_now[i].medal.target_id) > -1) {
                            continue
                        }
                        // 今日亲密度已满 1500，点赞/弹幕也不会再加，直接跳过
                        if (isFeedFull(medal_list_now[i])) {
                            continue
                        }

                        if (medal_list_now[i].room_info.living_status) {
                            if (MY_API.CONFIG.auto_like) {
                                await BAPI.task_info(medal_list_now[i].medal.target_id).then(async (data) => {
                                    let task_info = data && data.data && data.data.task_info
                                    if (!Array.isArray(task_info)) return
                                    for (let t = 0; t < task_info.length; t++) {
                                        // 实测点赞满了之后接口照样返回 code 0 但不涨亲密度，必须靠 is_done 拦
                                        if (task_info[t].jump_type == "like" && !task_info[t].is_done && task_info[t].sub_title == "仅点亮") {
                                            await sleep(5000)
                                            await BAPI.likeReportV3(medal_list_now[i].room_info.room_id, medal_list_now[i].medal.uid, medal_list_now[i].medal.target_id, Live_info.csrf_token, 30).then(async (re) => {
                                                if (re.code == 0) {
                                                    window.toast(`【点赞点亮】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 点赞成功`, 'success');
                                                } else {
                                                    window.toast(`【点赞点亮】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 点赞：${re.message}`, 'error');
                                                }
                                            }, () => { })
                                        }
                                        if (task_info[t].jump_type == "like" && !task_info[t].is_done && task_info[t].sub_title !== "仅点亮") {
                                            await sleep(5000)
                                            const mins = parseMinutes(task_info[t].sub_title)
                                            if (mins === null) continue
                                            let liketime = (10 - mins) * 30
                                            if (liketime > 0) {
                                                await BAPI.likeReportV3(medal_list_now[i].room_info.room_id, medal_list_now[i].medal.uid, medal_list_now[i].medal.target_id, Live_info.csrf_token, liketime).then(async (re) => {
                                                    if (re.code == 0) {
                                                        window.toast(`【点赞任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 点赞 ${liketime} 次成功`, 'success');
                                                    } else {
                                                        window.toast(`【点赞任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 点赞：${re.message}`, 'error');
                                                    }
                                                }, () => { })
                                            }
                                        }
                                    }
                                }, () => { })
                            }
                        }
                        if (!medal_list_now[i].room_info.living_status && MY_API.CONFIG.auto_sendmsg) {
                            await BAPI.task_info(medal_list_now[i].medal.target_id).then(async (data) => {
                                let task_info = data && data.data && data.data.task_info
                                if (!Array.isArray(task_info)) return
                                for (let t = 0; t < task_info.length; t++) {
                                    if (task_info[t].jump_type == "sendDanmu" && !task_info[t].is_done && task_info[t].sub_title == "仅点亮") {
                                        shuffle(dmlist)
                                        for (let h = 0; h < Math.min(10, dmlist.length); h++) {
                                            await sleep(5000)
                                            let msg = dmlist[h]
                                            if (!msg) break
                                            await BAPI.sendmsg(msg, medal_list_now[i].room_info.room_id, Live_info.csrf_token).then(async (re) => {
                                                if (re.code == 0) {
                                                    window.toast(`【弹幕点亮】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 弹幕发送成功`, 'success');
                                                } else {
                                                    window.toast(`【弹幕点亮】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 弹幕：${re.message}`, 'error');
                                                }
                                            }, () => { })
                                        }
                                    }
                                    if (task_info[t].jump_type == "sendDanmu" && !task_info[t].is_done && task_info[t].sub_title !== "仅点亮") {
                                        await sleep(5000)
                                        const mins = parseMinutes(task_info[t].sub_title)
                                        if (mins === null) continue
                                        let liketime = 10 - mins
                                        if (liketime > 0) {
                                            shuffle(dmlist)
                                            for (let h = 0; h < Math.min(liketime, dmlist.length); h++) {
                                                await sleep(5000)
                                                let msg = dmlist[h]
                                                if (!msg) break
                                                await BAPI.sendmsg(msg, medal_list_now[i].room_info.room_id, Live_info.csrf_token).then(async (re) => {
                                                    if (re.code == 0) {
                                                        window.toast(`【弹幕任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 弹幕发送成功`, 'success');
                                                    } else {
                                                        window.toast(`【弹幕任务】[${medal_list_now[i].anchor_info.nick_name}] [${medal_list_now[i].medal.medal_name}] 弹幕：${re.message}`, 'error');
                                                    }
                                                }, () => { })
                                            }
                                        }
                                    }
                                }
                            }, () => { })
                        }
                    }
                } catch (e) {
                    console.error('[点赞弹幕] 循环异常', e);
                }
                if (ts_s() - start_ts < 10 * 60) {
                    await sleep(10 * 60 * 1000)
                }
                return MY_API.like_msg()
            },
            experience_add: async () => {//主站经验大会员加速包
                if (Live_info.vipType >= 1 && Live_info.vipStatus == 1) {
                    await BAPI.experience_add(Live_info.csrf_token).then(async (re) => {
                        if (re.code == 0) {
                            window.toast(`【大会员经验】主站经验大会员加速包领取成功`, 'success');
                        } else if (re.code == 69801) {
                            window.toast(`【大会员经验】主站经验大会员加速包已领取`, 'error');
                        } else {
                            window.toast(`【大会员经验】主站经验大会员加速包：${re.message}`, 'error');
                        }
                    }, () => { });
                    window.toast(`【大会员经验】将在12小时后重新运行...`)
                    await sleep(12 * 3600 * 1000)
                    return MY_API.experience_add()
                }
            },
            // 大会员权益领取：只看 recive_state（1=未领取，2=已领取）。
            // state 字段不能当判据——实测 state=0 表示「有权益但未领」，领成功后变 1，与直觉相反。
            vip_privilege: async () => {
                if (!(Live_info.vipType >= 1 && Live_info.vipStatus == 1)) return;
                // 失败类型缓存：淘宝未绑定(69825)/超大会员(6034021)/活动过期(6034019)/不支持web(-400)
                // 这些是前置条件不满足，每轮重试纯属浪费，记下来 7 天内不再请求
                const SKIP_KEY = `${NAME}_VIP_SKIP`;
                const now = ts_s();
                let skip = {};
                try { skip = JSON.parse(localStorage.getItem(SKIP_KEY) || '{}') || {}; } catch (e) { skip = {}; }
                try {
                    let targets = [];
                    await BAPI.vip_privilege_my().then((re) => {
                        if (re.code !== 0 || !re.data || !Array.isArray(re.data.list)) return;
                        targets = re.data.list
                            .filter(x => Number(x.recive_state) === 1)
                            .filter(x => {
                                const t = String(x.type);
                                return !skip[t] || now - skip[t] > 7 * 86400;
                            });
                    }, () => { });
                    if (!targets.length) {
                        window.toast(`【大会员权益】当前无可领取项`);
                    } else {
                        let okCount = 0, failCount = 0;
                        for (let i = 0; i < targets.length; i++) {
                            const t = targets[i].type;
                            await BAPI.vip_privilege_receive(t, Live_info.csrf_token).then((re) => {
                                if (re.code === 0) {
                                    okCount++;
                                    delete skip[t];
                                    window.toast(`【大会员权益】类型 ${t} 领取成功`, 'success');
                                } else if (re.code === 69801 || re.code === 69818) {
                                    // 已领过（69818 是"已领过，请到移动端查看"）
                                    delete skip[t];
                                } else {
                                    failCount++;
                                    skip[t] = now;
                                    console.warn(`[大会员权益] type=${t} code=${re.code} ${re.message}`);
                                }
                            }, () => { });
                            await sleep(3000);
                        }
                        if (okCount) window.toast(`【大会员权益】本轮领取 ${okCount} 项`, 'success');
                        if (failCount) console.warn(`[大会员权益] ${failCount} 项有前置条件未满足，已记 7 天内跳过`);
                    }
                } catch (e) {
                    console.error('[大会员权益] 异常', e);
                }
                try { localStorage.setItem(SKIP_KEY, JSON.stringify(skip)); } catch (e) { }
                window.toast(`【大会员权益】将在6小时后重新运行...`)
                await sleep(6 * 3600 * 1000)
                return MY_API.vip_privilege()
            },
            score_task_sign: async () => {//大会员自动签到
                if (Live_info.vipType >= 1 && Live_info.vipStatus == 1) {
                    await BAPI.score_task_sign().then(async (re) => {
                        if (re.code == 0 && re.message == "success") {
                            window.toast(`【大会员签到】大会员签到成功`, 'success');
                            await BAPI.vip_point_task_combine().then((r) => {
                                if (r.code == 0) {
                                    window.toast(`【大会员签到】大会员积分：${r.data.point_info.point}`, 'success');
                                }
                            }, () => { })
                        }
                    }, () => { });
                    window.toast(`【大会员签到】将在12小时后重新运行...`)
                    await sleep(12 * 3600 * 1000)
                    return MY_API.score_task_sign()
                }
            },
            watch_share: async () => {
                await BAPI.top_rcmd().then(async (response) => {
                    if (response.code === 0 && response.data.item) {
                        const obj = (response.data.item[0])
                        await BAPI.watch_heartbeat(obj.id, obj.cid, Live_info.uid, Live_info.csrf_token).then((response) => {
                            if (response.code === 0) {
                                window.toast(`【视频观看】视频观看完成(av=${obj.id})`, 'success');
                            } else {
                                window.toast(`【视频观看】视频观看${response.message}`, 'error');
                            }
                        }, () => { })
                        await BAPI.aid_share(obj.id, Live_info.csrf_token).then((response) => {
                            if (response.code === 0) {
                                window.toast(`【视频分享】视频分享完成(av=${obj.id})`, 'success');
                            } else {
                                window.toast(`【视频分享】视频分享${response.message}`, 'error');
                            }
                        }, () => { })
                    } else {
                        window.toast(`【观看分享】获取视频失败：${response.message}`, 'error');
                    }
                }, () => {
                    window.toast(`【观看分享】推荐接口请求失败`, 'error');
                })
                window.toast(`【观看分享】将在12小时后重新运行...`)
                await sleep(12 * 3600 * 1000)
                return MY_API.watch_share()
            },
            coin_add: async () => {
                await BAPI.exp().then(async (response) => {
                    if (response.code === 0) {
                        let need_coin = (50 - response.data) / 10
                        if (need_coin > 0) {
                            await BAPI.article_recommends().then(async (response) => {
                                let oidlist = response.data
                                if (!Array.isArray(oidlist)) return
                                let break_mark = false
                                for (let i = 0; i < need_coin; i++) {
                                    if (break_mark) break
                                    if (!oidlist[i]) break
                                    await BAPI.article_coin_add(oidlist[i].id, oidlist[i].author.mid, Live_info.csrf_token).then(async (response) => {
                                        if (response.code === 0) {
                                            window.toast(`【投币任务】投币1个成功(av=${oidlist[i].id})`);
                                        } else {
                                            break_mark = true
                                            window.toast(`【投币任务】投币${response.message}`);
                                        }
                                    }, () => { break_mark = true })
                                    await sleep(5000)
                                }
                            }, () => { })
                        } else {
                            window.toast(`【投币任务】投币任务已完成`);
                        }
                    }
                }, () => { })
                window.toast(`【投币任务】将在12小时后重新运行...`)
                await sleep(12 * 3600 * 1000)
                return MY_API.coin_add()
            },

        };
        await MY_API.loadConfig()
        try {
            // 同一标签页重载（刷新 / B站 SPA 路由切换）时 beforeunload 不一定触发，
            // 会留下上一次的心跳标记，导致新实例把自己误判成"已在运行"直接退出、面板不出现。
            // 用 sessionStorage 区分「本标签页重载」和「另一个标签页真的在跑」。
            if (sessionStorage.getItem(`${NAME}_TAB`) === '1') {
                MY_API.CONFIG.js_running_mark = 0;
                MY_API.saveConfig();
            }
            sessionStorage.setItem(`${NAME}_TAB`, '1');
            const promiseInit = $.Deferred();
            const uniqueCheck = () => {
                const t = Date.now();
                // 检测窗口只比写入间隔(5s)略大，避免刷新瞬间被自己上一次的标记挡住
                if (t - MY_API.CONFIG.js_running_mark >= 0 && t - MY_API.CONFIG.js_running_mark <= 6e3) {
                    window.toast('检测到另一个标签页正在运行本脚本。若没有其他标签页，等 10 秒后刷新即可', 'error', 15000);
                    return promiseInit.reject();
                }
                return promiseInit.resolve();
            };
            uniqueCheck().then(() => {
                let timer_unique;
                const uniqueMark = () => {
                    // 原版每 2 秒同步写一次 localStorage + 整个 CONFIG 序列化，改 5 秒
                    timer_unique = setTimeout(uniqueMark, 5e3);
                    MY_API.CONFIG.js_running_mark = Date.now();
                    try {
                        localStorage.setItem(`${NAME}_CONFIG`, JSON.stringify(MY_API.CONFIG));
                        return true
                    } catch (e) {
                        console.log('API保存出错', e);
                        return false
                    };
                };
                window.addEventListener('beforeunload', () => {
                    if (timer_unique) {
                        clearTimeout(timer_unique);
                        MY_API.CONFIG.js_running_mark = 0;
                        try {
                            localStorage.setItem(`${NAME}_CONFIG`, JSON.stringify(MY_API.CONFIG));
                            return true
                        } catch (e) {
                            console.log('API保存出错', e);
                            return false
                        };
                    }
                });
                uniqueMark();
                StartPlunder(MY_API);
            });
        } catch (e) {
            console.error('重复运行检测错误', e);
        }
    }
    async function StartPlunder(API) {
        await BAPI.room_init(Live_info.room_id).then(async function (data) {
            if (data.code == 0 && data.data.live_status == 1) {
                window.toast('当前直播间正在直播，由于B站限制仅能生效一个观看亲密度（包括各端），可能不能正常获取亲密度，请挂在未开播直播间', 'error', 60000);
            }
        }, () => { })

        let icon_pic = 'https://s1.hdslb.com/bfs/live/e051dfd4557678f8edcac4993ed00a0935cbd9cc.png'
        let ui_button = $(`<img width=100 height=100 style="position: fixed; top: 155px; right: 60px;z-index:999;" src=${icon_pic} />`)
        $('html').append(ui_button);
        ui_button.click(function () {
            $('.xzsjzsdiv').toggle()
        });

        // 先取消费数据，再建面板，避免面板先渲染出 undefined 再覆盖
        let get_cost = () => {
            return BAPI.cost().then((re) => {
                if (re.code == 0) {
                    let list = re.data.info
                    for (let i = 0; i < list.length; i++) {
                        if (list[i].title == "富可敌国") {
                            if (list[i].finished) {
                                Live_info.cost = '10个W元以上'
                            } else {
                                Live_info.cost = parseInt(list[i].progress.now / 10) + '元'
                            }
                            break
                        }
                    }
                }
            }, () => { });
        }
        await get_cost()

        API.creatSetBox(); //创建设置框
        $('.xzsjzsdiv').hide()

        setTimeout(async () => {
            if (API.CONFIG.auto_medal_task) {
                API.auto_heartbert()
            }
            if (API.CONFIG.auto_like || API.CONFIG.auto_sendmsg) {
                API.like_msg()
            }
            if (API.CONFIG.auto_share_watch) {
                API.watch_share()
                API.score_task_sign()
                API.experience_add()
            }
            if (API.CONFIG.auto_vip_privilege) {
                API.vip_privilege()
            }
            if (API.CONFIG.auto_coin_add) {
                API.coin_add()
            }
        }, 5 * 1000);
    }
})();

const BilibiliAPI = {
    runUntilSucceed: (callback, delay = 0, period = 50) => {
        setTimeout(() => {
            if (!callback())
                BilibiliAPI.runUntilSucceed(callback, period, period);
        }, delay);
    },
    processing: 0,
    ajax: (settings) => {
        if (settings.xhrFields === undefined)
            settings.xhrFields = {};
        settings.xhrFields.withCredentials = true;
        jQuery.extend(settings, {
            url: settings.url,
            method: settings.method || 'GET',
            crossDomain: true,
            dataType: settings.dataType || 'json'
        });
        const p = jQuery.Deferred();
        BilibiliAPI.runUntilSucceed(() => {
            if (BilibiliAPI.processing > 8)
                return false;
            ++BilibiliAPI.processing;
            return jQuery.ajax(settings).then((arg1, arg2, arg3) => {
                --BilibiliAPI.processing;
                p.resolve(arg1, arg2, arg3);
                return true;
            }, (arg1, arg2, arg3) => {
                --BilibiliAPI.processing;
                p.reject(arg1, arg2, arg3);
                return true;
            });
        });
        return p;
    },
    getPictureHashKey(i) {
        const V = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52], N = [];
        return V.forEach(U => { i.charAt(U) && N.push(i.charAt(U)) }), N.join("").slice(0, 32)
    },
    // 兜底密钥：仅当 nav 接口没返回 wbi_img 时使用
    WBI_FALLBACK: { img: "7cd084941338484aae1ad9425b84077c", sub: "4932caff0ff746eab6f01bf08b70ac45" },
    wbi: { img: "", sub: "" },
    setWbiKeys: (img, sub) => {
        if (img && sub) {
            BilibiliAPI.wbi.img = img;
            BilibiliAPI.wbi.sub = sub;
        }
    },
    getMixinKey: () => {
        const img = BilibiliAPI.wbi.img || BilibiliAPI.WBI_FALLBACK.img;
        const sub = BilibiliAPI.wbi.sub || BilibiliAPI.WBI_FALLBACK.sub;
        return BilibiliAPI.getPictureHashKey(img + sub);
    },
    // wbi 签名：参数按 key 字典序排序后拼接，再拼 mixin key 做 MD5
    wbiQuery: (params) => {
        const mixin = BilibiliAPI.getMixinKey();
        const all = Object.assign({}, params, { wts: Math.round(Date.now() / 1000) });
        const query = Object.keys(all).sort().map(k => `${k}=${encodeURIComponent(all[k])}`).join('&');
        return `${query}&w_rid=${CryptoJS.MD5(query + mixin).toString()}`;
    },
    likeReportV3: (room_id, uid, ruid, csrf_token, click_time = 300) => {
        const query = BilibiliAPI.wbiQuery({
            anchor_id: ruid,
            click_time: click_time,
            csrf: csrf_token,
            room_id: room_id,
            uid: uid,
            web_location: 444.8,
        });
        return BilibiliAPI.ajax({
            method: "POST",
            url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3?" + query,
        })
    },
    sendmsg: (msg, roomid, csrf) => {
        const query = BilibiliAPI.wbiQuery({ web_location: 444.8 });
        return BilibiliAPI.ajax({
            method: 'POST',
            url: 'https://api.live.bilibili.com/msg/send?' + query,
            data: {
                'bubble': 0,
                'msg': msg,
                'color': 16777215,
                'mode': 1,
                'room_type': 0,
                'jumpfrom': 0,
                'reply_mid': 0,
                'reply_attr': 0,
                'replay_dmid': '',
                'statistics': JSON.stringify({ "appId": 100, "platform": 5 }),
                'reply_type': 0,
                'reply_uname': '',
                'data_extend': JSON.stringify({ "trackid": "-99998" }),
                'fontsize': 25,
                'rnd': Math.round(Date.now() / 1000),
                'roomid': roomid,
                'csrf': csrf,
                'csrf_token': csrf,
            }
        });
    },
    GetEmoticons: () => {//表情包信息
        return BilibiliAPI.ajax({
            url: "https://api.live.bilibili.com/xlive/web-ucenter/v2/emoticon/GetEmoticons?platform=pc&room_id=25746928",
            method: "GET",
        })
    },
    task_info: (ruid) => {//勋章任务
        return BilibiliAPI.ajax({
            url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/GetActivatedMedalInfo?target_id=" + ruid,
            method: "GET",
        })
    },
    fansMedal_panel: (page, pageSize = 50) => {//获取全部勋章数据
        return BilibiliAPI.ajax({
            url: "https://api.live.bilibili.com/xlive/app-ucenter/v1/fansMedal/panel",
            method: "GET",
            data: {
                page: page,
                page_size: pageSize
            }
        })
    },
    cost: () => {//花费适用于10w以下
        return BilibiliAPI.ajax({
            url: "https://api.live.bilibili.com/xlive/web-ucenter/v1/achievement/list?type=normal&status=0&category=all&keywords=&page=1&pageSize=100",
            method: "GET",
        })
    },
    room_init: (roomid) => {
        return BilibiliAPI.ajax({
            url: "https://api.live.bilibili.com/room/v1/Room/room_init?id=" + roomid,
            method: "GET",
        })
    },
    top_rcmd: () => {//首页视频推荐
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/web-interface/index/top/rcmd",
            method: "GET",
        })
    },
    watch_heartbeat: (i, e, a, csrf) => {//视频观看
        return BilibiliAPI.ajax({
            method: "POST",
            url: "https://api.bilibili.com/x/report/web/heartbeat",
            data: {
                aid: i,
                cid: e,
                mid: a,
                start_ts: Math.round(Date.now() / 1000),
                played_time: 0,
                realtime: 0,
                type: 3,
                play_type: 1,
                dt: 2,
                csrf: csrf
            }
        })
    },
    aid_share: (i, csrf) => {//视频分享
        return BilibiliAPI.ajax({
            method: "POST",
            url: "https://api.bilibili.com/x/web-interface/share/add",
            data: {
                aid: i,
                csrf: csrf,
                jsonp: "jsonp"
            }
        })
    },
    exp: () => {//投币经验
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/web-interface/coin/today/exp",
        })
    },
    article_recommends: () => {//获取最新专栏信息
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/article/recommends",
            method: "GET",
            data: {
                aid: '',
                cid: 3,
                pn: 1,
                ps: 20,
                jsonp: 'jsonp',
                sort: 1
            }
        })
    },
    article_coin_add: (oid, upid, csrf) => {//专栏投币
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/web-interface/coin/add",
            method: "POST",
            data: {
                aid: oid,
                upid: upid,
                multiply: 1,
                avtype: 2,
                csrf: csrf
            }
        })
    },
    experience_add: (csrf) => {//大会员经验包
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/vip/experience/add",
            method: "POST",
            data: {
                csrf: csrf
            }
        })
    },
    vip_privilege_my: () => {//大会员权益列表（含每项 recive_state）
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/vip/privilege/my",
            method: "GET",
        })
    },
    vip_privilege_receive: (type, csrf) => {//领取大会员权益，type: 1=B币券 2=会员购券 3=漫画福利券 4=包邮券 6=装扮体验卡
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/vip/privilege/receive",
            method: "POST",
            data: {
                type: type,
                platform: 'web',
                csrf: csrf
            }
        })
    },
    score_task_sign: () => {//大会员积分签到
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/pgc/activity/score/task/sign",
            method: "POST",
        })
    },
    vip_point_task_combine: () => {//大会员积分查询
        return BilibiliAPI.ajax({
            url: "https://api.bilibili.com/x/vip/point/task/combine",
            method: "GET",
        })
    },
}
//https://github.com/lzghzr/TampermonkeyJS

class RoomHeart {
    constructor(t, g, r) {
        this.roomID = t,
            this.Dotime = g,
            this.ruid = r
    }
    areaID;
    parentID;
    seq = 0;
    roomID;
    Dotime;
    get id() {
        return [this.parentID, this.areaID, this.seq, this.roomID]
    }
    buvid = this.getItem("LIVE_BUVID");
    uuid = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (t => {
        const e = 16 * Math.random() | 0;
        return ("x" === t ? e : 3 & e | 8).toString(16)
    }));
    device = [this.buvid, this.uuid];
    get ts() {
        return Date.now()
    }
    _patchData = {};
    get patchData() {
        const t = [];
        for (const [e, i] of Object.entries(this._patchData))
            t.push(i);
        return t
    }
    get isPatch() {
        return 0 === this.patchData.length ? 0 : 1
    }
    W = "undefined" == typeof unsafeWindow ? window : unsafeWindow;
    ua = this.W && this.W.navigator ? this.W.navigator.userAgent : "";
    csrf = this.getItem("bili_jct") || "";
    nextInterval = Math.floor(5) + Math.floor(55 * Math.random());
    heartBeatInterval;
    secretKey;
    secretRule;
    timestamp;
    lastHeartbeatTimestamp = Date.now();
    get watchTimeFromLastReport() {
        const t = Math.ceil(((new Date).getTime() - this.lastHeartbeatTimestamp) / 1e3);
        return t < 0 ? 0 : t > this.heartBeatInterval ? this.heartBeatInterval : t
    }
    start() {
        return this.getInfoByRoom()
    }
    doneFunc = function () { };
    async getInfoByRoom() {
        if (0 === this.roomID)
            return !1;
        const t = await fetch(`//api.live.bilibili.com/room/v1/Room/get_info?room_id=${this.roomID}&from=room`, {
            mode: "cors",
            credentials: "include"
        }).then((t => t.json())).catch(() => ({ code: -1 }));
        return 0 === t.code && (({
            area_id: this.areaID,
            parent_area_id: this.parentID,
            room_id: this.roomID
        } = t.data), 0 !== this.areaID && 0 !== this.parentID && (this.e(), !0))
    }
    async webHeartBeat() {
        if (this.seq > this.Dotime)
            return;
        const t = `${this.nextInterval}|${this.roomID}|1|0`,
            e = CryptoJS.enc.Utf8.parse(t),
            i = CryptoJS.enc.Base64.stringify(e),
            s = await fetch(`//live-trace.bilibili.com/xlive/rdata-interface/v1/heartbeat/webHeartBeat?hb=${encodeURIComponent(i)}&pf=web`, {
                mode: "cors",
                credentials: "include"
            }).then((t => t.json())).catch(() => ({ code: -1 }));
        0 === s.code && (this.nextInterval = s.data.next_interval, setTimeout((() => this.webHeartBeat()), 1e3 * this.nextInterval))
    }
    async savePatchData() {
        if (this.seq > this.Dotime)
            return;
        const t = {
            id: JSON.stringify(this.id),
            device: JSON.stringify(this.device),
            ruid: this.ruid,
            ets: this.timestamp,
            benchmark: this.secretKey,
            time: this.watchTimeFromLastReport > this.heartBeatInterval ? this.heartBeatInterval : this.watchTimeFromLastReport,
            ts: this.ts,
            ua: this.ua
        },
            e = this.sypder(JSON.stringify(t), this.secretRule),
            i = Object.assign({
                s: e
            }, t);
        this._patchData[this.roomID] = i,
            setTimeout((() => this.savePatchData()), 15e3)
    }
    async e() {
        const t = {
            id: JSON.stringify(this.id),
            device: JSON.stringify(this.device),
            ruid: this.ruid,
            ts: this.ts,
            is_patch: 0,
            heart_beat: "[]",
            ua: this.ua
        },
            e = await fetch("//live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/E", {
                headers: {
                    "content-type": "application/x-www-form-urlencoded"
                },
                method: "POST",
                body: `${this.json2str(t)}&csrf_token=${this.csrf}&csrf=${this.csrf}&visit_id=`,
                mode: "cors",
                credentials: "include"
            }).then((t => t.json())).catch(() => ({ code: -1 }));
        0 === e.code && (this.seq += 1, ({
            heartbeat_interval: this.heartBeatInterval,
            secret_key: this.secretKey,
            secret_rule: this.secretRule,
            timestamp: this.timestamp
        } = e.data), setTimeout((() => this.x()), 1e3 * this.heartBeatInterval))
    }
    async x() {
        if (this.seq > this.Dotime)
            return this.doneFunc();
        const t = {
            id: JSON.stringify(this.id),
            device: JSON.stringify(this.device),
            ruid: this.ruid,
            ets: this.timestamp,
            benchmark: this.secretKey,
            time: this.heartBeatInterval,
            ts: this.ts,
            ua: this.ua
        },
            e = this.sypder(JSON.stringify(t), this.secretRule),
            i = Object.assign({
                s: e
            }, t);
        this._patchData[this.roomID] = i,
            this.lastHeartbeatTimestamp = Date.now();
        const s = await fetch("//live-trace.bilibili.com/xlive/data-interface/v1/x25Kn/X", {
            headers: {
                "content-type": "application/x-www-form-urlencoded"
            },
            method: "POST",
            body: `${this.json2str(i)}&csrf_token=${this.csrf}&csrf=${this.csrf}&visit_id=`,
            mode: "cors",
            credentials: "include"
        }).then((t => t.json())).catch(() => ({ code: -1 }));
        0 === s.code && (this.seq += 1, ({
            heartbeat_interval: this.heartBeatInterval,
            secret_key: this.secretKey,
            secret_rule: this.secretRule,
            timestamp: this.timestamp
        } = s.data), setTimeout((() => this.x()), 1e3 * this.heartBeatInterval))
    }
    sypder(t, e) {
        const i = JSON.parse(t),
            [s, a, r, n] = JSON.parse(i.id),
            [o, c] = JSON.parse(i.device),
            h = i.benchmark,
            m = {
                platform: "web",
                parent_id: s,
                area_id: a,
                seq_id: r,
                room_id: n,
                buvid: o,
                uuid: c,
                ets: i.ets,
                time: i.time,
                ts: i.ts
            };
        let d = JSON.stringify(m);
        for (const t of e)
            switch (t) {
                case 0:
                    d = CryptoJS.HmacMD5(d, h).toString(CryptoJS.enc.Hex);
                    break;
                case 1:
                    d = CryptoJS.HmacSHA1(d, h).toString(CryptoJS.enc.Hex);
                    break;
                case 2:
                    d = CryptoJS.HmacSHA256(d, h).toString(CryptoJS.enc.Hex);
                    break;
                case 3:
                    d = CryptoJS.HmacSHA224(d, h).toString(CryptoJS.enc.Hex);
                    break;
                case 4:
                    d = CryptoJS.HmacSHA512(d, h).toString(CryptoJS.enc.Hex);
                    break;
                case 5:
                    d = CryptoJS.HmacSHA384(d, h).toString(CryptoJS.enc.Hex);
                    break;
                default:
                    break
            }
        return d
    }
    getItem(t) {
        return decodeURIComponent(document.cookie.replace(new RegExp("(?:(?:^|.*;)\\s*" + encodeURIComponent(t).replace(/[\-\.\+\*]/g, "\\$&") + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1")) || ""
    }
    json2str(t) {
        let e = "";
        for (const i in t)
            e += `${i}=${encodeURIComponent(t[i])}&`;
        return e.slice(0, -1)
    }
}
