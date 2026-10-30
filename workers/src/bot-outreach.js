/**
 * Bot 主动关怀（bot-outreach.js）
 *
 * 分工：bot-commands.js 回答「你说话时我该怎么回」；这一层回答一个更难的问题——
 * 没人说话的时候，它到底有没有资格先开口。
 *
 * 克制是设计的一部分，不是可调参数：
 *   1. 时机随机但每天至多一次：东八区 10:00–22:30 之间，用 (user_id, 日期) 哈希出
 *      当天唯一的时刻；只有到点之后的第一次 cron 才可能行动。
 *   2. 刚说完话不插嘴，聊完也算数：距用户上次说话至少 30 分钟；如果 6 小时内聊过，
 *      就不再等当天那个固定时刻，而是在聊完 30–120 分钟之间（由这轮对话哈希出的
 *      时刻）开口，并把刚才那几轮对话当背景喂给模型，允许它顺着话题补一句。
 *   3. 素材必须有出处：只从 3 天前到 180 天前的旧记录里挑；一条都挑不出来就不发。
 *   4. 模型有否决权：它觉得不值得提就回 SKIP，我们记一条 skipped 收工；每天只尝试
 *      一次，跳过了今天就不再补发（宁可不说，不可硬说）。
 *   5. 概率闸门：即使到点、有素材，也只有 OUTREACH_SEND_PROBABILITY 的概率真的发；
 *      连续 4 天没发过则免除这道闸，避免长期沉默。
 *   6. 一切可关：账号级 outreach_enabled + 审计表记录每条主动消息的出处与结果。
 *   7. 主动消息也进对话记忆：说出来之后马上写一条 assistant 轮次（带出处），否则用户回
 *      一句「什么时候啊」，下一轮完全不知道自己在说什么；写失败只记错误，不影响已发出的消息。
 *
 * 与 bot-claw.js 的边界：这里只调用它的 sendClawText，协议细节不在这里。
 * 主动消息的正文会落审计表（用户自己的库，用于回答「你凭什么想起这件事」），
 * 但永不进日志——日志只记 user_id、ref 与错误信息。
 */

import { sendClawText } from './bot-claw.js';
import { buildThreadCandidates } from './insights.js';
import { callCustomLlmWithMessages, moderateText } from './llm.js';
import { jsonResponse, readJsonCapped } from './security.js';

/** 允许开口的时窗（东八区，左闭右开，以当天分钟数表示） */
export const OUTREACH_WINDOW_START_MINUTE = 10 * 60;
/** 时窗结束（22:30 之后闭嘴，夜里不再打扰） */
export const OUTREACH_WINDOW_END_MINUTE = 22 * 60 + 30;
/** 每天最多一次真实尝试（发出去或被跳过都算用掉） */
export const OUTREACH_DAILY_CAP = 1;
/** 刚说完话后的最小间隔：这段时间内绝不插嘴 */
export const OUTREACH_MIN_GAP_MS = 30 * 60 * 1000;
/** 聊完之后最早开口（与最小间隔同值，单独命名便于阅读） */
export const OUTREACH_FOLLOWUP_MIN_MS = OUTREACH_MIN_GAP_MS;
/** 聊完之后最晚开口：超过这个时间就不再算「顺着刚才的话题」 */
export const OUTREACH_FOLLOWUP_MAX_MS = 120 * 60 * 1000;
/** 多久之内聊过算「刚聊过」：可以把刚才的对话当背景，顺着话题补一句 */
export const OUTREACH_FOLLOWUP_WINDOW_MS = 6 * 60 * 60 * 1000;
/** 新记录不碰：只回忆 3 天前的东西 */
export const OUTREACH_MIN_AGE_MS = 3 * 24 * 60 * 60 * 1000;
/** 太老的东西也不翻（180 天前） */
export const OUTREACH_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** 到点之后仍以这个概率决定真的发，其余记 skipped */
export const OUTREACH_SEND_PROBABILITY = 0.65;
/** 连续这么久没发过就免除概率闸门，避免长期沉默 */
export const OUTREACH_MAX_GAP_MS = 4 * 24 * 60 * 60 * 1000;
/** 主动消息正文上限（UTF-8 字节） */
export const OUTREACH_TEXT_MAX_BYTES = 480;
/** 每张表抓多少个候选旧记录（再在内存里按年龄过滤） */
export const OUTREACH_CANDIDATE_FETCH = 40;
/** 一次 cron 最多处理几个账号 */
export const OUTREACH_MAX_ACCOUNTS = 2;
/** 应用内开关请求体上限 */
const MAX_OUTREACH_BODY_BYTES = 1024;

