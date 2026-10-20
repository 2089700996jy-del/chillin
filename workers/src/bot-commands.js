/**
 * Bot 大脑：微信 ClawBot（iLink 协议）的消息分流与对话编排。
 *
 * 传输层（长轮询 / 回复）独立在 bot-claw.js；这一层回答一个问题：
 * 用户发来一段文字，该回什么 markdown，以及要不要动数据。
 *
 * 私人伴侣的四条底线（与 AGENTS.md 并列生效）：
 *   1. **默认无副作用**——普通聊天只产生回复，绝不写库；写入只有确定性的显式指令一条路，
 *      宁可少记、不可错记。
 *   2. 三层记忆各司其职：当前对话（bot-memory）→ 个人档案（bot-memory）→ 花园事实（rag）。
 *   3. 脚注只在「真的动了数据」或「引用了花园证据」时出现。
 *   4. 聊天正文永不进日志（只记 id 与错误信息）。
 *
 * 指令（确定性正则，先垫一层）：
 *   帮助 / 记录：X / 记住：X / 忘记 X / 你记得我什么 / 搜 X / 问 X / 重置对话
 * 其余一律走对话模型：温和、陪伴、多共情，不做任何持久化。
 */

import { handlePostFeed } from './garden-resources.js';
import { retrieveGardenMemories, generateFallbackReply } from './rag.js';
import { callCustomLlm, callCustomLlmWithMessages, moderateText } from './llm.js';
import { checkRateLimitShared } from './security.js';
import {
    saveChatTurn, loadChatContext, clearChatContext,
    addProfileItem, listProfile, forgetProfile, clearProfile, loadProfilePrompt,
    PROFILE_MAX_ITEMS, PROFILE_ITEM_MAX_CHARS
} from './bot-memory.js';

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
    '**Chillin 小助手**',
    '',
    '- 直接跟我说话：聊天、倾诉、问问题都行',
    '- 「记录：内容」：把内容存进**随手记**',
    '- 「记住：内容」：写进「关于我」，以后都记得',
    '- 「搜 关键词」：翻花园里的历史记录',
    '- 「问 问题」：结合你的记忆回答',
    '- 「你记得我什么」：查看「关于我」档案',
    '- 「忘记 关键词」：从档案里删掉这一条',
    '- 「重置对话」：清空我们这次的对话上下文',
    '- 「帮助」：显示这条说明'
].join('\n');

/**
 * 明确的数据写入指令：返回要保存的内容，未命中返回 null。
 * 「记录一下」「记一下」「存一下」自带明确的动作语义，后面可省分隔符；
 * 光杆「记录」「随手记」则必须跟分隔符，避免把「记录了这件事」这类叙述误判成指令。
 */
const RECORD_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:(?:记录一下|记一下|存一下)[\s:：]*|(?:记录|随手记|\/feed|\/note)[\s:：]+)([\s\S]+)$/i;
/** 档案写入指令（「记住」动作唯一，允许省分隔符，但内容至少两个字） */
const REMEMBER_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:记住|记牢|\/remember)[\s:：]*([\s\S]+)$/i;
/** 档案遗忘指令 */
const FORGET_RE = /^(?:忘记|忘掉|\/forget)[\s:：]*([\s\S]+)$/i;
const FORGET_ALL_RE = /^(?:忘记全部|清空档案|清空关于我|\/forgetall)$/i;
const PROFILE_VIEW_RE = /^(?:你记得我什么|你记住了我什么|我的档案|查看档案|\/profile)$/i;
const RESET_RE = /^(?:重置对话|清空对话|重置上下文|清空上下文|\/reset|\/clear)$/i;
const HELP_RE = /^(?:帮助|help|\/help|\?|？)$/i;

export function parseRecordCommand(text) {
    const m = RECORD_RE.exec(String(text || '').trim());
    const body = m ? m[1].trim() : '';
    return body || null;
}

export function parseRememberCommand(text) {
    const m = REMEMBER_RE.exec(String(text || '').trim());
    const body = m ? m[1].trim() : '';
    return body.length >= 2 ? body : null;
}

export function parseForgetCommand(text) {
    const raw = String(text || '').trim();
    if (FORGET_ALL_RE.test(raw)) return { all: true, keyword: '' };
    const m = FORGET_RE.exec(raw);
    const keyword = m ? m[1].trim() : '';
    return keyword ? { all: false, keyword } : null;
}

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

/** 东八区当前时间（提示词里给模型一个时间锚点） */
function nowInEast8() {
    const s = new Date(Date.now() + 8 * 3600 * 1000).toISOString();
    return s.slice(0, 10) + ' ' + s.slice(11, 16);
}

