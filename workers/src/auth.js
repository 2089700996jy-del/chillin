/**
 * Authentication & Session Management Module
 */
import {
    jsonResponse,
    checkRateLimitShared,
    rateLimitedResponse,
    getClientIp,
    validatePassword,
    hashPassword,
    verifyPassword
} from './security.js';

export const SESSION_COOKIE = 'chillin_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 从 Authorization: Bearer 或 HttpOnly 会话 Cookie 中提取令牌 */
export function extractSessionToken(request) {
    const authHeader = request.headers.get('Authorization') || '';
    if (authHeader.startsWith('Bearer ')) {
        const bearer = authHeader.slice(7).trim();
        if (bearer) return bearer;
    }
    const cookieHeader = request.headers.get('Cookie') || '';
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        if (part.slice(0, idx).trim() !== SESSION_COOKIE) continue;
        const raw = part.slice(idx + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }
    return '';
}

function isSecureRequest(request) {
    try {
        return new URL(request.url).protocol === 'https:';
    } catch {
        return true;
    }
}

/** 会话 Cookie：HttpOnly + SameSite=Lax（HTTPS 下追加 Secure），前端 JS 无法读取 */
export function sessionCookieHeader(token, request, maxAgeSeconds = SESSION_TTL_MS / 1000) {
    const attrs = [
        `${SESSION_COOKIE}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(maxAgeSeconds)}`
    ];
    if (isSecureRequest(request)) attrs.push('Secure');
    return attrs.join('; ');
}

/** 会话令牌摘要：数据库中只保存 SHA-256 哈希，库泄露也无法直接重放会话 */
export async function tokenHash(token) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token || '')));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 解析会话：先按哈希查询；命中旧版明文行时就地升级为哈希存储（零停机迁移）。
 * 返回 { token, user_id, expires_at } 或 null。
 */
async function resolveSession(db, token, { upgrade = true } = {}) {
    const hashed = await tokenHash(token);
    const selectSql = 'SELECT token, user_id, expires_at, COALESCE(last_seen_at, 0) AS last_seen_at FROM sessions WHERE token = ?1 AND expires_at > ?2';

    let row = await db.prepare(selectSql).bind(hashed, Date.now()).first();
    if (!row) {
        // 防范 D1 主从节点边缘同步延迟：极快连续请求如果初次未查到，微秒级重试一次
        await new Promise(r => setTimeout(r, 60));
        row = await db.prepare(selectSql).bind(hashed, Date.now()).first();
    }
    if (row) {
        // 设备列表需要「最近活跃」；每 5 分钟最多写一次，避免每次请求都写库
        try {
            if (Date.now() - Number(row.last_seen_at || 0) > 5 * 60 * 1000) {
                await db.prepare('UPDATE sessions SET last_seen_at = ?1 WHERE token = ?2')
                    .bind(Date.now(), row.token).run();
            }
        } catch (_) { /* 活跃时间写入失败不影响鉴权 */ }
        return row;
    }

    // 兼容旧版明文会话（升级失败也不影响本次鉴权）
    const legacy = await db.prepare(selectSql).bind(token, Date.now()).first();
    if (!legacy) return null;
    if (upgrade) {
        try {
            await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
            await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
                .bind(hashed, legacy.user_id, legacy.expires_at).run();
        } catch (_) { /* 忽略：下次请求会再试 */ }
    }
    return legacy;
}

export async function authenticate(request, db) {
    const token = extractSessionToken(request);
    if (!token) return null;
    const session = await resolveSession(db, token);
    return session ? session.user_id : null;
}

export async function handleRegister(request, env, db) {
    const regLimit = await checkRateLimitShared(db, `register:${getClientIp(request, env)}`, 5, 60 * 60 * 1000);
    if (!regLimit.ok) return rateLimitedResponse(regLimit.retryAfter);

    if (env.ALLOW_REGISTRATION !== 'true') {
        return jsonResponse({ error: '注册功能已关闭，请联系管理员。' }, 403);
    }

    const { username, password } = await request.json();
    if (!username || username.length < 3 || username.length > 32) {
        return jsonResponse({ error: '账号长度需为 3–32 位' }, 400);
    }
    const pwdErr = validatePassword(password);
    if (pwdErr) return jsonResponse({ error: pwdErr }, 400);

    const existing = await db.prepare('SELECT id FROM users WHERE username = ?1').bind(username).first();
    if (existing) {
        return jsonResponse({ error: '该账号已被注册' }, 400);
    }

    const hashedPassword = await hashPassword(password);
    const insertResult = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?1, ?2) RETURNING id')
        .bind(username, hashedPassword).first();

    const userId = insertResult.id;
    const token = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    // 数据库只存哈希；明文仅通过 Set-Cookie 交给浏览器
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen_at, user_agent, ip) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)')
        .bind(await tokenHash(token), userId, expiresAt, Date.now(), request.headers.get('User-Agent') || '', getClientIp(request, env)).run();

    // 同时下发 HttpOnly Cookie；响应体仍带 token，保证旧前端零停机共存
    return jsonResponse(
        { token, username, userId, session: 'cookie' },
        201,
        { 'Set-Cookie': sessionCookieHeader(token, request) }
    );
}

