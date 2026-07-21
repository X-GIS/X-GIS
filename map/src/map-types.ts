// Type declarations for XGISMap, extracted from map.ts so the shapes
// live somewhere callers + sibling helpers can import without pulling in
// the high-level orchestrator. Internal-only types (VariantPipelines,
// TextOverlay) export from here but are not re-exported from map.ts; the
// public surface (TextOverlayOptions / TextOverlayHandle /
// XGISFontResource / XGISMapOptions / FontTypographyMap) is re-exported
// from map.ts to preserve the existing import paths.

import type { TextStageOptions } from './text/text-stage-types'
import type { GlyphProvider } from './text/sdf/pbf/glyph-provider'
import type { BackendChoice } from '@xgis/engine'
import type { Body } from '@xgis/shared'
import type { SourceLoader } from './source-loader'
import type { GeoJSONFeatureCollection, CoverageHandle } from '@xgis/data'

export type { BackendChoice }

/** A `rawDatasets` entry. Either a real GeoJSON FeatureCollection (the
 *  common case) or one of the documented placeholder markers written by
 *  source-manager / the polar-cap install for sources that carry NO in-memory
 *  features: `{ _tileUrl }` for a raster XYZ source, `{ _tileUrl, _dem }` for a
 *  `raster-dem` source (routes to the HillshadeRenderer with the DEM decode
 *  params, #777), `{ _vectorTile: true }` for a vector-tile (MVT/VT) or
 *  tiled-geojson source, and `{ _coverage }` for an S-100 gridded-coverage
 *  (.xgcov) source — the CPU-resident CoverageHandle is the value-readout
 *  authority (#1158 GAP-1). rebuildLayers narrows on these markers with `in` guards. */
export type RawDataset =
  | GeoJSONFeatureCollection
  | { readonly _tileUrl: string }
  | {
      readonly _tileUrl: string
      /** `raster-dem` marker — routes to the HillshadeRenderer, not raster. */
      readonly _dem: true
      /** DEM elevation-pack encoding (`mapbox` | `terrarium` | `custom`). */
      readonly encoding?: string
      /** Native DEM tile pixel size (256 / 512). */
      readonly tileSize?: number
      /** `encoding: custom` elevation unpack factors. */
      readonly redFactor?: number
      readonly greenFactor?: number
      readonly blueFactor?: number
      readonly baseShift?: number
    }
  | { readonly _vectorTile: true }
  | { readonly _coverage: CoverageHandle }

export interface VariantPipelines {
  fillPipeline: GPURenderPipeline
  fillPipelineGround?: GPURenderPipeline
  linePipeline: GPURenderPipeline
  fillPipelineFallback?: GPURenderPipeline
  fillPipelineGroundFallback?: GPURenderPipeline
  linePipelineFallback?: GPURenderPipeline
  // pointer-events: none mirrors (writeMask:0 on the pick attachment).
  fillPipelineNoPick?: GPURenderPipeline
  fillPipelineGroundNoPick?: GPURenderPipeline
  linePipelineNoPick?: GPURenderPipeline
  fillPipelineFallbackNoPick?: GPURenderPipeline
  fillPipelineGroundFallbackNoPick?: GPURenderPipeline
  linePipelineFallbackNoPick?: GPURenderPipeline
}

/** Map.addOverlay options. The text + anchor are required; everything
 *  else has sensible defaults. */
export interface TextOverlayOptions {
  /** Display string. Use `text-transform` via `.transform`. */
  text: string
  /** Geo anchor [lon, lat]. The map projects per frame. */
  anchor: [number, number]
  /** Font size in display pixels. Default 14. */
  size?: number
  /** RGBA fill color (0..1 per channel). Default white. */
  color?: [number, number, number, number]
  /** Optional halo for legibility over busy backgrounds. */
  halo?: { color: [number, number, number, number]; width: number }
  /** Font key to look up in the runtime's font registry. */
  font?: string
  /** Mapbox `text-transform` post-processing. */
  transform?: 'none' | 'uppercase' | 'lowercase'
}

export interface TextOverlay {
  text: string
  lon: number
  lat: number
  size: number
  color: [number, number, number, number]
  halo?: { color: [number, number, number, number]; width: number }
  font?: string
  transform?: 'none' | 'uppercase' | 'lowercase'
}

export interface TextOverlayHandle {
  /** Remove the overlay. Idempotent. */
  remove(): void
}

/** A single font face to register via the CSS FontFace API. The
 *  pre-loaded `data` lets the map run completely offline — the host
 *  application embeds the WOFF/TTF bytes in its own bundle and hands
 *  them in. `weight` accepts a CSS-spec range string for variable
 *  fonts (e.g. `"300 800"`) or a single value (`"600"`). */
