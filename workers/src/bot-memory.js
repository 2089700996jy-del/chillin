/**
 * Bot 个人记忆层：当前对话上下文 + 「关于我」个人档案。
 *
 * 三层记忆的分工（对话编排在 bot-commands.js，事实检索在 rag.js）：
 *   1. 当前对话（bot_chat_turns）：有限长度的近场上下文，只服务这一次交谈，可整体重置；
 *   2. 个人档案（bot_profile）：用户自述的长期事实与偏好，只能由显式指令写入，可看 / 可改 / 可遗忘；
 *   3. 花园 RAG（rag.js）：历史记录本身，回答时作为证据引用。
 * 三者绝不合并——上下文会过期，档案要显式写入，花园是事实来源。
 * 另有「待存图片」暂存位（bot_pending_media）：图片先描述、不落库，用户回「记录」才写成随手记。
 *
 * 写入全部软删（is_deleted），用户数据永不物理删除；聊天正文永不进日志。
 */

import { jsonResponse, readJsonCapped, isValidRecordId } from './security.js';

/** 注入提示词的最近对话条数上限 */
export const CHAT_CONTEXT_TURNS = 8;
/** 注入提示词的对话上下文字符总预算（有界，防止长回答把提示词撑爆） */
export const CHAT_CONTEXT_MAX_CHARS = 2400;
/** 单条对话入库前裁剪长度 */
export const CHAT_TURN_MAX_CHARS = 2000;
/** 一份档案最多注入多少条 */
export const PROFILE_MAX_ITEMS = 24;
/** 档案注入提示词的字符预算 */
export const PROFILE_MAX_CHARS = 1200;
/** 单条档案条目的字符上限 */
export const PROFILE_ITEM_MAX_CHARS = 240;
/** 应用内档案接口的请求体上限（单条 ≤240 字，留足 JSON 包装余量） */
const MAX_PROFILE_BODY_BYTES = 4096;

function clip(text, max) {
    const s = String(text == null ? '' : text);
    return s.length > max ? s.slice(0, max) + '…' : s;
}

/** 落一条对话（用户或助手），失败只记错误、不打断回复 */
export async function saveChatTurn(db, userId, role, content) {
    if (!db || !userId || !content) return false;
    try {
        await db.prepare(
            'INSERT INTO bot_chat_turns (user_id, role, content, is_deleted) VALUES (?1, ?2, ?3, 0)'
        ).bind(Number(userId), role === 'assistant' ? 'assistant' : 'user', clip(content, CHAT_TURN_MAX_CHARS)).run();
        return true;
    } catch (err) {
        console.error('[bot-memory] 写入对话上下文失败: ' + (err && err.message));
        return false;
    }
}

/** 取最近若干条对话，按「旧 → 新」返回，并保证总字符数有界 */
export async function loadChatContext(db, userId) {
    if (!db || !userId) return [];
    const rows = await db.prepare(
        'SELECT role, content FROM bot_chat_turns WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT ?2'
    ).bind(Number(userId), CHAT_CONTEXT_TURNS).all();
    const list = ((rows && rows.results) || []).slice().reverse();
    const kept = [];
    let used = 0;
    for (let i = list.length - 1; i >= 0; i--) {
        const content = String(list[i].content || '');
        if (!content) continue;
        // 从最新往旧累加：一旦加进更旧的会超预算就停止，上下文因此有界
        if (kept.length && used + content.length > CHAT_CONTEXT_MAX_CHARS) break;
        used += content.length;
        kept.unshift({ role: list[i].role === 'assistant' ? 'assistant' : 'user', content });
    }
    return kept;
}

/** 「重置对话」：整体软删当前上下文，返回受影响条数 */
export async function clearChatContext(db, userId) {
    if (!db || !userId) return 0;
    const res = await db.prepare(
        'UPDATE bot_chat_turns SET is_deleted = 1 WHERE user_id = ?1 AND is_deleted = 0'
    ).bind(Number(userId)).run();
    return (res && res.meta && res.meta.changes) || 0;
}

// ─────────────── 待确认动作（管家编辑 / 删除、交流偏好共用） ───────────────

/** 待确认动作的保留时长：过期后必须重新发起，避免很久以后一句「确认」误改数据 */
export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

