export async function onRequest(context) {
    if (context.request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }
    
    try {
        // Forward the multipart request to telegra.ph
        const response = await fetch('https://telegra.ph/upload', {
            method: 'POST',
            body: context.request.body,
            headers: {
                'Content-Type': context.request.headers.get('Content-Type')
            }
        });
        
        if (!response.ok) {
            return new Response(JSON.stringify({ error: 'Upload failed on upstream' }), {
                status: response.status,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        const data = await response.json();
        if (data.error) {
            return new Response(JSON.stringify({ error: data.error }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        
        // Rewrite Telegraph relative path /file/xxx to our proxy path /api/file/xxx
        const result = data.map(item => {
            const fileName = item.src.replace('/file/', '');
            return {
                src: `/api/file/${fileName}`
            };
        });
        
        return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
