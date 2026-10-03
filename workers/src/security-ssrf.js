/**
 * SSRF Prevention & Safe Outbound Fetch Utilities for Chillin Worker
 * Blocks loopback, private IPv4/IPv6 CIDRs, cloud metadata endpoints,
 * and handles bounded streaming text reading.
 */

// ==================== SSRF 防护 ====================
export function isPrivateIPv4(parts) {
    if (!parts || parts.length !== 4) return true;
    if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    return isPrivateIPv4Int(((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

/**
 * 限长读取响应体文本。
 * 外链解析会把目标页面的 HTML 读进来做正则解析，恶意站点可以返回超大响应体，
 * 若不设上限会直接撑爆 Worker 内存（128MB）。超过上限即截断并取消后续读取。
 */
export async function readTextCapped(response, maxBytes = 512 * 1024) {
    if (!response) return '';
    if (!response.body || typeof response.body.getReader !== 'function') {
        return await response.text();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    try {
        while (received < maxBytes) {
            const { done, value } = await reader.read();
            if (done) break;
            const remain = maxBytes - received;
            if (value.byteLength >= remain) {
                // 单块就可能超过上限：按字节切片，绝不整块收下
                chunks.push(value.subarray(0, remain));
                received = maxBytes;
                try { await reader.cancel(); } catch (_) { /* 忽略取消失败 */ }
                break;
            }
            chunks.push(value);
            received += value.byteLength;
        }
    } catch (_) {
        // 读取中断时返回已收到的部分
    }
    const merged = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
    }
    // 一次性解码，避免多字节字符被流式切断（fatal:false 保证不抛错）
    return new TextDecoder('utf-8', { fatal: false }).decode(merged);
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
