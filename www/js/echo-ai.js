import { escapeHtml, markdownToHtml } from './utils.js';
import { state } from './state.js';
import { ui } from './ui.js';
import { actions } from './actions.js';
import {
    getLocalKey,
    apiRequest,
    fetchWithFallback,
    setSyncStatus,
    logout,
} from './api.js';

export function initEchoAi() {
// 4. Render Echo Cards & Generator
function renderEchoCards() {
    const container = document.getElementById('echo-cards-container');
    if (!container) return;

    if (!state.echoCardsDatabase || state.echoCardsDatabase.length === 0) {
        container.innerHTML = '';
        return;
    }

    container.innerHTML = state.echoCardsDatabase.map(card => {
        let feedLinksHtml = '';
        try {
            // Removed feed links logic
        } catch (e) {}

        return `
            <div class="echo-card" id="echo-card-${card.id}">
                <button class="echo-card-delete" onclick="deleteEchoCard(${card.id})" title="删除卡片">×</button>
                <div class="echo-card-badge">✨ AI 记忆回响 · ${escapeHtml(card.topic || '周记串联')}</div>
                <div class="echo-card-title">${escapeHtml(card.title)}</div>
                <div class="echo-card-summary">${escapeHtml(card.summary)}</div>
                ${feedLinksHtml}
            </div>
        `;
    }).join('');
}

window.jumpToFeed = function(feedId) {
    actions.jumpToElement?.('feeds', `[data-feed-id="${CSS.escape(String(feedId))}"]`);
};

window.deleteEchoCard = function(id) {
    if (!confirm('确定要删除这张 AI 回响卡片吗？')) return;
    state.echoCardsDatabase = state.echoCardsDatabase.filter(c => String(c.id) !== String(id));
    localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(state.echoCardsDatabase));
    renderEchoCards();
    apiRequest('/api/echo/cards/' + id, { method: 'DELETE' }).catch(() => {});
};

async function fetchAiChatStream(body, isRetry = false) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.authToken) headers['Authorization'] = `Bearer ${state.authToken}`;

    const response = await fetchWithFallback('/api/ai/chat', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });

    if (response.status === 401) {
        if (!isRetry) {
            await new Promise((r) => setTimeout(r, 300));
            return fetchAiChatStream(body, true);
        }
        logout({ reason: 'expired' });
        return null;
    }
    return response;
}

function getLocalAiReply(question) {
    const allMemory = [];
    (state.feedsDatabase || []).forEach(f => allMemory.push(`[随手记 ${f.created_at || ''}] ${f.content}`));
    (state.notesDatabase || []).forEach(n => allMemory.push(`[备忘录 ${n.date || ''}] ${n.title}: ${n.content || ''}`));
    (state.database || []).forEach(w => allMemory.push(`[周记 ${w.date || ''}] ${w.title}: ${w.summary || ''}`));
    (state.bookmarksDatabase || []).forEach(b => allMemory.push(`[书签] ${b.title}: ${b.desc || b.description || ''} (${b.url || ''})`));

    if (allMemory.length === 0) {
        return `我在您的记忆花园里还没有找到记录。试试先在“随手记”里记录一些想法吧！`;
    }

    const keywords = question.replace(/[？?！!，,。.\s]/g, '').split('').filter(c => c);
    const matches = allMemory.filter(item => {
        return keywords.some(kw => item.toLowerCase().includes(kw.toLowerCase()));
    });

    if (matches.length > 0) {
        return `针对您的提问 “${question}”，我在您的记忆库中检索到了以下相关切片：\n\n` +
            matches.slice(0, 5).map(m => `• ${m}`).join('\n') +
            `\n\n💡 提示：持续添加随手记，我会帮您记住更多细节！`;
    } else {
        return `针对您的提问 “${question}”，未找到相关精确词汇，为您找到最近的记忆切片：\n\n` +
            allMemory.slice(0, 4).map(m => `• ${m}`).join('\n');
    }
}

const btnTriggerEchoCard = document.getElementById('btn-trigger-echo-card');
if (btnTriggerEchoCard) {
    btnTriggerEchoCard.addEventListener('click', async () => {
        btnTriggerEchoCard.disabled = true;
        btnTriggerEchoCard.innerText = 'AI 生成中...';
        try {
            const newCard = await apiRequest('/api/echo/generate', { method: 'POST', timeout: 60000 });
            if (newCard && newCard.title) {
                state.echoCardsDatabase.unshift(newCard);
                localStorage.setItem(getLocalKey('gardenEchoCards'), JSON.stringify(state.echoCardsDatabase));
                renderEchoCards();
                actions.switchView('feeds');
                setSyncStatus('回响卡片已生成', 'ok', 2500);
                return;
            }
            throw new Error('生成结果为空');
        } catch (err) {
            const msg = (err && err.message) ? err.message : '生成失败';
            if (/暂无足够|随手记/.test(msg)) {
                alert(msg);
            } else {
                alert('AI 回响生成失败：' + msg + '\n请确认已登录且 LLM 密钥可用后重试。');
            }
        } finally {
            btnTriggerEchoCard.disabled = false;
            btnTriggerEchoCard.innerText = '✨ 生成 AI 回响卡片';
        }
    });
}

