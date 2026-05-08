-- Chillin 数字花园 - 初始建表
-- 周记/记忆切片
CREATE TABLE IF NOT EXISTS weeklies (
    id INTEGER PRIMARY KEY,
    category TEXT NOT NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    date TEXT NOT NULL,
    cover TEXT,
    weekly_data TEXT,
    content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 备忘录
CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    content TEXT,
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 收藏夹
CREATE TABLE IF NOT EXISTS bookmarks (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 插入默认周记示例
INSERT OR IGNORE INTO weeklies (id, category, title, summary, date, cover, weekly_data, content) VALUES (
    1,
    '🌸',
    '2023-W42: 记忆切片',
    '在这个节奏极快的秋周里，抓住了一些微小的确幸：黑塞、坂本龙一、和一碗完美的意面。',
    '2023年10月22日',
    'https://images.unsplash.com/photo-1505909182942-e2f09aee3e89?q=80&w=800&auto=format&fit=crop',
    '{"music":{"title":"Merry Christmas Mr. Lawrence","artist":"坂本龙一","lyric":"无需歌词，唯有宁静跨越时间。"},"media":[{"icon":"🎬","title":"《奥本海默》","desc":"在 IMAX 厅感受了极其震撼的音效与人类群星闪耀的矛盾。"}],"life":{"image":"https://images.unsplash.com/photo-1473093295043-cdd812d0e601?q=80&w=600&auto=format&fit=crop","caption":"周五晚上的完美意面 🍝"},"podcast":"在《Huberman Lab》里学到了，早晨醒来后不要立刻看手机，而是先去接触自然光 10 分钟，能够完美重置昼夜节律。","work":{"title":"Next.js App Router 迁移","desc":"本周踩完了 Server Actions 的坑。结论：将复杂的数据验证逻辑全部移到单独的 API 路由。"}}',
    '<p>时间的流逝在开始工作后变得惊人的快。周一到周五仿佛被压缩成了一天。所以决定用这样的方式，把每周值得记住的时刻切片保存下来。</p>'
);

-- 插入默认笔记示例
INSERT OR IGNORE INTO notes (id, title, content, date) VALUES
    (101, '下周购物清单', '1. 咖啡豆\n2. 全脂牛奶\n3. 极简风马克杯\n4. 绿植（龟背竹）', '2023年10月23日'),
    (102, '零碎灵感', '也许可以尝试给博客加上深色模式？\n颜色方案可以参考 GitHub 的 Dark Dimmed。', '2023年10月24日');

-- 插入默认收藏示例
INSERT OR IGNORE INTO bookmarks (id, type, title, url, description) VALUES
    (201, '🛠️ 工具', 'Notion', 'https://notion.so', '极致的块状编辑器，灵感的发源地。'),
    (202, '🌐 网站', 'Vercel', 'https://vercel.com', '前端项目一键部署的神仙平台。'),
    (203, '🎬 电影', '豆瓣电影', 'https://movie.douban.com', '找冷门好片的唯一去处。');
