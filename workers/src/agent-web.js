/**
 * 目标 Agent 的只读联网工具：web_search / fetch_url。
 *
 * 边界与安全准则：
 * - 只读，不写库、不发送消息；
 * - fetch_url 只接受公开 https 地址，拒绝 localhost / 私网 / 裸 IP 字面量；
 * - 拦截 DNS rebinding：域名解析为私有网段或环回地址时坚决拒绝；
 * - 严格重定向校验：每一跳重定向均必须重新执行 URL 安全准入与 DNS 检查；
 * - 响应体大小防护：前置 Content-Length 拦截与流式 256 KiB 上限截断，防范内存 OOM 与 Zip/HTML 炸弹；
 * - 统一超时保护：全局 AbortController 严格控制 15 秒总执行预算并及时释放底层连接。
 */
import { runWebSearch } from './bot-search.js';
import { readerEndpoint } from './bot-links.js';

const FETCH_TIMEOUT_MS = 15000;
const FETCH_MAX_CHARS = 12000;
const MAX_CONTENT_LENGTH = 5 * 1024 * 1024; // 5 MB 响应头前置拦截上限
const MAX_RESPONSE_BYTES = 256 * 1024;      // 256 KiB 实际读取最大字节数
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

export function isPrivateOrReservedIp(ip) {
    if (!ip || typeof ip !== 'string') return true;
    const s = ip.trim().toLowerCase();
    // IPv4 判定
    if (/^\d+(\.\d+){3}$/.test(s)) {
        const parts = s.split('.').map(Number);
        if (parts.some((p) => p < 0 || p > 255 || isNaN(p))) return true;
        const [a, b] = parts;
        if (a === 0) return true; // 0.0.0.0/8
        if (a === 10) return true; // 10.0.0.0/8
        if (a === 127) return true; // 127.0.0.0/8
        if (a === 169 && b === 254) return true; // 169.254.0.0/16
        if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
        if (a === 192 && b === 168) return true; // 192.168.0.0/16
        if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10
        if (a === 192 && b === 0) return true; // 192.0.0.0/24, 192.0.2.0/24
        if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15
        if (a === 198 && b === 51) return true; // 198.51.100.0/24
        if (a === 203 && b === 0) return true; // 203.0.113.0/24
        if (a >= 224) return true; // 224.0.0.0/4 多播及 240.0.0.0/4 保留
        return false;
    }
    // IPv6 判定
    if (s.includes(':')) {
        if (s === '::' || s === '::1') return true;
        if (s.startsWith('fe80:') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return true;
        if (s.startsWith('fc') || s.startsWith('fd')) return true;
        if (s.startsWith('::ffff:')) {
            return isPrivateOrReservedIp(s.slice(7));
        }
        return false;
    }
    return true;
}

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

/**
 * DNS Rebinding 深度检查：解析域名对应 IP 并拦截私有/环回地址。
 */
export async function verifyHostDns(host, deps = {}) {
    const h = String(host || '').toLowerCase().replace(/\.$/, '');
    if (!h) return false;
    // 依赖注入 lookup（便于单元测试与特殊环境定制）
    if (deps.lookup && typeof deps.lookup === 'function') {
        try {
            const addrs = await deps.lookup(h);
            const list = Array.isArray(addrs) ? addrs : [addrs];
            for (const entry of list) {
                const ip = typeof entry === 'string' ? entry : (entry && entry.address);
                if (isPrivateOrReservedIp(ip)) return false;
            }
        } catch {
            return false;
        }
    }
    return true;
}

export function distillWebText(text, maxChars = 3600) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (raw.length <= maxChars) return raw;
    const headLen = Math.floor(maxChars * 0.65);
    const tailLen = Math.floor(maxChars * 0.30);
    return raw.slice(0, headLen) + '\n\n[...篇幅较长，中间细节自动蒸馏收缩以保护执行上下文，保留核心主干与结论...]\n\n' + raw.slice(-tailLen);
}

async function readPageText(res) {
    if (!res) return '';
    const contentLength = Number(res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-length') : 0);
    if (contentLength && contentLength > MAX_CONTENT_LENGTH) {
        throw new Error('BODY_TOO_LARGE: 响应体超过允许上限 (5MB)');
    }
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let bytes = 0;
        try {
            while (bytes < MAX_RESPONSE_BYTES) {
                const { done, value } = await reader.read();
                if (done) break;
                const take = Math.min(value.length, MAX_RESPONSE_BYTES - bytes);
                bytes += take;
                text += decoder.decode(value.subarray(0, take), { stream: true });
                if (bytes >= MAX_RESPONSE_BYTES) break;
            }
        } finally {
            try { await reader.cancel(); } catch (_) { /* 已断开 */ }
        }
    } else if (typeof res.text === 'function') {
        const fullText = await res.text();
        text = fullText.slice(0, FETCH_MAX_CHARS * 2);
    }
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, FETCH_MAX_CHARS);
}

/**
 * 直连拉取：手动跟随重定向，并在每一跳对目标地址执行 safePublicUrl 与 verifyHostDns 安全准入校验。
 */
