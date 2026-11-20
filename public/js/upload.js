/** Global image upload to /api/upload; writes resolved URL into target input. */
import { state } from './state.js';
import { actions } from './actions.js';
import { API_BASE, resolveAssetUrl } from './api.js';
import { showToast } from './utils.js';
import { setHtml } from './trusted-types.js';

// 客户端图片压缩，避免手机相册原图过大（支持至 15MB）
export const compressImage = (file, maxWidth = 1600, maxHeight = 1600, quality = 0.85) => {
    return new Promise((resolve, reject) => {
        let objectUrl = null;
        let cleanedUp = false;
        const cleanup = () => {
            if (!cleanedUp) {
                cleanedUp = true;
                if (objectUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
                    try { URL.revokeObjectURL(objectUrl); } catch (_) {}
                }
            }
        };

        const img = new Image();
        img.onload = () => {
            try {
                let width = img.naturalWidth || img.width;
                let height = img.naturalHeight || img.height;

                if (!width || !height) {
                    cleanup();
                    return reject(new Error('Invalid image dimensions'));
                }

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

                // 优先 WebP（同画质体积通常比 JPEG 小 25%~35%），不支持时回退 JPEG
                const mime = supportsWebpExport() ? 'image/webp' : 'image/jpeg';
                canvas.toBlob((blob) => {
                    cleanup();
                    if (blob) {
                        resolve(blob);
                    } else {
                        // 探测通过但导出失败：再试一次 JPEG
                        canvas.toBlob((jpegBlob) => {
                            jpegBlob ? resolve(jpegBlob) : reject(new Error('Canvas to Blob conversion failed'));
                        }, 'image/jpeg', quality);
                    }
                }, mime, quality);
            } catch (err) {
                cleanup();
                reject(err);
            }
        };
        img.onerror = (err) => {
            cleanup();
            reject(err);
        };

        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
                objectUrl = URL.createObjectURL(file);
                img.src = objectUrl;
                return;
            } catch (_) {}
        }

        const reader = new FileReader();
        reader.onload = (event) => { img.src = event.target.result; };
        reader.onerror = (err) => { cleanup(); reject(err); };
        reader.readAsDataURL(file);
    });
};

/** 上一次失败的上传：供「重试上传」复用，避免用户重新选文件 */
let pendingRetry = null;

export function clearPendingRetry(btn = null) {
    pendingRetry = null;
    if (btn) {
        delete btn.dataset.uploadRetry;
        if (btn.dataset.originalHtml) setHtml(btn, btn.dataset.originalHtml);
    } else {
        document.querySelectorAll('.btn-upload-image[data-upload-retry]').forEach((b) => {
            delete b.dataset.uploadRetry;
            if (b.dataset.originalHtml) setHtml(b, b.dataset.originalHtml);
        });
    }
}

/** 浏览器 canvas 是否支持导出 WebP（Safari 14+ / Chrome / Firefox 全支持，仍需探测兜底） */
let webpSupported = null;
function supportsWebpExport() {
    if (webpSupported !== null) return webpSupported;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        webpSupported = canvas.toDataURL('image/webp').startsWith('data:image/webp');
    } catch (_) {
        webpSupported = false;
    }
    return webpSupported;
}

/** XHR 上传（fetch 无法上报进度）：返回 { status, text }，失败时 reject */
function postUploadWithProgress(formData, onProgress) {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `${API_BASE}/api/upload`);
        xhr.withCredentials = true;
        xhr.timeout = 60000;
        if (state.authToken) xhr.setRequestHeader('Authorization', `Bearer ${state.authToken}`);
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && typeof onProgress === 'function') {
                onProgress(event.loaded / event.total);
            }
        };
        xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText || '' });
        xhr.onerror = () => reject(new Error('网络连接失败'));
        xhr.ontimeout = () => reject(new Error('上传超时，请检查网络后重试'));
        xhr.send(formData);
    });
}

/**
 * 核心单图上传与回填流程
 */
