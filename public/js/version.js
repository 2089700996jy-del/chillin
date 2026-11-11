/** Single source of truth for the visible app version (bump with cache ?v=). */
export const APP_VERSION = '2.5.242';
export const APP_BUILD_LABEL = `v${APP_VERSION}`;

/**
 * 判断 candidate 是否比 baseline 新（只认 x.y.z 纯数字比较，'2.5.10' > '2.5.9'）。
 * 用途单一：发布顺序自检——前端跑到了旧 Worker 前面时给出提示。
 * 任一版本号缺失或格式不对，一律返回 false（宁可不提示，也不要误报）。
 */
export function isVersionAhead(candidate, baseline) {
    const parse = (value) => {
        const matched = String(value == null ? '' : value).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
        return matched ? [Number(matched[1]), Number(matched[2]), Number(matched[3])] : null;
    };
    const a = parse(candidate);
    const b = parse(baseline);
    if (!a || !b) return false;
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i];
    }
    return false;
}
