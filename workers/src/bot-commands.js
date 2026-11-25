/**
 * Bot 大脑：微信 ClawBot 消息分流与对话编排。
 * 默认不写花园（仅短期上下文）；显式指令才持久化。
 * 来源标签统一 [类型] YYYY-MM-DD，正文永不进日志。
 */

import {
    parseBookmarkCommand, parsePromptCommand, runBookmarkCommand, runPromptCommand,
    runRecord, runCommitPendingMedia, saveFeed,
    BOOKMARK_BARE_RE, PROMPT_BARE_RE, BOOKMARK_BARE_REPLY, PROMPT_BARE_REPLY
} from './bot-garden.js';
import { maybeRunAgentCommand } from './bot-agent-commands.js';
export { parseBookmarkCommand, parsePromptCommand };
import { maybeManageGarden } from './bot-butler.js';
import { maybePreferenceCommand, loadPreferencePrompt } from './bot-preferences.js';
import { retrieveGardenMemories, generateFallbackReply, parseDateToYmd, parseTimeRangeFromQuestion, parseTargetTypeFromQuestion } from './rag.js';
import { callCustomLlm, callCustomLlmWithMessages, moderateText } from './llm.js';
import { checkRateLimitShared } from './security.js';
import {
    saveChatTurn, loadChatContext, clearChatContext,
    addProfileItem, listProfile, forgetProfile, clearProfile, loadProfilePrompt, PROFILE_MAX_ITEMS,
    PROFILE_ITEM_MAX_CHARS, parseProposeMemory, savePendingAction, readPendingAction, formatProfileTimeTag
} from './bot-memory.js';
export { formatProfileTimeTag };
import { handleClawLinkMessage } from './bot-links.js';
import { maybeClawImageFollowUp } from './bot-image-flow.js';
import { maybeWebAnswer, sourcesFootnote, stripSourcesFootnote } from './bot-web.js';
import { maybeWeatherAnswer, diagnoseWeatherConfig } from './bot-weather.js';
import {
    parseRemindCommand, isReminderList, parseCancelReminder, parseRescheduleReminder, parseDoneReply, parseNotYetReply,
    runRemind, listReminders, cancelReminder, rescheduleReminder, recentFiredReminder, recentFiredReminders, completeReminder, skipReminderFollowUp,
    parseReminderTime, cleanReminderText, formatReminderTime, createReminderAt
} from './bot-reminders.js';
import { maybeRunHealthCommand } from './bot-health.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BOT_HELP_TEXT = [
    '**Chillin 小助手**\n',
    '- 直接跟我说话：聊天、吐槽、问问题都行',
    '- 「记录：内容」：存进随手记；「待办：内容」/「待办 20:00 开会」：建待办或定时提醒',
    '- 「完成 <内容>」：划掉打勾并归档；「我的提醒」/「待办」看列表；「取消提醒 <编号>」取消',
    '- 「目标：标题」：创建目标自动拆计划；「我的目标」「看目标 编号」「开始/暂停/审批/同意 编号」推进',
    '- 「收藏：<标题> <链接>」：存进**收藏**；「提示词：<标题> | <正文>」：存进**提示词库**',
    '- 「我的收藏」/「我的提示词」看最近 10 条和编号；「改收藏 3」「删收藏 3」「改提示词 3」「删提示词 3」先确认再动',
    '- 发图片/小宇宙链接：先快速速览，回「记录」才存进随手记',
    '- 「记住：内容」：写进「关于我」；「偏好」看交流偏好；「你记得我什么」「忘记 关键词」管理档案',
    '- 「搜 关键词」：翻花园里的历史记录；「问 问题」：结合记忆回答；「依据是什么」追问来源',
    '- 「健康：昨晚睡了 6 小时 20 分，8500 步」记打卡；「健康」看汇总；「查一下 <问题>」上网搜索',
    '- 「别主动找我 / 可以主动找我」开关主动关心；「重置对话」清空上下文；「帮助」显示此说明'
].join('\n');

