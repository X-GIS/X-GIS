// ═══ Demo loader — shared by all per-category demo fragments ═══
// Source files live in ../examples/*.xgis — single source of truth.
// Vite inlines them at build time via ?raw glob import.

const modules = import.meta.glob<string>('../examples/*.xgis', {
  eager: true,
  query: '?raw',
  import: 'default',
})

// .xgis source URL rewrites — applied in BOTH dev and prod.
//
// The protomaps demo bucket the demos originally referenced
// (`demo-bucket.protomaps.com/v4.pmtiles`, via the vite `/pmtiles-proxy/
// protomaps` proxy) is DEAD — the file 404s as of 2026-06, so the proxy no
// longer resolves and the v4 demos (osm-style, pmtiles-layered, etc.) render
// only their style background. Rewrite that dead path to the protomaps API
// TileJSON. The runtime's pmtiles-source loader detects `.json` URLs and
// switches to the XYZ MVT-tile-server fetcher, so the same .xgis sources work
// everywhere. Per protomaps' CORS policy a keyed request from localhost is
// CORS-exempt (local dev), and the key is allowed for https://x-gis.github.io
// in prod — so the direct API URL works in both. (Previously this rewrite was
// prod-only; with the bucket gone, dev needs it too.)
const PROTOMAPS_API_KEY = '360aa6108dc73d2e'

const URL_REWRITES: Array<[RegExp, string]> = [
  [
    /\/pmtiles-proxy\/protomaps\/v4\.pmtiles/g,
    `https://api.protomaps.com/tiles/v4.json?key=${PROTOMAPS_API_KEY}`,
  ],
]

// The live demos stream from CORS-less open-data origins through a bridge — the vite
// `/opendata` dev middleware locally. The hosted static site has no dev server, so in PROD
// ONLY we rewrite that prefix to a CORS-open Cloudflare Worker serving the same contract
// (dev/opendata-bridge-worker.ts). The prefix is PRESERVED in the rewrite (the worker routes
// on the full `/opendata/…` path); dev keeps the bare path so the vite bridge handles it.
// Until the worker is deployed the demos degrade to imagery-only on the hosted site (see
// docs/api/noaa-coverage-recipes.md).
//
// ONE rule, because the bridge has ONE prefix. It was two — `/noaa-s111/` and `/noaa/` — and
// a rewrite list that has to grow per product is a list that will be missing the next one.
const OPENDATA_BRIDGE = 'https://opendata-bridge.x-gis.workers.dev'
if (import.meta.env.PROD) {
  URL_REWRITES.push([/\/opendata\//g, `${OPENDATA_BRIDGE}/opendata/`])
}
// (A `NOAA_PROXY_BASE` for IMPERATIVE app-side fetches lived here until #1453. Nothing fetches
// open data imperatively any more: the live source declares a catalogue URL, so it goes through
// the URL_REWRITES above like every other source URL, and the catalogue's own cell hrefs are
// relative — they follow the document to whichever origin served it.)

export function load(file: string): string {
  const key = `../examples/${file}`
  let src = modules[key]
  if (!src) throw new Error(`Missing example: ${key}`)
  for (const [pattern, replacement] of URL_REWRITES) {
    src = src.replace(pattern, replacement)
  }
  return src
}

import type { XGISMap } from '@xgis/map'

/** One gallery action button (#1192 interaction infra): demo-runner renders
 *  `label` in the #demo-actions bar and invokes `run` with the LIVE map on
 *  click — the MapLibre examples' `<button>` → map-API wiring, expressed as
 *  demo metadata so API-driven examples stay portable. */
export interface DemoAction {
  label: string
  run: (map: XGISMap) => void
}

export interface Demo {
  name: string
  tag: string
  description: string
  source: string // loaded from .xgis file
  /** When true, demo-runner enables runtime picking and installs a
   *  hover/click overlay panel that shows the hit feature's name +
   *  coordinate. Used by interactive picking demos and any fixture
   *  that wants to expose live event feedback for manual testing. */
  picking?: boolean
  /** When true, the demo is kept in DEMOS (so `demo.html?id=…` and the
   *  e2e suite still resolve it) but the gallery OMITS it. Used to keep
   *  the isolated-feature regression fixtures out of the user-facing
   *  showcase while preserving their ids for the test harness. */
  hidden?: boolean
  /** Initial camera zoom applied on open (unless a URL `#z/lat/lon` hash
   *  overrides). A .xgis source carries no camera state, so a demo that only
   *  reads well at a specific zoom (e.g. a raster-dem hillshade, near-flat at
   *  low zoom) declares it here. */
  zoom?: number
  /** Initial camera centre `[lon, lat]` applied on open (same hash-override
   *  rule as `zoom`). For demos anchored to a real-world place — e.g. a live
   *  terrain-tile hillshade over the Grand Canyon — where the default 0,0
   *  view would show nothing of interest. */
  center?: [number, number]
  /** Viewport projection applied via `map.setProjection()` after the demo
   *  mounts (#1192 P1 — mirrors MapLibre examples that call the projection
   *  API rather than declaring it in the style, e.g. globe). A `?proj=` URL
   *  override still wins. */
  projection?: string
  /** Action buttons rendered by demo-runner while this demo is mounted. */
  actions?: DemoAction[]
  /** Initial camera pitch (degrees) / bearing (degrees) applied on open with
   *  the same hash-override rule. For camera-pose demos (the MapLibre
   *  "Set pitch and bearing" port) — the .xgis carries only style, so the
   *  pose is demo metadata like `zoom`/`center`. */
  pitch?: number
  bearing?: number
  /** When true, demo-runner installs a small badge that tracks the live
   *  lon/lat under the cursor via map.unproject() on every pointermove —
   *  MapLibre's "Get coordinates of the mouse pointer" example (#1192).
   *  Unlike `picking`, this fires everywhere over the map, not just over
   *  a hit feature. */
  mousePosition?: boolean
  /** When true, demo-runner installs the measure overlay (#1192 / #1235):
   *  each map click appends a measurement point (clicking an existing point
   *  removes it), the host rebuilds the `measure_pts` / `measure_path`
   *  FeatureCollections and pushes them via setSourceData, and a badge shows
   *  the running haversine total — MapLibre's "Measure distances" example. */
  measure?: boolean
  /** When true, demo-runner reads the demo's `currents` coverage source
   *  (map.getCoverage) after mount and overlays a retained particle-flow batch
   *  drifting along the direction band — the NOAA S-111 vector-field reading
   *  (#1272 / #826). The coverage colour ramp stays the speed reading. */
  currents?: boolean
  /** When true, demo-runner shows the forecast-hour scrubber over the `currents` source
   *  (#1272 E-③) — a slider + play/pause driving `setCoverageTime` / `playCoverageTime`.
   *  Set it for a source whose cell carries a MULTI-HOUR axis; the control hides itself
   *  over a single-group cell anyway. Pair with `currents: true`.
   *
   *  This replaced a `mosaic` flag (#1453). Viewport residency is no longer something a
   *  demo opts into: the live source's `url:` names a STAC catalogue and the ENGINE
   *  resolves the viewport, exactly as it does for `type: raster`. */
  timeControl?: boolean
  /** When true, demo-runner fetches NOAA CO-OPS live tidal-current stations
   *  (api.tidesandcurrents.noaa.gov, CORS `*`) and draws one retained arrow per
   *  station, refreshing periodically — the browser-DIRECT live-data path
   *  (#1272). Requires network egress; the arrows simply stay absent offline. */
  coops?: boolean
}