/** 主动关怀的人格与红线：像朋友一样想起，而不是像系统一样推送 */
const OUTREACH_SYSTEM_PROMPT = [
    '你是 Chillin，是用户熟悉的朋友。此刻没人跟你说话——你翻他/她的花园记录时想起了某一条，像朋友突然想起一件小事，考虑要不要开口，而不是系统推送。',
    '只有当你确实能说出一句「具体、自然、属于这条记录本身」的话时才开口；否则只回复四个字母：SKIP。',
    '',
    '【红线】',
    '1. 一句话，不超过 60 个汉字，口语，不要 markdown。',
    '2. 不要问候、不要问「在吗」、不要说教、不要提建议、不要评价对方，也不要用「宝贝 / 亲爱的 / 想你」这类亲密称呼或刻意煽情。',
    '3. 不要复述原文，不要提「记录」「数据库」「花园」「检索」这类系统词。',
    '4. 只说这条记录让你想到的东西；不确定就当没想起，回 SKIP。若素材是多条跨时间的同一条线索，可以点出这个念头反复出现，并轻轻问一句要不要继续。',
    '5. 若给了「你们刚聊过」，那是背景不是台词：不要复述，也不要接着追问。'
].join('\n');

const encoder = new TextEncoder();

/** 按字节裁剪（中文安全），超长补省略号 */
function cutUtf8(text, maxBytes) {
    const s = String(text == null ? '' : text);
    const bytes = encoder.encode(s);
    if (bytes.length <= maxBytes) return s;
    const head = new TextDecoder().decode(bytes.slice(0, Math.max(0, maxBytes - 3)), { stream: true });
    return head + '…';
}

/** 东八区视角的日期 / 小时 / 当天零点（毫秒仍是真实 epoch，便于直接比较） */
export function east8Parts(nowMs) {
    const shifted = Number(nowMs) + 8 * 3600 * 1000;
    const dayStartShifted = Math.floor(shifted / 86400000) * 86400000;
    const at = new Date(shifted);
    return {
        ymd: at.toISOString().slice(0, 10),
        hour: at.getUTCHours(),
        minuteOfDay: at.getUTCHours() * 60 + at.getUTCMinutes(),
        dayStartMs: dayStartShifted - 8 * 3600 * 1000
    };
}

/** 现在是否在允许开口的时窗内 */
export function isOutreachWindow(nowMs) {
    const minute = east8Parts(nowMs).minuteOfDay;
    return minute >= OUTREACH_WINDOW_START_MINUTE && minute < OUTREACH_WINDOW_END_MINUTE;
}

function hash32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
}

/**
 * 当天的随机开口时刻：只由 (user_id, 东八区日期) 决定，所以同一天稳定、
 * 不同天不同；落在 [10:00, 22:30) 内。cron 每分钟跑，到点后的第一次就触发。
 */
export function pickOutreachInstantMs(userId, nowMs) {
    const parts = east8Parts(nowMs);
    const spanMs = (OUTREACH_WINDOW_END_MINUTE - OUTREACH_WINDOW_START_MINUTE) * 60 * 1000;
    const offset = hash32(String(userId) + ':' + parts.ymd) % spanMs;
    return parts.dayStartMs + OUTREACH_WINDOW_START_MINUTE * 60 * 1000 + offset;
}

/**
 * 聊完之后多久才允许顺着话题开口：由 (user_id, 这轮对话的 id) 哈希决定，落在
 * [30 分钟, 120 分钟)；同一轮对话只对应一个时刻，cron 每分钟跑也不会重掷。
 */
export function pickFollowUpDelayMs(userId, turnId) {
    const span = OUTREACH_FOLLOWUP_MAX_MS - OUTREACH_FOLLOWUP_MIN_MS;
    return OUTREACH_FOLLOWUP_MIN_MS + (hash32(String(userId) + ':' + String(turnId)) % span);
}