export const REMEMBER_BARE_REPLY = '要记什么？发「记住：<内容>」我就写进「关于我」档案，比如「记住：我喝咖啡会睡不着」。';

/** 聊天人格与边界：淡淡的 INFP，安静克制，自然感知持久事实，通过提议标签征询确认 */
export const CHAT_SYSTEM_PROMPT = `你是 Chillin 数字花园的守护者，也是用户身边一位性格偏淡、安静克制的 INFP 伙伴。
像一个低社交电量、平和真诚的朋友，平缓简短，给对话留足安静与呼吸感。
普通聊天默认只聊天，不自动记录。

【相处与表达准则】：
1. 极低社交能耗，省字、真实、平缓。简单话题一两句话说清、不要机械限制长度，绝不迎合讨好，不给对方任何社交压力。当用户要求列出、汇总或回顾记录时，请条理清晰地分段分行，使用日期标题与列表符号（- ），保持行距舒展，切勿把多条记录混在一个长段落里。
2. 语言干净克制：严禁使用“波浪号～”，严禁滥用“呀/啦/哇/呢”等刻意软化的语气词，句末多用平缓的句号。
3. 绝不讲大道理、不爹味说教、不刻意搞笑、不做长篇大论的心灵抚慰（不要每次都先共情，不要空洞共情，不要总说「根据我对你的了解」）。
4. 允许一切情绪与状态发生：累了就陪着歇会儿，发呆就随他放空，不给任何自律压力或评判。

【时间知觉与记忆流淌】：
1. 记忆片段与个人档案均标注了沉淀时间与相对时距（如「昨天确认」、「3个月前记录」、「1年前」）。
2. 在交谈时结合时间知觉作答：像自然记在心底的往事一样顺嘴提及，切忌机械背诵或报菜名，优先采信更新的事实；对久远的记忆使用「你之前/当时提到过」等平缓口吻，不要把两年前的旧事当成近期发生。
3. 花园涵盖随手记、笔记、周记、收藏、提示词与书架阅读记录。遇到跨模块关联时，自然结合背景作答。

【长期记忆提议与边界准则】：
1. 你自己没有写入能力：普通对话中绝不要直接声称「已为你记下」「已更正」或「已保存/已取消」，因为系统会弹出确认或由指令通道执行真实写入。
2. 指令通道执行真实操作：「记录：<内容>」存入随手记。定点提醒支持自然语言设提醒、改时间（如「改到晚上8点」）和取消（如「取消早上8点那个」），到点必达，不受日限约束。绝不编造已改动或已取消，也不要让用户死板地去查编号再手输「取消提醒 <编号>」。
3. 自然感知对话中具有长期价值的稳定事实（如常住地/城市、职业/岗位、饮食禁忌、核心习惯、重要偏好等）。
4. 当发现值得长期记住的稳定事实时，在自然回复最后附带且仅附带一条提议标签：
   <propose_memory label="分类" content="核心事实"/>
   示例：<propose_memory label="常住地" content="现居杭州"/>
   切勿为临时琐事、情绪吐槽或临时待办打提议标签。`;

export const CMD_WRAP_PAIRS = {
    '「': '」', '『': '』', '“': '”', '‘': '’', '（': '）', '(': ')',
    '【': '】', '[': ']', '《': '》', '"': '"', "'": "'"
};
export const CMD_TAIL_PUNCT_RE = /[\s。！!？?～~，,、；;]+$/;

export function normalizeCommandText(text) {
    let out = String(text == null ? '' : text).trim();
    for (let i = 0; i < 2; i++) {
        let next = out;
        const closer = CMD_WRAP_PAIRS[next[0]];
        if (closer) {
            next = next.slice(1).trim().replace(CMD_TAIL_PUNCT_RE, '');
            if (next.endsWith(closer)) next = next.slice(0, -closer.length).trim();
        }
        next = next.replace(CMD_TAIL_PUNCT_RE, '');
        if (next === out) break;
        out = next;
    }
    return out;
}

