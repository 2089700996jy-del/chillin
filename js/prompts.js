/**
 * AI Prompt Library (提示词库) Module
 * Handles dual-dimension filtering (Project & Scene), search, one-click copy,
 * variable replacement, AI chat pipeline, and editor CRUD.
 */
import { generateUniqueId, escapeHtml, showToast } from './utils.js';
import { state, DEFAULT_PROMPTS } from './state.js';
import { actions } from './actions.js';
import {
    savePromptsDatabase,
    apiSyncPrompt,
    stampLocalUpdate,
    addDeletedId,
} from './api.js';

export function initPrompts() {
    let currentProjectFilter = 'all';
    let currentSceneFilter = 'all';
    let currentSearchKeyword = '';

    // DOM Elements
    const promptsListContainer = document.getElementById('prompts-list-container');
    const promptsSearchInput = document.getElementById('prompts-search-input');
    const promptsSearchClear = document.getElementById('prompts-search-clear');
    const projectChipsContainer = document.getElementById('prompts-project-chips');
    const sceneChipsContainer = document.getElementById('prompts-scene-chips');
    const btnCreatePrompt = document.getElementById('btn-create-prompt');
    const subviewResources = document.getElementById('subview-resources');
    const subviewPrompts = document.getElementById('subview-prompts');
    const tabSwitcher = document.getElementById('bookmarks-tab-switcher');

    // Editor elements
    const promptEditorForm = document.getElementById('prompt-editor-form');
    const btnCancelPrompt = document.getElementById('btn-cancel-prompt');
    const editPromptId = document.getElementById('edit-prompt-id');
    const editPromptTitle = document.getElementById('edit-prompt-title');
    const editPromptProject = document.getElementById('edit-prompt-project');
    const editPromptScene = document.getElementById('edit-prompt-scene');
    const editPromptContent = document.getElementById('edit-prompt-content');
    const editPromptDesc = document.getElementById('edit-prompt-desc');
    const editPromptTags = document.getElementById('edit-prompt-tags');
    const editPromptPinned = document.getElementById('edit-prompt-pinned');
    const btnInsertVariable = document.getElementById('btn-insert-variable');
    const projectDatalist = document.getElementById('prompt-project-options');

    // Variable fill modal elements
    const variableModal = document.getElementById('prompt-variable-modal');
    const variableModalTitle = document.getElementById('prompt-variable-modal-title');
    const variableInputsContainer = document.getElementById('prompt-variable-inputs-container');
    const variablePreviewText = document.getElementById('prompt-variable-preview-text');
    const btnCopyRawPrompt = document.getElementById('btn-copy-raw-prompt');
    const btnCopyFilledPrompt = document.getElementById('btn-copy-filled-prompt');
    const btnSendFilledToAi = document.getElementById('btn-send-filled-to-ai');

    // ── Helper: Extract unique projects from prompts database ──
    function getUniqueProjects() {
        const set = new Set();
        (state.promptsDatabase || []).forEach(p => {
            const pr = (p.project || '').trim();
            if (pr && pr !== '通用') set.add(pr);
        });
        return Array.from(set);
    }

    // ── Render Project Chips ──
    function renderProjectChips() {
        if (!projectChipsContainer) return;
        const projects = getUniqueProjects();
        projectChipsContainer.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = 'prompt-chip' + (currentProjectFilter === 'all' ? ' active' : '');
        allBtn.dataset.project = 'all';
        allBtn.textContent = '全部项目';
        projectChipsContainer.appendChild(allBtn);

        const commonBtn = document.createElement('button');
        commonBtn.type = 'button';
        commonBtn.className = 'prompt-chip' + (currentProjectFilter === '通用' ? ' active' : '');
        commonBtn.dataset.project = '通用';
        commonBtn.textContent = '通用';
        projectChipsContainer.appendChild(commonBtn);

        projects.forEach(pr => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'prompt-chip' + (currentProjectFilter === pr ? ' active' : '');
            btn.dataset.project = pr;
            btn.textContent = pr;
            projectChipsContainer.appendChild(btn);
        });

        // Update datalist for editor
        if (projectDatalist) {
            projectDatalist.innerHTML = ['通用', ...projects].map(pr => '<option value="' + escapeHtml(pr) + '"></option>').join('');
        }
    }

    // ── Scene Emoji Map ──
    const SCENE_ICONS = {
        '开发': '💻',
        '写作': '✍️',
        '润色': '🎨',
        '推演': '🧠',
        '翻译': '🌐',
        '角色': '🎭',
        '通用': '⚡',
    };

    function getSceneIcon(scene) {
        return SCENE_ICONS[scene] || '✨';
    }

    // ── Render Prompts List ──
    function renderPrompts() {
        if (!promptsListContainer) return;
        promptsListContainer.innerHTML = '';

        renderProjectChips();

        let list = [...(state.promptsDatabase || [])];

        // 1. Project filter
        if (currentProjectFilter !== 'all') {
            list = list.filter(p => (p.project || '通用') === currentProjectFilter);
        }

        // 2. Scene filter
        if (currentSceneFilter !== 'all') {
            list = list.filter(p => (p.scene || '通用') === currentSceneFilter);
        }

        // 3. Search keyword filter
        if (currentSearchKeyword) {
            const kw = currentSearchKeyword.toLowerCase();
            list = list.filter(p =>
                (p.title || '').toLowerCase().includes(kw) ||
                (p.content || '').toLowerCase().includes(kw) ||
                (p.description || '').toLowerCase().includes(kw) ||
                (p.tags || '').toLowerCase().includes(kw) ||
                (p.project || '').toLowerCase().includes(kw)
            );
        }

        // 4. Sort: Pinned first, then ID desc
        list.sort((a, b) => {
            if (b.is_pinned !== a.is_pinned) return (b.is_pinned ? 1 : 0) - (a.is_pinned ? 1 : 0);
            return (b.id || 0) - (a.id || 0);
        });

        // Empty state
        if (list.length === 0) {
            if (!state.promptsDatabase || state.promptsDatabase.length === 0) {
                promptsListContainer.innerHTML = `
                    <div class="list-empty prompt-empty-state">
                        <div class="list-empty-icon">🤖</div>
                        <div class="list-empty-title">提示词库空空如也</div>
                        <div class="list-empty-sub">收集并分类你在不同项目与场景下的专属 AI 提示词</div>
                        <div style="margin-top: 16px; display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;">
                            <button type="button" class="btn-primary" id="btn-import-starter-prompts">✨ 一键载入常用模板</button>
                            <button type="button" class="btn-secondary" id="btn-empty-create-prompt">+ 手动新建</button>
                        </div>
                    </div>
                `;
                const btnStarter = document.getElementById('btn-import-starter-prompts');
                if (btnStarter) {
                    btnStarter.addEventListener('click', () => {
                        state.promptsDatabase = [...DEFAULT_PROMPTS];
                        savePromptsDatabase();
                        state.promptsDatabase.forEach(p => apiSyncPrompt(p, 'POST'));
                        renderPrompts();
                        showToast('已载入 4 条常用精选提示词模板！', 'success');
                    });
                }
                const btnEmptyCreate = document.getElementById('btn-empty-create-prompt');
                if (btnEmptyCreate) btnEmptyCreate.addEventListener('click', () => openPromptEditor());
                return;
            }

            promptsListContainer.innerHTML = `
                <div class="list-empty">
                    <div class="list-empty-icon">🔍</div>
                    <div class="list-empty-title">未找到匹配的提示词</div>
                    <div class="list-empty-sub">尝试更换筛选项目、使用场景或清空搜索词</div>
                </div>
            `;
            return;
        }

        // Render Cards
        list.forEach(prompt => {
            const card = document.createElement('div');
            card.className = 'prompt-card' + (prompt.is_pinned ? ' is-pinned' : '');
            card.setAttribute('data-prompt-id', String(prompt.id));

            const hasVariables = /\{\{([^}]+)\}\}/.test(prompt.content || '');
            const sceneIcon = getSceneIcon(prompt.scene || '通用');

            const tagHtml = prompt.tags
                ? prompt.tags.split(/[,，\s]+/).filter(Boolean).map(t => '<span class="prompt-tag">' + escapeHtml(t.startsWith('#') ? t : '#' + t) + '</span>').join('')
                : '';

            card.innerHTML = `
                <div class="prompt-card-header">
                    <div class="prompt-card-title-group">
                        ${prompt.is_pinned ? '<span class="prompt-card-pin" title="已置顶">📌</span>' : ''}
                        <span class="prompt-card-title">${escapeHtml(prompt.title)}</span>
                    </div>
                    <div class="prompt-card-badges">
                        <span class="prompt-badge prompt-badge-project" title="所属项目">📁 ${escapeHtml(prompt.project || '通用')}</span>
                        <span class="prompt-badge prompt-badge-scene" title="使用场景">${sceneIcon} ${escapeHtml(prompt.scene || '通用')}</span>
                    </div>
                </div>

                ${prompt.description ? '<div class="prompt-card-desc">' + escapeHtml(prompt.description) + '</div>' : ''}

                <div class="prompt-card-content-wrapper">
                    <div class="prompt-card-content" id="prompt-content-${prompt.id}">${escapeHtml(prompt.content)}</div>
                    <div class="prompt-expand-mask"><span class="btn-expand-text">展开全文 ▾</span></div>
                </div>

                ${tagHtml ? '<div class="prompt-card-tags">' + tagHtml + '</div>' : ''}

                <div class="prompt-card-actions">
                    <div class="prompt-action-left">
                        <button type="button" class="btn-prompt-action btn-prompt-copy" data-id="${prompt.id}" title="复制提示词">
                            <span class="action-icon">📋</span>
                            <span class="action-label">${hasVariables ? '填参 / 复制' : '复制'}</span>
                        </button>
                        <button type="button" class="btn-prompt-action btn-prompt-ai" data-id="${prompt.id}" title="发送至 AI 对话助手">
                            <span class="action-icon">✨</span>
                            <span class="action-label">直发 AI</span>
                        </button>
                    </div>
                    <div class="prompt-action-right">
                        <button type="button" class="btn-icon-action btn-prompt-edit" data-id="${prompt.id}" title="编辑提示词">✏️</button>
                        <button type="button" class="btn-icon-action btn-prompt-delete" data-id="${prompt.id}" title="删除提示词">🗑️</button>
                    </div>
                </div>
            `;

            // Expand / Collapse toggling
            const contentWrapper = card.querySelector('.prompt-card-content-wrapper');
            contentWrapper.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                contentWrapper.classList.toggle('expanded');
                const maskText = contentWrapper.querySelector('.btn-expand-text');
                if (maskText) {
                    maskText.textContent = contentWrapper.classList.contains('expanded') ? '收起全文 ▴' : '展开全文 ▾';
                }
            });

            // 复制按钮
            const copyBtn = card.querySelector('.btn-prompt-copy');
            copyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handlePromptCopy(prompt, copyBtn);
            });

            // 直发 AI 按钮
            const aiBtn = card.querySelector('.btn-prompt-ai');
            aiBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                handlePromptSendToAi(prompt);
            });

            // 编辑按钮
            const editBtn = card.querySelector('.btn-prompt-edit');
            editBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                openPromptEditor(prompt.id);
            });

            // 删除按钮
            const deleteBtn = card.querySelector('.btn-prompt-delete');
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deletePrompt(prompt.id, prompt.title);
            });

            promptsListContainer.appendChild(card);
        });
    }

    // ── One-Click Copy / Variable Filler ──
    function handlePromptCopy(prompt, btnEl) {
        const content = prompt.content || '';
        const vars = extractVariables(content);

        if (vars.length > 0) {
            openVariableModal(prompt);
        } else {
            doCopyText(content, btnEl, '已复制提示词！');
        }
    }

    // ── Direct Send to AI Assistant ──
    function handlePromptSendToAi(prompt) {
        const content = prompt.content || '';
        const vars = extractVariables(content);

        if (vars.length > 0) {
            openVariableModal(prompt, true);
        } else {
            if (actions.sendToAiChat) {
                actions.sendToAiChat(content);
                showToast('已填入 AI 记忆助手！', 'success');
            } else {
                doCopyText(content, null, '已复制提示词，请粘贴至 AI 窗口');
            }
        }
    }

    function doCopyText(text, btnEl, successMsg = '已复制到剪贴板！') {
        const afterCopy = () => {
            showToast(successMsg, 'success');
            if (btnEl) {
                const label = btnEl.querySelector('.action-label');
                const orig = label ? label.textContent : '';
                if (label) label.textContent = '已复制 ✓';
                btnEl.classList.add('copied');
                setTimeout(() => {
                    if (label) label.textContent = orig;
                    btnEl.classList.remove('copied');
                }, 1600);
            }
        };

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(afterCopy).catch(() => {
                fallbackCopy(text);
                afterCopy();
            });
        } else {
            fallbackCopy(text);
            afterCopy();
        }
    }

    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e) {}
        document.body.removeChild(ta);
    }

    // ── Variables Helper ──
    function extractVariables(text) {
        const regex = /\{\{([^}]+)\}\}/g;
        const matches = [];
        let m;
        while ((m = regex.exec(text)) !== null) {
            const v = m[1].trim();
            if (v && !matches.includes(v)) matches.push(v);
        }
        return matches;
    }

    // ── Open Variable Filler Modal ──
    function openVariableModal(prompt, autoSendToAi = false) {
        if (!variableModal || !variableInputsContainer) return;

        const vars = extractVariables(prompt.content);
        if (variableModalTitle) variableModalTitle.textContent = '填入参数：' + prompt.title;
        variableInputsContainer.innerHTML = '';

        const varValues = {};

        vars.forEach((vName, idx) => {
            varValues[vName] = '';
            const row = document.createElement('div');
            row.className = 'variable-input-row';
            row.innerHTML = `
                <label class="variable-label" for="var-input-${idx}">{{${escapeHtml(vName)}}}</label>
                <textarea id="var-input-${idx}" class="variable-input" rows="2" placeholder="在此填入 ${escapeHtml(vName)} 的实际内容..."></textarea>
            `;
            const input = row.querySelector('textarea');
            input.addEventListener('input', () => {
                varValues[vName] = input.value;
                updateVariablePreview(prompt.content, varValues);
            });
            variableInputsContainer.appendChild(row);
        });

        updateVariablePreview(prompt.content, varValues);
        variableModal.classList.add('show');

        // Wire modal action buttons
        if (btnCopyRawPrompt) {
            btnCopyRawPrompt.onclick = () => {
                doCopyText(prompt.content, null, '已复制原始模板！');
                variableModal.classList.remove('show');
            };
        }

        if (btnCopyFilledPrompt) {
            btnCopyFilledPrompt.onclick = () => {
                const filled = buildFilledPrompt(prompt.content, varValues);
                doCopyText(filled, null, '已复制填参后的完整提示词！');
                variableModal.classList.remove('show');
            };
        }

        if (btnSendFilledToAi) {
            btnSendFilledToAi.onclick = () => {
                const filled = buildFilledPrompt(prompt.content, varValues);
                variableModal.classList.remove('show');
                if (actions.sendToAiChat) {
                    actions.sendToAiChat(filled);
                    showToast('已将完整提示词填入 AI 助手！', 'success');
                } else {
                    doCopyText(filled, null, '已复制提示词！');
                }
            };
        }

        // Auto focus first input
        setTimeout(() => {
            const first = variableInputsContainer.querySelector('textarea');
            if (first) first.focus();
        }, 120);
    }

    function buildFilledPrompt(template, varValues) {
        let res = template;
        Object.keys(varValues).forEach(k => {
            const val = varValues[k] || ('{{' + k + '}}');
            res = res.replaceAll('{{' + k + '}}', val);
        });
        return res;
    }

    function updateVariablePreview(template, varValues) {
        if (!variablePreviewText) return;
        variablePreviewText.textContent = buildFilledPrompt(template, varValues);
    }

    // ── Editor Form Open / Save / Cancel ──
    function openPromptEditor(promptId = null) {
        promptEditorForm.reset();
        editPromptId.value = '';
        renderProjectChips();

        const pageTitle = document.getElementById('prompt-editor-page-title');

        if (promptId) {
            const prompt = (state.promptsDatabase || []).find(p => String(p.id) === String(promptId));
            if (prompt) {
                if (pageTitle) pageTitle.textContent = '编辑提示词';
                editPromptId.value = prompt.id;
                editPromptTitle.value = prompt.title || '';
                editPromptProject.value = prompt.project || '通用';
                editPromptScene.value = prompt.scene || '开发';
                editPromptContent.value = prompt.content || '';
                editPromptDesc.value = prompt.description || '';
                editPromptTags.value = prompt.tags || '';
                editPromptPinned.checked = !!prompt.is_pinned;
            }
        } else {
            if (pageTitle) pageTitle.textContent = '新建提示词';
            editPromptProject.value = currentProjectFilter !== 'all' ? currentProjectFilter : '通用';
            editPromptScene.value = currentSceneFilter !== 'all' ? currentSceneFilter : '开发';
            editPromptPinned.checked = false;
        }

        actions.switchView('prompt-editor');
    }

    function deletePrompt(id, title) {
        if (!confirm('确定要删除提示词「' + title + '」吗？')) return;
        addDeletedId(id);
        state.promptsDatabase = (state.promptsDatabase || []).filter(p => String(p.id) !== String(id));
        savePromptsDatabase();
        apiSyncPrompt({ id }, 'DELETE');
        renderPrompts();
        showToast('已删除提示词', 'info');
    }

    // ── Event Handlers ──

    // Subtab Switcher: Bookmarks vs Prompts
    if (tabSwitcher) {
        tabSwitcher.addEventListener('click', (e) => {
            const btn = e.target.closest('.segment-btn');
            if (!btn) return;
            const subtab = btn.dataset.subtab;
            tabSwitcher.querySelectorAll('.segment-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');

            if (subtab === 'prompts') {
                if (subviewResources) subviewResources.style.display = 'none';
                if (subviewPrompts) subviewPrompts.style.display = 'block';
                renderPrompts();
                const fabLabel = document.getElementById('fab-label');
                if (fabLabel) fabLabel.textContent = '新建提示词';
            } else {
                if (subviewResources) subviewResources.style.display = 'block';
                if (subviewPrompts) subviewPrompts.style.display = 'none';
                actions.renderBookmarks?.();
                const fabLabel = document.getElementById('fab-label');
                if (fabLabel) fabLabel.textContent = '收藏新链接';
            }
        });
    }

    // Top New Prompt Button
    if (btnCreatePrompt) {
        btnCreatePrompt.addEventListener('click', () => openPromptEditor());
    }

    // Project Chips Click
    if (projectChipsContainer) {
        projectChipsContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.prompt-chip');
            if (!chip) return;
            currentProjectFilter = chip.dataset.project || 'all';
            projectChipsContainer.querySelectorAll('.prompt-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            renderPrompts();
        });
    }

    // Scene Chips Click
    if (sceneChipsContainer) {
        sceneChipsContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.prompt-chip');
            if (!chip) return;
            currentSceneFilter = chip.dataset.scene || 'all';
            sceneChipsContainer.querySelectorAll('.prompt-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            renderPrompts();
        });
    }

    // Search Input
    if (promptsSearchInput) {
        promptsSearchInput.addEventListener('input', () => {
            currentSearchKeyword = promptsSearchInput.value.trim();
            if (promptsSearchClear) {
                promptsSearchClear.style.display = currentSearchKeyword ? 'block' : 'none';
            }
            renderPrompts();
        });
    }

    if (promptsSearchClear) {
        promptsSearchClear.addEventListener('click', () => {
            promptsSearchInput.value = '';
            currentSearchKeyword = '';
            promptsSearchClear.style.display = 'none';
            promptsSearchInput.focus();
            renderPrompts();
        });
    }

    // Cancel in Editor
    if (btnCancelPrompt) {
        btnCancelPrompt.addEventListener('click', () => actions.switchView('bookmarks'));
    }

    // Insert placeholder in Editor
    if (btnInsertVariable) {
        btnInsertVariable.addEventListener('click', () => {
            const placeholder = prompt('请输入占位符名称（例如：输入代码、待润色内容）：', '待填内容');
            if (!placeholder) return;
            const insertText = '{{' + placeholder.trim() + '}}';
            const start = editPromptContent.selectionStart;
            const end = editPromptContent.selectionEnd;
            const val = editPromptContent.value;
            editPromptContent.value = val.substring(0, start) + insertText + val.substring(end);
            editPromptContent.focus();
            editPromptContent.selectionStart = editPromptContent.selectionEnd = start + insertText.length;
        });
    }

    // Save Prompt Form Submit
    if (promptEditorForm) {
        promptEditorForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const id = editPromptId.value ? parseInt(editPromptId.value) : generateUniqueId();
            const isEditing = !!editPromptId.value;

            const newPrompt = {
                id,
                title: editPromptTitle.value.trim(),
                project: editPromptProject.value.trim() || '通用',
                scene: editPromptScene.value || '开发',
                content: editPromptContent.value.trim(),
                description: editPromptDesc.value.trim(),
                tags: editPromptTags.value.trim(),
                is_pinned: editPromptPinned.checked ? 1 : 0,
            };

            stampLocalUpdate(newPrompt);

            if (isEditing) {
                const idx = (state.promptsDatabase || []).findIndex(p => p.id === id);
                if (idx !== -1) state.promptsDatabase[idx] = newPrompt;
                else state.promptsDatabase.unshift(newPrompt);
            } else {
                state.promptsDatabase = state.promptsDatabase || [];
                state.promptsDatabase.unshift(newPrompt);
            }

            savePromptsDatabase();
            apiSyncPrompt(newPrompt, 'POST');

            actions.switchView('bookmarks');

            // Switch subtab to prompts
            const promptTabBtn = document.querySelector('.segment-btn[data-subtab="prompts"]');
            if (promptTabBtn) promptTabBtn.click();
            else renderPrompts();

            showToast(isEditing ? '提示词修改已保存！' : '新建提示词成功！', 'success');
        });
    }

    // Expose actions
    actions.renderPrompts = renderPrompts;
    actions.openPromptEditor = openPromptEditor;

    return { renderPrompts, openPromptEditor };
}
