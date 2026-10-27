import test from 'node:test';
import assert from 'node:assert/strict';
import {
    sniffImageMime,
    timingSafeEqualStr,
    validatePassword,
    isValidRecordId,
    readTextCapped,
    readJsonCapped,
    jsonResponse
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



test('Security - API JSON 响应默认带 Cache-Control: no-store', async () => {
    const res = jsonResponse({ ok: true });
    assert.equal(res.headers.get('Cache-Control'), 'no-store', '私人数据接口不能被浏览器/中间层缓存');
    // 显式 extraHeaders 仍然可以覆盖（例如需要特殊缓存策略的接口）
    const overridden = jsonResponse({ ok: true }, 200, { 'Cache-Control': 'private, max-age=60' });
    assert.equal(overridden.headers.get('Cache-Control'), 'private, max-age=60');
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

    const html = await fsMod.readFile(pathMod.join(root, 'public', 'index.html'), 'utf8');
    const headers = await fsMod.readFile(pathMod.join(root, 'public', '_headers'), 'utf8');

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

    // 注意：_headers 里还有 Content-Security-Policy-Report-Only，必须精确匹配强制指令那一行
    const cspLine = headers.split('\n').find((line) => line.trim().startsWith('Content-Security-Policy:'));
    assert.ok(cspLine, 'expected a Content-Security-Policy in _headers');
    const scriptSrc = cspLine.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src'));
    assert.ok(scriptSrc, 'expected script-src in the CSP');
    assert.ok(!scriptSrc.includes("'unsafe-inline'"), 'script-src must not allow unsafe-inline');
    assert.match(scriptSrc, /'sha256-/);

    // DOMPurify 已自托管：script-src 不应再放行任何第三方脚本域
    const scriptHosts = scriptSrc.match(/https?:\/\/[^\s;]+/g) || [];
    assert.deepEqual(scriptHosts, [], `script-src must not allow third-party hosts: ${scriptHosts.join(', ')}`);
    assert.ok(!/<script[^>]+src="https?:/i.test(html), 'index.html must not load scripts from a third-party origin');

    // 自托管产物必须与官方发布字节一致（供应链校验，防止被替换）
    const vendorBytes = await fsMod.readFile(pathMod.join(root, 'public', 'vendor', 'dompurify.min.js'));
    const vendorDigest = cryptoMod.createHash('sha384').update(vendorBytes).digest('base64');
    assert.equal(
        vendorDigest,
        'XQqX/4yiUGu+oyr87jvWzRuqBUK/adrY0DunhL+tID9m/9dwSpV8h9Fk/Sg6ifVQ',
        'vendor/dompurify.min.js no longer matches the official DOMPurify 3.1.7 release'
    );

    // 收紧后的附加指令：插件/内嵌框一律禁止，且强制升级到 HTTPS
    assert.match(cspLine, /object-src 'none'/, 'CSP should block plugins with object-src none');
    assert.match(cspLine, /frame-src 'none'/, 'CSP should block nested frames with frame-src none');
    assert.match(cspLine, /upgrade-insecure-requests/, 'CSP should upgrade insecure subresource requests');
    // 已无任何第三方静态资源：样式/字体也不应再放行外部域
    const styleSrc = cspLine.split(';').map((p) => p.trim()).find((p) => p.startsWith('style-src'));
    assert.ok(!/https?:\/\//.test(styleSrc), `style-src must not allow third-party hosts: ${styleSrc}`);
    assert.ok(!/font-src[^;]*https?:\/\//.test(cspLine), 'font-src must not allow third-party hosts');

    // 内联事件处理器在收紧后的 CSP 下会被拦截：源码中不得再出现
    const sources = ['public/index.html', ...(await fsMod.readdir(pathMod.join(root, 'public', 'js'))).filter((f) => f.endsWith('.js')).map((f) => pathMod.join('public', 'js', f)), 'public/app.js'];
    for (const rel of sources) {
        const text = await fsMod.readFile(pathMod.join(root, rel), 'utf8');
        // 只认「带引号值」的 HTML 属性写法：on*=("|')。否则 onOk / onProgress / onKeydown
        // 这类回调变量名会被误判成内联处理器。
        assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(text), `${rel} still contains an inline event handler attribute`);
        assert.ok(!/javascript:/i.test(text), `${rel} must not contain a javascript: URL`);
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

test('Auth - device descriptions summarise user agents for the session list', async () => {
    const { describeUserAgent } = await import('../workers/src/auth.js');

    const ios = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const edge = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';

    assert.equal(describeUserAgent(ios), 'iOS · Safari');
    assert.equal(describeUserAgent(edge), 'Windows · Edge');
    assert.equal(describeUserAgent(android), 'Android · Chrome');
    assert.equal(describeUserAgent(''), '未知设备');
    assert.equal(describeUserAgent(undefined), '未知设备');
});

test('Audit - retention cleanup only deletes rows older than the window', async () => {
    const { cleanupAuditLogs } = await import('../workers/src/audit.js');

    const calls = [];
    const db = {
        prepare(sql) {
            return {
                bind(...args) {
                    calls.push({ sql, args });
                    return { async run() { return { meta: { changes: 2 } }; } };
                }
            };
        }
    };

    const result = await cleanupAuditLogs(db, 180);
    assert.deepEqual(result, { auditLogs: 2, quarantine: 2 });
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.match(call.sql, /DELETE FROM (audit_log|ugc_quarantine)/);
        // 必须使用与写入一致的 SQLite 时间格式（审计行按东八区写入，边界也要 +8 hours），且窗口参数化
        assert.match(call.sql, /datetime\('now', '\+8 hours', \?1\)/);
        assert.equal(call.args[0], '-180 days');
    }

    // 非法窗口收敛到至少 1 天，避免一次清空全表
    calls.length = 0;
    await cleanupAuditLogs(db, 0);
    assert.equal(calls[0].args[0], '-1 days');
});

test('Security - every HTML sink goes through the Trusted Types choke point', async () => {
    const fsMod = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const jsDir = path.join(root, 'public', 'js');

    const offenders = [];
    for (const file of (await fsMod.readdir(jsDir)).filter((f) => f.endsWith('.js'))) {
        if (file === 'trusted-types.js') continue; // 唯一允许写 innerHTML 的地方
        const text = await fsMod.readFile(path.join(jsDir, file), 'utf8');
        const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
        if (/\.(inner|outer)HTML\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(/.test(stripped)) offenders.push(file);
        if (/setHtml\(/.test(stripped) && !text.includes("from './trusted-types.js'")) {
            offenders.push(file + ' (uses setHtml without importing it)');
        }
    }
    assert.deepEqual(offenders, [], `HTML sinks must go through setHtml(): ${offenders.join(', ')}`);

    const tt = await fsMod.readFile(path.join(jsDir, 'trusted-types.js'), 'utf8');
    assert.match(tt, /createPolicy\(POLICY_NAME, \{ createHTML/, 'expected a Trusted Types policy');
    assert.match(tt, /chillin#html/, 'policy name must match the CSP allowlist');
});

test('Security - Trusted Types is enforced and allowlists our policy names', async () => {
    const fsMod = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
    const headers = await fsMod.readFile(path.join(root, 'public', '_headers'), 'utf8');

    // 已从 Report-Only 提升为强制指令
    assert.ok(
        !headers.includes('Content-Security-Policy-Report-Only'),
        'the Trusted Types directive must not remain report-only'
    );
    const enforced = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
    assert.ok(enforced, 'expected the enforced Content-Security-Policy');
    assert.match(enforced, /require-trusted-types-for 'script'/, 'enforced CSP must require Trusted Types');

    const allowlist = enforced.slice(enforced.indexOf('trusted-types '));
    assert.ok(allowlist.includes('chillin#html'), 'our policy name must be allowlisted');
    assert.ok(allowlist.includes('dompurify'), 'DOMPurify creates its own policy and must be allowlisted');
});

test('Security - setHtml uses the Trusted Types policy, and degrades without it', async () => {
    // 1) 浏览器支持 Trusted Types：必须经 createPolicy('chillin#html') 产出 TrustedHTML
    const created = [];
    globalThis.trustedTypes = {
        createPolicy(name, rules) {
            created.push(name);
            return { createHTML: (value) => ({ trusted: true, html: rules.createHTML(value) }) };
        }
    };
    const enforced = await import('../public/js/trusted-types.js?with-tt=1');
    const el = { innerHTML: null };
    enforced.setHtml(el, '<b>hi</b>');
    assert.deepEqual(created, ['chillin#html']);
    assert.equal(el.innerHTML.trusted, true);
    assert.equal(el.innerHTML.html, '<b>hi</b>');
    delete globalThis.trustedTypes;

    // 2) 不支持 Trusted Types 的浏览器（如部分旧版）：退回普通字符串赋值
    const legacy = await import('../public/js/trusted-types.js?no-tt=1');
    const el2 = { innerHTML: null };
    legacy.setHtml(el2, '<i>x</i>');
    assert.equal(el2.innerHTML, '<i>x</i>');

    // 3) 空目标不应抛错（很多渲染函数会先查元素是否存在）
    assert.doesNotThrow(() => legacy.setHtml(null, 'x'));
    assert.doesNotThrow(() => legacy.setHtml(el2, undefined));
    assert.equal(el2.innerHTML, '');
});

test('Security - urlBase64ToUint8Array handles valid VAPID keys and invalid inputs gracefully', async () => {
    const { urlBase64ToUint8Array } = await import('../public/js/utils.js');
    assert.equal(urlBase64ToUint8Array('').length, 0);
    assert.equal(urlBase64ToUint8Array(null).length, 0);
    assert.equal(urlBase64ToUint8Array(undefined).length, 0);

    const validKey = 'BBj8FZZ57_GfEm-HGPo9pXRA5jsd4FAzu-3bQJC7KjAoGp3TWlDGFt5D22JadZ6t5bw9u6NDNsy4Vgny9v3r2e0';
    const arr = urlBase64ToUint8Array(validKey);
    assert.ok(arr instanceof Uint8Array);
    assert.ok(arr.length > 0);
});

test('Security - readTextCapped 在读取过程中限长，不把超大体读完', async () => {
    // 1) 正常小请求：读回原文与字节数
    const okRes = await readTextCapped(new Request('https://x/api/t', { method: 'POST', body: 'hello' }), 1024);
    assert.equal(okRes.ok, true);
    assert.equal(okRes.text, 'hello');
    assert.equal(okRes.bytes, 5);

    // 2) 声明长度就超限：不读请求体，直接拒绝
    const declaredStream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('abcdef')); c.close(); } });
    const declared = new Request('https://x/api/t', {
        method: 'POST', body: declaredStream, duplex: 'half', headers: { 'Content-Length': '999999' }
    });
    const declaredRes = await readTextCapped(declared, 1024);
    assert.equal(declaredRes.ok, false);
    assert.equal(declaredRes.tooLarge, true);

    // 3) 分块流累计超限：必须在中途停止拉取，而不是读完整再判断
    let pulled = 0;
    const stream = new ReadableStream({
        pull(controller) {
            pulled++;
            if (pulled > 100) { controller.close(); return; }
            controller.enqueue(new TextEncoder().encode('y'.repeat(64)));
        }
    });
    const streaming = new Request('https://x/api/t', { method: 'POST', body: stream, duplex: 'half' });
    const streamingRes = await readTextCapped(streaming, 256);
    assert.equal(streamingRes.ok, false);
    assert.equal(streamingRes.tooLarge, true);
    assert.ok(pulled < 100, '超限后应停止继续拉取，实际拉了 ' + pulled + ' 次');
});
test('Security - readJsonCapped 限长并区分 413 / 400', async () => {
    const okRes = await readJsonCapped(new Request('https://x', { method: 'POST', body: JSON.stringify({ a: 1 }) }), 1024);
    assert.equal(okRes.ok, true);
    assert.equal(okRes.value.a, 1);

    // 声明长度超限：直接 413，不解析
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); c.close(); } });
    const tooLarge = await readJsonCapped(new Request('https://x', { method: 'POST', body: stream, duplex: 'half', headers: { 'Content-Length': '999999' } }), 1024);
    assert.equal(tooLarge.ok, false);
    assert.equal(tooLarge.status, 413);

    const bad = await readJsonCapped(new Request('https://x', { method: 'POST', body: 'not json' }), 1024);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 400);
});
test('Security - 法务页面（隐私政策 / 用户协议）是自洽的公开静态页', async () => {
    // 背景：第三方开放平台（如小米运动健康）申请时必须提供 https 的隐私政策与用户协议链接。
    // 这两页是公开可访问的静态文件，必须和主应用守同一条纪律：无脚本、无内联事件处理器、
    // 无 javascript: URL、不引用任何第三方资源——它们是唯一不需要登录就能打开的页面。
    const fsMod = await import('node:fs/promises');
    const pathMod = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const root = pathMod.resolve(pathMod.dirname(fileURLToPath(import.meta.url)), '..');
    const pages = ['public/privacy.html', 'public/terms.html'];
    const index = await fsMod.readFile(pathMod.join(root, 'public', 'index.html'), 'utf8');
    for (const rel of pages) {
        let text = '';
        await assert.doesNotReject(
            (async () => { text = await fsMod.readFile(pathMod.join(root, rel), 'utf8'); })(),
            `${rel} 必须存在（申请表的两个链接就指向它）`
        );
        assert.match(text, /<meta charset="UTF-8">/, `${rel} 缺少 charset 声明`);
        assert.match(text, /name="viewport"/, `${rel} 缺少移动端 viewport`);
        assert.ok(!/<script[\s>]/i.test(text), `${rel} 不应包含任何脚本`);
        assert.ok(!/\son[a-z]+\s*=\s*["\']/i.test(text), `${rel} 不应包含内联事件处理器`);
        assert.ok(!/javascript:/i.test(text), `${rel} 不应包含 javascript: URL`);
        assert.ok(!/(src|href)="https?:\/\//i.test(text), `${rel} 不应引用第三方资源`);
        const slug = rel.split('/')[1];
        assert.ok(index.includes(`href="/${slug}"`), `index.html 应在设置里挂上 ${slug} 的入口`);
    }
    // 两页互相交叉引用，且都能回到应用
    const privacy = await fsMod.readFile(pathMod.join(root, 'public', 'privacy.html'), 'utf8');
    const terms = await fsMod.readFile(pathMod.join(root, 'public', 'terms.html'), 'utf8');
    assert.ok(privacy.includes('href="/terms.html"'), '隐私政策应指向用户协议');
    assert.ok(terms.includes('href="/privacy.html"'), '用户协议应指向隐私政策');
    // 政策必须如实交代数据存放与删除方式，否则只是空壳
    for (const needle of ['Cloudflare', 'PBKDF2', '删除', '第三方']) {
        assert.ok(privacy.includes(needle), `隐私政策应提到 ${needle}`);
    }
});
