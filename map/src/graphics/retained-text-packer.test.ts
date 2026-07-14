import { describe, it, expect } from 'vitest'
import { lonLatToECEF } from '@xgis/shared'
import {
  packRetainedTextFeat,
  packRetainedTextTint,
  type GlyphShaper,
  type ShapedGlyph,
} from './retained-text-packer'
import {
  TEXT_RETAINED_FEAT,
  TEXT_RETAINED_TINT_STRIDE,
} from '../shaders/dsl/text-retained-feat-layout'
import type { TextDrawSpec } from './graphics-types'

const F = TEXT_RETAINED_FEAT.slot
const S = TEXT_RETAINED_FEAT.stride

// ── Stub glyph source with KNOWN metrics (mission: pack against a stubbed shaper). ──
// Uniform monospace-ish glyph: advance 10, bearingX 1, bearingY 8, bbox 8×8, slot 16² at (32,64)
// on a 256² page, baked at 16 px. With fontSize 16 → scale 1, drawW=drawH=16, so the intra-glyph
// quad top-left x = bearingX - (drawW - width)/2 = 1 - (16-8)/2 = -3, and y (below baseline) =
// -bearingY - (drawH - height)/2 = -8 - 4 = -12.
const RASTER = 16
function glyph(cp: number, over: Partial<ShapedGlyph> = {}): ShapedGlyph {
  return {
    codepoint: cp,
    advanceWidth: 10,
    bearingX: 1,
    bearingY: 8,
    width: 8,
    height: 8,
    rasterFontSize: RASTER,
    slot: { pxX: 32, pxY: 64, size: 16, page: 0 },
    ...over,
  }
}

const PAGE = 256
function makeShaper(): { shaper: GlyphShaper; shapeCalls: () => number } {
  let calls = 0
  return {
    shapeCalls: () => calls,
    shaper: {
      pageSize: PAGE,
      shape: (_fontKey, text) => {
        calls++
        const out: ShapedGlyph[] = []
        for (const ch of text) out.push(glyph(ch.codePointAt(0)!))
        return out
      },
    },
  }
}

interface Place {
  lngLat: readonly [number, number]
  name: string
}
const places: Place[] = [
  { lngLat: [10, 20], name: 'ab' },
  { lngLat: [126.98, 37.57], name: 'xyz' }, // Seoul
]

function textSpec(overrides: Partial<TextDrawSpec<Place>> = {}): TextDrawSpec<Place> {
  return {
    type: 'text',
    data: places,
    getPosition: (p) => p.lngLat,
    getText: (p) => p.name,
    anchor: 'left',
    ...overrides,
  }
}

