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

export const PBF_REF_SIZE = 24  // MapLibre rasterises all glyph PBFs at 24 px
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
  // PBF is ALWAYS baked at its native 24-px reference (scale = 1):
  // an identity byte copy into the slot, no bilinear upsample, no
  // byte rescale. The global rasterFontSize is DPR-scaled for the
  // local Canvas2D path (crisp Hangul); coupling PBF to it
  // reintroduced the resample softening ae5fdab eliminated (thin
  // Latin "Seoul"/"l"). The returned `rasterFontSize: PBF_REF_SIZE`
  // tells the renderer to scale this glyph by sizePx/24 at draw
  // time, so display size is unchanged while the SDF stays 1:1.
  void rasterFontSize  // PBF size is source-fixed, not the global raster
  void sdfRadius       // distance encoding already matches engine convention
  // PBF is baked at its native 24-px reference. Slot is sized for
  // PBF native at this scale (slot=64 fits 24 + 2*8 sdfRadius +
  // headroom). Copy the FULL PBF bitmap (g.width + 2·buffer wide,
  // g.height + 2·buffer tall) into the slot centered, preserving
  // the 3-px outer-falloff buffer the PBF server bakes around every
  // glyph. The buffer pixels carry the SDF gradient from edge byte
  // 192 down to 0 — without them, sampling beyond the glyph's
  // silhouette reads slot zero-padding and the shader smoothstep
  // hits a HARD cutoff at the glyph boundary instead of a smooth
  // falloff into background. Iter 121 root fix for user-reported
  // "S 글자가 박스 형태로 더 얇아짐" at OFM Positron
  // #4.82/36.87/128.90: pixel column scan showed inconsistent ink
  // breaks inside glyph strokes (e.g. y=19 byte=122 in middle of
  // what should be solid black S top arc) — caused by sampling
  // landing exactly at the missing-buffer boundary where the SDF
  // dropped from edge byte 192 to 0 in one pixel.
  const bw = g.width + 2 * PBF_BUFFER
  const bh = g.height + 2 * PBF_BUFFER
  const N = slotSize * slotSize
  const sdf = new Uint8Array(N)
  if (g.bitmap.length > 0 && bw > 0 && bh > 0) {
    const ox = Math.floor((slotSize - bw) / 2)
    const oy = Math.floor((slotSize - bh) / 2)
    // Direct byte copy — no bilinear resample (PBF native = slot
    // raster) and no byte rescale (PBF already encodes 255-per-
    // radius slope matching the shader's haloK=3 convention since
    // iter 114).
    //
    // Bound BOTH loops to the on-slot window. g.width/g.height are
    // untrusted uint32 varints from a network glyph PBF: a huge width
    // with a tiny bitmap (which still passes the length>0 guard) made
    // the inner loop run the full bw per in-range row regardless of
    // the dstX clip — O(slotSize·width) = a multi-second CPU freeze on
    // the first label using that glyph. Iterating only x∈[xStart,xEnd)
    // (dstX in [0,slotSize)) and y∈[yStart,yEnd) caps the copy at
    // O(slotSize²); out-of-window source/dest are never visited.
    const xStart = Math.max(0, -ox)
    const xEnd = Math.min(bw, slotSize - ox)
    const yStart = Math.max(0, -oy)
    const yEnd = Math.min(bh, slotSize - oy)
    for (let y = yStart; y < yEnd; y++) {
      const dstY = oy + y
      const srcBase = y * bw
      const dstBase = dstY * slotSize + ox
      for (let x = xStart; x < xEnd; x++) {
        const src = srcBase + x
        if (src >= g.bitmap.length) break
        sdf[dstBase + x] = g.bitmap[src]!
      }
    }
  }

  return {
    fontKey,
    codepoint: g.id,
    sdfRadius,
    sdf,
    advanceWidth: g.advance,
    bearingX: g.left,
    bearingY: g.top,
    width: g.width,
    height: g.height,
    rasterFontSize: PBF_REF_SIZE,
  }
}
