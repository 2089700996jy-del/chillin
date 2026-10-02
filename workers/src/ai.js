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
    rateLimitedResponse
} from './security.js';
import { retrieveGardenMemories, generateFallbackReply } from './rag.js';
import { callCustomLlmStreamWithMessages, callCustomLlmWithMessages, moderateText } from './llm.js';

export async function handleAiChat(request, env, db, userId) {
    const aiLimit = await checkRateLimitShared(db, `ai:${userId}`, 30, 10 * 60 * 1000);
    if (!aiLimit.ok) return rateLimitedResponse(aiLimit.retryAfter);

    const { question, stream, history } = await request.json();
    if (!question) return jsonResponse({ error: '请输入问题' }, 400);

    const rag = await retrieveGardenMemories(db, userId, question, { history });
    const contextText = rag.contextText;
    const sources = rag.sources;

    const systemPrompt = [
        '你是用户在数字花园 Chillin 中的 AI 记忆助手。',
        '下面【检索到的记忆片段】已由系统按用户问题做过 RAG 筛选，请【只依据这些片段】回答，不要假设还有未提供的日记全文。',
        '若片段为空或不相关，请明确说没有找到相关记忆，不要编造。',
        '回答用温暖简炼的中文；可引用片段中的日期或标题，但不要逐字粘贴过长原文。'
    ].join('');

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
