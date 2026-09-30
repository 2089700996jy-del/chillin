/** Global image upload to /api/upload; writes resolved URL into target input. */
import { state } from './state.js';
import { API_BASE, resolveAssetUrl } from './api.js';
import { showToast } from './utils.js';

// 客户端图片压缩，避免手机相册原图过大（限制 5MB）
export const compressImage = (file, maxWidth = 1600, maxHeight = 1600, quality = 0.85) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > maxWidth || height > maxHeight) {
                    if (width > height) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    } else {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Canvas to Blob conversion failed'));
                    }
                }, 'image/jpeg', quality);
            };
            img.onerror = (err) => reject(err);
        };
        reader.onerror = (err) => reject(err);
    });
};

/**
 * 核心单图上传与回填流程
 */
export async function uploadSingleImage(file, { targetInput = null, mode = 'value', btn = null } = {}) {
    if (!file) return;

    let originalBtnHtml = '';
    if (btn) {
        originalBtnHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span style="font-size:12px;opacity:0.9;">⏳ 正在上传...</span>';
    }

    let uploadFile = file;
    if (file.type && file.type.startsWith('image/')) {
        try {
            if (btn) btn.innerHTML = '<span style="font-size:12px;opacity:0.9;">🔄 压缩中...</span>';
            const compressedBlob = await compressImage(file, 1600, 1600, 0.85);
            const baseName = file.name && file.name.includes('.') 
                ? file.name.substring(0, file.name.lastIndexOf('.')) 
                : (file.name || 'image');
            const newFileName = `${baseName}.jpg`;
            uploadFile = new File([compressedBlob], newFileName, { type: 'image/jpeg' });
        } catch (compressErr) {
            console.warn('Image compression failed, using original file:', compressErr);
        }
    }

    if (btn) {
        btn.innerHTML = '<span style="font-size:12px;opacity:0.9;">🚀 上传中...</span>';
    }

    const formData = new FormData();
    formData.append('file', uploadFile);

    const headers = {};
    if (state.authToken) {
        headers['Authorization'] = `Bearer ${state.authToken}`;
    }

    try {
        const res = await fetch(`${API_BASE}/api/upload`, {
            method: 'POST',
            headers: headers,
            body: formData
        });

        if (res.status === 401) {
            showToast('上传失败：登录已过期或未登录，请先登录', 'error');
            return;
        }
        if (res.status === 413) {
            showToast('上传失败：图片文件过大，单张最大支持 5MB', 'error');
            return;
        }
        if (!res.ok) {
            const errData = await res.json().catch(() => null);
            throw new Error(errData?.error || `接口返回状态 ${res.status}`);
        }

        const data = await res.json();
        if (data && data[0] && data[0].src) {
            const src = data[0].src;

            if (targetInput) {
                const isMarkdownTarget = mode === 'markdown' || targetInput.tagName === 'TEXTAREA';
                if (isMarkdownTarget) {
                    // 正文 Markdown 插入模式
                    const start = targetInput.selectionStart ?? targetInput.value.length;
                    const end = targetInput.selectionEnd ?? targetInput.value.length;
                    const val = targetInput.value;
                    const before = val.slice(0, start);
                    const after = val.slice(end);
                    const needLeadingNewline = before.length > 0 && !before.endsWith('\n');
                    const insertText = (needLeadingNewline ? '\n' : '') + `![图片](${src})\n`;
                    targetInput.value = before + insertText + after;
                    targetInput.selectionStart = targetInput.selectionEnd = start + insertText.length;
                    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
                    showToast('图片已成功上传并插入正文！', 'success');
                } else {
                    // 单一 URL 链接输入框回填模式 (如封面、日常实拍、动态图)
                    targetInput.value = src;
                    targetInput.dispatchEvent(new Event('input', { bubbles: true }));
                    targetInput.dispatchEvent(new Event('change', { bubbles: true }));

                    if (targetInput.id === 'edit-cover') {
                        showToast('封面图已上传并填入！', 'success');
                    } else if (targetInput.id === 'feed-media-url') {
                        const previewWrap = document.getElementById('feed-media-preview');
                        const previewImg = document.getElementById('feed-media-preview-img');
                        if (previewWrap && previewImg) {
                            previewImg.src = resolveAssetUrl(src);
                            previewWrap.style.display = 'block';
                        }
                        const mediaWrap = document.getElementById('feed-media-input-wrapper');
                        if (mediaWrap) mediaWrap.style.display = 'block';
                        showToast('动态配图已上传！', 'success');
                    } else {
                        showToast('图片上传成功！已填入链接', 'success');
                    }
                }
            } else {
                showToast('图片上传成功！', 'success');
            }
        } else {
            throw new Error('未获取到返回的文件地址');
        }
    } catch (err) {
        console.error('[Upload] error:', err);
        showToast('图片上传失败，请重试：' + (err.message || '未知错误'), 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalBtnHtml;
            btn.disabled = false;
        }
        const globalUploader = document.getElementById('global-image-uploader');
        if (globalUploader) globalUploader.value = '';
    }
}

