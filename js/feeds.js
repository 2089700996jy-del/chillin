import { escapeHtml } from './utils.js';
import { state } from './state.js';
import { actions } from './actions.js';
import {
    resolveAssetUrl,
    getLocalKey,
    apiRequest,
    apiSyncFeed,
    stampLocalUpdate,
    addDeletedId,
} from './api.js';

export function initFeeds() {
// 1. Render Feeds Stream (随手记流)
function extractUrlFromText(text) {
    if (!text) return null;
    const match = text.match(/(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+|(?:www\.)?[a-zA-Z0-9-]+\.(?:com|net|org|cn|fm|cc|co|tv|me|io|xyz)[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]*)/i);
    if (!match) return null;
    let raw = match[0].trim();
    let normalized = raw;
    if (!normalized.match(/^https?:\/\//i)) {
        normalized = 'https://' + normalized;
    }
    return { raw, normalized };
}

function renderFeeds() {
    const container = document.getElementById('feeds-stream-container');
    if (!container) return;

    const displayFeeds = state.feedsDatabase;

    if (!displayFeeds || displayFeeds.length === 0) {
        container.innerHTML = `
            <div class="list-empty">
                <div class="list-empty-icon">⚡️</div>
                <div class="list-empty-title">随手记流空空如也</div>
                <div class="list-empty-sub">在上方输入框倾倒你的第一个思考吧</div>
            </div>
        `;
        return;
    }

    const pendingEnrichFeeds = [];

    container.innerHTML = displayFeeds.map(feed => {
        const tags = feed.tags || [];
        const tagHtml = tags.map(t => `<span class="feed-tag-pill">${escapeHtml(t)}</span>`).join('');

        
        // Format link preview if summary or link exists
        let linkHtml = '';
        const extracted = extractUrlFromText(feed.content);
        if (extracted || feed.summary) {
            const targetUrl = extracted ? extracted.normalized : '#';
            let meta = null;
            if (feed.summary) {
                try {
                    if (feed.summary.trim().startsWith('{')) {
                        meta = JSON.parse(feed.summary);
                    }
                } catch {}
            }

            let title = meta?.title || (feed.summary && !feed.summary.startsWith('{') ? feed.summary : '');
            let description = meta?.description || '';
            let coverUrl = meta?.cover || feed.media_url || '';
            let platformName = meta?.platform || '';
            let platformIcon = meta?.icon || '';

            if (!title || /^(403|404|500|Forbidden|Access Denied|Error)/i.test(title.trim())) {
                try {
                    title = new URL(targetUrl).hostname;
                } catch {
                    title = targetUrl;
                }
            }

            if (!platformName) {
                try {
                    const u = new URL(targetUrl);
                    const host = u.hostname;
                    if (host.includes('xiaoyuzhoufm.com')) { platformName = '小宇宙'; platformIcon = '🪐'; }
                    else if (host.includes('xiaohongshu.com') || host.includes('xhslink.com')) { platformName = '小红书'; platformIcon = '📕'; }
                    else if (host.includes('bilibili.com') || host.includes('b23.tv')) { platformName = 'Bilibili'; platformIcon = '📺'; }
                    else if (host.includes('weixin.qq.com')) { platformName = '微信文章'; platformIcon = '💬'; }
                    else if (host.includes('zhihu.com')) { platformName = '知乎'; platformIcon = '💡'; }
                    else if (host.includes('music.163.com')) { platformName = '网易云音乐'; platformIcon = '🎵'; }
                    else if (host.includes('weibo.com') || host.includes('weibo.cn')) { platformName = '微博'; platformIcon = '🔴'; }
                    else { platformName = host; platformIcon = '🌐'; }
                } catch {
                    platformName = '网络链接';
                    platformIcon = '🌐';
                }
            }

            // Auto enrich unparsed links or plain hostnames (e.g. historical posts)
            if (extracted && (!meta || !meta.cover || title === 'www.xiaoyuzhoufm.com' || title === 'xiaoyuzhoufm.com')) {
                if (!feed._enriching) {
                    pendingEnrichFeeds.push({ feed, url: extracted.normalized });
                }
            }

            linkHtml = `
                <a href="${escapeHtml(targetUrl)}" target="_blank" class="rich-link-card" onclick="event.stopPropagation()">
                    <div class="rich-link-main">
                        <div class="rich-link-info">
                            <div class="rich-link-title">${escapeHtml(title)}</div>
                            ${description ? `<div class="rich-link-desc">${escapeHtml(description)}</div>` : ''}
                        </div>
                        ${coverUrl ? `<img src="${escapeHtml(resolveAssetUrl(coverUrl))}" class="rich-link-cover" referrerpolicy="no-referrer" alt="" onerror="this.onerror=null; this.style.display='none'">` : ''}
                    </div>
                    <div class="rich-link-footer">
                        <span class="rich-platform-pill">
                            <span class="platform-icon">${escapeHtml(platformIcon)}</span>
                            <span class="platform-name">${escapeHtml(platformName)}</span>
                            <span class="platform-divider">|</span>
                            <span class="platform-action">链接速览</span>
                            <svg class="platform-arrow" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
                        </span>
                    </div>
                </a>
            `;
        }

        // Image preview
        let mediaHtml = '';
        if (feed.media_url && !linkHtml) {
            mediaHtml = `<img src="${escapeHtml(resolveAssetUrl(feed.media_url))}" class="feed-media-preview" alt="" onclick="previewImage(this.src)">`;
        }

        // Remove raw URL text if a rich link card is displayed
        let contentText = feed.content || '';
        if (extracted && linkHtml) {
            contentText = contentText.replace(extracted.raw, '').replace(extracted.normalized, '').trim();
        }

        let textHtml = '';
        if (contentText) {
            const formattedContent = escapeHtml(contentText).replace(/(https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g, '<a href="$1" target="_blank" style="color:#007AFF;">$1</a>');
            textHtml = `<div class="feed-content-text">${formattedContent}</div>`;
        }

        return `
            <div class="feed-item-card" data-feed-id="${feed.id}">
                <div class="feed-header">
                    <div class="feed-tags">${tagHtml}</div>
                    <div style="display:flex;align-items:center;gap:10px;">
                        <span class="feed-date">${escapeHtml(feed.created_at || '')}</span>
                        <button class="btn-text text-danger" onclick="deleteFeed(${feed.id})" style="font-size:12px;">删除</button>
                    </div>
                </div>
                ${textHtml}
                ${mediaHtml}
                ${linkHtml}
            </div>
        `;
    }).join('');

    // Async auto enrichment for historical unparsed links
    if (pendingEnrichFeeds.length > 0) {
        pendingEnrichFeeds.forEach(({ feed, url }) => {
            feed._enriching = true;
            apiRequest('/api/link/parse', {
                method: 'POST',
                body: JSON.stringify({ url })
            }).then(parseRes => {
                if (parseRes && parseRes.title) {
                    feed.summary = JSON.stringify(parseRes);
                    if (parseRes.cover) feed.media_url = parseRes.cover;
                    feed.updated_at = new Date().toISOString();
                    feed._dirty = true;
                    saveFeedsDatabase();
                    renderFeeds();
                    apiSyncFeed(feed, 'PUT');
                }
            }).catch(() => {});
        });
    }
}

// 2. Add Feed Handler
const btnSendFeed = document.getElementById('btn-send-feed');
const feedInputText = document.getElementById('feed-input-text');
const feedMediaUrlInput = document.getElementById('feed-media-url');
const btnFeedAddMedia = document.getElementById('btn-feed-add-media');
const feedMediaInputWrapper = document.getElementById('feed-media-input-wrapper');
const btnFeedRemoveMedia = document.getElementById('btn-feed-remove-media');

if (btnFeedAddMedia && feedMediaInputWrapper) {
    btnFeedAddMedia.addEventListener('click', () => {
        const uploader = document.getElementById('global-image-uploader');
        if (uploader) {
            // Manually trigger upload flow
            currentUploadTargetInput = feedMediaUrlInput;
            uploader.click();
        }
    });
}

if (btnFeedRemoveMedia) {
    btnFeedRemoveMedia.addEventListener('click', () => {
        if (feedMediaUrlInput) {
            feedMediaUrlInput.value = '';
            feedMediaUrlInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
    });
}

const updateFeedMediaPreview = () => {
    const previewWrap = document.getElementById('feed-media-preview');
    const previewImg = document.getElementById('feed-media-preview-img');
    if (!previewWrap || !previewImg || !feedMediaUrlInput) return;
    const url = feedMediaUrlInput.value.trim();
    if (url) {
        previewImg.src = resolveAssetUrl(url);
        previewWrap.style.display = 'inline-block';
        if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'block';
    } else {
        previewImg.removeAttribute('src');
        previewWrap.style.display = 'none';
        if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'none';
    }
};
if (feedMediaUrlInput) {
    feedMediaUrlInput.addEventListener('input', updateFeedMediaPreview);
}

// Chip Tag click listener
document.querySelectorAll('.feed-tools .btn-chip[data-tag]').forEach(chip => {
    chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        if (feedInputText) {
            if (!feedInputText.value.includes(tag)) {
                feedInputText.value += ` ${tag} `;
            }
        }
    });
});

async function sendFeed() {
    if (!feedInputText) return;
    const content = feedInputText.value.trim();
    const mediaUrl = feedMediaUrlInput ? feedMediaUrlInput.value.trim() : '';
    if (!content && !mediaUrl) return;

    btnSendFeed.disabled = true;
    btnSendFeed.innerText = '解析中...';

    let summary = null;
    let type = mediaUrl ? 'image' : 'text';
    let parsedCover = '';

    // Check if content contains a URL (supports https:// and www. domain URLs)
    const extracted = extractUrlFromText(content);
    if (extracted) {
        type = 'link';
        try {
            const parseRes = await apiRequest('/api/link/parse', {
                method: 'POST',
                body: JSON.stringify({ url: extracted.normalized })
            });
            if (parseRes) {
                summary = JSON.stringify(parseRes);
                if (parseRes.cover) parsedCover = parseRes.cover;
            }
        } catch {}
    } else if (mediaUrl) {
        type = 'image';
    }

    const newFeed = {
        id: Date.now(),
        content: content || '分享了图片/链接',
        type,
        media_url: mediaUrl || parsedCover || null,
        summary,
        tags: [],
        created_at: new Date().toISOString().replace('T', ' ').slice(0, 16)
    };
    stampLocalUpdate(newFeed);

    state.feedsDatabase.unshift(newFeed);
    localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(state.feedsDatabase));
    renderFeeds();
    actions.renderHeatmap();

    feedInputText.value = '';
    if (feedMediaUrlInput) feedMediaUrlInput.value = '';
    if (feedMediaInputWrapper) feedMediaInputWrapper.style.display = 'none';
    const feedPreview = document.getElementById('feed-media-preview');
    const feedPreviewImg = document.getElementById('feed-media-preview-img');
    if (feedPreview) feedPreview.style.display = 'none';
    if (feedPreviewImg) feedPreviewImg.removeAttribute('src');

    btnSendFeed.disabled = false;
    btnSendFeed.innerText = '发送 🚀';

    // Sync with Cloudflare Worker API
    try {
        const apiRes = await apiRequest('/api/feeds', {
            method: 'POST',
            body: JSON.stringify(newFeed)
        });
        if (apiRes && apiRes.id) {
            const idx = state.feedsDatabase.findIndex(f => f.id === newFeed.id);
            if (idx !== -1) {
                state.feedsDatabase[idx] = apiRes;
            } else {
                state.feedsDatabase.unshift(apiRes);
            }
            saveFeedsDatabase();
            renderFeeds();
        }
    } catch (err) {
        console.warn('Silent feed sync failed:', err);
    }
}

if (btnSendFeed) {
    btnSendFeed.addEventListener('click', sendFeed);
}
if (feedInputText) {
    feedInputText.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            sendFeed();
        }
    });
}