/** 读当前用户最新一条待确认动作；过期只标记并带回 action，交给对应入口清理与解释 */
export async function readPendingAction(db, userId, now) {
    const ts = now == null ? Date.now() : now;
    let row;
    try {
        row = await db.prepare(
            'SELECT id, action, target_table, target_id, payload, created_at_ms FROM bot_pending_actions WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 1'
        ).bind(Number(userId)).first();
    } catch (err) {
        console.error('[bot-memory] 读取待确认动作失败: ' + (err && err.message));
        return null;
    }
    if (!row) return null;
    // 过期只标记、不在这里清：调用方要先看 action 才能决定由谁解释；清理交给对应入口
    if (Number(row.created_at_ms) + PENDING_ACTION_TTL_MS < ts) {
        return { ...row, payload: {}, expired: true };
    }
    let payload = {};
    try { payload = JSON.parse(row.payload || '{}'); } catch (_) { payload = {}; }
    return { ...row, payload };
}

/** 同一用户只保留一条待确认动作：新动作会软删旧的，避免两句「确认」改错目标 */
export async function savePendingAction(db, userId, action, targetTable, targetId, payload) {
    await db.prepare('UPDATE bot_pending_actions SET is_deleted = 1 WHERE user_id = ?1 AND is_deleted = 0')
        .bind(Number(userId)).run();
    await db.prepare(
        'INSERT INTO bot_pending_actions (user_id, action, target_table, target_id, payload, created_at_ms, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)'
    ).bind(Number(userId), action, targetTable, Number(targetId) || 0, JSON.stringify(payload || {}), Date.now()).run();
}

/** 作废当前待确认动作（软删，绝不物理删除） */
export async function clearPendingAction(db, userId) {
    await db.prepare('UPDATE bot_pending_actions SET is_deleted = 1 WHERE user_id = ?1 AND is_deleted = 0')
        .bind(Number(userId)).run();
}

/** 待存内容的保留时长：超过这个时间还没被「记录」确认，就当用户不要了 */
export const PENDING_MEDIA_TTL_MINUTES = 60;
/** 待存正文上限（配文 ≤2000 字 + 看图描述 ≤120 字，留足余量） */
const PENDING_MEDIA_MAX_CHARS = 2400;
/** 待存卡片元数据（JSON）上限：链接速览用的 title / description / cover */
const PENDING_SUMMARY_MAX_CHARS = 1200;
/** 待存多图批次（JSON）上限：最多 6 张，含每张的短描述 */
const PENDING_IMAGE_BATCH_MAX_CHARS = 12000;
const PENDING_IMAGE_BATCH_MAX_ITEMS = 6;
/** 待存内容的确认提示：图片与链接速览共用同一句 */
export const PENDING_CONFIRM_HINT = '\n\n要存进随手记就回我「记录」。';

/**
 * 暂存一条「待确认为随手记」的消息（微信图片，或带卡片元数据的小宇宙链接）。
 * 每人只留最新一条（user_id 主键 + UPSERT）：消息不再自动写进随手记，
 * 而是等用户在有效期内回一句「记录」——默认无副作用，宁可少记不可错记。
 * media_url 允许为空串（页面没有封面时），summary 只在链接速览时为卡片 JSON。
 */
export async function savePendingMedia(db, userId, mediaUrl, content, summary, imageBatch) {
    const url = String(mediaUrl || '');
    const body = String(content || '').trim();
    if (!db || !userId || !body) return false;
    const meta = summary ? clip(String(summary), PENDING_SUMMARY_MAX_CHARS) : null;
    const batch = imageBatch ? clip(JSON.stringify(imageBatch), PENDING_IMAGE_BATCH_MAX_CHARS) : null;
    try {
        await db.prepare(
            'INSERT INTO bot_pending_media (user_id, media_url, content, summary, media_urls, is_deleted) VALUES (?1, ?2, ?3, ?4, ?5, 0) '
            + "ON CONFLICT(user_id) DO UPDATE SET media_url = ?2, content = ?3, summary = ?4, media_urls = ?5, is_deleted = 0, created_at = datetime('now', '+8 hours')"
        ).bind(Number(userId), url, clip(body, PENDING_MEDIA_MAX_CHARS), meta, batch).run();
        return true;
    } catch (err) {
        console.error('[bot-memory] 暂存消息失败: ' + (err && err.message));
        return false;
    }
}

/** 取有效期内的待存内容（created_at 是东八区，减 8 小时才能跟 datetime('now') 的 UTC 比） */
export async function readPendingMedia(db, userId) {
    if (!db || !userId) return null;
    const row = await db.prepare(
        'SELECT media_url, content, summary, media_urls FROM bot_pending_media WHERE user_id = ?1 AND is_deleted = 0 '
        + "AND datetime(created_at, '-8 hours') >= datetime('now', ?2)"
    ).bind(Number(userId), '-' + PENDING_MEDIA_TTL_MINUTES + ' minutes').first();
    return row && row.content ? row : null;
}