/**
 * 主动消息写进对话记忆时的正文：原话 + 一行出处备注。
 * 出处是为了让它答得出「那是多久以前的事」——用户实测问过「什么时候啊」。
 */
export function outreachTurnContent(text, candidate) {
    const ref = candidate ? (candidate.ageDays + ' 天前的' + candidate.kind) : '一条旧记录';
    return String(text || '') + '\n（这条是我自己先开口提的，出处：' + ref + '）';
}

/** 容忍两种历史写法：东八区文本（YYYY-MM-DD HH:MM:SS）与 epoch 毫秒 */
export function parseRecordTimeMs(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'number') return value;
    const s = String(value).trim();
    if (/^\d{10,}$/.test(s)) return Number(s);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - 8 * 3600 * 1000;
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : 0;
}

/** 候选素材的来源表：全部参数化绑定，绝不拼接 SQL */
const CANDIDATE_SOURCES = [
    {
        table: 'quick_feeds',
        kind: '随手记',
        sql: 'SELECT id, content AS body, created_at, updated_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'notes',
        kind: '笔记',
        sql: 'SELECT id, title, content, created_at, updated_at FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'weeklies',
        kind: '周记',
        sql: 'SELECT id, title, summary, content, created_at, updated_at FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    },
    {
        table: 'bookmarks',
        kind: '收藏',
        sql: 'SELECT id, title, description, url, created_at, updated_at FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC, id DESC LIMIT ?2'
    }
];

function candidateBody(source, row) {
    if (source.table === 'quick_feeds') return String(row.body || '').trim();
    if (source.table === 'bookmarks') return [row.title, row.description, row.url].filter(Boolean).join(' ').trim();
    if (source.table === 'notes') return [row.title, row.content].filter(Boolean).join(' ').trim();
    return [row.title, row.summary || row.content].filter(Boolean).join(' ').trim();
}

/** 收集年龄合适的候选（导出便于单测直接喂数据） */
export async function collectCandidates(db, userId, nowMs) {
    const out = [];
    for (const source of CANDIDATE_SOURCES) {
        const res = await db.prepare(source.sql).bind(userId, OUTREACH_CANDIDATE_FETCH).all();
        for (const row of (res && res.results) || []) {
            const body = candidateBody(source, row);
            if (body.length < 8) continue;
            const at = parseRecordTimeMs(row.created_at) || parseRecordTimeMs(row.updated_at);
            if (!at) continue;
            const age = nowMs - at;
            if (age < OUTREACH_MIN_AGE_MS || age > OUTREACH_MAX_AGE_MS) continue;
            out.push({
                type: source.table,
                kind: source.kind,
                id: String(row.id),
                body: body.slice(0, 400),
                atMs: at,
                ageDays: Math.floor(age / 86400000)
            });
        }
    }
    // 跨月份反复出现的旧记录合成线索候选；Bot 因此能说「你之前也想过这个」。
    out.push(...buildThreadCandidates(out, nowMs));
    return out;
}

/** 随机挑一条没被引用过的候选；没有就返回 null（返回 null 是合法的「今天不说」） */
export function pickCandidate(candidates, usedRefs, random = Math.random) {
    const fresh = (candidates || []).filter(c => !usedRefs.has(c.type + ':' + c.id));
    if (!fresh.length) return null;
    const idx = Math.floor(random() * fresh.length) % fresh.length;
    return fresh[idx];
}

// ─────────────── 状态读写（账号级开关 + 审计） ───────────────

/** 应用内 / 微信侧共用的开关与统计状态 */
export async function loadOutreachState(db, userId) {
    const acct = await db.prepare(
        "SELECT COUNT(*) AS n, SUM(CASE WHEN outreach_enabled = 1 THEN 1 ELSE 0 END) AS on_count FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0"
    ).bind(userId).first();
    const bound = Number((acct && acct.n) || 0) > 0;
    const enabled = Number((acct && acct.on_count) || 0) > 0;
    const last = await db.prepare(
        "SELECT created_at FROM bot_outreach WHERE user_id = ?1 AND is_deleted = 0 AND status = 'sent' ORDER BY id DESC LIMIT 1"
    ).bind(userId).first();
    const cnt = await db.prepare(
        "SELECT COUNT(*) AS n FROM bot_outreach WHERE user_id = ?1 AND is_deleted = 0 AND status = 'sent'"
    ).bind(userId).first();
    return {
        bound,
        enabled,
        sent: Number((cnt && cnt.n) || 0),
        lastSentAt: (last && last.created_at) || ''
    };
}

/** 开关主动关怀（作用于该用户的全部账号）；返回最新状态 */
export async function setOutreachEnabled(db, userId, enabled) {
    await db.prepare(
        "UPDATE bot_claw_accounts SET outreach_enabled = ?1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?2 AND is_deleted = 0"
    ).bind(enabled ? 1 : 0, userId).run();
    return loadOutreachState(db, userId);
}

async function attemptedToday(db, userId, nowMs) {
    const parts = east8Parts(nowMs);
    const row = await db.prepare(
        'SELECT COUNT(*) AS n FROM bot_outreach WHERE user_id = ?1 AND is_deleted = 0 AND created_at >= ?2'
    ).bind(userId, parts.ymd + ' 00:00:00').first();
    return Number((row && row.n) || 0) > 0;
}

async function loadUsedRefs(db, userId) {
    const res = await db.prepare('SELECT ref_type, ref_id FROM bot_outreach WHERE user_id = ?1').bind(userId).all();
    const used = new Set();
    for (const row of (res && res.results) || []) {
        if (row.ref_type && row.ref_id) used.add(row.ref_type + ':' + row.ref_id);
    }
    return used;
}

async function recordAttempt(db, account, status, candidate, text, reason) {
    await db.prepare(
        'INSERT INTO bot_outreach (user_id, account_id, status, ref_type, ref_id, text, reason, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0)'
    ).bind(
        account.user_id,
        account.id,
        status,
        candidate ? candidate.type : '',
        candidate ? candidate.id : '',
        text || '',
        reason || ''
    ).run();
}

/** 用户最近一次说话的时间（东八区文本或 epoch 毫秒）与那一轮的 id；从未说过返回 0 */
async function lastUserTurnInfo(db, userId) {
    const row = await db.prepare(
        "SELECT id, created_at FROM bot_chat_turns WHERE user_id = ?1 AND role = 'user' AND is_deleted = 0 ORDER BY id DESC LIMIT 1"
    ).bind(userId).first();
    if (!row || !row.created_at) return { atMs: 0, id: 0 };
    return { atMs: parseRecordTimeMs(row.created_at), id: Number(row.id) || 0 };
}

/**
 * 开口的时间资格：距上次说话至少 OUTREACH_MIN_GAP_MS（刚说完就不插嘴）；
 * 从未说过话时退回「距绑定至少 1 小时」。返回 lastUserMs 供 follow-up 判断。
 */
async function outreachTiming(db, account, nowMs) {
    const last = await lastUserTurnInfo(db, account.user_id);
    if (last.atMs) {
        if (nowMs - last.atMs < OUTREACH_MIN_GAP_MS) return { ok: false, lastUserMs: last.atMs, lastUserTurnId: last.id };
        return { ok: true, lastUserMs: last.atMs, lastUserTurnId: last.id };
    }
    const boundAt = Number(account.bound_at_ms || 0);
    if (boundAt && nowMs - boundAt < 60 * 60 * 1000) return { ok: false, lastUserMs: 0, lastUserTurnId: 0 };
    return { ok: true, lastUserMs: 0, lastUserTurnId: 0 };
}

/** 一句话起草：模型说不出来就返回空串（等于放弃今天） */
async function draftOutreach(env, db, userId, candidate, followUp) {
    let profile = '';
    try { profile = await loadProfilePromptSafe(db, userId); } catch (_) { profile = ''; }
    let preferences = '';
    try { preferences = await loadPreferencePromptSafe(db, userId); } catch (_) { preferences = ''; }
    const parts = [];
    if (profile) parts.push('【关于她/他】\n' + profile);
    if (preferences) parts.push('【交流偏好（只调整说法，不改变主动开口的边界）】\n' + preferences);
    if (followUp) {
        const talk = await loadRecentTalkSafe(db, userId);
        if (talk) parts.push('【你们刚聊过】（这是背景，不是叫你现在接话）\n' + talk);
    }
    if (Array.isArray(candidate.evidence) && candidate.evidence.length >= 2) {
        parts.push('她/他不同时间写过同一件事（' + candidate.kind + '：' + candidate.topic + '）：');
        for (const item of candidate.evidence.slice(0, 4)) {
            parts.push('- ' + item.date + '（' + item.label + '）：' + item.snippet);
        }
        parts.push('如果值得，就像突然想起来一样，点出这是反复出现的念头，并轻轻问一句要不要继续；'
            + '不要罗列日期，不要复述原文，不要提建议；只一句话，不值得就只回复 SKIP。');
    } else {
        parts.push('她/他 ' + candidate.ageDays + ' 天前写的一条' + candidate.kind + '：\n' + candidate.body);
        parts.push(followUp
            ? '如果值得，就说一句能落回这条旧记录、又不重复刚才对话的话；不值得就只回复 SKIP。'
            : '如果值得，就直接说出那句话；不值得就只回复 SKIP。');
    }
    let raw = '';
    try {
        raw = await callCustomLlmWithMessages(env, [
            { role: 'system', content: OUTREACH_SYSTEM_PROMPT },
            { role: 'user', content: parts.join('\n\n') }
        ]);
    } catch (err) {
        console.error('[outreach] 大模型调用失败: ' + (err && err.message));
        return '';
    }
    const text = String(raw || '').replace(/\s+/g, ' ').replace(/^["「『]+|["」』]+$/g, '').trim();
    if (!text || /^SKIP\b/i.test(text)) return '';
    const moderated = moderateText(text, env);
    if (!moderated.ok) return '';
    return cutUtf8(moderated.text, OUTREACH_TEXT_MAX_BYTES);
}

// 单独包一层：档案读取失败绝不影响「要不要开口」这个判断
async function loadProfilePromptSafe(db, userId) {
    const mod = await import('./bot-memory.js');
    return mod.loadProfilePrompt(db, userId);
}

async function loadPreferencePromptSafe(db, userId) {
    const mod = await import('./bot-preferences.js');
    return mod.loadPreferencePrompt(db, userId);
}

// 最近几轮对话（同一份上下文记忆），只在「刚聊过」时才取；失败就当没有
async function loadRecentTalkSafe(db, userId) {
    try {
        const mod = await import('./bot-memory.js');
        const turns = await mod.loadChatContext(db, userId);
        return (turns || []).slice(-6).map(t => {
            const who = t && t.role === 'user' ? '她/他说' : '你说';
            return who + '：' + String((t && t.content) || '').replace(/\s+/g, ' ').slice(0, 120);
        }).join('\n');
    } catch (_) {
        return '';
    }
}

// 主动消息落进同一份对话记忆；失败绝不影响已经发出去的那条消息
async function saveOutreachTurnSafe(db, userId, text, candidate) {
    try {
        const mod = await import('./bot-memory.js');
        await mod.saveChatTurn(db, userId, 'assistant', outreachTurnContent(text, candidate));
    } catch (err) {
        console.error('[outreach] 写入对话记忆失败 user=' + userId + ': ' + (err && err.message));
    }
}

/** 单个账号的一次尝试；返回 'sent' | 'skipped' | 'failed' | 'wait' | 'done' | 'too-soon' | 'empty' */
async function runOneAccount(env, db, account, fetchImpl, nowMs, random) {
    if (await attemptedToday(db, account.user_id, nowMs)) return 'done';
    if (OUTREACH_DAILY_CAP <= 0) return 'done';

    const timing = await outreachTiming(db, account, nowMs);
    if (!timing.ok) return 'too-soon';
    const followUp = !!timing.lastUserMs && nowMs - timing.lastUserMs < OUTREACH_FOLLOWUP_WINDOW_MS;
    // 刚聊过：不等当天那个固定时刻，改由这轮对话哈希出的 30–120 分钟后开口
    const dueMs = followUp
        ? timing.lastUserMs + pickFollowUpDelayMs(account.user_id, timing.lastUserTurnId)
        : pickOutreachInstantMs(account.user_id, nowMs);
    if (nowMs < dueMs) return 'wait';

    const candidates = await collectCandidates(db, account.user_id, nowMs);
    const candidate = pickCandidate(candidates, await loadUsedRefs(db, account.user_id), random);
    if (!candidate) return 'empty';

    const state = await loadOutreachState(db, account.user_id);
    const lastMs = parseRecordTimeMs(state.lastSentAt);
    const mustSpeak = !lastMs || nowMs - lastMs >= OUTREACH_MAX_GAP_MS;
    if (!mustSpeak && random() >= OUTREACH_SEND_PROBABILITY) {
        await recordAttempt(db, account, 'skipped', candidate, '', 'random');
        return 'skipped';
    }

    const text = await draftOutreach(env, db, account.user_id, candidate, followUp);
    if (!text) {
        await recordAttempt(db, account, 'skipped', candidate, '', 'model-skip');
        return 'skipped';
    }

    try {
        await sendClawText({
            token: account.bot_token,
            baseurl: account.baseurl,
            botId: account.ilink_bot_id,
            toUserId: account.ilink_user_id,
            contextToken: '',
            text,
            fetchImpl
        });
        await recordAttempt(db, account, 'sent', candidate, text, '');
        await saveOutreachTurnSafe(db, account.user_id, text, candidate);
        console.log('[outreach] 已主动送达 user=' + account.user_id + ' ref=' + candidate.type + ':' + candidate.id + (followUp ? ' (follow-up)' : ''));
        return 'sent';
    } catch (err) {
        await recordAttempt(db, account, 'failed', candidate, text, String((err && err.message) || '').slice(0, 120));
        console.error('[outreach] 发送失败 user=' + account.user_id + ': ' + (err && err.message));
        return 'failed';
    }
}

/**
 * 每分钟 cron 调用入口：环境没有可用模型时直接不动（宁可不说，也不要模板化寒暄）。
 */
export async function runOutreachChecks(env, db, fetchImpl = fetch, options = {}) {
    const opts = options || {};
    const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    if (!db) return { state: 'no-db' };
    if (!env || (!env.AI && !env.LLM_API_KEY)) return { state: 'no-llm' };
    if (!isOutreachWindow(nowMs)) return { state: 'closed' };

    let accounts = [];
    try {
        const res = await db.prepare(
            "SELECT * FROM bot_claw_accounts WHERE is_deleted = 0 AND status = 'bound' AND outreach_enabled = 1 ORDER BY id LIMIT ?1"
        ).bind(OUTREACH_MAX_ACCOUNTS).all();
        accounts = (res && res.results) || [];
    } catch (err) {
        console.error('[outreach] 读取账号失败: ' + (err && err.message));
        return { state: 'error' };
    }

    const summary = { state: 'idle', sent: 0, skipped: 0, failed: 0 };
    for (const account of accounts) {
        try {
            const outcome = await runOneAccount(env, db, account, fetchImpl, nowMs, random);
            if (outcome === 'sent') summary.sent++;
            else if (outcome === 'skipped') summary.skipped++;
            else if (outcome === 'failed') summary.failed++;
        } catch (err) {
            console.error('[outreach] 主动关怀失败 user=' + account.user_id + ': ' + (err && err.message));
            summary.state = 'error';
        }
    }
    if (summary.sent || summary.skipped || summary.failed) summary.state = 'active';
    return summary;
}

// ─────────────── 应用内开关接口 ───────────────

/** 应用内「主动关怀」开关：GET 状态 / POST 切换，删除语义无关（只切开关） */
export async function handleBotOutreachApi(request, env, url, db, userId) {
    const path = url.pathname;
    try {
        if (path === '/api/bot/outreach' && request.method === 'GET') {
            return jsonResponse(await loadOutreachState(db, userId), 200);
        }
        if (path === '/api/bot/outreach' && request.method === 'POST') {
            const parsed = await readJsonCapped(request, MAX_OUTREACH_BODY_BYTES);
            if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
            const payload = parsed.value || {};
            return jsonResponse(await setOutreachEnabled(db, userId, payload.enabled === true), 200);
        }
    } catch (err) {
        console.error('[outreach] 接口失败: ' + (err && err.message));
        return jsonResponse({ error: '主动关怀设置暂时不可用，请稍后重试' }, 502);
    }
    return jsonResponse({ error: '接口不存在' }, 404);
}
