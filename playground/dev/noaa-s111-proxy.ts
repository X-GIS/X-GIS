// ═══ NOAA S-111 dev proxy — CORS bridge to the NOAA Open-Data S3 bucket ═══
//
// The NOAA S-100 PDS bucket (`noaa-s111-pds.s3.amazonaws.com`) serves real S-111
// surface-current cells over plain HTTP Range, but sets NO `Access-Control-Allow-Origin`,
// so a browser `fetch` from the playground origin is CORS-blocked. This dev-server
// middleware is the local CORS bridge — the exact same role the `/pmtiles-proxy`
// entry plays for the protomaps demo bucket — with one extra job the pmtiles case
// didn't need: the bucket is a ROLLING WINDOW (old forecast cycles age out), so a
// hard-coded cell URL would 404 within days. `/noaa-s111/latest.h5` therefore RESOLVES
// the newest CBOFS (Chesapeake Bay) regional cell on each request and streams it, so
// the demo never rots. Any other `/noaa-s111/<key>` path is a plain range-preserving
// passthrough.
//
// This is DEV TOOLING (never bundled into the shipped library). The production static
// site rewrites `/noaa-s111/` to a CORS-open proxy that implements the same resolve +
// stream contract — see playground/src/demos/loader.ts and docs/recipes.

import type { Connect } from 'vite'

const BUCKET = 'https://noaa-s111-pds.s3.amazonaws.com'
const CBOFS = 'ed1.0.1/model_forecast_guidance/cbofs'

type FetchImpl = typeof globalThis.fetch

/** List the immediate child `CommonPrefixes` (folder names) under `prefix`. */
async function listPrefixes(prefix: string, f: FetchImpl): Promise<string[]> {
  const res = await f(`${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`)
  const xml = await res.text()
  const out: string[] = []
  for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) {
    const seg = m[1]!.slice(prefix.length).replace(/\/$/, '')
    if (seg) out.push(seg)
  }
  return out
}

/** List object keys under `prefix` (no delimiter — leaf objects). */
async function listKeys(prefix: string, f: FetchImpl): Promise<string[]> {
  const res = await f(`${BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}`)
  const xml = await res.text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!)
}

const maxOf = (xs: string[]): string | undefined =>
  xs.length ? xs.slice().sort().pop() : undefined

/** Resolve the newest CBOFS regional S-111 cell key by walking the date tree
 *  newest-first (S3 lists lexicographically, so the latest is the tail). Not every
 *  cycle publishes a `regional/` folder, so try each recent hour — then the previous
 *  day — until a `111US00_CBOFS_*.h5` cell is found. */
export async function resolveLatestCbofsKey(f: FetchImpl = fetch): Promise<string> {
  const year = maxOf(await listPrefixes(`${CBOFS}/`, f))
  if (!year) throw new Error('no CBOFS year folders')
  const month = maxOf(await listPrefixes(`${CBOFS}/${year}/`, f))
  if (!month) throw new Error('no CBOFS month folders')

  const days = (await listPrefixes(`${CBOFS}/${year}/${month}/`, f)).sort().reverse()
  for (const day of days.slice(0, 2)) {
    const dayPrefix = `${CBOFS}/${year}/${month}/${day}/`
    const hours = (await listPrefixes(dayPrefix, f)).sort().reverse()
    for (const hour of hours) {
      const keys = await listKeys(`${dayPrefix}${hour}/dcf2/regional/`, f)
      const cell = keys.find((k) => /111US00_CBOFS_\d+T\d+Z\.h5$/.test(k))
      if (cell) return cell
    }
  }
  throw new Error('no CBOFS regional cell found in the two most-recent days')
}

const STREAM_HEADERS = ['content-length', 'content-type', 'content-range', 'accept-ranges', 'etag']

/** The portable core: turn a `/noaa-s111` request (the path AFTER the prefix, e.g.
 *  `latest.h5` or a full cell key, plus an optional Range) into a CORS-open web
 *  `Response` streaming the S3 cell. Web-standard in/out, so the SAME function backs
 *  both the vite dev middleware (below) and the production Cloudflare Worker
 *  (`noaa-s111-worker.ts`) — one resolve+stream authority, no drift (CLAUDE.md §12).
 *  `fetchImpl` is injectable so the logic is testable off a working transport. */
export async function handleNoaaS111(
  pathAfterPrefix: string,
  range: string | null,
  fetchImpl: FetchImpl = fetch,
): Promise<Response> {
  try {
    const path = pathAfterPrefix.split('?')[0]!.replace(/^\//, '')
    const key = path === 'latest.h5' ? await resolveLatestCbofsKey(fetchImpl) : path
    const upstream = await fetchImpl(`${BUCKET}/${key}`, {
      headers: range ? { Range: range } : undefined,
    })
    const headers = new Headers({ 'access-control-allow-origin': '*', 'x-noaa-s111-key': key })
    for (const h of STREAM_HEADERS) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    return new Response(`NOAA S-111 proxy error: ${(err as Error).message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' },
    })
  }
}

/** A connect middleware bridging `/noaa-s111/*` to the NOAA S3 bucket with CORS —
 *  the vite dev-server adapter over `handleNoaaS111`. */
export function createNoaaS111Middleware(fetchImpl: FetchImpl = fetch): Connect.NextHandleFunction {
  return (req, res, next) => {
    const url = req.url ?? ''
    if (!url.startsWith('/noaa-s111/')) return next()
    void (async () => {
      const web = await handleNoaaS111(
        url.slice('/noaa-s111/'.length),
        req.headers['range'] ?? null,
        fetchImpl,
      )
      res.statusCode = web.status
      web.headers.forEach((v, k) => res.setHeader(k, v))
      res.end(new Uint8Array(await web.arrayBuffer()))
    })()
  }
}

/** Vite plugin form — registers the middleware on the dev server. */
export function noaaS111Proxy() {
  return {
    name: 'noaa-s111-proxy',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(createNoaaS111Middleware())
    },
  }
}
