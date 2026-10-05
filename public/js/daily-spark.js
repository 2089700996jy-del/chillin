/**
 * Chillin Daily Spark, Mood & Energy Check-in, Serendipity Capsule, and Weekly Mind Mirror.
 * Apple HIG / Inset Grouped standard, zero-build native ESM.
 */
import { escapeHtml, getEast8Time, showToast, markdownToHtml } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';
import {
    apiRequest,
    stampLocalUpdate,
    saveFeedsDatabase,
    apiSyncFeed,
    saveNotesDatabase,
    apiSyncNote,
} from './api.js';
import { setHtml } from './trusted-types.js';

// 36 个富含人文温度与减压心智的轻启发问题
const SPARK_PROMPTS = [
    '今天发生的哪一件微不足道的小事，如果没发生，你的心情会不一样？',
    '今天吃到的哪一口食物，或者喝到的哪一口饮料，让你感受到了片刻治愈？',
    '此刻环顾四周，把目光停在视线里最顺眼的一件物品上，它为什么在这里？',
    '今天有哪一刻让你体会到了片刻的松弛或释怀？',
    '今天听到的哪一首歌，或者哪一句偶然路过的话，触动了你的心弦？',
    '如果用一个天气词或自然颜色来形容你今天下午的心境，会是什么？',
    '今天有什么事情，如果换成一年前的你可能会焦虑，但今天你平静应对了？',
    '今天有没有向某个人、某只动物或某处风景悄悄投去温柔的一瞥？',
    '今天工作中或日常里，哪一个瞬间让你觉得“原来我也可以做得不错”？',
    '此刻身体感觉最紧绷或最放松的部位是哪里？试着深呼吸一次。',
    '最近有没有哪件事，让你突然意识到自己其实已经走过了很长的路？',
    '今天有什么想吐槽、抱怨或者清空的大脑缓存吗？把它写在这里留给今天。',
    '如果今天的生活是一部电影，你觉得最适合做预告片画面的镜头是哪一幕？',
    '今天喝水、咖啡还是茶？在饮下的那一瞬，脑海里划过的是什么想法？',
    '今天遇到的哪一个意外的“计划之外”，反而带来了意料之外的体验？',
    '最近有没有发现哪个习以为常的日用品、软件或小角落，其实帮了你大忙？',
    '如果给明早起床的自己留一句悄悄话，你最想提醒自己什么？',
    '今天有哪一个瞬间，你完全沉浸在当下，忘记了看手机？',
    '最近有没有产生某个奇怪但有趣的小念头？记下来，别让它跑了。',
    '今天跟谁说的那句话，让你感觉真诚而舒适？',
    '今天走在路上时，抬头看过天空或树叶吗？它们的色彩是怎样的？',
    '如果今天什么都不用想，你最想在这个夜晚给自己安排怎样的一个小时？',
    '今天完成的哪件微小的事，让你在心里给自己默默点了个赞？',
    '有什么事情是你最近一直在默默忍受或消耗精力的？试着用一句话写下来。',
    '今天哪个瞬间，让你感受到了人与人之间某种奇妙的善意或默契？',
    '如果把今天的精力值打个分（1-10分），你给自己几分？为什么？',
    '最近读到或刷到的哪一个观点，让你忍不住停下来思考了半分钟？',
    '今天有什么事情是完全为了取悦你自己而做的吗？',
    '试着记录下此刻耳边能听到的三种细微声音（风声、键盘、车流…）',
    '今天在哪个决定上，你遵循了自己的本心，而不是别人的期待？',
    '有什么好消息（哪怕极小），是你很想偷偷跟未来的自己分享的？',
    '最近有什么原本执着的事情，突然觉得“其实也没那么重要”了？',
    '今天路过的哪个街角、橱窗或光影，让你忍不住多看了两眼？',
    '如果今天遇到的一切都是为了教给你某件小事，你觉得那是什么？',
    '有什么话是你今天想说却咽回肚子里的？写在这里，只有花园知道。',
    '闭上眼睛三秒钟，今天浮现在你脑海里的第一个人或画面是谁？'
];

export const MOODS = [
    { id: 'energy', emoji: '⚡', label: '充能', desc: '能量充沛' },
    { id: 'calm', emoji: '🌿', label: '平静', desc: '随遇而安' },
    { id: 'focus', emoji: '☕', label: '续命', desc: '专注当下' },
    { id: 'tired', emoji: '🌧️', label: '疲惫', desc: '允许停歇' },
    { id: 'inspired', emoji: '✨', label: '灵感', desc: '闪烁火花' }
];

let currentSparkIndex = 0;
let currentSerendipityShuffleOffset = 0;

