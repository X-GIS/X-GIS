// ═══ NOAA's S-102 catalogue, translated to STAC (#1453) ═══
//
// Unlike S-111 — where nothing published a `bbox → cell` table and this repo had to carry one —
// NOAA PUBLISHES the S-102 table, in the standard meant for it:
//
//   noaa-s102-pds/ed3.0.0/_CATALOG/CATALOG.XML   — an IHO S-100 Exchange Catalogue
//                                                  (`S100XC:S100_ExchangeCatalogue`, S-100 5.2 /
//                                                  ISO 19115-3), 4313 datasets, every one with a
//                                                  `fileName` and a complete four-corner bbox.
//
// So nothing here invents a table; it reads the producer's own. What it does do is TRANSLATE, and
// that needs justifying against ADR-0010, which forbids transcoding a standard into a house
// format. Three things make this the permitted case rather than the forbidden one:
//
//   • The target is a STANDARD (STAC), not a house container.
//   • It runs SERVER-SIDE. The browser never sees the intermediate.
//   • The DATA is untouched — cells are still read in place as HDF5 over HTTP Range. Only the
//     discovery metadata is restated.
//
// And the reason is measured, not asserted: 19 MB of XML per browser session, for a step whose
// whole output is a bbox lookup, against ~1 MB of STAC (≈150 KB gzipped) that then serves every
// subsequent pan for free. An IHO-specific XML parser in a content-blind engine would also be
// exactly the coupling the catalogue contract exists to avoid — the engine reads ONE catalogue
// format; publishers' native discovery metadata meets it here.

type FetchImpl = typeof globalThis.fetch

const S102_BUCKET = 'https://noaa-s102-pds.s3.amazonaws.com'
const CATALOG_KEY = 'ed3.0.0/_CATALOG/CATALOG.XML'

/** One S-102 cell, as the exchange catalogue describes it. */
interface S102Cell {
  /** Bucket key, e.g. `ed3.0.0/Southeast/Wilmington/102US004SC1EV262227.h5`. */
  key: string
  /** The cell's own identifier — the file's basename, which is the S-100 cell name. */
  id: string
  /** `[west, south, east, north]` in degrees. */
  bbox: [number, number, number, number]
  /** `"Southeast, Wilmington"` — the producer's own description. */
  title: string
}

/** One `<gex:*BoundLongitude>`-style decimal out of a discovery-metadata block. */
function decimalOf(block: string, tag: string): number | null {
  const m = new RegExp(`<${tag}>\\s*<gco:Decimal>([^<]+)</gco:Decimal>`).exec(block)
  if (!m) return null
  const v = Number(m[1])
  return Number.isFinite(v) ? v : null
}

/** Parse the exchange catalogue into its cells.
 *
 *  Regex rather than a DOM parse, deliberately: this runs in a Cloudflare Worker and in vite's
 *  node process, neither of which has a DOM, and the two fields taken here (`fileName`, the four
 *  bounds) are flat leaf elements inside one repeated block. Pulling in an XML parser to read
 *  five scalars out of a 19 MB document would cost more than it explains.
 *
 *  A dataset missing either field is SKIPPED rather than defaulted — a cell whose envelope we do
 *  not know cannot be matched to a viewport, and inventing one would place bathymetry somewhere
 *  the producer never said it was. */
