/**
 * Onde Assistir BR — JustWatch relay on Cloudflare's free tier.
 *
 * Why it exists: apis.justwatch.com answers fine server-to-server, but it runs a CORS
 * origin allowlist covering only *.justwatch.com and localhost. A page on github.io
 * gets no Access-Control-Allow-Origin, so the browser blocks the read. Crucially it
 * DOES allow localhost — so calling JustWatch directly works in local dev and breaks
 * only once deployed. This relay is the fix.
 *
 * Caching note: caches.default is zone-scoped and is a silent no-op on *.workers.dev,
 * so we deliberately do NOT use it. Real caching happens on the device (IndexedDB),
 * plus a small per-isolate memo that absorbs bursts for free.
 *
 * Setup (dashboard only, no CLI, free plan):
 *   Workers & Pages -> Create -> Worker -> paste this -> Deploy.
 * Only needed if the sandboxed bridge ever stops working. Then set RELAY in app.js to the resulting https://<name>.<sub>.workers.dev URL.
 */

const ALLOWED_ORIGINS = [
  'https://vergarac.github.io',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
];

// Only these operations are relayed, so the worker can never become an open proxy.
const ALLOWED_OPS = new Set(['SearchTitles', 'GetPopular', 'GetTitleOffers', 'GetPackages']);

const TTL_MS = { SearchTitles: 36e5, GetTitleOffers: 216e5, GetPackages: 6048e5, GetPopular: 216e5 };
const MAX_BODY = 8000;

// Per-isolate memo. Not a real cache — it just absorbs repeat hits while an isolate
// is warm, which is enough to keep a single user far inside the free quota.
const memo = new Map();

function cors(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(obj, status, origin, extra) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(origin), ...(extra || {}) },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, origin);

    const raw = await request.text();
    if (raw.length > MAX_BODY) return json({ error: 'body too large' }, 413, origin);

    let body;
    try { body = JSON.parse(raw); } catch { return json({ error: 'bad json' }, 400, origin); }

    const op = body.operationName;
    if (!ALLOWED_OPS.has(op)) return json({ error: 'operation not allowed' }, 403, origin);

    const key = op + ':' + JSON.stringify(body.variables || {});
    const hit = memo.get(key);
    if (hit && hit.until > Date.now()) {
      return new Response(hit.text, {
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Relay-Cache': 'HIT', ...cors(origin) },
      });
    }

    let upstream;
    try {
      upstream = await fetch('https://apis.justwatch.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; OndeAssistirBR/1.0)' },
        body: raw,
      });
    } catch (e) {
      return json({ error: 'upstream unreachable', detail: String(e) }, 502, origin);
    }

    const text = await upstream.text();
    if (upstream.ok) {
      if (memo.size > 400) memo.clear();
      memo.set(key, { text, until: Date.now() + (TTL_MS[op] || 36e5) });
    }

    // max-age lets the browser and the service worker do the caching that
    // caches.default cannot do on a workers.dev hostname.
    const ttlSec = Math.floor((TTL_MS[op] || 36e5) / 1000);
    return new Response(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSec}`,
        'X-Relay-Cache': 'MISS',
        ...cors(origin),
      },
    });
  },
};
