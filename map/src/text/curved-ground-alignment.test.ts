// #2012 INC-4 — the curved label's END-TO-END ground wiring, through the REAL
// TextStage.prepare().
//
// The unit gates either side of this file pin the halves: curved-glyph-walk.test
// pins the plane walk + pre-image, text-ground-basis-wiring.test pins what the
// renderer does with a basis and a pivot. Neither can see the seam between them,
// and #1081 is the standing reminder of what a dry seam looks like: a complete,
// correct chain that delivers nothing, with a 0.000 % pixel diff to prove it. So
// this drives `addCurvedLineLabel` with the ground arguments the label pass sends
// and asserts the three things that must arrive on the TextDraw:
//
//   1. `groundBasis` reaches the draw (`labels.groundAligned` reads it there),
//   2. `groundBasisPivot` is the LIVE screen point at the label centre, and
//   3. the collision bbox is the footprint of the quads the renderer will draw —
//      same basis, same pivot, same offsets — because a label that lies down while
//      its box stays upright reserves the wrong footprint.
//
// Same harness as curved-line-shaping.test.ts (MockRasterizer: advance 14.4 at
// rasterFontSize 24, so size 20 / dpr 1 ⇒ 12 px per glyph, verticalOffset 8).

import { describe, it, expect } from 'vitest'
import { TextStage } from '@xgis/map'
import { MockRasterizer } from '@xgis/map'
import { WebGpuDevice } from '@xgis/rhi-webgpu'
import type { LabelDef, TextValue } from '@xgis/compiler'
import type { TextDraw } from '@xgis/map'
import { groundBasisAabb } from './ground-basis'

const g = globalThis as Record<string, unknown>
g.GPUShaderStage ??= { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 }
g.GPUBufferUsage ??= {
  MAP_READ: 1,
  MAP_WRITE: 2,
  COPY_SRC: 4,
  COPY_DST: 8,
  INDEX: 16,
  VERTEX: 32,
  UNIFORM: 64,
  STORAGE: 128,
  INDIRECT: 256,
  QUERY_RESOLVE: 512,
}
g.GPUTextureUsage ??= {
  COPY_SRC: 1,
  COPY_DST: 2,
  TEXTURE_BINDING: 4,
  STORAGE_BINDING: 8,
  RENDER_ATTACHMENT: 16,
}
g.GPUColorWrite ??= { RED: 1, GREEN: 2, BLUE: 4, ALPHA: 8, ALL: 15 }

function stubDevice(): GPUDevice {
  const stub: unknown = new Proxy(
    function () {
      return stub
    },
    {
      get(_t, p) {
        if (p === 'size') return 1 << 22
        if (p === 'width' || p === 'height') return 4096
        if (p === 'limits') return { maxTextureDimension2D: 8192 }
        if (p === Symbol.toPrimitive) return () => 0
        return stub
      },
      apply() {
        return stub
      },
    },
  )
  return stub as GPUDevice
}

function litValue(s: string): TextValue {
  return { kind: 'expr', expr: { ast: { kind: 'StringLiteral', value: s } as never } }
}

function curvedDef(extra: Partial<LabelDef> = {}): LabelDef {
  return {
    text: litValue(''),
    size: 20,
    letterSpacing: 0,
    font: ['Noto Sans Bold'],
    placement: 'line',
    padding: 2,
    ...extra,
  } as LabelDef
}

function makeStage() {
  const stage = new TextStage(stubDevice(), new WebGpuDevice(stubDevice()), 'bgra8unorm', {
    rasterizer: new MockRasterizer(),
  })
  const captured: TextDraw[][] = []
  ;(stage as unknown as { renderer: { setDraws(d: TextDraw[]): void } }).renderer.setDraws = (
    d: TextDraw[],
  ) => {
    captured.push(d)
  }
  return { stage, captured }
}

/** The renderer's transform (text-renderer.ts), restated so the assertions below
 *  are against the contract rather than against the stage's own arithmetic. */
