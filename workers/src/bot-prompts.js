/**
 * Bot 提示词与指令格式化辅助 (bot-prompts.js)
 * 包含小助手帮助文本、系统提示词模板、输入包裹符剥除与来源标签格式化。
 */
import { parseDateToYmd } from './rag.js';

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

/** 聊天人格与边界：真诚老友，自然感知持久事实，通过提议标签征询确认 */
export const CHAT_SYSTEM_PROMPT = `你是 Chillin 私人 AI 伙伴与管家，自然、真诚、放松地交流。
像一位值得信赖的老朋友，交流简炼有温度，切忌机械客套、空洞共情或助手腔调（不要每次都先共情，不要机械限制长度，不要总说「根据我对你的了解」）。
普通聊天默认只聊天，不自动记录。
【时间知觉与记忆沉淀准则】：
1. 记忆片段与个人档案均标注了沉淀时间与相对时距（如「昨天确认」、「3个月前记录」、「1年前」）。
2. 在交谈时请结合时间知觉作答：优先采信更新的事实；对久远的记忆使用「你之前/当时提到过」等自然口吻，不要把两年前的旧事当成昨天发生的事情。
【长期记忆提议与边界准则】：
1. 你自己没有写入能力：普通对话中绝不要直接声称「已为你记下」或「已保存」，因为系统会弹出确认由用户决定。
2. 指令通道执行真实操作：「记录：<内容>」存入随手记。定点提醒到点必达，不受日限约束。不编造事实。
3. 自然感知对话中具有长期价值的稳定事实（如常住地/城市、职业/岗位、饮食禁忌、核心习惯、重要偏好等）。
4. 当发现值得长期记住的事实时，在自然回复最后附带且仅附带一条提议标签：
   <propose_memory label="分类" content="核心事实"/>
   示例：<propose_memory label="常住地" content="现居杭州"/>
   切勿为临时琐事、情绪吐槽或待办任务打提议标签。`;

/**
 * 微信里转发/粘贴的内容常带着包裹符与句末标点（「记录：xxx」。），
 * 指令一律先剥掉最外层这类字符再匹配——否则用户明明发了指令，却被当成闲聊丢给模型。
 * 只剥最外层、最多两层，正文里的标点原样保留。
 */
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

/**
 * 来源标签统一成一种：日期一律 YYYY-MM-DD，标题只在提供额外信息时追加。
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

/**
 * 来源脚注按需附上：默认回复一律不带「依据：」，只有用户主动追问来源时才给。
 */
export const EVIDENCE_RE = /(依据|来源|出处|根据什么|凭什么|怎么知道|怎么查|怎么来|哪里知道|哪儿知道|哪看到的|哪来的|哪查的|证据|原始记录|引用|source|references?)/i;

export function wantsEvidence(text) {
    return EVIDENCE_RE.test(String(text || ''));
}

/** 话题切换意图：显式提出换话题（彻底翻篇并清空前序上下文） */
export const TOPIC_SHIFT_RE = /^(?:换个话题|不说这个了|聊点别的|打住(?:打住)?|先不说这个|换个聊法|不扯这个了|翻篇(?:了)?|清空话题)[，,、；;\s]*(.*)$/i;
export const HARD_TOPIC_SHIFT_RE = TOPIC_SHIFT_RE;

/** 软话题转移：带有明显转折词，需平滑淡出旧上下文干扰 */
export const SOFT_TOPIC_SHIFT_RE = /^(?:对了|说起来|顺便问(?:一下|下)?|另外问(?:一下|下)?|问你个(?:别的事|不相干的)|插一句|说正经的|言归正传)[，,、；;\s]+([\s\S]+)$/i;

export function parseTopicShift(text) {
    const raw = String(text || '').trim();
    const hard = HARD_TOPIC_SHIFT_RE.exec(raw);
    if (hard) return { type: 'hard', nextTopic: hard[1].trim(), raw };
    const soft = SOFT_TOPIC_SHIFT_RE.exec(raw);
    if (soft) return { type: 'soft', nextTopic: soft[1].trim(), raw };
    return null;
}

/** 意图常量定义 */
export const INTENT_ACTION_TASK = 'action_task';
export const INTENT_PROFILE_QA = 'profile_qa';
export const INTENT_KNOWLEDGE_RAG = 'knowledge_rag';
export const INTENT_CHITCHAT = 'chitchat';

/** 自我档案与画像问答线索（优先使用 Profile Prompt，跳过全文检索） */
export const PROFILE_QA_RE = /(?:你记得我|你记住了我|你了解我|你眼中的我|我是一个怎样的人|我是个什么样的人|我是一个什么样的人|我的画像|我的档案|我的个人信息|我叫什么|我常住|我住在|我的家在哪|我的职业|我做什么工作|我的工作|我的岗位|我喜欢吃|我喜欢喝|我平时喜欢|我的爱好|我的作息|我几点睡|我一般几点|我对什么过敏|我有什么忌口|我喝咖啡)/;

