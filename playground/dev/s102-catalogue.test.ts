// ═══ NOAA's S-100 Exchange Catalogue → STAC (#1453) ═══
//
// Unlike S-111, the `bbox → cell` table here is NOAA's own — `_CATALOG/CATALOG.XML`, an IHO
// S-100 Exchange Catalogue. These gates pin the translation, and they parse a fixture cut from
// the REAL document (samples verified against the live bucket: 4313 datasets, all with a
// fileName and a complete four-corner bbox), not a shape invented to match the parser.

import { describe, expect, it, beforeEach } from 'vitest'
import {
  parseS102ExchangeCatalogue,
  s102CatalogueDocument,
  s102CatalogueCached,
  _resetS102CatalogueCache,
} from './s102-catalogue'
import { parseCoverageCatalogue, itemsForView } from '@xgis/map'
import type { Bbox } from '@xgis/data'

/** One `S100_DatasetDiscoveryMetadata` block, in the producer's own element order. */
function entry(file: string, desc: string, [w, s, e, n]: number[], extra = ''): string {
  return `
  <S100XC:S100_DatasetDiscoveryMetadata>
    <S100XC:fileName>${file}</S100XC:fileName>
    <S100XC:description><gco:CharacterString>${desc}</gco:CharacterString></S100XC:description>
    <S100XC:notForNavigation>true</S100XC:notForNavigation>
    ${extra}
    <S100XC:boundingBox>
      <gex:westBoundLongitude><gco:Decimal>${w}</gco:Decimal></gex:westBoundLongitude>
      <gex:eastBoundLongitude><gco:Decimal>${e}</gco:Decimal></gex:eastBoundLongitude>
      <gex:southBoundLatitude><gco:Decimal>${s}</gco:Decimal></gex:southBoundLatitude>
      <gex:northBoundLatitude><gco:Decimal>${n}</gco:Decimal></gex:northBoundLatitude>
    </S100XC:boundingBox>
  </S100XC:S100_DatasetDiscoveryMetadata>`
}
const catalogue = (...entries: string[]): string =>
  `<?xml version="1.0" ?>\n<S100XC:S100_ExchangeCatalogue>${entries.join('')}</S100XC:S100_ExchangeCatalogue>`

// Verbatim from the live document (2026-07-27 issue).
const WILMINGTON = entry(
  'file:../Southeast/Wilmington/102US004SC1EV262227.h5',
  'Southeast, Wilmington',
  [-78.0, 33.3, -77.7, 33.6],
)
const PENSACOLA = entry(
  'file:../South_Florida/Pensacola/102US004FL1WC262247.h5',
  'South_Florida, Pensacola',
  [-87.0, 29.7, -86.7, 30.0],
)

describe('parseS102ExchangeCatalogue (#1453)', () => {
  it('reads the producer’s fileName + bbox into a bucket key and an envelope', () => {
    const cells = parseS102ExchangeCatalogue(catalogue(WILMINGTON))
    expect(cells).toEqual([
      {
        // `file:../…` is relative to `_CATALOG/`, so the `../` lands back on the edition root.
        key: 'ed3.0.0/Southeast/Wilmington/102US004SC1EV262227.h5',
        id: '102US004SC1EV262227',
        bbox: [-78.0, 33.3, -77.7, 33.6],
        title: 'Southeast, Wilmington',
      },
    ])
  })

  it('SKIPS a dataset with no usable envelope rather than defaulting one', () => {
    // Inventing a bbox would place bathymetry somewhere the producer never said it was.
    const noBox = `
      <S100XC:S100_DatasetDiscoveryMetadata>
        <S100XC:fileName>file:../X/Y/nobox.h5</S100XC:fileName>
      </S100XC:S100_DatasetDiscoveryMetadata>`
    const degenerate = entry('file:../X/Y/flat.h5', 'flat', [10, 10, 10, 12])
    const inverted = entry('file:../X/Y/inv.h5', 'inv', [10, 10, 5, 12])
    const cells = parseS102ExchangeCatalogue(
      catalogue(WILMINGTON, noBox, degenerate, inverted, PENSACOLA),
    )
    expect(cells.map((c) => c.id)).toEqual(['102US004SC1EV262227', '102US004FL1WC262247'])
  })

  it('refuses a fileName that escapes the edition tree', () => {
    const escaped = entry('file:../../../etc/passwd.h5', 'nope', [0, 0, 1, 1])
    expect(parseS102ExchangeCatalogue(catalogue(escaped))).toEqual([])
  })

  it('an empty catalogue is not an error — just no cells', () => {
    expect(parseS102ExchangeCatalogue(catalogue())).toEqual([])
  })
})

