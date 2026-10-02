export async function onRequest(context) {
    const url = new URL(context.request.url);
    const targetUrl = new URL(url.pathname + url.search, 'https://chillin-api.2089700996jy.workers.dev');

    const headers = new Headers(context.request.headers);
    // Pages → Worker：去掉宿主 Host，避免部分边缘节点转发异常
    headers.delete('host');
    headers.set('Host', 'chillin-api.2089700996jy.workers.dev');

    // 真实客户端 IP 透传：跨 Worker 子请求时 CF-Connecting-IP 会被重写为边缘地址，
    // 导致后端限流退化成「全局一个桶」。这里显式带回原 IP，并附上共享密钥供后端校验来源。
    // 未配置密钥时一律清除这两个头，防止客户端伪造直连 Worker 绕过限流。
    const clientIp = context.request.headers.get('CF-Connecting-IP');
    const proxySecret = context.env && context.env.PROXY_SHARED_SECRET;
    if (clientIp && proxySecret) {
        headers.set('X-Chillin-Client-IP', clientIp.trim());
        headers.set('X-Chillin-Proxy-Token', proxySecret);
    } else {
        headers.delete('X-Chillin-Client-IP');
        headers.delete('X-Chillin-Proxy-Token');
    }

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
        return new Response(JSON.stringify({ error: '网关连接异常，请稍后重试' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' },
        });
    }
}
