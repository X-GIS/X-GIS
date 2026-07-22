import { describe, it, expect } from 'vitest'
import {
  holdoverSimilarityValid,
  reprojectTextHoldover,
  reprojectIconHoldover,
  makeBakeFrame,
  holdoverDrawToEmit,
  type HoldoverBakeFrame,
  type MotionHoldoverCtx,
  type HoldoverTransform,
} from './holdover-reproject'

// Smooth fade-out DURING zoom/pan. A label that leaves the placement set mid-
// zoom used to POP (its holdover was suppressed while the camera moved, because
// the clone bakes absolute screen px) — fade-in still worked, so the asymmetry
// read as a blink. The fix reprojects the frozen clone onto the current frame
// via the #1177 replay similarity (current_px = baked_px·scale + shift), so it
// fades IN PLACE. These pin the reprojection math + the similarity gate.

interface TD {
  anchorX: number
  anchorY: number
  glyphs: never[]
  fontSize: number
  rasterFontSize: number
  color: [number, number, number, number]
  letterSpacingPx?: number
  halo?: { color: [number, number, number, number]; width: number; blur?: number }
  glyphOffsets?: Float32Array
}
const draw = (over: Partial<TD> = {}): TD => ({
  anchorX: 100,
  anchorY: 200,
  glyphs: [],
  fontSize: 16,
  rasterFontSize: 24,
  color: [1, 1, 1, 1],
  ...over,
})

describe('reprojectTextHoldover — fade-out clone tracks the map during zoom', () => {
  it('identity transform leaves geometry byte-identical (the idle path must not drift)', () => {
    const d = draw({ fontSize: 16, letterSpacingPx: 2 })
    const out = reprojectTextHoldover(d, { scale: 1, dx: 0, dy: 0 })
    expect(out.anchorX).toBe(100)
    expect(out.anchorY).toBe(200)
    expect(out.fontSize).toBe(16)
    expect(out.letterSpacingPx).toBe(2)
  })

  it('FAIL-BEFORE intuition: a stale (un-reprojected) clone sits at the OLD px; reproject moves it to where a fresh bake would', () => {
    // Zoom-in ×1.25 about the origin, camera pan of (+10,-5) px. A fresh label
    // for the same feature would land at anchor·1.25 + shift; the pre-fix
    // holdover stayed at (100,200) → visibly lagged, then popped.
    const out = reprojectTextHoldover(draw(), { scale: 1.25, dx: 10, dy: -5 })
    expect(out.anchorX).toBeCloseTo(100 * 1.25 + 10, 9) // 135
    expect(out.anchorY).toBeCloseTo(200 * 1.25 - 5, 9) // 245
    expect(out.anchorX).not.toBe(100) // NOT the stale baked position
  })

  it('scales every size-bearing field by scale so the label grows with the zoom', () => {
    const d = draw({
      fontSize: 16,
      letterSpacingPx: 3,
      halo: { color: [0, 0, 0, 1], width: 2, blur: 1 },
      glyphOffsets: new Float32Array([4, 8, -4, 8]),
    })
    const out = reprojectTextHoldover(d, { scale: 2, dx: 0, dy: 0 })
    expect(out.fontSize).toBe(32)
    expect(out.letterSpacingPx).toBe(6)
    expect(out.halo!.width).toBe(4)
    expect(out.halo!.blur).toBe(2)
    expect(Array.from(out.glyphOffsets!)).toEqual([8, 16, -8, 16])
    // NORMALISED halo edge (halo.width / fontSize, the shader's pack ratio) is
    // scale-invariant — the halo stays proportional as the glyph grows.
    expect(out.halo!.width / out.fontSize).toBeCloseTo(d.halo!.width / d.fontSize, 9)
  })

  it('returns a COPY — the stored clone stays baked so the next prepare re-solves from the same origin', () => {
    const d = draw({ glyphOffsets: new Float32Array([4, 8]) })
    const out = reprojectTextHoldover(d, { scale: 3, dx: 1, dy: 1 })
    expect(d.anchorX).toBe(100) // source untouched
    expect(d.glyphOffsets![0]).toBe(4)
    expect(out.glyphOffsets).not.toBe(d.glyphOffsets)
  })

  it('COMPOSITION: reproject(bake→prepare) then the shader replay(prepare→now) equals the single bake→now similarity', () => {
    // The stage bakes the holdover to the CURRENT prepare via reproject; the
    // renderer then applies the global replay (prepare→now) per vertex. The two
    // must compose to the exact bake→now transform, else a fading label would
    // diverge from the live labels around it. Similarities compose as
    // (p·s1+d1)·s2+d2 = p·(s1·s2) + (d1·s2+d2).
    const s1 = 1.1,
      d1x = 7,
      d1y = -3 // bake → prepare
    const s2 = 1.2,
      d2x = -4,
      d2y = 9 // prepare → now (shader replay)
    const p0 = draw({ anchorX: 137, anchorY: 91 })
    const afterReproject = reprojectTextHoldover(p0, { scale: s1, dx: d1x, dy: d1y })
    // Shader replay is per-vertex px·s2 + shift.
    const composedX = afterReproject.anchorX * s2 + d2x
    const composedY = afterReproject.anchorY * s2 + d2y
    // Single bake → now similarity.
    const directX = 137 * (s1 * s2) + (d1x * s2 + d2x)
    const directY = 91 * (s1 * s2) + (d1y * s2 + d2y)
    expect(composedX).toBeCloseTo(directX, 9)
    expect(composedY).toBeCloseTo(directY, 9)
  })
})

