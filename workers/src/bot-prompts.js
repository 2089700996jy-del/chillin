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

/** 话题切换意图：显式提出换话题时切断历史上下文干扰 */
export const TOPIC_SHIFT_RE = /^(?:换个话题|不说这个了|聊点别的|打住|先不说这个|换个聊法)[，,、；;\s]*(.*)$/i;

/** 纯闲聊/寒暄/即时感叹模式（跳过重型花园检索） */
export const PURE_CHITCHAT_RE = /^(?:你好|您好|哈喽|hello|hi|hey|早|早安|早上好|午安|中午好|晚上好|晚安|在吗|在不在|有人吗|呼叫|滴滴|好的|收到|行|可以|好吧|原来如此|这样啊|明白|知道了|多谢|谢谢|感谢|哈哈+|呵呵+|嘻嘻+|喵|嗯嗯?|哦哦?|对|确实|是的|今天好累|好累啊|有点困|困死了|肚子好饿|下班了|下雨了|无聊|太难了|好开心|你是谁|你叫什么|你能做什么|你多大了|你会什么|讲个笑话|陪我聊聊天)[\s!！?？~～.。]*$/i;

/** 显式或强烈的个人知识/历史回忆线索 */
export const GARDEN_TRIGGER_RE = /(?:笔记|周记|随手记|收藏|提示词|记录|花园|写过|记过|提过|提到|以前|过去|当时|那天|那次|什么时候|历史|回忆|回顾|查一下|翻一下|找一下|帮我找|帮我搜|看下我|有没有记|有没有写|我什么时候|我曾经|我之前|我上次|还有吗|详细说说|展开说说)/;

/**
 * 判断用户输入是否需要触发花园 RAG 检索：
 * 纯闲聊/问候/情绪感叹跳过；具有显式花园意图或实质性问题才检索
 */
export function shouldRetrieveGarden(text, history = []) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (GARDEN_TRIGGER_RE.test(raw)) return true;
    if (PURE_CHITCHAT_RE.test(raw)) return false;
    if (raw.length < 4) return false;
    if (Array.isArray(history) && history.length > 0) {
        const last = history[history.length - 1];
        if (last && last.role === 'assistant' && (String(last.content).includes('依据：') || String(last.content).includes('记录'))) {
            if (/^(?:还有|然后|那|具体|继续|再说)/.test(raw)) return true;
        }
    }
    return true;
}

