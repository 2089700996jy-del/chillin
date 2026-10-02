import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sniffImageMime,
    isSafeFetchUrl,
    isLoopbackOrPrivateHost,
    timingSafeEqualStr,
    validatePassword,
    isValidRecordId
} from '../workers/src/security.js';

test('Security - sniffImageMime accurately detects image headers', () => {
    // JPEG
    const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    assert.equal(sniffImageMime(jpegBytes), 'image/jpeg');

    // PNG
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
    assert.equal(sniffImageMime(pngBytes), 'image/png');

    // GIF
    const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00]);
    assert.equal(sniffImageMime(gifBytes), 'image/gif');

    // WEBP: RIFF....WEBP
    const webpBytes = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00,
        0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20
    ]);
    assert.equal(sniffImageMime(webpBytes), 'image/webp');

    // Invalid / Text / Executable
    const textBytes = new TextEncoder().encode('Hello, world! <script>alert(1)</script>');
    assert.equal(sniffImageMime(textBytes), null);
    assert.equal(sniffImageMime(null), null);
    assert.equal(sniffImageMime(new Uint8Array([1, 2, 3])), null);
});

test('Security - SSRF protection blocks private and cloud metadata IPs', () => {
    // Localhost & Loopback
    assert.equal(isLoopbackOrPrivateHost('localhost'), true);
    assert.equal(isLoopbackOrPrivateHost('127.0.0.1'), true);
    assert.equal(isLoopbackOrPrivateHost('sub.localhost'), true);

    // Private IPv4 ranges
    assert.equal(isLoopbackOrPrivateHost('10.0.0.1'), true);
    assert.equal(isLoopbackOrPrivateHost('172.16.0.1'), true);
    assert.equal(isLoopbackOrPrivateHost('192.168.1.1'), true);

    // Cloud metadata IP (AWS/GCP/Alibaba)
    assert.equal(isLoopbackOrPrivateHost('169.254.169.254'), true);
    assert.equal(isLoopbackOrPrivateHost('metadata.google.internal'), true);

    // Public Internet hostnames
    assert.equal(isLoopbackOrPrivateHost('example.com'), false);
    assert.equal(isLoopbackOrPrivateHost('github.com'), false);

    // 归一化绕过：FQDN 尾部点与 IPv6 内嵌 IPv4（::ffff:a.b.c.d 的十六进制写法）
    assert.equal(isLoopbackOrPrivateHost('localhost.'), true);
    assert.equal(isLoopbackOrPrivateHost('127.0.0.1.'), true);
    assert.equal(isLoopbackOrPrivateHost('metadata.google.internal.'), true);
    assert.equal(isLoopbackOrPrivateHost('::1'), true);
    assert.equal(isLoopbackOrPrivateHost('[::1]'), true);
    assert.equal(isLoopbackOrPrivateHost('::ffff:7f00:1'), true);
    assert.equal(isLoopbackOrPrivateHost('::ffff:a9fe:a9fe'), true);
    assert.equal(isLoopbackOrPrivateHost('64:ff9b::a9fe:a9fe'), true);
    assert.equal(isLoopbackOrPrivateHost('2002:7f00:0001::'), true);
    assert.equal(isLoopbackOrPrivateHost('fe80::1'), true);
    assert.equal(isLoopbackOrPrivateHost('fd00::1'), true);
    assert.equal(isLoopbackOrPrivateHost('2606:4700::1111'), false);

    // Full URL validation
    assert.equal(isSafeFetchUrl('http://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isSafeFetchUrl('http://127.0.0.1:8080/admin'), false);
    assert.equal(isSafeFetchUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'), false);
    assert.equal(isSafeFetchUrl('http://localhost./admin'), false);
    assert.equal(isSafeFetchUrl('ftp://example.com/file'), false);
    assert.equal(isSafeFetchUrl('https://chillin-bfc.pages.dev/'), true);
    assert.equal(isSafeFetchUrl('https://api.github.com/repos'), true);
});

test('Security - timingSafeEqualStr timing-safe string comparison', () => {
    assert.equal(timingSafeEqualStr('token12345', 'token12345'), true);
    assert.equal(timingSafeEqualStr('token12345', 'token12346'), false);
    assert.equal(timingSafeEqualStr('token', 'token123'), false);
    assert.equal(timingSafeEqualStr('', ''), true);
    assert.equal(timingSafeEqualStr(null, ''), true);
});

test('Security - validatePassword enforces 8+ chars and alphanumeric rules', () => {
    assert.notEqual(validatePassword('short'), null);
    assert.notEqual(validatePassword('onlyletters'), null);
    assert.notEqual(validatePassword('1234567890'), null);
    assert.equal(validatePassword('chillin2026!'), null);
    assert.equal(validatePassword('passWord123'), null);
});

test('Security - isValidRecordId validates positive safe integers', () => {
    assert.equal(isValidRecordId(1), true);
    assert.equal(isValidRecordId(105), true);
    assert.equal(isValidRecordId('105'), true);
    assert.equal(isValidRecordId(null), true); // optional
    assert.equal(isValidRecordId(''), true);   // optional
    assert.equal(isValidRecordId(-5), false);
    assert.equal(isValidRecordId('abc'), false);
    assert.equal(isValidRecordId('1; DROP TABLE users'), false);
});

test('Security - session token extraction and cookie hardening', async () => {
    const { extractSessionToken, sessionCookieHeader, SESSION_COOKIE } = await import('../workers/src/auth.js');

    const bearerReq = new Request('https://example.com/api/auth/me', { headers: { Authorization: 'Bearer abc123' } });
    assert.equal(extractSessionToken(bearerReq), 'abc123');

    const cookieReq = new Request('https://example.com/api/auth/me', {
        headers: { Cookie: `other=1; ${SESSION_COOKIE}=tok-xyz; more=2` }
    });
    assert.equal(extractSessionToken(cookieReq), 'tok-xyz');
    assert.equal(extractSessionToken(new Request('https://example.com/')), '');

    // Bearer 优先于 Cookie（旧客户端与新客户端可共存）
    const bothReq = new Request('https://example.com/api/auth/me', {
        headers: { Authorization: 'Bearer win', Cookie: `${SESSION_COOKIE}=lose` }
    });
    assert.equal(extractSessionToken(bothReq), 'win');

    const httpsCookie = sessionCookieHeader('tok-xyz', new Request('https://example.com/'));
    assert.match(httpsCookie, /HttpOnly/);
    assert.match(httpsCookie, /SameSite=Lax/);
    assert.match(httpsCookie, /Secure/);
    assert.match(httpsCookie, /Max-Age=604800/);

    // 本地 http 调试不下发 Secure，否则浏览器会直接丢弃 Cookie
    const localCookie = sessionCookieHeader('tok-xyz', new Request('http://localhost:8080/'));
    assert.ok(!localCookie.includes('Secure'));

    const cleared = sessionCookieHeader('', new Request('https://example.com/'), 0);
    assert.match(cleared, /Max-Age=0/);
});

test('Security - session tokens are hashed at rest', async () => {
    const { tokenHash } = await import('../workers/src/auth.js');
    const hashed = await tokenHash('raw-token-123');
    assert.match(hashed, /^[0-9a-f]{64}$/);
    assert.equal(hashed, await tokenHash('raw-token-123'));
    assert.notEqual(hashed, await tokenHash('raw-token-124'));
    assert.ok(!hashed.includes('raw-token'));
    assert.equal(await tokenHash(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('Security - CSP hashes cover every inline script and forbid unsafe-inline', async () => {
    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const urlMod = await import('node:url');
    const cryptoMod = await import('node:crypto');
    const root = pathMod.resolve(pathMod.dirname(urlMod.fileURLToPath(import.meta.url)), '..');

    const html = await fsMod.readFile(pathMod.join(root, 'index.html'), 'utf8');
    const headers = await fsMod.readFile(pathMod.join(root, '_headers'), 'utf8');

    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];
    assert.ok(inlineScripts.length > 0, 'expected index.html to contain inline scripts');

    // GitHub 中的 index.html 以 LF 存储（见 .gitattributes），Cloudflare Pages 部署的也是 LF 字节；
    // 本地检出可能是 CRLF，因此必须先归一化再算哈希，否则会得出线上永远不匹配的哈希。
    for (const match of inlineScripts) {
        const scriptText = match[1].replace(/\r\n/g, '\n');
        const digest = cryptoMod.createHash('sha256').update(scriptText, 'utf8').digest('base64');
        assert.ok(
            headers.includes(`'sha256-${digest}'`),
            `_headers CSP is missing the hash for an inline script: 'sha256-${digest}'`
        );
    }

    const cspLine = headers.split('\n').find((line) => line.includes('Content-Security-Policy'));
    assert.ok(cspLine, 'expected a Content-Security-Policy in _headers');
    const scriptSrc = cspLine.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
    assert.ok(scriptSrc, 'expected script-src in the CSP');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
    assert.match(scriptSrc, /'sha256-/);

    // 内联事件处理器在收紧后的 CSP 下会被拦截：源码中不得再出现
    const sources = ['index.html', ...(await fsMod.readdir(pathMod.join(root, 'js'))).filter((f) => f.endsWith('.js')).map((f) => pathMod.join('js', f)), 'app.js'];
    for (const rel of sources) {
        const text = await fsMod.readFile(pathMod.join(root, rel), 'utf8');
        assert.ok(!/\son(click|error|load|change|input|submit)\s*=/i.test(text), `${rel} still contains an inline event handler attribute`);
    }
});

test('Security - shared rate limiter enforces limits and degrades safely', async () => {
    const { checkRateLimitShared, cleanupRateLimits, getClientIp } = await import('../workers/src/security.js');

    // 模拟 D1 的原子 upsert 语义
    const rows = new Map();
    const fakeDb = {
        prepare() {
            return {
                bind(key, windowStart) {
                    return {
                        async first() {
                            const k = `${key}|${windowStart}`;
                            const next = (rows.get(k) || 0) + 1;
                            rows.set(k, next);
                            return { count: next };
                        },
                        async run() { return { meta: { changes: 1 } }; },
                    };
                },
            };
        },
    };

    const key = `test:${Date.now()}:${Math.random()}`;
    for (let i = 0; i < 3; i += 1) {
        assert.equal((await checkRateLimitShared(fakeDb, key, 3, 60000)).ok, true);
    }
    const blocked = await checkRateLimitShared(fakeDb, key, 3, 60000);
    assert.equal(blocked.ok, false);
    assert.ok(blocked.retryAfter >= 1);

    // D1 不可用时应降级到内存桶而不是抛错（可用性优先）
    const broken = { prepare() { throw new Error('d1 down'); } };
    assert.equal((await checkRateLimitShared(broken, `fallback:${Date.now()}`, 5, 60000)).ok, true);
    assert.equal(await cleanupRateLimits(fakeDb), 1);

    // 取信 CF-Connecting-IP；回退时取 XFF 最后一段（首段可被客户端伪造）
    assert.equal(getClientIp(new Request('https://x/', { headers: { 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' } })), '1.2.3.4');
    assert.equal(getClientIp(new Request('https://x/', { headers: { 'X-Forwarded-For': '6.6.6.6, 5.5.5.5' } })), '5.5.5.5');
    assert.equal(getClientIp(new Request('https://x/')), 'unknown');
});

test('Security - client IP is trusted only when the proxy secret matches', async () => {
    const { getClientIp } = await import('../workers/src/security.js');
    const env = { PROXY_SHARED_SECRET: 'test-secret' };

    // 反代带来的真实 IP + 正确密钥 → 采信
    const viaProxy = new Request('https://x/', {
        headers: { 'X-Chillin-Client-IP': '203.0.113.9', 'X-Chillin-Proxy-Token': 'test-secret', 'CF-Connecting-IP': '172.71.0.1' }
    });
    assert.equal(getClientIp(viaProxy, env), '203.0.113.9');

    // 密钥不对 → 忽略伪造头，回退到 CF-Connecting-IP
    const forged = new Request('https://x/', {
        headers: { 'X-Chillin-Client-IP': '203.0.113.9', 'X-Chillin-Proxy-Token': 'wrong', 'CF-Connecting-IP': '172.71.0.1' }
    });
    assert.equal(getClientIp(forged, env), '172.71.0.1');

    // 后端未配置密钥时，任何自定义头都不被采信
    assert.equal(getClientIp(viaProxy, {}), '172.71.0.1');
    assert.equal(getClientIp(viaProxy, undefined), '172.71.0.1');
});