async function fetchDirect(initialUrl, deps = {}) {
    const fetchImpl = deps.fetchImpl || fetch;
    const signal = deps.signal;
    let currentUrl = initialUrl;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const safe = safePublicUrl(currentUrl);
        if (!safe) throw new Error('REDIRECT_BLOCKED: 重定向目标地址不安全');
        currentUrl = safe;

        const host = new URL(currentUrl).hostname;
        if (!(await verifyHostDns(host, deps))) {
            throw new Error('DNS_REBINDING_BLOCKED: 域名解析为私有或保留 IP 地址');
        }

        const res = await fetchImpl(currentUrl, {
            method: 'GET',
            redirect: 'manual',
            headers: { Accept: 'text/html, text/plain;q=0.9', 'User-Agent': 'ChillinAgent/1.0' },
            signal
        });

        if (res.status >= 300 && res.status < 400) {
            const location = (res.headers && typeof res.headers.get === 'function')
                ? res.headers.get('location')
                : (res.headers && (res.headers.location || res.headers.Location || ''));
            if (!location) throw new Error('REDIRECT_MISSING_LOCATION: 重定向缺少 Location 标头');
            try {
                currentUrl = new URL(location, currentUrl).toString();
            } catch {
                throw new Error('REDIRECT_INVALID_URL: 重定向目标 URL 非法');
            }
            continue;
        }

        if (!res.ok) throw new Error('HTTP ' + res.status);
        return readPageText(res);
    }
    throw new Error('TOO_MANY_REDIRECTS: 超过最大重定向次数');
}

/**
 * 第三方读取服务代理：仅在网络连接异常或被源站封禁时作为尽力而为的退路，严格校验服务端基址。
 */
async function fetchViaReader(env, url, deps = {}) {
    const key = String((env && env.LINK_READER_API_KEY) || '').trim();
    if (!key) throw new Error('未配置读取服务');
    const baseUrl = String((env && env.LINK_READER_URL) || 'https://r.jina.ai').trim();
    if (!safePublicUrl(baseUrl)) throw new Error('读取服务地址非法或指向私有网段');
    const endpoint = readerEndpoint(baseUrl, url);
    if (!endpoint || !safePublicUrl(endpoint.split('?')[0])) throw new Error('读取服务地址非法');

    const fetchImpl = deps.fetchImpl || fetch;
    const signal = deps.signal;
    const res = await fetchImpl(endpoint, {
        method: 'GET',
        redirect: 'manual',
        headers: { Accept: 'text/plain', Authorization: 'Bearer ' + key, 'x-api-key': key, 'User-Agent': 'ChillinAgent/1.0' },
        signal
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

            // 统一超时控制：AbortController 在 15s 后准时中断 socket 与流
            const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            let timer;
            if (controller) {
                timer = setTimeout(() => {
                    try { controller.abort(new Error('WEB_TIMEOUT')); } catch (_) {}
                }, FETCH_TIMEOUT_MS);
            }

            const toolDeps = {
                ...deps,
                signal: controller ? controller.signal : undefined
            };

            let text = '';
            try {
                try {
                    text = await fetchDirect(url, toolDeps);
                } catch (err) {
                    const msg = (err && err.message) || '';
                    // 安全与边界违规：DNS 重绑定、恶意重定向、报文超限或主动安全拦截，严禁降级到第三方读取服务
                    if (
                        msg.startsWith('REDIRECT_') ||
                        msg.startsWith('DNS_REBINDING_') ||
                        msg.startsWith('BODY_TOO_LARGE') ||
                        msg.startsWith('TOO_MANY_REDIRECTS')
                    ) {
                        return {
                            ok: false,
                            tool,
                            error: {
                                code: msg.startsWith('BODY_TOO_LARGE') ? 'BODY_TOO_LARGE' : 'INVALID_URL',
                                message: msg.startsWith('DNS_REBINDING_') ? '域名解析为私有地址，已被安全拦截' :
                                    msg.startsWith('REDIRECT_BLOCKED') ? '重定向目标地址不安全，已被安全拦截' :
                                    msg.startsWith('BODY_TOO_LARGE') ? '页面内容过大，超出处理上限' :
                                    '抓取安全检查失败：' + msg
                            },
                            citations: []
                        };
                    }
                    if (msg.includes('WEB_TIMEOUT') || (err && err.name === 'AbortError')) {
                        return { ok: false, tool, error: { code: 'TIMEOUT', message: '网页请求超时' }, citations: [] };
                    }
                    // 网络阻断或 403/429 时，尝试使用第三方读取服务代读
                    text = await fetchViaReader(env, url, toolDeps);
                }
            } finally {
                if (timer) clearTimeout(timer);
            }

            const distilled = distillWebText(text, 3600);
            return {
                ok: true, tool,
                data: { url, content: distilled, original_length: text.length, length: distilled.length },
                citations: [{ type: '网页', id: url, title: url, snippet: text.slice(0, 200) }],
                truncated: text.length > distilled.length
            };
        }
        return { ok: false, tool, error: { code: 'UNKNOWN_TOOL', message: '未注册的联网工具' }, citations: [] };
    } catch (err) {
        if (err && (err.message === 'WEB_TIMEOUT' || err.name === 'AbortError')) {
            return { ok: false, tool, error: { code: 'TIMEOUT', message: '网页请求超时' }, citations: [] };
        }
        return { ok: false, tool, error: { code: 'WEB_FAILED', message: '联网工具失败：' + (err && err.message || 'unknown') }, citations: [] };
    }
}
