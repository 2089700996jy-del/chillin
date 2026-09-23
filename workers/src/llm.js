/**
 * LLM (DeepSeek / Cloudflare Workers AI) Integration & Content Moderation
 */

export const MODERATE_HARD_RE = /色情|裸聊|黄播|约炮|嫖娼|卖淫|赌博|博彩|赌场|六合彩|毒品|制毒|贩毒|枪支|弹药|爆炸物|杀人|血腥|暴力恐吓/i;
export const MODERATE_SOFT_RE = /加微信|加微|微信号|扫码进群|QQ群|刷单|代发|兼职日结|网赚|返利|引流|微商代理|传销|贷款办卡|代开发票/i;

export function moderateText(text, env) {
    if (!text) return { ok: true, text };
    let hard = MODERATE_HARD_RE;
    const political = (env && env.MODERATION_POLITICAL_WORDS) ? String(env.MODERATION_POLITICAL_WORDS).trim() : '';
    if (political) {
        const p = political.split(/[,，]/).map(s => s.trim()).filter(Boolean).join('|');
        if (p) hard = new RegExp(`${MODERATE_HARD_RE.source}|${p}`, 'i');
    }
    if (hard.test(text)) return { ok: false, text: '' };
    return { ok: true, text: text.replace(MODERATE_SOFT_RE, '****') };
}

export async function callCustomLlmStreamWithMessages(env, messages, onChunk) {
    const apiBase = env.LLM_API_BASE || 'https://api.deepseek.com/v1';
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL || 'deepseek-chat';

    if (apiKey) {
        const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7,
                stream: true
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Custom LLM API error (${res.status}): ${errText}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let hasData = false;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith(':')) continue;
                if (trimmed === 'data: [DONE]') break;
                if (trimmed.startsWith('data: ')) {
                    try {
                        const json = JSON.parse(trimmed.slice(6));
                        const content = json.choices?.[0]?.delta?.content;
                        if (content) {
                            hasData = true;
                            onChunk(content);
                        }
                    } catch {}
                }
            }
        }
        return hasData;
    }

    if (env.AI) {
        const aiRes = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
            messages
        });
        if (aiRes.response) {
            onChunk(aiRes.response);
            return true;
        }
    }

    return false;
}

export async function callCustomLlmWithMessages(env, messages) {
    const apiBase = env.LLM_API_BASE || 'https://api.deepseek.com/v1';
    const apiKey = env.LLM_API_KEY;
    const model = env.LLM_MODEL || 'deepseek-chat';

    if (apiKey) {
        const url = `${apiBase.replace(/\/$/, '')}/chat/completions`;
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model,
                messages,
                temperature: 0.7
            })
        });

        if (!res.ok) {
            const errText = await res.text();
            throw new Error(`Custom LLM API error (${res.status}): ${errText}`);
        }

        const data = await res.json();
        if (data.choices && data.choices[0] && data.choices[0].message) {
            return data.choices[0].message.content;
        }
    }
    return '';
}

export async function callCustomLlm(env, systemPrompt, userPrompt) {
    return callCustomLlmWithMessages(env, [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
    ]);
}
