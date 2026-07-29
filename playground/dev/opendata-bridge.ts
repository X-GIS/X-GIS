// ═══ The open-data bridge — one CORS front for the public datasets the demos stream ═══
//
// The AWS Open Data Registry buckets (`noaa-s111-pds`, `noaa-s102-pds`, …) serve real data
// over plain HTTP Range but set NO `Access-Control-Allow-Origin`, so a browser `fetch` from
// the playground origin is CORS-blocked. This is the bridge that fixes that — the same role
// `/pmtiles-proxy` plays for the protomaps bucket — and it is deliberately named for the
// SCOPE rather than for the first dataset that needed it: it fronts AWS Open Data today and
// is where any other open-data origin lands when one arrives.
//
// ONE PREFIX, `/opendata/`. Everything hangs off it, and that is structural rather than
// tidy: the previous scheme had `/noaa/` and `/noaa-s111/` and then `/noaa-s102/`, matched
// against a hand-maintained prefix LIST in the dev middleware, and adding the third product
// silently fell through to vite's SPA fallback — a catalogue fetch that got `index.html`
// with a 200. A route table that must be updated in two places will be wrong in one of them.
// With a single prefix there is nothing to keep in sync.
//
//   /opendata/s3/<bucket>/<key…>[?query]  — passthrough to an ALLOWLISTED AWS Open Data
//                                           bucket: an object GET (Range preserved) OR an S3
//                                           LIST (`?list-type=2&prefix=…`), so a client can
//                                           resolve the newest key for any dataset itself.
//   /opendata/s111/catalog.json           — SYNTHESISED: a STAC ItemCollection of the S-111
//                                           cells with their domain envelopes, so a
//                                           `type: coverage` source can name it and let the
//                                           ENGINE own viewport residency (#1453).
//   /opendata/s111/latest.h5              — convenience: newest CBOFS (Chesapeake) cell.
//   /opendata/s111/latest/<model>.h5      — convenience: newest cell for ANY S-111 model
//                                           (dbofs, gomofs, ngofs2, sfbofs, tbofs, wcofs, …).
//   /opendata/s102/catalog.json           — SYNTHESISED: NOAA's own S-100 Exchange Catalogue
//                                           (`_CATALOG/CATALOG.XML`, 4313 cells) translated to
//                                           STAC, so the browser reads ~1 MB of JSON rather
//                                           than 19 MB of XML for a bbox lookup (#1453).
//   /opendata/s102/cells/<key…>           — the cells those catalogue hrefs resolve to.
//
// The product namespaces (`s111/`, `s102/`) exist because a synthesised catalogue's asset
// hrefs are RELATIVE, so the cells must live in the catalogue's own DIRECTORY — see the two
// catalogue modules for why relative is load-bearing.
//
// This is DEV TOOLING (never bundled into the library); the production static site rewrites
// `/opendata/` to the same-contract Cloudflare Worker (`opendata-bridge-worker.ts`) — see
// playground/src/demos/loader.ts and docs/api/noaa-coverage-recipes.md.

import type { Connect } from 'vite'
import { s111CatalogueDocument } from './s111-catalogue'
import { s102CatalogueCached } from './s102-catalogue'

type FetchImpl = typeof globalThis.fetch

/** ═══ The allowlist ═══
 *
 *  A REGISTRY, not a pattern. `/opendata/s3/<bucket>/…` can name any bucket in the world, so
 *  the only thing standing between this bridge and being an open proxy — one anyone could
 *  borrow to launder S3 bandwidth through the x-gis account — is this list. The previous
 *  `noaa-*` glob worked only because the scope was one publisher; AWS Open Data is thousands
 *  of publishers with no shared naming, so a glob would either admit everything or admit the
 *  wrong things.
 *
 *  Adding a dataset is one line here plus a worker redeploy, and the redeploy is not on
 *  anyone's memory: `scripts/check-opendata-bridge.ts` reads the routes the shipped demos
 *  declare and fails the deploy when the live bridge does not serve one. */
const AWS_OPEN_DATA_BUCKETS = new Set([
  'noaa-s111-pds', // S-111 surface currents (IHO S-100)
  'noaa-s102-pds', // S-102 bathymetric surface (IHO S-100)
])

/** An AWS Open Data bucket's anonymous HTTPS origin. */
const s3Origin = (bucket: string): string => `https://${bucket}.s3.amazonaws.com`

const S111_BUCKET = s3Origin('noaa-s111-pds')
const S102_BUCKET = s3Origin('noaa-s102-pds')

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
      'content-range, content-length, accept-ranges, etag, x-opendata-key, cf-cache-status',
  }
}

/** List the immediate child `CommonPrefixes` (folder names) under `prefix`. */
async function listPrefixes(base: string, prefix: string, f: FetchImpl): Promise<string[]> {
  const res = await f(`${base}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`)
  const xml = await res.text()
  const out: string[] = []
  for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) {
    const seg = m[1]!.slice(prefix.length).replace(/\/$/, '')
    if (seg) out.push(seg)
  }
  return out
}

