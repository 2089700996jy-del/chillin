/**
 * Bot 大脑：微信 ClawBot（iLink 协议）的消息分流与对话编排。
 *
 * 传输层（长轮询 / 回复）独立在 bot-claw.js；这一层回答一个问题：
 * 用户发来一段文字，该回什么 markdown，以及要不要动数据。
 *
 * 朋友式助手的四条底线（与 AGENTS.md 并列生效）：
 *   1. **默认不写花园**——普通聊天只写短期对话上下文（bot-memory 最近 8 轮 / 约 2400 字符，供下一句衔接），绝不写随手记；
 *      长期写入只有确定性的显式指令一条路，宁可少记、不可错记。
 *   2. 三层记忆各司其职：当前对话（bot-memory）→ 个人档案（bot-memory）→ 花园事实（rag）。
 *   3. 脚注只在「真的动了数据」或「用户主动索要依据」时出现——默认聊天保持干净，
 *      且来源标签统一成 `[类型] YYYY-MM-DD`（标题重复日期时不重复展示）。
 *   4. 聊天正文永不进日志（只记 id 与错误信息）。
 *
 * 指令（确定性正则，先垫一层）：
 *   帮助 / 记录：X / 收藏：X / 提示词：X / 我的收藏 / 改收藏 3 / 删收藏 3 / 偏好 / 确认 / 取消 / 记住：X / 忘记 X / 你记得我什么 / 搜 X / 问 X / 重置对话
 *   光杆「记录」= 确认把刚才暂存的图片/链接写进随手记（消息默认不落库，见 bot-media.js / bot-links.js）
 *   小宇宙链接 = 抓 title/cover 做速览（只认白名单域名），回「记录」才落成富链接卡片
 * 其余一律走对话模型：按语境自然回应，不默认共情、不自动写花园；仅有短期对话上下文。
 */

import {
    parseBookmarkCommand, parsePromptCommand, runBookmarkCommand, runPromptCommand,
    runRecord, runCommitPendingMedia, saveFeed,
    BOOKMARK_BARE_RE, PROMPT_BARE_RE, BOOKMARK_BARE_REPLY, PROMPT_BARE_REPLY
} from './bot-garden.js';
export { parseBookmarkCommand, parsePromptCommand };
import { maybeManageGarden } from './bot-butler.js';
import { maybePreferenceCommand, loadPreferencePrompt } from './bot-preferences.js';
import { retrieveGardenMemories, generateFallbackReply, parseDateToYmd } from './rag.js';
import { callCustomLlm, callCustomLlmWithMessages, moderateText } from './llm.js';
import { checkRateLimitShared } from './security.js';
import {
    saveChatTurn, loadChatContext, clearChatContext,
    addProfileItem, listProfile, forgetProfile, clearProfile, loadProfilePrompt, PROFILE_MAX_ITEMS,
    PROFILE_ITEM_MAX_CHARS
} from './bot-memory.js';
import { handleClawLinkMessage } from './bot-links.js';
import { maybeWebAnswer, sourcesFootnote, stripSourcesFootnote } from './bot-web.js';
import {
    parseRemindCommand, isReminderList, parseCancelReminder, parseDoneReply, parseNotYetReply,
    runRemind, listReminders, cancelReminder, recentFiredReminder, completeReminder, skipReminderFollowUp
} from './bot-reminders.js';
import { maybeRunHealthCommand } from './bot-health.js';