// 5. AI Memory Chat Modal Logic (🤖 AI 记忆回响助手)
const aiChatModal = document.getElementById('ai-chat-modal');
const btnOpenAiChat = document.getElementById('btn-open-ai-chat');
const btnCloseAiChat = document.getElementById('btn-close-ai-chat');
const btnSendAiChat = document.getElementById('btn-send-ai-chat');
const aiChatInput = document.getElementById('ai-chat-input');
const aiChatBody = document.getElementById('ai-chat-body');

if (btnOpenAiChat && aiChatModal) {
    btnOpenAiChat.addEventListener('click', () => {
        aiChatModal.classList.add('show');
        if (!ui.aiModalInHistory) {
            history.pushState({ view: 'ai' }, '', '#/ai');
            ui.aiModalInHistory = true;
        }
        if (aiChatInput) aiChatInput.focus();
    });
}
if (btnCloseAiChat && aiChatModal) {
    btnCloseAiChat.addEventListener('click', () => {
        if (ui.aiModalInHistory && actions.parseHashRoute().view === 'ai') {
            history.back();
        } else {
            aiChatModal.classList.remove('show');
            ui.aiModalInHistory = false;
        }
    });
}

window.closeAiChatModal = function() {
    if (ui.aiModalInHistory && actions.parseHashRoute().view === 'ai') {
        history.back();
        return;
    }
    if (aiChatModal) aiChatModal.classList.remove('show');
    ui.aiModalInHistory = false;
};

window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (aiChatModal && aiChatModal.classList.contains('show')) {
        window.closeAiChatModal();
        return;
    }
    const imgModal = document.getElementById('image-preview-modal');
    if (imgModal && imgModal.classList.contains('show')) {
        imgModal.classList.remove('show');
    }
});



