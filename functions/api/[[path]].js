export async function onRequest(context) {
    const url = new URL(context.request.url);
    
    // 将目标地址重写为后端 Worker 地址
    const targetUrl = new URL(url.pathname + url.search, 'https://chillin-api.2089700996jy.workers.dev');
    
    // 复制请求
    const modifiedRequest = new Request(targetUrl, {
        method: context.request.method,
        headers: context.request.headers,
        body: context.request.method !== 'GET' && context.request.method !== 'HEAD' ? context.request.body : null,
        redirect: 'manual'
    });
    
    try {
        const response = await fetch(modifiedRequest);
        return response;
    } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error: ' + err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