function getTodayKey() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function getStoredTodayMood() {
    try {
        return localStorage.getItem(`chillin_mood_${getTodayKey()}`);
    } catch (_) {
        return null;
    }
}

function setStoredTodayMood(moodId) {
    try {
        localStorage.setItem(`chillin_mood_${getTodayKey()}`, moodId);
    } catch (_) {}
}

/** 1. 3秒心绪打卡条 */
export function renderMoodPills() {
    const container = document.getElementById('mood-pills-row');
    const statusEl = document.getElementById('mood-checkin-status');
    if (!container) return;

    const todayMood = getStoredTodayMood();

    setHtml(container, MOODS.map(m => {
        const isActive = todayMood === m.id;
        return `
            <button type="button" class="k-mood-chip${isActive ? ' active' : ''}" data-mood-id="${m.id}" title="${m.label} · ${m.desc}" role="radio" aria-checked="${isActive}">
                <span class="k-mood-emoji">${m.emoji}</span>
                <span class="k-mood-text">${m.label}</span>
            </button>
        `;
    }).join(''));

    if (statusEl) {
        if (todayMood) {
            const m = MOODS.find(x => x.id === todayMood);
            statusEl.textContent = m ? `已记：${m.emoji} ${m.label}` : '';
            statusEl.classList.add('is-checked');
        } else {
            statusEl.textContent = '轻按标记状态';
            statusEl.classList.remove('is-checked');
        }
    }
}

export async function checkInMood(moodId) {
    const mood = MOODS.find(m => m.id === moodId);
    if (!mood) return;

    setStoredTodayMood(moodId);
    renderMoodPills();

    // 存入随手记 (Feeds)，作为今日微状态足迹
    const timeStr = getEast8Time().slice(11, 16);
    const content = `${mood.emoji} ${mood.label} · 今日心绪打卡 (${mood.desc}) · ${timeStr}`;

    const newFeed = {
        id: Date.now(),
        content,
        type: 'text',
        media_url: null,
        summary: null,
        tags: ['心绪', mood.label],
        created_at: getEast8Time().slice(0, 16)
    };
    stampLocalUpdate(newFeed);

    state.feedsDatabase.unshift(newFeed);
    saveFeedsDatabase();
    if (typeof actions.renderFeeds === 'function') actions.renderFeeds();
    if (typeof actions.renderHeatmap === 'function') actions.renderHeatmap();

    apiSyncFeed(newFeed, 'POST').catch(() => {});
    showToast(`${mood.emoji} 今日状态已记录为「${mood.label}」，思考轨迹已点亮！`, 'ok');
}

/** 2. 每日轻启发 (Daily Spark) */
function computeDailyIndex() {
    const now = new Date();
    const start = new Date(now.getFullYear(), 0, 0);
    const diff = now - start;
    const dayOfYear = Math.floor(diff / (1000 * 60 * 60 * 24));
    return dayOfYear % SPARK_PROMPTS.length;
}

export function renderDailySparkCard() {
    const questionEl = document.getElementById('daily-spark-question');
    if (!questionEl) return;
    questionEl.textContent = SPARK_PROMPTS[currentSparkIndex];
}

export function shuffleSpark() {
    currentSparkIndex = (currentSparkIndex + 1) % SPARK_PROMPTS.length;
    renderDailySparkCard();
    const questionEl = document.getElementById('daily-spark-question');
    if (questionEl) {
        questionEl.classList.remove('spark-pulse');
        void questionEl.offsetWidth; // 触发 reflow 重置动画
        questionEl.classList.add('spark-pulse');
    }
}

export async function saveSparkResponse() {
    const input = document.getElementById('daily-spark-input');
    if (!input) return;
    const answer = input.value.trim();
    if (!answer) {
        showToast('写下一两句随想再保存吧~', 'info');
        input.focus();
        return;
    }

    const question = SPARK_PROMPTS[currentSparkIndex];
    const content = `💡 【今日轻启发】\nQ: ${question}\nA: ${answer}`;

    const newFeed = {
        id: Date.now(),
        content,
        type: 'text',
        media_url: null,
        summary: null,
        tags: ['轻启发', '灵感'],
        created_at: getEast8Time().slice(0, 16)
    };
    stampLocalUpdate(newFeed);

    state.feedsDatabase.unshift(newFeed);
    saveFeedsDatabase();
    if (typeof actions.renderFeeds === 'function') actions.renderFeeds();
    if (typeof actions.renderHeatmap === 'function') actions.renderHeatmap();

    apiSyncFeed(newFeed, 'POST').catch(() => {});

    input.value = '';
    showToast('✨ 灵感已悄悄在花园生根并点亮轨迹！', 'ok');
}