function formatSources(sources) {
    return sources.map((s, i) => (i + 1) + '. [' + s.type + '] ' + (s.title ? s.title + ' · ' : '')
        + s.date + '\n   ' + s.snippet).join('\n');
}

export async function runSearch(db, userId, query) {
    const history = await loadChatContext(db, userId);
    const memory = await retrieveGardenMemories(db, userId, query, { topK: 6, maxChars: 1400, history });
    const sources = memory.sources || [];
    if (!sources.length) return '没有检索到与「' + query + '」相关的记录。';
    return '**检索「' + query + '」** · 命中 ' + sources.length + ' 条\n\n' + formatSources(sources);
}

export async function runAsk(env, db, userId, question) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '提问太频繁了，请 ' + (limit.retryAfter || 60) + ' 秒后再试。';

    const history = await loadChatContext(db, userId);
    const memory = await retrieveGardenMemories(db, userId, question, { topK: 6, maxChars: 1600, history });
    const systemPrompt = '你是用户在数字花园 Chillin 里的 AI 记忆助手。请只依据给出的记忆片段回答，'
        + '片段不足以回答时如实说明，不要编造。用简炼、温和的中文，可用 markdown。';
    const userPrompt = '用户提问：' + question + '\n\n相关记忆片段：\n' + memory.contextText;
    let answer = '';
    try {
        answer = await callCustomLlm(env, systemPrompt, userPrompt);
    } catch (err) {
        console.error('[bot] 大模型调用失败: ' + (err && err.message));
    }
    if (!answer) answer = generateFallbackReply(question, memory.contextText);
    const moderated = moderateText(answer, env);
    if (!moderated.ok) return '回答未通过内容安全检查，已拒绝输出。';
    const sources = memory.sources || [];
    if (!sources.length) return moderated.text;
    return moderated.text + '\n\n---\n依据：'
        + sources.slice(0, 3).map(s => '[' + s.type + '] ' + (s.title || s.date)).join('、');
}

/** 聊天人格与边界：默认路径，只说话、不动数据 */
const CHAT_SYSTEM_PROMPT = [
    '你是 Chillin，用户私人数字花园里的陪伴型助手，此刻正通过微信和他/她聊天。',
    '说话温和、口语化，像一个熟悉的、靠得住的朋友：先接住对方的情绪，再回应内容。',
    '不要用「已完成任务」「已为您处理」这类机器人腔，也不要每次都总结或给建议。',
    '',
    '【边界，必须遵守】',
    '1. 你不是存储工具。除非对方用了明确的指令（「记录：…」「记住：…」），否则不要声称已经保存、已经记住任何东西。',
    '2. 如果对方明显希望你记下什么却没说指令，就温和地问一句要不要记，并告诉他怎么发（例如「想存的话发：记录：<内容>」）——由对方决定，你不要自己写。',
    '3. 只依据【花园记忆片段】陈述过去发生的事；片段没提到的就说没找到，绝不编造。',
    '4. 不了解、不确定的事就说不了解、不确定，不要假装知道。',
    '5. 对方倾诉时先共情，不急着评价、不急着给方案；对方没问的时候不要分析利弊。',
    '6. 篇幅克制：通常 150 字以内，除非对方明确要长回答。用中文，可以少量 markdown。'
].join('\n');

async function runChat(env, db, userId, text, history) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '聊得有点快，缓 ' + (limit.retryAfter || 60) + ' 秒我们再接着聊。';

    const memory = await retrieveGardenMemories(db, userId, text, { topK: 4, maxChars: 1200, history });
    const sources = memory.sources || [];

    const blocks = [CHAT_SYSTEM_PROMPT, '现在是 ' + nowInEast8() + '（东八区）。'];
    const profile = await loadProfilePrompt(db, userId);
    if (profile) blocks.push('【关于我（用户自述，只作参考，不得据此编造人格标签）】\n' + profile);
    if (memory.contextText) blocks.push('【花园记忆片段（历史事实，只作证据，不要复述无关内容）】\n' + memory.contextText);

    const messages = [{ role: 'system', content: blocks.join('\n\n') }];
    for (const turn of history) messages.push({ role: turn.role, content: turn.content });
    messages.push({ role: 'user', content: text });

    let answer = '';
    try {
        answer = await callCustomLlmWithMessages(env, messages);
    } catch (err) {
        console.error('[bot] 聊天模型调用失败: ' + (err && err.message));
    }
    if (!answer) {
        answer = sources.length
            ? generateFallbackReply(text, memory.contextText)
            : '嗯，我在。想聊什么都可以，或者发「记录：…」我把内容存进花园。';
    }
    const moderated = moderateText(answer, env);
    if (!moderated.ok) return '这个话题我不太方便展开，我们换个轻松的聊？';
    if (!sources.length) return moderated.text;
    return moderated.text + '\n\n---\n依据：'
        + sources.slice(0, 3).map(s => '[' + s.type + '] ' + (s.title || s.date)).join('、');
}

