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

export type { BackendChoice }

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
   *  code), this is a pure construction-time selection — two maps on one page
   *  can run different backends. Construction-immutable: the canvas context
   *  type is sticky, so there is no runtime `setBackend()`; a re-`run()` scene
   *  swap keeps the original backend. NOTE: the WebGL2 backend is currently a
   *  limited single-sample raster slice, not full render parity. */
  backend?: BackendChoice
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
  /** Accessible name applied to the canvas via `aria-label`, announced
   *  by screen readers when the map receives focus. Defaults to `"Map"`.
   *  Set a deployment-specific label (e.g. `"Seoul transit map"`) so the
   *  a11y tree distinguishes multiple maps on a page. */
  ariaLabel?: string
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
