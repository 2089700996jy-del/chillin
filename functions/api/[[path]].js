export async function onRequest(context) {
    const url = new URL(context.request.url);
    const targetUrl = new URL(url.pathname + url.search, 'https://chillin-api.2089700996jy.workers.dev');

    const headers = new Headers(context.request.headers);
    // Pages → Worker：去掉宿主 Host，避免部分边缘节点转发异常
    headers.delete('host');
    headers.set('Host', 'chillin-api.2089700996jy.workers.dev');

    const init = {
        method: context.request.method,
        headers,
        redirect: 'manual',
    };

    if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
        init.body = context.request.body;
        // Cloudflare Workers fetch 流式 body 需要 duplex
        init.duplex = 'half';
    }

    try {
        return await fetch(targetUrl.toString(), init);
    } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error: ' + (err && err.message ? err.message : 'unknown') }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
