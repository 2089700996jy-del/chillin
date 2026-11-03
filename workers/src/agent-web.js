/**
 * 目标 Agent 的只读联网工具：web_search / fetch_url。
 *
 * 边界：
 * - 只读，不写库、不发送消息；
 * - fetch_url 只接受公开 https 地址，拒绝 localhost / 私网 / IP 字面量；
 * - 抓取内容截断后交给模型，内容本身是数据，不是指令；
 * - 有 LINK_READER_API_KEY 时优先让读取服务代读，避免 Cloudflare 出口被封。
 */
import { runWebSearch } from './bot-search.js';
import { readerEndpoint } from './bot-links.js';

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_CHARS = 12000;
const SEARCH_RESULTS = 6;
const MAX_REDIRECTS = 3;

export const WEB_AGENT_TOOLS = [
    {
        type: 'function',
        function: {
            name: 'web_search',
            description: '只读联网检索。用于查询新闻、赛事、价格、最新事件等外部事实；返回标题、链接和摘要。',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', minLength: 1, maxLength: 200 } },
                required: ['query'],
                additionalProperties: false
            }
        }
    },
    {
        type: 'function',
        function: {
            name: 'fetch_url',
            description: '只读打开一个公开 https 网页并返回正文。必须先用 web_search 或其他来源拿到 URL。',
            parameters: {
                type: 'object',
                properties: { url: { type: 'string', minLength: 8, maxLength: 2000 } },
                required: ['url'],
                additionalProperties: false
            }
        }
    }
];

/**
 * 私网、环回、链路本地、云元数据及特殊保留网段正则。
 * 覆盖：
 * - 0.0.0.0/8 (当前网络)
 * - 10.0.0.0/8 (RFC 1918 私网)
 * - 127.0.0.0/8 (环回)
 * - 169.254.0.0/16 (链路本地 / 云元数据 169.254.169.254)
 * - 172.16.0.0/12 (RFC 1918: 172.16 - 172.31)
 * - 192.168.0.0/16 (RFC 1918)
 * - 100.64.0.0/10 (CGNAT: 100.64 - 100.127)
 * - 192.0.0.0/24, 192.0.2.0/24 (保留 / TEST-NET-1)
 * - 198.18.0.0/15 (基准测试)
 * - 198.51.100.0/24 (TEST-NET-2)
 * - 203.0.113.0/24 (TEST-NET-3)
 * 支持识别标准点分及子域名伪装（如 127.0.0.1.nip.io、foo.10.0.0.1.xip.io 等）
 */
const PRIVATE_HOST_RE = /(^|\.)(0|10|127|169\.254|172\.(1[6-9]|2\d|3[01])|192\.168|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])|192\.0\.[02]|198\.1[89]|198\.51\.100|203\.0\.113)\./;

export function safePublicUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch (_) { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    if (u.port && u.port !== '443') return '';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    if (!host) return '';
    if (
        host === 'localhost' ||
        host.endsWith('.localhost') ||
        host.endsWith('.local') ||
        host.endsWith('.internal') ||
        host.endsWith('.lan') ||
        host.endsWith('.home.arpa') ||
        host.endsWith('.corp')
    ) return '';
    if (host.startsWith('[') || host.includes(':')) return '';
    // IPv4 字面量检测（标准点分十进制与纯整数），拒绝所有裸 IP 访问
    if (/^\d+(\.\d+){3}$/.test(host) || /^\d+$/.test(host)) return '';
    // 私有/保留网段深度拦截（包含伪装为子域名的 nip.io / xip.io 等）
    if (PRIVATE_HOST_RE.test(host)) return '';
    return u.toString();
}

function withTimeout(promise, ms) {
    let timer;
    return Promise.race([
        Promise.resolve(promise),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('WEB_TIMEOUT')), ms); })
    ]).finally(() => clearTimeout(timer));
}

async function readPageText(res) {
    let text = '';
    if (res && res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
            while (bytes < 256 * 1024) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.length;
                text += decoder.decode(value, { stream: true });
            }
        } finally {
            try { await reader.cancel(); } catch (_) { /* 已断开 */ }
        }
    } else {
        text = await res.text();
    }
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, FETCH_MAX_CHARS);
}

/**
 * 直连拉取：手动跟随重定向，并在每一跳对目标地址重新进行 safePublicUrl 安全准入校验，彻底阻断 SSRF。
 */
