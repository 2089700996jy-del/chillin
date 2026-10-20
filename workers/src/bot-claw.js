/**
 * 微信 ClawBot 接入层（官方 iLink 协议）——让 Chillin Worker 直接当 ClawBot 后端，
 * 不再需要 OpenClaw、也不需要任何常驻机器。
 *
 * 协议依据：官方仓库 Tencent/openclaw-weixin 的 docs/protocol.md 与原客户端 src 实现，
 * 原文明确该协议「供实现兼容后端的开发者使用」，不是逆向。
 *   传输：https://ilinkai.weixin.qq.com，POST + JSON，Authorization: Bearer <bot_token>
 *   登录：POST /ilink/bot/get_bot_qrcode?bot_type=3 -> 二维码；
 *         GET  /ilink/bot/get_qrcode_status?qrcode=… -> wait|scaned|confirmed|expired…
 *   收信：POST /ilink/bot/getupdates（长轮询，实测无消息时服务端约 18s 返回），
 *         响应里的 get_updates_buf 是必须持久化的游标。
 *   回信：POST /ilink/bot/sendmessage。带上来信消息的 context_token 表示「接着这句话回」；
 *         置空同样能送达（v2.5.110 实测：无人说话时用空 context_token 主动开口，HTTP 200 且用户收到），
 *         这是 bot-outreach 主动关怀的传输基础。
 *
 * 分层：
 * - 传输层：上面几个纯函数，全部可注入 fetchImpl，便于离线单测。
 * - 接入层：/api/bot/claw/* 挂在登录态鉴权之后（绑机器人和绑账号一样属于私人操作）；
 *   每分钟 cron 走 pollClawAccounts 长轮询收信，业务指令复用 bot-commands 共享大脑。
 * - 凭证：bot_token 只存 D1、只在服务端使用，任何 API 响应都不返回。
 *
 * 已知未覆盖：扫码后可能返回 scaned_but_redirect（需换轮询主机）与 binded_redirect，
 * v1 先按「同一微信身份只绑一次」的常规路径处理，遇到时记 last_error 便于排查。
 */
import { jsonResponse } from './security.js';
import { truncateUtf8, buildBotReply, claimBotMessage } from './bot-commands.js';
import { extractClawImageItems, handleClawImageMessage } from './bot-media.js';

const ILINK_DEFAULT_BASE = 'https://ilinkai.weixin.qq.com';
/** 官方客户端上报的通道版本 */
const ILINK_CHANNEL_VERSION = '2.4.8';
/** 0x00020408，官方客户端 2.4.8 对应的十进制字符串 */
const ILINK_CLIENT_VERSION = '132104';
const ILINK_BOT_AGENT = 'Chillin/0.1';
/** 二维码实测 40–60 秒就 expired，前端据此自动换新 */
const QR_TTL_SECONDS = 90;
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