export interface XGISFontResource {
  family: string
  data: ArrayBuffer | Uint8Array
  weight?: string
  style?: string
  /** Em-unit offset ADDED to layer-level `text-letter-spacing` for any
   *  label whose primary font matches this family. Default 0. Useful
   *  when bundling fonts whose intrinsic tracking differs — e.g. Noto
   *  Sans looks slightly looser than Open Sans at the same nominal
   *  spacing, so a -0.02 offset re-balances multi-font layouts. */
  letterSpacingEm?: number
  /** Multiplier on the layer-level `text-line-height` (default 1.2em).
   *  Default 1.0. Some fonts authored with a tight UPM benefit from a
   *  small expansion (e.g. 1.05) for multi-line labels. */
  lineHeightScale?: number
}

/** Resource-injection bag for XGISMap. All fields are optional so the
 *  no-arg constructor (`new XGISMap(canvas)`) still works. Resources
 *  attached here are picked up by the TextStage on first construction
 *  (lazy — happens on the first label-bearing frame). Setters + `add
 *  GlyphProvider` cover the late-binding case. */
export interface XGISMapOptions {
  /** GPU backend to run on, chosen at construction. `'auto'` (the default)
   *  uses WebGPU, honouring the `?forcegl2=1` dev override; `'webgpu'` /
   *  `'webgl2'` hard-pin the backend in code and ignore the URL flag. Since
   *  compiled materials are dual-backend (they carry both WebGPU and WebGL2
   *  code), this is a pure construction-time selection — two maps, each on its
   *  OWN canvas, can run different backends on one page (a single canvas's
   *  context type is sticky, so the same canvas cannot switch).
   *  Construction-immutable: there is no runtime `setBackend()`; a re-`run()` scene
   *  swap keeps the original backend. NOTE: the WebGL2 backend is currently a
   *  limited single-sample raster slice, not full render parity. */
  backend?: BackendChoice
  /** WebGL2-backend-only (#1153 M2, MapLibre-parity name): keep the WebGL2
   *  drawing buffer preserved after present so host-side `canvas.toDataURL()` /
   *  `readPixels`-after-present capture works. Default `false` — a preserved
   *  buffer is a permanent 2×-fullres memory/bandwidth tax on the weakest iOS
   *  devices, and only canvas capture needs it. No effect on the WebGPU backend.
   *  Construction-immutable (mirrors `backend`). */
  preserveDrawingBuffer?: boolean
  /** Celestial body to render, chosen at construction (#798 P2) — e.g. `MOON` /
   *  `MARS_IAU2000` from `@xgis/shared`, or a custom `makeBody(...)`. Routes
   *  through `configureBody()` (the process-global Body authority) and the GPU
   *  const seam BEFORE any shader emit, so every CPU pack and emitted shader
   *  reads the same body. Default: the current active body (EARTH unless
   *  `configureBody()` was called earlier). Construction-immutable (mirrors
   *  `backend`) and PROCESS-GLOBAL — two maps on one page share one body, so
   *  the last-constructed map's `body` wins for both. */
  body?: Body
  /** Per-map custom source-loader registry (docs/architecture/source-loader-seam.md).
   *  Maps a custom `.xgis` `source { type: <key> }` to a loader that produces the
   *  source's data — the declarative on-ramp for data the 7 built-in source types
   *  don't cover. The key is the declared `type:` VERBATIM (e.g. `'x-kr-admin'`).
   *  Construction-immutable, per-canvas (mirrors `backend`). */
  sources?: Record<string, SourceLoader>
  /** Initial camera center `[lon, lat]`, applied at construction so the FIRST
   *  rendered frame is already framed — no default-view flash-then-jump. Routes
   *  through the same `setCenter()` as the runtime API (single mutation
   *  authority) and latches the camera as explicitly-positioned, so the
   *  post-compile bounds-auto-fit will NOT override it (call `fitBounds()`
   *  yourself for data-driven framing). Default `[0, 20]`. */
  center?: [number, number]
  /** Initial zoom, applied at construction (see `center`). Latches the
   *  positioned flag. Clamped to the active min/max zoom. Default `2`. */
  zoom?: number
  /** Initial bearing in degrees, applied at construction. Latches the
   *  positioned flag. Wrapped to `[0, 360)`. Default `0`. */
  bearing?: number
  /** Initial pitch in degrees, applied at construction. Latches the positioned
   *  flag. Clamped to `[0, 85]`. Default `0`. */
  pitch?: number
  /** Initial projection — same names as `setProjection()` (e.g. `'mercator'`,
   *  `'globe'`, `'natural_earth'`). Unlike the camera fields it does NOT latch
   *  the positioned flag (projection is orthogonal to data-bounds framing).
   *  Default `'mercator'`. */
  projection?: string
  /** Glyph sources. `url` points at a MapLibre PBF server template;
   *  `inline` seeds the cache with pre-loaded PBF range bytes per
   *  fontstack — useful for air-gapped deployments. */
  glyphs?: {
    url?: string
    inline?: NonNullable<TextStageOptions['inlineGlyphs']>
  }
  /** Sprite atlas URL prefix (e.g. `https://.../sprites/ofm`). The
   *  IconStage fetches `${url}.json` + `${url}.png` on first label-
   *  bearing frame. Optional — leaving it unset means icon-image
   *  layers from imported styles render nothing (current default). */
  spriteUrl?: string
  /** Raw provider chain — escape hatch for custom backends (IndexedDB,
   *  S3, etc.). Sits between inline and HTTP in the chain. */
  glyphProviders?: GlyphProvider[]
  /** Pre-loaded WOFF/TTF fonts registered via the CSS FontFace API.
   *  Same effect as <link rel="preload"> + @font-face, but driven from
   *  JS so the host can ship the bytes inside its own bundle. */
  fonts?: XGISFontResource[]
  /** Plan P4 opt-in: route per-feature paint expressions
   *  (`match(get(field), ...)`, `case(...)`) through a GPU compute
   *  kernel instead of the legacy fragment-shader if-else chain.
   *
   *  When set to `true`, `emitCommands` runs with
   *  `enableComputePath: true`: the compiler emits a `computePlan`
   *  + variants carrying `computeBindings`, and MapRenderer attaches
   *  `ComputeLayerHandle` instances that dispatch per-frame compute
   *  kernels (see `compute-layer-registry.ts`).
   *
   *  Default is `false` (legacy fragment-shader path) until the
   *  per-style pixel-match verification gate flips. Direct .xgis
   *  fixtures with `match()` data-driven fills exercise the path
   *  cleanly; Mapbox-converted styles (OFM Bright etc.) get their
   *  match() expressions pre-expanded by `expand-color-match` so
   *  the compute path sees 0 entries on them — still safe to enable. */
  enableComputePath?: boolean
  /** Show the lat/lon graticule grid lines. Default `false` — the
   *  graticule was a debugging aid that shipped on by default; for
   *  basemap-quality output it should opt in. Toggle at runtime via
   *  `map.setGraticuleEnabled(bool)`. */
  graticule?: boolean
  /** Symbol fade duration in ms (MapLibre `fadeDuration` parity). Labels and
   *  their paired icons ramp opacity over this window when they appear or
   *  disappear (tile loads, collision churn) instead of popping. Placement
   *  itself stays instant — only the visual alpha ramps, so the S16
   *  label-prepare skip and its zoom-jank guarantees are untouched. `0`
   *  disables fading (pre-fade byte-identical rendering, the right setting
   *  for pixel-exact screenshot harnesses). Default `300`. */
  fadeDuration?: number
  /** Accessible name applied to the canvas via `aria-label`, announced
   *  by screen readers when the map receives focus. Defaults to `"Map"`.
   *  Set a deployment-specific label (e.g. `"Seoul transit map"`) so the
   *  a11y tree distinguishes multiple maps on a page. */
  ariaLabel?: string
  /** Canvas `touch-action` policy (#1153 M1, matches MapLibre/Mapbox). By default
   *  the library sets the canvas's inline `touch-action: none` so iOS/Android
   *  don't hijack pan/pinch as page scroll (which fires repeated `pointercancel`
   *  and breaks gestures for third-party embeds) — but ONLY when the host has not
   *  already expressed intent via an inline OR a non-`auto` computed `touch-action`
   *  (that authorial value is preserved). Pass an explicit string (e.g. `'pan-y'`)
   *  to set that value unconditionally, or `false` to never touch the style at all.
   *  NOTE: an explicit stylesheet `touch-action: auto` is indistinguishable from
   *  the CSS default and will be overridden; use `touchAction: false` (or insert
   *  the canvas into the DOM before construction) to opt out. */
  touchAction?: false | string
  /** Surface a converted style's "Conversion notes" block to the console
   *  once at load. `convertMapboxStyle` records every dropped / approximated
   *  filter / paint in a trailing block comment in the emitted .xgis source;
   *  the lexer discards it, so the user who loads the converted source saw
   *  ZERO console output even when a filter was silently widened or a paint
   *  property dropped. When `run()` finds the block it `console.warn`s the
   *  extracted notes once. Default `true`; set `false` to silence (e.g. a
   *  deployment shipping a hand-vetted converted style). */
  logConversionNotes?: boolean
}

/** Map of CSS family name → per-font typography overrides. Built once
 *  from the constructor options and consulted in TextStage when
 *  computing per-label letter-spacing and line-height. */
export type FontTypographyMap = Map<string, { letterSpacingEm: number; lineHeightScale: number }>
