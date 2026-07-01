// Type declarations extracted from text-stage.ts (behaviour-preserving
// structural split, mirrors the map.ts pattern). text-stage.ts imports
// these and re-exports the previously-`export`ed ones so the public
// surface stays byte-identical.

import type { LabelDef } from '@xgis/compiler'
import type { GlyphRasterizer } from '@xgis/map'
import type { InlineGlyphSource } from './sdf/pbf/inline-glyph-provider'
import type { GlyphProvider } from '@xgis/map'

export interface WrappedLineRange { start: number; end: number; width: number }

export interface KPBreak {
  index: number
  x: number
  prior: KPBreak | null
  badness: number
}

export interface MlVerticalLayout {
  /** Per-line baseline Y in px, relative to the label anchor
   *  (screen-down positive). The renderer converts baseline→quad-top
   *  by subtracting each glyph's own bearingY.
   *
   *  iter-242 — widened to `ArrayLike<number>` so FrameArena-backed
   *  `Float32Array` views work as drop-in. Read-only access via `[i]`
   *  + `length` — both Array<number> and Float32Array satisfy. */
  baselineY: ArrayLike<number>
  /** Block bbox edges in px relative to the anchor (collision). */
  blockTop: number
  blockBottom: number
}

export interface TextStageOptions {
  /** Atlas slot side length in pixels. Each glyph rasterises into
   *  one slot; slot must be larger than (rasterFontSize + 2*sdfRadius). */
  slotSize?: number
  /** Atlas page side length in pixels. Multiple of slotSize. */
  pageSize?: number
  /** Pixel size each glyph is rasterised at. Display sizes scale
   *  via the SDF threshold smoothing in the shader. Picking ~24px
   *  gives good fidelity from 12px up to 64px display. */
  rasterFontSize?: number
  /** SDF falloff radius in pixels. Determines edge smoothness +
   *  halo headroom. */
  sdfRadius?: number
  /** Device-pixel-ratio the atlas rasterises for. `rasterFontSize`
   *  is multiplied by this (capped so rasterFontSize + 2*sdfRadius
   *  still fits slotSize) so locally Canvas2D-rasterised glyphs
   *  (Hangul/Han — not served by the PBF glyph endpoint) are baked
   *  near their physical-pixel display size instead of being
   *  GPU-upscaled ~dpr× from a 24-px raster (visible as low-res
   *  CJK labels on hidpi phones). Fixed at construction — the atlas
   *  is built once; matches the existing single-build lifecycle.
   *  Defaults to 1 (no scaling). */
  dpr?: number
  /** Default font key when LabelDef doesn't specify a font stack. */
  defaultFont?: string
  /** Optional rasterizer override (e.g. a worker-backed implementation
   *  injected by the integration layer). When omitted, picks the best
   *  available for the current environment via createRasterizer(). */
  rasterizer?: GlyphRasterizer
  /** Style-spec `glyphs` URL template (`{fontstack}` + `{range}`).
   *  When provided AND no explicit `rasterizer` is supplied, the stage
   *  wraps the Canvas2D rasterizer with one that fetches MapLibre SDF
   *  PBF glyphs in the background. Failed fetches (offline / 404 / CORS)
   *  stay on Canvas2D for the session. Combined with `inlineGlyphs` /
   *  `glyphProviders`, the URL provider sits at the END of the chain
   *  so cheap inline / IDB sources shadow network requests. */
  glyphsUrl?: string
  /** Pre-loaded PBF range data keyed by `{ fontstack: { rangeStart:
   *  Uint8Array } }`. Used for closed-network / military / air-gapped
   *  deployments where the host application bundles its own PBF
   *  bytes. Stacks at the TOP of the provider chain — inline data
   *  shadows network requests for any range the host pre-bundled. */
  inlineGlyphs?: { [fontstack: string]: InlineGlyphSource }
  /** Raw provider chain — escape hatch for custom backends (IndexedDB,
   *  S3, IPFS). Appended AFTER `inlineGlyphs` and BEFORE the URL-based
   *  HTTP provider. Implement the `GlyphProvider` interface to plug in. */
  glyphProviders?: GlyphProvider[]
  /** Per-font typography overrides — `{ family → { letterSpacingEm,
   *  lineHeightScale } }`. The letter-spacing offset is ADDED to the
   *  layer-level `text-letter-spacing` (in em-units), and the line-
   *  height scale multiplies the layer-level `text-line-height`. Lets
   *  callers tune multi-font bundles where the bundled families have
   *  different intrinsic tracking / leading without forking the style
   *  spec. Missing-family lookups are no-ops (identity 0 / 1). */
  fontTypography?: Map<string, { letterSpacingEm: number; lineHeightScale: number }>
  /** Audit ① B1 — called when an async glyph resource (PBF range) LANDS
   *  after the frame that requested it already drew. The atlas slot is
   *  invalidated internally, but the owning map must also re-arm a frame
   *  AND tag the LABEL domain dirty, or the S16 label-collision skip keeps
   *  serving the stale (zero-SDF) glyph until the camera moves. The host
   *  wires this to `markLabelDirty()`; omitted in tests / non-PBF setups. */
  onResourceLanded?: () => void
}

export interface PendingLabel {
  text: string
  anchorX: number
  anchorY: number
  def: LabelDef
  fontKey: string
  /** Iter 112 paired-symbol collision: identifier shared with the
   *  matching icon dispatched at the SAME line-walk anchor. After
   *  collision, the stage exposes droppedPairKeys so IconStage can
   *  drop the paired icon — implements MapLibre's "text+icon as one
   *  symbol" invariant without a full paired-symbol collision queue. */
  pairKey?: string
}

export interface PendingLineLabel {
  text: string
  /** Polyline already projected to screen pixels by the caller. */
  polylineX: Float32Array
  polylineY: Float32Array
  /** Distance along the polyline (px) where the label centre sits. */
  centerOffsetPx: number
  def: LabelDef
  fontKey: string
  /** Iter 112 paired-symbol collision: identifier shared with the
   *  icon dispatched at the SAME line-walk anchor. Mirror of
   *  PendingLabel.pairKey for curved (tangent-rotated) shields — when
   *  the text is collision-rejected the stage stamps this into
   *  droppedPairKeys so IconStage drops the orphaned badge. Without it,
   *  curved highway shields render the box with no road number. */
  pairKey?: string
  /** #605 — TILE-STABLE identity of the line this label follows (the
   *  route ref for a shield, the road name for a plain label), qualified
   *  by layer. Passed through to the collision pass's `lineId` so two
   *  along-line symbols on the SAME route closer than `minLineSpacingPx`
   *  collide — capping cross-tile shield repeats in SCREEN space (PMTiles
   *  slices one route into per-tile polylines, so the dispatch-side
   *  per-show dedup alone leaves ~one shield PER tile on screen). Stable
   *  ACROSS tiles by construction: it is the ref/name, never the tile id.
   *  Undefined → not subject to same-line spacing (the historical path). */
  lineId?: string
  /** #605 — the anchor's along-polyline screen offset (px), forwarded to
   *  the collision pass's `anchorDistancePx`. Same-`lineId` anchors within
   *  `minLineSpacingPx` of an already-placed one are dropped. Undefined →
   *  unused. */
  anchorDistancePx?: number
}
