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

    // Full URL validation
    assert.equal(isSafeFetchUrl('http://169.254.169.254/latest/meta-data/'), false);
    assert.equal(isSafeFetchUrl('http://127.0.0.1:8080/admin'), false);
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