/** List object keys under `prefix` (no delimiter — leaf objects). */
async function listKeys(base: string, prefix: string, f: FetchImpl): Promise<string[]> {
  const res = await f(`${base}/?list-type=2&prefix=${encodeURIComponent(prefix)}`)
  const xml = await res.text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!)
}

const maxOf = (xs: string[]): string | undefined =>
  xs.length ? xs.slice().sort().pop() : undefined

/** Resolve the newest S-111 regional cell for a forecast model by walking the date
 *  tree newest-first (S3 lists lexicographically, so the latest is the tail). Not every
 *  cycle publishes a `regional/` folder, so try each recent hour — then the previous
 *  day — until an `.h5` cell is found. Model-agnostic (cbofs, dbofs, gomofs, …): it
 *  takes the newest `.h5` under the cycle's `dcf2/regional/`, whatever its cell name. */
export async function resolveLatestS111(model: string, f: FetchImpl = fetch): Promise<string> {
  const base = `ed1.0.1/model_forecast_guidance/${model}`
  const year = maxOf(await listPrefixes(S111_BUCKET, `${base}/`, f))
  if (!year) throw new Error(`no S-111 year folders for model "${model}"`)
  const month = maxOf(await listPrefixes(S111_BUCKET, `${base}/${year}/`, f))
  if (!month) throw new Error(`no S-111 month folders for model "${model}"`)

  const days = (await listPrefixes(S111_BUCKET, `${base}/${year}/${month}/`, f)).sort().reverse()
  for (const day of days.slice(0, 2)) {
    const dayPrefix = `${base}/${year}/${month}/${day}/`
    const hours = (await listPrefixes(S111_BUCKET, dayPrefix, f)).sort().reverse()
    for (const hour of hours) {
      const cells = (await listKeys(S111_BUCKET, `${dayPrefix}${hour}/dcf2/regional/`, f))
        .filter((k) => k.endsWith('.h5'))
        .sort()
      if (cells.length) return cells[cells.length - 1]!
    }
  }
  throw new Error(`no ${model} S-111 regional cell in the two most-recent days`)
}

/** Back-compat alias — the CBOFS (Chesapeake) newest cell, the `s111_live` demo's default. */
export const resolveLatestCbofsKey = (f: FetchImpl = fetch): Promise<string> =>
  resolveLatestS111('cbofs', f)

/** Per-model memo of the resolved newest cell. Streaming ONE cell drives a BURST of range
 *  requests — the HDF5 reader walks superblock → b-tree → chunks in ~13 GETs, and EACH one
 *  hits `resolveTarget`, so without this every request re-walked the S3 date tree (~5 serial
 *  LISTs): one load paid ~13× the resolution cost (~1 min observed). Caching the in-flight
 *  PROMISE also collapses a concurrent burst into ONE walk. The TTL is short (cells publish
 *  ~every 6 h) so `latest` still rolls forward as new cycles land. Module scope, so it
 *  survives across requests in BOTH the long-lived vite dev process AND a warm Cloudflare
 *  isolate — one authority, transport-agnostic (no Worker-specific Cache API). */
const LATEST_TTL_MS = 5 * 60_000
const latestCache = new Map<string, { at: number; p: Promise<string> }>()

/** `resolveLatestS111` behind the burst memo above. A rejected walk is evicted (never a
 *  cached failure) so the next request retries the resolution cleanly. */
export function resolveLatestS111Cached(model: string, f: FetchImpl = fetch): Promise<string> {
  const now = Date.now()
  const hit = latestCache.get(model)
  if (hit && now - hit.at < LATEST_TTL_MS) return hit.p
  const entry = { at: now } as { at: number; p: Promise<string> }
  entry.p = resolveLatestS111(model, f).catch((err: unknown) => {
    if (latestCache.get(model) === entry) latestCache.delete(model)
    throw err
  })
  latestCache.set(model, entry)
  return entry.p
}

const STREAM_HEADERS = ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag']

function errorResponse(status: number, message: string, origin: string | null): Response {
  return new Response(`opendata bridge: ${message}`, {
    status,
    headers: { 'content-type': 'text/plain', ...corsHeaders(origin) },
  })
}

/** Resolve an `/opendata/…` request path (prefix already stripped) to the upstream URL + the
 *  key we serve. */
