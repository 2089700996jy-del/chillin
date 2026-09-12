/** Mutable app state shared across modules. */

export const DEFAULT_WEEKLY = [{
    id: 1, category: "🌸", title: "2023-W42: 记忆切片",
    summary: "在这个节奏极快的秋周里，抓住了一些微小的确幸：黑塞、坂本龙一、和一碗完美的意面。",
    date: "2023年10月22日",
    cover: "https://images.unsplash.com/photo-1505909182942-e2f09aee3e89?q=80&w=800&auto=format&fit=crop",
    weeklyData: {
        music: { title: "Merry Christmas Mr. Lawrence", artist: "坂本龙一", lyric: "无需歌词，唯有宁静跨越时间。" },
        media: [{ icon: "🎬", title: "《奥本海默》", desc: "在 IMAX 厅感受了极其震撼的音效与人类群星闪耀的矛盾。" }],
        life: { image: "https://images.unsplash.com/photo-1473093295043-cdd812d0e601?q=80&w=600&auto=format&fit=crop", caption: "周五晚上的完美意面 🍝" },
        podcast: "在《Huberman Lab》里学到了，早晨醒来后不要立刻看手机，而是先去接触自然光 10 分钟，能够完美重置昼夜节律。",
        work: { title: "Next.js App Router 迁移", desc: "本周踩完了 Server Actions 的坑。结论：将复杂的数据验证逻辑全部移到单独的 API 路由。" }
    },
    content: "<p>时间的流逝在开始工作后变得惊人的快。周一到周五仿佛被压缩成了一天。所以决定用这样的方式，把每周值得记住的时刻切片保存下来。</p>"
}];

export const DEFAULT_NOTES = [
    { id: 101, title: "下周购物清单", content: "1. 咖啡豆\n2. 全脂牛奶\n3. 极简风马克杯\n4. 绿植（龟背竹）", date: "2023年10月23日" },
    { id: 102, title: "零碎灵感", content: "也许可以尝试给博客加上深色模式？\n颜色方案可以参考 GitHub 的 Dark Dimmed。", date: "2023年10月24日" }
];

export const DEFAULT_BOOKMARKS = [
    { id: 201, type: "🛠️ 工具", title: "Notion", url: "https://notion.so", desc: "极致的块状编辑器，灵感的发源地。", image: "" },
    { id: 202, type: "🌐 网站", title: "Vercel", url: "https://vercel.com", desc: "前端项目一键部署的神仙平台。" },
    { id: 203, type: "🎬 电影", title: "豆瓣电影", url: "https://movie.douban.com", desc: "找冷门好片的唯一去处。" }
];

export const DEFAULT_FEEDS = [
    {
        id: 1,
        content: "今天将数字花园升级接入了 AI 记忆能力与随手记流！可以随时在顶部倾倒思考，AI 也会实时捕捉脉络。",
        type: "text",
        tags: ["#技术", "#灵感"],
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
    }
];

export const DEFAULT_PROMPTS = [
    {
        id: 301,
        title: "代码审查与重构专家",
        project: "Chillin",
        scene: "开发",
        content: "你是一位资深全栈工程师与架构专家。请审查以下代码，指出潜在缺陷、性能瓶颈、可维护性问题，并给出符合最佳实践的重构版本：\n\n```\n{{输入代码}}\n```\n\n要求：\n1. 先给出核心问题清单（按严重程度排序）\n2. 给出简洁清晰的优化后完整代码\n3. 简短说明重构前后的改进点",
        description: "深度审查代码质量，找出性能与安全性隐患并重构",
        tags: "#代码,#重构",
        is_pinned: 1
    },
    {
        id: 302,
        title: "周报与工作成果提炼",
        project: "日常工作",
        scene: "写作",
        content: "请根据我本周的零散工作记录，提炼整理一份结构清晰、重点突出的专业周报：\n\n【本周原始记录】：\n{{本周工作碎片}}\n\n要求格式：\n- 🎯 核心产出与成果（数据化量化）\n- 🚀 重点攻关与解决的问题\n- 💡 经验复盘与下周规划",
        description: "将零碎想法或日志整理为大厂级专业周报",
        tags: "#周报,#工作",
        is_pinned: 1
    },
    {
        id: 303,
        title: "深度思考追问与反思",
        project: "思维模型",
        scene: "推演",
        content: "请针对我当前的观点或决策进行批判性思维（Critical Thinking）审视：\n\n【我的观点/决策】：\n{{输入你的想法}}\n\n请扮演严厉但富有洞察力的苏格拉底式导师：\n1. 寻找该论点背后的隐含假设（这些假设一定成立吗？）\n2. 列出最强烈的 3 个反面证据或潜在盲区\n3. 提供 2 个能从根本上检验该想法的可行性微实验",
        description: "用苏格拉底式追问识别盲区与底层假设",
        tags: "#思维,#决策",
        is_pinned: 0
    },
    {
        id: 304,
        title: "结构化 Markdown 润色",
        project: "内容创作",
        scene: "润色",
        content: "请阅读以下草稿，在保留原作者口吻和核心信息的前提下，进行中文语言润色与排版优化：\n\n【草稿原文】：\n{{输入草稿}}\n\n润色原则：\n1. 消除啰嗦赘字，增强节奏感与表现力\n2. 统一中英文排版规范（中英文混排加空格）\n3. 梳理清晰的层级标题与要点列表，提升阅读愉悦感",
        description: "精修中英文混排、标点规范与表达节奏",
        tags: "#写作,#排版",
        is_pinned: 0
    }
];

export const state = {
    authToken: localStorage.getItem('chillin_token') || '',
    authUser: JSON.parse(localStorage.getItem('chillin_user') || 'null'),
    database: [],
    notesDatabase: [],
    bookmarksDatabase: [],
    promptsDatabase: [],
    feedsDatabase: [],
    echoCardsDatabase: [],
    aiChatHistory: [],
    isRegisterMode: false,
};