/** 3. 时光偶遇卡片 (Serendipity Capsule) */
function parseTimestamp(val) {
    if (!val) return 0;
    if (typeof val === 'number') return val;
    const s = String(val).trim();
    const t = Date.parse(s.includes('T') || s.includes('-') ? s : s.replace(' ', 'T'));
    return Number.isFinite(t) ? t : 0;
}

export function getEligibleMemories() {
    const pool = [];
    const now = Date.now();
    const MIN_AGE_MS = 2 * 86400 * 1000; // 至少2天前的记忆

    (state.notesDatabase || []).forEach(n => {
        if (!n || n.is_deleted) return;
        const ts = parseTimestamp(n.date || n.created_at || n.updated_at);
        if (ts && (now - ts) > MIN_AGE_MS) {
            pool.push({
                id: n.id,
                type: 'note',
                typeName: '备忘录',
                title: n.title || '无题随笔',
                content: n.content || '',
                date: (n.date || n.created_at || '').slice(0, 10),
                ts
            });
        }
    });

    (state.database || []).forEach(w => {
        if (!w || w.is_deleted) return;
        const ts = parseTimestamp(w.date || w.created_at || w.updated_at);
        if (ts && (now - ts) > MIN_AGE_MS) {
            pool.push({
                id: w.id,
                type: 'weekly',
                typeName: '周记',
                title: w.title || '周刊长文',
                content: w.summary || w.content || '',
                date: (w.date || w.created_at || '').slice(0, 10),
                ts
            });
        }
    });

    (state.feedsDatabase || []).forEach(f => {
        if (!f || f.is_deleted) return;
        const ts = parseTimestamp(f.created_at || f.updated_at);
        if (ts && (now - ts) > MIN_AGE_MS) {
            pool.push({
                id: f.id,
                type: 'feed',
                typeName: '随手记',
                title: (f.content || '').slice(0, 24),
                content: f.content || '',
                date: (f.created_at || '').slice(0, 10),
                ts
            });
        }
    });

    return pool;
}

