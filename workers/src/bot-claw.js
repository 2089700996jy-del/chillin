/**
 * 微信 ClawBot 接入层（官方 iLink 协议）：纯 Worker 长轮询与收发，无需 OpenClaw 常驻机器。
 * 传输：https://ilinkai.weixin.qq.com，POST + JSON，Authorization: Bearer <bot_token>
 * 收信：POST /ilink/bot/getupdates 游标控制；回信：POST /ilink/bot/sendmessage。
 * 扫码状态异常换到 redirect_host 轮询；每分钟 cron 走 pollClawAccounts 维持收信。
 */
import { truncateUtf8, buildBotReply, claimBotMessage } from './bot-commands.js';
import { toClawText } from './bot-text.js';
import { extractClawImageItems } from './bot-media.js';
import { handleClawImageMessage } from './bot-image-flow.js';
import {
    saveCursor,
    markAccountError,
    markAccountSuccess,
    startClawLogin,
    checkClawLogin,
    unbindClaw,
    handleClawApi
} from './bot-claw-auth.js';

export {
    startClawLogin,
    checkClawLogin,
    unbindClaw,
    handleClawApi
};

const ILINK_DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
/** 官方客户端上报的通道版本 */
const ILINK_CHANNEL_VERSION = '2.4.8';
/** 0x00020408，官方客户端 2.4.8 对应的十进制字符串 */
const ILINK_CLIENT_VERSION = '132104';
const ILINK_BOT_AGENT = 'Chillin/0.1';
/** 微信单聊消息的实践长度上限，留足余量 */
const MAX_CLAW_REPLY_BYTES = 4000;
/** 单次 cron 最多轮询几个账号 */
const MAX_ACCOUNTS_PER_RUN = 2;
/**
 * 一次 scheduled 调用里用于收信的时间预算：cron 周期 60s，留 5s 让渡给下一次触发。
 * getupdates 没有新消息时服务端约 18s 才返回，所以「一次调用只拉一轮」会让每分钟出现
 * 约 42s 死区、用户最坏等将近一分钟；改成在预算内持续循环拉取后，延迟只剩「在途请求
 * 返回 + 回复往返」。
 */
const POLL_RUN_BUDGET_MS = 55000;
/** 多账号时每个账号至少分到的时间片（即使预算为 0 也要跑完一轮收信） */
const POLL_MIN_SLICE_MS = 5000;
/** 丢弃绑定前 1 分钟内积压的旧消息，避免重放写入花园 */
const REPLAY_SLACK_MS = 60 * 1000;
/** 瞬时错误（iLink 520 之类）后的退避：不能因为一次失败丢掉整分钟的收信窗口 */
const POLL_ERROR_BACKOFF_MS = 1000;
const POLL_ERROR_BACKOFF_MAX_MS = 5000;
/** 等一会儿再拉；单测可把退避压到几毫秒 */
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// ─────────────────────────── 传输层 ───────────────────────────
/** 官方要求每个请求带一个随机 uint32 的 base64（防重放） */
export function ilinkUin() {
    return btoa(String(Math.floor(Math.random() * 4294967295)));
}

