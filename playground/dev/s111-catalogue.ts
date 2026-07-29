// ═══ The S-111 cell CATALOGUE the bridge serves, as STAC (#1453) ═══
//
// NOAA publishes surface currents (S-111) as a set of REGIONAL operational forecast systems
// (OFS), each covering one estuary / bay / shelf. Something has to say WHICH cell covers a
// given viewport, because an S-100 cell key (`cbofs`, `102US004MD1AF262297`) is an opaque
// identifier — unlike a `{z}/{x}/{y}` tile key, nothing about a bounding box produces it.
//
// That `bbox → id` table lives HERE, in the demo's own bridge, and is published as a **STAC
// ItemCollection**. Two things follow from that placement, and both are the point:
//
//  • The ENGINE stays content-blind. It reads a catalogue; it knows nothing about NOAA.
//    Putting this registry in `@xgis/map` would have made the engine's viewport resolution
//    generalise to exactly one product.
//  • The demo stops owning residency. `installS111Mosaic` re-implemented bbox overlap,
//    relevance ordering, a byte budget, an LRU and a concurrency cap in app code — the job
//    `type: raster` has always done for itself. That is now `url: "/opendata/s111.stac.json"`.
//
// It also owns RESOLVING each model's newest published cell, because the bridge has no route
// that could. The bridge proxies allowlisted HOSTS; `latest/<model>.h5` is not a host, and a
// route shaped like one would be a product carve-out in a router that has none. Resolving here
// is the better answer anyway: a STAC catalogue should NAME the cells it lists rather than hand
// out a promise to resolve one later, and every item's `href` is now the real key of a real
// object.
//
// The `bounds` are APPROXIMATE operational-domain envelopes (deg, [W, S, E, N]) — enough to
// pick cells for a viewport. The EXACT grid geometry always comes from the streamed cell's own
// S-100 metadata, never from here. Moved verbatim from the deleted
// `playground/src/examples/s111-models.ts`; the SELECTION rule that used to sit beside it is
// now `itemsForView` in map/src/coverage-catalogue.ts, with these same witnesses under test.

type FetchImpl = typeof globalThis.fetch

/** The bucket's REGIONAL endpoint — the address its objects actually have, and the exact host
 *  the bridge's allowlist carries (`scripts/gen-opendata-hosts.ts` emits this same form). */
const S111_HOST = 'noaa-s111-pds.s3.us-east-1.amazonaws.com'
const S111_BUCKET = `https://${S111_HOST}`

/** One regional S-111 model: its bucket folder + its domain envelope. */
export interface S111Model {
  key: string
  name: string
  bounds: readonly [number, number, number, number]
}

/** The regional S-111 models the bridge can stream. Ordered coarse→fine only for readability;
 *  selection is geometric and happens in the engine. */
export const S111_MODELS: readonly S111Model[] = [
  { key: 'wcofs', name: 'U.S. West Coast', bounds: [-134.0, 30.0, -117.0, 49.0] },
  { key: 'gomofs', name: 'Gulf of Maine', bounds: [-72.0, 39.5, -63.0, 45.5] },
  { key: 'ngofs2', name: 'Northern Gulf of Mexico', bounds: [-98.5, 27.0, -87.5, 31.0] },
  { key: 'cbofs', name: 'Chesapeake Bay', bounds: [-77.3, 36.0, -74.9, 39.6] },
  { key: 'dbofs', name: 'Delaware Bay', bounds: [-75.9, 38.0, -74.2, 40.5] },
  { key: 'sfbofs', name: 'San Francisco Bay', bounds: [-123.2, 36.9, -121.3, 38.5] },
  { key: 'tbofs', name: 'Tampa Bay', bounds: [-83.2, 27.2, -82.4, 28.1] },
  { key: 'ciofs', name: 'Cook Inlet', bounds: [-155.0, 58.5, -148.0, 61.5] },
  { key: 'lsofs', name: 'Lake Superior', bounds: [-92.3, 46.4, -84.2, 49.1] },
  { key: 'lmhofs', name: 'Lake Michigan-Huron', bounds: [-88.2, 41.6, -79.7, 46.5] },
  { key: 'leofs', name: 'Lake Erie', bounds: [-83.6, 41.3, -78.8, 43.0] },
  { key: 'loofs', name: 'Lake Ontario', bounds: [-79.9, 43.1, -76.0, 44.4] },
]