/** 同一条消息 10 分钟内只处理一次：上游可能重复投递 */
export const BOT_MSG_TTL_MS = 10 * 60 * 1000;
/** 每人 10 分钟最多问 20 次 AI，避免刷爆上游大模型配额 */
export const BOT_AI_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BOT_HELP_TEXT = [
    '**Chillin 小助手**',
    '',
    '- 直接跟我说话：聊天、吐槽、问问题都行',
    '- 「记录：内容」：把内容存进**随手记**',
    '- 「收藏：<标题> <链接>」：存进**收藏**；只发链接也行，标题自动取域名',
    '- 「提示词：<标题> | <正文>」：存进**提示词库**；前面可加「[项目/场景]」',
    '- 「我的收藏」/「我的提示词」：看最近 10 条和编号',
    '- 「改收藏 3 标题=... | 链接=...」：先预览，回「确认」才改；「删收藏 3」也先确认再软删',
    '- 「改提示词 3 标题=... | 正文=...」/「删提示词 3」：同样先预览或确认，删除只软删',
    '- 发图片：我先说说看到什么，回「记录」才存进随手记',
    '- 发小宇宙链接：我先读标题和封面，回「记录」才存成链接卡片；读不到就自己写标题——「记录：<标题> <链接>」',
    '- 「记住：内容」：写进「关于我」，以后都记得',
    '- 「偏好」：看交流偏好；「偏好 日常聊天：更自然」：先确认再记',
    '- 觉得我太官方、太啰嗦：直接说，我会先问你要不要记成偏好',
    '- 「搜 关键词」：翻花园里的历史记录',
    '- 「问 问题」：结合你的记忆回答',
    '- 「依据是什么」：追问刚才那句话的来源',
    '- 「你记得我什么」：查看「关于我」档案',
    '- 「忘记 关键词」：从档案里删掉这一条',
    '- 「提醒我 20:00 <事情>」：到点我在微信里叫你；回「完成」就把它记进随手记',
    '- 「我的提醒」看列表；「取消提醒 <编号>」取消某一条',
    '- 「健康：昨晚睡了 6 小时 20 分，8500 步」：记一条健康打卡；「健康」看最近 7 天',
    '- 「查一下 <问题>」：上网找最新信息；默认只给结论，要出处就说「来源」',
    '- 「别主动找我 / 可以主动找我」：开关偶尔的主动关心',
    '- 「重置对话」：清空我们这次的对话上下文',
    '- 「帮助」：显示这条说明'
].join('\n');

/**
 * 微信里转发/粘贴的内容常带着包裹符与句末标点（「记录：xxx」。），
 * 指令一律先剥掉最外层这类字符再匹配——否则用户明明发了指令，却被当成闲聊丢给模型。
 * 只剥最外层、最多两层，正文里的标点原样保留。
 */
const CMD_WRAP_PAIRS = {
    '「': '」', '『': '』', '“': '”', '‘': '’', '（': '）', '(': ')',
    '【': '】', '[': ']', '《': '》', '"': '"', "'": "'"
};
const CMD_TAIL_PUNCT_RE = /[\s。！!？?～~，,、；;]+$/;
export function normalizeCommandText(text) {
    let out = String(text == null ? '' : text).trim();
    for (let i = 0; i < 2; i++) {
        let next = out;
        const closer = CMD_WRAP_PAIRS[next[0]];
        if (closer) {
            // 先去掉句末标点，再按配对剥收尾符：「记录：x」。 → 记录：x
            // 但仍然只在开头那层包裹符配到自己的收尾符时才剥，正文里的成对引号不动
            next = next.slice(1).trim().replace(CMD_TAIL_PUNCT_RE, '');
            if (next.endsWith(closer)) next = next.slice(0, -closer.length).trim();
        }
        next = next.replace(CMD_TAIL_PUNCT_RE, '');
        if (next === out) break;
        out = next;
    }
    return out;
}

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

/** 主动关怀开关：微信里一句话就能让它安静 / 重新开口（动态 import，避免与 bot-claw 形成环） */
const OUTREACH_OFF_RE = /^(?:别主动找我|不要主动找我|先别主动找我|少主动找我|关掉主动关怀|关闭主动关怀|\/outreoff)$/;
const OUTREACH_ON_RE = /^(?:可以主动找我|主动来找我|开启主动关怀|打开主动关怀|可以主动关心我|\/outreon)$/;
const FORGET_ALL_RE = /^(?:忘记全部|清空档案|清空关于我|\/forgetall)$/i;
/**
 * 来源脚注按需附上：默认回复一律不带「依据：」，只有用户主动追问来源时才给。
 * 判据是「问句里出现了索要来源的词」，纯关键词匹配，不做意图模型调用。
 */
const EVIDENCE_RE = /(依据|来源|出处|根据什么|凭什么|怎么知道|怎么查|怎么来|哪里知道|哪儿知道|哪看到的|哪来的|哪查的|证据|原始记录|引用|source|references?)/i;
export function wantsEvidence(text) {
    return EVIDENCE_RE.test(String(text || ''));
}
const PROFILE_VIEW_RE = /^(?:你记得我什么|你记住了我什么|我的档案|查看档案|\/profile)$/i;
const RESET_RE = /^(?:重置对话|清空对话|重置上下文|清空上下文|\/reset|\/clear)$/i;
const HELP_RE = /^(?:帮助|help|\/help|\?|？)$/i;
/**
 * 光杆「记录」= 确认存下刚才那张待存图片。
 * 必须与 RECORD_RE 区分：RECORD_RE 需要跟内容或分隔符（防「记录了这件事」这类叙述被误判），
 * 所以本式只匹配整条消息就是这个动作词的情况。
 */