export async function handleLogin(request, env, db) {
    const loginLimit = await checkRateLimitShared(db, `login:${getClientIp(request, env)}`, 40, 15 * 60 * 1000);
    if (!loginLimit.ok) {
        return rateLimitedResponse(loginLimit.retryAfter, '登录过于频繁，请稍后再试');
    }

    let body;
    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: '请求格式错误，请重试' }, 400);
    }
    const username = body && typeof body.username === 'string' ? body.username.trim() : '';
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!username || !password) return jsonResponse({ error: '请输入账号和密码' }, 400);

    // 账号维度锁定：经 Pages 反代时 CF-Connecting-IP 会变成边缘地址，
    // 单靠 IP 桶会退化成「全局一个桶」，因此再按账号独立计数（15 分钟 10 次）。
    const accountLimit = await checkRateLimitShared(db, `login-user:${username.toLowerCase()}`, 10, 15 * 60 * 1000);
    if (!accountLimit.ok) {
        return rateLimitedResponse(accountLimit.retryAfter, '该账号尝试过于频繁，请稍后再试');
    }

    const user = await db.prepare('SELECT id, password_hash FROM users WHERE username = ?1').bind(username).first();
    if (!user) return jsonResponse({ error: '账号或密码错误' }, 401);

    const verify = await verifyPassword(password, user.password_hash);
    if (!verify.valid) {
        return jsonResponse({ error: '账号或密码错误' }, 401);
    }
    // 旧格式密码透明升级为 PBKDF2
    if (verify.upgrade) {
        const upgraded = await hashPassword(password);
        await db.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(upgraded, user.id).run();
    }

    const token = crypto.randomUUID();
    const expiresAt = Date.now() + SESSION_TTL_MS;
    // 数据库只存哈希；明文仅通过 Set-Cookie 交给浏览器
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen_at, user_agent, ip) VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)')
        .bind(await tokenHash(token), user.id, expiresAt, Date.now(), request.headers.get('User-Agent') || '', getClientIp(request, env)).run();

    // 同时下发 HttpOnly Cookie；响应体仍带 token，保证旧前端零停机共存
    return jsonResponse(
        { token, username, userId: user.id, session: 'cookie' },
        200,
        { 'Set-Cookie': sessionCookieHeader(token, request) }
    );
}

export async function handleLogout(request, db) {
    const token = extractSessionToken(request);
    if (token) {
        // 同时清理哈希行与可能遗留的明文行
        await db.prepare('DELETE FROM sessions WHERE token IN (?1, ?2)')
            .bind(await tokenHash(token), token).run();
    }
    return jsonResponse({ success: true }, 200, { 'Set-Cookie': sessionCookieHeader('', request, 0) });
}

/** 退出所有设备：吊销该用户全部会话（丢失设备时可一键止损） */
export async function handleLogoutAll(request, db, userId) {
    const res = await db.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(userId).run();
    return jsonResponse(
        { success: true, revoked: res.meta?.changes || 0 },
        200,
        { 'Set-Cookie': sessionCookieHeader('', request, 0) }
    );
}

/** 人类可读的设备描述（纯函数，便于单测） */
export function describeUserAgent(ua) {
    const s = String(ua || '');
    if (!s) return '未知设备';
    const os = /iPhone|iPad|iPod/i.test(s) ? 'iOS'
        : /Android/i.test(s) ? 'Android'
        : /Macintosh|Mac OS X/i.test(s) ? 'macOS'
        : /Windows/i.test(s) ? 'Windows'
        : /Linux/i.test(s) ? 'Linux'
        : '未知系统';
    const browser = /Edg\//i.test(s) ? 'Edge'
        : /OPR\/|Opera/i.test(s) ? 'Opera'
        : /Chrome\/|CriOS/i.test(s) ? 'Chrome'
        : /Firefox\/|FxiOS/i.test(s) ? 'Firefox'
        : /Safari\//i.test(s) ? 'Safari'
        : '未知浏览器';
    return `${os} · ${browser}`;
}

