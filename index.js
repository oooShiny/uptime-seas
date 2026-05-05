/**
 * Cloudflare Worker — CORS proxy for Statuspage.io APIs.
 *
 * Accepts: GET /?url=<encoded-statuspage-url>
 * Returns: upstream JSON with Access-Control-Allow-Origin: *
 *
 * Only whitelisted domains are proxied to prevent open-relay abuse.
 * Responses are edge-cached for 60 seconds.
 */

const ALLOWED_HOSTS = new Set([
  'status.openai.com',
  'status.anthropic.com',
  'www.githubstatus.com',
  'www.vercel-status.com',
  'discordstatus.com',
  'www.cloudflarestatus.com',
  'status.zoom.us',
  'status.atlassian.com',
  'status.stability.ai',
  'status.elevenlabs.io',
  'groqstatus.com',
  'status.cohere.com',
  'status.deepseek.com',
  'status.heygen.com',
]);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const CACHE_TTL = 60;

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'GET') {
      return jsonError('Method not allowed', 405);
    }

    const { searchParams } = new URL(request.url);
    const targetUrl = searchParams.get('url');

    if (!targetUrl) {
      return jsonError('Missing ?url= parameter', 400);
    }

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return jsonError('Invalid URL', 400);
    }

    if (!ALLOWED_HOSTS.has(parsed.hostname)) {
      return jsonError(`Host not allowed: ${parsed.hostname}`, 403);
    }

    if (!parsed.pathname.startsWith('/api/')) {
      return jsonError('Only /api/* paths are allowed', 403);
    }

    try {
      const upstream = await fetch(targetUrl, {
        headers: { 'User-Agent': 'uptime-seas-proxy/1.0' },
        cf: { cacheTtl: CACHE_TTL, cacheEverything: true },
      });

      const body = await upstream.arrayBuffer();

      return new Response(body, {
        status: upstream.status,
        headers: {
          ...CORS_HEADERS,
          'Content-Type': upstream.headers.get('Content-Type') || 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
          'X-Upstream-Status': String(upstream.status),
        },
      });
    } catch (err) {
      return jsonError(`Upstream fetch failed: ${err.message}`, 502);
    }
  },
};

function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