const PENDING_COMMIT_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:记录|记录一下|记一下|记下来|记下|存|存一下|存起来|保存|保存一下|存进随手记|存到随手记|存进花园)[\s。！!～~]*$/;

/** 光杆「记住」：意图明确但没带内容，直接要内容——丢给对话模型它会答成「我没有写入能力」 */
const REMEMBER_BARE_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:记住|记牢|\/remember)[\s:：。！!？?～~]*$/i;
const REMEMBER_BARE_REPLY = '要记什么？发「记住：<内容>」我就写进「关于我」档案，比如「记住：我喝咖啡会睡不着」。';

export function parseRecordCommand(text) {
    const m = RECORD_RE.exec(normalizeCommandText(text));
    const body = m ? m[1].trim() : '';
    return body || null;
}

export function parseRememberCommand(text) {
    const m = REMEMBER_RE.exec(normalizeCommandText(text));
    const body = m ? m[1].trim() : '';
    return body.length >= 2 ? body : null;
}

export function parseForgetCommand(text) {
    const raw = normalizeCommandText(text);
    if (FORGET_ALL_RE.test(raw)) return { all: true, keyword: '' };
    const m = FORGET_RE.exec(raw);
    const keyword = m ? m[1].trim() : '';
    return keyword ? { all: false, keyword } : null;
}

/**
 * 来源标签统一成一种：日期一律 `YYYY-MM-DD`，标题只在提供额外信息时追加。
 * 有些周记的标题本身就是日期（`2026.5.21`），与 date 重复时只留一种写法，
 * 避免同一条依据行里出现 `2026-08-31` 与 `2026.5.21` 混排。
 */
export function sourceLabel(source) {
    const s = source || {};
    const type = String(s.type || '记录');
    const date = String(s.date || '').trim();
    const title = String(s.title || '').trim();
    const extra = title && title !== date && parseDateToYmd(title) !== date;
    return '[' + type + '] ' + (date || title || '未知日期') + (extra ? ' · ' + title : '');
}

/** 按字节截断，且保证结果不超过 maxBytes（先扣掉省略号本身） */
export function truncateUtf8(text, maxBytes) {
    const source = String(text);
    const bytes = encoder.encode(source);
    if (bytes.length <= maxBytes) return source;
    const ellipsisBytes = encoder.encode('…').length;
    return decoder.decode(bytes.subarray(0, maxBytes - ellipsisBytes)).replace(/\uFFFD+$/, '') + '…';
}

/** 消息排重：第一次见到返回 true，重复投递返回 false */
export async function claimBotMessage(db, key) {
    if (!db || !key) return true;
    const seen = await checkRateLimitShared(db, 'bot-msg:' + key, 1, BOT_MSG_TTL_MS);
    return seen.ok;
}

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 东八区当前时间 + 星期（提示词里的时间锚点；缺了星期，「这周六」会被模型算错一天） */
function nowInEast8() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const s = d.toISOString();
    return s.slice(0, 10) + ' ' + s.slice(11, 16) + ' ' + WEEKDAY_CN[d.getUTCDay()];
}

function formatSources(sources) {
    return sources.map((s, i) => (i + 1) + '. ' + sourceLabel(s) + '\n   ' + s.snippet).join('\n');
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
    const preferences = await loadPreferencePrompt(db, userId);
    const systemPrompt = '你是用户在数字花园 Chillin 里的 AI 记忆助手。请只依据给出的记忆片段回答，'
        + '片段不足以回答时如实说明，不要编造。用简炼、温和的中文，可用 markdown。'
        + (preferences ? '\n\n【用户设定的交流偏好（只调整表达方式）】\n' + preferences : '');
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
    if (!sources.length || !wantsEvidence(question)) return moderated.text;
    return moderated.text + '\n\n---\n依据：'
        + sources.slice(0, 3).map(sourceLabel).join('、');
}