async function runRecord(db, userId, content) {
    const feed = content.slice(0, MAX_FEED_CHARS);
    if (!(await saveFeed(db, userId, feed))) return '保存失败了，稍后再试一次？';
    const preview = feed.length > 160 ? feed.slice(0, 160) + '…' : feed;
    return '已存入**随手记** ✅\n\n> ' + preview.replace(/\n/g, '\n> ');
}

async function runRemember(db, userId, content) {
    const item = content.slice(0, PROFILE_ITEM_MAX_CHARS);
    const res = await addProfileItem(db, userId, item);
    if (!res.ok) return '这条我没能记下来（存储临时不可用），稍后再试一次。';
    if (res.duplicate) return '这条我已经记得了 🙂';
    return '好，我记住了：\n\n> ' + item.replace(/\n/g, '\n> ')
        + '\n\n以后想删掉，就发「忘记 <关键词>」。';
}

async function runProfileView(db, userId) {
    const items = await listProfile(db, userId);
    if (!items.length) return '我这儿还没有你的档案。发「记住：…」我就会开始记。';
    const shown = items.slice(0, PROFILE_MAX_ITEMS)
        .map((it, i) => (i + 1) + '. ' + (it.label ? it.label + '：' : '') + it.content).join('\n');
    return '**关于我**（' + items.length + ' 条）\n\n' + shown + '\n\n要删哪条就发「忘记 <关键词>」。';
}

async function runForget(db, userId, req) {
    const res = req.all ? await clearProfile(db, userId) : await forgetProfile(db, userId, req.keyword);
    if (!res.removed) return '档案里没有匹配「' + req.keyword + '」的条目。发「你记得我什么」能看全部。';
    return req.all ? ('整份档案已清空，忘了 ' + res.removed + ' 条。') : ('已忘记 ' + res.removed + ' 条。');
}

/** 已支持的显式指令；返回 null 表示「不是指令」，交给对话模型 */
export async function runCommand(env, db, userId, content) {
    const text = String(content || '').trim();
    if (HELP_RE.test(text)) return BOT_HELP_TEXT;
    if (PROFILE_VIEW_RE.test(text)) return runProfileView(db, userId);

    const forget = parseForgetCommand(text);
    if (forget) return runForget(db, userId, forget);

    const remember = parseRememberCommand(text);
    if (remember) return runRemember(db, userId, remember);

    const record = parseRecordCommand(text);
    if (record) return runRecord(db, userId, record);

    const searchCmd = text.match(/^(?:搜|搜索|search|find)[\s:：]+([\s\S]+)$/i);
    if (searchCmd) return runSearch(db, userId, searchCmd[1].trim());

    const askCmd = text.match(/^(?:问|ask|\/ai)[\s:：]+([\s\S]+)$/i);
    if (askCmd) return runAsk(env, db, userId, askCmd[1].trim());

    return null;
}

/**
 * 统一入口：给一段用户文本，返回该回复的 markdown。
 * 指令命中就执行指令；否则默认走聊天——聊天路径不写任何业务数据。
 */
export async function buildBotReply(env, db, userId, content) {
    const text = String(content || '').trim();
    if (!text) return '';

    // 重置对话：清空上下文，这条指令本身不留在上下文里
    if (RESET_RE.test(text)) {
        await clearChatContext(db, userId);
        return '好，我们这次的对话上下文已经清空 ✨ 个人档案和花园记录都不受影响。';
    }

    const commandReply = await runCommand(env, db, userId, text);
    if (commandReply !== null) {
        // 帮助只是使用说明，不必占用对话上下文
        if (!HELP_RE.test(text)) {
            await saveChatTurn(db, userId, 'user', text);
            await saveChatTurn(db, userId, 'assistant', commandReply);
        }
        return commandReply;
    }

    const history = await loadChatContext(db, userId);
    const reply = await runChat(env, db, userId, text, history);
    await saveChatTurn(db, userId, 'user', text);
    await saveChatTurn(db, userId, 'assistant', reply);
    return reply;
}