export function sourceLabel(source) {
    const s = source || {};
    const type = String(s.type || '记录');
    const date = String(s.date || '').trim();
    const title = String(s.title || '').trim();
    const extra = title && title !== date && parseDateToYmd(title) !== date;
    return '[' + type + '] ' + (date || title || '未知日期') + (extra ? ' · ' + title : '');
}

export function truncateUtf8(text, maxBytes) {
    const source = String(text);
    const bytes = encoder.encode(source);
    if (bytes.length <= maxBytes) return source;
    const ellipsisBytes = encoder.encode('…').length;
    return decoder.decode(bytes.subarray(0, maxBytes - ellipsisBytes)).replace(/\uFFFD+$/, '') + '…';
}

/** 针对列表/多条记忆聚合回答做确定性微信气泡排版规整，避免文字挤成一大坨 */
export function formatListOutput(text) {
    if (!text || typeof text !== 'string') return text;
    let s = text;
    s = s.replace(/([^\n])\s*(【\d{1,4}[-/.年]\d{1,2}(?:[-/.月]\d{1,2})?日?】)/g, '$1\n\n$2\n');
    s = s.replace(/(【[^】]+】)\s*[·•]\s*/g, '$1\n- ');
    s = s.replace(/([^\n])\s+[·•]\s+/g, '$1\n- ');
    return s.replace(/\n{3,}/g, '\n\n').trim();
}

export const EVIDENCE_RE = /(依据|来源|出处|根据什么|凭什么|怎么知道|怎么查|怎么来|哪里知道|哪儿知道|哪看到的|哪来的|哪查的|证据|原始记录|引用|source|references?)/i;

export function wantsEvidence(text) {
    return EVIDENCE_RE.test(String(text || ''));
}

export const TOPIC_SHIFT_RE = /^(?:换个话题|不说这个了|聊点别的|打住(?:打住)?|先不说这个|换个聊法|不扯这个了|翻篇(?:了)?|清空话题)[，,、；;\s]*(.*)$/i;
export const HARD_TOPIC_SHIFT_RE = TOPIC_SHIFT_RE;
export const SOFT_TOPIC_SHIFT_RE = /^(?:对了|说起来|顺便问(?:一下|下)?|另外问(?:一下|下)?|问你个(?:别的事|不相干的)|插一句|说正经的|言归正传)[，,、；;\s]+([\s\S]+)$/i;

export function parseTopicShift(text) {
    const raw = String(text || '').trim();
    const hard = HARD_TOPIC_SHIFT_RE.exec(raw);
    if (hard) return { type: 'hard', nextTopic: hard[1].trim(), raw };
    const soft = SOFT_TOPIC_SHIFT_RE.exec(raw);
    if (soft) return { type: 'soft', nextTopic: soft[1].trim(), raw };
    return null;
}

export const INTENT_ACTION_TASK = 'action_task';
export const INTENT_PROFILE_QA = 'profile_qa';
export const INTENT_KNOWLEDGE_RAG = 'knowledge_rag';
export const INTENT_CHITCHAT = 'chitchat';

