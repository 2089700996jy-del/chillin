export async function onRequest(context) {
    const url = new URL(context.request.url);
    // Extract filename from URL (e.g. abc.png)
    const segments = url.pathname.split('/');
    const fileName = segments[segments.length - 1];
    
    if (!fileName || fileName === 'file') {
        return new Response('File Not Found', { status: 404 });
    }
    
    const targetUrl = `https://telegra.ph/file/${fileName}`;
    
    try {
        const response = await fetch(targetUrl);
        if (!response.ok) {
            return new Response('Not Found', { status: 404 });
        }
        
        // Return response with original content headers (images/videos etc.)
        const newHeaders = new Headers(response.headers);
        // Ensure browser caching is allowed to reduce bandwidth/latency
        newHeaders.set('Cache-Control', 'public, max-age=31536000');
        
        return new Response(response.body, {
            status: response.status,
            headers: newHeaders
        });
    } catch (err) {
        return new Response('Proxy Error', { status: 500 });
    }
}
