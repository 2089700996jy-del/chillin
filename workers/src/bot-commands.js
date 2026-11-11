/**
 * Bot 大脑：微信 ClawBot 消息分流与对话编排。
 * 默认不写花园（仅短期上下文）；显式指令才持久化。
 * 来源标签统一 [类型] YYYY-MM-DD，正文永不进日志。
 */

import {
    parseBookmarkCommand, parsePromptCommand, runBookmarkCommand, runPromptCommand,
    runRecord, runCommitPendingMedia, saveFeed, maybeRunAgentCommand,
    BOOKMARK_BARE_RE, PROMPT_BARE_RE, BOOKMARK_BARE_REPLY, PROMPT_BARE_REPLY
} from './bot-garden.js';
export { parseBookmarkCommand, parsePromptCommand };
import { maybeManageGarden } from './bot-butler.js';
import { maybePreferenceCommand, loadPreferencePrompt } from './bot-preferences.js';
import { retrieveGardenMemories, generateFallbackReply } from './rag.js';
import { callCustomLlm, callCustomLlmWithMessages, moderateText } from './llm.js';
import { checkRateLimitShared } from './security.js';
import {
    saveChatTurn, loadChatContext, clearChatContext,
    addProfileItem, listProfile, forgetProfile, clearProfile, loadProfilePrompt, PROFILE_MAX_ITEMS,
    PROFILE_ITEM_MAX_CHARS, parseProposeMemory, savePendingAction
} from './bot-memory.js';
import { handleClawLinkMessage } from './bot-links.js';
import { maybeClawImageFollowUp } from './bot-image-flow.js';
import { maybeWebAnswer, sourcesFootnote, stripSourcesFootnote } from './bot-web.js';
import {
    parseRemindCommand, isReminderList, parseCancelReminder, parseDoneReply, parseNotYetReply,
    runRemind, listReminders, cancelReminder, recentFiredReminder, completeReminder, skipReminderFollowUp,
    parseReminderTime, cleanReminderText, formatReminderTime, createReminderAt
} from './bot-reminders.js';
import { maybeRunHealthCommand } from './bot-health.js';
import {
    BOT_HELP_TEXT,
    REMEMBER_BARE_REPLY,
    CHAT_SYSTEM_PROMPT,
    normalizeCommandText,
    sourceLabel,
    truncateUtf8,
    wantsEvidence,
    EVIDENCE_RE,
    CMD_WRAP_PAIRS,
    CMD_TAIL_PUNCT_RE,
    shouldRetrieveGarden,
    TOPIC_SHIFT_RE,
    parseTopicShift
} from './bot-prompts.js';

export {
    BOT_HELP_TEXT,
    REMEMBER_BARE_REPLY,
    CHAT_SYSTEM_PROMPT,
    normalizeCommandText,
    sourceLabel,
    truncateUtf8,
    wantsEvidence,
    parseTopicShift
};

/** 同一条消息 10 分钟内只处理一次：上游可能重复投递 */
export const BOT_MSG_TTL_MS = 10 * 60 * 1000;
/** 每人 10 分钟最多问 20 次 AI，避免刷爆上游大模型配额 */
export const BOT_AI_LIMIT = { limit: 20, windowMs: 10 * 60 * 1000 };

/**
 * 明确的数据写入指令：返回要保存的内容，未命中返回 null。
 * 「记录一下」「记一下」「存一下」自带明确的动作语义，后面可省分隔符；
 * 光杆「记录」「随手记」则必须跟分隔符，避免把「记录了这件事」这类叙述误判成指令。
 */
const RECORD_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:(?:记录一下|记一下|存一下)[\s:：]*|(?:记录|随手记|\/feed|\/note)[\s:：]+)([\s\S]+)$/i;
const TODO_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:待办|todo|待办事项)[\s:：]+([\s\S]+)$/i;
const DONE_TASK_RE = /^(?:完成|搞定|做完|办好|弄好|done)[\s:：]+([\s\S]+)$/i;
/** 档案写入指令（「记住」动作唯一，允许省分隔符，但内容至少两个字） */
const REMEMBER_RE = /^(?:请|帮我|麻烦(?:你)?|帮)?\s*(?:记住|记牢|\/remember)[\s:：]*([\s\S]+)$/i;
/** 档案遗忘指令 */
const FORGET_RE = /^(?:忘记|忘掉|\/forget)[\s:：]*([\s\S]+)$/i;