export async function queryClawQrcode(qrcode, fetchImpl = fetch) {
    const res = await fetchImpl(ILINK_DEFAULT_BASE + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrcode), {
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
        ilinkUserId: String((data && data.ilink_user_id) || '')
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
    const body = {
        msg: {
            from_user_id: String(opts.botId || ''),
            to_user_id: String(opts.toUserId || ''),
            client_id: 'chillin-' + Date.now() + '-' + Math.floor(Math.random() * 1000000),
            message_type: 2,
            message_state: 2,
            context_token: String(opts.contextToken || ''),
            item_list: [{ type: 1, text_item: { text: truncateUtf8(opts.text, MAX_CLAW_REPLY_BYTES) } }]
        },
        base_info: { channel_version: ILINK_CHANNEL_VERSION, bot_agent: ILINK_BOT_AGENT }
    };
    const res = await fetchImpl(ilinkBase(opts.baseurl) + '/ilink/bot/sendmessage', {
        method: 'POST',
        headers: ilinkHeaders(opts.token),
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('sendmessage http ' + res.status);
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

// ─────────────────────────── D1 读写 ───────────────────────────

async function readAccount(db, userId) {
    return await db.prepare('SELECT * FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0')
        .bind(userId).first();
}

async function upsertQrcode(db, userId, qrcode) {
    await db.prepare(
        'INSERT INTO bot_claw_accounts (user_id, status, qrcode, qr_expires_at, created_at, updated_at) '
        + "VALUES (?1, 'pending', ?2, datetime('now', '+8 hours', '+" + QR_TTL_SECONDS + " seconds'), "
        + "datetime('now', '+8 hours'), datetime('now', '+8 hours')) "
        + "ON CONFLICT(user_id) DO UPDATE SET status = 'pending', qrcode = ?2, "
        + "qr_expires_at = datetime('now', '+8 hours', '+" + QR_TTL_SECONDS + " seconds'), "
        + "last_error = '', updated_at = datetime('now', '+8 hours')"
    ).bind(userId, qrcode).run();
}

async function markBound(db, userId, info) {
    await db.prepare(
        "UPDATE bot_claw_accounts SET status = 'bound', bot_token = ?2, baseurl = ?3, ilink_bot_id = ?4, "
        + "ilink_user_id = ?5, qrcode = '', qr_expires_at = NULL, cursor = '', bound_at_ms = ?6, "
        + "last_error = '', updated_at = datetime('now', '+8 hours') "
        + 'WHERE user_id = ?1 AND is_deleted = 0'
    ).bind(userId, info.botToken, ilinkBase(info.baseurl), info.ilinkBotId, info.ilinkUserId, Date.now()).run();
}

async function markUnBound(db, userId) {
    await db.prepare(
        "UPDATE bot_claw_accounts SET status = 'unbound', bot_token = '', cursor = '', qrcode = '', "
        + "is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND is_deleted = 0"
    ).bind(userId).run();
}

async function saveCursor(db, id, cursor) {
    await db.prepare("UPDATE bot_claw_accounts SET cursor = ?2, last_poll_at = datetime('now', '+8 hours') WHERE id = ?1")
        .bind(id, cursor).run();
}

async function markAccountError(db, id, message) {
    await db.prepare("UPDATE bot_claw_accounts SET last_error = ?2, last_poll_at = datetime('now', '+8 hours') WHERE id = ?1")
        .bind(id, String(message || '').slice(0, 200)).run();
}

// ─────────────────────────── 接入层 API（登录态之后） ───────────────────────────

function publicStatus(row) {
    if (!row) return { bound: false, status: 'none' };
    return {
        bound: String(row.status) === 'bound' && !!row.bot_token,
        status: String(row.status || 'none'),
        qrcode: String(row.qrcode || ''),
        expiresAt: row.qr_expires_at || '',
        ilinkBotId: String(row.ilink_bot_id || ''),
        ilinkUserId: String(row.ilink_user_id || ''),
        lastPollAt: row.last_poll_at || '',
        lastError: String(row.last_error || '')
    };
}

/** 取一张新二维码并落库（旧二维码立即作废：企微/微信侧只认最新一次） */
export async function startClawLogin(env, db, userId, fetchImpl = fetch) {
    const qr = await requestClawQrcode(fetchImpl);
    await upsertQrcode(db, userId, qr.qrcode);
    return { qrcode: qr.qrcode, url: qr.url, ttlSeconds: QR_TTL_SECONDS, status: 'pending' };
}

/** 查询一次扫码状态；confirmed 时把凭证写入库 */
export async function checkClawLogin(env, db, userId, fetchImpl = fetch) {
    const row = await readAccount(db, userId);
    if (!row || !row.qrcode) return publicStatus(row);
    const state = await queryClawQrcode(String(row.qrcode), fetchImpl);
    if (state.status === 'confirmed') {
        if (!state.botToken || !state.ilinkBotId) {
            await markAccountError(db, row.id, 'confirmed 响应缺少 bot_token/ilink_bot_id');
            return publicStatus(await readAccount(db, userId));
        }
        await markBound(db, userId, state);
        console.log('[bot-claw] 绑定成功 ilink_bot_id=' + state.ilinkBotId);
        return publicStatus(await readAccount(db, userId));
    }
    if (state.status === 'expired') {
        await db.prepare("UPDATE bot_claw_accounts SET qrcode = '', updated_at = datetime('now', '+8 hours') WHERE id = ?1")
            .bind(row.id).run();
    }
    return Object.assign(publicStatus(row), { status: state.status });
}

export async function unbindClaw(db, userId) {
    await markUnBound(db, userId);
    return { bound: false, status: 'unbound' };
}

export async function handleClawApi(request, env, url, db, userId) {
    const path = url.pathname;
    try {
        if (path === '/api/bot/claw/status' && request.method === 'GET') {
            return jsonResponse(publicStatus(await readAccount(db, userId)), 200);
        }
        if (path === '/api/bot/claw/qrcode' && request.method === 'POST') {
            return jsonResponse(await startClawLogin(env, db, userId), 200);
        }
        if (path === '/api/bot/claw/check' && request.method === 'POST') {
            return jsonResponse(await checkClawLogin(env, db, userId), 200);
        }
        if (path === '/api/bot/claw' && request.method === 'DELETE') {
            return jsonResponse(await unbindClaw(db, userId), 200);
        }
    } catch (err) {
        console.error('[bot-claw] api error: ' + (err && err.message));
        return jsonResponse({ error: '微信机器人服务暂时不可用，请稍后重试' }, 502);
    }
    return jsonResponse({ error: '接口不存在' }, 404);
}

// ─────────────── 每分钟长轮询收信（一次调用内持续拉取） ───────────────

/**
 * 在 accountDeadline 之前反复拉取：没有新消息时每轮约 18s 返回，有新消息时服务端立刻
 * 返回并推送。只要调用期间一直有在途长轮询，用户感知延迟就只剩「在途请求返回 + 回复
 * 往返」，而不是「等下一次 cron」。至少执行一轮，保证预算为 0 时也收一次信。
 */
async function pollAccountUntilDeadline(env, db, account, fetchImpl, accountDeadline) {
    const token = String(account.bot_token || '');
    if (!token) return;
    const userId = Number(account.user_id);
    const boundAt = Number(account.bound_at_ms) || 0;
    let cursor = String(account.cursor || '');
    let polls = 0;
    do {
        polls++;
        const updates = await fetchClawUpdates({
            token,
            baseurl: account.baseurl,
            cursor,
            fetchImpl
        });
        if (updates.ret !== undefined && updates.ret !== null && Number(updates.ret) !== 0) {
            await markAccountError(db, account.id, 'ret=' + updates.ret + ' errcode=' + updates.errcode);
            return;
        }
        if (updates.cursor && updates.cursor !== cursor) {
            cursor = updates.cursor;
            await saveCursor(db, account.id, cursor);
        }
        for (const msg of updates.msgs) {
            try {
                await handleClawMessage(env, db, account, msg, userId, boundAt, fetchImpl);
            } catch (err) {
                // 单条消息失败不能连坐整分钟的收信
                console.error('[bot-claw] 消息处理失败 id=' + account.id + ': ' + (err && err.message));
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
    if (!(await claimBotMessage(db, 'claw:' + clawDedupKey(msg)))) {
        console.log('[bot-claw] 重复消息已忽略');
        return;
    }
    // 有图就走存图通道（秒回、不经模型也不占对话限流桶）；图 + 文字时文字自动变成配文
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
}

/**
 * 每分钟 cron 入口：在一次调用内尽量持续地长轮询收信。
 * options.budgetMs 只给单测收紧预算用（0 = 只拉一轮，不空转）。
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
            await pollAccountUntilDeadline(env, db, account, fetchImpl, accountDeadline);
        } catch (err) {
            console.error('[bot-claw] 轮询失败 id=' + account.id + ': ' + (err && err.message));
            await markAccountError(db, account.id, err && err.message);
        }
    }
}