export function renderSerendipityCard() {
    const cardEl = document.getElementById('serendipity-capsule-card');
    if (!cardEl) return;

    const memories = getEligibleMemories();
    if (memories.length === 0) {
        setHtml(cardEl, `
            <div class="serendipity-empty-state">
                <span class="serendipity-empty-icon">🌱</span>
                <div class="serendipity-empty-text">
                    <strong>记忆幼苗生长中</strong> · 坚持记录几天后，Chillin 会在此处为你唤醒「那年今日」与时光偶遇。
                </div>
            </div>
        `);
        return;
    }

    const today = new Date();
    const todayMonth = today.getMonth();
    const todayDay = today.getDate();

    // 优先匹配那年今日（周年纪念）
    let target = memories.find(m => {
        const d = new Date(m.ts);
        return d.getMonth() === todayMonth && d.getDate() === todayDay && (today.getFullYear() - d.getFullYear() >= 1);
    });

    let badgeLabel = '时光偶遇';
    if (target) {
        const diffYears = today.getFullYear() - new Date(target.ts).getFullYear();
        badgeLabel = `${diffYears} 年前的今天`;
    } else {
        const index = (Math.abs(today.getFullYear() * 365 + today.getMonth() * 31 + todayDay + currentSerendipityShuffleOffset)) % memories.length;
        target = memories[index];
        const daysAgo = Math.max(1, Math.floor((Date.now() - target.ts) / (86400 * 1000)));
        badgeLabel = `${daysAgo} 天前 · ${target.typeName}`;
    }

    const snippet = target.content.replace(/<[^>]+>/g, '').slice(0, 120) + (target.content.length > 120 ? '…' : '');

    setHtml(cardEl, `
        <div class="k-memory-card-inner">
            <div class="k-memory-top">
                <div class="k-memory-badge">
                    <span class="k-memory-dot" aria-hidden="true"></span>
                    <span class="k-memory-label">${escapeHtml(badgeLabel)}</span>
                </div>
                <button type="button" class="k-memory-shuffle-btn" id="btn-shuffle-serendipity" title="偶遇下一条" aria-label="偶遇下一条">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
                    </svg>
                    <span>换一条</span>
                </button>
            </div>
            <div class="k-memory-body">
                ${target.title && target.title !== snippet ? `<div class="k-memory-title">${escapeHtml(target.title)}</div>` : ''}
                <div class="k-memory-quote">“${escapeHtml(snippet)}”</div>
            </div>
            <div class="k-memory-footer">
                <span class="k-memory-date">${escapeHtml(target.date)}</span>
                <button type="button" class="k-memory-reflect-trigger" id="btn-serendipity-reflect" data-target-id="${escapeHtml(String(target.id))}" data-target-type="${escapeHtml(target.type)}" data-target-title="${escapeHtml(target.title)}">
                    <span>留句回响</span>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
                </button>
            </div>
            <div class="k-memory-reflection-composer" id="serendipity-reflection-box" style="display: none;">
                <input type="text" id="serendipity-reflection-input" class="k-memory-input" placeholder="回看当时的自己，想写点什么…" autocomplete="off">
                <button type="button" class="k-spark-send-btn" id="btn-save-serendipity-reflection" title="发送回响" aria-label="发送回响">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
                        <line x1="12" y1="19" x2="12" y2="5"></line>
                        <polyline points="5 12 12 5 19 12"></polyline>
                    </svg>
                </button>
            </div>
        </div>
    `);

    document.getElementById('btn-shuffle-serendipity')?.addEventListener('click', () => {
        currentSerendipityShuffleOffset++;
        renderSerendipityCard();
    });

    const reflectBtn = document.getElementById('btn-serendipity-reflect');
    const reflectBox = document.getElementById('serendipity-reflection-box');
    const reflectInput = document.getElementById('serendipity-reflection-input');
    const saveReflectBtn = document.getElementById('btn-save-serendipity-reflection');

    if (reflectBtn && reflectBox && reflectInput && saveReflectBtn) {
        reflectBtn.addEventListener('click', () => {
            const isVisible = reflectBox.style.display !== 'none';
            reflectBox.style.display = isVisible ? 'none' : 'flex';
            if (!isVisible) reflectInput.focus();
        });

        saveReflectBtn.addEventListener('click', async () => {
            const text = reflectInput.value.trim();
            if (!text) return;
            const refTitle = reflectBtn.dataset.targetTitle || '历史记忆';
            const content = `⏳ 【回溯时光胶囊】 回看《${refTitle}》：\n${text}`;

            const newFeed = {
                id: Date.now(),
                content,
                type: 'text',
                media_url: null,
                summary: null,
                tags: ['时光胶囊', '回响'],
                created_at: getEast8Time().slice(0, 16)
            };
            stampLocalUpdate(newFeed);

            state.feedsDatabase.unshift(newFeed);
            saveFeedsDatabase();
            if (typeof actions.renderFeeds === 'function') actions.renderFeeds();
            if (typeof actions.renderHeatmap === 'function') actions.renderHeatmap();

            apiSyncFeed(newFeed, 'POST').catch(() => {});

            reflectBox.style.display = 'none';
            reflectInput.value = '';
            showToast('💌 跨越时光的回响已存入随手记！', 'ok');
        });
    }
}

/** 4. AI 本周精神切片 / 镜像报告 (Weekly Mind Mirror) */
let cachedWeeklyReviewReply = '';