async function fetchDirect(initialUrl, fetchImpl = fetch) {
    let currentUrl = initialUrl;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const safe = safePublicUrl(currentUrl);
        if (!safe) throw new Error('REDIRECT_BLOCKED');
        currentUrl = safe;

        const res = await fetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': 'ChillinAgent/1.0' },
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
        });

        if (res.status >= 300 && res.status < 400) {
            const location = (res.headers && typeof res.headers.get === 'function')
                ? res.headers.get('location')
                : (res.headers && (res.headers.location || res.headers.Location || ''));
            if (!location) throw new Error('REDIRECT_MISSING_LOCATION');
            try {
                currentUrl = new URL(location, currentUrl).toString();
            } catch {
                throw new Error('REDIRECT_INVALID_URL');
            }
            continue;
        }

        if (!res.ok) throw new Error('HTTP ' + res.status);
        return readPageText(res);
    }
    throw new Error('TOO_MANY_REDIRECTS');
}

async function fetchViaReader(env, url, fetchImpl = fetch) {
    const key = String((env && env.LINK_READER_API_KEY) || '').trim();
    if (!key) throw new Error('未配置读取服务');
    const endpoint = readerEndpoint((env && env.LINK_READER_URL) || 'https://r.jina.ai', url);
    if (!endpoint) throw new Error('读取服务地址非法');
    const res = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'text/plain', Authorization: 'Bearer ' + key, 'x-api-key': key, 'User-Agent': 'ChillinAgent/1.0' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
    });
    if (!res.ok) throw new Error('读取服务 HTTP ' + res.status);
    return readPageText(res);
}

export async function runWebTool(env, name, args = {}, deps = {}) {
    const tool = String(name || '');
    try {
        if (tool === 'web_search') {
            const query = String(args.query || '').trim();
            if (!query) return { ok: false, tool, error: { code: 'INVALID_ARGUMENTS', message: 'query 不能为空' }, citations: [] };
            const result = await runWebSearch(env, query, deps.fetchImpl || fetch, query);
            if (!result || !result.ok) {
                return { ok: false, tool, error: { code: 'SEARCH_FAILED', message: '联网检索失败：' + (result && result.reason || 'unknown') }, citations: [] };
            }
            const results = result.sources.slice(0, SEARCH_RESULTS).map((item) => ({
                title: item.title, url: item.url, snippet: item.snippet, date: item.date, site: item.site
            }));
            return {
                ok: true, tool,
                data: { query, results },
                citations: results.map((item) => ({ type: '网页', id: item.url, title: item.title, snippet: item.snippet, date: item.date })),
                truncated: result.sources.length > SEARCH_RESULTS
            };
        }
        if (tool === 'fetch_url') {
            const url = safePublicUrl(args.url);
            if (!url) return { ok: false, tool, error: { code: 'INVALID_URL', message: '只允许公开 https 网页地址' }, citations: [] };
            let text = '';
            try {
                text = await withTimeout(fetchDirect(url, deps.fetchImpl || fetch), FETCH_TIMEOUT_MS);
            } catch (err) {
                // 如果直连明确触发了重定向安全拦截（SSRF 攻击），坚决不走代读退路，直接拒绝
                if (err && err.message && (err.message.startsWith('REDIRECT_') || err.message === 'TOO_MANY_REDIRECTS')) {
                    return {
                        ok: false,
                        tool,
                        error: {
                            code: err.message === 'REDIRECT_BLOCKED' ? 'INVALID_URL' : 'REDIRECT_FAILED',
                            message: err.message === 'REDIRECT_BLOCKED' ? '重定向目标地址不安全，已被安全拦截' : '重定向处理失败：' + err.message
                        },
                        citations: []
                    };
                }
                text = await withTimeout(fetchViaReader(env, url, deps.fetchImpl || fetch), FETCH_TIMEOUT_MS);
            }
            return {
                ok: true, tool,
                data: { url, content: text, length: text.length },
                citations: [{ type: '网页', id: url, title: url, snippet: text.slice(0, 200) }],
                truncated: text.length >= FETCH_MAX_CHARS
            };
        }
        return { ok: false, tool, error: { code: 'UNKNOWN_TOOL', message: '未注册的联网工具' }, citations: [] };
    } catch (err) {
        return { ok: false, tool, error: { code: 'WEB_FAILED', message: '联网工具失败：' + (err && err.message || 'unknown') }, citations: [] };
    }
}
