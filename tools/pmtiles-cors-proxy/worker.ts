// Cloudflare Worker — CORS proxy for protomaps demo bucket.
//
// Why this exists: the X-GIS playground's pmtiles_* demos point at
// `https://demo-bucket.protomaps.com/v4.pmtiles`, the canonical
// daily protomaps v4 world basemap. That bucket explicitly rejects
// cross-origin requests (Tigris OS returns 403 on OPTIONS preflight
// with an Origin header), so the browser can't fetch the archive
// directly from `https://x-gis.github.io`. The dev server bypasses
// this with a Vite proxy; production needs an equivalent edge proxy.
//
// What it does:
//   * Forward GET/HEAD with the original Range header so PMTiles'
//     byte-range fetches work end-to-end.
//   * Answer the CORS preflight (OPTIONS) directly with permissive
//     headers — the upstream's 403 never reaches the browser.
//   * Add `Access-Control-Allow-Origin: *` to every response so the
//     browser surfaces the body to PMTiles.js.
//   * Use Cloudflare's edge cache (`cf.cacheTtl`) so repeat tile
//     fetches don't roundtrip to Tigris.
//
// Deploy: `wrangler deploy` from this directory. The deployed URL
// (e.g. `https://x-gis-pmtiles-proxy.<account>.workers.dev`) goes
// into `PROD_PMTILES_PROXY_BASE` in `playground/src/demos.ts`.

const UPSTREAM_ORIGIN = 'https://demo-bucket.protomaps.com'

// Edge cache TTL in seconds. PMTiles archives are immutable per
// version (filename includes the build date for daily basemaps), so
// 24 h is conservative — adjust if you publish a mutable URL.
const CACHE_TTL_SECONDS = 86_400

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'range, if-match, if-none-match, if-range',
  'Access-Control-Expose-Headers': 'content-length, content-range, accept-ranges, etag, last-modified',
  'Access-Control-Max-Age': '86400',
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    // ── CORS preflight ──
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    // PMTiles only fetches with GET (and occasionally HEAD for
    // header-only probes). Anything else gets bounced — we don't
    // want this proxy used for arbitrary upstream writes.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', {
        status: 405,
        headers: { ...CORS_HEADERS, 'Allow': 'GET, HEAD, OPTIONS' },
      })
    }

    // Forward path + query verbatim. Strip leading slash from
    // pathname so `concat` produces a well-formed URL.
    const target = `${UPSTREAM_ORIGIN}${url.pathname}${url.search}`

    // Forward only the headers that matter for byte-range fetches.
    // Stripping everything else keeps the upstream's auth/cookie
    // surface clean and the response cacheable.
    const upstreamHeaders = new Headers()
    for (const name of ['range', 'if-match', 'if-none-match', 'if-range']) {
      const v = request.headers.get(name)
      if (v) upstreamHeaders.set(name, v)
    }

    const upstream = await fetch(target, {
      method: request.method,
      headers: upstreamHeaders,
      cf: {
        cacheTtl: CACHE_TTL_SECONDS,
        cacheEverything: true,
      },
    })

    // Re-emit the response with CORS headers stamped on. Use the
    // original status (esp. 206 Partial Content for Range hits) and
    // the original body stream so PMTiles' incremental parser sees
    // the bytes it asked for.
    const out = new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
    for (const [k, v] of Object.entries(CORS_HEADERS)) {
      out.headers.set(k, v)
    }
    return out
  },
}
