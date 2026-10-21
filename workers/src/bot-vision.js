/**
 * Bot 看图（Vision）：把微信发来的图片交给多模态模型，换回一句中文描述。
 *
 * v2.5.127 起：DeepSeek 官方端点实测可读图（2026-10-21 线上探针确证：202614 字节 JPEG
 * 1355ms 返回正确中文描述，prompt_tokens 约 960）。
 * 没有密钥、模型报错、超时、内容安全拦截，一律返回空串——存图与回复绝不受影响。
 *
 * v2.5.129 起：提示词由「念标签」改成「朋友随口说一句」（2026-10-21 A/B 实测，真图上
 * 旧词只回标签、新词给出「你开了 ChatGPT 的临时聊天，说不留历史记录，现在对着空输入框发呆呢。」
 * 这种带人称和细节的口气，且不再出现「这张图/画面中」的复述腔）。
 */

import { moderateText } from './llm.js';

const VISION_TIMEOUT_MS = 8000;
const VISION_MAX_TOKENS = 120; // 描述目标 ≤40 字，留一倍余量即可：少生成一点就快一点
const VISION_PROMPT = '你是用户的朋友，刚看到这张图。用一句自然口语的中文说出图里最具体的东西（谁或什么、在做什么、什么氛围），'
    + '像随口聊到那样；只说你看到的，别猜是谁的、别用「你家」「你的」这类归属说法；不要罗列，不要用「这张图」「画面中」这类话，是截图就点出是什么应用、在讲什么；不超过 40 字，只输出这一句。';
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