describe('#797 P2b retained-text packer', () => {
  it('runs each accessor EXACTLY ONCE per datum and shapes each string ONCE', () => {
    let posCalls = 0
    let textCalls = 0
    let sizeCalls = 0
    let colorCalls = 0
    const { shaper, shapeCalls } = makeShaper()
    const spec = textSpec({
      getPosition: (p) => {
        posCalls++
        return p.lngLat
      },
      getText: (p) => {
        textCalls++
        return p.name
      },
      getSize: () => {
        sizeCalls++
        return 16
      },
      getColor: () => {
        colorCalls++
        return [1, 0, 0, 1]
      },
    })
    const { glyphCounts } = packRetainedTextFeat(spec, shaper, 1)
    packRetainedTextTint(spec, glyphCounts)
    const n = places.length
    expect(posCalls).toBe(n)
    expect(textCalls).toBe(n)
    expect(sizeCalls).toBe(n)
    expect(shapeCalls()).toBe(n) // one shape() per datum — no per-frame re-shaping
    expect(colorCalls).toBe(n) // color packed into tint, once per datum
  })

  it('tint pack replicates the datum colour across its glyphs and touches ONLY getColor', () => {
    let posCalls = 0
    let textCalls = 0
    let sizeCalls = 0
    const { shaper } = makeShaper()
    const spec = textSpec({
      getPosition: (p) => {
        posCalls++
        return p.lngLat
      },
      getText: (p) => {
        textCalls++
        return p.name
      },
      getSize: () => {
        sizeCalls++
        return 16
      },
      getColor: (p) => (p.name === 'ab' ? [1, 0, 0, 1] : [0, 0, 1, 1]),
    })
    const { glyphCounts } = packRetainedTextFeat(spec, shaper, 1)
    // reset the counters the feat pack touched — the tint pack must NOT re-run them.
    posCalls = textCalls = sizeCalls = 0
    const tint = packRetainedTextTint(spec, glyphCounts)
    // update({triggers:['color']}) re-packs tint only → position/text/size NOT re-run, NO re-shape.
    expect(posCalls).toBe(0)
    expect(textCalls).toBe(0)
    expect(sizeCalls).toBe(0)
    // glyphCounts = [2 ('ab'), 3 ('xyz')] → 5 glyph instances, 2 red then 3 blue.
    expect([...glyphCounts]).toEqual([2, 3])
    expect(tint.length).toBe(5 * TEXT_RETAINED_TINT_STRIDE)
    expect([tint[0], tint[1], tint[2], tint[3]]).toEqual([1, 0, 0, 1]) // glyph 0 = 'a' → red
    expect([tint[4], tint[5], tint[6], tint[7]]).toEqual([1, 0, 0, 1]) // glyph 1 = 'b' → red
    expect([tint[8], tint[9], tint[10], tint[11]]).toEqual([0, 0, 1, 1]) // glyph 2 = 'x' → blue
    expect([tint[16], tint[17], tint[18], tint[19]]).toEqual([0, 0, 1, 1]) // glyph 4 = 'z' → blue
  })

  it('packs the anchor DSFUN once per datum, SHARED across all its glyphs', () => {
    const { shaper } = makeShaper()
    const { feat } = packRetainedTextFeat(textSpec(), shaper, 1)
    // 'ab' → glyphs 0,1 share place[0]; 'xyz' → glyphs 2,3,4 share place[1].
    const anchorOf = [0, 0, 1, 1, 1]
    for (let inst = 0; inst < 5; inst++) {
      const o = inst * S
      const [lon, lat] = places[anchorOf[inst]!]!.lngLat
      expect(feat[o + F.abs_lon]).toBeCloseTo(lon, 3)
      expect(feat[o + F.abs_lat]).toBeCloseTo(lat, 3)
      const ecef = lonLatToECEF(lon, lat)
      expect(feat[o + F.ecef_x_h]).toBe(Math.fround(ecef[0]))
      expect(feat[o + F.ecef_x_h] + feat[o + F.ecef_x_l]).toBeCloseTo(ecef[0], 6)
    }
  })

  it('pen-walks the glyph quad offsets (left anchor): x advances by advance, y is constant', () => {
    // Single place 'abc', anchor left → baseX 0, baseY 0.5×16 = 8. Intra-glyph x = -3, y = 8-12 = -4.
    const { shaper } = makeShaper()
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [{ lngLat: [0, 0], name: 'abc' }],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
      anchor: 'left',
    }
    const { feat } = packRetainedTextFeat(spec, shaper, 1)
    const offX = [0, 1, 2].map((i) => feat[i * S + F.off_x])
    expect(offX).toEqual([-3, 7, 17]) // pen 0/10/20 minus the 3 px intra-glyph inset
    for (let i = 0; i < 3; i++) {
      expect(feat[i * S + F.off_y]).toBe(-4)
      expect(feat[i * S + F.size_w]).toBe(16)
      expect(feat[i * S + F.size_h]).toBe(16)
    }
  })

  it('block anchor shifts the pen origin — center/right horizontal, top/bottom vertical', () => {
    const { shaper } = makeShaper()
    const mk = (anchor: TextDrawSpec<Place>['anchor']) => {
      const spec: TextDrawSpec<Place> = {
        type: 'text',
        data: [{ lngLat: [0, 0], name: 'abc' }],
        getPosition: (p) => p.lngLat,
        getText: (p) => p.name,
        anchor,
      }
      return packRetainedTextFeat(spec, shaper, 1).feat
    }
    // lineW = 3 × advance(10) = 30. center → baseX -15, right → baseX -30.
    expect(mk('center')[F.off_x]).toBe(-18) // -15 + 0 - 3
    expect(mk('center')[2 * S + F.off_x]).toBe(2) // -15 + 20 - 3
    expect(mk('right')[F.off_x]).toBe(-33) // -30 + 0 - 3
    // vertical baseline offset = vFactor × fontSize; glyph y = baseY - 12.
    expect(mk('top')[F.off_y]).toBe(4) // vFactor 1 → baseY 16 → 16-12
    expect(mk('bottom')[F.off_y]).toBe(-12) // vFactor 0 → baseY 0 → 0-12
    expect(mk('left')[F.off_y]).toBe(-4) // vFactor 0.5 → baseY 8 → 8-12
  })

  it('packs the atlas UV rect + page from each glyph slot', () => {
    // Two glyphs on different pages/slots to prove per-glyph UV + page (not a shared constant).
    const shaper: GlyphShaper = {
      pageSize: 256,
      shape: () => [
        glyph(65, { slot: { pxX: 32, pxY: 64, size: 16, page: 0 } }),
        glyph(66, { slot: { pxX: 128, pxY: 0, size: 32, page: 3 } }),
      ],
    }
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [{ lngLat: [0, 0], name: 'AB' }],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
      anchor: 'left',
    }
    const { feat } = packRetainedTextFeat(spec, shaper, 1)
    // glyph 0: 16² slot at (32,64) on 256².
    expect(feat[F.u0]).toBeCloseTo(32 / 256, 6)
    expect(feat[F.v0]).toBeCloseTo(64 / 256, 6)
    expect(feat[F.u1]).toBeCloseTo((32 + 16) / 256, 6)
    expect(feat[F.v1]).toBeCloseTo((64 + 16) / 256, 6)
    expect(feat[F.page]).toBe(0)
    // glyph 1: 32² slot at (128,0) on page 3.
    expect(feat[S + F.u0]).toBeCloseTo(128 / 256, 6)
    expect(feat[S + F.u1]).toBeCloseTo((128 + 32) / 256, 6)
    expect(feat[S + F.page]).toBe(3)
  })

  it('DPR scales the offsets + sizes but NOT the UV rect', () => {
    const { shaper } = makeShaper()
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [{ lngLat: [0, 0], name: 'a' }],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
      anchor: 'left',
    }
    const { feat } = packRetainedTextFeat(spec, shaper, 2)
    expect(feat[F.off_x]).toBe(-6) // -3 × dpr 2
    expect(feat[F.off_y]).toBe(-8) // -4 × dpr 2
    expect(feat[F.size_w]).toBe(32) // 16 × dpr 2
    expect(feat[F.size_h]).toBe(32)
    expect(feat[F.u0]).toBeCloseTo(32 / 256, 6) // UV is resolution-independent
  })

  it('skips newline glyphs — no instance, no pen advance', () => {
    const { shaper } = makeShaper()
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [{ lngLat: [0, 0], name: 'a\nb' }],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
      anchor: 'left',
    }
    const { feat, glyphCounts } = packRetainedTextFeat(spec, shaper, 1)
    expect(glyphCounts[0]).toBe(2) // newline is not an instance
    expect(feat.length).toBe(2 * S)
    // 'b' packs at pen 10 (the newline neither drew nor advanced the pen).
    expect(feat[F.off_x]).toBe(-3) // 'a' at pen 0
    expect(feat[S + F.off_x]).toBe(7) // 'b' at pen 10
  })

  it('glyphCounts + total instances exclude newlines', () => {
    const { shaper } = makeShaper()
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [
        { lngLat: [0, 0], name: 'ab' },
        { lngLat: [1, 1], name: 'a\nb\nc' },
        { lngLat: [2, 2], name: '' },
      ],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
    }
    const { feat, glyphCounts } = packRetainedTextFeat(spec, shaper, 1)
    expect([...glyphCounts]).toEqual([2, 3, 0]) // newlines + empty string excluded
    expect(feat.length).toBe(5 * S) // 2 + 3 + 0 instances
  })

  it('defaults: font size 16 and white fill when getSize / getColor are absent', () => {
    const { shaper } = makeShaper()
    const spec: TextDrawSpec<Place> = {
      type: 'text',
      data: [{ lngLat: [0, 0], name: 'a' }],
      getPosition: (p) => p.lngLat,
      getText: (p) => p.name,
      anchor: 'left',
    }
    const { feat, glyphCounts } = packRetainedTextFeat(spec, shaper, 1)
    // getSize absent → 16 px → scale 1 → drawW 16 (proves the default flowed through).
    expect(feat[F.size_w]).toBe(16)
    const tint = packRetainedTextTint(spec, glyphCounts)
    expect([tint[0], tint[1], tint[2], tint[3]]).toEqual([1, 1, 1, 1]) // getColor absent → white
  })
})
