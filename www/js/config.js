/** Shared runtime endpoints (kept tiny to avoid circular imports). */
export const CLOUD_WORKER_BASE = 'https://chillin-api.2089700996jy.workers.dev';

export function resolveApiBase() {
    if (typeof CHILLIN_API_URL !== 'undefined' && CHILLIN_API_URL) {
        return CHILLIN_API_URL;
    }
    if (
        window.location.protocol === 'file:'
        || window.location.hostname === 'localhost'
        || window.location.hostname === '127.0.0.1'
    ) {
        return 'https://chillin-bfc.pages.dev';
    }
    // Same-origin Pages Function proxy → Worker
    return '';
}