export async function uploadSingleImage(file, { targetInput = null, mode = 'value', btn = null } = {}) {
    if (!file) return;

    let originalBtnHtml = '';
    if (btn) {
        if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
        originalBtnHtml = btn.dataset.originalHtml;
        delete btn.dataset.uploadRetry;
        btn.disabled = true;
        setHtml(btn, '<span style="font-size:12px;opacity:0.9;">⏳ 正在上传...</span>');
    }
    pendingRetry = null;

    let uploadFile = file;

    // 乐观即时预览与旧状态记录（失败时回退，成功后释放 ObjectURL）
    let tempPreviewUrl = null;
    let previousPreviewSrc = null;
    let previousPreviewDisplay = null;

    const previewWrap = targetInput?.id === 'edit-cover' ? document.getElementById('edit-cover-preview') : null;
    const previewImg = targetInput?.id === 'edit-cover' ? document.getElementById('edit-cover-preview-img') : null;

    if (previewWrap && previewImg) {
        previousPreviewSrc = previewImg.src;
        previousPreviewDisplay = previewWrap.style.display;
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
            try {
                tempPreviewUrl = URL.createObjectURL(file);
                previewImg.src = tempPreviewUrl;
                previewWrap.style.display = 'block';
            } catch (_) { /* audit-ignore: intentional-fallback */ }
        }
    }

    const cleanupTempPreview = () => {
        if (tempPreviewUrl && typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
            try { URL.revokeObjectURL(tempPreviewUrl); } catch (_) {}
            tempPreviewUrl = null;
        }
    };

    const restorePreviousPreview = () => {
        cleanupTempPreview();
        if (previewWrap && previewImg) {
            if (previousPreviewSrc) {
                previewImg.src = previousPreviewSrc;
                previewWrap.style.display = previousPreviewDisplay || 'block';
            } else if (targetInput && targetInput.value) {
                previewImg.src = resolveAssetUrl(targetInput.value);
                previewWrap.style.display = 'block';
            } else {
                previewImg.src = '';
                previewWrap.style.display = 'none';
            }
        }
    };

    // 检测是否为图片（支持大写扩展名以及移动端 MIME 为空的照片），GIF 动图跳过压缩保持帧序列
    const isGif = file.type === 'image/gif' || /\.gif$/i.test(file.name || '');
    const isDirectlySupported = (file.type && /^image\/(jpeg|png|gif|webp)$/i.test(file.type)) ||
                                /\.(jpe?g|png|gif|webp)$/i.test(file.name || '');
    const isImage = (file.type && file.type.startsWith('image/')) ||
                    /\.(jpe?g|png|webp|gif|bmp|heic|heif|jfif|tiff?)$/i.test(file.name || '');
    if (isImage && !isGif) {
        let compressed = false;
        try {
            if (btn) setHtml(btn, '<span style="font-size:12px;opacity:0.9;">🔄 压缩中...</span>');
            const compressedBlob = await compressImage(file, 1600, 1600, 0.85);
            const baseName = file.name && file.name.includes('.') 
                ? file.name.substring(0, file.name.lastIndexOf('.')) 
                : (file.name || 'image');
            const isWebp = compressedBlob.type === 'image/webp';
            const newFileName = `${baseName}.${isWebp ? 'webp' : 'jpg'}`;
            uploadFile = new File([compressedBlob], newFileName, { type: compressedBlob.type || (isWebp ? 'image/webp' : 'image/jpeg') });
            compressed = true;
        } catch (compressErr) {
            console.warn('Image compression failed, using original file:', compressErr);
        }

        // 统一格式支持策略：若浏览器无法解码非标准格式（如部分浏览器对 HEIC/HEIF/TIFF 不支持），
        // 且原文件并不是后端直接支持的格式（JPEG/PNG/GIF/WEBP），则不可回退上传原文件（后端必定 400 拒绝）
        if (!compressed && !isDirectlySupported) {
            restorePreviousPreview();
            const extMatch = (file.name || '').match(/\.([a-zA-Z0-9]+)$/);
            const extName = extMatch ? extMatch[1].toUpperCase() : '特殊';
            showToast(`当前浏览器无法直接解码 ${extName} 格式图片，请转换为 JPG/PNG/WebP 格式后上传`, 'error');
            return;
        }
    }

    if (btn) {
        setHtml(btn, '<span style="font-size:12px;opacity:0.9;">🚀 上传中...</span>');
    }

    const formData = new FormData();
    formData.append('file', uploadFile);

    const updateButton = (ratio) => {
        if (!btn) return;
        const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
        setHtml(btn, `<span style="font-size:12px;opacity:0.9;">🚀 上传中 ${pct}%</span>`);
    };

    try {
        const res = await postUploadWithProgress(formData, updateButton);

        if (res.status === 401) {
            restorePreviousPreview();
            showToast('上传失败：登录已过期或未登录，请先登录', 'error');
            return;
        }
        if (res.status === 413) {
            restorePreviousPreview();
            showToast('上传失败：图片文件过大，单张最大支持 15MB', 'error');
            return;
        }
        if (res.status < 200 || res.status >= 300) {
            let message = `接口返回状态 ${res.status}`;
            try {
                const parsed = JSON.parse(res.text);
                if (parsed && parsed.error) message = parsed.error;
            } catch (_) { /* audit-ignore: intentional-fallback 非 JSON 响应，保留默认文案 */ }
            throw new Error(message);
        }

        const data = JSON.parse(res.text || 'null');
        if (data && data[0] && data[0].src) {
            const src = data[0].src;
            cleanupTempPreview();

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
                        if (previewWrap && previewImg) {
                            previewImg.src = resolveAssetUrl(src);
                            previewWrap.style.display = 'block';
                        }
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
        restorePreviousPreview();
        // 记住这次上传，让用户点一下就能重试，不必重新选文件
        pendingRetry = { file: uploadFile, targetInput, mode, btn };
        showToast('图片上传失败：' + (err.message || '未知错误') + '，可点击「重试上传」', 'error');
    } finally {
        cleanupTempPreview();
        if (btn) {
            if (pendingRetry && pendingRetry.btn === btn) {
                setHtml(btn, '<span style="font-size:12px;opacity:0.9;">↻ 重试上传</span>');
                btn.dataset.uploadRetry = '1';
            } else {
                setHtml(btn, btn.dataset.originalHtml || originalBtnHtml);
                delete btn.dataset.uploadRetry;
            }
            btn.disabled = false;
        }
        const globalUploader = document.getElementById('global-image-uploader');
        if (globalUploader) globalUploader.value = '';
    }
}

