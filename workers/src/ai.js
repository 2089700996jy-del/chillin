/**
 * AI Chat domain: RAG retrieval, streaming SSE reply and non-streaming reply.
 *
 * Extracted from the gateway so workers/api.js stays a thin router
 * (AGENTS.md: gateway must stay under 300 lines).
 */
import {
    jsonResponse,
    sseResponse,
    checkRateLimitShared,
    rateLimitedResponse,
    readTextCapped
} from './security.js';
import { retrieveGardenMemories, generateFallbackReply, east8NowParts, pad2 } from './rag.js';
import { callCustomLlmStreamWithMessages, callCustomLlmWithMessages, moderateText } from './llm.js';

export async function handleAiChat(request, env, db, userId) {
    const aiLimit = await checkRateLimitShared(db, `ai:${userId}`, 30, 10 * 60 * 1000);
    if (!aiLimit.ok) return rateLimitedResponse(aiLimit.retryAfter);

    // 输入上限：问题 + 历史都是用户可控文本，先限长读取并做字段级裁剪
    const MAX_AI_BODY_BYTES = 256 * 1024;
    const MAX_QUESTION_CHARS = 4000;
    const MAX_HISTORY_MESSAGES = 20;
    const MAX_HISTORY_ITEM_CHARS = 2000;

    const raw = await readTextCapped(request, MAX_AI_BODY_BYTES);
    if (!raw.ok) return jsonResponse({ error: '请求内容过大' }, 413);

    let payload;
    try {
        payload = JSON.parse(raw.text || '{}');
    } catch (_) {
        return jsonResponse({ error: '请求格式错误' }, 400);
    }
    if (!payload || typeof payload !== 'object') return jsonResponse({ error: '请求格式错误' }, 400);

    const stream = payload.stream;
    const question = String(payload.question || '');
    if (!question.trim()) return jsonResponse({ error: '请输入问题' }, 400);
    if (question.length > MAX_QUESTION_CHARS) {
        return jsonResponse({ error: '问题过长，请控制在 ' + MAX_QUESTION_CHARS + ' 字以内' }, 400);
    }
    // 只保留最近若干条、并裁剪单条长度，避免历史被无限灌大
    const history = Array.isArray(payload.history)
        ? payload.history.slice(-MAX_HISTORY_MESSAGES).map((m) => ({
            role: m && m.role === 'assistant' ? 'assistant' : 'user',
            content: String((m && m.content) || '').slice(0, MAX_HISTORY_ITEM_CHARS)
        }))
        : [];

    const rag = await retrieveGardenMemories(db, userId, question, { history });
    const contextText = rag.contextText;
    const sources = rag.sources;

    const now = east8NowParts();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dayOfWeek = weekdays[now.date.getDay()];
    const todayStr = `${now.y}年${now.m + 1}月${now.d}日`;
    // 计算本周与上周的年月日范围 (周一至周日)
    const day = now.date.getDay() || 7;
    const thisMonday = new Date(now.date);
    thisMonday.setDate(now.d - day + 1);
    const thisSunday = new Date(thisMonday);
    thisSunday.setDate(thisMonday.getDate() + 6);
    const lastMonday = new Date(thisMonday);
    lastMonday.setDate(thisMonday.getDate() - 7);
    const lastSunday = new Date(thisMonday);
    lastSunday.setDate(thisMonday.getDate() - 1);

    const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const thisWeekRange = `${fmtDate(thisMonday)} 至 ${fmtDate(thisSunday)}`;
    const lastWeekRange = `${fmtDate(lastMonday)} 至 ${fmtDate(lastSunday)}`;

    const systemPrompt = [
        '你是用户在数字花园 Chillin 中的 AI 记忆助手。',
        `当前基准时间（东八区）：${todayStr} 星期${dayOfWeek}（本周范围：${thisWeekRange}；上周范围：${lastWeekRange}）。`,
        '下面【检索到的记忆片段】已由系统按用户问题做过 RAG 筛选，请【只依据这些片段】回答，不要假设还有未提供的日记全文。',
        '标注“关联”的片段是按 wikilink / 共同标签扩展出来的背景，可辅助理解，但不要把它说成用户直接写过的原话。',
        '若片段为空或不相关，请明确说没有找到相关记忆，不要编造。',
        '回答用温暖简炼的中文；可引用片段中的日期或标题，但不要逐字粘贴过长原文。'
    ].join('\n');

    const sanitizedHistory = (Array.isArray(history) ? history : [])
        .filter(h => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string')
        .slice(-6);

    const messages = [
        { role: 'system', content: `${systemPrompt}\n\n【检索到的记忆片段】:\n${contextText}` },
        ...sanitizedHistory,
        { role: 'user', content: question }
    ];

    if (stream) {
        const readable = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                const push = (obj) => {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                };
                try {
                    push({ type: 'rag', sources, query_tokens: rag.tokens, time_range: rag.timeRange });
                    const streamed = await callCustomLlmStreamWithMessages(env, messages, (chunk) => {
                        const moderated = moderateText(chunk, env);
                        if (moderated.ok && moderated.text) {
                            push({ delta: moderated.text });
                        }
                    });
                    if (!streamed) {
                        const fallback = generateFallbackReply(question, contextText);
                        const moderated = moderateText(fallback, env);
                        push({ delta: moderated.text });
                    }
                } catch (err) {
                    console.error('LLM Stream error:', err);
                    push({ error: '回答处理出错，请重试' });
                } finally {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            }
        });
        return sseResponse(readable, request);
    }

    let reply = '';
    try {
        reply = await callCustomLlmWithMessages(env, messages);
    } catch (err) {
        console.error('LLM Call error:', err);
    }

    if (!reply) {
        reply = generateFallbackReply(question, contextText);
    }

    const moderated = moderateText(reply, env);
    if (!moderated.ok) {
        return jsonResponse({ error: '内容不合规，已拒绝回答' }, 403);
    }

    return jsonResponse({
        reply: moderated.text,
        sources,
        query_tokens: rag.tokens,
        time_range: rag.timeRange
    }, 200);
}
