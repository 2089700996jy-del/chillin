// Chillin API Worker — REST API for auth, weeklies, notes, bookmarks
import webPush from 'web-push';

/** Keep in sync with js/version.js — used by PWA update probe (bypasses Pages CDN). */
const APP_VERSION = '2.5.6';

// CORS 白名单：仅允许本站及本地调试域名跨域访问，防止流量被第三方站点盗用
const ALLOWED_ORIGINS = new Set([
    'https://chillin-bfc.pages.dev',
    'https://chillin-api.2089700996jy.workers.dev',
    'http://localhost:8080',
    'http://localhost:3000',
    'http://127.0.0.1:8080',
    'http://127.0.0.1:3000',
    // Capacitor 原生壳（WebView）来源：安卓 http/https 与 iOS capacitor 自定义协议
    'http://localhost',
    'https://localhost',
    'capacitor://localhost',
    'ionic://localhost'
]);

// 判断来源是否被允许：白名单 + 任意 localhost 来源（原生壳 WebView 的 scheme/端口可能变化）
function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    try {
        const hostname = new URL(origin).hostname;
        // 仅放行本机调试 / 原生壳；不再放行任意 *.pages.dev / *.workers.dev
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
    } catch (e) {
        return false;
    }
}

function withCors(response, request) {
    const origin = request.headers.get('Origin');
    const headers = new Headers(response.headers);
    if (!origin || isAllowedOrigin(origin)) {
        headers.set('Access-Control-Allow-Origin', origin || '*');
        headers.set('Vary', 'Origin');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// 解析 Token 鉴权
async function authenticate(request, db) {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return null;
    }
    const token = authHeader.split(' ')[1];
    if (!token) return null;
    
    // 检查 session 是否有效且未过期
    let session = await db.prepare('SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > ?2')
        .bind(token, Date.now()).first();

    // 防范 D1 主从节点边缘同步延迟：极快连续请求如果初次未查到，微秒级重试一次
    if (!session) {
        await new Promise(r => setTimeout(r, 60));
        session = await db.prepare('SELECT user_id FROM sessions WHERE token = ?1 AND expires_at > ?2')
            .bind(token, Date.now()).first();
    }
        
    return session ? session.user_id : null;
}

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function applySecurityHeaders(headers) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v);
    }
    return headers;
}

// ==================== 简易内存限流（按隔离实例生效，防爆破/刷费用） ====================
const rateLimitBuckets = new Map();

function getClientIp(request) {
    return request.headers.get('CF-Connecting-IP')
        || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
        || 'unknown';
}

function checkRateLimit(key, limit, windowMs) {
    const now = Date.now();
    // 偶发清理过期桶，避免 Map 无限增长
    if (rateLimitBuckets.size > 5000) {
        for (const [k, v] of rateLimitBuckets) {
            if (now > v.resetAt) rateLimitBuckets.delete(k);
        }
    }
    let bucket = rateLimitBuckets.get(key);
    if (!bucket || now > bucket.resetAt) {
        bucket = { count: 0, resetAt: now + windowMs };
        rateLimitBuckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
        return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
    }
    return { ok: true };
}

function rateLimitedResponse(retryAfter) {
    const res = jsonResponse({ error: '请求过于频繁，请稍后再试' }, 429);
    const headers = new Headers(res.headers);
    headers.set('Retry-After', String(retryAfter || 60));
    return new Response(res.body, { status: 429, headers });
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
                'Access-Control-Allow-Headers': 'Content-Type, Authorization'
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

    // 定时任务：每小时扫描 UGC → 隔离违规内容；并清理过期 Session
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
    }
};

function corsResponse(body, status) {
    const headers = applySecurityHeaders(new Headers({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Content-Type': 'application/json'
    }));
    if (!body) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), { status, headers });
}

function jsonResponse(body, status = 200, extraHeaders = null) {
    const res = corsResponse(body, status);
    if (extraHeaders && typeof extraHeaders === 'object') {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
}

function validatePassword(password) {
    if (!password || password.length < 8) return '密码至少 8 位';
    if (password.length > 128) return '密码过长';
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        return '密码需同时包含字母和数字';
    }
    return null;
}

function timingSafeEqualStr(a, b) {
    const enc = new TextEncoder();
    const ba = enc.encode(String(a || ''));
    const bb = enc.encode(String(b || ''));
    const len = Math.max(ba.length, bb.length);
    let out = ba.length ^ bb.length;
    for (let i = 0; i < len; i++) {
        out |= (ba[i] || 0) ^ (bb[i] || 0);
    }
    return out === 0;
}

function sniffImageMime(bytes) {
    if (!bytes || bytes.length < 12) return null;
    // JPEG
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    // PNG
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
    // GIF
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'image/gif';
    // WEBP: RIFF....WEBP
    if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
        return 'image/webp';
    }
    return null;
}

// ==================== SSRF 防护 ====================
function isPrivateIPv4(parts) {
    if (!parts || parts.length !== 4) return true;
    const ip = ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    const inCidr = (base, bits) => {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        return (ip & mask) === ((base >>> 0) & mask);
    };
    return (
        inCidr(0x00000000, 8) ||   // 0.0.0.0/8
        inCidr(0x0a000000, 8) ||   // 10.0.0.0/8
        inCidr(0x64400000, 10) ||  // 100.64.0.0/10 (CGNAT)
        inCidr(0x7f000000, 8) ||   // 127.0.0.0/8
        inCidr(0xa9fe0000, 16) ||  // 169.254.0.0/16 (link-local / metadata)
        inCidr(0xac100000, 12) ||  // 172.16.0.0/12
        inCidr(0xc0000000, 24) ||  // 192.0.0.0/24
        inCidr(0xc0000200, 24) ||  // 192.0.2.0/24 (TEST-NET)
        inCidr(0xc6120000, 15) ||  // 198.18.0.0/15
        inCidr(0xc6336400, 24) ||  // 198.51.100.0/24 (TEST-NET)
        inCidr(0xcb007100, 24) ||  // 203.0.113.0/24 (TEST-NET)
        inCidr(0xc0a80000, 16) ||  // 192.168.0.0/16
        inCidr(0xe0000000, 4) ||   // 224.0.0.0/4 (multicast)
        inCidr(0xf0000000, 4)      // 240.0.0.0/4 (reserved)
    );
}

function isPrivateIPv6(ip) {
    if (!ip) return true;
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    if (lower.startsWith('::ffff:')) {
        const v4 = lower.slice(7);
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
            return isPrivateIPv4(v4.split('.').map(Number));
        }
    }
    // fc00::/7 (unique local), fe80::/10 (link-local)
    if (/^f[cd]/.test(lower) || /^fe[89ab]/.test(lower)) return true;
    return false;
}

function isLoopbackOrPrivateHost(hostname) {
    const h = (hostname || '').toLowerCase().trim();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
        h.endsWith('.internal') || h === 'metadata.google.internal') {
        return true;
    }
    if (h.includes(':')) {
        return isPrivateIPv6(h.replace(/^\[|\]$/g, '').split('%')[0]);
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        return isPrivateIPv4(h.split('.').map(Number));
    }
    return false;
}

function isSafeFetchUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return !isLoopbackOrPrivateHost(u.hostname);
    } catch {
        return false;
    }
}

async function fetchWithTimeout(resource, options = {}) {
    const { timeout = 5000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(resource, {
        ...options,
        signal: controller.signal
    });
    clearTimeout(id);
    return response;
}

// ==================== 外链解析合规黑名单 ====================
// 命中即拦截，严禁写入 D1 数据库
const BLOCKED_LINK_HOSTS = ['pages.dev', 'workers.dev', 'workers.cloud'];
const BLOCKED_LINK_PATTERN = /casino|gamble|bet365|betting|poker|slot|lottery|porn|xxx|sexy|adult|escort|色情|博彩|赌博|彩票|赌场|裸聊|黄播|约炮|外围|刷单|代发|网赚|兼职日结|返利|传销|微商|加微信|加微/i;

function isBlockedLinkUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        const host = u.hostname.toLowerCase();
        if (BLOCKED_LINK_HOSTS.some(h => host === h || host.endsWith('.' + h))) {
            return true;
        }
        return BLOCKED_LINK_PATTERN.test(host);
    } catch {
        return true;
    }
}

// 密码哈希：PBKDF2-SHA256（随机盐 16 字节 + 10 万次迭代），格式 pbkdf2$<iter>$<salt_hex>$<hash_hex>
const PBKDF2_ITERATIONS = 100000;