export function initUpload() {
    const globalImageUploader = document.getElementById('global-image-uploader');
    let currentUploadTargetInput = null;
    let currentUploadMode = 'value';
    let currentActiveUploadBtn = null;

    // 1. 全局委托：支持所有带有 .btn-upload-image 的上传与插入按钮
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-upload-image');
        if (!btn) return;

        const targetId = btn.dataset.target;
        currentUploadTargetInput = document.getElementById(targetId);
        currentUploadMode = btn.dataset.mode || (currentUploadTargetInput?.tagName === 'TEXTAREA' ? 'markdown' : 'value');
        currentActiveUploadBtn = btn;

        if (globalImageUploader) {
            // 关键修复：每次点击前主动清空 value，确保选择同名文件或取消后重选均能触发 change 事件
            globalImageUploader.value = '';
            globalImageUploader.click();
        }
    });

    // 2. 监听文件选择框选择事件
    if (globalImageUploader) {
        globalImageUploader.addEventListener('change', async (e) => {
            const file = e.target.files?.[0];
            if (!file) return;

            await uploadSingleImage(file, {
                targetInput: currentUploadTargetInput,
                mode: currentUploadMode,
                btn: currentActiveUploadBtn
            });
        });
    }

    // 3. 增强：支持在周记正文与备忘录正文中直接粘贴 (Ctrl+V) 图片自动上传
    document.addEventListener('paste', async (e) => {
        const target = e.target;
        if (!target || (target.id !== 'edit-content' && target.id !== 'edit-note-content')) return;

        const items = e.clipboardData?.items;
        if (!items) return;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.type && item.type.startsWith('image/')) {
                e.preventDefault();
                const file = item.getAsFile();
                if (file) {
                    showToast('正在上传剪贴板图片...', 'info');
                    await uploadSingleImage(file, {
                        targetInput: target,
                        mode: 'markdown',
                        btn: null
                    });
                }
                break;
            }
        }
    });

    // 4. 增强：支持向周记正文与备忘录正文直接拖拽 (Drag & Drop) 图片文件
    const bindDropUpload = (textareaId) => {
        const el = document.getElementById(textareaId);
        if (!el) return;

        el.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        el.addEventListener('drop', async (e) => {
            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;

            for (let i = 0; i < files.length; i++) {
                const file = files[i];
                if (file.type && file.type.startsWith('image/')) {
                    e.preventDefault();
                    showToast('正在上传拖拽图片...', 'info');
                    await uploadSingleImage(file, {
                        targetInput: el,
                        mode: 'markdown',
                        btn: null
                    });
                    break;
                }
            }
        });
    };

    bindDropUpload('edit-content');
    bindDropUpload('edit-note-content');
}
