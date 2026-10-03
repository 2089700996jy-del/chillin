/**
 * Network Security, Headers, CORS, Rate Limiting & Input Validation for Chillin Worker.
 */
import { timingSafeEqualStr } from './security-crypto.js';

// CORS 白名单：仅允许本站及本地调试域名跨域访问，防止流量被第三方站点盗用
export const ALLOWED_ORIGINS = new Set([
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
export function isAllowedOrigin(origin) {
    if (!origin) return false;
    if (ALLOWED_ORIGINS.has(origin)) return true;
    try {
        const hostname = new URL(origin).hostname;
        // 仅放行本机调试 / 原生壳；不再放行任意 *.pages.dev / *.workers.dev
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.localhost');
    } catch {
        return false;
    }
}

export const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
};

export function applySecurityHeaders(headers) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
        if (!headers.has(k)) headers.set(k, v);
    }
    return headers;
}

export function withCors(response, request) {
    const origin = request.headers.get('Origin');
    const headers = new Headers(response.headers);
    if (origin && isAllowedOrigin(origin)) {
        // 允许携带 HttpOnly 会话 Cookie 的跨域请求（精确回显来源，绝不能与 * 同用）
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Vary', 'Origin');
    } else if (!origin) {
        headers.set('Access-Control-Allow-Origin', '*');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsResponse(body, status) {
    const headers = applySecurityHeaders(new Headers({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
        'Content-Type': 'application/json'
    }));
    if (!body) return new Response(null, { status, headers });
    return new Response(JSON.stringify(body), { status, headers });
}

export function jsonResponse(body, status = 200, extraHeaders = null) {
    const res = corsResponse(body, status);
    if (extraHeaders && typeof extraHeaders === 'object') {
        const headers = new Headers(res.headers);
        for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
        return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }
    return res;
}

export function sseResponse(stream, request) {
    const origin = request.headers.get('Origin');
    const headers = new Headers({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    applySecurityHeaders(headers);
    if (!origin || isAllowedOrigin(origin)) {
        headers.set('Access-Control-Allow-Origin', origin || '*');
        headers.set('Vary', 'Origin');
    }
    return new Response(stream, { headers });
}

// ==================== 限流：内存快速桶 + D1 跨实例共享计数 ====================
export const rateLimitBuckets = new Map();

export function getClientIp(request, env) {
    // 反代（Pages Function）会把原 IP 放在自定义头里并附上共享密钥；
    // 只有密钥匹配（恒定时间比较）才采信，直连 Worker 无法伪造头部绕过限流。
    const proxiedIp = request.headers.get('X-Chillin-Client-IP');
    if (proxiedIp) {
        const token = request.headers.get('X-Chillin-Proxy-Token') || '';
        const secret = env && env.PROXY_SHARED_SECRET;
        if (secret && token && timingSafeEqualStr(token, secret)) return proxiedIp.trim();
    }
    const cfIp = request.headers.get('CF-Connecting-IP');
    if (cfIp && cfIp.trim()) return cfIp.trim();
    // 回退：取 X-Forwarded-For 的最后一段（由最近的边缘节点追加，最接近真实客户端；
    // 首段是客户端可伪造的，不能作为限流依据）
    const chain = (request.headers.get('X-Forwarded-For') || '')
        .split(',').map((part) => part.trim()).filter(Boolean);
    return chain.length ? chain[chain.length - 1] : 'unknown';
}

/**
 * 跨实例限流：内存桶负责同 isolate 的快速拒绝，D1 计数负责跨边缘节点的一致性。
 * D1 异常时降级为内存桶结果（可用性优先，与旧行为一致）。
 */
export async function checkRateLimitShared(db, key, limit, windowMs) {
    const local = checkRateLimit(key, limit, windowMs);
    if (!local.ok) return local;
    if (!db) return local;

    const now = Date.now();
    const windowStart = Math.floor(now / windowMs) * windowMs;
    try {
        const row = await db.prepare(
            `INSERT INTO rate_limits (bucket_key, window_start, count) VALUES (?1, ?2, 1)
             ON CONFLICT(bucket_key, window_start) DO UPDATE SET count = count + 1
             RETURNING count`
        ).bind(key, windowStart).first();
        const count = row && row.count != null ? Number(row.count) : 1;
        if (count > limit) {
            return { ok: false, retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
        }
        return { ok: true };
    } catch (err) {
        console.warn('[rate-limit] shared counter unavailable, using isolate bucket', err);
        return local;
    }
}

/** 定时清理过期限流行（保留 1 天窗口足够所有限流策略回看） */
export async function cleanupRateLimits(db, keepMs = 24 * 60 * 60 * 1000) {
    const res = await db.prepare('DELETE FROM rate_limits WHERE window_start < ?1')
        .bind(Date.now() - keepMs).run();
    return res.meta?.changes || 0;
}

export function checkRateLimit(key, limit, windowMs) {
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

export function rateLimitedResponse(retryAfter, tip) {
    const res = jsonResponse({
        error: tip || '请求过于频繁，请稍后再试',
        code: 'RATE_LIMITED',
        retryAfter: retryAfter || 60
    }, 429);
    const headers = new Headers(res.headers);
    headers.set('Retry-After', String(retryAfter || 60));
    return new Response(res.body, { status: 429, headers });
}

export function sniffImageMime(bytes) {
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

export function isValidRecordId(id) {
    if (id == null || id === '') return true;
    const n = Number(id);
    return Number.isSafeInteger(n) && n > 0;
}
