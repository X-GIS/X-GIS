// ═══ The open-data bridge — one CORS front for the public datasets the demos stream ═══
//
// Open-data publishers serve real data over plain HTTP Range but set no
// `Access-Control-Allow-Origin`, so a browser `fetch` from the playground origin is
// CORS-blocked. This is the bridge that fixes that — the same role `/pmtiles-proxy` plays for
// the protomaps bucket — and it is named for the SCOPE, not for the first dataset that needed
// it: AWS Open Data today, and open data anywhere as sources arrive.
//
// TWO ROUTES. Neither names a product:
//
//   /opendata/<host>/<path…>[?query]  — passthrough to an ALLOWLISTED host: an object GET
//                                       (Range preserved) or a LIST (`?list-type=2&prefix=…`).
//   /opendata/<id>.stac.json          — a SYNTHESISED STAC ItemCollection, so a `type: coverage`
//                                       source can name it and let the ENGINE own viewport
//                                       residency (#1453). The only route not backed by a host.
//
// The catalogue is a SIBLING of the host segment, not a child of a `stac/` directory, and that
// is load-bearing. Its asset hrefs are relative so they follow the document to whichever origin
// served it; from a `stac/` directory that would need `../<host>/<key>`, and
// `parseCoverageCatalogue` resolves a relative href by joining onto the base directory without
// collapsing `..` — so the engine would ask this bridge for `/opendata/stac/../<host>/…` and get
// a 404 off its own catalogue. As siblings the href is bare and no `..` can arise. A `.stac.json`
// suffix cannot collide with a host either: `.json` is not a TLD.
//
// WHY A BARE HOST rather than an `s3/<bucket>` sugar. The regional endpoint
// (`<bucket>.s3.<region>.amazonaws.com`) is the address an S3 object actually has — the
// region-less form answers a 307 for anything outside us-east-1, an extra round trip on every
// ranged read. Once the region is in the host, `s3/<bucket>` is an abbreviation for a host, and
// an abbreviation is not worth a second code path or a second allowlist shape. Seoul's open-data
// portal and a NOAA bucket now arrive through the identical route with the identical check.
//
// The route table was `/noaa/` + `/noaa-s111/` + `/noaa-s102/` matched against a hand-maintained
// prefix LIST, and the third product silently fell through to vite's SPA fallback — a catalogue
// fetch that got `index.html` with a 200. A route table that must be updated in two places will
// be wrong in one of them. There is nothing left to keep in sync.
//
// This is DEV TOOLING (never bundled into the library); the production static site rewrites
// `/opendata/` to the same-contract Cloudflare Worker (`opendata-bridge-worker.ts`) — see
// playground/src/demos/loader.ts and docs/api/noaa-coverage-recipes.md.

import type { Connect } from 'vite'
import { OPEN_DATA_HOSTS } from './opendata-hosts'
import { s111CatalogueCached } from './s111-catalogue'
import { s102CatalogueCached } from './s102-catalogue'

type FetchImpl = typeof globalThis.fetch

/** The synthesised catalogues, by the `<id>` in `/opendata/<id>.stac.json`.
 *
 *  A TABLE, not a branch per product: adding a catalogue is an entry here, and the routing code
 *  never learns another product name. Both builders are memoised in their own module. */
const CATALOGUE_SUFFIX = '.stac.json'
const CATALOGUES: Record<string, (f: FetchImpl) => Promise<unknown>> = {
  s111: s111CatalogueCached,
  s102: s102CatalogueCached,
}

/** CORS is LOCKED to the X-GIS site (plus localhost for a dev hitting the prod worker
 *  directly). This bridge exists to serve the X-GIS demos — not as an open CORS proxy
 *  anyone can borrow. A browser from any other origin is refused by the mismatched
 *  `Access-Control-Allow-Origin`. */
const ALLOWED_ORIGINS = new Set([
  'https://x-gis.github.io',
  'https://localhost:3000',
  'http://localhost:3000',
])
const DEFAULT_ORIGIN = 'https://x-gis.github.io'
function allowOrigin(origin: string | null): string {
  return origin && ALLOWED_ORIGINS.has(origin) ? origin : DEFAULT_ORIGIN
}
/** The CORS header set for a request from `origin` — the locked ACAO + `Vary: Origin`
 *  (so a cache can't serve one origin's grant to another) + the exposed range headers. */
export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': allowOrigin(origin),
    vary: 'origin',
    'access-control-expose-headers':
      'content-range, content-length, accept-ranges, etag, x-opendata-source, cf-cache-status',
  }
}