/** List object keys under `prefix` (no delimiter — every leaf under it). */
async function listKeys(prefix: string, f: FetchImpl): Promise<string[]> {
  const res = await f(`${S111_BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}`)
  const xml = await res.text()
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]!)
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** How many days back to look for a published cycle. Three covers a missed cycle or two without
 *  making a fully-stale model expensive: the worst case is `DAYS_BACK` LISTs for a model that
 *  published nothing, and every model runs concurrently against ONE subrequest budget. */
const DAYS_BACK = 3

/** Resolve the newest regional cell for a forecast model: ONE list per candidate day, newest
 *  day first, take the lexicographic maximum.
 *
 *  ONE LIST PER DAY, and that is not a micro-optimisation. This ran as a prefix WALK — year →
 *  month → day → hour → leaf, 5 to 10 LISTs per model — and twelve models resolving concurrently
 *  blew Cloudflare's **50-subrequest-per-request** limit. The catalogue still answered 200, with
 *  five of twelve models silently missing: the exact green-but-broken shape this whole bridge
 *  exists to stop. Nothing local could see it, because node has no such limit. A day prefix
 *  listed WITHOUT a delimiter returns every key for that day in one request (240 at the busiest
 *  model observed, far under S3's 1000-key page), so the whole catalogue now costs 12–36
 *  subrequests instead of 60–120.
 *
 *  The `/dcf2/regional/` filter is load-bearing, not a tidy-up. A day's keys also contain
 *  `dcf3/` and `dcf2/tiles/`, and BOTH sort after `dcf2/regional/` — a bare maximum over the
 *  day would confidently return the wrong product. The walk this replaced never saw them
 *  because it listed that one folder directly.
 *
 *  Model-agnostic (cbofs, dbofs, gomofs, …): it takes the newest `.h5` under the newest cycle's
 *  `dcf2/regional/`, whatever the cell is named. Keys embed a zero-padded hour as a path segment,
 *  so lexicographic order IS chronological order within a day. */
export async function resolveLatestS111(
  model: string,
  f: FetchImpl = fetch,
  now: number = Date.now(),
): Promise<string> {
  const base = `ed1.0.1/model_forecast_guidance/${model}`
  for (let back = 0; back < DAYS_BACK; back++) {
    const d = new Date(now - back * 86_400_000)
    const day = `${base}/${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}/`
    const cells = (await listKeys(day, f))
      .filter((k) => k.includes('/dcf2/regional/') && k.endsWith('.h5'))
      .sort()
    if (cells.length) return cells[cells.length - 1]!
  }
  throw new Error(`no ${model} S-111 dcf2/regional cell in the last ${DAYS_BACK} days`)
}

/** The catalogue as a STAC ItemCollection, over the models whose newest cell resolved.
 *
 *  Asset hrefs are RELATIVE, and that is load-bearing rather than tidy. In dev the catalogue is
 *  served from the page origin; in production the site rewrites `/opendata/` to the Cloudflare
 *  Worker, so the catalogue arrives from the WORKER's origin. A root-relative href would then
 *  resolve against the PAGE origin (github.io), which serves no cells — every item would 404 in
 *  prod and only in prod. A bare `<host>/<key>` resolves against the catalogue's own URL, so it
 *  follows the document to whichever origin served it and lands on the bridge's passthrough. An
 *  absolute href would need this file to know the deploy target, which is exactly the coupling
 *  the bridge exists to avoid. The catalogue is served as a SIBLING of the host segment
 *  precisely so this href needs no `..`: `parseCoverageCatalogue` joins a relative href onto the
 *  base directory without collapsing one.
 *
 *  Each item's `datetime` is the CYCLE, not the forecast hour — S-111 hours are HDF5 groups
 *  INSIDE a cell, stepped by `setCoverageTime`, and the catalogue never selects among them. */
