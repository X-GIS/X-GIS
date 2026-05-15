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
import type { PbfGlyph } from './glyphs-proto'

const PBF_REF_SIZE = 24       // MapLibre rasterises all glyph PBFs at 24 px
const PBF_BUFFER = 3          // px of outer buffer around the glyph bbox

// One fresh Uint8Array per call — the result is returned and the
// caller (atlas-host) takes ownership. A shared scratch would alias
// the previous call's output. ~4 KB per 64×64 slot is cheap; the
// 100-glyph cold-start burst is bounded by LRU cache size, not
// per-call allocation.

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

  // The PBF arrives pre-rendered as an SDF with byte 192 = edge and
  // the same falloff convention the shader expects (sdfRadius bytes
  // per SDF px). We bilinearly resample the byte SDF directly into
  // the slot — no intermediate binary alpha + recompute.
  //
  // Previous behaviour (commit history before this change): threshold
  // each bilinear sample to 0/255 and re-run computeSDF on the binary
  // mask. The threshold step discarded the original PBF's sub-pixel
  // edge precision (any sample 191.9 was rounded to 0), eroding the
  // glyph silhouette by ~0.5 px per side. Net visual effect: every
  // PBF-sourced label rendered ~1 px thinner than MapLibre on the
  // same PBF data — the user-reported "labels too thin" on the
  // Korea pitched compare view (#12.21/37.19319/127.26829/0/69).
  // Sampling the SDF directly keeps the precision the upstream tile
  // server already encoded.
  //
  // Background pixels OUTSIDE the glyph bbox are set to 0 (= "deep
  // outside the glyph"), matching the PBF buffer-region convention
  // where SDF bytes far from any glyph stroke saturate at 0. The
  // shader smoothstep around edge=192/255 reads these as fully
  // transparent.
  const N = slotSize * slotSize
  const sdf = new Uint8Array(N)

  if (g.bitmap.length > 0 && drawW > 0 && drawH > 0) {
    const bw = g.width + 2 * PBF_BUFFER
    const bh = g.height + 2 * PBF_BUFFER
    const ox = Math.floor((slotSize - drawW) / 2)
    const oy = Math.floor((slotSize - drawH) / 2)

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

        // Clamp to byte range. Bilinear of byte values stays in
        // [0, 255] by construction, but the round-trip via the +/−
        // operations leaves an imprecise FP residue we discard.
        sdf[outRowBase + x] = s < 0 ? 0 : s > 255 ? 255 : (s | 0)
      }
    }
  }
  // sdfRadius is no longer used by this function — the PBF already
  // encodes the radius via its byte-per-SDF-px convention, and we
  // pass the SDF through untouched. Kept in the signature for
  // backward compatibility with the rasterizer chain.
  void sdfRadius

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
