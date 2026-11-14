// Cloudflare Pages Function: same-origin POST /api/chat
// Deploy together with index.html (drag the whole folder into Pages, or `wrangler pages deploy`).
//
// KEY HANDLING - two supported modes, the key is NEVER stored in this repository:
//   1. Server key  : set a Production environment variable SEARCH_API_KEY = your GLM key.
//   2. Personal key: the browser sends its own key in the `x-glm-key` header. That key is stored
//                    on the user's device encrypted (AES-GCM + PBKDF2) and takes precedence.
// The server key is used whenever the request does not carry a personal one.
const UPSTREAM = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL = 'GLM-4-Flash';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-glm-key'
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  const personal = (request.headers.get('x-glm-key') || '').trim();
  const serverKey = (env.SEARCH_API_KEY || env.SEARCH_KEY || '').trim();
  const key = personal || serverKey;

  if (!key) {
    return new Response(
      JSON.stringify({ error: { message: 'No API key. Set the SEARCH_API_KEY environment variable on the Pages project, or store a personal key in Settings.' } }),
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