/**
 * 解析待存多图批次。兼容旧行（无 media_urls）与直接的数组 JSON；
 * 只保留 http(s)/站内 /api/file/ 地址，最多 6 张，描述截断，绝不把坏 JSON 抛给调用方。
 */
export function parsePendingImageBatch(raw) {
    let data = raw;
    if (typeof raw === 'string' && raw.trim()) {
        try { data = JSON.parse(raw); } catch (_) { data = null; }
    }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
    const caption = data && !Array.isArray(data) ? String(data.caption || '').trim() : '';
    const out = [];
    for (const item of items) {
        if (!item || typeof item.url !== 'string') continue;
        const url = item.url.trim();
        if (!url || (!/^https?:\/\//i.test(url) && !url.startsWith('/api/file/'))) continue;
        out.push({
            url,
            fileId: String(item.fileId || '').trim(),
            mime: String(item.mime || '').trim(),
            desc: clip(String(item.desc || '').trim(), 1200)
        });
    }
    return { caption: clip(caption, PENDING_MEDIA_MAX_CHARS), items: out.slice(-PENDING_IMAGE_BATCH_MAX_ITEMS) };
}

export { PENDING_IMAGE_BATCH_MAX_ITEMS };


/** 确认落库之后作废这一条（软删，用户数据永不物理删除） */
export async function clearPendingMedia(db, userId) {
    if (!db || !userId) return 0;
    const res = await db.prepare(
        'UPDATE bot_pending_media SET is_deleted = 1 WHERE user_id = ?1 AND is_deleted = 0'
    ).bind(Number(userId)).run();
    return (res && res.meta && res.meta.changes) || 0;
}


/** 读「关于我」档案（未软删、按写入顺序） */
export async function listProfile(db, userId) {
    if (!db || !userId) return [];
    const rows = await db.prepare(
        'SELECT id, label, content, created_at FROM bot_profile WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id ASC LIMIT ?2'
    ).bind(Number(userId), PROFILE_MAX_ITEMS).all();
    return (rows && rows.results) || [];
}

/** 写一条档案：内容完全相同视为重复，不重复入库 */
export async function addProfileItem(db, userId, content, label = '') {
    if (!db || !userId || !content) return { ok: false, duplicate: false };
    const body = clip(content, PROFILE_ITEM_MAX_CHARS);
    const existing = await listProfile(db, userId);
    if (existing.some((it) => String(it.content) === body)) return { ok: true, duplicate: true };
    // 条数硬上限：缺这道闸，第 25 条会写进库里却永远读不出来（listProfile 自带 LIMIT）
    if (existing.length >= PROFILE_MAX_ITEMS) return { ok: false, duplicate: false, full: true };
    try {
        await db.prepare(
            'INSERT INTO bot_profile (user_id, label, content, source, is_deleted) VALUES (?1, ?2, ?3, ?4, 0)'
        ).bind(Number(userId), clip(label, 40), body, 'user').run();
        return { ok: true, duplicate: false };
    } catch (err) {
        console.error('[bot-memory] 写入个人档案失败: ' + (err && err.message));
        return { ok: false, duplicate: false };
    }
}

/** 按关键词忘记：内容或标签包含即命中，逐条软删（不物理删除） */
export async function forgetProfile(db, userId, keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    if (!kw) return { removed: 0 };
    const items = await listProfile(db, userId);
    const hit = items.filter((it) => (
        String(it.content || '').toLowerCase().includes(kw)
        || String(it.label || '').toLowerCase().includes(kw)
    ));
    for (const it of hit) await forgetProfileById(db, userId, it.id);
    return { removed: hit.length };
}

/** 清空整份档案（同样走软删） */
export async function clearProfile(db, userId) {
    if (!db || !userId) return { removed: 0 };
    const res = await db.prepare(
        "UPDATE bot_profile SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE user_id = ?1 AND is_deleted = 0"
    ).bind(Number(userId)).run();
    return { removed: (res && res.meta && res.meta.changes) || 0 };
}

/** 按 id 遗忘一条：只作用于本人未软删的条目，仍走软删 */
export async function forgetProfileById(db, userId, id) {
    const rid = Number(id);
    if (!db || !userId || !isValidRecordId(rid)) return { removed: 0 };
    const res = await db.prepare(
        "UPDATE bot_profile SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2 AND is_deleted = 0"
    ).bind(rid, Number(userId)).run();
    return { removed: (res && res.meta && res.meta.changes) || 0 };
}

/** 应用内改一条档案：只更新本人未软删的条目（改内容与标签，不改归属） */
export async function updateProfileItem(db, userId, id, content, label = '') {
    const rid = Number(id);
    const body = String(content == null ? '' : content).trim();
    if (!db || !userId || !isValidRecordId(rid) || !body) return { ok: false, reason: 'invalid' };
    const res = await db.prepare(
        "UPDATE bot_profile SET content = ?1, label = ?2, updated_at = datetime('now', '+8 hours') WHERE id = ?3 AND user_id = ?4 AND is_deleted = 0"
    ).bind(clip(body, PROFILE_ITEM_MAX_CHARS), clip(label, 40), rid, Number(userId)).run();
    const changes = (res && res.meta && res.meta.changes) || 0;
    return { ok: changes > 0, reason: changes > 0 ? '' : 'not_found' };
}

/** 拼成注入提示词的档案块（受字符预算约束，空档案返回空串） */
export async function loadProfilePrompt(db, userId) {
    const items = await listProfile(db, userId);
    const lines = [];
    let used = 0;
    for (const it of items) {
        const line = '- ' + (it.label ? it.label + '：' : '') + it.content;
        if (used + line.length > PROFILE_MAX_CHARS) break;
        used += line.length;
        lines.push(line);
    }
    return lines.join('\n');
}

// ─────────────── 应用内「关于我」档案接口 ───────────────

/**
 * 应用内档案接口：查看 / 新增 / 编辑 / 遗忘。
 * 与微信侧共用同一份 bot_profile，所以两个入口看到的是同一份档案；
 * 删除一律软删，用户数据永不物理删除；请求体有上限、全部参数化绑定。
 */
export async function handleBotProfileApi(request, env, url, db, userId) {
    const path = url.pathname;
    try {
        if (path === '/api/bot/profile' && request.method === 'GET') {
            const items = await listProfile(db, userId);
            return jsonResponse({ items, maxItems: PROFILE_MAX_ITEMS, itemMaxChars: PROFILE_ITEM_MAX_CHARS }, 200);
        }
        if (path === '/api/bot/profile' && request.method === 'POST') {
            const parsed = await readJsonCapped(request, MAX_PROFILE_BODY_BYTES);
            if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
            const payload = parsed.value || {};
            const content = String(payload.content == null ? '' : payload.content).trim();
            if (!content) return jsonResponse({ error: '内容不能为空' }, 400);
            const res = await addProfileItem(db, userId, content, String(payload.label == null ? '' : payload.label).trim());
            if (!res.ok) {
                if (res.full) return jsonResponse({ error: '档案最多保留 ' + PROFILE_MAX_ITEMS + ' 条，先遗忘一两条再记新的' }, 409);
                return jsonResponse({ error: '写入失败，请稍后重试' }, 500);
            }
            return jsonResponse({ ok: true, duplicate: !!res.duplicate }, 200);
        }
        if (path === '/api/bot/profile/clear' && request.method === 'POST') {
            return jsonResponse(await clearProfile(db, userId), 200);
        }
        const one = path.match(/^\/api\/bot\/profile\/(\d+)$/);
        if (one && request.method === 'PUT') {
            const parsed = await readJsonCapped(request, MAX_PROFILE_BODY_BYTES);
            if (!parsed.ok) return jsonResponse({ error: parsed.error }, parsed.status);
            const payload = parsed.value || {};
            const content = String(payload.content == null ? '' : payload.content).trim();
            if (!content) return jsonResponse({ error: '内容不能为空' }, 400);
            const res = await updateProfileItem(db, userId, one[1], content, String(payload.label == null ? '' : payload.label).trim());
            if (!res.ok) return jsonResponse({ error: res.reason === 'invalid' ? '内容不能为空' : '这条档案不存在' }, res.reason === 'invalid' ? 400 : 404);
            return jsonResponse({ ok: true }, 200);
        }
        if (one && request.method === 'DELETE') {
            const res = await forgetProfileById(db, userId, one[1]);
            if (!res.removed) return jsonResponse({ error: '这条档案不存在' }, 404);
            return jsonResponse({ ok: true, removed: res.removed }, 200);
        }
    } catch (err) {
        console.error('[bot-memory] 档案接口失败: ' + (err && err.message));
        return jsonResponse({ error: '档案服务暂时不可用，请稍后重试' }, 502);
    }
    return jsonResponse({ error: '接口不存在' }, 404);
}
