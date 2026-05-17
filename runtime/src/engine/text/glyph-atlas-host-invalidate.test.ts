import { describe, it, expect, beforeEach } from 'vitest'
import { GlyphAtlasHost } from './sdf/glyph-atlas-host'
import {
  type GlyphRasterizer, type GlyphRasterRequest, type GlyphRasterResult,
} from './sdf/glyph-rasterizer'
import { computeSDF } from './sdf/distance-transform'

const cfg = { slotSize: 24, pageSize: 96 }
const opts = { fontSize: 16, sdfRadius: 6 }

/** Rasterizer that tracks calls and emits distinct SDFs per call so we
 *  can distinguish "first rasterise" from "re-rasterise after invalidate". */
class CountingRasterizer implements GlyphRasterizer {
  calls = 0
  rasterize(req: GlyphRasterRequest): GlyphRasterResult {
    this.calls += 1
    const alpha = new Uint8Array(req.slotSize * req.slotSize)
    // Distinct discs by call number so SDF bytes differ between
    // invocations — a re-rasterise of the same key must yield a new
    // SDF object, not a re-served cached one.
    const cx = req.slotSize / 2, cy = req.slotSize / 2
    const r = (req.slotSize / 6) + this.calls
    for (let y = 0; y < req.slotSize; y++) {
      for (let x = 0; x < req.slotSize; x++) {
        const d = Math.hypot(x - cx, y - cy)
        alpha[y * req.slotSize + x] = d < r ? 255 : 0
      }
    }
    const sdf = computeSDF(alpha, req.slotSize, req.slotSize, req.sdfRadius)
    return {
      fontKey: req.fontKey, codepoint: req.codepoint, sdfRadius: req.sdfRadius, sdf,
      advanceWidth: 10 + this.calls, bearingX: 0, bearingY: 10, width: 10, height: 10,
      rasterFontSize: req.fontSize,
    }
  }
}

describe('GlyphAtlasHost.invalidate', () => {
  let ras: CountingRasterizer
  let host: GlyphAtlasHost
  beforeEach(() => {
    ras = new CountingRasterizer()
    host = new GlyphAtlasHost(cfg, ras, opts)
  })

  it('no-op when glyph isn\'t in the atlas yet', () => {
    host.invalidate('noto', 65)
    expect(ras.calls).toBe(0)
    // First ensure still rasterises exactly once.
    host.ensure('noto', 65)
    expect(ras.calls).toBe(1)
  })

  it('forces re-rasterise on next ensure, same slot, updates metrics', () => {
    const a = host.ensure('noto', 65)
    host.consumeDirty()
    expect(ras.calls).toBe(1)

    host.invalidate('noto', 65)
    const b = host.ensure('noto', 65)

    expect(ras.calls).toBe(2)               // re-rasterised
    expect(b.slot).toEqual(a.slot)          // same slot
    expect(b.advanceWidth).toBe(12)         // CountingRasterizer's 10 + calls (=2)
    expect(a.advanceWidth).toBe(11)         // sanity: first call was different
  })

  it('queues a fresh dirty entry on next ensure (GPU re-upload signal)', () => {
    host.ensure('noto', 65)
    host.consumeDirty()                      // drain initial

    host.invalidate('noto', 65)
    host.ensure('noto', 65)
    const dirty = host.consumeDirty()

    expect(dirty).toHaveLength(1)
    expect(dirty[0]!.key.codepoint).toBe(65)
  })

  it('does NOT emit an eviction on invalidate (slot stays bound)', () => {
    host.ensure('noto', 65)
    host.consumeEvictions()                  // drain initial

    host.invalidate('noto', 65)
    host.ensure('noto', 65)

    expect(host.consumeEvictions()).toEqual([])
  })

  it('stale flag clears after the re-rasterise — subsequent ensure is cache hit', () => {
    host.ensure('noto', 65)
    host.invalidate('noto', 65)
    host.ensure('noto', 65)                  // does the re-rasterise
    host.consumeDirty()
    host.ensure('noto', 65)                  // should be a cache hit now

    expect(ras.calls).toBe(2)                // not 3
    expect(host.consumeDirty()).toEqual([])
  })

  it('invalidates per (fontKey, codepoint), not in bulk', () => {
    host.ensure('noto', 65)
    host.ensure('noto', 66)
    host.consumeDirty()

    host.invalidate('noto', 65)              // only A, not B
    host.ensure('noto', 65)
    host.ensure('noto', 66)

    const dirty = host.consumeDirty()
    expect(dirty).toHaveLength(1)
    expect(dirty[0]!.key.codepoint).toBe(65)
  })
})
