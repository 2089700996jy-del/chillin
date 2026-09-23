/**
 * Security & Network Utilities for Chillin Worker
 * Includes CORS, Headers, Rate Limiting, Password Hashing (PBKDF2),
 * Image Sniffing, SSRF Prevention & Safe Fetch.
 */

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
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
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
    if (!origin || isAllowedOrigin(origin)) {
        headers.set('Access-Control-Allow-Origin', origin || '*');
        headers.set('Vary', 'Origin');
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function corsResponse(body, status) {
    const headers = applySecurityHeaders(new Headers({
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ==================== 简易内存限流（按隔离实例生效，防爆破/刷费用） ====================
export const rateLimitBuckets = new Map();

export function getClientIp(request) {
    return request.headers.get('CF-Connecting-IP')
        || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
        || 'unknown';
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

export function validatePassword(password) {
    if (!password || password.length < 8) return '密码至少 8 位';
    if (password.length > 128) return '密码过长';
    if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
        return '密码需同时包含字母和数字';
    }
    return null;
}

export function timingSafeEqualStr(a, b) {
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

// ==================== SSRF 防护 ====================
export function isPrivateIPv4(parts) {
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

export function isPrivateIPv6(ip) {
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

export function isLoopbackOrPrivateHost(hostname) {
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

export function isSafeFetchUrl(rawUrl) {
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
        return !isLoopbackOrPrivateHost(u.hostname);
    } catch {
        return false;
    }
}

export async function fetchWithTimeout(resource, options = {}) {
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
export const BLOCKED_LINK_HOSTS = ['pages.dev', 'workers.dev', 'workers.cloud'];
export const BLOCKED_LINK_PATTERN = /casino|gamble|bet365|betting|poker|slot|lottery|porn|xxx|sexy|adult|escort|色情|博彩|赌博|彩票|赌场|裸聊|黄播|约炮|外围|刷单|代发|网赚|兼职日结|返利|传销|微商|加微信|加微/i;

export function isBlockedLinkUrl(rawUrl) {
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

// 密码哈希：PBKDF2-SHA256（随机盐 16 字节 + 10 万次迭代）
export const PBKDF2_ITERATIONS = 100000;

export async function hashPassword(password) {
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
export async function verifyPassword(password, stored) {
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

export function isValidRecordId(id) {
    if (id == null || id === '') return true;
    const n = Number(id);
    return Number.isSafeInteger(n) && n > 0;
}
