/**
 * 正在生长的线索（Recurring Insight Shelf）
 *
 * 只展示 Worker 已经发现、跨月份反复出现的主题。每条线索都带原文短句与日期，
 * 用户可以直接把它写成带下一步的笔记，或让微信 Bot 明晚提醒自己继续。
 * 发现逻辑在 workers/src/insights.js；这里只负责呈现与行动，不调用模型。
 */
import { state } from './state.js';
import { actions } from './actions.js';
import { apiRequest, getLocalKey } from './api.js';
import { escapeHtml, showToast } from './utils.js';
import { setHtml } from './trusted-types.js';

const DISMISS_KEY = 'gardenInsightDismissed';
const DISMISS_DAYS = 30;
let currentThreads = [];
let loading = false;
let lastLoadedAt = 0;

function readDismissed() {
    try {
        const raw = JSON.parse(localStorage.getItem(getLocalKey(DISMISS_KEY)) || '{}');
        const now = Date.now();
        const out = {};
        for (const [id, ts] of Object.entries(raw || {})) {
            if (now - Number(ts) < DISMISS_DAYS * 86400000) out[id] = Number(ts);
        }
        return out;
    } catch (_) { return {}; }
}

function dismissThread(id) {
    const map = readDismissed();
    map[id] = Date.now();
    try { localStorage.setItem(getLocalKey(DISMISS_KEY), JSON.stringify(map)); } catch (_) {}
    currentThreads = currentThreads.filter(thread => thread.id !== id);
    renderThreads();
}

function shortDate(ymd) {
    const m = String(ymd || '').match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m ? Number(m[1]) + '月' + Number(m[2]) + '日' : String(ymd || '');
}

function nextEvening20() {
    const shifted = new Date(Date.now() + 8 * 3600000);
    const y = shifted.getUTCFullYear();
    const m = shifted.getUTCMonth();
    const d = shifted.getUTCDate();
    return Date.UTC(y, m, d + 1, 20, 0, 0) - 8 * 3600000;
}

function threadCard(thread) {
    const evidence = (thread.evidence || []).slice(0, 3).map(item => (
        '<li class="insight-evidence-item">'
        + '<span class="insight-evidence-date">' + escapeHtml(shortDate(item.date)) + '</span>'
        + '<span class="insight-evidence-text">' + escapeHtml(item.snippet) + '</span>'
        + '</li>'
    )).join('');
    const badge = thread.unfinished ? '还没收尾' : '反复出现';
    return '<article class="insight-thread-card" role="listitem" data-thread-id="' + escapeHtml(thread.id) + '">'
        + '<div class="insight-thread-meta"><span class="insight-thread-badge">' + escapeHtml(badge) + '</span>'
        + '<span>' + escapeHtml(thread.months + ' 个月 · ' + thread.count + ' 次') + '</span></div>'
        + '<h3 class="insight-thread-title">' + escapeHtml(thread.topic) + '</h3>'
        + '<p class="insight-thread-summary">' + escapeHtml(thread.summary) + '</p>'
        + '<ul class="insight-evidence-list">' + evidence + '</ul>'
        + '<div class="insight-thread-actions">'
        + '<button type="button" class="btn-primary insight-action-plan" data-insight-action="plan">写成下一步</button>'
        + '<button type="button" class="btn-secondary insight-action-remind" data-insight-action="remind">明晚提醒</button>'
        + '<button type="button" class="btn-text insight-action-dismiss" data-insight-action="dismiss">先放下</button>'
        + '</div></article>';
}

function renderThreads() {
    const section = document.getElementById('insight-threads-section');
    const list = document.getElementById('insight-threads-list');
    const countEl = document.getElementById('insight-threads-count');
    if (!section || !list) return;
    const dismissed = readDismissed();
    const visible = currentThreads.filter(thread => thread && !dismissed[thread.id]);
    if (!visible.length) {
        section.hidden = true;
        setHtml(list, '');
        return;
    }
    section.hidden = false;
    if (countEl) countEl.textContent = visible.length + ' 条';
    setHtml(list, visible.map(threadCard).join(''));
}

/** 读取线索；失败只隐藏，不打断首页。 */
export async function refreshInsights(force = false) {
    const section = document.getElementById('insight-threads-section');
    if (!section) return;
    if (!(state.authToken || state.cookieSession)) { section.hidden = true; return; }
    if (loading) return;
    if (!force && Date.now() - lastLoadedAt < 30000 && currentThreads.length) { renderThreads(); return; }
    loading = true;
    try {
        const data = await apiRequest('/api/insights/threads?days=180&limit=6');
        currentThreads = Array.isArray(data && data.threads) ? data.threads : [];
        lastLoadedAt = Date.now();
        renderThreads();
    } catch (err) {
        console.warn('[insights] load failed', err && err.message);
        section.hidden = true;
    } finally {
        loading = false;
    }
}

function planContent(thread) {
    const evidence = (thread.evidence || []).map(item => (
        '- ' + item.date + '（' + item.label + '）：' + item.snippet
    )).join('\n');
    return [
        '## 这条线索',
        '从 ' + thread.firstAt + ' 到 ' + thread.lastAt + '，你在 ' + thread.months + ' 个月里提到过 ' + thread.count + ' 次「' + thread.topic + '」。',
        '',
        '### 当时的记录',
        evidence,
        '',
        '### 下一步',
        '- [ ] ',
        ''
    ].join('\n');
}

async function openPlan(thread) {
    if (typeof actions.openNoteEditor !== 'function') {
        showToast('笔记编辑器还没准备好，稍后再试', 'warn');
        return;
    }
    actions.openNoteEditor(null, {
        prefill: { title: '继续：' + thread.topic, content: planContent(thread) }
    });
}

async function remindMe(thread, button) {
    button.disabled = true;
    try {
        const fireAt = nextEvening20();
        await apiRequest('/api/reminders', {
            method: 'POST',
            body: JSON.stringify({ text: '继续想想：' + thread.topic, fire_at_ms: fireAt })
        });
        button.textContent = '已设明晚提醒';
        showToast('已设明晚 20:00 的微信提醒：继续想想「' + thread.topic + '」', 'success');
    } catch (err) {
        button.disabled = false;
        showToast(err && err.message ? err.message : '提醒设置失败', 'error');
    }
}

export function initInsights() {
    const section = document.getElementById('insight-threads-section');
    if (!section) return;
    section.addEventListener('click', (event) => {
        const button = event.target.closest('[data-insight-action]');
        if (!button) return;
        const card = button.closest('[data-thread-id]');
        const thread = currentThreads.find(item => item.id === (card && card.dataset.threadId));
        if (!thread) return;
        const action = button.dataset.insightAction;
        if (action === 'plan') openPlan(thread);
        else if (action === 'remind') remindMe(thread, button);
        else if (action === 'dismiss') dismissThread(thread.id);
    });
    window.addEventListener('chillin:auth-ready', () => refreshInsights(true));
    refreshInsights();
}
