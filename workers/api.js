// Chillin API Worker — Main Entrypoint & Router
import {
    isAllowedOrigin,
    applySecurityHeaders,
    withCors,
    jsonResponse,
    cleanupRateLimits
} from './src/security.js';

import {
    authenticate,
    handleRegister,
    handleLogin,
    handleLogout,
    handleLogoutAll,
    handleRefreshSession,
    handleListSessions,
    handleRevokeSession,
    handleMe,
    handlePushSubscribe,
    cleanExpiredSessions
} from './src/auth.js';

import {
    scanAndAudit,
    cleanupAuditLogs
} from './src/audit.js';

import {
    handleAiChat
} from './src/ai.js';

import { ensureSoftDeleteSchema } from './src/garden-shared.js';

import {
    handleUpload,
    handleFileView,
    handleLinkParse
} from './src/garden-media.js';

import {
    handleGetWeeklies,
    handlePostWeekly,
    handlePutWeekly,
    handleDeleteWeekly,
    handleGetNotes,
    handlePostNote,
    handlePutNote,
    handleDeleteNote,
    handleGetBookmarks,
    handlePostBookmark,
    handleDeleteBookmark,
    handleGetPrompts,
    handlePostPrompt,
    handleDeletePrompt,
    handleGetFeeds,
    handlePostFeed,
    handlePutFeed,
    handleDeleteFeed,
    handleGetReaderProgress,
    handlePostReaderProgress
} from './src/garden-resources.js';

import {
    handleSyncPull,
    handleSyncBatch,
    handleHeatmap
} from './src/garden-sync.js';

import {
    handleEchoGenerate,
    handleGetEchoCards,
    handleDeleteEchoCard,
    handleAiReview,
    handleAuditScan
} from './src/garden-echo.js';

/** Keep in sync with js/version.js — used by PWA update probe (bypasses Pages CDN). */
const APP_VERSION = '2.5.53';

