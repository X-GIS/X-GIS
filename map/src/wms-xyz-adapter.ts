// ═══ WMS→XYZ raster adapter (minimal) — #1478 ═══
//
// Turns a WMS 1.1.1/1.3.0 `GetMap` endpoint into a `type: "raster"` source URL: a
// pure options → URL-template builder, no fetch, no GetCapabilities negotiation, no
// WMTS. EPSG:3857 (Web Mercator) ONLY — deliberately, matching the raster tile grid
// the rest of the pipeline already uses. Scope is intentionally the issue's minimal
// ask; nothing beyond it.
//
// SEAM CHOICE — NOT the custom source-loader registry (source-loader.ts,
// docs/architecture/source-loader-seam.md), which the issue named as the first
// candidate. That registry's `SourceLoader` always returns a FeatureCollection /
// PointPatch and routes through `_attachGeoJSONViaVirtualPMTiles`
// (source-manager.ts:338-356) — tile-producing loaders are explicitly out of scope
// there (source-loader-seam.md §3.2, §9 Phase 3). A WMS `GetMap` reply is a raster
// IMAGE tile, not a feature collection, so that seam has no branch for it.
//
// The raster load path (source-manager.ts:396-401) stores a single URL STRING
// (`_tileUrl`), later expanded per-tile by `tileUrl()` (data/src/tile-select-
// helpers.ts) via `{z}`/`{x}`/`{y}`/`{ratio}` REGEX TOKEN substitution — there is no
// per-tile function hook a loader could attach to. A WMS BBOX is a COMPUTED value
// (linear in x/y, exponential in z), not a token drop, so it cannot ride those
// tokens either.
//
// This adapter instead emits a template carrying the `{bbox-epsg-3857}`
// placeholder — the same convention MapLibre/Mapbox GL's raster `tiles:` array
// documents for WMS interop — which `tileUrl()` now also substitutes (one `if`
// block, reusing this file's own `tileBounds` + `@xgis/geo`'s `lonLatToMercator`).
// Net library surface: one new placeholder in one existing, already-shared
// substitution function; no new source `type:`, no source-manager.ts change, no
// new render path. See docs/architecture/source-loader-seam.md §12 for the full
// writeup and docs/api/noaa-coverage-recipes.md Recipe 4 for the worked example +
// the CORS/proxy requirement (nowCOAST is 405-on-GET — this adapter builds the
// GetMap URL, it does not remove the need for a proxy).

import { tileUrl } from '@xgis/data'

/** Options for a single WMS `GetMap` layer, EPSG:3857 only. */
export interface WmsAdapterOptions {
  /** WMS server endpoint (the path serving `GetMap`), no query string required —
   *  an existing `?`-suffixed base (e.g. one already carrying `service=WFS&…`
   *  from a shared proxy path) is respected and `&`-joined. */
  readonly baseUrl: string
  /** WMS `LAYERS` param — one or more comma-separated layer names. */
  readonly layers: string
  /** WMS protocol version. `'1.3.0'` sends `CRS=EPSG:3857`; `'1.1.1'` sends
   *  `SRS=EPSG:3857`. Default `'1.3.0'`. (EPSG:3857 is a projected CRS, so the
   *  1.3.0 geographic-CRS axis-order swap — the classic EPSG:4326 trap — does not
   *  apply here in either version.) */
  readonly version?: '1.1.1' | '1.3.0'
  /** WMS `FORMAT` param (image MIME type). Default `'image/png'`. */
  readonly format?: string
  /** Tile edge length in pixels — WMS `WIDTH`/`HEIGHT` (both set equal). Must
   *  match the raster source's declared `tileSize`. Default `256`. */
  readonly tileSize?: number
  /** WMS `STYLES` param. Default `''` (server default style). */
  readonly styles?: string
  /** WMS `TRANSPARENT` param. Default `true`. */
  readonly transparent?: boolean
}

const DEFAULT_VERSION = '1.3.0'
const DEFAULT_FORMAT = 'image/png'
const DEFAULT_TILE_SIZE = 256
const DEFAULT_STYLES = ''
const DEFAULT_TRANSPARENT = true

function validate(options: WmsAdapterOptions): void {
  if (!options.baseUrl || options.baseUrl.trim() === '') {
    throw new Error('[X-GIS] wmsRasterTemplate: options.baseUrl is required')
  }
  if (!options.layers || options.layers.trim() === '') {
    throw new Error('[X-GIS] wmsRasterTemplate: options.layers is required')
  }
  if (options.version !== undefined && options.version !== '1.1.1' && options.version !== '1.3.0') {
    throw new Error(
      `[X-GIS] wmsRasterTemplate: unsupported WMS version '${options.version}' — ` +
        `only '1.1.1' and '1.3.0' are supported`,
    )
  }
  if (
    options.tileSize !== undefined &&
    (!Number.isFinite(options.tileSize) || options.tileSize <= 0)
  ) {
    throw new Error(
      `[X-GIS] wmsRasterTemplate: options.tileSize must be a positive number, ` +
        `got ${options.tileSize}`,
    )
  }
}

/** Build a raster-source URL TEMPLATE for a WMS layer: a `GetMap` request with a
 *  `{bbox-epsg-3857}` placeholder standing in for `BBOX`, expanded per-tile by
 *  `tileUrl()` (`@xgis/data`) exactly like an ordinary `{z}/{x}/{y}` raster
 *  template. Pass the result as a `type: "raster"` source's `url:`. Throws on a
 *  missing `baseUrl`/`layers`, an unsupported `version`, or a non-positive
 *  `tileSize`. */
export function wmsRasterTemplate(options: WmsAdapterOptions): string {
  validate(options)
  const version = options.version ?? DEFAULT_VERSION
  const format = options.format ?? DEFAULT_FORMAT
  const tileSize = options.tileSize ?? DEFAULT_TILE_SIZE
  const styles = options.styles ?? DEFAULT_STYLES
  const transparent = options.transparent ?? DEFAULT_TRANSPARENT
  const crsParam = version === '1.3.0' ? 'CRS' : 'SRS'
  const sep = options.baseUrl.includes('?') ? '&' : '?'
  const params = [
    'SERVICE=WMS',
    'REQUEST=GetMap',
    `VERSION=${version}`,
    `LAYERS=${encodeURIComponent(options.layers)}`,
    `STYLES=${encodeURIComponent(styles)}`,
    `${crsParam}=EPSG:3857`,
    'BBOX={bbox-epsg-3857}',
    `WIDTH=${tileSize}`,
    `HEIGHT=${tileSize}`,
    `FORMAT=${encodeURIComponent(format)}`,
    `TRANSPARENT=${transparent ? 'TRUE' : 'FALSE'}`,
  ]
  return `${options.baseUrl}${sep}${params.join('&')}`
}

/** Compute the literal WMS `GetMap` URL for one XYZ tile — pure, no network, no
 *  map instance required. Equivalent to `tileUrl(wmsRasterTemplate(options), {z,
 *  x, y, ox: x})`; exposed standalone so a single tile's URL can be built (or
 *  unit-tested) without going through the map's raster-source pipeline. */
export function wmsGetMapUrl(z: number, x: number, y: number, options: WmsAdapterOptions): string {
  return tileUrl(wmsRasterTemplate(options), { z, x, y, ox: x })
}
