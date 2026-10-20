/**
 * Bot 个人记忆层：当前对话上下文 + 「关于我」个人档案。
 *
 * 三层记忆的分工（对话编排在 bot-commands.js，事实检索在 rag.js）：
 *   1. 当前对话（bot_chat_turns）：有限长度的近场上下文，只服务这一次交谈，可整体重置；
 *   2. 个人档案（bot_profile）：用户自述的长期事实与偏好，只能由显式指令写入，可看 / 可改 / 可遗忘；
 *   3. 花园 RAG（rag.js）：历史记录本身，回答时作为证据引用。
 * 三者绝不合并——上下文会过期，档案要显式写入，花园是事实来源。
 *
 * 写入全部软删（is_deleted），用户数据永不物理删除；聊天正文永不进日志。
 */

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
    for (const it of hit) {
        await db.prepare(
            "UPDATE bot_profile SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2"
        ).bind(it.id, Number(userId)).run();
    }
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
