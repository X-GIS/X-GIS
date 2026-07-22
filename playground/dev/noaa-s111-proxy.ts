// ═══ NOAA dev proxy — general CORS bridge to the NOAA Open-Data S3 buckets ═══
//
// NOAA's public S3 buckets (`noaa-s111-pds`, `noaa-s102-pds`, `noaa-oisst-pds`,
// `noaa-goes*`, …) serve real data over plain HTTP Range but set NO
// `Access-Control-Allow-Origin`, so a browser `fetch` from the playground origin is
// CORS-blocked. This is the local CORS bridge — the same role `/pmtiles-proxy` plays
// for the protomaps bucket — and it is DELIBERATELY GENERAL, not pinned to one
// product: point a `type: coverage` (or any) source at one of these paths.
//
//   /noaa/<bucket>/<key…>[?query]  — passthrough to any NOAA bucket (`noaa-*`): an
//                                    object GET (Range preserved) OR an S3 LIST
//                                    (`?list-type=2&prefix=…`), so a client can
//                                    resolve the newest key for ANY dataset itself.
//   /noaa-s111/latest.h5           — convenience: newest CBOFS (Chesapeake) S-111 cell.
//   /noaa-s111/latest/<model>.h5   — convenience: newest cell for ANY S-111 model
//                                    (dbofs, gomofs, ngofs2, sfbofs, tbofs, wcofs, …).
//   /noaa-s111/<key…>              — explicit noaa-s111-pds key passthrough.
//
// The bucket is allowlisted to the `noaa-*` naming (public read-only Open-Data buckets),
// so this is NOT an open proxy. This is DEV TOOLING (never bundled into the library); the
// production static site rewrites these paths to the same-contract Cloudflare Worker
// (`noaa-s111-worker.ts`) — see playground/src/demos/loader.ts and docs/recipes.

import type { Connect } from 'vite'

type FetchImpl = typeof globalThis.fetch

const S111_BUCKET = 'https://noaa-s111-pds.s3.amazonaws.com'
/** Allowlist: NOAA Open-Data buckets all begin `noaa-` (public, read-only, anonymous).
 *  Anything else is refused — this bridges NOAA data, it is not an open proxy. */
const NOAA_BUCKET_RE = /^noaa-[a-z0-9][a-z0-9.-]*$/

/** CORS is LOCKED to the X-GIS site (plus localhost for a dev hitting the prod worker
 *  directly). This worker exists to serve the X-GIS demos — not as an open CORS proxy
 *  anyone can borrow to launder NOAA bandwidth through the x-gis account. A browser from
 *  any other origin is refused by the mismatched `Access-Control-Allow-Origin`. */
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
      'content-range, content-length, accept-ranges, etag, x-noaa-key',
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

const STREAM_HEADERS = ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag']

function errorResponse(status: number, message: string, origin: string | null): Response {
  return new Response(`NOAA proxy: ${message}`, {
    status,
    headers: { 'content-type': 'text/plain', ...corsHeaders(origin) },
  })
}

/** Resolve a `/noaa…` request path to the upstream S3 URL + the key we serve. */
async function resolveTarget(
  path: string,
  search: string,
  origin: string | null,
  f: FetchImpl,
): Promise<{ url: string; key: string } | Response> {
  const q = search ? `?${search}` : ''
  // Back-compat: the pre-generalization prod rewrite STRIPPED the `/noaa-s111/` prefix,
  // so a hosted site built before this change sends a bare `latest.h5` / `latest/<model>.h5`.
  // Normalize those to the S-111 form so the worker serves both loader versions (no broken
  // window across the deploy). Harmless once every site build carries the prefix-preserving rewrite.
  if (path === 'latest.h5' || path.startsWith('latest/')) path = `noaa-s111/${path}`
  // S-111 "latest" convenience — CBOFS by default, any model via /latest/<model>.h5.
  if (path === 'noaa-s111/latest.h5' || path.startsWith('noaa-s111/latest/')) {
    const model =
      path === 'noaa-s111/latest.h5'
        ? 'cbofs'
        : path.slice('noaa-s111/latest/'.length).replace(/\.h5$/, '')
    if (!/^[a-z0-9_]+$/.test(model)) return errorResponse(400, `bad model "${model}"`, origin)
    const key = await resolveLatestS111(model, f)
    return { url: `${S111_BUCKET}/${key}`, key }
  }
  // Explicit noaa-s111-pds key passthrough (back-compat).
  if (path.startsWith('noaa-s111/')) {
    const key = path.slice('noaa-s111/'.length)
    return { url: `${S111_BUCKET}/${key}${q}`, key }
  }
  // General passthrough: /noaa/<bucket>/<key> — any allowlisted NOAA bucket, object or LIST.
  if (path.startsWith('noaa/')) {
    const rest = path.slice('noaa/'.length)
    const slash = rest.indexOf('/')
    const bucket = slash === -1 ? rest : rest.slice(0, slash)
    const key = slash === -1 ? '' : rest.slice(slash + 1)
    if (!NOAA_BUCKET_RE.test(bucket))
      return errorResponse(403, `bucket not allowed: "${bucket}"`, origin)
    return { url: `https://${bucket}.s3.amazonaws.com/${key}${q}`, key: `${bucket}/${key}` }
  }
  return errorResponse(404, `unknown route "${path}"`, origin)
}

/** The portable core: turn a `/noaa…` request (full path + query) into a CORS-open web
 *  `Response` streaming the S3 object. Web-standard in/out, so the SAME function backs
 *  both the vite dev middleware (below) and the production Cloudflare Worker
 *  (`noaa-s111-worker.ts`) — one authority, no drift (CLAUDE.md §12). `fetchImpl` is
 *  injectable so the logic is testable off a working transport. */
export async function handleNoaa(
  reqUrl: string,
  range: string | null,
  origin: string | null = null,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  try {
    const [rawPath, search = ''] = reqUrl.split('?')
    const path = rawPath!.replace(/^\/+/, '')
    const target = await resolveTarget(path, search, origin, fetchImpl)
    if (target instanceof Response) return target
    const upstream = await fetchImpl(target.url, { headers: range ? { Range: range } : undefined })
    const headers = new Headers({ ...corsHeaders(origin), 'x-noaa-key': target.key })
    for (const h of STREAM_HEADERS) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    return errorResponse(502, (err as Error).message, origin)
  }
}

/** A connect middleware bridging `/noaa/*` and `/noaa-s111/*` to the NOAA buckets with
 *  CORS — the vite dev-server adapter over `handleNoaa`. */
export function createNoaaMiddleware(fetchImpl: FetchImpl = fetch): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/noaa/') && !url.startsWith('/noaa-s111/')) return next()
    void (async () => {
      const origin = (req.headers['origin'] as string | undefined) ?? null
      const web = await handleNoaa(url, req.headers['range'] ?? null, origin, fetchImpl)
      res.statusCode = web.status
      web.headers.forEach((v, k) => res.setHeader(k, v))
      res.end(new Uint8Array(await web.arrayBuffer()))
    })()
  }
}

/** Vite plugin form — registers the middleware on the dev server. */
export function noaaProxy() {
  return {
    name: 'noaa-proxy',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(createNoaaMiddleware())
    },
  }
}
