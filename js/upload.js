import { state } from './state.js';
import { API_BASE, resolveAssetUrl } from './api.js';

export function initUpload() {
// 图片上传处理
const globalImageUploader = document.getElementById('global-image-uploader');
let currentUploadTargetInput = null;

document.querySelectorAll('.btn-upload-image').forEach(btn => {
    btn.addEventListener('click', () => {
        currentUploadTargetInput = document.getElementById(btn.dataset.target);
        if (globalImageUploader) {
            globalImageUploader.click();
        }
    });
});

// 客户端图片压缩，避免手机相册原图过大（Telegraph 限制 5MB 且不支持 HEIC）
const compressImage = (file, maxWidth = 1600, maxHeight = 1600, quality = 0.8) => {
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

if (globalImageUploader) {
    globalImageUploader.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file || !currentUploadTargetInput) return;

        const uploadBtn = document.querySelector(`.btn-upload-image[data-target="${currentUploadTargetInput.id}"]`);
        const originalBtnText = uploadBtn ? uploadBtn.innerText : '📷 上传';
        
        let uploadFile = file;
        if (file.type.startsWith('image/')) {
            if (uploadBtn) {
                uploadBtn.innerText = '压缩中...';
                uploadBtn.disabled = true;
            }
            try {
                const compressedBlob = await compressImage(file, 1600, 1600, 0.85);
                const baseName = file.name.includes('.') ? file.name.substring(0, file.name.lastIndexOf('.')) : file.name;
                const newFileName = `${baseName || 'image'}.jpg`;
                uploadFile = new File([compressedBlob], newFileName, { type: 'image/jpeg' });
            } catch (compressErr) {
                console.warn('Image compression failed, using original file:', compressErr);
            }
        }

        if (uploadBtn) {
            uploadBtn.innerText = '上传中...';
            uploadBtn.disabled = true;
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
            if (!res.ok) throw new Error('上传接口返回异常');
            const data = await res.json();
            if (data && data[0] && data[0].src) {
                currentUploadTargetInput.value = data[0].src;
                currentUploadTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
                if (currentUploadTargetInput.id === 'feed-media-url') {
                    const previewWrap = document.getElementById('feed-media-preview');
                    const previewImg = document.getElementById('feed-media-preview-img');
                    if (previewWrap && previewImg) {
                        previewImg.src = resolveAssetUrl(data[0].src);
                        previewWrap.style.display = 'block';
                    }
                    const mediaWrap = document.getElementById('feed-media-input-wrapper');
                    if (mediaWrap) mediaWrap.style.display = 'block';
                } else {
                    alert('图片上传成功！已填入链接。');
                }
            } else {
                throw new Error('解析上传结果失败');
            }
        } catch (err) {
            alert('图片上传失败，请重试：' + err.message);
        } finally {
            if (uploadBtn) {
                uploadBtn.innerText = originalBtnText;
                uploadBtn.disabled = false;
            }
            globalImageUploader.value = '';
        }
    });
}


}