async function resolveTarget(
  path: string,
  search: string,
  origin: string | null,
  f: FetchImpl,
): Promise<{ url: string; key: string } | Response> {
  const q = search ? `?${search}` : ''
  // S-111 "latest" convenience — CBOFS by default, any model via /latest/<model>.h5.
  if (path === 's111/latest.h5' || path.startsWith('s111/latest/')) {
    const model =
      path === 's111/latest.h5' ? 'cbofs' : path.slice('s111/latest/'.length).replace(/\.h5$/, '')
    if (!/^[a-z0-9_]+$/.test(model)) return errorResponse(400, `bad model "${model}"`, origin)
    const key = await resolveLatestS111Cached(model, f)
    return { url: `${S111_BUCKET}/${key}`, key }
  }
  // The S-102 catalogue's asset hrefs are `cells/<key>` relative to `/opendata/s102/catalog.json`,
  // so they arrive here as `s102/cells/<key>` — the sibling passthrough that keeps those hrefs
  // RELATIVE (and therefore origin-following, dev and prod alike).
  if (path.startsWith('s102/cells/')) {
    const key = path.slice('s102/cells/'.length)
    return { url: `${S102_BUCKET}/${key}${q}`, key }
  }
  // General passthrough: /opendata/s3/<bucket>/<key> — any allowlisted AWS Open Data bucket,
  // object or LIST.
  if (path.startsWith('s3/')) {
    const rest = path.slice('s3/'.length)
    const slash = rest.indexOf('/')
    const bucket = slash === -1 ? rest : rest.slice(0, slash)
    const key = slash === -1 ? '' : rest.slice(slash + 1)
    if (!AWS_OPEN_DATA_BUCKETS.has(bucket))
      return errorResponse(403, `bucket not allowed: "${bucket}"`, origin)
    return { url: `${s3Origin(bucket)}/${key}${q}`, key: `${bucket}/${key}` }
  }
  return errorResponse(404, `unknown route "${path}"`, origin)
}

/** The portable core: turn an `/opendata/…` request (full path + query) into a CORS-open web
 *  `Response` streaming the upstream object. Web-standard in/out, so the SAME function backs
 *  both the vite dev middleware (below) and the production Cloudflare Worker
 *  (`opendata-bridge-worker.ts`) — one authority, no drift (CLAUDE.md §12). `fetchImpl` is
 *  injectable so the logic is testable off a working transport. */
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
    // The S-111 cell CATALOGUE (#1453) — SYNTHESISED here, not proxied, so it is handled
    // before `resolveTarget` (which only ever maps a path to an upstream object). A coverage
    // source pointed at this URL lets the ENGINE own viewport residency; the NOAA-specific
    // `bbox → cell` knowledge stays on this side of the wire, where it belongs.
    if (path === 's111/catalog.json') {
      return new Response(JSON.stringify(s111CatalogueDocument()), {
        headers: {
          ...corsHeaders(origin),
          'content-type': 'application/geo+json',
          // Short, like the `latest` memo: the document is static but its hrefs resolve
          // through `latest/`, so nothing here goes stale — this only bounds a redeploy.
          'cache-control': 'public, max-age=300',
        },
      })
    }
    // The S-102 catalogue is NOAA's own — the IHO S-100 Exchange Catalogue published at
    // `_CATALOG/CATALOG.XML` — translated to STAC here so the browser fetches ~1 MB of JSON
    // instead of 19 MB of XML for a bbox lookup, and so the engine keeps ONE catalogue format
    // (see s102-catalogue.ts for why that is inside ADR-0010 rather than against it).
    if (path === 's102/catalog.json') {
      return new Response(JSON.stringify(await s102CatalogueCached(fetchImpl)), {
        headers: {
          ...corsHeaders(origin),
          'content-type': 'application/geo+json',
          // An hour, matching the memo: the source is re-issued per edition, not per request.
          'cache-control': 'public, max-age=3600',
        },
      })
    }
    const target = await resolveTarget(path, search, origin, fetchImpl)
    if (target instanceof Response) return target
    // Edge-cache the upstream fetch: `target.url` is an IMMUTABLE resolved key (the `latest`
    // → key resolution is memoized above), so Cloudflare can serve a reload / another
    // viewer's identical range from its edge instead of round-tripping to S3 — the dominant
    // REPEAT-load cost once `resolveLatestS111Cached` removed the redundant walks. `cf` is a
    // Worker-only hint: node/undici (the dev middleware) and the injected test fetch ignore
    // the unknown init key, so it stays one transport-agnostic authority.
    const upstream = await fetchImpl(target.url, {
      headers: range ? { Range: range } : undefined,
      cf: { cacheEverything: true, cacheTtl: 1800 },
    } as RequestInit)
    const headers = new Headers({ ...corsHeaders(origin), 'x-opendata-key': target.key })
    for (const h of [...STREAM_HEADERS, 'cf-cache-status']) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    return errorResponse(502, (err as Error).message, origin)
  }
}

/** A connect middleware bridging `/opendata/*` to the open-data origins with CORS — the vite
 *  dev-server adapter over `handleOpenData`. One prefix, so this matcher can never fall out of
 *  step with the route table the way a list of prefixes did. */
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
