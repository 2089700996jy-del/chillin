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
    const selectSql = 'SELECT token, user_id, expires_at FROM sessions WHERE token = ?1 AND expires_at > ?2';

    let row = await db.prepare(selectSql).bind(hashed, Date.now()).first();
    if (!row) {
        // 防范 D1 主从节点边缘同步延迟：极快连续请求如果初次未查到，微秒级重试一次
        await new Promise(r => setTimeout(r, 60));
        row = await db.prepare(selectSql).bind(hashed, Date.now()).first();
    }
    if (row) return row;

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
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
        .bind(await tokenHash(token), userId, expiresAt).run();

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
    await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
        .bind(await tokenHash(token), user.id, expiresAt).run();

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
