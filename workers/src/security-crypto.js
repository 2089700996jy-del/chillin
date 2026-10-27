/**
 * Cryptographic & Password Security Utilities for Chillin Worker
 * Includes PBKDF2 hashing, constant-time string comparison, and password rules.
 */

// 密码哈希：PBKDF2-SHA256（随机盐 16 字节 + 60 万次迭代）
// 60 万次是 OWASP 2023 对 PBKDF2-HMAC-SHA256 的推荐下限；旧哈希不强制失效，
// 登录成功时由 verifyPassword 标记 upgrade，再用当前迭代数透明重哈希。
export const PBKDF2_ITERATIONS = 600000;

export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
    const encoder = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt, iterations: iterations, hash: 'SHA-256' },
        keyMaterial, 256
    );
    const toHex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2$${iterations}$${toHex(salt)}$${toHex(bits)}`;
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
    const valid = timingSafeEqualStr(toHex(bits), expected);
    // 迭代次数低于当前标准的旧哈希：登录成功后就地升级，用户无感
    return { valid, upgrade: valid && iter < PBKDF2_ITERATIONS };
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
