// ═══ The S-111 cell CATALOGUE the proxy serves, as STAC (#1453) ═══
//
// NOAA publishes surface currents (S-111) as a set of REGIONAL operational forecast systems
// (OFS), each covering one estuary / bay / shelf. Something has to say WHICH cell covers a
// given viewport, because an S-100 cell key (`cbofs`, `102US004MD1AF262297`) is an opaque
// identifier — unlike a `{z}/{x}/{y}` tile key, nothing about a bounding box produces it.
//
// That `bbox → id` table lives HERE, in the demo's own proxy, and is published as a **STAC
// ItemCollection**. Two things follow from that placement, and both are the point:
//
//  • The ENGINE stays content-blind. It reads a catalogue; it knows nothing about NOAA.
//    Putting this registry in `@xgis/map` would have made the engine's viewport resolution
//    generalise to exactly one product.
//  • The demo stops owning residency. `installS111Mosaic` re-implemented bbox overlap,
//    relevance ordering, a byte budget, an LRU and a concurrency cap in app code — the job
//    `type: raster` has always done for itself. That is now `url: "/opendata/s111/catalog.json"`.
//
// The `bounds` are APPROXIMATE operational-domain envelopes (deg, [W, S, E, N]) — enough to
// pick cells for a viewport. The EXACT grid geometry always comes from the streamed cell's own
// S-100 metadata, never from here. Moved verbatim from the deleted
// `playground/src/examples/s111-models.ts`; the SELECTION rule that used to sit beside it is
// now `itemsForView` in map/src/coverage-catalogue.ts, with these same witnesses under test.

/** One regional S-111 model: the proxy `latest/<key>.h5` route + its domain envelope. */
export interface S111Model {
  key: string
  name: string
  bounds: readonly [number, number, number, number]
}

/** The regional S-111 models the proxy can stream. Ordered coarse→fine only for readability;
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

/** The catalogue as a STAC ItemCollection.
 *
 *  Asset hrefs are RELATIVE (`latest/<key>.h5`), and that is load-bearing rather than tidy.
 *  In dev the catalogue is served from the page origin; in production the site rewrites
 *  `/opendata/` to the Cloudflare Worker, so the catalogue arrives from the WORKER's origin.
 *  A root-relative `/opendata/s111/latest/cbofs.h5` would then resolve against the PAGE origin
 *  (github.io), which serves no cells — every item would 404 in prod and only in prod. A
 *  relative href resolves against the catalogue's own URL, so it follows the document to
 *  whichever origin served it. An absolute href would need this file to know the deploy
 *  target, which is exactly the coupling the proxy exists to avoid.
 *
 *  `latest/<key>.h5` also means the catalogue never rots: the proxy resolves the newest
 *  published cycle per request, so no cell key is baked in here.
 *
 *  Each item's `datetime` is the CYCLE, not the forecast hour — S-111 hours are HDF5 groups
 *  INSIDE a cell, stepped by `setCoverageTime`, and the catalogue never selects among them. */
export function s111CatalogueDocument(): unknown {
  return {
    type: 'FeatureCollection',
    stac_version: '1.0.0',
    features: S111_MODELS.map((m) => ({
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
          href: `latest/${m.key}.h5`,
          type: 'application/x-hdf5',
          title: `${m.name} surface currents (newest cycle)`,
          roles: ['data'],
        },
      },
    })),
  }
}