export async function openWeeklyReviewModal() {
    const modal = document.getElementById('weekly-review-modal');
    if (!modal) return;
    modal.classList.add('show');

    // 计算过去 7 天的足迹指标
    const now = Date.now();
    const sevenDaysMs = 7 * 86400 * 1000;
    const activeDates = new Set();
    let totalItems = 0;
    const moodCounts = {};

    const checkItem = (item, dateStr) => {
        if (!item || item.is_deleted) return;
        const ts = parseTimestamp(dateStr);
        if (ts && (now - ts) <= sevenDaysMs) {
            totalItems++;
            const dayKey = (dateStr || '').slice(0, 10);
            if (dayKey) activeDates.add(dayKey);
            if (item.tags && Array.isArray(item.tags)) {
                item.tags.forEach(t => {
                    if (MOODS.some(m => m.label === t)) {
                        moodCounts[t] = (moodCounts[t] || 0) + 1;
                    }
                });
            }
        }
    };

    (state.feedsDatabase || []).forEach(f => checkItem(f, f.created_at));
    (state.notesDatabase || []).forEach(n => checkItem(n, n.date || n.created_at));
    (state.database || []).forEach(w => checkItem(w, w.date || w.created_at));

    const activeDaysEl = document.getElementById('weekly-active-days');
    const totalItemsEl = document.getElementById('weekly-total-items');
    const dominantMoodEl = document.getElementById('weekly-dominant-mood');
    const daterangeEl = document.getElementById('weekly-review-daterange');

    if (activeDaysEl) activeDaysEl.textContent = `${activeDates.size}/7`;
    if (totalItemsEl) totalItemsEl.textContent = String(totalItems);

    let topMood = '平静';
    let topCount = 0;
    for (const [m, c] of Object.entries(moodCounts)) {
        if (c > topCount) { topCount = c; topMood = m; }
    }
    const matchedMood = MOODS.find(x => x.label === topMood) || MOODS[1];
    if (dominantMoodEl) dominantMoodEl.textContent = `${matchedMood.emoji} ${matchedMood.label}`;

    // 格式化日期区间
    const startDate = new Date(now - 6 * 86400 * 1000);
    const endDate = new Date(now);
    const fmt = d => `${d.getMonth() + 1}.${d.getDate()}`;
    if (daterangeEl) daterangeEl.textContent = `${fmt(startDate)} - ${fmt(endDate)}`;

    // 渲染 AI 侧写报告
    const markdownEl = document.getElementById('weekly-review-markdown');
    if (!markdownEl) return;

    setHtml(markdownEl, `
        <div class="weekly-loading-wrap">
            <span class="weekly-spinner"></span>
            <span>正在梳理本周的心绪脉络…</span>
        </div>
    `);

    try {
        const res = await apiRequest('/api/ai/review', { method: 'POST', body: JSON.stringify({}) });
        cachedWeeklyReviewReply = (res && res.reply) ? res.reply : '本周记录较少，继续随手记下更多灵感吧~';
        setHtml(markdownEl, markdownToHtml(cachedWeeklyReviewReply));
    } catch (err) {
        cachedWeeklyReviewReply = '本周随想汇总：\n\n' + (totalItems > 0 ? `本周累计留下 ${totalItems} 条思绪碎片，心绪偏向 ${matchedMood.emoji} ${matchedMood.label}。每一份随手记录都是生活的见证。` : '本周暂未检测到较多记录，去随手记敲下一句吧~');
        setHtml(markdownEl, markdownToHtml(cachedWeeklyReviewReply));
    }
}

/** 初始化 Daily Spark 模块交互 */
export function initDailySpark() {
    actions.renderMoodPills = renderMoodPills;
    actions.renderSerendipityCard = renderSerendipityCard;

    currentSparkIndex = computeDailyIndex();
    renderMoodPills();
    renderDailySparkCard();
    renderSerendipityCard();

    // 1. 心绪胶囊点击
    const moodRow = document.getElementById('mood-pills-row');
    if (moodRow) {
        moodRow.addEventListener('click', (e) => {
            const btn = e.target.closest('.k-mood-chip, .mood-pill-btn');
            if (btn && btn.dataset.moodId) {
                checkInMood(btn.dataset.moodId);
            }
        });
    }

    // 2. 换一个轻启发
    document.getElementById('btn-shuffle-spark')?.addEventListener('click', shuffleSpark);

    // 3. 提交轻启发回答
    document.getElementById('btn-save-spark')?.addEventListener('click', saveSparkResponse);
    document.getElementById('daily-spark-input')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveSparkResponse();
        }
    });

    // 4. 打开本周回顾（拦截或接管现有按钮）
    const btnWeeklyReview = document.getElementById('btn-weekly-review');
    if (btnWeeklyReview) {
        btnWeeklyReview.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openWeeklyReviewModal();
        });
    }

    // 5. 复制本周切片
    document.getElementById('btn-copy-weekly-review')?.addEventListener('click', () => {
        if (!cachedWeeklyReviewReply) return;
        navigator.clipboard?.writeText(cachedWeeklyReviewReply).then(() => {
            showToast('📋 本周回顾已复制到剪贴板', 'ok');
        }).catch(() => {
            showToast('复制失败，请手动选取', 'warn');
        });
    });

    // 6. 存为本周周记草稿
    document.getElementById('btn-convert-to-weekly-draft')?.addEventListener('click', () => {
        const modal = document.getElementById('weekly-review-modal');
        if (modal) modal.classList.remove('show');

        // 导航至周记编辑器并预填
        window.location.hash = '#editor';
        setTimeout(() => {
            const titleInput = document.getElementById('edit-title');
            const summaryInput = document.getElementById('edit-summary');
            const contentTextarea = document.getElementById('edit-content');

            if (titleInput && !titleInput.value) {
                titleInput.value = `本周随想回顾 (${getEast8Time().slice(0, 10)})`;
            }
            if (summaryInput && !summaryInput.value) {
                summaryInput.value = `本周心绪脉络与碎片沉淀`;
            }
            if (contentTextarea) {
                contentTextarea.value = (contentTextarea.value ? contentTextarea.value + '\n\n' : '') + cachedWeeklyReviewReply;
            }
            showToast('📝 已将本周回顾填入周记草稿', 'ok');
        }, 300);
    });
}