function applyBasis(
  b: ArrayLike<number>,
  pvx: number,
  pvy: number,
  x: number,
  y: number,
): [number, number] {
  const dx = x - pvx,
    dy = y - pvy
  return [pvx + dx * b[0]! + dy * b[2]!, pvy + dx * b[1]! + dy * b[3]!]
}

// Plane run 0→1000 px; its live twin compresses the far half, the way a road
// running away from a pitched camera does.
const PLANE_X = new Float32Array([0, 500, 1000])
const PLANE_Y = new Float32Array([100, 100, 100])
const LIVE_X = new Float32Array([0, 400, 700])
const LIVE_Y = new Float32Array([100, 100, 100])
/** Pitch-60-shaped: screen-horizontal untouched, screen-vertical halved. */
const BASIS: readonly [number, number, number, number] = [1, 0, 0, 0.5]

function drive(ground?: {
  liveX: Float32Array
  liveY: Float32Array
  basis: ArrayLike<number> | undefined
  /** #2012 INC-5 — defaulted so the pre-INC-5 cases stay spelled as they were;
   *  1 is the no-correction identity. */
  sizeScale?: number
}): { draw: TextDraw } {
  const { stage, captured } = makeStage()
  stage.beginFrame()
  stage.addCurvedLineLabel(
    litValue('AB'),
    {},
    PLANE_X,
    PLANE_Y,
    500,
    curvedDef(),
    undefined,
    'roads',
    undefined,
    undefined,
    undefined,
    undefined,
    ground && { ...ground, sizeScale: ground.sizeScale ?? 1 },
  )
  stage.prepare()
  const draw = captured[0]!.find((d) => d.glyphRotations !== undefined)!
  expect(draw, 'curved draw missing').toBeDefined()
  return { draw }
}

describe('#2012 INC-5 — the map-branch size correction reaches the curved draw', () => {
  // The claim: `groundSizeScale` multiplies the label's sizePx, which is the
  // SINGLE quad authority — so the drawn font size, the glyph advances and the
  // collision box all move with it. Asserted on quantities the walk actually
  // MOVES (fontSize and the along-run advance between the two glyphs), not on a
  // count, because a count cannot tell "the label got bigger" from "the label got
  // placed".

  it('scales the drawn fontSize by exactly the multiplier it was handed', () => {
    const base = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1 })
    const grown = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 2 })
    expect(grown.draw.fontSize).toBeCloseTo(base.draw.fontSize * 2, 6)
  })

  it('grows the GLYPH ADVANCE too — the quad authority, not a draw-time fudge', () => {
    // If the multiplier were applied to the quad alone, the glyphs would keep
    // their old spacing and overlap. The advance is measured in the label plane
    // and mapped back through the correspondence, so it is read off the stored
    // pre-image offsets.
    const base = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1 })
    const grown = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 2 })
    const span = (d: TextDraw): number => {
      const o = d.glyphOffsets!
      return Math.abs(o[2]! - o[0]!)
    }
    expect(span(grown.draw)).toBeGreaterThan(span(base.draw) * 1.5)
  })

  it('a multiplier of 1 sizes exactly like the no-correction path', () => {
    // The no-regression rung. An unpitched frame withholds the basis entirely, so it
    // never gets here — but a pitched anchor sitting exactly at the camera centre
    // distance produces 1, and must not perturb the size.
    //
    // The comparison arm has to be a run that genuinely TAKES the uncorrected path,
    // not the same input spelled twice: `drive` normalises `sizeScale ?? 1` before it
    // reaches the stage, so omitting the field here would hand both arms an identical
    // object and the assertion would hold for any value of the fallback constant
    // (#2110 review). A basis-LESS run is the reachable uncorrected arm — it leaves
    // `PendingLineLabel.groundSizeScale` undefined and so exercises the `?? 1` in
    // `text-stage.ts`. Only the SIZE is comparable: without a basis there is no
    // pre-image step, so the offsets legitimately differ.
    const corrected = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1 })
    const uncorrected = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: undefined })
    expect(corrected.draw.fontSize).toBe(uncorrected.draw.fontSize)
    // …and the pairing is not vacuous: a non-1 multiplier does move it.
    const grown = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 2 })
    expect(grown.draw.fontSize).not.toBe(uncorrected.draw.fontSize)
  })

  it('is QUANTISED to 1/64, so a pitched pan cannot thrash the layout cache', () => {
    // The cache is keyed on the resulting sizePx (layoutCacheKey). Two multipliers
    // inside one 1/64 step must therefore produce the SAME size, or every frame of
    // a tilt mints a fresh entry and the steady scene becomes all-miss.
    const a = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1.5 })
    const b = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1.5 + 1 / 500 })
    expect(b.draw.fontSize).toBe(a.draw.fontSize)
    // And a step of a full 1/64 DOES move it, or the quantisation is a constant.
    const c = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS, sizeScale: 1.5 + 1 / 64 })
    expect(c.draw.fontSize).toBeGreaterThan(a.draw.fontSize)
  })
})