export function s111CatalogueDocument(
  resolved: ReadonlyMap<string, string>,
  matched: number = resolved.size,
): unknown {
  return {
    type: 'FeatureCollection',
    stac_version: '1.0.0',
    // STAC API's own counters, and they earn their place: a model whose resolution failed is
    // DROPPED, so a partial build is otherwise indistinguishable from a complete one — which is
    // how a 5-of-12 catalogue shipped to production answering a clean 200. `numberReturned <
    // numberMatched` is the signal `scripts/check-opendata-bridge.ts` fails the deploy on.
    numberMatched: matched,
    numberReturned: resolved.size,
    features: S111_MODELS.filter((m) => resolved.has(m.key)).map((m) => ({
      type: 'Feature',
      stac_version: '1.0.0',
      id: m.key,
      bbox: m.bounds,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [m.bounds[0], m.bounds[1]],
            [m.bounds[2], m.bounds[1]],
            [m.bounds[2], m.bounds[3]],
            [m.bounds[0], m.bounds[3]],
            [m.bounds[0], m.bounds[1]],
          ],
        ],
      },
      properties: { title: m.name, 'xgis:product': 's111' },
      assets: {
        data: {
          href: `${S111_HOST}/${resolved.get(m.key)!}`,
          type: 'application/x-hdf5',
          title: `${m.name} surface currents (newest cycle)`,
          roles: ['data'],
        },
      },
    })),
  }
}

/** The models the BUCKET actually publishes, intersected with the ones this file can place.
 *
 *  The list above was hand-maintained and had drifted from reality in both directions: it
 *  claimed `ciofs`, which the bucket does not carry at all, and it missed `nyofs`,
 *  `rtofs_east` and `rtofs_west`, which it does. A stale entry made the deploy check red for
 *  nothing; a missing one silently narrowed the catalogue.
 *
 *  So the BUCKET decides what exists and this file decides where it is. That split is forced:
 *  NOAA publishes no domain envelope alongside the folders, and the only other way to learn one
 *  is to range-read every cell's S-100 metadata. An entry here for a model the bucket does not
 *  publish is therefore harmless (it simply never intersects) and a model the bucket publishes
 *  without an entry here is skipped rather than placed at a guessed location. */
async function publishedModels(f: FetchImpl): Promise<readonly S111Model[]> {
  const prefix = 'ed1.0.1/model_forecast_guidance/'
  const res = await f(
    `${S111_BUCKET}/?list-type=2&prefix=${encodeURIComponent(prefix)}&delimiter=/`,
  )
  const xml = await res.text()
  const names = new Set<string>()
  for (const m of xml.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)) {
    const seg = m[1]!.slice(prefix.length).replace(/\/$/, '')
    if (seg) names.add(seg)
  }
  if (names.size === 0) throw new Error('S-111 bucket listed no forecast models')
  return S111_MODELS.filter((m) => names.has(m.key))
}

/** Resolve every published model's newest cell and build the catalogue, memoised.
 *
 *  A model whose resolution fails is DROPPED, not defaulted: an item whose href we cannot name
 *  would send the engine at a key that does not exist, and one unreachable basin must not take
 *  the others with it. The models resolve concurrently, so the wall cost is one day-listing, not
 *  one per model — and the whole build stays inside Cloudflare's 50-subrequest budget.
 *
 *  Memoised for the five minutes the resolution is good for — cells publish ~every 6 h, so
 *  `latest` still rolls forward as new cycles land. Caching the in-flight PROMISE collapses a
 *  concurrent burst into one build, and a rejected build is evicted so a transient failure is
 *  never cached. Module scope, so it survives across requests in BOTH the long-lived vite dev
 *  process AND a warm Cloudflare isolate — one authority, transport-agnostic. */
const CATALOGUE_TTL_MS = 5 * 60_000
let cached: { at: number; p: Promise<unknown> } | null = null

export function s111CatalogueCached(f: FetchImpl = fetch, now = Date.now()): Promise<unknown> {
  if (cached && now - cached.at < CATALOGUE_TTL_MS) return cached.p
  const entry = { at: now } as { at: number; p: Promise<unknown> }
  entry.p = (async () => {
    const models = await publishedModels(f)
    const settled = await Promise.all(
      models.map(async (m) => {
        try {
          return [m.key, await resolveLatestS111(m.key, f, now)] as const
        } catch (err) {
          console.warn(`[opendata] S-111 ${m.key}: ${(err as Error).message}`)
          return null
        }
      }),
    )
    const resolved = new Map(settled.filter((x): x is readonly [string, string] => x !== null))
    if (resolved.size === 0) throw new Error('no S-111 model resolved a cell')
    return s111CatalogueDocument(resolved, models.length)
  })().catch((err: unknown) => {
    if (cached === entry) cached = null
    throw err
  })
  cached = entry
  return entry.p
}

/** Drop the memo — tests only, so one case cannot inherit another's catalogue. */
export function _resetS111CatalogueCache(): void {
  cached = null
}