let currentUploadTargetInput = null;
let currentUploadMode = 'value';
let currentActiveUploadBtn = null;

/**
 * 直接同步拉起系统图片选择器，规避移动端合成事件传递（Synthetic Event Chaining）导致瞬态激活失效
 */
export function triggerImageUpload({ targetInput = null, targetInputId = 'edit-cover', mode = 'value', btn = null } = {}) {
    const input = targetInput || (targetInputId ? document.getElementById(targetInputId) : null);
    currentUploadTargetInput = input;
    currentUploadMode = mode || (input?.tagName === 'TEXTAREA' ? 'markdown' : 'value');
    currentActiveUploadBtn = btn;
    clearPendingRetry(btn);
    const uploader = document.getElementById('global-image-uploader');
    if (uploader) {
        uploader.value = '';
        uploader.click();
    }
}

export function initUpload() {
    actions.clearPendingRetry = clearPendingRetry;
    actions.triggerImageUpload = triggerImageUpload;
    if (typeof document === 'undefined') return;
    const getGlobalUploader = () => document.getElementById('global-image-uploader');

    // 清理重试状态：监听封面移除与输入框清空（捕获阶段，防止子元素 stopPropagation 吞掉点击）
    document.addEventListener('click', (e) => {
        if (e.target.closest('#btn-clear-cover') || e.target.closest('.ios-cover-preview-clear')) {
            clearPendingRetry();
        }
    }, true);
    document.getElementById('edit-cover')?.addEventListener('input', (e) => {
        if (!e.target.value.trim()) {
            clearPendingRetry();
        }
    });

    // 1. 全局委托：支持所有带有 .btn-upload-image 的上传与插入按钮
    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.btn-upload-image');
        if (!btn) return;

        // 上次失败的上传：直接重试，不再弹文件选择器
        if (btn.dataset.uploadRetry === '1' && pendingRetry) {
            const retry = pendingRetry;
            pendingRetry = null;
            delete btn.dataset.uploadRetry;
            uploadSingleImage(retry.file, { targetInput: retry.targetInput, mode: retry.mode, btn });
            return;
        }

        const targetId = btn.dataset.target;
        const targetInput = targetId ? document.getElementById(targetId) : null;
        const mode = btn.dataset.mode || (targetInput?.tagName === 'TEXTAREA' ? 'markdown' : 'value');
        triggerImageUpload({ targetInput, mode, btn });
    });

    // 2. 监听文件选择框选择事件
    const uploader = getGlobalUploader();
    if (uploader) {
        uploader.addEventListener('change', async (e) => {
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
