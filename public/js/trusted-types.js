/**
 * Trusted Types 收口模块。
 *
 * 背景：全站有 70+ 处 `el.innerHTML = ...`，CSP 因此长期需要 `script-src 'unsafe-inline'`，
 * 也无法启用 `require-trusted-types-for 'script'`。现在所有 HTML 注入都必须经过 `setHtml()`：
 *
 * 1. 它把分散的写入点收敛为**唯一入口**，将来只需在这一个地方接入清洗；
 * 2. 启用 Trusted Types 后，任何绕过本模块的字符串赋值都会被浏览器直接拒绝
 *    （TypeError），从而挡住「忘记转义就直接拼 HTML」这类回归；
 * 3. 策略本身是恒等映射（不做清洗）——真正的 XSS 防线仍是各处的 escapeHtml
 *    与正文的 DOMPurify.sanitize，这里只负责「谁能写 HTML」这一层。
 */
const POLICY_NAME = 'chillin#html';

let cachedPolicy = null;

function getPolicy() {
    if (cachedPolicy !== null) return cachedPolicy;
    try {
        cachedPolicy = (typeof trustedTypes !== 'undefined' && typeof trustedTypes.createPolicy === 'function')
            ? trustedTypes.createPolicy(POLICY_NAME, { createHTML: (value) => String(value), createScriptURL: (value) => String(value) })
            : false;
    } catch (err) {
        // 策略重名或 CSP 未放行该策略名：退回普通字符串（此时 CSP 未强制 Trusted Types）
        console.warn('[trusted-types] policy unavailable, falling back to plain assignment', err);
        cachedPolicy = false;
    }
    return cachedPolicy;
}

/**
 * 把 HTML 字符串安全地写入元素（Trusted Types 唯一入口）。
 * @param {Element|null|undefined} el 目标元素
 * @param {string} markup HTML 字符串（调用方负责转义用户内容）
 */
export function setHtml(el, markup) {
    if (!el) return;
    const value = markup == null ? '' : String(markup);
    const policy = getPolicy();
    el.innerHTML = policy ? policy.createHTML(value) : value;
}

/**
 * 把脚本/Worker/SW URL 包装为 TrustedScriptURL。
 * @param {string} url 目标脚本地址
 * @returns {TrustedScriptURL|string}
 */
export function getScriptUrl(url) {
    if (!url) return url;
    const policy = getPolicy();
    return policy && typeof policy.createScriptURL === 'function'
        ? policy.createScriptURL(url)
        : url;
}