export function ilinkHeaders(token) {
    const headers = {
        'Content-Type': 'application/json',
        'AuthorizationType': 'ilink_bot_token',
        'X-WECHAT-UIN': ilinkUin(),
        'iLink-App-Id': 'bot',
        'iLink-App-ClientVersion': ILINK_CLIENT_VERSION
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    return headers;
}

/** 只接受 https 主机名；非法值一律退回官方域名（防止被篡改的库记录把请求带去别处） */
export function ilinkBase(baseurl) {
    const raw = String(baseurl || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/[a-z0-9.-]+(?::[0-9]+)?$/i.test(raw)) return ILINK_DEFAULT_BASE;
    return raw;
}

/** redirect_host 只允许微信 HTTPS 域名：扫码响应不该把 Worker 变成任意主机的代理 */
export function ilinkRedirectBase(host) {
    const raw = String(host || '').trim();
    if (!raw) return '';
    const candidate = (/^https:\/\//i.test(raw) ? raw : 'https://' + raw).replace(/\/+$/, '');
    try {
        const url = new URL(candidate);
        const hostname = url.hostname.toLowerCase();
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
        if (url.pathname !== '/' && url.pathname !== '') return '';
        if (hostname !== 'weixin.qq.com' && !hostname.endsWith('.weixin.qq.com')) return '';
        return candidate;
    } catch {
        return '';
    }
}

export async function requestClawQrcode(fetchImpl = fetch) {
    const res = await fetchImpl(ILINK_DEFAULT_BASE + '/ilink/bot/get_bot_qrcode?bot_type=3', {
        method: 'POST',
        headers: ilinkHeaders(''),
        body: JSON.stringify({ local_token_list: [] })
    });
    if (!res.ok) throw new Error('get_bot_qrcode http ' + res.status);
    const data = await res.json();
    const qrcode = String((data && data.qrcode) || '');
    if (!qrcode) throw new Error('get_bot_qrcode 响应缺少 qrcode');
    return { qrcode, url: String((data && data.qrcode_img_content) || '') };
}

export async function queryClawQrcode(qrcode, fetchImpl = fetch, baseurl = '') {
    const res = await fetchImpl(ilinkBase(baseurl) + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), {
        method: 'GET',
        headers: ilinkHeaders('')
    });
    if (!res.ok) throw new Error('get_qrcode_status http ' + res.status);
    const data = await res.json();
    return {
        status: String((data && data.status) || 'wait'),
        botToken: String((data && data.bot_token) || ''),
        baseurl: String((data && data.baseurl) || ''),
        ilinkBotId: String((data && data.ilink_bot_id) || ''),
        ilinkUserId: String((data && data.ilink_user_id) || ''),
        redirectHost: String((data && data.redirect_host) || '')
    };
}

export async function fetchClawUpdates(options) {
    const opts = options || {};
    const fetchImpl = opts.fetchImpl || fetch;
    const res = await fetchImpl(ilinkBase(opts.baseurl) + '/ilink/bot/getupdates', {
        method: 'POST',
        headers: ilinkHeaders(opts.token),
        body: JSON.stringify({
            get_updates_buf: String(opts.cursor || ''),
            base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT }
        })
    });
    if (!res.ok) throw new Error('getupdates http ' + res.status);
    const data = await res.json();
    return {
        msgs: Array.isArray(data && data.msgs) ? data.msgs : [],
        cursor: String((data && data.get_updates_buf) || ''),
        ret: data && data.ret,
        errcode: data && data.errcode
    };
}
export async function sendClawText(options) {
    const opts = options || {};
    const fetchImpl = opts.fetchImpl || fetch;
    const text = toClawText(opts.text);
    const body = {
        msg: {
            from_user_id: String(opts.botId || ''),
            to_user_id: String(opts.toUserId || ''),
            client_id: 'chillin-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
            message_type: 2,
            message_state: 2,
            context_token: String(opts.contextToken || ''),
            item_list: [{ type: 1, text_item: { text: truncateUtf8(text, MAX_CLAW_REPLY_BYTES) } }]
        },
        base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT }
    };
    const res = await fetchImpl(ilinkBase(opts.baseurl) + '/ilink/bot/sendmessage', {
        method: 'POST',
        headers: ilinkHeaders(opts.token),
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('sendmessage http ' + res.status);
    const data = await res.json().catch(() => null);
    if (data && data.ret != null && Number(data.ret) !== 0) throw new Error('sendmessage ret=' + data.ret + (data.errmsg ? ' ' + data.errmsg : ''));
    return true;
}
// ─────────────────────────── 报文解析 ───────────────────────────
/** 取纯文本：item_list 里 type=1 的 text_item（多条拼接） */
export function extractClawText(msg) {
    if (!msg || !Array.isArray(msg.item_list)) return '';
    return msg.item_list
        .filter(item => item && Number(item.type) === 1 && item.text_item && typeof item.text_item.text === 'string')
        .map(item => item.text_item.text)
        .join('\n')
        .trim();
}


/**
 * 排重键。message_id 是 uint64，JSON.parse 会丢精度，所以再叠上 item_list[0].msg_id
 * 与 client_id；三者任一不同都视为不同消息。
 */
export function clawDedupKey(msg) {
    if (!msg) return '';
    const items = Array.isArray(msg.item_list) ? msg.item_list : [];
    const itemId = items.length && items[0] && items[0].msg_id ? String(items[0].msg_id) : '';
    return String(msg.message_id || '') + '|' + itemId + '|' + String(msg.client_id || '');
}

// ─────────────────────────── 扫码登录与 API ───────────────────────────
// 扫码登录状态机与应用内配置 API 已下沉至 ./bot-claw-auth.js，此处统一重导出以保持契约兼容。

// ─────────────── 每分钟长轮询收信（一次调用内持续拉取） ───────────────

/**
 * 在 accountDeadline 之前反复拉取：没有新消息时每轮约 18s 返回，有新消息时服务端立刻
 * 返回并推送。只要调用期间一直有在途长轮询，用户感知延迟就只剩「在途请求返回 + 回复
 * 往返」，而不是「等下一次 cron」。至少执行一轮，保证预算为 0 时也收一次信。
 */
async function pollAccountUntilDeadline(env, db, account, fetchImpl, accountDeadline, errorBackoffMs, defer) {
    const token = String(account.bot_token || '');
    if (!token) return;
    const userId = Number(account.user_id);
    const boundAt = Number(account.bound_at_ms) || 0;
    let cursor = String(account.cursor || '');
    let polls = 0;
    let consecutiveErrors = 0;
    let successMarked = false;
    let background = Promise.resolve();
    do {
        polls++;
        let updates;
        try {
            updates = await fetchClawUpdates({
                token,
                baseurl: account.baseurl,
                cursor,
                fetchImpl
            });
            consecutiveErrors = 0;
        } catch (err) {
            // 瞬时错误（iLink 520 之类）绝不能丢掉整分钟的收信窗口：记一笔、退避一下，就在本次
            // deadline 内接着拉——否则用户那条消息要干等到下一个整分的 cron 才有人来取。
            consecutiveErrors++;
            console.error('[bot-claw] 拉取失败第 ' + consecutiveErrors + ' 次 id=' + account.id + ': ' + (err && err.message));
            await markAccountError(db, account.id, err && err.message);
            const remaining = accountDeadline - Date.now();
            if (remaining <= 0) break;
            await sleep(Math.min(
                Number.isFinite(errorBackoffMs) ? errorBackoffMs : POLL_ERROR_BACKOFF_MS,
                POLL_ERROR_BACKOFF_MAX_MS,
                remaining
            ));
            continue;
        }
        if (updates.ret !== undefined && updates.ret !== null && Number(updates.ret) !== 0) {
            await markAccountError(db, account.id, 'ret=' + updates.ret + ' errcode=' + updates.errcode);
            return;
        }
        // 本轮第一次成功就擦掉旧错误、刷新 last_poll_at；后续轮次不再重复写
        if (!successMarked) {
            await markAccountSuccess(db, account.id);
            successMarked = true;
        }
        const nextCursor = (updates.cursor && updates.cursor !== cursor) ? updates.cursor : null;
        let batchHadError = false;
        const batch = async () => {
            for (const msg of updates.msgs) {
                try {
                    await handleClawMessage(env, db, account, msg, userId, boundAt, fetchImpl);
                } catch (err) {
                    batchHadError = true;
                    console.error('[bot-claw] 消息处理失败 id=' + account.id + ': ' + (err && err.message));
                }
            }
            if (nextCursor && !batchHadError) {
                cursor = nextCursor;
                await saveCursor(db, account.id, cursor);
            }
        };
        if (typeof defer === 'function' && updates.msgs.length) {
            background = background.then(batch, batch);
            defer(background.catch(err => console.error('[bot-claw] 后台回复失败 id=' + account.id + ': ' + (err && err.message))));
        } else {
            if (updates.msgs.length) await batch();
            else if (nextCursor) {
                cursor = nextCursor;
                await saveCursor(db, account.id, cursor);
            }
        }
    } while (Date.now() < accountDeadline);
    console.log('[bot-claw] 轮询 ' + polls + ' 轮后让出 id=' + account.id);
}

/** 单条入站消息：绑定身份校验 → 排重 → 共享指令大脑 → 原会话回复 */
async function handleClawMessage(env, db, account, msg, userId, boundAt, fetchImpl) {
    if (!msg || Number(msg.message_type) !== 1) return;
    const from = String(msg.from_user_id || '');
    // 绑定的微信身份之外的消息一律忽略：这台机器人只为绑定它的主人服务
    if (account.ilink_user_id && from !== String(account.ilink_user_id)) {
        console.warn('[bot-claw] 非绑定用户的消息已忽略 from=' + from);
        return;
    }
    const createdMs = Number(msg.create_time_ms) || 0;
    if (boundAt && createdMs && createdMs < boundAt - REPLAY_SLACK_MS) {
        console.log('[bot-claw] 绑定前的积压消息已丢弃 create_time_ms=' + createdMs);
        return;
    }
    const text = extractClawText(msg);
    // iLink 的图片消息外层 message_type 仍是 1，靠 item.type=2 的 image_item 识别（2026-10-20 实测）
    const hasImage = extractClawImageItems(msg).length > 0;
    // 语音等其它类型仍不支持：既不回复也不声称保存，静默丢弃
    if (!text && !hasImage) return;
    const dedupKey = 'claw:' + clawDedupKey(msg);
    if (!(await claimBotMessage(db, dedupKey))) {
        console.log('[bot-claw] 重复消息已忽略');
        return;
    }
    if (msg.context_token) await db.prepare("UPDATE bot_claw_accounts SET last_context_token = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?1").bind(account.id, String(msg.context_token).slice(0, 500)).run();
    try {
        const reply = hasImage
            ? await handleClawImageMessage(env, db, userId, msg, text, fetchImpl)
            : await buildBotReply(env, db, userId, text);
        if (!reply) return;
        await sendClawText({
            token: String(account.bot_token || ''),
            baseurl: account.baseurl,
            botId: account.ilink_bot_id,
            toUserId: from,
            contextToken: msg.context_token,
            text: reply,
            fetchImpl
        });
    } catch (err) {
        try { await db.prepare("DELETE FROM rate_limits WHERE bucket_key = ?1").bind('bot-msg:' + dedupKey).run(); } catch (_) {}
        throw err;
    }
}

/**
 * 每分钟 cron 入口：在一次调用内尽量持续地长轮询收信。
 * options.budgetMs 只给单测收紧预算用（0 = 只拉一轮，不空转）；
 * options.errorBackoffMs 同样只给单测用（把瞬时错误的重试退避压到几毫秒）。
 */
export async function pollClawAccounts(env, db, fetchImpl = fetch, options = {}) {
    if (!db) return;
    const opts = options || {};
    const budget = Number.isFinite(opts.budgetMs) ? Number(opts.budgetMs) : POLL_RUN_BUDGET_MS;
    // budget 为 0 表示只拉一轮（单测收紧预算用），不能落进同一毫秒里空转
    const runDeadline = budget > 0 ? Date.now() + budget : 0;
    const rows = await db.prepare(
        "SELECT * FROM bot_claw_accounts WHERE is_deleted = 0 AND status = 'bound' ORDER BY id LIMIT ?1"
    ).bind(MAX_ACCOUNTS_PER_RUN).all();
    const accounts = (rows && rows.results) || [];
    const slice = accounts.length ? Math.max(POLL_MIN_SLICE_MS, Math.floor(budget / accounts.length)) : budget;
    for (const account of accounts) {
        const accountDeadline = Math.min(runDeadline, Date.now() + slice);
        try {
            await pollAccountUntilDeadline(env, db, account, fetchImpl, accountDeadline, opts.errorBackoffMs, opts.defer);
        } catch (err) {
            console.error('[bot-claw] 轮询失败 id=' + account.id + ': ' + (err && err.message));
            await markAccountError(db, account.id, err && err.message);
        }
    }
}