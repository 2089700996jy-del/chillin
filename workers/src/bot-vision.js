/**
 * Bot 看图（Vision）：把微信发来的图片交给多模态模型，换回一句中文描述。
 *
 * v2.5.127 起：DeepSeek 官方端点实测可读图（2026-10-21 线上探针确证：202614 字节 JPEG
 * 1355ms 返回正确中文描述，prompt_tokens 约 960）。
 * 没有密钥、模型报错、超时、内容安全拦截，一律返回空串——存图与回复绝不受影响。
 */

import { moderateText } from './llm.js';

const VISION_TIMEOUT_MS = 8000;
const VISION_MAX_TOKENS = 200;
const VISION_PROMPT = '用一句不超过 30 字的中文说这张图里有什么，只输出描述本身。';
const MAX_DESC_CHARS = 120;

/** 字节 → base64（分块 fromCharCode，避免大图撑爆调用栈） */
function bytesToBase64(bytes) {
    let bin = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

/** 看一眼图片，给一句中文描述；拿不到描述就返回空串（调用方照常存图）。 */
export async function describeClawImageContent(env, bytes, mime, fetchImpl = fetch) {
    const apiKey = (env && (env.VISION_API_KEY || env.LLM_API_KEY)) || '';
    if (!apiKey) return '';
    const base = String((env && (env.VISION_API_BASE || env.LLM_API_BASE)) || 'https://api.deepseek.com/v1').replace(/\/$/, '');
    const model = String((env && env.VISION_MODEL) || 'deepseek-chat');
    const signal = (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(VISION_TIMEOUT_MS) : undefined;
    try {
        const res = await fetchImpl(base + '/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
            body: JSON.stringify({
                model,
                temperature: 0.2,
                max_tokens: VISION_MAX_TOKENS,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: VISION_PROMPT },
                        { type: 'image_url', image_url: { url: 'data:' + mime + ';base64,' + bytesToBase64(bytes) } }
                    ]
                }]
            }),
            signal
        });
        if (!res || !res.ok) {
            console.warn('[bot-vision] 图片描述失败 status=' + ((res && res.status) || 0));
            return '';
        }
        const data = await res.json();
        const raw = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        const text = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESC_CHARS);
        if (!text) return '';
        const verdict = moderateText(text, env);
        if (!verdict.ok) {
            console.warn('[bot-vision] 图片描述未通过内容安全检查，已丢弃');
            return '';
        }
        return verdict.text;
    } catch (err) {
        console.warn('[bot-vision] 图片描述异常: ' + (err && err.message));
        return '';
    }
}
