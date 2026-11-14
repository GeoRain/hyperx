'use strict';

/**
 * Google 1993/1998 AI Search - local gateway
 * Zero dependencies. Node.js 16+.
 *
 * Why this exists:
 *   open.bigmodel.cn answers POST with an Access-Control-Allow-Origin header, but its
 *   OPTIONS preflight returns no CORS headers at all. A browser request carrying an
 *   Authorization header is therefore always blocked. Keeping the key server-side and
 *   proxying same-origin requests is both functional and safer than inlining the key
 *   into the page.
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const INDEX_PATH = path.join(ROOT, 'index.html');
const MAX_BODY = 64 * 1024;

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    console.warn('[config] config.json not found - falling back to environment variables and the in-app personal key.');
    return {};
  }
}

const CFG = loadConfig();
const API_KEY = String(process.env.SEARCH_API_KEY || process.env.GLM_API_KEY || CFG.apiKey || '').trim();
const MODEL = String(CFG.model || 'GLM-4-Flash');
const HOST = String(CFG.host || '127.0.0.1');
const PORT = Number(process.env.PORT || CFG.port || 8080);

let UPSTREAM;
try {
  const base = String(CFG.baseUrl || '').endsWith('/') ? CFG.baseUrl : CFG.baseUrl + '/';
  UPSTREAM = new URL('chat/completions', base);
  if (UPSTREAM.protocol !== 'https:') throw new Error('baseUrl must be https');
} catch (err) {
  console.error('[config] Invalid baseUrl: ' + err.message);
  process.exit(1);
}

if (!API_KEY) {
  console.warn('[config] No server-side API key. Searches will use the personal key stored in Settings,');
  console.warn('[config] or set SEARCH_API_KEY / GLM_API_KEY before starting.');
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-glm-key'
};

function sendJSON(res, status, obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...CORS_HEADERS
  });
  res.end(buf);
}

function sendText(res, status, text) {
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...CORS_HEADERS
  });
  res.end(buf);
}

function sanitizeMessages(input) {
  if (!Array.isArray(input)) throw new Error('messages must be an array');
  const out = [];
  let total = 0;
  for (const item of input.slice(-8)) {
    if (!item || typeof item.content !== 'string') continue;
    const role = ['system', 'user', 'assistant'].includes(item.role) ? item.role : 'user';
    const content = item.content.slice(0, 8000);
    total += content.length;
    if (total > 24000) break;
    out.push({ role, content });
  }
  if (out.length === 0) throw new Error('messages must contain at least one text message');
  return out;
}

function buildPayload(data) {
  const temperature = Number(data.temperature);
  const maxTokens = Number(data.max_tokens);
  return {
    model: MODEL,
    messages: sanitizeMessages(data.messages),
    stream: data.stream === true,
    temperature: Number.isFinite(temperature) ? Math.min(1, Math.max(0, temperature)) : 0.7,
    max_tokens: Number.isFinite(maxTokens) ? Math.min(2048, Math.max(32, Math.floor(maxTokens))) : 1024
  };
}

function handleChat(req, res) {
  // Key resolution order: personal key sent by the browser (x-glm-key) > server-side key.
  const personal = String(req.headers['x-glm-key'] || '').trim();
  const apiKey = personal || API_KEY;
  if (!apiKey) {
    return sendJSON(res, 500, {
      error: {
        message: 'No API key available. Set SEARCH_API_KEY / GLM_API_KEY, add config.json, or store a personal key in Settings.',
        code: 'no_api_key'
      }
    });
  }

  let raw = '';
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    raw += chunk;
    if (raw.length > MAX_BODY) {
      aborted = true;
      sendJSON(res, 413, { error: { message: 'Request body too large.', code: 'payload_too_large' } });
      req.destroy();
    }
  });

  req.on('end', () => {
    if (aborted) return;

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return sendJSON(res, 400, { error: { message: 'Malformed JSON body.', code: 'bad_json' } });
    }

    let payload;
    try {
      payload = buildPayload(data);
    } catch (err) {
      return sendJSON(res, 400, { error: { message: err.message, code: 'bad_request' } });
    }

    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');

    let settled = false;
    const fail = (status, message, code) => {
      if (settled) return;
      settled = true;
      if (!res.headersSent) sendJSON(res, status, { error: { message, code } });
      else {
        // The stream already started: emit a terminal SSE error event so the
        // browser can render a proper error instead of a truncated answer.
        try {
          res.write('data: ' + JSON.stringify({ error: { message, code } }) + '\n\n');
          res.end();
        } catch { /* client already gone */ }
      }
    };

    const upReq = https.request({
      hostname: UPSTREAM.hostname,
      port: UPSTREAM.port || 443,
      path: UPSTREAM.pathname + UPSTREAM.search,
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Content-Length': bodyBuf.length,
        'Accept': payload.stream ? 'text/event-stream' : 'application/json'
      },
      timeout: 90000
    }, (upRes) => {
      if (upRes.statusCode !== 200) {
        let errBody = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { if (errBody.length < 2000) errBody += c; });
        upRes.on('end', () => {
          let detail = errBody;
          try {
            const parsed = JSON.parse(errBody);
            detail = (parsed.error && (parsed.error.message || parsed.error.code)) || errBody;
          } catch { /* keep raw */ }
          fail(502, 'Upstream API returned HTTP ' + upRes.statusCode + ': ' + String(detail).slice(0, 400), 'upstream_' + upRes.statusCode);
        });
        return;
      }

      settled = true;
      if (payload.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Content-Type-Options': 'nosniff',
          ...CORS_HEADERS
        });
        upRes.pipe(res);
        upRes.on('end', () => { try { res.end(); } catch { /* noop */ } });
      } else {
        let buf = '';
        upRes.setEncoding('utf8');
        upRes.on('data', (c) => { buf += c; });
        upRes.on('end', () => {
          if (res.writableEnded) return;
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...CORS_HEADERS
          });
          res.end(buf);
        });
      }
    });

    upReq.on('timeout', () => upReq.destroy(new Error('Upstream timeout')));
    upReq.on('error', (err) => fail(502, 'Cannot reach upstream API: ' + err.message, 'upstream_unreachable'));
    res.on('close', () => { if (!res.writableEnded) upReq.destroy(); });

    upReq.write(bodyBuf);
    upReq.end();
  });

  req.on('error', () => { /* client disconnected */ });
}