describe('holdoverSimilarityValid — reproject only when the similarity is exact', () => {
  const bake = (over: Partial<HoldoverBakeFrame> = {}): HoldoverBakeFrame => ({
    refs: new Float64Array(12),
    bearingKey: 0,
    canvasW: 800,
    canvasH: 600,
    ...over,
  })
  const ctx = (over: Partial<MotionHoldoverCtx> = {}): MotionHoldoverCtx => ({
    bearingKey: 0,
    canvasW: 800,
    canvasH: 600,
    refs: new Float64Array(12),
    solve: () => null,
    ...over,
  })

  it('accepts an unchanged bearing + canvas (pure zoom/pan — the exact regime)', () => {
    expect(holdoverSimilarityValid(bake(), ctx())).toBe(true)
  })

  it('rejects a bearing change (a rotation is NOT a scale+translate → would misplace the vanishing label)', () => {
    expect(holdoverSimilarityValid(bake({ bearingKey: 0 }), ctx({ bearingKey: 4500 }))).toBe(false)
  })

  it('rejects a canvas resize (the screen centre moved → the solved shift would be wrong)', () => {
    expect(holdoverSimilarityValid(bake({ canvasW: 800 }), ctx({ canvasW: 1024 }))).toBe(false)
    expect(holdoverSimilarityValid(bake({ canvasH: 600 }), ctx({ canvasH: 720 }))).toBe(false)
  })
})

describe('makeBakeFrame — one refs COPY per prepare, null off the safe path', () => {
  const ctx = (): MotionHoldoverCtx => ({
    bearingKey: 3,
    canvasW: 800,
    canvasH: 600,
    refs: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    solve: () => null,
  })

  it('returns null when the camera is not similarity-safe (ctx undefined → later fade-outs pop)', () => {
    expect(makeBakeFrame(undefined)).toBeNull()
  })

  it('snapshots bearing + canvas and COPIES refs (the ctx buffer is reused next prepare)', () => {
    const c = ctx()
    const bake = makeBakeFrame(c)!
    expect(bake.bearingKey).toBe(3)
    expect(bake.canvasW).toBe(800)
    expect(bake.canvasH).toBe(600)
    expect(Array.from(bake.refs)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    // Mutating the source buffer must NOT change the snapshot (a per-prepare
    // shared buffer would otherwise corrupt every stamped holdover).
    c.refs[0] = 999
    expect(bake.refs[0]).toBe(1)
  })
})

describe('holdoverDrawToEmit — the exact emit decision both stages run', () => {
  const T: HoldoverTransform = { scale: 1.2, dx: 5, dy: -3 }
  const held = { anchorX: 10, anchorY: 20, sizeScale: 1 }
  const reproj = (d: typeof held, t: HoldoverTransform) => ({
    ...d,
    anchorX: d.anchorX * t.scale + t.dx,
    anchorY: d.anchorY * t.scale + t.dy,
  })
  const bake: HoldoverBakeFrame = {
    refs: new Float64Array(12),
    bearingKey: 0,
    canvasW: 800,
    canvasH: 600,
  }
  const ctx = (over: Partial<MotionHoldoverCtx> = {}): MotionHoldoverCtx => ({
    bearingKey: 0,
    canvasW: 800,
    canvasH: 600,
    refs: new Float64Array(12),
    solve: () => T,
    ...over,
  })

  it('IDLE (holdoverOk): draws the baked clone AS-IS — the byte-identical path', () => {
    // ctx present or not, holdoverOk short-circuits to the unmodified clone.
    expect(holdoverDrawToEmit(held, bake, true, ctx(), reproj)).toBe(held)
    expect(holdoverDrawToEmit(held, undefined, true, undefined, reproj)).toBe(held)
  })

  it('MOTION + safe + solvable: REPROJECTS (the fix — fades in place, not popped)', () => {
    const out = holdoverDrawToEmit(held, bake, false, ctx(), reproj)
    expect(out).not.toBeNull()
    expect(out).not.toBe(held)
    expect(out!.anchorX).toBeCloseTo(10 * 1.2 + 5, 9)
  })

  it('MOTION but no ctx (globe / pitch / rotate): DROP — the graceful pop, unchanged', () => {
    expect(holdoverDrawToEmit(held, bake, false, undefined, reproj)).toBeNull()
  })

  it('MOTION but no stamped bake frame (baked under a non-safe camera): DROP', () => {
    expect(holdoverDrawToEmit(held, undefined, false, ctx(), reproj)).toBeNull()
  })

  it('MOTION but bearing/canvas changed since bake (similarity invalid): DROP not misplace', () => {
    expect(holdoverDrawToEmit(held, bake, false, ctx({ bearingKey: 9000 }), reproj)).toBeNull()
  })

  it('MOTION but the solve falls outside the replay bands (world-copy flip): DROP', () => {
    expect(holdoverDrawToEmit(held, bake, false, ctx({ solve: () => null }), reproj)).toBeNull()
  })
})

describe('reprojectIconHoldover — paired badge fades with its text', () => {
  it('moves the anchor affinely and scales sizeScale so the icon tracks the zoom', () => {
    const out = reprojectIconHoldover(
      { anchorX: 50, anchorY: 60, sizeScale: 2 },
      { scale: 1.5, dx: 3, dy: -2 },
    )
    expect(out.anchorX).toBe(50 * 1.5 + 3)
    expect(out.anchorY).toBe(60 * 1.5 - 2)
    expect(out.sizeScale).toBe(3)
  })

  it('scales an icon-text-fit override (absolute px w/h + offset) by the same scale', () => {
    const out = reprojectIconHoldover(
      { anchorX: 0, anchorY: 0, sizeScale: 1, fit: { w: 40, h: 20, dx: 4, dy: -2 } },
      { scale: 2, dx: 0, dy: 0 },
    )
    expect(out.fit).toEqual({ w: 80, h: 40, dx: 8, dy: -4 })
  })
})
