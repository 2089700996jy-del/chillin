/**
 * Bot 看图（Vision）：快速识图 / 深度看图两种模式。
 *
 * 快速识图（默认）：一张图一句自然口语，最多 120 字；多图逐张看，尽量不拖慢回信。
 * 深度看图：用户带问题（表格、图表、截图、共同问题、对比、关系……）时，把所有图一起交给模型，
 * 让它先回答再给依据；没把握就说不确定，绝不编造。
 *
 * 安全边界不变：没有密钥、模型报错、超时、内容安全拦截一律返回空串——
 * 存图与回复绝不受影响；日志只记状态，不记图片正文。
 */

import { moderateText } from './llm.js';

const VISION_TIMEOUT_MS = 8000;
const VISION_DEEP_TIMEOUT_MS = 20000;
const VISION_MAX_TOKENS = 120; // 单图快速描述 ≤40 字，留一倍余量即可：少生成一点就快一点
const VISION_DEEP_MAX_TOKENS = 1200;
const VISION_PROMPT = '你是用户的朋友，刚看到这张图。用一句自然口语的中文说出图里最具体的东西（谁或什么、在做什么、什么氛围），'
    + '像随口聊到那样；只说你看到的，别猜是谁的、别用「你家」「你的」这类归属说法；不要罗列，不要用「这张图」「画面中」这类话，是截图就点出是什么应用、在讲什么；不超过 40 字，只输出这一句。';
const VISION_DEEP_PROMPT = '你是用户的朋友，用户发来几张图并问了一个问题。先直接回答用户的问题，再给关键依据；'
    + '如果图里有表格，按行列读出关键数字和异常；如果是图表，说明趋势、对比和可能的异常；'
    + '如果是多张截图，指出它们的共同点、差异、前后关系或共同问题。'
    + '只依据图里能看到的，不确定就直说不确定，绝不编造数字、人名或结论；用中文口语，条理清楚，不要复述「这张图/画面中」，不超过 600 字。';
const MAX_DESC_CHARS = 120;
const MAX_FAST_MULTI_CHARS = 600;
const MAX_DEEP_CHARS = 1200;
const MAX_IMAGES = 6;

/** 字节 → base64（分块 fromCharCode，避免大图撑爆调用栈） */
function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/**
 * 是否值得走深度看图。只做确定性关键词判断，不额外调模型：
 * 「分析/表格/图表/截图/共同/关系/对比/解释…」直接深度；普通问句带图也深度；
 * 「快速/简单/大概」明确要求快时仍走快速。
 */
export function isDeepVisionQuestion(text) {
    const s = String(text || '').trim();
    if (!s) return false;
    if (/^(?:快速|简单|大概|粗略)(?:看|说|描述|讲)/.test(s)) return false;
    if (/(仔细|认真|深入|深度|分析|解读|解释|读懂|读一下|看一下|看看|对比|比较|区别|差异|共同|关系|关联|表格|图表|数据|截图|总结|梳理|问题|哪里|为什么|怎么|如何|哪张|这几张|这些图|图中|图里)/.test(s)) return true;
    return /[?？]/.test(s) && /(图|照片|截图|这张|这几张)/.test(s);
}

function buildContent(images, prompt) {
    const content = [{ type: 'text', text: prompt }];
    images.forEach((image, i) => {
        if (images.length > 1) content.push({ type: 'text', text: '第' + (i + 1) + '张：' });
        content.push({
            type: 'image_url',
            image_url: { url: 'data:' + image.mime + ';base64,' + bytesToBase64(image.bytes) }
        });
    });
    return content;
}

/**
 * 看图统一入口。
 * @param {object} env
 * @param {Array<{bytes: Uint8Array, mime: string}>} images
 * @param {{mode?: 'fast'|'deep', question?: string, fetchImpl?: Function, timeoutMs?: number}} options
 * @returns {Promise<string>} 失败一律空串
 */
export async function analyzeClawImages(env, images, options = {}) {
    const list = (Array.isArray(images) ? images : [])
        .filter(image => image && image.bytes && image.mime)
        .slice(0, MAX_IMAGES);
    if (!list.length) return '';
    const apiKey = (env && (env.VISION_API_KEY || env.LLM_API_KEY)) || '';
    if (!apiKey) return '';
    const question = String(options.question || '').trim();
    const deep = options.mode === 'deep' || isDeepVisionQuestion(question);
    // 快速多图：逐张并行看，回信最多等最慢的一张；深度多图：一次带上全部图，模型能比较关系。
    if (!deep && list.length > 1) {
        const parts = await Promise.all(list.map(image => analyzeClawImages(env, [image], {
            mode: 'fast',
            fetchImpl: options.fetchImpl
        })));
        return parts.filter(Boolean).map((part, i) => (i + 1) + '. ' + part).join('\n').slice(0, MAX_FAST_MULTI_CHARS);
    }
    const base = String((env && (env.VISION_API_BASE || env.LLM_API_BASE)) || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const model = String((env && env.VISION_MODEL) || 'deepseek-flash');
    const timeout = Number(options.timeoutMs) > 0
        ? Number(options.timeoutMs)
        : (Number(env && env.VISION_TIMEOUT_MS) > 0 ? Number(env.VISION_TIMEOUT_MS) : (deep ? VISION_DEEP_TIMEOUT_MS : VISION_TIMEOUT_MS));
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(timeout) : undefined;
    const prompt = deep
        ? VISION_DEEP_PROMPT + (question ? '\n用户的问题：' + question : '')
        : VISION_PROMPT;
    const maxChars = deep ? MAX_DEEP_CHARS : (list.length > 1 ? MAX_FAST_MULTI_CHARS : MAX_DESC_CHARS);
    try {
        const res = await (options.fetchImpl || fetch)(base + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({
                model,
                temperature: deep ? 0.3 : 0.2,
                // 看图不思考：thinking 会拖慢超时窗口，也会让 temperature 失效
                thinking: { type: 'disabled' },
                max_tokens: deep ? VISION_DEEP_MAX_TOKENS : (list.length > 1 ? VISION_MAX_TOKENS * list.length : VISION_MAX_TOKENS),
                messages: [{ role: 'user', content: buildContent(list, prompt) }]
            }),
            signal
        });
        if (!res || !res.ok) {
            console.warn('[bot-vision] 图片分析失败 status=' + ((res && res.status) || 0));
            return '';
        }
        const data = await res.json();
        const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, maxChars);
        if (!text) return '';
        const verdict = moderateText(text, env);
        if (!verdict.ok) {
            console.warn('[bot-vision] 图片分析未通过内容安全检查，已丢弃');
            return '';
        }
        return verdict.text;
    } catch (err) {
        console.warn('[bot-vision] 图片分析异常: ' + (err && err.message));
        return '';
    }
}

/** 看一眼图片，给一句中文描述；拿不到描述就返回空串（调用方照常存图）。 */
export async function describeClawImageContent(env, bytes, mime, fetchImpl = fetch) {
    return analyzeClawImages(env, [{ bytes, mime }], { mode: 'fast', fetchImpl });
}
