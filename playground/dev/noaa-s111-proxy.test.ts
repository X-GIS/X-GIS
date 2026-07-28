import { describe, expect, it } from 'vitest'
import { handleNoaa, resolveLatestS111Cached } from './noaa-s111-proxy'
import { S111_MODELS } from './s111-catalogue'
import { parseCoverageCatalogue, itemsForView } from '@xgis/map'

type FetchImpl = typeof globalThis.fetch

// A fake S3 that answers the `resolveLatestS111` date-tree walk for one model with canned
// XML and COUNTS the LISTs it serves — so a test can prove the memo collapses a whole load
// burst into ONE walk. The walk lists year → month → day → hour prefixes, then the leaf
// `dcf2/regional/` keys = 5 LISTs for the happy path below.
function makeS3(model: string): { fetch: FetchImpl; listCount: () => number } {
  const base = `ed1.0.1/model_forecast_guidance/${model}`
  let n = 0
  const xml = (body: string): Response => new Response(body, { status: 200 })
  const fetchImpl = (async (input: string | URL): Promise<Response> => {
    n++
    // URLSearchParams already percent-decodes, so `prefix` is the raw S3 prefix.
    const prefix = new URL(String(input)).searchParams.get('prefix') ?? ''
    if (prefix.endsWith('/00/dcf2/regional/')) return xml(`<Key>${prefix}CBOFS_TYP2.h5</Key>`)
    if (prefix === `${base}/2026/07/22/`) return xml(`<Prefix>${prefix}00/</Prefix>`)
    if (prefix === `${base}/2026/07/`) return xml(`<Prefix>${prefix}22/</Prefix>`)
    if (prefix === `${base}/2026/`) return xml(`<Prefix>${prefix}07/</Prefix>`)
    if (prefix === `${base}/`) return xml(`<Prefix>${prefix}2026/</Prefix>`)
    return xml('')
  }) as unknown as FetchImpl
  return { fetch: fetchImpl, listCount: () => n }
}

const expectedKey = (model: string): string =>
  `ed1.0.1/model_forecast_guidance/${model}/2026/07/22/00/dcf2/regional/CBOFS_TYP2.h5`

describe('resolveLatestS111Cached (burst memo)', () => {
  it('walks the S3 date tree ONCE for a concurrent burst of resolutions', async () => {
    const model = 'burstmodel'
    const s3 = makeS3(model)
    // The reader's ~13 range GETs each hit resolveTarget → resolveLatestS111Cached.
    const keys = await Promise.all(
      Array.from({ length: 13 }, () => resolveLatestS111Cached(model, s3.fetch)),
    )
    expect(keys.every((k) => k === expectedKey(model))).toBe(true)
    expect(s3.listCount()).toBe(5) // ONE walk (5 LISTs) — NOT 13 × 5 = 65.
  })

  it('re-resolves after a failure (a rejected walk is never cached)', async () => {
    const model = 'failmodel'
    let firstRequest = true
    const flakyFetch = (async (input: string | URL): Promise<Response> => {
      if (firstRequest) {
        // Kill the first walk at its first LIST: an empty body parses to zero year
        // folders, so resolveLatestS111 throws. The failure must NOT be cached.
        firstRequest = false
        return new Response('', { status: 500 })
      }
      return makeS3(model).fetch(input)
    }) as unknown as FetchImpl
    await expect(resolveLatestS111Cached(model, flakyFetch)).rejects.toThrow()
    // A fresh call must RETRY (cache evicted the failure) and now succeed.
    await expect(resolveLatestS111Cached(model, flakyFetch)).resolves.toBe(expectedKey(model))
  })
})

// ── The S-111 cell catalogue (#1453) ──
//
// The route the `s111_live` demo's `type: coverage` source names. It is the one route not
// backed by S3, so it must answer without any upstream fetch at all — and it is parsed by the
// ENGINE, so these gates run the real `parseCoverageCatalogue` over the real document rather
// than asserting the shape this file happens to emit.

const NEVER_FETCH = (async () => {
  throw new Error('the catalogue route must not touch the network')
}) as unknown as FetchImpl

describe('GET /noaa-s111/catalog.json', () => {
  it('is served without an upstream fetch, as CORS-open geo+json', async () => {
    const res = await handleNoaa('/noaa-s111/catalog.json', null, null, NEVER_FETCH)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/geo+json')
    expect(res.headers.get('access-control-allow-origin')).toBeTruthy()
  })

  it('the ENGINE parses it — every model becomes one addressable cell', async () => {
    const res = await handleNoaa('/noaa-s111/catalog.json', null, null, NEVER_FETCH)
    const items = parseCoverageCatalogue(await res.json(), '/noaa-s111/catalog.json', 'test')
    expect(items).toHaveLength(S111_MODELS.length)
    expect(items.map((i) => i.id).sort()).toEqual(S111_MODELS.map((m) => m.key).sort())
  })

  it('hrefs are RELATIVE, so they follow the catalogue to whichever origin served it', async () => {
    // The production site rewrites `/noaa-s111/` to the Cloudflare Worker, so the catalogue
    // arrives from the WORKER's origin. A root-relative href would resolve against the PAGE
    // origin (github.io), which serves no cells — every item would 404 in prod and ONLY in
    // prod. Both resolutions are asserted here so that cannot regress silently.
    const res = await handleNoaa('/noaa-s111/catalog.json', null, null, NEVER_FETCH)
    const doc = await res.json()
    const dev = parseCoverageCatalogue(doc, '/noaa-s111/catalog.json', 'test')
    expect(dev.find((i) => i.id === 'cbofs')!.href).toBe('/noaa-s111/latest/cbofs.h5')

    const prod = parseCoverageCatalogue(
      doc,
      'https://noaa-s111.x-gis.workers.dev/noaa-s111/catalog.json',
      'test',
    )
    expect(prod.find((i) => i.id === 'cbofs')!.href).toBe(
      'https://noaa-s111.x-gis.workers.dev/noaa-s111/latest/cbofs.h5',
    )
  })

  it('the demo viewports still resolve to the cells the mosaic used to pick', async () => {
    // The witnesses `s111-models.test.ts` carried, now proven END TO END: served document →
    // engine parse → engine selection. The demo's own opening view is the Chesapeake one.
    const res = await handleNoaa('/noaa-s111/catalog.json', null, null, NEVER_FETCH)
    const items = parseCoverageCatalogue(await res.json(), '/noaa-s111/catalog.json', 'test')
    const keys = (v: [number, number, number, number]): string[] =>
      itemsForView(items, v).map((i) => i.id)

    expect(keys([-76.6, 37.5, -75.9, 38.3])[0]).toBe('cbofs')
    expect(keys([-122.6, 37.5, -122.1, 38.0])[0]).toBe('sfbofs') // tie → the local domain
    expect(keys([-160, 10, -150, 20])).toEqual([]) // mid-Pacific: no cell
    const midAtlantic = keys([-76.5, 37.5, -74.5, 39.5])
    expect(midAtlantic[0]).toBe('cbofs')
    expect(midAtlantic).toContain('dbofs') // BOTH — the mosaic, without any app code
  })

  it('every model envelope is well-formed and uniquely keyed', async () => {
    const seen = new Set<string>()
    for (const m of S111_MODELS) {
      expect(m.bounds[0], m.key).toBeLessThan(m.bounds[2])
      expect(m.bounds[1], m.key).toBeLessThan(m.bounds[3])
      expect(seen.has(m.key), `duplicate key ${m.key}`).toBe(false)
      seen.add(m.key)
    }
  })
})