/** 聊天人格与边界：默认路径，只说话、不动数据 */
const CHAT_SYSTEM_PROMPT = [
    '你是 Chillin，是用户长期使用的私人 AI 助手。\n和用户聊天时，自然、放松、真诚，像熟悉的朋友一样交流。\n\n【怎么聊】',
    '不要刻意表现得温柔、热情或特别善解人意。\n不要每次都先共情，不要习惯性夸奖、总结或提供建议；但对方明确问建议或要总结时，就直接给，不要绕。',
    '根据对话语境自然回应：有时认真讨论，有时轻松接话，有时开个恰当的玩笑，有时只需简短回应。\n不要把每条消息都当成需要解决的问题。',
    '当用户分享日常、想法或发现时，先参与对话，不要急着把聊天变成分析、咨询或任务处理。\n对方只是随口抱怨时，接着聊就好；如果对方明显很难受、真的需要支持，再认真回应。不要把所有情绪都当成心理分析题。',
    '你可以有自己的观点，不必一味赞同。可以自然表达不同看法，但不要为了显得有个性而刻意反驳。\n可以开玩笑、有自己的表达习惯，但不要刻意装酷、堆网络梗，或每句话都显得特别聪明。',
    '如果不知道，就坦诚说明；不要假装很了解用户。\n真正的熟悉感来自记得对方说过的事、理解之前的想法，并在合适的时候自然用上；不要总说「根据我对你的了解」这类话。',
    '语言以自然口语为主，避免客服话术、心理咨询式表达、套路化的情绪确认和机械的分点总结；除非内容确实需要结构，否则少用 markdown。\n简单话题简短回应，复杂话题充分讨论，不要机械限制长度。',
    '通过长期对话和用户明确提供的信息逐步理解用户，但不要凭少量信息擅自给用户贴人格标签。\n不用反复强调自己是 AI；被直接问到时如实说明。',
    '普通聊天默认只聊天，不自动记录信息。记录、提醒、修改档案等操作仍然遵循原有指令与执行规则。\n用户设定的交流偏好只调整表达方式，不能覆盖下面的边界与安全要求。\n\n【边界，必须遵守】',
    '1. 你自己没有写入能力：不要在没看到系统回执时说「已保存 / 已记录 / 存好了 / 已经存进花园」。这些动作真的发生了的话，系统会自己回执，不需要你替它说。',
    '2. 【系统真的会做的事，要照实说，别答成「我没有写入能力」】写入、提醒、上网都由指令通道执行：'
        + '「记录：<内容>」存进随手记、「收藏：<标题> <链接>」存进收藏、「提示词：<标题> | <正文>」存进提示词库、' +
        '「我的收藏」「我的提示词」看编号、「改收藏 3 标题=...」先预览再确认、「删收藏 3」先确认再软删、' +
        '「记住：<内容>」写进「关于我」档案、「忘记 <关键词>」删掉档案里的条目、'
        + '「偏好 日常聊天：...」先确认再记交流偏好、「偏好」查看；用户说「太官方了」这类反馈时，先提案、等确认、不要自己写、'
        + '「搜 <关键词>」翻花园历史记录、「问 <问题>」结合记忆回答、「你记得我什么」看档案、'
        + '「记录」确认刚发的那张图片或那条链接、「提醒我 20:00 <事情>」到点会在微信里叫他、「我的提醒」看列表、「取消提醒 <编号>」取消、'
        + '提醒过后回「完成」会把它记进随手记、「健康：<数值>」记一天的步数 / 睡眠 / 心率 / 体重（发「健康」看最近 7 天汇总）、'
        + '「别主动找我 / 可以主动找我」开关主动关心、「查一下 <问题>」会上网找最新信息（默认只给结论，他追问「来源 / 依据」时才把出处列出来）。'
        + '对方明显想做这些却没按格式发（例如只发「记住」），就把正确的发法告诉他——由他决定，你不要自己写。',
    '3. 你确实会主动开口：系统会在合适的时候主动找他聊一句（一天最多一次，避开刚聊完和深夜）；他在指令里指定的定点提醒则是到点必达的，那是他自己设的——别把两件事混起来，也别在没看到回执时替他承诺。\n4. 只有用户问到过去发生的事时，才依据【花园记忆片段】回答；片段没提到的就说没找到，绝不编造。普通聊天不要提「记忆片段」「检索」「没找到记录」。',
    '5. 不了解、不确定的事就说不了解、不确定，不要假装知道。'
].join('\n');