describe('#2012 INC-4 — a curved label carries its basis and pivot to the draw', () => {
  it('reaches TextDraw.groundBasis + groundBasisPivot (the #1081 dry-seam guard)', () => {
    const { draw } = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS })
    expect(draw.groundBasis, 'the basis never reached the draw').toBeDefined()
    expect(Array.from(draw.groundBasis as ArrayLike<number>)).toEqual([1, 0, 0, 0.5])
    expect(draw.groundBasisPivot, 'the pivot never reached the draw').toBeDefined()
    // centerOffsetPx 500 is exactly plane vertex 1 ⇒ live x 400, y 100.
    expect(draw.groundBasisPivot![0]).toBeCloseTo(400, 6)
    expect(draw.groundBasisPivot![1]).toBeCloseTo(100, 6)
  })

  it('lands every glyph on the LIVE polyline once the renderer applies the basis', () => {
    const { draw } = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS })
    const off = draw.glyphOffsets!
    const pv = draw.groundBasisPivot!
    // "AB": totalAdvance 24, centre 500 ⇒ plane cursors 488 and 500.
    //   488 → plane seg 0 (0→500) at t 0.976 ⇒ live 0 + 400·0.976 = 390.4
    //   500 → plane vertex 1                 ⇒ live 400
    const expectedLive = [390.4, 400]
    for (let gi = 0; gi < 2; gi++) {
      const [rx, ry] = applyBasis(BASIS, pv[0], pv[1], off[gi * 2]!, off[gi * 2 + 1]!)
      expect(rx).toBeCloseTo(expectedLive[gi]!, 3)
      // The 8 px perpendicular is a MAP-PLANE offset, so it draws at 8·0.5 = 4.
      expect(ry).toBeCloseTo(104, 3)
    }
  })

  it('stores the PRE-IMAGE, which is not what gets drawn', () => {
    const withBasis = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS })
    const off = withBasis.draw.glyphOffsets!
    // Road at y 100 with an 8 px perpendicular: the stored offset is 108 (the
    // shift is a MAP-PLANE quantity) and the renderer draws it at
    // 100 + 8·0.5 = 104. Stored ≠ drawn is the whole point of the pre-image —
    // a wiring that wrote the drawn position would store 104 and draw 102.
    expect(off[1]!).toBeCloseTo(108, 3)
    const [, drawnY] = applyBasis(
      BASIS,
      withBasis.draw.groundBasisPivot![0],
      withBasis.draw.groundBasisPivot![1],
      off[0]!,
      off[1]!,
    )
    expect(drawnY).toBeCloseTo(104, 3)
    expect(off[1]!).not.toBeCloseTo(drawnY, 1)
    // And x IS the live correspondence position, not the plane cursor 488.
    expect(off[0]!).toBeCloseTo(390.4, 2)
  })

  it('keeps a basis-less curved label byte-identical to the pre-INC-4 draw', () => {
    const plain = drive()
    const planeOnly = drive({ liveX: PLANE_X, liveY: PLANE_Y, basis: undefined })
    expect(plain.draw.groundBasis).toBeUndefined()
    expect(plain.draw.groundBasisPivot).toBeUndefined()
    expect(planeOnly.draw.groundBasis).toBeUndefined()
    expect(planeOnly.draw.groundBasisPivot).toBeUndefined()
    expect(Array.from(planeOnly.draw.glyphOffsets!)).toEqual(Array.from(plain.draw.glyphOffsets!))
    expect(Array.from(planeOnly.draw.glyphRotations!)).toEqual(
      Array.from(plain.draw.glyphRotations!),
    )
  })
})