describe('s102CatalogueDocument → what the ENGINE reads (#1453)', () => {
  const doc = (): unknown =>
    s102CatalogueDocument(parseS102ExchangeCatalogue(catalogue(WILMINGTON, PENSACOLA)))

  it('the engine parses it, keyed by the S-100 cell name', () => {
    const items = parseCoverageCatalogue(doc(), '/noaa-s102/catalog.json', 'test')
    expect(items.map((i) => i.id)).toEqual(['102US004SC1EV262227', '102US004FL1WC262247'])
    expect(items[0]!.bbox).toEqual([-78.0, 33.3, -77.7, 33.6])
  })

  it('hrefs are RELATIVE, so they follow the document to whichever origin served it', () => {
    // Same rule S-111 established: prod rewrites `/noaa-s102/` to the Worker, so a
    // root-relative href would resolve against the PAGE origin and 404 in prod and only there.
    const dev = parseCoverageCatalogue(doc(), '/noaa-s102/catalog.json', 'test')
    expect(dev[0]!.href).toBe(
      '/noaa-s102/cells/ed3.0.0/Southeast/Wilmington/102US004SC1EV262227.h5',
    )
    const prod = parseCoverageCatalogue(
      doc(),
      'https://noaa-s111.x-gis.workers.dev/noaa-s102/catalog.json',
      'test',
    )
    expect(prod[0]!.href).toBe(
      'https://noaa-s111.x-gis.workers.dev/noaa-s102/cells/ed3.0.0/Southeast/Wilmington/102US004SC1EV262227.h5',
    )
  })

  it('carries NOAA’s not-for-navigation flag rather than dropping it', () => {
    const f = (doc() as { features: { properties: Record<string, unknown> }[] }).features[0]!
    expect(f.properties['xgis:notForNavigation']).toBe(true)
  })

  it('a viewport picks the cell that covers it, and nothing else', () => {
    const items = parseCoverageCatalogue(doc(), '/noaa-s102/catalog.json', 'test')
    const off = [-77.9, 33.35, -77.75, 33.55] as Bbox // inside Wilmington
    expect(itemsForView(items, off).map((i) => i.id)).toEqual(['102US004SC1EV262227'])
    expect(itemsForView(items, [-100, 10, -95, 15] as Bbox)).toEqual([])
  })
})

describe('s102CatalogueCached — 19 MB is fetched once, not per request (#1453)', () => {
  beforeEach(() => _resetS102CatalogueCache())

  const server = (xml = catalogue(WILMINGTON)) => {
    let n = 0
    const f = (async () => {
      n++
      return new Response(xml, { status: 200 })
    }) as unknown as typeof globalThis.fetch
    return { fetch: f, count: () => n }
  }

  it('collapses a concurrent burst into ONE fetch of the source document', async () => {
    const s = server()
    const docs = await Promise.all(Array.from({ length: 8 }, () => s102CatalogueCached(s.fetch)))
    expect(s.count()).toBe(1)
    for (const d of docs) expect((d as { features: unknown[] }).features).toHaveLength(1)
  })

  it('serves from the memo inside the TTL and re-reads after it', async () => {
    const s = server()
    await s102CatalogueCached(s.fetch, 0)
    await s102CatalogueCached(s.fetch, 30 * 60_000) // 30 min — inside the hour
    expect(s.count()).toBe(1)
    await s102CatalogueCached(s.fetch, 61 * 60_000) // past it
    expect(s.count()).toBe(2)
  })

  it('never caches a FAILURE — the next call retries cleanly', async () => {
    let first = true
    const flaky = (async () => {
      if (first) {
        first = false
        return new Response('nope', { status: 503 })
      }
      return new Response(catalogue(WILMINGTON), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    await expect(s102CatalogueCached(flaky)).rejects.toThrow(/HTTP 503/)
    const doc = await s102CatalogueCached(flaky)
    expect((doc as { features: unknown[] }).features).toHaveLength(1)
  })

  it('a rejected build does not poison a concurrent waiter’s retry', async () => {
    const dead = (async () => new Response('', { status: 500 })) as unknown as typeof fetch
    await expect(s102CatalogueCached(dead)).rejects.toThrow()
    // The memo evicted itself, so the next caller starts a fresh build rather than awaiting
    // the settled rejection forever.
    const s = server()
    await expect(s102CatalogueCached(s.fetch)).resolves.toBeTruthy()
    expect(s.count()).toBe(1)
  })
})
