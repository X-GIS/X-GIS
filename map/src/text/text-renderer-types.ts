// ═══════════════════════════════════════════════════════════════════
// Text Renderer — public types
// ═══════════════════════════════════════════════════════════════════
//
// Top-level types extracted from text-renderer.ts. The renderer class
// and WGSL shader stay in text-renderer.ts, which re-exports these so
// existing `import { ..., type TextDraw } from './text-renderer'` call
// sites keep working unchanged.

import type { GlyphInfo } from './sdf/glyph-atlas-host'

export interface TextDraw {
  /** Anchor in screen pixels — caller projects from (lon, lat). */
  anchorX: number
  anchorY: number
  /** Per-codepoint info from `GlyphAtlasHost.ensureString`. Pen
   *  walks left-to-right starting at anchor. */
  glyphs: GlyphInfo[]
  /** Display size in pixels. Atlas was rasterised at a fixed size;
   *  the shader scales via SDF threshold + quad dimensions. */
  fontSize: number
  /** Atlas rasterisation size (the `fontSize` GlyphAtlasHost was
   *  configured with). Needed at draw time to scale glyph metrics. */
  rasterFontSize: number
  /** RGBA fill colour (0–1 each channel). */
  color: [number, number, number, number]
  /** Optional halo. `width` is in display pixels; `color` is RGBA;
   *  `blur` is the SDF feathering width in display pixels (Mapbox
   *  `text-halo-blur`) — extra smoothstep band on top of the
   *  derivative-AA edge for a soft-glow halo. */
  halo?: { color: [number, number, number, number]; width: number; blur?: number }
  /** Extra pixels between adjacent glyphs (Mapbox text-letter-spacing
   *  in em-units already converted to px by the caller). Applied
   *  AFTER each glyph except the last. */
  letterSpacingPx?: number
  /** Rotation in radians around the (anchorX, anchorY) point.
   *  Mapbox text-rotate is degrees clockwise — caller converts. */
  rotateRad?: number
  /** Optional per-glyph (dx, dy) offsets from (anchorX, anchorY).
   *  When set, the renderer positions each glyph at
   *  (anchorX + offsets[2i], anchorY + offsets[2i+1]) and SKIPS
   *  the pen-advance loop — used by the multiline layout path
   *  in TextStage where line wrapping + justify happens CPU-side
   *  before vertex generation. */
  glyphOffsets?: Float32Array
  /** SDF falloff radius the atlas was rasterised with (px). Used
   *  to convert halo-width-in-px into the SDF byte-space threshold
   *  the shader expects. When unset, falls back to the historical
   *  6-px assumption to preserve old call sites. */
  sdfRadius?: number
  /** Per-glyph rotation (radians, screen-space CW). When set, each
   *  glyph quad rotates around its OWN centre instead of around the
   *  label anchor — required for text-along-curve where neighbouring
   *  glyphs face slightly different tangents. Length must match
   *  glyphs.length; pairs naturally with `glyphOffsets` (which
   *  positions each glyph at its sample point). When set, `rotateRad`
   *  is ignored. */
  glyphRotations?: Float32Array
  /** Label font is italic. Latin glyphs carry a real italic in their
   *  SDF, but the italic glyph PBF serves CJK/Hangul/Kana ideographs
   *  UPRIGHT — so the renderer applies a synthetic oblique shear to the
   *  ideographic-codepoint glyphs of an italic label, matching
   *  MapLibre's local-ideograph oblique. */
  italic?: boolean
}