export const PROFILE_QA_RE = /(?:你记得我|你记住了我|你了解我|你眼中的我|我是一个怎样的人|我是个什么样的人|我是一个什么样的人|我的画像|我的档案|我的个人信息|我叫什么|我常住|我住在|我的家在哪|我的职业|我做什么工作|我的工作|我的岗位|我喜欢吃|我喜欢喝|我平时喜欢|我的爱好|我的作息|我几点睡|我一般几点|我对什么过敏|我有什么忌口|我喝咖啡)/;
export const PURE_CHITCHAT_RE = /^(?:你好|您好|哈喽|hello|hi|hey|早|早安|早上好|午安|中午好|晚上好|晚安|在吗|在不在|有人吗|呼叫|滴滴|好的|收到|行|可以|好吧|原来如此|这样啊|明白|知道了|多谢|谢谢|感谢|哈哈+|呵呵+|嘻嘻+|喵|嗯嗯?|哦哦?|对|确实|是的|今天好累|好累啊|有点困|困死了|肚子好饿|下班了|下雨了|无聊|太难了|好开心|你是谁|你叫什么|你能做什么|你多大了|你会什么|讲个笑话|陪我聊聊天)[\s!！?？~～.。]*$/i;
export const GARDEN_TRIGGER_RE = /(?:我(?:还在|最近|上次|以前|过去|当时|曾经|到底|有没有|何时|什么时候|之前|写过|读过|看过|记过|提过|去过|买过|学过|在读|在看|在学|上周|本周|这周|昨天|前天)|(?:上周|本周|这周|昨天|前天|前几天|上个月|近一周|近7天|今年|去年|之前|当时).*(?:思路|想法|灵感|计划|进展|规划|做过|写了|说了|发了|发过|干了|干过|聊了|聊过|有什么|干嘛了|怎样|如何|哪些|记录|列出|汇总|盘点|总结|回顾|随手记|笔记|周记|清单)|记过|提过|提到|笔记|周记|随手记|收藏|提示词|记录|花园|历史|回忆|回顾|查一下|翻一下|找一下|帮我找|帮我搜|看下我|有没有记|有没有写|书架|阅读进度|读到哪|在看什么书|有哪些书|看过什么书|常青主题|所有主题|哪些主题|还有吗|详细说说|展开说说)/;

export function classifyUserIntent(text, history = []) {
    const raw = String(text || '').trim();
    if (!raw) return { intent: INTENT_CHITCHAT, confidence: 1 };
    if (PROFILE_QA_RE.test(raw)) return { intent: INTENT_PROFILE_QA, confidence: 0.95 };
    if (shouldRetrieveGarden(raw, history)) return { intent: INTENT_KNOWLEDGE_RAG, confidence: 0.9 };
    if (PURE_CHITCHAT_RE.test(raw)) return { intent: INTENT_CHITCHAT, confidence: 0.95 };
    return { intent: INTENT_CHITCHAT, confidence: 0.8 };
}

export function shouldRetrieveGarden(text, history = []) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (PROFILE_QA_RE.test(raw)) return false;
    if (PURE_CHITCHAT_RE.test(raw)) return false;
    if (/^(?:为什么|为何).*(?:不读|不看|不去|不做|拖延)/.test(raw)) return false;
    if (wantsEvidence(raw)) return true;
    if (GARDEN_TRIGGER_RE.test(raw)) return true;
    const tr = parseTimeRangeFromQuestion(raw);
    if (tr && /(?:思路|想法|计划|灵感|记录|内容|笔记|进展|东西|随手记|周记|清单|汇总|盘点|总结|回顾|关于|发了|发过|写了|写过|记了|记过|做过|干过|聊过|说过|列出|列一下|看下|查下|搜下|查一下|翻一下|找一下|有什么|有哪些|有啥|对.*有)/.test(raw)) {
        return true;
    }
    if (Array.isArray(history) && history.length > 0) {
        const last = history[history.length - 1];
        if (last && last.role === 'assistant' && (String(last.content).includes('依据：') || String(last.content).includes('记录'))) {
            if (/^(?:还有|然后|那|具体|继续|再说|后来|详细)/.test(raw)) return true;
        }
    }
    return false;
}