/** 主动关怀开关：微信里一句话就能让它安静 / 重新开口（动态 import，避免与 bot-claw 形成环） */
const OUTREACH_OFF_RE = /^(?:别主动找我|不要主动找我|先别主动找我|少主动找我|关掉主动关怀|关闭主动关怀|\/outreoff)$/;
const OUTREACH_ON_RE = /^(?:可以主动找我|主动来找我|开启主动关怀|打开主动关怀|可以主动关心我|\/outreon)$/;
const FORGET_ALL_RE = /^(?:忘记全部|清空档案|清空关于我|\/forgetall)$/i;
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

export function parseRecordCommand(text) {
    const m = RECORD_RE.exec(normalizeCommandText(text));
    const body = m ? m[1].trim() : '';
    return body || null;
}

export function parseTodoCommand(text) {
    const m = TODO_RE.exec(normalizeCommandText(text));
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


async function runChat(env, db, userId, text, history, options = {}) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '聊得有点快，缓 ' + (limit.retryAfter || 60) + ' 秒我们再接着聊。';
    const isSoftShift = Boolean(options.isSoftShift);
    const queryText = options.activeQuery || text;
    let effectiveHistory = history || [];
    if (isSoftShift && effectiveHistory.length > 2) {
        effectiveHistory = effectiveHistory.slice(-2);
    }
    const needsGarden = shouldRetrieveGarden(queryText, effectiveHistory);
    const memory = needsGarden
        ? await retrieveGardenMemories(db, userId, queryText, { topK: 4, maxChars: 1200, history: effectiveHistory })
        : { tokens: [], sources: [], contextText: '' };
    const sources = memory.sources || [];
    // 没有主题词时不拿「最近几条」硬凑记忆：那会让「在吗」突然翻旧账；有主题词但没命中也不注入检索失败指令。
    const hasTopic = Array.isArray(memory.tokens) && memory.tokens.length > 0;
    const hasMemory = hasTopic && sources.length > 0;
    const blocks = [CHAT_SYSTEM_PROMPT, '现在是 ' + nowInEast8() + '（东八区）。'];
    if (isSoftShift) {
        blocks.push('【话题平滑切换】：用户已发起新话题转折，前序旧对话仅作背景参考，请直接回答当前新问题，切勿牵强附会或纠缠前序话题。');
    }
    const profile = await loadProfilePrompt(db, userId);
    if (profile) blocks.push('【关于我（用户自述档案，带有记录沉淀时距，请结合时间知觉作答）】\n' + profile);
    const preferences = await loadPreferencePrompt(db, userId);
    if (preferences) blocks.push('【用户设定的交流偏好（只调整表达方式，不得突破边界）】\n' + preferences);
    if (hasMemory && memory.contextText) blocks.push('【花园记忆片段（历史事实，带有记录时距与置信度，只作证据）】\n' + memory.contextText);

    const messages = [{ role: 'system', content: blocks.join('\n\n') }];
    for (const turn of effectiveHistory) messages.push({ role: turn.role, content: turn.content });
    messages.push({ role: 'user', content: text });

    let answer = '';
    try {
        answer = await callCustomLlmWithMessages(env, messages);
    } catch (err) {
        console.error('[bot] 聊天模型调用失败: ' + (err && err.message));
    }
    if (!answer) {
        answer = hasMemory
            ? generateFallbackReply(queryText, memory.contextText)
            : '我刚刚没接上这句，你再发一下？';
    }
    const moderated = moderateText(answer, env);
    if (!moderated.ok) return '这个话题我不太方便展开，我们换个轻松的聊？';
    let output = moderated.text;
    const { cleanText, proposal } = parseProposeMemory(output);
    if (proposal && proposal.content) {
        output = cleanText;
        const existing = await listProfile(db, userId);
        const tag = proposal.label || '';
        const isDupe = existing.some(it => String(it.content) === proposal.content && (!tag || String(it.label || '') === tag));
        if (!isDupe) {
            await savePendingAction(db, userId, 'set_profile', 'bot_profile', 0, proposal);
            output += '\n\n💡 记下你的新档案「' + (tag ? tag + '：' : '') + proposal.content + '」？回复【确认】保存，回复【取消】忽略。';
        }
    }
    if (!sources.length || !wantsEvidence(queryText)) return output;
    return output + '\n\n---\n依据：'
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

    // 待办指令：带时间词自动转定时提醒；无时间词自动写 [ ] 待办随手记
    const todoText = parseTodoCommand(text);
    if (todoText) {
        const fireAtMs = parseReminderTime(todoText, nowMs);
        if (fireAtMs) {
            const body = cleanReminderText(todoText);
            const created = await createReminderAt(db, userId, body, fireAtMs, nowMs);
            return created.duplicated ? created.reply : ('已设待办提醒 ⏰\n> ' + formatReminderTime(fireAtMs, nowMs) + ' — ' + body);
        }
        await saveFeed(db, userId, '[ ] ' + todoText);
        return '已记入待办 ✅\n> [ ] ' + todoText;
    }

    // 完成待办/提醒关键词核销
    const doneTaskMatch = DONE_TASK_RE.exec(normalizeCommandText(text));
    if (doneTaskMatch) {
        const kw = doneTaskMatch[1].trim();
        const fired = await recentFiredReminder(db, userId, nowMs);
        if (fired && (!kw || fired.text.includes(kw))) {
            await completeReminder(db, userId, fired);
            await saveFeed(db, userId, '✅ ' + fired.text);
            return '记下了 ✅「' + fired.text + '」已完成并写进随手记。';
        }
        const target = await db.prepare("SELECT id, text FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' AND text LIKE '%' || ?2 || '%' ORDER BY fire_at_ms ASC LIMIT 1").bind(userId, kw).first();
        if (target) {
            await db.prepare("UPDATE bot_reminders SET status = 'done', updated_at = datetime('now', '+8 hours') WHERE id = ?1").bind(target.id).run();
            await saveFeed(db, userId, '✅ ' + target.text);
            return '搞定啦 ✅ 待办提醒「' + target.text + '」已核销并归档到随手记。';
        }
        const feedRow = await db.prepare("SELECT id, content FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND content LIKE '[ ] %' AND content LIKE '%' || ?2 || '%' ORDER BY id DESC LIMIT 1").bind(userId, kw).first();
        if (feedRow) {
            const upd = feedRow.content.replace(/^\[ \]\s*/, '✅ ');
            await db.prepare("UPDATE quick_feeds SET content = ?1, updated_at = datetime('now', '+8 hours') WHERE id = ?2").bind(upd, feedRow.id).run();
            return '已划掉待办 ✅\n> ' + upd;
        }
    }

    // 「完成 / 还没」回执（优先响应 12 小时内到期提醒；无提醒时划掉最近一条待办）
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
        if (parseDoneReply(text)) {
            const feedRow = await db.prepare("SELECT id, content FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND content LIKE '[ ] %' ORDER BY id DESC LIMIT 1").bind(userId).first();
            if (feedRow) {
                const upd = feedRow.content.replace(/^\[ \]\s*/, '✅ ');
                await db.prepare("UPDATE quick_feeds SET content = ?1, updated_at = datetime('now', '+8 hours') WHERE id = ?2").bind(upd, feedRow.id).run();
                return '已帮你划掉最近一条待办 ✅\n> ' + upd;
            }
        }
    }

    // 健康打卡：一天一行，重复打卡是合并而不是新增（判别与执行都在 bot-health）
    const healthReply = await maybeRunHealthCommand(db, userId, text, nowMs);
    if (healthReply !== null) return healthReply;

    // 目标 Agent：建目标 / 看进度 / 排队继续 / 审批，复用网页端同一套函数
    const agentReply = await maybeRunAgentCommand(env, db, userId, text);
    if (agentReply !== null) return agentReply;

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

    // 连续图片后的追问：只在有待存图片、且问句确实指向图片时走深度看图
    const imageFollowUp = await maybeClawImageFollowUp(env, db, userId, text);
    if (imageFollowUp !== null) return imageFollowUp;

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

    // 话题切换：硬切换（彻底翻篇并清空前序上下文）或软切换（优雅平滑淡出）
    const shift = parseTopicShift(cmdText);
    if (shift && shift.type === 'hard') {
        await clearChatContext(db, userId);
        const nextTopic = shift.nextTopic;
        if (!nextTopic) return '好呀，那我们聊点别的 ✨ 你想聊什么？';
        return buildBotReply(env, db, userId, nextTopic);
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
    const isSoftShift = shift && shift.type === 'soft';
    const activeQuery = isSoftShift && shift.nextTopic ? shift.nextTopic : text;
    const reply = await runChat(env, db, userId, text, history, { isSoftShift, activeQuery });
    await saveChatTurn(db, userId, 'user', text);
    await saveChatTurn(db, userId, 'assistant', reply);
    return reply;
}