async function router(path, method, request, env, ctx) {
    const db = env.DB;
    const url = new URL(request.url);

    // ==================== 公开路由（无需登录） ====================
    if (path === '/api/app-version' && method === 'GET') {
        return jsonResponse(
            { version: APP_VERSION, build: `v${APP_VERSION}` },
            200,
            { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'CDN-Cache-Control': 'no-store' }
        );
    }

    // 健康检查：供 uptime 监控 / 手动排查使用（只暴露版本与数据库可达性）
    if (path === '/api/health' && method === 'GET') {
        let dbOk = true;
        try {
            await db.prepare('SELECT 1 AS ok').first();
        } catch (err) {
            dbOk = false;
            console.error('[health] database probe failed:', err);
        }
        return jsonResponse(
            { ok: dbOk, version: APP_VERSION, time: new Date().toISOString() },
            dbOk ? 200 : 503,
            { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'CDN-Cache-Control': 'no-store' }
        );
    }

    if (path === '/api/push/subscribe' && method === 'POST') {
        return handlePushSubscribe(request, db);
    }

    if (path === '/api/auth/register' && method === 'POST') {
        return handleRegister(request, env, db);
    }

    if (path === '/api/auth/login' && method === 'POST') {
        return handleLogin(request, env, db);
    }

    if (path.startsWith('/api/file/') && method === 'GET') {
        const fileId = path.replace('/api/file/', '');
        return handleFileView(fileId, request, db, authenticate);
    }

    if (path === '/api/link/parse' && method === 'POST') {
        const linkUserId = await authenticate(request, db);
        if (!linkUserId) return jsonResponse({ error: '未登录或登录已过期' }, 401);
        return handleLinkParse(request, env, db, linkUserId);
    }

    // ==================== 鉴权闸门（以下路由全量要求登录） ====================
    const userId = await authenticate(request, db);
    if (!userId) {
        return jsonResponse({ error: '未登录或登录已过期' }, 401);
    }
    await ensureSoftDeleteSchema(db);

    // ── 账号与文件 ──
    if (path === '/api/upload' && method === 'POST') return handleUpload(request, db, userId);
    if (path === '/api/auth/logout' && method === 'POST') return handleLogout(request, db);
    if (path === '/api/auth/logout-all' && method === 'POST') return handleLogoutAll(request, db, userId);
    if (path === '/api/auth/refresh' && method === 'POST') return handleRefreshSession(request, env, db, userId);
    if (path === '/api/auth/sessions' && method === 'GET') return handleListSessions(request, db, userId);
    const sessionMatch = path.match(/^\/api\/auth\/sessions\/([0-9a-f]{64})$/);
    if (sessionMatch && method === 'DELETE') return handleRevokeSession(request, db, userId, sessionMatch[1]);
    if (path === '/api/auth/me' && method === 'GET') return handleMe(db, userId);

    // ── 周记 (Weeklies) ──
    if (path === '/api/weeklies' && method === 'GET') return handleGetWeeklies(url, db, userId);
    if (path === '/api/weeklies' && method === 'POST') return handlePostWeekly(request, db, userId);
    const weeklyMatch = path.match(/^\/api\/weeklies\/(\d+)$/);
    if (weeklyMatch && method === 'PUT') return handlePutWeekly(parseInt(weeklyMatch[1]), request, db, userId);
    if (weeklyMatch && method === 'DELETE') return handleDeleteWeekly(parseInt(weeklyMatch[1]), db, userId);

    // ── 备忘录 (Notes) ──
    if (path === '/api/notes' && method === 'GET') return handleGetNotes(url, db, userId);
    if (path === '/api/notes' && method === 'POST') return handlePostNote(request, db, userId);
    const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
    if (noteMatch && method === 'PUT') return handlePutNote(parseInt(noteMatch[1]), request, db, userId);
    if (noteMatch && method === 'DELETE') return handleDeleteNote(parseInt(noteMatch[1]), db, userId);

    // ── 收藏 (Bookmarks) ──
    if (path === '/api/bookmarks' && method === 'GET') return handleGetBookmarks(url, db, userId);
    if (path === '/api/bookmarks' && method === 'POST') return handlePostBookmark(request, db, userId);
    const bmMatch = path.match(/^\/api\/bookmarks\/(\d+)$/);
    if (bmMatch && method === 'DELETE') return handleDeleteBookmark(parseInt(bmMatch[1]), db, userId);

    // ── 提示词库 (Prompts) ──
    if (path === '/api/prompts' && method === 'GET') return handleGetPrompts(url, db, userId);
    if (path === '/api/prompts' && method === 'POST') return handlePostPrompt(request, db, userId);
    const promptMatch = path.match(/^\/api\/prompts\/(\d+)$/);
    if (promptMatch && method === 'DELETE') return handleDeletePrompt(parseInt(promptMatch[1]), db, userId);

    // ── 随手记 (Feeds) ──
    if (path === '/api/feeds' && method === 'GET') return handleGetFeeds(url, db, userId);
    if (path === '/api/feeds' && method === 'POST') return handlePostFeed(request, db, userId);
    const feedMatch = path.match(/^\/api\/feeds\/(\d+)$/);
    if (feedMatch && method === 'PUT') return handlePutFeed(parseInt(feedMatch[1]), request, db, userId);
    if (feedMatch && method === 'DELETE') return handleDeleteFeed(parseInt(feedMatch[1]), db, userId);

    // ── 阅读器进度 (Reader Progress) ──
    if (path === '/api/reader/progress' && method === 'GET') return handleGetReaderProgress(db, userId);
    if (path === '/api/reader/progress' && method === 'POST') return handlePostReaderProgress(request, db, userId);

    // ── 增量同步与批处理 (Sync) ──
    if (path === '/api/sync/pull' && method === 'GET') return handleSyncPull(url, db, userId);
    if (path === '/api/sync/batch' && method === 'POST') return handleSyncBatch(request, db, userId);

    // ── 统计 ──
    if (path === '/api/stats/heatmap' && method === 'GET') return handleHeatmap(db, userId);

    // ── AI 记忆回响问答 (Chat & RAG) ── 实现在 src/ai.js
    if (path === '/api/ai/chat' && method === 'POST') return handleAiChat(request, env, db, userId);

    // ── AI 回顾与回响卡片 ──
    if (path === '/api/ai/review' && method === 'POST') return handleAiReview(env, db, userId);
    if (path === '/api/echo/generate' && method === 'POST') return handleEchoGenerate(request, env, ctx, db, userId);
    if (path === '/api/echo/cards' && method === 'GET') return handleGetEchoCards(db, userId);
    const echoCardMatch = path.match(/^\/api\/echo\/cards\/(\d+)$/);
    if (echoCardMatch && method === 'DELETE') return handleDeleteEchoCard(parseInt(echoCardMatch[1]), db, userId);

    // ── 审计扫描 ──
    if (path === '/api/audit/scan' && method === 'POST') return handleAuditScan(db, userId);

    return jsonResponse({ error: 'Not found' }, 404);
}

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS 预检
        if (method === 'OPTIONS') {
            const origin = request.headers.get('Origin');
            const headers = applySecurityHeaders(new Headers({
                'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Authorization',
                'Access-Control-Allow-Credentials': 'true'
            }));
            if (isAllowedOrigin(origin)) {
                headers.set('Access-Control-Allow-Origin', origin);
                headers.set('Vary', 'Origin');
            }
            return new Response(null, { status: 204, headers });
        }

        try {
            return withCors(await router(path, method, request, env, ctx), request);
        } catch (err) {
            console.error('[api] unhandled error:', err);
            return withCors(jsonResponse({ error: '服务器内部错误' }, 500), request);
        }
    },

    // 定时任务：每小时扫描 UGC 隔离违规内容；并清理过期 Session
    async scheduled(event, env, ctx) {
        try {
            const result = await scanAndAudit(env.DB);
            console.log(`[audit] scheduled scan: scanned=${result.scanned} quarantined=${result.quarantined}`);
        } catch (err) {
            console.error('[audit] scheduled scan failed:', err);
        }
        try {
            const cleaned = await cleanExpiredSessions(env.DB);
            console.log(`[session] scheduled cleanup: removed=${cleaned}`);
        } catch (err) {
            console.error('[session] scheduled cleanup failed:', err);
        }
        try {
            const pruned = await cleanupRateLimits(env.DB);
            console.log(`[rate-limit] scheduled cleanup: removed=${pruned}`);
        } catch (err) {
            console.error('[rate-limit] scheduled cleanup failed:', err);
        }
        try {
            const audits = await cleanupAuditLogs(env.DB);
            console.log(`[audit] retention cleanup: logs=${audits.auditLogs} quarantine=${audits.quarantine}`);
        } catch (err) {
            console.error('[audit] retention cleanup failed:', err);
        }
    }
};