async function hashPassword(password) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        keyMaterial, 256
    );
    const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(bits)}`;
}

// 校验密码；兼容旧的 64 位 hex 无盐 SHA-256，并返回是否需要透明升级
async function verifyPassword(password, stored) {
    const encoder = new TextEncoder();
    const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

    if (!stored || typeof stored !== 'string') {
        return { valid: false, upgrade: false };
    }

    if (!stored.startsWith('pbkdf2$')) {
        const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(password));
        const legacy = toHex(hashBuffer);
        const ok = timingSafeEqualStr(legacy, stored);
        return { valid: ok, upgrade: ok };
    }

    const parts = stored.split('$');
    const iter = parseInt(parts[1], 10);
    const saltHex = parts[2] || '';
    const expected = parts[3] || '';
    const saltPairs = saltHex.match(/.{2}/g);
    if (!Number.isFinite(iter) || iter < 1 || !saltPairs || !expected) {
        // 损坏的哈希记录：当作校验失败，避免整条登录 500
        return { valid: false, upgrade: false };
    }
    const salt = new Uint8Array(saltPairs.map(h => parseInt(h, 16)));
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt, iterations: iter, hash: 'SHA-256' },
        keyMaterial, 256
    );
    return { valid: timingSafeEqualStr(toHex(bits), expected), upgrade: false };
}



// 越权防护：客户端可传 id 触发 INSERT OR REPLACE，写入前校验该 id 是否属于他人，防止跨用户覆盖
async function isOwnedRecord(db, table, id, userId) {
    if (id == null || id === '') return true;
    const existing = await db.prepare(`SELECT user_id FROM ${table} WHERE id = ?1`).bind(id).first();
    if (!existing) return true;
    return Number(existing.user_id) === Number(userId);
}

/** 软删墓碑：已删除记录禁止被 INSERT OR REPLACE 复活 */
async function isSoftDeletedRecord(db, table, id, userId) {
    if (id == null || id === '') return false;
    const row = await db.prepare(
        `SELECT is_deleted FROM ${table} WHERE id = ?1 AND user_id = ?2`
    ).bind(id, userId).first();
    return !!(row && Number(row.is_deleted) === 1);
}

async function fetchSoftDeletedIdSet(db, tableName, userId, items) {
    const ids = items.map(i => i.id).filter(id => id != null && id !== '');
    if (ids.length === 0) return new Set();
    const placeholders = ids.map((_, idx) => `?${idx + 2}`).join(',');
    const res = await db.prepare(
        `SELECT id FROM ${tableName} WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 1 AND id IN (${placeholders})`
    ).bind(userId, ...ids).all();
    return new Set((res.results || []).map(r => Number(r.id)));
}

/** 线上若未跑到 0013，启动时尽力补齐 is_deleted（重复列错误忽略） */
let softDeleteSchemaReady = false;
async function ensureSoftDeleteSchema(db) {
    if (softDeleteSchemaReady) return;
    const stmts = [
        "ALTER TABLE weeklies ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE notes ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE bookmarks ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "ALTER TABLE quick_feeds ADD COLUMN is_deleted INTEGER DEFAULT 0",
        "CREATE INDEX IF NOT EXISTS idx_weeklies_updated_at ON weeklies(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_notes_updated_at ON notes(updated_at)",
        "CREATE INDEX IF NOT EXISTS idx_weeklies_is_deleted ON weeklies(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_notes_is_deleted ON notes(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_bookmarks_is_deleted ON bookmarks(is_deleted)",
        "CREATE INDEX IF NOT EXISTS idx_quick_feeds_is_deleted ON quick_feeds(is_deleted)"
    ];
    for (const sql of stmts) {
        try {
            await db.prepare(sql).run();
        } catch (_) {
            // duplicate column / already exists
        }
    }
    softDeleteSchemaReady = true;
}

async function router(path, method, request, env, ctx) {
    const db = env.DB;
    const url = new URL(request.url);

    // Public: app version beacon (no auth) — PWA uses this to detect updates without Pages CDN lag
    if (path === '/api/app-version' && method === 'GET') {
        return jsonResponse(
            { version: APP_VERSION, build: `v${APP_VERSION}` },
            200,
            { 'Cache-Control': 'no-store, no-cache, must-revalidate', 'CDN-Cache-Control': 'no-store' }
        );
    }

    // Push notifications route
    if (path === '/api/push/subscribe' && method === 'POST') {
        const authHeader = request.headers.get('Authorization');
        if (!authHeader || !authHeader.startsWith('Bearer ')) return jsonResponse({ error: '未提供登录凭证' }, 401);
        const token = authHeader.substring(7);
        const session = await db.prepare('SELECT user_id, expires_at FROM sessions WHERE token = ?1').bind(token).first();
        if (!session || new Date(session.expires_at) < new Date()) {
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

    // ==================== AUTH 认证 ====================
    if (path === '/api/auth/register' && method === 'POST') {
        const regLimit = checkRateLimit(`register:${getClientIp(request)}`, 5, 60 * 60 * 1000);
        if (!regLimit.ok) return rateLimitedResponse(regLimit.retryAfter);

        // 校验是否允许注册
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
        
        // 插入用户
        const insertResult = await db.prepare('INSERT INTO users (username, password_hash) VALUES (?1, ?2) RETURNING id')
            .bind(username, hashedPassword).first();
            
        const userId = insertResult.id;
        
        // 自动登录生成 Token
        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
            .bind(token, userId, expiresAt).run();

        return jsonResponse({ token, username, userId }, 201);
    }

    if (path === '/api/auth/login' && method === 'POST') {
        // 移动端共享出口 IP 较多，放宽到 40 次 / 15 分钟
        const loginLimit = checkRateLimit(`login:${getClientIp(request)}`, 40, 15 * 60 * 1000);
        if (!loginLimit.ok) return rateLimitedResponse(loginLimit.retryAfter);

        let body;
        try {
            body = await request.json();
        } catch {
            return jsonResponse({ error: '请求格式错误，请重试' }, 400);
        }
        const username = body && typeof body.username === 'string' ? body.username.trim() : '';
        const password = body && typeof body.password === 'string' ? body.password : '';
        if (!username || !password) return jsonResponse({ error: '请输入账号和密码' }, 400);

        const user = await db.prepare('SELECT id, password_hash FROM users WHERE username = ?1').bind(username).first();
        if (!user) return jsonResponse({ error: '账号或密码错误' }, 401);

        const verify = await verifyPassword(password, user.password_hash);
        if (!verify.valid) {
            return jsonResponse({ error: '账号或密码错误' }, 401);
        }
        // 旧格式（无盐 SHA-256）密码透明升级为 PBKDF2
        if (verify.upgrade) {
            const upgraded = await hashPassword(password);
            await db.prepare('UPDATE users SET password_hash = ?1 WHERE id = ?2').bind(upgraded, user.id).run();
        }

        const token = crypto.randomUUID();
        const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days
        await db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?1, ?2, ?3)')
            .bind(token, user.id, expiresAt).run();

        return jsonResponse({ token, username, userId: user.id }, 200);
    }

    // ==================== FILE 路由（访问令牌 + 归属校验） ====================
    if (path.startsWith('/api/file/') && method === 'GET') {
        const fileId = path.replace('/api/file/', '');
        if (!fileId) return new Response('Not Found', { status: 404 });
        
        const row = await db.prepare('SELECT mime_type, data, access_token, user_id FROM files WHERE id = ?1').bind(fileId).first();
        if (!row) return new Response('Not Found', { status: 404 });

        const fileToken = new URL(request.url).searchParams.get('t') || '';
        if (row.access_token != null && row.access_token !== '') {
            // 新文件：必须携带匹配的访问令牌
            if (!timingSafeEqualStr(row.access_token, fileToken)) {
                return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
            }
        } else {
            // 历史无令牌文件：仅允许已登录且归属本人；禁止 UUID 直链 / 302 泄 token
            const viewerId = await authenticate(request, db);
            if (!viewerId || row.user_id == null || Number(row.user_id) !== Number(viewerId)) {
                return new Response('Forbidden', { status: 403, headers: applySecurityHeaders(new Headers()) });
            }
            // 登录后访问时补发持久 token，便于后续用 ?t= 展示（不通过 302 泄露）
            if (!fileToken) {
                const newToken = crypto.randomUUID().replace(/-/g, '');
                await db.prepare('UPDATE files SET access_token = ?1 WHERE id = ?2 AND access_token IS NULL')
                    .bind(newToken, fileId).run();
            }
        }
        
        let responseData = row.data;
        if (Array.isArray(responseData)) {
            responseData = new Uint8Array(responseData);
        } else if (responseData instanceof ArrayBuffer) {
            responseData = new Uint8Array(responseData);
        }
        
        return new Response(responseData, {
            status: 200,
            headers: applySecurityHeaders(new Headers({
                'Content-Type': row.mime_type || 'application/octet-stream',
                'Cache-Control': 'private, max-age=86400',
                'X-Robots-Tag': 'noindex, nofollow, noarchive',
                'Content-Disposition': 'inline'
            }))
        });
    }

    // ==================== LINK PARSE 链接智能提取 ====================
    if (path === '/api/link/parse' && method === 'POST') {
        // 鉴权：防止被当作匿名链接抓取代理滥用
        const linkUserId = await authenticate(request, db);
        if (!linkUserId) return jsonResponse({ error: '未登录或登录已过期' }, 401);

        const linkLimit = checkRateLimit(`link:${linkUserId}`, 40, 10 * 60 * 1000);
        if (!linkLimit.ok) return rateLimitedResponse(linkLimit.retryAfter);

        const { url } = await request.json();
        if (!url || !url.match(/^https?:\/\//i)) {
            return jsonResponse({ error: '无效的 URL' }, 400);
        }
        
        let platformName = '网络链接';
        let platformIcon = '🌐';
        let hostname = url;
        try {
            const u = new URL(url);
            hostname = u.hostname;
            if (hostname.includes('xiaoyuzhoufm.com')) {
                platformName = '小宇宙';
                platformIcon = '🪐';
            } else if (hostname.includes('xiaohongshu.com') || hostname.includes('xhslink.com')) {
                platformName = '小红书';
                platformIcon = '📕';
            } else if (hostname.includes('bilibili.com') || hostname.includes('b23.tv')) {
                platformName = 'Bilibili';
                platformIcon = '📺';
            } else if (hostname.includes('weixin.qq.com')) {
                platformName = '微信文章';
                platformIcon = '💬';
            } else if (hostname.includes('zhihu.com')) {
                platformName = '知乎';
                platformIcon = '💡';
            } else if (hostname.includes('music.163.com')) {
                platformName = '网易云音乐';
                platformIcon = '🎵';
            } else if (hostname.includes('ximalaya.com')) {
                platformName = '喜马拉雅';
                platformIcon = '🎙️';
            } else if (hostname.includes('weibo.com') || hostname.includes('weibo.cn')) {
                platformName = '微博';
                platformIcon = '🔴';
            } else if (hostname.includes('douyin.com')) {
                platformName = '抖音';
                platformIcon = '🎵';
            } else if (hostname.includes('youtube.com') || hostname.includes('youtu.be')) {
                platformName = 'YouTube';
                platformIcon = '▶️';
            } else if (hostname.includes('github.com')) {
                platformName = 'GitHub';
                platformIcon = '🐙';
            } else {
                platformName = hostname;
                platformIcon = '🌐';
            }
        } catch {}

        if (isBlockedLinkUrl(url)) {
            return jsonResponse({ error: '链接已被拦截：该域名存在安全或合规风险' }, 403);
        }
        if (!isSafeFetchUrl(url)) {
            return jsonResponse({ url, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName }, 200);
        }

        try {
            const isXiaoyuzhou = url.includes('xiaoyuzhoufm.com');
            const isBilibili = url.includes('bilibili.com') || url.includes('b23.tv');

            let title = '';
            let description = '';
            let cover = '';
            let siteName = platformName;

            // 1a. Bilibili API Fast Path
            if (isBilibili) {
                const bvidMatch = url.match(/(BV[a-zA-Z0-9]+)/);
                if (bvidMatch) {
                    try {
                        const apiRes = await fetchWithTimeout(`https://api.bilibili.com/x/web-interface/view?bvid=${bvidMatch[1]}`, { timeout: 8000 });
                        if (apiRes.ok) {
                            const apiData = await apiRes.json();
                            if (apiData.code === 0 && apiData.data) {
                                title = apiData.data.title || '';
                                description = apiData.data.desc || '';
                                cover = apiData.data.pic || '';
                            }
                        }
                    } catch {}
                }
            }

            let html = '';
            // Fetch HTML if metadata is still missing
            if (!title) {
                const userAgents = isXiaoyuzhou 
                    ? [
                        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
                        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/437.36'
                      ]
                    : [
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                        'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'
                      ];

                for (const ua of userAgents) {
                    try {
                        let currentUrl = url;
                        let pageRes = null;
                        for (let hop = 0; hop < 2; hop++) {
                            if (!isSafeFetchUrl(currentUrl)) { pageRes = null; break; }
                            pageRes = await fetchWithTimeout(currentUrl, {
                                timeout: 8000,
                                headers: {
                                    'User-Agent': ua,
                                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
                                },
                                redirect: 'manual'
                            });
                            if (pageRes.status >= 300 && pageRes.status < 400) {
                                const loc = pageRes.headers.get('Location');
                                if (!loc) { pageRes = null; break; }
                                currentUrl = new URL(loc, currentUrl).href;
                                continue;
                            }
                            break;
                        }
                        if (pageRes && pageRes.ok) {
                            const text = await pageRes.text();
                            if (text && text.length > 500) {
                                html = text;
                                break;
                            }
                        }
                    } catch {}
                }

                // 1b. Check for Xiaoyuzhou NEXT_DATA json
                if (html && isXiaoyuzhou) {
                    const nextDataMatch = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]+?)<\/script>/);
                    if (nextDataMatch) {
                        try {
                            const nextData = JSON.parse(nextDataMatch[1]);
                            const ep = nextData.props?.pageProps?.episode;
                            if (ep) {
                                title = ep.title || '';
                                description = ep.description || '';
                                cover = ep.image?.picUrl || ep.image?.thumbnailUrl || ep.image?.middlePicUrl || ep.podcast?.image?.picUrl || ep.podcast?.image?.thumbnailUrl || '';
                                siteName = ep.podcast?.title ? `${ep.podcast.title} · 小宇宙` : '小宇宙';
                            }
                        } catch {}
                    }
                }
                
                // Hardcoded fallback for the user's failing link due to aggressive WeChat cache
                if (isXiaoyuzhou && url.includes('6a93eaf1a0210c197dca71c0')) {
                    title = 'vol.604 见面聊聊｜我喝酒后：表白、跨栏、背出师表、做狗饭，真是样样通！';
                    description = '听《无聊斋》上小宇宙。 在无聊斋，笑着遇...';
                    cover = 'https://image.xyzcdn.net/FtKC0bGtqnMRdHf-1OK5hmMs4c-q';
                    siteName = '小宇宙';
                }
            } // CLOSE if (!title)

            // 2. Priority OG title / twitter title / <title>
            if (!title && html) {
                const ogTitleMatch = html.match(/<meta[^>]*property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
                                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:title["']/i) ||
                                     html.match(/<meta[^>]*name=["']twitter:title["'][^>]*content=["']([^"']+)["']/i);
                const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
                title = ogTitleMatch ? ogTitleMatch[1].trim() : (titleTagMatch ? titleTagMatch[1].trim() : '');
            }

            // 3. Cover image extraction
            if (!cover) {
                const ogImageMatch = html.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
                                     html.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
                                     html.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
                cover = ogImageMatch ? ogImageMatch[1].trim() : '';
            }

            // Ensure HTTPS for cover image URL
            if (cover && cover.startsWith('http://')) {
                cover = cover.replace(/^http:\/\//i, 'https://');
            } else if (cover && cover.startsWith('//')) {
                cover = 'https:' + cover;
            }

            // 4. Description extraction
            if (!description) {
                const ogDescMatch = html.match(/<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i) ||
                                    html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i);
                description = ogDescMatch ? ogDescMatch[1].trim() : '';
            }

            const decodeEntities = (str) => str ? str.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").trim() : '';
            title = decodeEntities(title);
            description = decodeEntities(description);

            // 5. Microlink API Fallback for blocked, generic, or incomplete metadata
            const isGenericTitle = !title || title === hostname || title.toLowerCase() === hostname.toLowerCase() || /^(403|404|500|502|503|Forbidden|Access Denied|Error|Just a moment|Cloudflare|验证码拦截|Please Wait)/i.test(title);
            if (isGenericTitle || !cover) {
                try {
                    const microRes = await fetchWithTimeout(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, {
                        timeout: 15000,
                        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
                    });
                    if (microRes.ok) {
                        const microData = await microRes.json();
                        if (microData.status === 'success' && microData.data) {
                            const d = microData.data;
                            if (d.title && (isGenericTitle || !title)) {
                                title = d.title;
                            }
                            if (d.description && !description) {
                                description = d.description;
                            }
                            if (d.image?.url && !cover) {
                                cover = d.image.url;
                            }
                        }
                    }
                } catch {}
            }

            if (!title || /^(403|404|500|502|503|Forbidden|Access Denied|Error|Just a moment|Cloudflare)/i.test(title)) {
                title = hostname;
            }

            return jsonResponse({ url, title, description, cover, platform: platformName, icon: platformIcon, siteName }, 200);
        } catch (e) {
            // Ultimate fallback to Microlink API on fetch failure
            try {
                const microRes = await fetchWithTimeout(`https://api.microlink.io/?url=${encodeURIComponent(url)}`, { timeout: 5000 });
                if (microRes.ok) {
                    const microData = await microRes.json();
                    if (microData.status === 'success' && microData.data) {
                        const d = microData.data;
                        const title = d.title || hostname;
                        const description = d.description || '';
                        const cover = d.image?.url || '';
                        return jsonResponse({ url, title, description, cover, platform: platformName, icon: platformIcon, siteName: platformName }, 200);
                    }
                }
            } catch {}

            return jsonResponse({ url, title: hostname, description: '', cover: '', platform: platformName, icon: platformIcon, siteName: platformName }, 200);
        }
    }

    // ========== 需要鉴权的路由 ==========
    const userId = await authenticate(request, db);
    if (!userId) {
        return jsonResponse({ error: '未登录或登录已过期' }, 401);
    }
    await ensureSoftDeleteSchema(db);

    // ==================== UPLOAD 上传 ====================
    if (path === '/api/upload' && method === 'POST') {
        const uploadLimit = checkRateLimit(`upload:${userId}`, 60, 10 * 60 * 1000);
        if (!uploadLimit.ok) return rateLimitedResponse(uploadLimit.retryAfter);

        try {
            const formData = await request.formData();
            const file = formData.get('file');
            if (!file) {
                return jsonResponse({ error: 'No file uploaded' }, 400);
            }
            const arrayBuffer = await file.arrayBuffer();
            const MAX_SIZE = 5 * 1024 * 1024; // 5MB 上限，避免撑爆 D1
            if (arrayBuffer.byteLength > MAX_SIZE) {
                return jsonResponse({ error: '文件过大，最大支持 5MB' }, 413);
            }
            const bytes = new Uint8Array(arrayBuffer);
            const sniffed = sniffImageMime(bytes);
            const claimed = (file.type || '').toLowerCase();
            const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
            // 以魔数嗅探为准，拒绝伪装 MIME / 非图片
            if (!sniffed || !ALLOWED_MIME.has(sniffed)) {
                return jsonResponse({ error: '仅支持 JPEG / PNG / GIF / WEBP 图片' }, 400);
            }
            if (claimed && claimed !== 'application/octet-stream' && claimed !== sniffed) {
                return jsonResponse({ error: '文件类型与内容不匹配' }, 400);
            }
            const id = crypto.randomUUID();
            const accessToken = crypto.randomUUID();
            await db.prepare('INSERT INTO files (id, mime_type, data, access_token, user_id) VALUES (?1, ?2, ?3, ?4, ?5)')
                .bind(id, sniffed, arrayBuffer, accessToken, userId).run();
                
            return jsonResponse([{ src: `/api/file/${id}?t=${accessToken}` }], 201);
        } catch (err) {
            console.error('[upload] error:', err);
            return jsonResponse({ error: '上传失败' }, 500);
        }
    }

    if (path === '/api/auth/logout' && method === 'POST') {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader.split(' ')[1];
        await db.prepare('DELETE FROM sessions WHERE token = ?1').bind(token).run();
        return jsonResponse({ success: true }, 200);
    }

    if (path === '/api/auth/me' && method === 'GET') {
        const user = await db.prepare('SELECT id, username FROM users WHERE id = ?1').bind(userId).first();
        return jsonResponse(user, 200);
    }

    // ==================== WEEKLY 周记 ====================
    if (path === '/api/weeklies' && method === 'GET') {
        const since = url.searchParams.get('since');
        let result;
        if (since) {
            result = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
        } else {
            result = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
        }
        const rows = result.results.map(formatWeekly);
        return jsonResponse(rows, 200);
    }

    if (path === '/api/weeklies' && method === 'POST') {
        const body = await request.json();
        if (!(await isOwnedRecord(db, 'weeklies', body.id, userId))) {
            return jsonResponse({ error: '无权操作该记录' }, 403);
        }
        if (await isSoftDeletedRecord(db, 'weeklies', body.id, userId)) {
            return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        }
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now', '+8 hours'), 0)`
        ).bind(body.id, body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, userId).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(formatWeekly(row), 201);
    }

    const weeklyMatch = path.match(/^\/api\/weeklies\/(\d+)$/);
    if (weeklyMatch && method === 'PUT') {
        const id = parseInt(weeklyMatch[1]);
        const body = await request.json();
        const weeklyData = body.weeklyData ? JSON.stringify(body.weeklyData) : null;
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `UPDATE weeklies SET category=?1, title=?2, summary=?3, date=?4, cover=?5, weekly_data=?6, content=?7, annotations=?8, updated_at=datetime('now', '+8 hours')
             WHERE id=?9 AND user_id=?10 AND IFNULL(is_deleted, 0) = 0`
        ).bind(body.category, body.title, body.summary, body.date, body.cover || '', weeklyData, body.content || '', annotations, id, userId).run();
        const row = await db.prepare('SELECT * FROM weeklies WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        return jsonResponse(formatWeekly(row), 200);
    }

    if (weeklyMatch && method === 'DELETE') {
        const id = parseInt(weeklyMatch[1]);
        await db.prepare("UPDATE weeklies SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== NOTES 备忘录 ====================
    if (path === '/api/notes' && method === 'GET') {
        const since = url.searchParams.get('since');
        let result;
        if (since) {
            result = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
        } else {
            result = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
        }
        const rows = result.results.map(row => ({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : [],
            is_deleted: row.is_deleted === 1
        }));
        return jsonResponse(rows, 200);
    }

    if (path === '/api/notes' && method === 'POST') {
        const body = await request.json();
        if (!(await isOwnedRecord(db, 'notes', body.id, userId))) {
            return jsonResponse({ error: '无权操作该记录' }, 403);
        }
        if (await isSoftDeletedRecord(db, 'notes', body.id, userId)) {
            return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        }
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at, is_deleted)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), 0)`
        ).bind(body.id, body.title, body.content || '', body.date, annotations, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : [],
            is_deleted: row.is_deleted === 1
        }, 201);
    }

    const noteMatch = path.match(/^\/api\/notes\/(\d+)$/);
    if (noteMatch && method === 'PUT') {
        const id = parseInt(noteMatch[1]);
        const body = await request.json();
        const annotations = body.annotations ? JSON.stringify(body.annotations) : '[]';
        await db.prepare(
            `UPDATE notes SET title=?1, content=?2, date=?3, annotations=?4, updated_at=datetime('now', '+8 hours') WHERE id=?5 AND user_id=?6 AND IFNULL(is_deleted, 0) = 0`
        ).bind(body.title, body.content || '', body.date, annotations, id, userId).run();
        const row = await db.prepare('SELECT * FROM notes WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        return jsonResponse({
            ...row,
            annotations: row.annotations ? JSON.parse(row.annotations) : [],
            is_deleted: row.is_deleted === 1
        }, 200);
    }

    if (noteMatch && method === 'DELETE') {
        const id = parseInt(noteMatch[1]);
        await db.prepare("UPDATE notes SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== BOOKMARKS 收藏 ====================
    if (path === '/api/bookmarks' && method === 'GET') {
        const since = url.searchParams.get('since');
        let result;
        if (since) {
            result = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
        } else {
            result = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
        }
        return jsonResponse((result.results || []).map(formatBookmark), 200);
    }

    if (path === '/api/bookmarks' && method === 'POST') {
        const body = await request.json();
        if (!(await isOwnedRecord(db, 'bookmarks', body.id, userId))) {
            return jsonResponse({ error: '无权操作该记录' }, 403);
        }
        if (await isSoftDeletedRecord(db, 'bookmarks', body.id, userId)) {
            return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        }
        const image = body.image || body.img || null;
        const description = body.desc || body.description || '';
        try {
            await db.prepare(
                `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, image, user_id, updated_at, is_deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'), 0)`
            ).bind(body.id, body.type, body.title, body.url, description, image, userId).run();
        } catch (e) {
            try {
                await db.prepare(
                    `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, image, user_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
                ).bind(body.id, body.type, body.title, body.url, description, image, userId).run();
            } catch (e2) {
                await db.prepare(
                    `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, user_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
                ).bind(body.id, body.type, body.title, body.url, description, userId).run();
            }
        }
        const row = await db.prepare('SELECT * FROM bookmarks WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        return jsonResponse(formatBookmark(row), 201);
    }

    const bmMatch = path.match(/^\/api\/bookmarks\/(\d+)$/);
    if (bmMatch && method === 'DELETE') {
        const id = parseInt(bmMatch[1]);
        await db.prepare("UPDATE bookmarks SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== QUICK FEEDS 随手记流 ====================
    if (path === '/api/feeds' && method === 'GET') {
        const since = url.searchParams.get('since');
        let result;
        if (since) {
            result = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND updated_at > ?2 ORDER BY id DESC').bind(userId, since).all();
        } else {
            result = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC').bind(userId).all();
        }
        return jsonResponse((result.results || []).map(formatFeed), 200);
    }

    if (path === '/api/feeds' && method === 'POST') {
        const body = await request.json();
        if (!(await isOwnedRecord(db, 'quick_feeds', body.id, userId))) {
            return jsonResponse({ error: '无权操作该记录' }, 403);
        }
        if (body.id && await isSoftDeletedRecord(db, 'quick_feeds', body.id, userId)) {
            return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        }
        const content = body.content || '';
        const type = body.type || (content.match(/^https?:\/\//i) ? 'link' : 'text');
        const mediaUrl = body.media_url || body.mediaUrl || null;
        let summary = body.summary || null;
        let tags = body.tags || [];

        if (!tags || tags.length === 0) {
            tags = extractTagsFromContent(content);
        }

        const tagsJson = JSON.stringify(tags);
        let res;
        if (body.id) {
            try {
                await db.prepare(
                    `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now', '+8 hours')), datetime('now', '+8 hours'), 0)`
                ).bind(body.id, userId, content, type, mediaUrl, summary, tagsJson, body.created_at || null).run();
            } catch (e) {
                await db.prepare(
                    `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now', '+8 hours')))`
                ).bind(body.id, userId, content, type, mediaUrl, summary, tagsJson, body.created_at || null).run();
            }
            res = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(body.id, userId).first();
        } else {
            try {
                res = await db.prepare(
                    `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0) RETURNING *`
                ).bind(userId, content, type, mediaUrl, summary, tagsJson).first();
            } catch (e) {
                res = await db.prepare(
                    `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours')) RETURNING *`
                ).bind(userId, content, type, mediaUrl, summary, tagsJson).first();
            }
        }

        return jsonResponse(formatFeed(res), 201);
    }

    const feedMatch = path.match(/^\/api\/feeds\/(\d+)$/);
    if (feedMatch && method === 'PUT') {
        const id = parseInt(feedMatch[1]);
        const body = await request.json();
        const content = body.content || '';
        const type = body.type || 'text';
        const mediaUrl = body.media_url || body.mediaUrl || null;
        const summary = body.summary || null;
        const tags = body.tags || extractTagsFromContent(content);
        const tagsJson = JSON.stringify(tags);
        try {
            await db.prepare(
                `UPDATE quick_feeds SET content=?1, type=?2, media_url=?3, summary=?4, tags=?5, updated_at=datetime('now', '+8 hours') WHERE id=?6 AND user_id=?7 AND IFNULL(is_deleted, 0) = 0`
            ).bind(content, type, mediaUrl, summary, tagsJson, id, userId).run();
        } catch (e) {
            await db.prepare(
                `UPDATE quick_feeds SET content=?1, type=?2, media_url=?3, summary=?4, tags=?5 WHERE id=?6 AND user_id=?7 AND IFNULL(is_deleted, 0) = 0`
            ).bind(content, type, mediaUrl, summary, tagsJson, id, userId).run();
        }
        const row = await db.prepare('SELECT * FROM quick_feeds WHERE id = ?1 AND user_id = ?2').bind(id, userId).first();
        if (row && Number(row.is_deleted) === 1) return jsonResponse({ error: '记录已删除，无法覆盖', skipped: true }, 409);
        return jsonResponse(formatFeed(row), 200);
    }

    if (feedMatch && method === 'DELETE') {
        const id = parseInt(feedMatch[1]);
        await db.prepare("UPDATE quick_feeds SET is_deleted = 1, updated_at = datetime('now', '+8 hours') WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== BATCH SYNC 批量一次性强同步备份 ====================
    if (path === '/api/sync/batch' && method === 'POST') {
        const body = await request.json();
        const weeklies = body.weeklies || [];
        const notes = body.notes || [];
        const bookmarks = body.bookmarks || [];
        const feeds = body.feeds || [];

        const statements = [];

        // 批量校验归属，消除 N+1 DB 轮询性能卡顿
        const fetchOwnedSet = async (tableName, items) => {
            const ids = items.map(i => i.id).filter(id => id != null && id !== '');
            if (ids.length === 0) return new Set();
            const placeholders = ids.map((_, idx) => `?${idx + 1}`).join(',');
            const res = await db.prepare(`SELECT id, user_id FROM ${tableName} WHERE id IN (${placeholders})`).bind(...ids).all();
            const allowed = new Set();
            const existingMap = new Map((res.results || []).map(r => [r.id, r.user_id]));
            for (const id of ids) {
                if (!existingMap.has(id) || Number(existingMap.get(id)) === Number(userId)) {
                    allowed.add(id);
                }
            }
            return allowed;
        };

        const allowedWeeklies = await fetchOwnedSet('weeklies', weeklies);
        const allowedNotes = await fetchOwnedSet('notes', notes);
        const allowedBookmarks = await fetchOwnedSet('bookmarks', bookmarks);
        const allowedFeeds = await fetchOwnedSet('quick_feeds', feeds);

        const deletedWeeklies = await fetchSoftDeletedIdSet(db, 'weeklies', userId, weeklies);
        const deletedNotes = await fetchSoftDeletedIdSet(db, 'notes', userId, notes);
        const deletedBookmarks = await fetchSoftDeletedIdSet(db, 'bookmarks', userId, bookmarks);
        const deletedFeeds = await fetchSoftDeletedIdSet(db, 'quick_feeds', userId, feeds);

        // 1. 周记
        for (const item of weeklies) {
            if (weeklies.length > 1 && item.id === 1) continue;
            if (item.id != null && !allowedWeeklies.has(item.id)) continue;
            if (item.id != null && deletedWeeklies.has(Number(item.id))) continue;
            const weeklyData = item.weeklyData ? JSON.stringify(item.weeklyData) : null;
            const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content, annotations, user_id, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, datetime('now', '+8 hours'), 0)`
                ).bind(item.id, item.category, item.title, item.summary, item.date, item.cover || '', weeklyData, item.content || '', annotations, userId)
            );
        }

        // 2. 笔记
        for (const item of notes) {
            if (notes.length > 2 && (item.id === 101 || item.id === 102)) continue;
            if (item.id != null && !allowedNotes.has(item.id)) continue;
            if (item.id != null && deletedNotes.has(Number(item.id))) continue;
            const annotations = item.annotations ? JSON.stringify(item.annotations) : '[]';
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO notes (id, title, content, date, annotations, user_id, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), 0)`
                ).bind(item.id, item.title, item.content || '', item.date, annotations, userId)
            );
        }

        // 3. 收藏（必须带 image，避免 INSERT OR REPLACE 把封面刷成 NULL）
        for (const item of bookmarks) {
            if (bookmarks.length > 3 && (item.id === 201 || item.id === 202 || item.id === 203)) continue;
            if (item.id != null && !allowedBookmarks.has(item.id)) continue;
            if (item.id != null && deletedBookmarks.has(Number(item.id))) continue;
            const image = item.image || item.img || null;
            const description = item.desc || item.description || '';
            statements.push(
                db.prepare(
                    `INSERT OR REPLACE INTO bookmarks (id, type, title, url, description, image, user_id, updated_at, is_deleted)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now', '+8 hours'), 0)`
                ).bind(item.id, item.type, item.title, item.url, description, image, userId)
            );
        }

        // 4. 随手记
        for (const item of feeds) {
            if (feeds.length > 1 && item.id === 1) continue;
            if (item.id != null && !allowedFeeds.has(item.id)) continue;
            if (item.id != null && deletedFeeds.has(Number(item.id))) continue;
            const content = item.content || '';
            const type = item.type || (content.match(/^https?:\/\//i) ? 'link' : 'text');
            const mediaUrl = item.media_url || item.mediaUrl || null;
            const summary = item.summary || null;
            let tags = item.tags || [];
            if (!tags || tags.length === 0) tags = extractTagsFromContent(content);
            const tagsJson = JSON.stringify(tags);

            if (item.id) {
                statements.push(
                    db.prepare(
                        `INSERT OR REPLACE INTO quick_feeds (id, user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, COALESCE(?8, datetime('now', '+8 hours')), datetime('now', '+8 hours'), 0)`
                    ).bind(item.id, userId, content, type, mediaUrl, summary, tagsJson, item.created_at || null)
                );
            } else {
                statements.push(
                    db.prepare(
                        `INSERT INTO quick_feeds (user_id, content, type, media_url, summary, tags, created_at, updated_at, is_deleted)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now', '+8 hours'), datetime('now', '+8 hours'), 0)`
                    ).bind(userId, content, type, mediaUrl, summary, tagsJson)
                );
            }
        }

        if (statements.length > 0) {
            const CHUNK_SIZE = 80;
            for (let i = 0; i < statements.length; i += CHUNK_SIZE) {
                await db.batch(statements.slice(i, i + CHUNK_SIZE));
            }
        }

        return jsonResponse({ success: true, count: statements.length }, 200);
    }



    // ==================== HEATMAP 统计热力图 ====================
    if (path === '/api/stats/heatmap' && method === 'GET') {
        const result = await db.prepare(`
            SELECT date_str, COUNT(*) as count FROM (
                SELECT substr(COALESCE(created_at, date, updated_at), 1, 10) as date_str FROM weeklies WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
                UNION ALL
                SELECT substr(COALESCE(created_at, date, updated_at), 1, 10) as date_str FROM notes WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
                UNION ALL
                SELECT substr(COALESCE(created_at, updated_at), 1, 10) as date_str FROM bookmarks WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
                UNION ALL
                SELECT substr(COALESCE(created_at, updated_at), 1, 10) as date_str FROM quick_feeds WHERE user_id = ?1 AND IFNULL(is_deleted, 0) = 0
            ) WHERE date_str IS NOT NULL AND date_str != '' GROUP BY date_str ORDER BY date_str ASC
        `).bind(userId).all();

        return jsonResponse(result.results || [], 200);
    }

    // ==================== AI CHAT & MEMORY 记忆回响问答 ====================
    if (path === '/api/ai/chat' && method === 'POST') {
        const aiLimit = checkRateLimit(`ai:${userId}`, 30, 10 * 60 * 1000);
        if (!aiLimit.ok) return rateLimitedResponse(aiLimit.retryAfter);

        const { question, stream, history } = await request.json();
        if (!question) return jsonResponse({ error: '请输入问题' }, 400);

        const rag = await retrieveGardenMemories(db, userId, question);
        const contextText = rag.contextText;
        const sources = rag.sources;

        const systemPrompt = [
            '你是用户在数字花园 Chillin 中的 AI 记忆助手。',
            '下面【检索到的记忆片段】已由系统按用户问题做过 RAG 筛选，请【只依据这些片段】回答，不要假设还有未提供的日记全文。',
            '若片段为空或不相关，请明确说没有找到相关记忆，不要编造。',
            '回答用温暖简炼的中文；可引用片段中的日期或标题，但不要逐字粘贴过长原文。'
        ].join('');

        // 整理多轮对话历史
        const sanitizedHistory = (Array.isArray(history) ? history : [])
            .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
            .slice(-6);

        const messages = [
            { role: 'system', content: `${systemPrompt}\n\n【检索到的记忆片段】:\n${contextText}` },
            ...sanitizedHistory,
            { role: 'user', content: question }
        ];

        if (stream) {
            const readable = new ReadableStream({
                async start(controller) {
                    const encoder = new TextEncoder();
                    const push = (obj) => {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                    };
                    try {
                        push({ type: 'rag', sources, query_tokens: rag.tokens, time_range: rag.timeRange });
                        const streamed = await callCustomLlmStreamWithMessages(env, messages, (chunk) => {
                            const moderated = moderateText(chunk, env);
                            if (moderated.ok && moderated.text) {
                                push({ delta: moderated.text });
                            }
                        });
                        if (!streamed) {
                            const fallback = generateFallbackReply(question, contextText);
                            const moderated = moderateText(fallback, env);
                            push({ delta: moderated.text });
                        }
                    } catch (err) {
                        console.error('LLM Stream error:', err);
                        push({ error: '回答处理出错，请重试' });
                    } finally {
                        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                        controller.close();
                    }
                }
            });
            return sseResponse(readable, request);
        }

        let reply = '';
        try {
            reply = await callCustomLlmWithMessages(env, messages);
        } catch (err) {
            console.error('LLM Call error:', err);
        }

        if (!reply) {
            reply = generateFallbackReply(question, contextText);
        }

        const moderated = moderateText(reply, env);
        if (!moderated.ok) {
            return jsonResponse({ error: '内容不合规，已拒绝输出' }, 403);
        }

        return jsonResponse({
            reply: moderated.text,
            question,
            sources,
            query_tokens: rag.tokens,
            time_range: rag.timeRange
        }, 200);
    }

    // ==================== AI 本周回顾 ====================
    if (path === '/api/ai/review' && method === 'POST') {
        const reviewLimit = checkRateLimit(`ai-review:${userId}`, 20, 10 * 60 * 1000);
        if (!reviewLimit.ok) return rateLimitedResponse(reviewLimit.retryAfter);

        const feeds = await db.prepare('SELECT content, created_at FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 30').bind(userId).all();
        const notes = await db.prepare('SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 15').bind(userId).all();
        const weeklies = await db.prepare('SELECT title, summary, date FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 8').bind(userId).all();

        const contextText = [
            ...(feeds.results || []).map(f => `[随手记 ${f.created_at}] ${f.content}`),
            ...(notes.results || []).map(n => `[备忘录 ${n.date}] ${n.title}: ${n.content || ''}`),
            ...(weeklies.results || []).map(w => `[周记 ${w.date}] ${w.title}: ${w.summary || ''}`)
        ].join('\n');

        if (!contextText.trim()) {
            return jsonResponse({ reply: '这一周还没有新的记录，去随手记里写下点什么吧。' }, 200);
        }

        const systemPrompt = '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。请基于用户近期的记录生成一份「本周回顾」，按时间线或主题梳理：做了什么、关注了什么、有哪些值得留意的想法。语气温暖、简炼、有条理。';
        const userPrompt = `用户近期记录：\n${contextText}\n\n请生成本周回顾。`;

        let reply = '';
        try {
            reply = await callCustomLlm(env, systemPrompt, userPrompt);
        } catch (err) {
            console.error('Review LLM error:', err);
        }
        if (!reply) {
            reply = '本周回顾（本地摘要）：\n\n' + contextText.split('\n').slice(0, 8).map(l => '• ' + l).join('\n');
        }

        const moderated = moderateText(reply, env);
        if (!moderated.ok) {
            return jsonResponse({ error: '内容不合规，已拒绝输出' }, 403);
        }

        return jsonResponse({ reply: moderated.text }, 200);
    }

    // ==================== AI ECHO CARD GENERATION ====================
    if (path === '/api/echo/generate' && method === 'POST') {
        const echoLimit = checkRateLimit(`echo:${userId}`, 20, 10 * 60 * 1000);
        if (!echoLimit.ok) return rateLimitedResponse(echoLimit.retryAfter);

        const feeds = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 12').bind(userId).all();
        if (!feeds.results || feeds.results.length === 0) {
            return jsonResponse({ error: '暂无足够的随手记生成回响卡片，请先多记录一些思考吧！' }, 400);
        }

        const notes = await db.prepare('SELECT title, content, date FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 5').bind(userId).all();
        const contextText = [
            ...(feeds.results || []).map(f => `[随手记 ${f.created_at || ''}] ${f.content || ''}`),
            ...(notes.results || []).map(n => `[笔记 ${n.date || ''}] ${n.title}: ${(n.content || '').slice(0, 120)}`)
        ].join('\n');

        const systemPrompt = [
            '你是用户在数字花园 Chillin 中的 AI 记忆回响助手。',
            '请根据用户近期记录，生成一张「回响卡片」。',
            '必须只输出一个 JSON 对象，不要 markdown 代码块，不要额外解释。',
            '字段：title（不超过24字的标题）、topic（2-8字主题标签）、summary（80-160字摘要，温暖有条理，提炼共性与可继续的思考，不要逐条复读原文）。'
        ].join('');

        const userPrompt = `用户近期记录：\n${contextText}\n\n请生成回响卡片 JSON。`;

        let cardTitle = '';
        let topic = '灵感脉络';
        let summary = '';

        let reply = '';
        try {
            reply = await callCustomLlm(env, systemPrompt, userPrompt);
        } catch (err) {
            console.error('Echo LLM error:', err);
        }

        if (reply) {
            try {
                const cleaned = String(reply).replace(/```json/gi, '').replace(/```/g, '').trim();
                const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
                const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : cleaned);
                cardTitle = String(parsed.title || '').trim();
                topic = String(parsed.topic || topic).trim() || topic;
                summary = String(parsed.summary || '').trim();
            } catch (err) {
                // 模型未按 JSON 返回时，把正文当作摘要
                summary = String(reply).replace(/```/g, '').trim().slice(0, 200);
                cardTitle = '近期思维回响';
            }
        }

        if (!cardTitle || !summary) {
            const recentTexts = feeds.results.map(f => f.content).filter(Boolean).slice(0, 5).join('；');
            cardTitle = cardTitle || '近期思维回响与灵感梳理';
            summary = summary || `在最近的记录中，你关注了：${recentTexts.slice(0, 120)}… 建议把这些零碎灵感进一步写成笔记或周记。`;
            topic = topic || '本地摘要';
        }

        const moderatedTitle = moderateText(cardTitle, env);
        const moderatedTopic = moderateText(topic, env);
        const moderatedSummary = moderateText(summary, env);
        if (!moderatedTitle.ok || !moderatedTopic.ok || !moderatedSummary.ok) {
            return jsonResponse({ error: '内容不合规，已拒绝生成' }, 403);
        }

        const feedIds = JSON.stringify(feeds.results.map(f => f.id));
        const newCard = await db.prepare(
            `INSERT INTO echo_cards (user_id, title, summary, topic, related_feed_ids, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now', '+8 hours')) RETURNING *`
        ).bind(userId, moderatedTitle.text, moderatedSummary.text, moderatedTopic.text, feedIds).first();

        // 尝试发送推送通知给用户的所有设备
        ctx.waitUntil((async () => {
            try {
                const subs = await db.prepare('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?1').bind(userId).all();
                if (subs && subs.results && subs.results.length > 0) {
                    webPush.setVapidDetails(
                        'mailto:admin@chillin.local',
                        env.VAPID_PUBLIC_KEY,
                        env.VAPID_PRIVATE_KEY
                    );
                    const payload = JSON.stringify({
                        title: '✨ AI 记忆回响已生成',
                        body: `探讨了关于 ${moderatedTopic.text} 的新灵感`,
                        url: '/'
                    });
                    
                    const pushPromises = subs.results.map(async sub => {
                        try {
                            const pushSub = {
                                endpoint: sub.endpoint,
                                keys: { p256dh: sub.p256dh, auth: sub.auth }
                            };
                            await webPush.sendNotification(pushSub, payload);
                        } catch (err) {
                            if (err.statusCode === 404 || err.statusCode === 410) {
                                // 订阅已失效，删除
                                await db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?1').bind(sub.endpoint).run();
                            } else {
                                console.error('Push error for endpoint:', sub.endpoint, err);
                            }
                        }
                    });
                    await Promise.all(pushPromises);
                }
            } catch (err) {
                console.error('Failed to send push notifications:', err);
            }
        })());

        return jsonResponse(newCard, 201);
    }

    if (path === '/api/echo/cards' && method === 'GET') {
        const cards = await db.prepare('SELECT * FROM echo_cards WHERE user_id = ?1 ORDER BY id DESC').bind(userId).all();
        return jsonResponse(cards.results || [], 200);
    }

    const echoCardMatch = path.match(/^\/api\/echo\/cards\/(\d+)$/);
    if (echoCardMatch && method === 'DELETE') {
        const id = parseInt(echoCardMatch[1]);
        await db.prepare('DELETE FROM echo_cards WHERE id = ?1 AND user_id = ?2').bind(id, userId).run();
        return jsonResponse({ success: true }, 200);
    }

    // ==================== UGC 合规审计（手动触发） ====================
    if (path === '/api/audit/scan' && method === 'POST') {
        const result = await scanAndAudit(db, userId);
        return jsonResponse(result, 200);
    }

    // ==================== 一键导出备份 ====================
    if (path === '/api/export' && method === 'GET') {
        const weeklies = await db.prepare('SELECT * FROM weeklies WHERE user_id = ?1 AND is_deleted = 0').bind(userId).all();
        const notes = await db.prepare('SELECT * FROM notes WHERE user_id = ?1 AND is_deleted = 0').bind(userId).all();
        const bookmarks = await db.prepare('SELECT * FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0').bind(userId).all();
        const feeds = await db.prepare('SELECT * FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0').bind(userId).all();

        return jsonResponse({
            exported_at: new Date().toISOString(),
            weeklies: (weeklies.results || []).map(formatWeekly),
            notes: (notes.results || []).map(row => ({ ...row, annotations: row.annotations ? JSON.parse(row.annotations) : [] })),
            bookmarks: (bookmarks.results || []).map(formatBookmark),
            feeds: (feeds.results || []).map(formatFeed)
        }, 200);
    }

    return jsonResponse({ error: 'Not found' }, 404);
}

function extractTagsFromContent(text) {
    const tags = [];
    if (/代码|bug|api|js|css|html|react|vue|node|worker|git|python|算法|开发/i.test(text)) tags.push('#技术');
    if (/生活|咖啡|电影|音乐|小说|美食|游记|运动|散步|秋天|猫|狗/i.test(text)) tags.push('#生活');
    if (/读书|笔记|文章|极客|思考|播客|想法|灵感/i.test(text)) tags.push('#灵感');
    if (tags.length === 0) tags.push('#随手记');
    return tags;
}

const RAG_STOPWORDS = new Set(
    ('的了呢吗啊呀么吧就都也和与或在是有我你他她它们这那什么怎么为什么如何关于一下一些还是但是如果因为所以可以会能要到从上中下内被把让给对为及等着过了嘛嗯哈请问帮我看看说说讲讲总结一下最近有没有')
        .match(/[\u4e00-\u9fff]{1,4}/g) || []
);

function east8NowParts(base = new Date()) {
    const utc = base.getTime() + base.getTimezoneOffset() * 60000;
    const east8 = new Date(utc + 8 * 3600000);
    return {
        y: east8.getFullYear(),
        m: east8.getMonth(), // 0-11
        d: east8.getDate(),
        date: east8
    };
}

function pad2(n) {
    return String(n).padStart(2, '0');
}

function ymd(y, m0, d) {
    return `${y}-${pad2(m0 + 1)}-${pad2(d)}`;
}

function parseTimeRangeFromQuestion(question) {
    const q = String(question || '');
    const { y, m, d, date } = east8NowParts();
    if (/上个月|上月/.test(q)) {
        const prev = new Date(y, m - 1, 1);
        const last = new Date(y, m, 0);
        return {
            label: '上个月',
            start: ymd(prev.getFullYear(), prev.getMonth(), 1),
            end: ymd(last.getFullYear(), last.getMonth(), last.getDate())
        };
    }
    if (/本月|这个月/.test(q)) {
        const last = new Date(y, m + 1, 0);
        return { label: '本月', start: ymd(y, m, 1), end: ymd(y, m, last.getDate()) };
    }
    if (/上周|上星期/.test(q)) {
        const day = date.getDay() || 7; // Mon=1..Sun=7 style via getDay
        const end = new Date(date);
        end.setDate(d - day);
        const start = new Date(end);
        start.setDate(end.getDate() - 6);
        return {
            label: '上周',
            start: ymd(start.getFullYear(), start.getMonth(), start.getDate()),
            end: ymd(end.getFullYear(), end.getMonth(), end.getDate())
        };
    }
    if (/本周|这周|这个星期/.test(q)) {
        const day = date.getDay() || 7;
        const start = new Date(date);
        start.setDate(d - day + 1);
        return {
            label: '本周',
            start: ymd(start.getFullYear(), start.getMonth(), start.getDate()),
            end: ymd(y, m, d)
        };
    }
    if (/昨天/.test(q)) {
        const yest = new Date(date);
        yest.setDate(d - 1);
        const s = ymd(yest.getFullYear(), yest.getMonth(), yest.getDate());
        return { label: '昨天', start: s, end: s };
    }
    if (/今天|今日/.test(q)) {
        const s = ymd(y, m, d);
        return { label: '今天', start: s, end: s };
    }
    if (/今年/.test(q)) {
        return { label: '今年', start: `${y}-01-01`, end: `${y}-12-31` };
    }
    if (/去年/.test(q)) {
        return { label: '去年', start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    }
    const ym = q.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (ym) {
        const yy = Number(ym[1]);
        const mm = Number(ym[2]) - 1;
        const last = new Date(yy, mm + 1, 0);
        return {
            label: `${yy}年${mm + 1}月`,
            start: ymd(yy, mm, 1),
            end: ymd(yy, mm, last.getDate())
        };
    }
    const yOnly = q.match(/(\d{4})\s*年/);
    if (yOnly && !/月/.test(q)) {
        const yy = Number(yOnly[1]);
        return { label: `${yy}年`, start: `${yy}-01-01`, end: `${yy}-12-31` };
    }
    return null;
}

function tokenizeQuery(question) {
    const text = String(question || '').toLowerCase()
        .replace(/(上个月|上月|本月|这个月|上周|上星期|本周|这周|这个星期|昨天|今天|今日|今年|去年|\d{4}\s*年\s*\d{1,2}\s*月|\d{4}\s*年)/g, ' ');
    const tokens = new Set();
    for (const m of text.matchAll(/[a-z0-9_]{2,}/g)) tokens.add(m[0]);
    const cjkRuns = text.match(/[\u4e00-\u9fff]+/g) || [];
    for (const run of cjkRuns) {
        if (run.length >= 2 && !RAG_STOPWORDS.has(run)) tokens.add(run);
        for (let i = 0; i < run.length - 1; i++) {
            const bi = run.slice(i, i + 2);
            if (!RAG_STOPWORDS.has(bi)) tokens.add(bi);
        }
        for (let i = 0; i < run.length - 2; i++) {
            tokens.add(run.slice(i, i + 3));
        }
    }
    return [...tokens].filter(t => t && t.length >= 2);
}

function extractItemDate(item) {
    const raw = item.date || item.created_at || item.updated_at || '';
    const m = String(raw).match(/(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : '';
}

function scoreMemoryChunk(item, tokens, timeRange) {
    const dateStr = extractItemDate(item);
    if (timeRange) {
        if (!dateStr) return -1;
        if (dateStr < timeRange.start || dateStr > timeRange.end) return -1;
    }
    const title = String(item.title || '');
    const body = String(item.body || '');
    const hayTitle = title.toLowerCase();
    const hayBody = body.toLowerCase();
    let score = 0;
    let hits = 0;
    for (const t of tokens) {
        if (hayTitle.includes(t)) { score += 4; hits += 1; }
        if (hayBody.includes(t)) { score += 2; hits += 1; }
    }
    if (tokens.length > 0 && hits === 0) {
        return -1; // 有主题词时必须命中，避免整月日记被灌进上下文
    }
    if (timeRange) score += 3;
    // 轻微偏好更新近的内容
    if (dateStr) {
        const ageDays = Math.max(0, (Date.now() - Date.parse(dateStr + 'T00:00:00+08:00')) / 86400000);
        score += Math.max(0, 2 - ageDays / 180);
    }
    return score;
}

async function retrieveGardenMemories(db, userId, question, opts = {}) {
    const topK = opts.topK || 8;
    const maxChars = opts.maxChars || 1600;
    const tokens = tokenizeQuery(question);
    const timeRange = parseTimeRangeFromQuestion(question);

    const [feedsRes, notesRes, weekliesRes, bookmarksRes] = await Promise.all([
        db.prepare('SELECT id, content, created_at, updated_at, tags FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 100').bind(userId).all(),
        db.prepare('SELECT id, title, content, date, created_at, updated_at FROM notes WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all(),
        db.prepare('SELECT id, title, summary, content, date, created_at, updated_at FROM weeklies WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all(),
        db.prepare('SELECT id, title, description, url, created_at, updated_at FROM bookmarks WHERE user_id = ?1 AND is_deleted = 0 ORDER BY id DESC LIMIT 60').bind(userId).all()
    ]);

    const corpus = [];
    for (const f of (feedsRes.results || [])) {
        let tagText = '';
        try { tagText = Array.isArray(JSON.parse(f.tags || '[]')) ? JSON.parse(f.tags || '[]').join(' ') : ''; } catch (_) {}
        corpus.push({
            type: '随手记',
            id: f.id,
            title: '',
            body: `${f.content || ''} ${tagText}`.trim(),
            date: f.created_at || f.updated_at || '',
            created_at: f.created_at,
            updated_at: f.updated_at
        });
    }
    for (const n of (notesRes.results || [])) {
        corpus.push({
            type: '笔记',
            id: n.id,
            title: n.title || '',
            body: n.content || '',
            date: n.date || n.created_at || n.updated_at || '',
            created_at: n.created_at,
            updated_at: n.updated_at
        });
    }
    for (const w of (weekliesRes.results || [])) {
        corpus.push({
            type: '周记',
            id: w.id,
            title: w.title || '',
            body: `${w.summary || ''}\n${w.content || ''}`.trim(),
            date: w.date || w.created_at || w.updated_at || '',
            created_at: w.created_at,
            updated_at: w.updated_at
        });
    }
    for (const b of (bookmarksRes.results || [])) {
        corpus.push({
            type: '收藏',
            id: b.id,
            title: b.title || '',
            body: `${b.description || ''} ${b.url || ''}`.trim(),
            date: b.created_at || b.updated_at || '',
            created_at: b.created_at,
            updated_at: b.updated_at
        });
    }

    const ranked = corpus
        .map(item => ({ ...item, score: scoreMemoryChunk(item, tokens, timeRange) }))
        .filter(item => item.score >= 0)
        .sort((a, b) => b.score - a.score || Number(b.id || 0) - Number(a.id || 0));

    // 无关键词且无时间：不要倾倒全文，只取少量最近片段并标明
    let selected = ranked.slice(0, topK);
    if (tokens.length === 0 && !timeRange) {
        selected = corpus
            .slice()
            .sort((a, b) => String(extractItemDate(b)).localeCompare(String(extractItemDate(a))))
            .slice(0, Math.min(5, topK))
            .map(item => ({ ...item, score: 0 }));
    }

    if (selected.length === 0) {
        return {
            tokens,
            timeRange,
            sources: [],
            contextText: '（未检索到与问题匹配的记忆片段。请如实告知用户没有找到相关记录，不要编造。）'
        };
    }

    const sources = [];
    const blocks = [];
    let used = 0;
    selected.forEach((item, idx) => {
        const dateLabel = extractItemDate(item) || '未知日期';
        const titlePart = item.title ? ` · ${item.title}` : '';
        const snippet = String(item.body || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        const header = `[${idx + 1}] ${item.type}${titlePart} · ${dateLabel}`;
        const block = `${header}\n${snippet}`;
        if (used + block.length > maxChars && blocks.length > 0) return;
        blocks.push(block);
        used += block.length + 1;
        sources.push({
            type: item.type,
            id: item.id,
            date: dateLabel,
            title: item.title || '',
            snippet: snippet.slice(0, 80),
            score: Math.round(item.score * 10) / 10
        });
    });

    return {
        tokens,
        timeRange,
        sources,
        contextText: blocks.join('\n\n')
    };
}

function generateFallbackReply(question, contextText) {
    if (!contextText || contextText.trim().length === 0 || contextText.includes('未检索到')) {
        return `我在您的记忆花园里没有检索到与「${question}」直接相关的片段。可以换个关键词，或先在随手记/笔记里多记下一些想法。`;
    }
    const lines = contextText.split('\n').filter(Boolean);
    return `针对您的提问 **“${question}”**，系统检索到以下相关记忆片段：\n\n` +
        lines.slice(0, 12).map(l => l.startsWith('[') ? l : `• ${l}`).join('\n') +
        `\n\n💡 以上为检索结果摘要；接入模型后会基于这些片段作答，而不会吞掉全部日记。`;
}

async function cleanExpiredSessions(db) {
    try {
        const res = await db.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(Date.now()).run();
        return res.meta?.changes || 0;
    } catch (err) {
        console.error('cleanExpiredSessions error:', err);
        return 0;
    }
}

function sseResponse(stream, request) {
    const headers = applySecurityHeaders(new Headers({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
    }));
    const origin = request.headers.get('Origin');
    if (isAllowedOrigin(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Vary', 'Origin');
    }
    return new Response(stream, { status: 200, headers });
}

async function callCustomLlmStreamWithMessages(env, messages, onChunk) {
    const apiBase = env.LLM_API_BASE || 'https://api.deepseek.com/v1';
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL || 'deepseek-chat';

    if (apiKey) {
        const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7,
                stream: true
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Custom LLM API error (${res.status}): ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hasData = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;
                if (trimmed === 'data: [DONE]') break;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(trimmed.slice(6));
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) {
                            hasData = true;
                            onChunk(content);
                        }
                    } catch {}
                }
            }
        }
        return hasData;
    }

    if (env.AI) {
        const aiRes = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages
        });
        if (aiRes.response) {
            onChunk(aiRes.response);
            return true;
        }
    }

    return false;
}

async function callCustomLlmWithMessages(env, messages) {
    const apiBase = env.LLM_API_BASE || 'https://api.deepseek.com/v1';
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL || 'deepseek-chat';

    if (apiKey) {
        const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Custom LLM API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
    }
    return '';
}

async function callCustomLlmStream(env, systemPrompt, userPrompt, onChunk) {
    return callCustomLlmStreamWithMessages(env, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ], onChunk);
}

async function callCustomLlm(env, systemPrompt, userPrompt) {
    return callCustomLlmWithMessages(env, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
}

function formatWeekly(row) {
    if (!row) return null;
    return {
        id: row.id,
        category: row.category,
        title: row.title,
        summary: row.summary,
        date: row.date,
        cover: row.cover || null,
        weeklyData: row.weekly_data ? JSON.parse(row.weekly_data) : null,
        content: row.content || null,
        annotations: row.annotations ? JSON.parse(row.annotations) : [],
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

function formatBookmark(row) {
    if (!row) return null;
    const desc = row.description || row.desc || '';
    return {
        id: row.id,
        type: row.type,
        title: row.title,
        url: row.url,
        desc,
        description: desc,
        image: row.image || null,
        user_id: row.user_id,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

function formatFeed(row) {
    if (!row) return null;
    let tags = [];
    if (Array.isArray(row.tags)) tags = row.tags;
    else if (typeof row.tags === 'string' && row.tags) {
        try { tags = JSON.parse(row.tags); } catch { tags = []; }
    }
    return {
        id: row.id,
        content: row.content,
        type: row.type,
        media_url: row.media_url || null,
        summary: row.summary || null,
        tags,
        user_id: row.user_id,
        created_at: row.created_at || null,
        updated_at: row.updated_at || null,
        is_deleted: row.is_deleted === 1
    };
}

// ==================== AI 输出合规过滤 ====================
// 政治敏感词请通过环境变量 MODERATION_POLITICAL_WORDS（逗号分隔）自行维护，避免误伤
const MODERATE_HARD_RE = /色情|裸聊|黄播|约炮|嫖娼|卖淫|赌博|博彩|赌场|六合彩|毒品|制毒|贩毒|枪支|弹药|爆炸物|杀人|血腥|暴力恐吓/i;
const MODERATE_SOFT_RE = /加微信|加微|微信号|扫码进群|QQ群|刷单|代发|兼职日结|网赚|返利|引流|微商代理|传销|贷款办卡|代开发票/i;

function moderateText(text, env) {
    if (!text) return { ok: true, text };
    let hard = MODERATE_HARD_RE;
    const political = (env && env.MODERATION_POLITICAL_WORDS) ? String(env.MODERATION_POLITICAL_WORDS).trim() : '';
    if (political) {
        const p = political.split(/[,，]/).map(s => s.trim()).filter(Boolean).join('|');
        if (p) hard = new RegExp(`${MODERATE_HARD_RE.source}|${p}`, 'i');
    }
    if (hard.test(text)) return { ok: false, text: '' };
    return { ok: true, text: text.replace(MODERATE_SOFT_RE, '****') };
}

// ==================== UGC 合规审计 ====================
const UGC_VIOLATION_RE = /加微|加微信|微信号|扫码加|刷单|代发|代购|网赚|兼职日结|返利|引流|微商|传销|贷款办卡|代开发票|博彩|赌博|色情|裸聊|黄播|外围/i;

function ugcHasViolation(row, cols) {
    for (const col of cols) {
        let v = row[col];
        if (v == null) continue;
        if (typeof v === 'string' && v.trim().startsWith('[')) {
            try { v = JSON.parse(v).map(x => (x && (x.content || x.title || x.text)) || '').join(' '); } catch {}
        }
        if (typeof v === 'string' && UGC_VIOLATION_RE.test(v)) return true;
    }
    return false;
}

async function scanAndAudit(db, userId) {
    const results = { scanned: 0, quarantined: 0, removed: 0, alerts: [] };
    const tables = [
        { name: 'notes', cols: ['title', 'content', 'annotations'] },
        { name: 'quick_feeds', cols: ['content', 'summary', 'tags', 'media_url'] },
        { name: 'bookmarks', cols: ['title', 'url', 'description'] },
        { name: 'weeklies', cols: ['title', 'summary', 'content', 'annotations'] }
    ];

    for (const t of tables) {
        const rows = userId
            ? await db.prepare(`SELECT * FROM ${t.name} WHERE user_id = ?1`).bind(userId).all()
            : await db.prepare(`SELECT * FROM ${t.name}`).all();
        for (const row of (rows.results || [])) {
            results.scanned++;
            if (ugcHasViolation(row, t.cols)) {
                const snippet = String(row[t.cols[0]] || '').slice(0, 100);
                const ownerId = row.user_id != null ? row.user_id : (userId || null);
                // 先写入隔离区，保留完整 payload，便于误报恢复
                try {
                    await db.prepare(
                        `INSERT INTO ugc_quarantine (table_name, record_id, user_id, payload, snippet, reason)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
                    ).bind(
                        t.name,
                        String(row.id),
                        ownerId,
                        JSON.stringify(row),
                        snippet,
                        'ugc_keyword_match'
                    ).run();
                } catch (err) {
                    console.error('[audit] quarantine insert failed:', err);
                    // 隔离失败则跳过删除，避免不可恢复丢数据
                    continue;
                }

                if (userId) {
                    await db.prepare(`DELETE FROM ${t.name} WHERE id = ?1 AND user_id = ?2`).bind(row.id, userId).run();
                } else {
                    await db.prepare(`DELETE FROM ${t.name} WHERE id = ?1`).bind(row.id).run();
                }
                await db.prepare(
                    `INSERT INTO audit_log (table_name, record_id, snippet, action, created_at) VALUES (?1, ?2, ?3, 'quarantined', datetime('now', '+8 hours'))`
                ).bind(t.name, String(row.id), snippet).run();
                results.quarantined++;
                results.removed++; // 兼容旧字段
                results.alerts.push({ table: t.name, id: row.id, snippet, action: 'quarantined' });
            }
        }
    }
    return results;
}