window.deleteFeed = function(id) {
    if (!confirm('确定要删除这条随手记吗？')) return;
    addDeletedId(id);
    state.feedsDatabase = state.feedsDatabase.filter(f => String(f.id) !== String(id));
    localStorage.setItem(getLocalKey('gardenFeeds'), JSON.stringify(state.feedsDatabase));
    renderFeeds();
    actions.renderHeatmap();
    apiRequest(`/api/feeds/${id}`, { method: 'DELETE' }).catch(() => {});
};

window.previewImage = function(src) {
    if (!src) return;
    const img = document.getElementById('image-preview-img');
    const modal = document.getElementById('image-preview-modal');
    if (img && modal) {
        img.src = src;
        modal.classList.add('show');
    }
};

// 3. Render Heatmap (思考与记忆轨迹热力图)
function renderHeatmap() {
    const grid = document.getElementById('heatmap-grid');
    if (!grid) return;

    // Build date counts map for last 365 days
    const dateMap = {};
    const toLocalIsoDate = (d) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
    };
    const toIsoDateKey = (value) => {
        if (!value) return '';
        const s = String(value).trim();
        const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
        if (iso) return iso[1];
        const cn = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日/);
        if (cn) {
            return `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}`;
        }
        const t = Date.parse(s.includes('T') || s.includes('-') ? s : s.replace(' ', 'T'));
        if (Number.isFinite(t)) return toLocalIsoDate(new Date(t));
        return '';
    };
    const addCount = (dateStr) => {
        const key = toIsoDateKey(dateStr);
        if (!key) return;
        dateMap[key] = (dateMap[key] || 0) + 1;
    };

    (state.database || []).forEach(w => addCount(w.created_at || w.updated_at || w.date));
    (state.notesDatabase || []).forEach(n => addCount(n.created_at || n.updated_at || n.date));
    (state.bookmarksDatabase || []).forEach(b => addCount(b.created_at || b.updated_at));
    (state.feedsDatabase || []).forEach(f => addCount(f.created_at || f.updated_at));

    // Generate columns (52 weeks x 7 days)
    const today = new Date();
    let colsHtml = '';

    for (let w = 51; w >= 0; w--) {
        let cellsHtml = '';
        for (let d = 0; d < 7; d++) {
            const dayOffset = (w * 7) + (6 - d);
            const cellDate = new Date(today);
            cellDate.setDate(today.getDate() - dayOffset);
            const dateKey = toLocalIsoDate(cellDate);
            const count = dateMap[dateKey] || 0;

            let levelClass = '';
            if (count >= 5) levelClass = 'level-4';
            else if (count >= 3) levelClass = 'level-3';
            else if (count >= 2) levelClass = 'level-2';
            else if (count >= 1) levelClass = 'level-1';

            cellsHtml += `<div class="heatmap-cell ${levelClass}" title="${dateKey}: ${count} 次记录"></div>`;
        }
        colsHtml += `<div class="heatmap-col">${cellsHtml}</div>`;
    }

    grid.innerHTML = colsHtml;
    grid.scrollLeft = grid.scrollWidth;
}



    actions.renderFeeds = renderFeeds;
    actions.renderHeatmap = renderHeatmap;

    return { renderFeeds, renderHeatmap, sendFeed };
}
