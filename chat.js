// Cloudflare Pages Function: serves same-origin POST /api/chat
// Deploy together with index.html (drag the whole folder into Pages, or `wrangler pages deploy`).
// Set a Production environment variable named SEARCH_API_KEY = your GLM key in the Pages dashboard.
const UPSTREAM = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'GLM-4-Flash';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const key = env.SEARCH_API_KEY || env.SEARCH_KEY || 'PASTE_KEY_HERE';
  if (!key || key === 'PASTE_KEY_HERE') {
    return new Response(
      JSON.stringify({ error: { message: 'Missing SEARCH_API_KEY environment variable on the Pages project.' } }),
      { status: 500, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }) }
    );
  }

  let input;
  try { input = await request.json(); }
  catch (e) {
    return new Response(
      JSON.stringify({ error: { message: 'Bad JSON' } }),
      { status: 400, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }) }
    );
  }

  const messages = (input.messages || []).slice(-8).filter(m => m && typeof m.content === 'string');
  if (!messages.length) {
    return new Response(
      JSON.stringify({ error: { message: 'No messages' } }),
      { status: 400, headers: Object.assign({}, CORS, { 'Content-Type': 'application/json' }) }
    );
  }

  const payload = {
    model: MODEL,
    messages: messages,
    stream: !!input.stream,
    temperature: typeof input.temperature === 'number' ? Math.min(1, Math.max(0, input.temperature)) : 0.7,
    max_tokens: Math.min(2048, Math.max(32, Number(input.max_tokens) || 1024))
  };

  const upstream = await fetch(UPSTREAM, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
    body: JSON.stringify(payload)
  });

  const headers = new Headers(CORS);
  headers.set('Content-Type', upstream.headers.get('content-type') || 'application/json');
  headers.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers });
}
