/**
 * Garden Export — 服务端全量导出
 *
 * 为什么独立成模块：
 *   1. 客户端的 IndexedDB 只有笔记/周记/随手记/收藏/提示词这几类，阅读进度、健康打卡、
 *      Bot 档案与提醒只存在 D1，备份若号称「全量」就必须由服务端补上；
 *   2. garden-sync.js 已有 360+ 行，再塞进来会撞 500 行红线，按领域拆分更符合架构规约。
 *
 * 只导出用户内容：会话、Bot 访问令牌与轮询游标属于凭据，一律不进导出。
 * 图片二进制与书籍正文留在 R2（单本可能 20MB），导出里保留元数据并在 omissions 说明。
 */
import { jsonResponse, checkRateLimitShared, rateLimitedResponse } from './security.js';
import {
    formatWeekly,
    formatNote,
    formatBookmark,
    formatPrompt,
    formatFeed
} from './garden-shared.js';

export const EXPORT_FORMAT = 'chillin-export-v1';

export async function handleExport(db, userId) {
    const limit = await checkRateLimitShared(db, `export:${userId}`, 10, 10 * 60 * 1000);
    if (!limit.ok) return rateLimitedResponse(limit.retryAfter, '导出过于频繁，请稍后再试');

    const [
        user,
        weeklies,
        notes,
        bookmarks,
        prompts,
        feeds,
        echoCards,
        progress,
        books,
        health,
        profile,
        chatTurns,
        reminders,
        claw
    ] = await Promise.all([
        db.prepare('SELECT id, username, created_at FROM users WHERE id = ?1').bind(userId).first(),
        db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT * FROM prompts WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT id, title, summary, topic, related_feed_ids, created_at FROM echo_cards WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT book_key, book_title, chapter_index, chapter_title, scroll_percentage, updated_at FROM reader_progress WHERE user_id = ?1 ORDER BY updated_at DESC').bind(userId).all(),
        db.prepare('SELECT book_key, title, author, total_chapters, size, created_at, updated_at FROM reader_books WHERE user_id = ?1 AND is_deleted = 0 ORDER BY updated_at DESC').bind(userId).all(),
        db.prepare('SELECT date, steps, sleep_min, active_min, resting_hr, weight_kg, source, created_at, updated_at FROM health_daily WHERE user_id = ?1 AND is_deleted = 0 ORDER BY date DESC').bind(userId).all(),
        db.prepare('SELECT label, content, source, created_at, updated_at FROM bot_profile WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id ASC').bind(userId).all(),
        db.prepare('SELECT role, content, created_at FROM bot_chat_turns WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 200').bind(userId).all(),
        db.prepare('SELECT text, fire_at_ms, status, fired_at_ms, created_at FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all(),
        db.prepare('SELECT status, bound_at_ms, last_poll_at, outreach_enabled FROM bot_claw_accounts WHERE user_id = ?1 AND is_deleted = 0').bind(userId).first()
    ]);

    const weeklyRows = (weeklies.results || []).map(formatWeekly);
    const noteRows = (notes.results || []).map(formatNote);
    const bookmarkRows = (bookmarks.results || []).map(formatBookmark);
    const promptRows = (prompts.results || []).map(formatPrompt);
    const feedRows = (feeds.results || []).map(formatFeed);
    const echoRows = (echoCards.results || []).map((r) => ({
        id: r.id,
        title: r.title,
        summary: r.summary,
        topic: r.topic,
        relatedFeedIds: r.related_feed_ids,
        createdAt: r.created_at
    }));
    const healthRows = (health.results || []).map((r) => ({
        date: r.date,
        steps: r.steps,
        sleepMin: r.sleep_min,
        activeMin: r.active_min,
        restingHr: r.resting_hr,
        weightKg: r.weight_kg,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    }));
    const profileRows = (profile.results || []).map((r) => ({
        label: r.label,
        content: r.content,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at
    }));
    const chatRows = (chatTurns.results || []).slice().reverse().map((r) => ({
        role: r.role,
        content: r.content,
        createdAt: r.created_at
    }));
    const reminderRows = (reminders.results || []).map((r) => ({
        text: r.text,
        fireAtMs: r.fire_at_ms,
        status: r.status,
        firedAtMs: r.fired_at_ms,
        createdAt: r.created_at
    }));

    return jsonResponse({
        format: EXPORT_FORMAT,
        exported_at: new Date().toISOString(),
        user: user ? { id: user.id, username: user.username, created_at: user.created_at } : null,
        counts: {
            weeklies: weeklyRows.length,
            notes: noteRows.length,
            bookmarks: bookmarkRows.length,
            prompts: promptRows.length,
            feeds: feedRows.length,
            echoCards: echoRows.length,
            readerBooks: (books.results || []).length,
            readerProgress: (progress.results || []).length,
            healthDays: healthRows.length,
            botProfile: profileRows.length,
            botChatTurns: chatRows.length,
            botReminders: reminderRows.length
        },
        weeklies: weeklyRows,
        notes: noteRows,
        bookmarks: bookmarkRows,
        prompts: promptRows,
        feeds: feedRows,
        echoCards: echoRows,
        reader: {
            books: (books.results || []).map((r) => ({
                bookKey: r.book_key,
                title: r.title,
                author: r.author,
                totalChapters: r.total_chapters,
                size: r.size,
                createdAt: r.created_at,
                updatedAt: r.updated_at,
                contentInR2: true
            })),
            progress: (progress.results || []).map((r) => ({
                bookKey: r.book_key,
                bookTitle: r.book_title,
                chapterIndex: r.chapter_index,
                chapterTitle: r.chapter_title,
                scrollPercentage: r.scroll_percentage,
                updatedAt: r.updated_at
            }))
        },
        health: healthRows,
        bot: {
            profile: profileRows,
            chatTurns: chatRows,
            reminders: reminderRows,
            outreachEnabled: claw ? Boolean(claw.outreach_enabled) : false,
            claw: claw ? {
                status: claw.status,
                boundAtMs: claw.bound_at_ms,
                lastPollAt: claw.last_poll_at
            } : null
        },
        omissions: [
            '图片二进制与书籍正文存放于 R2，不在本 JSON 内（书籍元数据已保留，可按需从阅读器重新下载）',
            '会话、Bot 访问令牌与轮询游标属于凭据，不参与导出'
        ]
    }, 200, { 'Cache-Control': 'no-store' });
}
