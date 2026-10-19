/**
 * Bot 指令层：微信 ClawBot（iLink 协议）的消息分流大脑。
 *
 * 传输层（长轮询 / 回复）独立在 bot-claw.js；这里只回答一个问题：
 * 用户发来一段文字，该回什么 markdown。
 *   - 帮助 / help       -> 使用说明
 *   - 搜 X / search X   -> 检索花园记忆
 *   - 问 X / ask X      -> 结合记忆问大模型
 *   - 其余文本与链接     -> 存入随手记（quick_feeds）
 *
 * 写库/检索/回答全部复用既有模块（garden-resources / rag / llm），本层不重造轮子。
 */

import { handlePostFeed } from './garden-resources.js';
import { retrieveGardenMemories, generateFallbackReply } from './rag.js';
import { callCustomLlm, moderateText } from './llm.js';
import { checkRateLimitShared } from './security.js';

/** 单条回复上限（UTF-8 字节）。微信侧单条消息更短，这里统一留余量 */
export const MAX_REPLY_BYTES = 20000;
/** 同一条消息 10 分钟内只处理一次：上游可能重复投递 */
export const BOT_MSG_TTL_MS = 10 * 60 * 1000;
/** 每人 10 分钟最多问 20 次 AI，避免刷爆上游大模型配额 */
export const BOT_AI_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };
/** 一条随手记最多收 4000 字（远小于 CRUD 的 512KB 上限） */
export const MAX_FEED_CHARS = 4000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BOT_HELP_TEXT = [
    '**Chillin 助手**',
    '',
    '- 直接发文字或链接：存入**随手记**',
    '- 「搜 关键词」：检索花园里的历史记录',
    '- 「问 问题」：结合你的记忆回答',
    '- 「帮助」：显示这条说明'
].join('\n');

/** 按字节截断，且保证结果不超过 maxBytes（先扣掉省略号本身） */
export function truncateUtf8(text, maxBytes) {
    const source = String(text);
    const bytes = encoder.encode(source);
    if (bytes.length <= maxBytes) return source;
    const ellipsisBytes = encoder.encode('…').length;
    return decoder.decode(bytes.subarray(0, maxBytes - ellipsisBytes)).replace(/\uFFFD+$/, '') + '…';
}

/** 解析逗号分隔的白名单，留空表示不限制 */
export function parseImUserList(value) {
    return String(value || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** 消息排重：第一次见到返回 true，重复投递返回 false */
export async function claimBotMessage(db, key) {
    if (!db || !key) return true;
    const seen = await checkRateLimitShared(db, 'bot-msg:' + key, 1, BOT_MSG_TTL_MS);
    return seen.ok;
}

/** 存进随手记：复用既有 CRUD handler，等价于前端调 POST /api/feeds */
export async function saveFeed(db, userId, content) {
    const res = await handlePostFeed(new Request('https://chillin.internal/api/feeds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content })
    }), db, userId);
    if (!res.ok) console.error('[bot] 存随手记失败 status=' + res.status);
    return res.ok;
}

function formatSources(sources) {
    return sources.map((s, i) => (i + 1) + '. [' + s.type + '] ' + (s.title ? s.title + ' · ' : '')
        + s.date + '\n   ' + s.snippet).join('\n');
}

export async function runSearch(db, userId, query) {
    const memory = await retrieveGardenMemories(db, userId, query, { topK: 6, maxChars: 1400 });
    const sources = memory.sources || [];
    if (!sources.length) return '没有检索到与「' + query + '」相关的记录。';
    return '**检索「' + query + '」** · 命中 ' + sources.length + ' 条\n\n' + formatSources(sources);
}

export async function runAsk(env, db, userId, question) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '提问太频繁了，请 ' + (limit.retryAfter || 60) + ' 秒后再试。';

    const memory = await retrieveGardenMemories(db, userId, question, { topK: 6, maxChars: 1600 });
    const systemPrompt = '你是用户在数字花园 Chillin 里的 AI 记忆助手。请只依据给出的记忆片段回答，'
        + '片段不足以回答时如实说明，不要编造。用简炼、温和的中文，可用 markdown。';
    const userPrompt = '用户提问：' + question + '\n\n相关记忆片段：\n' + memory.contextText;
    let answer = '';
    try {
        answer = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('[bot] 大模型调用失败:', err && err.message);
    }
    if (!answer) answer = generateFallbackReply(question, memory.contextText);
    const moderated = moderateText(answer, env);
    if (!moderated.ok) return '回答未通过内容安全检查，已拒绝输出。';
    const sources = memory.sources || [];
    if (!sources.length) return moderated.text;
    return moderated.text + '\n\n---\n依据：'
        + sources.slice(0, 3).map(s => '[' + s.type + '] ' + (s.title || s.date)).join('、');
}

/** 已支持的指令；返回 null 表示「不是指令」，按随手记处理 */
export async function runCommand(env, db, userId, content) {
    if (/^(?:帮助|help|\/help|\?|？)$/i.test(content)) return BOT_HELP_TEXT;

    const searchCmd = content.match(/^(?:搜|搜索|search|find)[\s:：]+([\s\S]+)$/i);
    if (searchCmd) return runSearch(db, userId, searchCmd[1].trim());

    const askCmd = content.match(/^(?:问|ask|\/ai)[\s:：]+([\s\S]+)$/i);
    if (askCmd) return runAsk(env, db, userId, askCmd[1].trim());

    return null;
}

/** 指令分流 + 落库的统一入口：给一段用户文本，返回该回复的 markdown */
export async function buildBotReply(env, db, userId, content) {
    const commandReply = await runCommand(env, db, userId, content);
    if (commandReply !== null) return commandReply;

    const feed = content.slice(0, MAX_FEED_CHARS);
    if (!(await saveFeed(db, userId, feed))) return '保存失败，请稍后再试。';
    const preview = feed.length > 160 ? feed.slice(0, 160) + '…' : feed;
    return '已存入**随手记** ✅\n\n> ' + preview.replace(/\n/g, '\n> ');
}