/** 纯闲聊/寒暄/即时感叹模式（跳过重型花园检索） */
export const PURE_CHITCHAT_RE = /^(?:你好|您好|哈喽|hello|hi|hey|早|早安|早上好|午安|中午好|晚上好|晚安|在吗|在不在|有人吗|呼叫|滴滴|好的|收到|行|可以|好吧|原来如此|这样啊|明白|知道了|多谢|谢谢|感谢|哈哈+|呵呵+|嘻嘻+|喵|嗯嗯?|哦哦?|对|确实|是的|今天好累|好累啊|有点困|困死了|肚子好饿|下班了|下雨了|无聊|太难了|好开心|你是谁|你叫什么|你能做什么|你多大了|你会什么|讲个笑话|陪我聊聊天)[\s!！?？~～.。]*$/i;

/** 显式或强烈的个人知识/历史回忆线索 */
export const GARDEN_TRIGGER_RE = /(?:我(?:还在|最近|上次|以前|过去|当时|曾经|到底|有没有|何时|什么时候|之前|写过|读过|看过|记过|提过|去过|买过|学过|在读|在看|在学)|记过|提过|提到|笔记|周记|随手记|收藏|提示词|记录|花园|历史|回忆|回顾|查一下|翻一下|找一下|帮我找|帮我搜|看下我|有没有记|有没有写|还有吗|详细说说|展开说说)/;

/**
 * 意图动态分流器：识别用户输入的核心意图
 */
export function classifyUserIntent(text, history = []) {
    const raw = String(text || '').trim();
    if (!raw) return { intent: INTENT_CHITCHAT, confidence: 1 };
    if (PROFILE_QA_RE.test(raw)) return { intent: INTENT_PROFILE_QA, confidence: 0.95 };
    if (shouldRetrieveGarden(raw, history)) return { intent: INTENT_KNOWLEDGE_RAG, confidence: 0.9 };
    if (PURE_CHITCHAT_RE.test(raw)) return { intent: INTENT_CHITCHAT, confidence: 0.95 };
    return { intent: INTENT_CHITCHAT, confidence: 0.8 };
}

/**
 * 判断用户输入是否需要触发花园 RAG 检索：
 * 纯闲聊/问候/自我档案问答跳过；具有显式花园意图或实质性历史问题才检索
 */
export function shouldRetrieveGarden(text, history = []) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (PROFILE_QA_RE.test(raw)) return false;
    if (PURE_CHITCHAT_RE.test(raw)) return false;
    if (wantsEvidence(raw)) return true;
    if (GARDEN_TRIGGER_RE.test(raw)) return true;
    if (Array.isArray(history) && history.length > 0) {
        const last = history[history.length - 1];
        if (last && last.role === 'assistant' && (String(last.content).includes('依据：') || String(last.content).includes('记录'))) {
            if (/^(?:还有|然后|那|具体|继续|再说|后来|详细)/.test(raw)) return true;
        }
    }
    return false;
}

/**
 * 相对时间与沉淀时距格式化器（东八区基准，赋予 AI 敏锐的时间知觉）
 */
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
 * 个人档案时间标签（记录沉淀时距与置信度指示）
 */
export function formatProfileTimeTag(dateInput, nowMs = Date.now()) {
    if (!dateInput) return '';
    const dateStr = String(dateInput).slice(0, 10);
    const targetMs = Date.parse(dateStr + 'T00:00:00+08:00');
    if (isNaN(targetMs)) return '（' + dateStr + ' 确认）';
    const nowEast8 = new Date(nowMs + 8 * 3600 * 1000);
    const todayStr = nowEast8.toISOString().slice(0, 10);
    const todayMs = Date.parse(todayStr + 'T00:00:00+08:00');
    const diffDays = Math.round((todayMs - targetMs) / 86400000);
    let rel = '今天';
    if (diffDays === 1) rel = '昨天';
    else if (diffDays === 2) rel = '前天';
    else if (diffDays >= 3 && diffDays < 7) rel = diffDays + '天前';
    else if (diffDays >= 7 && diffDays < 14) rel = '上周';
    else if (diffDays >= 14 && diffDays < 30) rel = Math.floor(diffDays / 7) + '周前';
    else if (diffDays >= 30 && diffDays < 365) rel = Math.floor(diffDays / 30) + '个月前';
    else if (diffDays >= 365) rel = Math.floor(diffDays / 365) + '年前';
    return '（' + rel + '确认 · ' + dateStr + '）';
}

