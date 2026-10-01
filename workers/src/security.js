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

export function getClientIp(request) {
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
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return isPrivateIPv4Int(((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/** 32 位无符号整数形式的 IPv4 私网/保留段判定（供 IPv6 内嵌 IPv4 复用） */
export function isPrivateIPv4Int(ip) {
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

/**
 * 把 IPv6 文本解析为 16 字节数组（支持 `::` 压缩与末尾内嵌 IPv4，如 `::ffff:7f00:1`）。
 * 解析失败返回 null。
 */
export function parseIPv6ToBytes(ip) {
    if (typeof ip !== 'string') return null;
    let text = ip.trim().toLowerCase().split('%')[0];
    if (!text.includes(':')) return null;
    if (text.includes('.')) {
        const colon = text.lastIndexOf(':');
        const v4 = text.slice(colon + 1);
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) return null;
        const p = v4.split('.').map(Number);
        if (p.some((n) => n > 255)) return null;
        text = text.slice(0, colon + 1) + (((p[0] << 8) | p[1]) >>> 0).toString(16) + ':' + (((p[2] << 8) | p[3]) >>> 0).toString(16);
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const parseGroups = (s) => (s === '' ? [] : s.split(':').map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN)));
    const head = parseGroups(halves[0]);
    const tail = halves.length === 2 ? parseGroups(halves[1]) : [];
    if (head.some(Number.isNaN) || tail.some(Number.isNaN)) return null;
    let groups;
    if (halves.length === 1) {
        if (head.length !== 8) return null;
        groups = head;
    } else {
        const missing = 8 - head.length - tail.length;
        if (missing < 1) return null;
        groups = [...head, ...new Array(missing).fill(0), ...tail];
    }
    const bytes = new Array(16);
    for (let i = 0; i < 8; i++) {
        bytes[i * 2] = (groups[i] >> 8) & 0xff;
        bytes[i * 2 + 1] = groups[i] & 0xff;
    }
    return bytes;
}

/** 16 字节数组形式的 IPv6 私网/保留/内嵌私网判定 */
export function isPrivateIPv6Bytes(b) {
    if (!b || b.length !== 16) return true;
    const allZero = (from, to) => b.slice(from, to).every((x) => x === 0);
    const embeddedV4 = (offset) =>
        ((b[offset] << 24) | (b[offset + 1] << 16) | (b[offset + 2] << 8) | b[offset + 3]) >>> 0;
    if (allZero(0, 16)) return true;                                  // ::
    if (allZero(0, 15) && b[15] === 1) return true;                   // ::1
    if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) return isPrivateIPv4Int(embeddedV4(12)); // ::ffff:a.b.c.d
    if (allZero(0, 12)) return isPrivateIPv4Int(embeddedV4(12));      // ::a.b.c.d（IPv4-compatible）
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) {
        if (allZero(4, 12)) return isPrivateIPv4Int(embeddedV4(12));  // NAT64 64:ff9b::/96
        return true;                                                  // 同前缀的本地用途段
    }
    if (b[0] === 0x20 && b[1] === 0x02) return isPrivateIPv4Int(embeddedV4(2)); // 6to4 2002::/16
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true; // Teredo 2001:0000::/32
    if ((b[0] & 0xfe) === 0xfc) return true;                          // ULA fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;         // link-local fe80::/10
    if (b[0] === 0xff) return true;                                   // multicast ff00::/8
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // 2001:db8::/32
    if (b[0] === 0x01 && b[1] === 0x00 && allZero(2, 8)) return true; // 100::/64
    return false;
}

/** 文本形式的 IPv6 判定；无法解析时按危险处理（fail-closed） */
export function isPrivateIPv6(ip) {
    if (!ip) return true;
    const bytes = parseIPv6ToBytes(String(ip).replace(/^\[|\]$/g, ''));
    if (!bytes) return true;
    return isPrivateIPv6Bytes(bytes);
}

export function isLoopbackOrPrivateHost(hostname) {
    const raw = (hostname || '').toLowerCase().trim();
    if (!raw) return true;
    // 归一化：去掉 FQDN 尾部点（`localhost.` / `127.0.0.1.`）与 IPv6 方括号
    const h = raw.replace(/\.+$/, '').replace(/^\[|\]$/g, '');
    if (!h) return true;
    if (h.includes(':')) {
        return isPrivateIPv6(h);
    }
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
        const parts = h.split('.').map(Number);
        return parts.some((n) => n > 255) ? true : isPrivateIPv4(parts);
    }
    if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') ||
        h.endsWith('.internal') || h === 'metadata.google.internal') {
        return true;
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