async function sendAiChatMessage() {
    if (!aiChatInput || !aiChatBody) return;
    const question = aiChatInput.value.trim();
    if (!question) return;

    // Append User Message
    const userMsgDiv = document.createElement('div');
    userMsgDiv.className = 'ai-msg ai-msg-user';
    userMsgDiv.innerHTML = `<div class="ai-msg-bubble">${escapeHtml(question)}</div>`;
    aiChatBody.appendChild(userMsgDiv);

    aiChatInput.value = '';
    aiChatBody.scrollTop = aiChatBody.scrollHeight;

    // Append Bot Typing Indicator
    const botMsgDiv = document.createElement('div');
    botMsgDiv.className = 'ai-msg ai-msg-bot';
    botMsgDiv.innerHTML = `<div class="ai-msg-bubble">🤖 思考中...</div>`;
    aiChatBody.appendChild(botMsgDiv);
    aiChatBody.scrollTop = aiChatBody.scrollHeight;

    const bubbleEl = botMsgDiv.querySelector('.ai-msg-bubble');

    try {
        // 多轮对话：保存 user 输入
        const recentHistory = [...state.aiChatHistory];
        state.aiChatHistory.push({ role: 'user', content: question });

        const response = await fetchAiChatStream({ question, stream: true, history: recentHistory });
        if (!response) {
            state.aiChatHistory.pop();
            bubbleEl.innerHTML = '🤖 登录已过期，请重新登录后再试';
            return;
        }

        if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';
            let isFirstChunk = true;
            let sourcesMounted = false;

            const mountSources = (sources) => {
                if (sourcesMounted || !Array.isArray(sources) || sources.length === 0) return;
                sourcesMounted = true;
                const box = document.createElement('div');
                box.className = 'ai-rag-sources';
                box.style.cssText = 'margin:0 0 8px;padding:8px 10px;border-radius:10px;background:rgba(120,120,128,0.12);font-size:12px;color:rgba(60,60,67,0.75);line-height:1.45;';
                const title = document.createElement('div');
                title.style.cssText = 'font-weight:600;margin-bottom:4px;color:rgba(28,28,30,0.85)';
                title.textContent = `已检索 ${sources.length} 条相关记忆`;
                box.appendChild(title);
                sources.slice(0, 6).forEach((s) => {
                    const row = document.createElement('div');
                    const label = [s.type, s.date, s.title].filter(Boolean).join(' · ');
                    row.textContent = `· ${label}${s.snippet ? ' — ' + s.snippet : ''}`;
                    box.appendChild(row);
                });
                botMsgDiv.insertBefore(box, bubbleEl);
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;
                    if (trimmed === 'data: [DONE]') break;
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const payload = JSON.parse(trimmed.slice(6));
                            if (payload.error) {
                                bubbleEl.innerHTML = '🤖 ' + escapeHtml(payload.error);
                                break;
                            }
                            if (payload.type === 'rag' && payload.sources) {
                                mountSources(payload.sources);
                                if (!payload.sources.length) {
                                    bubbleEl.innerHTML = '🤖 未检索到直接相关记忆，正在据此回答…';
                                }
                                continue;
                            }
                            if (payload.delta) {
                                if (isFirstChunk) {
                                    fullText = '';
                                    isFirstChunk = false;
                                }
                                fullText += payload.delta;
                                bubbleEl.innerHTML = markdownToHtml(fullText);
                                aiChatBody.scrollTop = aiChatBody.scrollHeight;
                            }
                        } catch (e) {}
                    }
                }
            }
            if (fullText) {
                state.aiChatHistory.push({ role: 'assistant', content: fullText });
                return;
            }
        } else if (response.ok) {
            const res = await response.json();
            if (res && res.reply) {
                if (Array.isArray(res.sources) && res.sources.length) {
                    const box = document.createElement('div');
                    box.className = 'ai-rag-sources';
                    box.style.cssText = 'margin:0 0 8px;padding:8px 10px;border-radius:10px;background:rgba(120,120,128,0.12);font-size:12px;color:rgba(60,60,67,0.75);line-height:1.45;';
                    box.innerHTML = `<div style="font-weight:600;margin-bottom:4px;color:rgba(28,28,30,0.85)">已检索 ${res.sources.length} 条相关记忆</div>` +
                        res.sources.slice(0, 6).map(s => {
                            const label = [s.type, s.date, s.title].filter(Boolean).join(' · ');
                            return `<div>· ${escapeHtml(label)}${s.snippet ? ' — ' + escapeHtml(s.snippet) : ''}</div>`;
                        }).join('');
                    botMsgDiv.insertBefore(box, bubbleEl);
                }
                bubbleEl.innerHTML = markdownToHtml(res.reply);
                state.aiChatHistory.push({ role: 'assistant', content: res.reply });
                aiChatBody.scrollTop = aiChatBody.scrollHeight;
                return;
            }
        }
    } catch (err) {
        console.error('AI chat stream fetch error:', err);
    }

    // 本地规则检索兜底（DeepSeek 密钥已收敛到后端 Worker，前端不再直连）
    const localReply = getLocalAiReply(question);
    bubbleEl.innerHTML = markdownToHtml(localReply);
    state.aiChatHistory.push({ role: 'assistant', content: localReply });
    aiChatBody.scrollTop = aiChatBody.scrollHeight;
}

// 📅 AI 本周回顾：打开对话并展示回顾结果
const btnWeeklyReview = document.getElementById('btn-weekly-review');
if (btnWeeklyReview) {
    btnWeeklyReview.addEventListener('click', async () => {
        if (!aiChatModal || !aiChatBody) return;
        aiChatModal.classList.add('show');
        const botMsgDiv = document.createElement('div');
        botMsgDiv.className = 'ai-msg ai-msg-bot';
        botMsgDiv.innerHTML = `<div class="ai-msg-bubble">🤖 正在为你生成本周回顾...</div>`;
        aiChatBody.appendChild(botMsgDiv);
        aiChatBody.scrollTop = aiChatBody.scrollHeight;
        try {
            const res = await apiRequest('/api/ai/review', { method: 'POST', body: JSON.stringify({}) });
            botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = (res && res.reply)
                ? markdownToHtml(res.reply)
                : '本周回顾生成失败，请稍后再试。';
        } catch (err) {
            botMsgDiv.querySelector('.ai-msg-bubble').innerHTML = '本周回顾生成失败：' + escapeHtml(err.message);
        }
        aiChatBody.scrollTop = aiChatBody.scrollHeight;
    });
}

if (btnSendAiChat) btnSendAiChat.addEventListener('click', sendAiChatMessage);
if (aiChatInput) {
    aiChatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendAiChatMessage();
        }
    });
}



    actions.renderEchoCards = renderEchoCards;

    return { renderEchoCards };
}
