// Bridge a MapLibre PBF glyph into a GlyphRasterResult the engine's
// atlas can consume directly.
//
// Mismatch we have to reconcile:
//   PBF: bitmap is (width+6) × (height+6) — 3-px buffer convention,
//        rasterised at 24 px reference. Edge byte value = 192.
//   Engine: slot is fixed slotSize × slotSize (typically 64), rasterised
//        at rasterFontSize (default 32), SDF radius = 8.
//
// Cleanest path: threshold PBF SDF to binary alpha at byte ≥ 192, scale
// the binary into engine raster space via bilinear-of-SDF (recovers
// subpixel boundary instead of nearest-neighbour staircase), then
// re-run computeSDF at engine's sdfRadius. Same shader threshold + AA
// behaviour applies as for Canvas2D-rasterised glyphs.

import type { GlyphRasterResult } from '../glyph-rasterizer'
import { computeSDF } from '../distance-transform'
import type { PbfGlyph } from './glyphs-proto'

const PBF_REF_SIZE = 24       // MapLibre rasterises all glyph PBFs at 24 px
const PBF_BUFFER = 3          // px of outer buffer around the glyph bbox
const PBF_EDGE_BYTE = 192     // SDF byte value at the glyph edge

// Module-level alpha scratch. Glyphs are pure consumers — they hand
// the byte mask to computeSDF which returns its own Uint8Array; the
// alpha buffer never escapes. Pre-cache one buffer per slotSize to
// avoid the 100-glyph cold-start burst allocating ~400 KB of
// per-call mask buffers (4 KB × 100 = 400 KB → 1 KB once + clear).
let _alphaScratch: Uint8Array = new Uint8Array(0)

export function pbfGlyphToSlot(
  g: PbfGlyph,
  fontKey: string,
  slotSize: number,
  sdfRadius: number,
  rasterFontSize: number,
): GlyphRasterResult {
  const scale = rasterFontSize / PBF_REF_SIZE
  const drawW = Math.round(g.width * scale)
  const drawH = Math.round(g.height * scale)

  // Reuse the scratch when the slot size matches; grow if needed.
  // Always zero out — the bilinear loop only writes inside the
  // glyph bbox, leaving stale bytes from a prior larger glyph's
  // ROI visible to computeSDF as phantom edges.
  const N = slotSize * slotSize
  if (_alphaScratch.length < N) _alphaScratch = new Uint8Array(N)
  const alpha = _alphaScratch.subarray(0, N)
  alpha.fill(0)

  if (g.bitmap.length > 0 && drawW > 0 && drawH > 0) {
    const bw = g.width + 2 * PBF_BUFFER
    const bh = g.height + 2 * PBF_BUFFER
    const ox = Math.floor((slotSize - drawW) / 2)
    const oy = Math.floor((slotSize - drawH) / 2)

    // For each output pixel inside the glyph bbox, bilinearly sample the
    // PBF SDF and threshold to recover binary alpha. The +PBF_BUFFER
    // offsets jump past the PBF's outer buffer band — we just want the
    // glyph silhouette, the engine recomputes its own SDF falloff.
    for (let y = 0; y < drawH; y++) {
      const srcY = (y + 0.5) / scale - 0.5 + PBF_BUFFER
      const yi = Math.floor(srcY)
      const yf = srcY - yi
      if (yi < 0 || yi + 1 >= bh) continue
      const rowBase = yi * bw
      const nextRowBase = (yi + 1) * bw
      const outRowBase = (oy + y) * slotSize + ox

      for (let x = 0; x < drawW; x++) {
        const srcX = (x + 0.5) / scale - 0.5 + PBF_BUFFER
        const xi = Math.floor(srcX)
        const xf = srcX - xi
        if (xi < 0 || xi + 1 >= bw) continue

        const i00 = g.bitmap[rowBase + xi]!
        const i10 = g.bitmap[rowBase + xi + 1]!
        const i01 = g.bitmap[nextRowBase + xi]!
        const i11 = g.bitmap[nextRowBase + xi + 1]!
        const top = i00 + (i10 - i00) * xf
        const bot = i01 + (i11 - i01) * xf
        const s = top + (bot - top) * yf

        alpha[outRowBase + x] = s >= PBF_EDGE_BYTE ? 255 : 0
      }
    }
  }

  const sdf = computeSDF(alpha, slotSize, slotSize, sdfRadius)

  return {
    fontKey,
    codepoint: g.id,
    sdfRadius,
    sdf,
    advanceWidth: g.advance * scale,
    bearingX: g.left * scale,
    bearingY: g.top * scale,
    width: g.width * scale,
    height: g.height * scale,
  }
}