const FAVICON = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" fill="#fff"/>' +
  '<text x="2" y="25" font-family="Georgia,serif" font-size="27" font-weight="bold" fill="#3366cc">G</text>' +
  '</svg>', 'utf8');

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/chat') return handleChat(req, res);

  if (req.method === 'OPTIONS' && pathname === '/api/chat') {
    res.writeHead(204, Object.assign({}, CORS_HEADERS, { 'Access-Control-Max-Age': '86400' }));
    return res.end();
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (pathname === '/' || pathname === '/index.html') {
      fs.readFile(INDEX_PATH, (err, buf) => {
        if (err) return sendText(res, 500, 'index.html is missing.');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff'
        });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
      return;
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      return res.end(req.method === 'HEAD' ? undefined : FAVICON);
    }
    if (pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, model: MODEL, upstream: UPSTREAM.host });
    }
  }

  sendText(res, 404, '404 Not Found\n\nThis page does not exist on this server.');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('[server] Port ' + PORT + ' is already in use. Set PORT=xxxx or edit config.json.');
  } else {
    console.error('[server] ' + err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = 'http://' + HOST + ':' + PORT + '/';
  console.log('');
  console.log('  HyperX AI Search (1993 / 1998 / 2025)');
  console.log('  ------------------------------------------');
  console.log('  Local URL : ' + url);
  console.log('  Model     : ' + MODEL);
  console.log('  Upstream  : ' + UPSTREAM.host);
  console.log('  Key       : ' + (API_KEY
    ? (process.env.SEARCH_API_KEY ? 'SEARCH_API_KEY env' : (process.env.GLM_API_KEY ? 'GLM_API_KEY env' : 'config.json'))
    : 'none (personal key from Settings only)'));
  console.log('  Stop      : Ctrl+C');
  console.log('');
  if (CFG.openBrowser !== false && !process.env.NO_OPEN) {
    try {
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    } catch { /* opening a browser is best-effort only */ }
  }
});