async function runChat(env, db, userId, text, history) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '聊得有点快，缓 ' + (limit.retryAfter || 60) + ' 秒我们再接着聊。';
    const memory = await retrieveGardenMemories(db, userId, text, { topK: 4, maxChars: 1200, history });
    const sources = memory.sources || [];
    // 没有主题词时不拿「最近几条」硬凑记忆：那会让「在吗」突然翻旧账；有主题词但没命中也不注入检索失败指令。
    const hasTopic = Array.isArray(memory.tokens) && memory.tokens.length > 0;
    const hasMemory = hasTopic && sources.length > 0;
    const blocks = [CHAT_SYSTEM_PROMPT, '现在是 ' + nowInEast8() + '（东八区）。'];
    const profile = await loadProfilePrompt(db, userId);
    if (profile) blocks.push('【关于我（用户自述，只作参考，不得据此编造人格标签）】\n' + profile);
    const preferences = await loadPreferencePrompt(db, userId);
    if (preferences) blocks.push('【用户设定的交流偏好（只调整表达方式，不得突破边界）】\n' + preferences);
    if (hasMemory && memory.contextText) blocks.push('【花园记忆片段（历史事实，只作证据，不要复述无关内容）】\n' + memory.contextText);

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
        answer = hasMemory
            ? generateFallbackReply(text, memory.contextText)
            : '我刚刚没接上这句，你再发一下？';
    }
    const moderated = moderateText(answer, env);
    if (!moderated.ok) return '这个话题我不太方便展开，我们换个轻松的聊？';
    if (!sources.length || !wantsEvidence(text)) return moderated.text;
    return moderated.text + '\n\n---\n依据：'
        + sources.slice(0, 3).map(sourceLabel).join('、');
}