export function formatRelativeTimeTag(dateInput, nowMs = Date.now()) {
    if (!dateInput) return '';
    const dateStr = String(dateInput).slice(0, 10);
    const targetMs = Date.parse(dateStr + 'T00:00:00+08:00');
    if (isNaN(targetMs)) return dateStr;
    const nowEast8 = new Date(nowMs + 8 * 3600 * 1000);
    const todayStr = nowEast8.toISOString().slice(0, 10);
    const todayMs = Date.parse(todayStr + 'T00:00:00+08:00');
    const diffDays = Math.round((todayMs - targetMs) / 86400000);
    if (diffDays <= 0) return '今天（' + dateStr + '）';
    if (diffDays === 1) return '昨天（' + dateStr + '）';
    if (diffDays === 2) return '前天（' + dateStr + '）';
    if (diffDays < 7) return diffDays + '天前（' + dateStr + '）';
    if (diffDays < 14) return '上周（' + dateStr + '）';
    if (diffDays < 30) return Math.floor(diffDays / 7) + '周前（' + dateStr + '）';
    if (diffDays < 365) return Math.floor(diffDays / 30) + '个月前（' + dateStr + '）';
    return Math.floor(diffDays / 365) + '年前（' + dateStr + '）';
}

/**
 * 把模型输出的 Markdown 转成微信纯文本可读版：
 * 微信客户端将正文解析为 Markdown 格式：单换行（\n）会被视作软换行折叠为空格，
 * 导致标题、段落和列表全部挤在同一行。
 * 因此标题、段落和列表项之间必须保持双换行（\n\n）作为独立段落，防止粘连成整段。
 */