/**
 * 滑动续期 + 会话轮换。
 * * Cookie 客户端：签发新令牌并吊销旧行（防会话固定），旧 Cookie 立即失效；
 * * 旧版 Bearer 客户端收不到新 Cookie，只延长有效期、不轮换，避免把旧客户端踢下线。
 */
export async function handleRefreshSession(request, env, db, userId) {
    const raw = extractSessionToken(request);
    if (!raw) return jsonResponse({ error: '未提供登录凭证' }, 401);

    const viaCookie = !(request.headers.get('Authorization') || '').startsWith('Bearer ');
    const hashed = await tokenHash(raw);
    const row = await db.prepare('SELECT token, created_at, user_agent, ip FROM sessions WHERE token = ?1 AND user_id = ?2')
        .bind(hashed, userId).first();
    if (!row) return jsonResponse({ error: '无效或过期的会话' }, 401);

    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;

    if (!viaCookie) {
        await db.prepare('UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE token = ?3')
            .bind(expiresAt, now, hashed).run();
        return jsonResponse({ success: true, rotated: false, expiresAt }, 200);
    }

    const newToken = crypto.randomUUID();
    const newHash = await tokenHash(newToken);
    await db.batch([
        db.prepare('DELETE FROM sessions WHERE token = ?1').bind(hashed),
        db.prepare('INSERT INTO sessions (token, user_id, expires_at, created_at, last_seen_at, user_agent, ip) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
            .bind(newHash, userId, expiresAt, row.created_at || now, now, row.user_agent || '', row.ip || '')
    ]);
    return jsonResponse(
        { success: true, rotated: true, expiresAt },
        200,
        { 'Set-Cookie': sessionCookieHeader(newToken, request) }
    );
}

/** 当前账号的登录设备列表（含当前会话标记） */
export async function handleListSessions(request, db, userId) {
    const raw = extractSessionToken(request);
    const currentHash = raw ? await tokenHash(raw) : '';
    const rows = await db.prepare(
        'SELECT token, created_at, last_seen_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ?1 AND expires_at > ?2 ORDER BY COALESCE(last_seen_at, created_at, 0) DESC'
    ).bind(userId, Date.now()).all();

    return jsonResponse((rows.results || []).map((r) => ({
        id: r.token,
        current: r.token === currentHash,
        device: describeUserAgent(r.user_agent),
        ip: r.ip || '',
        createdAt: r.created_at || null,
        lastSeenAt: r.last_seen_at || r.created_at || null,
        expiresAt: r.expires_at
    })), 200);
}

/** 吊销指定会话（「退出该设备」）；吊销当前会话时同时清 Cookie */
export async function handleRevokeSession(request, db, userId, sessionId) {
    if (!sessionId || !/^[0-9a-f]{64}$/.test(sessionId)) {
        return jsonResponse({ error: '无效的会话标识' }, 400);
    }
    const res = await db.prepare('DELETE FROM sessions WHERE token = ?1 AND user_id = ?2')
        .bind(sessionId, userId).run();
    const raw = extractSessionToken(request);
    const isCurrent = !!raw && (await tokenHash(raw)) === sessionId;
    return jsonResponse(
        { success: true, revoked: res.meta?.changes || 0, current: isCurrent },
        200,
        isCurrent ? { 'Set-Cookie': sessionCookieHeader('', request, 0) } : null
    );
}

export async function handleMe(db, userId) {
    const user = await db.prepare('SELECT id, username, created_at FROM users WHERE id = ?1').bind(userId).first();
    if (!user) return jsonResponse({ error: '用户不存在' }, 404);
    return jsonResponse(user);
}

export async function handlePushSubscribe(request, db) {
    const token = extractSessionToken(request);
    if (!token) return jsonResponse({ error: '未提供登录凭证' }, 401);
    const session = await resolveSession(db, token);
    if (!session || !session.user_id) {
        return jsonResponse({ error: '无效或过期的会话' }, 401);
    }

    const sub = await request.json();
    if (!sub || !sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
        return jsonResponse({ error: '订阅数据不完整' }, 400);
    }

    await db.prepare('INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id, endpoint) DO UPDATE SET updated_at = CURRENT_TIMESTAMP')
        .bind(session.user_id, sub.endpoint, sub.keys.p256dh, sub.keys.auth)
        .run();

    return jsonResponse({ success: true }, 200);
}

export async function cleanExpiredSessions(db) {
    const res = await db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(Date.now()).run();
    return res.meta?.changes || 0;
}