const STREAM_HEADERS = ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag']

function errorResponse(status: number, message: string, origin: string | null): Response {
  return new Response(`opendata bridge: ${message}`, {
    status,
    headers: { 'content-type': 'text/plain', ...corsHeaders(origin) },
  })
}

/** The portable core: turn an `/opendata/…` request (full path + query) into a CORS-open web
 *  `Response`. Web-standard in/out, so the SAME function backs both the vite dev middleware
 *  (below) and the production Cloudflare Worker (`opendata-bridge-worker.ts`) — one authority,
 *  no drift (CLAUDE.md §12). `fetchImpl` is injectable so the logic is testable off a working
 *  transport. */
export async function handleOpenData(
  reqUrl: string,
  range: string | null,
  origin: string | null = null,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  try {
    const [rawPath, search = ''] = reqUrl.split('?')
    const full = rawPath!.replace(/^\/+/, '')
    if (!full.startsWith('opendata/')) return errorResponse(404, `unknown route "${full}"`, origin)
    const path = full.slice('opendata/'.length)
    const slash = path.indexOf('/')
    const head = slash === -1 ? path : path.slice(0, slash)
    const rest = slash === -1 ? '' : path.slice(slash + 1)

    // ── The synthesised catalogues (#1453) ──
    // Handled before the passthrough because they are backed by no host: a coverage source
    // pointed at one lets the ENGINE own viewport residency, and the publisher-specific
    // `bbox → cell` knowledge stays on this side of the wire, where it belongs.
    if (head.endsWith(CATALOGUE_SUFFIX)) {
      const build = CATALOGUES[head.slice(0, -CATALOGUE_SUFFIX.length)]
      if (!build) return errorResponse(404, `no such catalogue "${head}"`, origin)
      return new Response(JSON.stringify(await build(fetchImpl)), {
        headers: {
          ...corsHeaders(origin),
          'content-type': 'application/geo+json',
          // Short, and matching the builders' own memo: an S-111 catalogue names the newest
          // published cycle, so it goes stale exactly as fast as that resolution does.
          'cache-control': 'public, max-age=300',
        },
      })
    }

    // ── The passthrough ──
    // EXACT host match against the allowlist, and the URL is built only AFTER the match — so a
    // hostile authority (`host@evil.com`, `host:8080`, `host.evil.com`) can never be reached,
    // because it is not the string that was allowed.
    if (!OPEN_DATA_HOSTS.has(head)) return errorResponse(403, `host not allowed: "${head}"`, origin)
    const url = `https://${head}/${rest}${search ? `?${search}` : ''}`

    // Edge-cache the upstream fetch: an open-data key is immutable (a re-issued cell gets a new
    // key, or the same key with a new ETag), so Cloudflare can serve a reload — or another
    // viewer's identical range — from its edge instead of round-tripping to the publisher. `cf`
    // is a Worker-only hint: node/undici (the dev middleware) and the injected test fetch ignore
    // the unknown init key, so this stays one transport-agnostic authority. It is inert unless
    // the worker's cache setting is on — see wrangler.toml's `[cache]`.
    const upstream = await fetchImpl(url, {
      headers: range ? { Range: range } : undefined,
      cf: { cacheEverything: true, cacheTtl: 1800 },
    } as RequestInit)
    const headers = new Headers({ ...corsHeaders(origin), 'x-opendata-source': `${head}/${rest}` })
    for (const h of [...STREAM_HEADERS, 'cf-cache-status']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    return errorResponse(502, (err as Error).message, origin)
  }
}

/** A connect middleware bridging `/opendata/*` with CORS — the vite dev-server adapter over
 *  `handleOpenData`. One prefix, so this matcher can never fall out of step with the route table
 *  the way a list of prefixes did. */
export function createOpenDataMiddleware(fetchImpl: FetchImpl = fetch): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/opendata/')) return next()
    void (async () => {
      const origin = (req.headers['origin'] as string | undefined) ?? null
      const web = await handleOpenData(url, req.headers['range'] ?? null, origin, fetchImpl)
      res.statusCode = web.status
      web.headers.forEach((v, k) => res.setHeader(k, v))
      res.end(new Uint8Array(await web.arrayBuffer()))
    })()
  }
}

/** Vite plugin form — registers the middleware on the dev server. */
export function openDataBridge() {
  return {
    name: 'opendata-bridge',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(createOpenDataMiddleware())
    },
  }
}
