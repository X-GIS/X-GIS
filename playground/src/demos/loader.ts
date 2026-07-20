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

export function load(file: string): string {
  const key = `../examples/${file}`
  let src = modules[key]
  if (!src) throw new Error(`Missing example: ${key}`)
  for (const [pattern, replacement] of URL_REWRITES) {
    src = src.replace(pattern, replacement)
  }
  return src
}

import type { XGISMap } from '@xgis/runtime'

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
}