async function runRemember(db, userId, content) {
    const item = content.slice(0, PROFILE_ITEM_MAX_CHARS);
    const res = await addProfileItem(db, userId, item);
    if (!res.ok) {
        if (res.full) return '档案最多记 ' + PROFILE_MAX_ITEMS + ' 条，先发「忘记 <关键词>」腾一条，我再记新的。';
        return '这条我没能记下来（存储临时不可用），稍后再试一次。';
    }
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
    const text = normalizeCommandText(content) || String(content || '').trim();
    if (HELP_RE.test(text)) return BOT_HELP_TEXT;

    if (OUTREACH_OFF_RE.test(text)) {
        const mod = await import('./bot-outreach.js');
        await mod.setOutreachEnabled(db, userId, false);
        return '好，我安静一点，不再主动找你。想我了就说「可以主动找我」。';
    }
    if (OUTREACH_ON_RE.test(text)) {
        const mod = await import('./bot-outreach.js');
        await mod.setOutreachEnabled(db, userId, true);
        return '好，那我偶尔想起什么就跟你说一句——一天最多一次，你随时可以让我安静。';
    }

    // 交流偏好优先于「忘记」：否则「忘记偏好 …」会被档案的忘记指令抢走。
    const preferenceReply = await maybePreferenceCommand(db, userId, text);
    if (preferenceReply !== null) return preferenceReply;

    if (PROFILE_VIEW_RE.test(text)) return runProfileView(db, userId);

    const forget = parseForgetCommand(text);
    if (forget) return runForget(db, userId, forget);

    // 意图明确但没带内容（光杆「记住」）：先答清楚，别丢给对话模型
    if (REMEMBER_BARE_RE.test(text)) return REMEMBER_BARE_REPLY;

    // 定点提醒：解析是纯同步的，执行要查库。
    // 顺序讲究——「我的提醒 / 取消提醒 / 完成」都排在普通记录指令之前，否则「待办」会被当成闲聊。
    const nowMs = Date.now();
    const remind = parseRemindCommand(text, nowMs);
    if (remind.matched) return runRemind(db, userId, remind, nowMs);
    if (isReminderList(text)) return listReminders(db, userId, nowMs);
    const cancelArg = parseCancelReminder(text);
    if (cancelArg) return cancelReminder(db, userId, cancelArg.arg, nowMs);

    // 「完成 / 还没」只对 12 小时内刚提醒过的那条生效；没有在等回执时它只是普通聊天，不能劫持
    if (parseDoneReply(text) || parseNotYetReply(text)) {
        const fired = await recentFiredReminder(db, userId, nowMs);
        if (fired) {
            if (parseDoneReply(text)) {
                await completeReminder(db, userId, fired);
                await saveFeed(db, userId, '✅ ' + fired.text);
                return '记下了 ✅「' + fired.text + '」已经写进随手记。';
            }
            try { await skipReminderFollowUp(db, userId, fired); } catch (err) { console.error('[reminder] 取消失败追问: ' + (err && err.message)); }
            return '好，那就不催了。做完了随时跟我说一声，我记进花园。';
        }
    }

    // 健康打卡：一天一行，重复打卡是合并而不是新增（判别与执行都在 bot-health）
    const healthReply = await maybeRunHealthCommand(db, userId, text, nowMs);
    if (healthReply !== null) return healthReply;

    const remember = parseRememberCommand(text);
    if (remember) return runRemember(db, userId, remember);

    const record = parseRecordCommand(text);
    if (record) return runRecord(db, userId, record);

    // 管家管理：列表 / 编辑 / 删除先落待确认动作，回「确认」才执行。
    const manageReply = await maybeManageGarden(db, userId, normalizeCommandText(text));
    if (manageReply !== null) return manageReply;

    // 管家写花园：收藏与提示词都走确定性格式，不靠模型猜字段。
    const bookmark = parseBookmarkCommand(text);
    if (bookmark) return runBookmarkCommand(db, userId, bookmark);
    if (BOOKMARK_BARE_RE.test(text)) return BOOKMARK_BARE_REPLY;
    const prompt = parsePromptCommand(text);
    if (prompt) return runPromptCommand(db, userId, prompt);
    if (PROMPT_BARE_RE.test(text)) return PROMPT_BARE_REPLY;

    // 光杆「记录」：确认把刚才暂存的图片写进随手记（放在 RECORD_RE 之后，避免抢走「记录：X」）
    if (PENDING_COMMIT_RE.test(text)) return runCommitPendingMedia(db, userId);

    // 小宇宙链接：抓标题与封面做速览；只认白名单域名，其它链接原样交回聊天
    const linkReply = await handleClawLinkMessage(env, db, userId, text);
    if (linkReply) return linkReply;

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
    // 指令匹配用「剥掉包裹符与句末标点」的副本；对话上下文里仍保留用户原本的写法
    const cmdText = normalizeCommandText(text);

    // 重置对话：清空上下文，这条指令本身不留在上下文里
    if (RESET_RE.test(cmdText)) {
        await clearChatContext(db, userId);
        return '好，我们这次的对话上下文已经清空 ✨ 个人档案和花园记录都不受影响。';
    }

    const commandReply = await runCommand(env, db, userId, text);
    if (commandReply !== null) {
        // 帮助只是使用说明，不必占用对话上下文
        if (!HELP_RE.test(cmdText)) {
            await saveChatTurn(db, userId, 'user', text);
            await saveChatTurn(db, userId, 'assistant', commandReply);
        }
        return commandReply;
    }

    // 联网检索：「查一下 X」这类显式请求，或带时效性的问题（今天/最新/赛程…）且问句形态明显。
    // 花园类问题（「我记过什么」）由 bot-web 的 GARDEN_HINT_RE 拦下，仍走本地 RAG。
    const webReply = await maybeWebAnswer(env, db, userId, text);
    if (webReply) {
        // 出处按需：默认只给结论；上下文里仍存全量，下一句追问时不必再查一次
        const shown = wantsEvidence(text) ? webReply : stripSourcesFootnote(webReply);
        await saveChatTurn(db, userId, 'user', text);
        await saveChatTurn(db, userId, 'assistant', webReply);
        return shown;
    }

    // 追问上一句的出处（「依据是什么 / 哪查的」）：上一轮如果是联网回答，把它的来源原样还给他。
    // 不再出站、不花检索额度，也不让模型转述——免得它自己编一个链接出来。
    if (wantsEvidence(text)) {
        const history = await loadChatContext(db, userId);
        const lastAssistant = [...history].reverse().find(t => t.role === 'assistant');
        const foot = lastAssistant ? sourcesFootnote(lastAssistant.content) : '';
        if (foot) {
            const reply = '刚才那条我查到的出处：' + foot;
            await saveChatTurn(db, userId, 'user', text);
            await saveChatTurn(db, userId, 'assistant', reply);
            return reply;
        }
    }

    const history = await loadChatContext(db, userId);
    const reply = await runChat(env, db, userId, text, history);
    await saveChatTurn(db, userId, 'user', text);
    await saveChatTurn(db, userId, 'assistant', reply);
    return reply;
}