describe('#2012 INC-4 — the collision box is the footprint of the drawn quads', () => {
  /** Two parallel roads 18 px apart on screen, each labelled. Upright, the two
   *  24-px-tall boxes (halfH 10 + padding 2 either side) overlap and the collision
   *  pass drops one. Lying in the ground plane the boxes are 12 px tall and both
   *  survive. Observed through what actually reaches the renderer, so no private
   *  surface is involved and the assertion is about BEHAVIOUR: a label that lies
   *  down while its box stays upright reserves the wrong footprint, loses
   *  collisions it should win, and blocks labels it should not. */
  function drawCount(ground: boolean): number {
    const { stage, captured } = makeStage()
    stage.beginFrame()
    for (const [text, y] of [
      ['AB', 100],
      ['CD', 118],
    ] as const) {
      const planeY = new Float32Array([y, y, y])
      const liveY = new Float32Array([y, y, y])
      stage.addCurvedLineLabel(
        litValue(text),
        {},
        PLANE_X,
        planeY,
        500,
        curvedDef(),
        undefined,
        'roads',
        undefined,
        undefined,
        undefined,
        undefined,
        ground ? { liveX: PLANE_X, liveY, basis: BASIS, sizeScale: 1 } : undefined,
      )
    }
    stage.prepare()
    return captured[0]!.filter((d) => d.glyphRotations !== undefined).length
  }

  it('upright boxes collide; ground-plane boxes do not — the footprint really tilts', () => {
    expect(drawCount(false)).toBe(1)
    expect(drawCount(true)).toBe(2)
  })

  it('the drawn quads agree with that box: predicted AABB == basis-image of the padded run', () => {
    // Same basis, same pivot, same offsets as the quads, derived independently
    // from the draw the renderer receives.
    const { draw } = drive({ liveX: LIVE_X, liveY: LIVE_Y, basis: BASIS })
    const off = draw.glyphOffsets!
    const pv = draw.groundBasisPivot!
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity
    for (let gi = 0; gi < 2; gi++) {
      minX = Math.min(minX, off[gi * 2]!)
      maxX = Math.max(maxX, off[gi * 2]!)
      minY = Math.min(minY, off[gi * 2 + 1]!)
      maxY = Math.max(maxY, off[gi * 2 + 1]!)
    }
    const r = 10 + 2 // halfH + padding, in the SAME (pre-image) space
    const box = groundBasisAabb(BASIS, pv[0], pv[1], minX - r, minY - r, maxX + r, maxY + r)
    // 24 px of padded height in the plane becomes 12 px on screen.
    expect(box.maxY - box.minY).toBeCloseTo(12, 3)
    // Width is untouched by this basis, so the box still spans the glyph run.
    expect(box.maxX - box.minX).toBeCloseTo(maxX - minX + 2 * r, 3)
    // Non-vacuity: the upright box is genuinely taller.
    expect(box.maxY - box.minY).toBeLessThan(maxY - minY + 2 * r)
  })
})