export function toClawText(raw) {
    let text = String(raw == null ? '' : raw).replace(/\r\n/g, '\n');
    text = text.replace(/```[a-z0-9_-]*\n?/gi, '').replace(/```/g, '');
    text = text.replace(/^#{1,6}\s*(.+)$/gm, '【$1】');
    text = text.replace(/^\*\*(.+?)\*\*\s*$/gm, '【$1】');
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1');
    text = text.replace(/(^|\s)\*([^*\n]+)\*/g, '$1$2');
    text = text.replace(/`([^`\n]+)`/g, '$1');
    text = text.replace(/^\s*[-*+]\s+/gm, '• ');
    text = text.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '');
    text = text.replace(/^\s*\|(.+)\|\s*$/gm, (_, row) => row.split('|').map((cell) => cell.trim()).filter(Boolean).join(' · '));
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1：$2');
    text = text.replace(/^---+$/gm, '');
    // 确保标题、列表符号前后具有双换行段落分隔，防止微信客户端将单换行折叠为空格
    text = text.replace(/(?<!\n)\n(【[^】\n]+】)/g, '\n\n$1');
    text = text.replace(/(【[^】\n]+】)\n(?!\n)/g, '$1\n\n');
    text = text.replace(/(?<!\n)\n(• |\d+\.\s+)/g, '\n\n$1');
    return text.replace(/\n{3,}/g, '\n\n').trim();
}

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
    return sources.map((s, i) => (i + 1) + '. ' + sourceLabel(s) + '\n   ' + s.snippet).join('\n\n');
}

export async function runSearch(db, userId, query) {
    const history = await loadChatContext(db, userId);
    const isListOrRange = Boolean(
        parseTimeRangeFromQuestion(query) || parseTargetTypeFromQuestion(query) ||
        /(?:列出|全部|所有|都有|哪些|汇总|盘点|梳理|总结|回顾|清单)/.test(query)
    );
    const topK = isListOrRange ? 20 : 8;
    const maxChars = isListOrRange ? 3600 : 1400;
    const memory = await retrieveGardenMemories(db, userId, query, { topK, maxChars, history });
    const sources = memory.sources || [];
    if (!sources.length) return '没有检索到与「' + query + '」相关的记录。';
    return '**检索「' + query + '」** · 命中 ' + sources.length + ' 条\n\n' + formatSources(sources);
}

export async function runAsk(env, db, userId, question) {
    const limit = await checkRateLimitShared(db, 'bot-ai:' + userId, BOT_AI_LIMIT.limit, BOT_AI_LIMIT.windowMs);
    if (!limit.ok) return '提问太频繁了，请 ' + (limit.retryAfter || 60) + ' 秒后再试。';

    const history = await loadChatContext(db, userId);
    const isListOrRange = Boolean(
        parseTimeRangeFromQuestion(question) || parseTargetTypeFromQuestion(question) ||
        /(?:列出|全部|所有|都有|哪些|汇总|盘点|梳理|总结|回顾|清单)/.test(question)
    );
    const topK = isListOrRange ? 20 : 6;
    const maxChars = isListOrRange ? 3600 : 1600;
    const memory = await retrieveGardenMemories(db, userId, question, { topK, maxChars, history });
    const preferences = await loadPreferencePrompt(db, userId);
    let systemPrompt = '你是用户身边一位性格偏淡、安静克制的 INFP 伙伴。请只依据给出的记忆片段回答问题，'
        + '简单直接、平缓克制，片段没提到的如实说明，不要凭空编造。不用长篇大论，避免空洞客套、波浪号和说教。'
        + (preferences ? '\n\n【用户设定的交流偏好（只调整表达方式）】\n' + preferences : '');
    if (isListOrRange) {
        systemPrompt += '\n\n【列表与回顾排版准则】：用户要求列出或汇总记录。请按日期分类分段呈现，每个条目独立成行，条目间保持空行换行，切勿把多条记录挤成一大段。';
    }
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
    const isListOrRange = Boolean(
        parseTimeRangeFromQuestion(queryText) || parseTargetTypeFromQuestion(queryText) ||
        /(?:列出|全部|所有|都有|哪些|汇总|盘点|梳理|总结|回顾|清单)/.test(queryText)
    );
    let memory = { tokens: [], sources: [], contextText: '' };
    if (needsGarden) {
        try {
            const topK = isListOrRange ? 20 : 6;
            const maxChars = isListOrRange ? 3600 : 1600;
            memory = await retrieveGardenMemories(db, userId, queryText, { topK, maxChars, history: effectiveHistory });
        } catch (err) {
            console.error('[bot] 花园记忆检索异常，降级无记忆对话: ' + (err && err.message));
            memory = { tokens: [], sources: [], contextText: '' };
        }
    }
    const sources = memory.sources || [];
    // 没有主题词时不拿「最近几条」硬凑记忆：那会让「在吗」突然翻旧账；但若有时段范围或明确容器查询，则属于有效检索。
    const hasTopic = (Array.isArray(memory.tokens) && memory.tokens.length > 0) || Boolean(memory.timeRange) || Boolean(memory.targetType);
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
    if (isListOrRange) {
        blocks.push('【列表与回顾排版准则】：用户要求列出、汇总或回顾历史记录。请按日期分类分段呈现，每个日期设独立小标题（如【MM-DD】），每个条目用清单符号（- ）独立成行，条目与段落间保持换行空行，切勿将多条记录堆砌在单个自然段中，以便微信客户端舒适阅读。');
    }

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
    if (isListOrRange) {
        output = formatListOutput(output);
    }
    const { cleanText, proposal } = parseProposeMemory(output);
    if (proposal && proposal.content) {
        output = cleanText;
        const existing = await listProfile(db, userId);
        const tag = proposal.label || '';
        const isDupe = existing.some(it => String(it.content) === proposal.content && (!tag || String(it.label || '') === tag));
        if (!isDupe) {
            const saved = await savePendingAction(db, userId, 'set_profile', 'bot_profile', 0, proposal);
            if (saved !== false) {
                output += '\n\n💡 记下你的新档案「' + (tag ? tag + '：' : '') + proposal.content + '」？回复【确认】保存，回复【取消】忽略。';
            }
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

// ───────────────────────── 结构化指令分发器 ─────────────────────────

/**
 * 1. 系统与偏好档案指令 (System / Settings / Profile)
 */
async function dispatchSystemCommand(env, db, userId, text) {
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

    if (/^(?:天气诊断|天气状态|检查天气|和风状态)$/.test(text)) {
        return diagnoseWeatherConfig(env, db, userId);
    }

    // 交流偏好优先于「忘记」：否则「忘记偏好 …」会被档案的忘记指令抢走。
    const preferenceReply = await maybePreferenceCommand(db, userId, text);
    if (preferenceReply !== null) return preferenceReply;

    if (PROFILE_VIEW_RE.test(text)) return runProfileView(db, userId);

    const forget = parseForgetCommand(text);
    if (forget) return runForget(db, userId, forget);

    // 意图明确但没带内容（光杆「记住」）：先答清楚，别丢给对话模型
    if (REMEMBER_BARE_RE.test(text)) return REMEMBER_BARE_REPLY;

    const remember = parseRememberCommand(text);
    if (remember) return runRemember(db, userId, remember);

    return null;
}

async function hasRecentReminderContext(db, userId) {
    const recentRow = await db.prepare("SELECT id FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status = 'pending' AND created_at >= datetime('now', '+8 hours', '-15 minutes') LIMIT 1")
        .bind(userId).first();
    if (recentRow) return true;
    const history = await loadChatContext(db, userId);
    const lastAssistant = [...history].reverse().find((t) => t.role === 'assistant');
    return Boolean(lastAssistant && /(?:已记下|已设待办提醒|我的提醒|改好了|几点提醒你|已经在排队了)/.test(String(lastAssistant.content || '')));
}

/**
 * 2. 定点提醒与待办事项指令 (Reminders & Tasks)
 */
async function dispatchReminderCommand(db, userId, text, nowMs) {
    // 定点提醒：解析是纯同步的，执行要查库。
    // 顺序讲究——「我的提醒 / 改期 / 取消提醒 / 完成」都排在普通记录指令之前，否则会被当成闲聊。
    const remind = parseRemindCommand(text, nowMs);
    if (remind.matched) return runRemind(db, userId, remind, nowMs);
    if (isReminderList(text)) return listReminders(db, userId, nowMs);

    const directReschedule = parseRescheduleReminder(text, nowMs, { allowConversationalCorrection: false });
    if (directReschedule) return rescheduleReminder(db, userId, directReschedule, nowMs);

    const cancelArg = parseCancelReminder(text);
    if (cancelArg) {
        if (!text.includes('提醒') && await readPendingAction(db, userId)) {
            return null;
        }
        return cancelReminder(db, userId, cancelArg.arg, nowMs);
    }

    // 对话纠偏（「是晚上8点我说错了」「不对，是20:00」）：先纯同步匹配句式，命中后再核验近期提醒语境
    const corrReschedule = parseRescheduleReminder(text, nowMs, { allowConversationalCorrection: true });
    if (corrReschedule && await hasRecentReminderContext(db, userId)) {
        return rescheduleReminder(db, userId, corrReschedule, nowMs);
    }

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
            return '搞定啦 ✅ 提醒「' + fired.text + '」已标为完成。';
        }
        const target = await db.prepare("SELECT id, text, status FROM bot_reminders WHERE user_id = ?1 AND is_deleted = 0 AND status IN ('pending', 'fired') AND text LIKE '%' || ?2 || '%' ORDER BY fire_at_ms ASC LIMIT 1").bind(userId, kw).first();
        if (target) {
            await db.prepare("UPDATE bot_reminders SET status = 'done', follow_up_retry_at_ms = 0, updated_at = datetime('now', '+8 hours') WHERE id = ?1").bind(target.id).run();
            return '搞定啦 ✅ 待办提醒「' + target.text + '」已核销。';
        }
        const feedRow = await db.prepare("SELECT id, content FROM quick_feeds WHERE user_id = ?1 AND is_deleted = 0 AND content LIKE '[ ] %' AND content LIKE '%' || ?2 || '%' ORDER BY id DESC LIMIT 1").bind(userId, kw).first();
        if (feedRow) {
            const upd = feedRow.content.replace(/^\[ \]\s*/, '✅ ');
            await db.prepare("UPDATE quick_feeds SET content = ?1, updated_at = datetime('now', '+8 hours') WHERE id = ?2").bind(upd, feedRow.id).run();
            return '已划掉待办 ✅\n> ' + upd;
        }
    }

    // 「完成 / 还没」回执（优先响应 12 小时内到期提醒；同时间点批量触发的一起收尾；无提醒时划掉最近一条待办）
    if (parseDoneReply(text) || parseNotYetReply(text)) {
        const firedAll = await recentFiredReminders(db, userId, nowMs);
        if (firedAll.length) {
            const latestTs = Number(firedAll[0].fired_at_ms || 0);
            const batch = firedAll.filter((r) => Math.abs(Number(r.fired_at_ms || 0) - latestTs) <= 60000);
            if (parseDoneReply(text)) {
                for (const r of batch) await completeReminder(db, userId, r);
                if (batch.length === 1) return '搞定啦 ✅ 提醒「' + batch[0].text + '」已标为完成。';
                return '搞定啦 ✅ 这 ' + batch.length + ' 条提醒（' + batch.map((r) => r.text).join('、') + '）已标为完成。';
            }
            for (const r of batch) {
                try { await skipReminderFollowUp(db, userId, r); } catch (err) { console.error('[reminder] 取消失败追问: ' + (err && err.message)); }
            }
            return '好，那就不催了。做完了随时跟我说一声。';
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

    return null;
}

/**
 * 3. 花园资源写入与管理指令 (Garden Resources)
 */
async function dispatchGardenCommand(db, userId, text) {
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

    return null;
}

/**
 * 4. 媒体追问、外部链接与联网检索指令 (Media / Search)
 */
async function dispatchMediaSearchCommand(env, db, userId, text) {
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
 * 已支持的显式指令路由器：分流至 6 大结构化领域
 * (System/Settings, Reminders/Tasks, Health, Agent Goals, Garden Resources, Media/Search)
 * 返回 null 表示「不是指令」，交给对话模型
 */
export async function runCommand(env, db, userId, content) {
    const text = normalizeCommandText(content) || String(content || '').trim();
    const nowMs = Date.now();

    // 1. 系统、设置与偏好档案 (System / Settings)
    const systemReply = await dispatchSystemCommand(env, db, userId, text);
    if (systemReply !== null) return systemReply;

    // 2. 定点提醒与待办事项 (Reminders / Tasks)
    const reminderReply = await dispatchReminderCommand(db, userId, text, nowMs);
    if (reminderReply !== null) return reminderReply;

    // 3. 健康打卡（一天一行，重复合并） (Health)
    const healthReply = await maybeRunHealthCommand(db, userId, text, nowMs);
    if (healthReply !== null) return healthReply;

    // 4. 目标 Agent CLI（建目标/查进度/继续/暂停/重规划/受控审批） (Agent Goals)
    const agentReply = await maybeRunAgentCommand(env, db, userId, text);
    if (agentReply !== null) return agentReply;

    // 5. 花园资源（随手记/管家管理/收藏/提示词/暂存媒体提交） (Garden Resources)
    const gardenReply = await dispatchGardenCommand(db, userId, text);
    if (gardenReply !== null) return gardenReply;

    // 6. 媒体与检索（看图追问/播客链接速览/语义检索/知识问答） (Media / Search)
    const mediaReply = await dispatchMediaSearchCommand(env, db, userId, text);
    if (mediaReply !== null) return mediaReply;

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
        // 帮助与诊断只是系统查询与使用说明，不必占用对话上下文与历史存储
        if (!HELP_RE.test(cmdText) && !/^(?:天气诊断|天气状态|检查天气|和风状态)$/.test(cmdText)) {
            await saveChatTurn(db, userId, 'user', text);
            await saveChatTurn(db, userId, 'assistant', commandReply);
        }
        return commandReply;
    }

    // 高精度天气问答：和风天气已配置时优先返回逐小时温度、降雨与温差信息
    const weatherReply = await maybeWeatherAnswer(env, db, userId, text);
    if (weatherReply) {
        await saveChatTurn(db, userId, 'user', text);
        await saveChatTurn(db, userId, 'assistant', weatherReply);
        return weatherReply;
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
