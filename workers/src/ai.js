/**
 * AI Chat 编排层：优先走只读 Agent 工具循环；模型不可用或记录类问题未触发工具时退回 RAG。
 *
 * 阶段 1 的边界：
 * - 只调用 ai-runtime 的只读工具；
 * - 流式接口保留原有 SSE 形状（rag / delta），额外增加 tool 轨迹事件；
 * - 非流式接口额外返回 tool_calls / steps，方便前端和测试审计。
 */
import {
    jsonResponse,
    sseResponse,
    checkRateLimitShared,
    rateLimitedResponse,
    readTextCapped
} from './security.js';
import {
    retrieveGardenMemories,
    generateFallbackReply,
    east8NowParts,
    pad2,
    parseTimeRangeFromQuestion,
    tokenizeQuery
} from './rag.js';
import { callCustomLlmWithMessages, moderateText } from './llm.js';
import { runAgent } from './ai-runtime.js';

function buildRagSystemPrompt() {
    const now = east8NowParts();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const dayOfWeek = weekdays[now.date.getDay()];
    const todayStr = `${now.y}年${now.m + 1}月${now.d}日`;
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

    return [
        '你是用户在数字花园 Chillin 中的 AI 记忆伙伴，性格偏淡、克制平缓（INFP）。',
        `当前基准时间（东八区）：${todayStr} 星期${dayOfWeek}（本周范围：${thisWeekRange}；上周范围：${lastWeekRange}）。`,
        '下面【检索到的记忆片段】已按用户问题做过筛选：',
        '1. 只依据这些片段平缓交谈，没提到的如实说明，不要凭空编造；',
        '2. 标注“关联”的片段是按双链或共同标签扩展出来的背景，作为辅助参考；',
        '3. 表达真实平缓、省字、克制，像老友翻出旧笔记随口说说，不讲大道理，不用波浪号～，少用空洞客套。'
    ].join('\n');
}

async function buildRagAnswer(env, db, userId, question, history) {
    const rag = await retrieveGardenMemories(db, userId, question, { history });
    const sanitizedHistory = (Array.isArray(history) ? history : [])
        .filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        .slice(-6);
    const messages = [
        { role: 'system', content: `${buildRagSystemPrompt()}\n\n【检索到的记忆片段】:\n${rag.contextText}` },
        ...sanitizedHistory,
        { role: 'user', content: question }
    ];

    let reply = '';
    try {
        reply = await callCustomLlmWithMessages(env, messages);
    } catch (err) {
        console.error('[ai] RAG fallback model call failed:', err && err.message ? err.message : err);
    }
    if (!reply) reply = generateFallbackReply(question, rag.contextText);
    return { reply, sources: rag.sources };
}

function chunkText(text, size = 48) {
    const chunks = [];
    const raw = String(text || '');
    for (let i = 0; i < raw.length; i += size) chunks.push(raw.slice(i, i + size));
    return chunks;
}

function fallbackPayload(result, fallback, force = false) {
    if (result && result.reply && !force) return result;
    return {
        ...result,
        reply: fallback.reply,
        sources: result && result.sources && result.sources.length ? result.sources : fallback.sources
    };
}

/**
 * 记录类问题如果没有触发任何工具，模型很可能是凭常识猜的。
 * 这里不信任这种回答，直接退回 RAG，确保至少基于真实数据。
 */
export function needsRecordEvidence(question) {
    return /(我|我的|自己)[^。！？]{0,24}(记录|笔记|周记|随手记|收藏|提示词|想法|写过|写了|记过)|(最近|近期|之前|过去)[^。！？]{0,16}(记录|笔记|周记|随手记|收藏|想法|主题)/.test(String(question || ''));
}

export async function handleAiChat(request, env, db, userId) {
    env = env || {};
    const aiLimit = await checkRateLimitShared(db, `ai:${userId}`, 30, 10 * 60 * 1000);
    if (!aiLimit.ok) return rateLimitedResponse(aiLimit.retryAfter);

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

    const stream = Boolean(payload.stream);
    const question = String(payload.question || '');
    if (!question.trim()) return jsonResponse({ error: '请输入问题' }, 400);
    if (question.length > MAX_QUESTION_CHARS) {
        return jsonResponse({ error: '问题过长，请控制在 ' + MAX_QUESTION_CHARS + ' 字以内' }, 400);
    }

    const history = Array.isArray(payload.history)
        ? payload.history.slice(-MAX_HISTORY_MESSAGES).map((item) => ({
            role: item && item.role === 'assistant' ? 'assistant' : 'user',
            content: String((item && item.content) || '').slice(0, MAX_HISTORY_ITEM_CHARS)
        }))
        : [];

    const canUseAgent = Boolean(env && env.LLM_API_KEY);
    const queryTokens = tokenizeQuery(question);
    const timeRange = parseTimeRangeFromQuestion(question);

    const execute = async (onEvent) => {
        let result = null;
        if (canUseAgent) {
            try {
                result = await runAgent({ env, db, userId, question, history, onEvent });
            } catch (err) {
                console.error('[ai] agent run failed:', err && err.message ? err.message : err);
            }
        }
        const noEvidence = needsRecordEvidence(question) && Number(result && result.toolCalls ? result.toolCalls : 0) === 0;
        if (!result || !result.reply || result.stopReason === 'model_error' || result.stopReason === 'timeout' || noEvidence) {
            const fallback = await buildRagAnswer(env, db, userId, question, history);
            result = fallbackPayload(result, fallback, noEvidence);
        }
        return result;
    };

    if (stream) {
        const readable = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                const push = (obj) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
                try {
                    const result = await execute((event) => push(event));
                    if (Array.isArray(result.sources) && result.sources.length) {
                        push({ type: 'rag', sources: result.sources, query_tokens: queryTokens, time_range: timeRange });
                    }
                    if (Array.isArray(result.toolTrace)) {
                        push({
                            type: 'agent',
                            steps: result.steps || 0,
                            tool_calls: result.toolTrace.length,
                            stop_reason: result.stopReason || 'final'
                        });
                    }
                    const moderated = moderateText(result.reply, env);
                    if (!moderated.ok) {
                        push({ error: '内容不合规，已拒绝回答' });
                    } else {
                        for (const delta of chunkText(moderated.text)) push({ delta });
                    }
                } catch (err) {
                    console.error('[ai] stream error:', err && err.message ? err.message : err);
                    push({ error: '回答处理出错，请重试' });
                } finally {
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'));
                    controller.close();
                }
            }
        });
        return sseResponse(readable, request);
    }

    const result = await execute(null);
    const moderated = moderateText(result.reply, env);
    if (!moderated.ok) return jsonResponse({ error: '内容不合规，已拒绝回答' }, 403);
    return jsonResponse({
        reply: moderated.text,
        sources: result.sources || [],
        query_tokens: queryTokens,
        time_range: timeRange,
        tool_calls: Array.isArray(result.toolTrace) ? result.toolTrace : [],
        steps: result.steps || 0,
        stop_reason: result.stopReason || 'final',
        citation_count: result.citationCount || 0
    }, 200);
}
