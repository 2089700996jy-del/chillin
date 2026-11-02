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

function safePublicUrl(raw) {
    let u;
    try { u = new URL(String(raw || '')); } catch (_) { return ''; }
    if (u.protocol !== 'https:' || u.username || u.password) return '';
    if (u.port && u.port !== '443') return '';
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return '';
    if (host.startsWith('[') || host.includes(':')) return '';
    if (/^d+(.d+){3}$/.test(host)) return '';
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
    const text = await res.text();
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, FETCH_MAX_CHARS);
}

async function fetchDirect(url, fetchImpl = fetch) {
    const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': 'ChillinAgent/1.0' },
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return readPageText(res);
}

async function fetchViaReader(env, url, fetchImpl = fetch) {
    const key = String((env && env.LINK_READER_API_KEY) || '').trim();
    if (!key) throw new Error('未配置读取服务');
    const endpoint = readerEndpoint((env && env.LINK_READER_URL) || 'https://r.jina.ai', url);
    if (!endpoint) throw new Error('读取服务地址非法');
    const res = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'follow',
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
            } catch (_) {
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