export function parseS102ExchangeCatalogue(xml: string): S102Cell[] {
  const cells: S102Cell[] = []
  const blocks = xml.matchAll(
    /<S100XC:S100_DatasetDiscoveryMetadata>([\s\S]*?)<\/S100XC:S100_DatasetDiscoveryMetadata>/g,
  )
  for (const [, block] of blocks) {
    const file = /<S100XC:fileName>([^<]+)<\/S100XC:fileName>/.exec(block!)
    const w = decimalOf(block!, 'gex:westBoundLongitude')
    const s = decimalOf(block!, 'gex:southBoundLatitude')
    const e = decimalOf(block!, 'gex:eastBoundLongitude')
    const n = decimalOf(block!, 'gex:northBoundLatitude')
    if (!file || w === null || s === null || e === null || n === null) continue
    if (!(w < e) || !(s < n)) continue // a degenerate envelope can never match a viewport
    // `file:../Southeast/Wilmington/102US004SC1EV262227.h5` — relative to `_CATALOG/`, so the
    // `../` lands it back on `ed3.0.0/`.
    const rel = file[1]!.replace(/^file:\.\.\//, '')
    if (rel.includes('..')) continue // nothing outside the edition tree
    const id = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.h5$/i, '')
    const title = /<gco:CharacterString>([^<]*)<\/gco:CharacterString>/.exec(block!)?.[1] ?? id
    cells.push({ key: `ed3.0.0/${rel}`, id, bbox: [w, s, e, n], title })
  }
  return cells
}

/** The catalogue as a STAC ItemCollection.
 *
 *  Asset hrefs are RELATIVE for the reason S-111's are (see s111-catalogue.ts): in production the
 *  site rewrites `/opendata/` to the Worker, so a root-relative href would resolve against the
 *  PAGE origin and 404 in prod and only in prod. `cells/<key>` hangs off the catalogue's own
 *  directory and follows the document to whichever origin served it.
 *
 *  `notForNavigation` rides along per item: NOAA marks these test-and-evaluation, and a chart
 *  product that quietly dropped that flag would be claiming something the producer did not. */
export function s102CatalogueDocument(cells: readonly S102Cell[]): unknown {
  return {
    type: 'FeatureCollection',
    stac_version: '1.0.0',
    features: cells.map((c) => ({
      type: 'Feature',
      stac_version: '1.0.0',
      id: c.id,
      bbox: c.bbox,
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [c.bbox[0], c.bbox[1]],
            [c.bbox[2], c.bbox[1]],
            [c.bbox[2], c.bbox[3]],
            [c.bbox[0], c.bbox[3]],
            [c.bbox[0], c.bbox[1]],
          ],
        ],
      },
      properties: {
        title: c.title,
        'xgis:product': 's102',
        'xgis:notForNavigation': true,
      },
      assets: {
        data: {
          href: `cells/${c.key}`,
          type: 'application/x-hdf5',
          title: c.title,
          roles: ['data'],
        },
      },
    })),
  }
}

/** Fetch + translate, memoised.
 *
 *  The source document is 19 MB and changes when NOAA re-issues the edition (the one read here
 *  was issued 2026-07-27), so this is cached for an hour rather than per request — otherwise
 *  every page load would pull 19 MB through the proxy to produce the same answer. Caching the
 *  in-flight PROMISE also collapses a concurrent burst into one fetch, and a rejected build is
 *  evicted so a transient failure is never cached — the `resolveLatestS111Cached` contract. */
const CATALOGUE_TTL_MS = 60 * 60_000
let cached: { at: number; p: Promise<unknown> } | null = null

export function s102CatalogueCached(f: FetchImpl = fetch, now = Date.now()): Promise<unknown> {
  if (cached && now - cached.at < CATALOGUE_TTL_MS) return cached.p
  const entry = { at: now } as { at: number; p: Promise<unknown> }
  entry.p = (async () => {
    const res = await f(`${S102_BUCKET}/${CATALOG_KEY}`)
    if (!res.ok) throw new Error(`S-102 CATALOG.XML: HTTP ${res.status}`)
    return s102CatalogueDocument(parseS102ExchangeCatalogue(await res.text()))
  })().catch((err: unknown) => {
    if (cached === entry) cached = null
    throw err
  })
  cached = entry
  return entry.p
}

/** Drop the memo — tests only, so one case cannot inherit another's catalogue. */
export function _resetS102CatalogueCache(): void {
  cached = null
}
