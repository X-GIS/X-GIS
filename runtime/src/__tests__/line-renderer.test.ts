import { describe, expect, it } from 'vitest'
import {
  buildLineSegments,
  packLineLayerUniform,
  LINE_UNIFORM_SIZE,
  LINE_SEGMENT_STRIDE_F32,
  LINE_CAP_BUTT,
  LINE_JOIN_MITER,
} from '../engine/line-renderer'

// Layer uniform layout (matches WGSL LineLayer struct)
const F32_COLOR = 0         // vec4<f32>  @ 0
const F32_WIDTH_PX = 4      // f32        @ 16
const F32_AA_WIDTH = 5      // f32        @ 20
const F32_MPP = 6           // f32        @ 24
const F32_MITER_LIMIT = 7   // f32        @ 28
const U32_FLAGS = 8         // u32        @ 32
const U32_DASH_COUNT = 9    // u32        @ 36
const F32_DASH_CYCLE = 10   // f32        @ 40
const F32_DASH_OFFSET = 11  // f32        @ 44
const F32_DASH_ARRAY_0 = 12 // array<vec4<f32>,2> @ 48-79

// ═══ DSFUN segment layout (LINE_SEGMENT_STRIDE_F32 = 16) ═══
//   [0-1]   p0_h (vec2)             — tile-local merc meters, high pair
//   [2-3]   p1_h (vec2)
//   [4-5]   p0_l (vec2)             — low pair
//   [6-7]   p1_l (vec2)
//   [8-9]   prev_tangent (vec2)
//   [10-11] next_tangent (vec2)
//   [12]    arc_start
//   [13]    line_length
//   [14]    pad_ratio_p0
//   [15]    pad_ratio_p1
const OFF_P0_H = 0
const OFF_P1_H = 2
const OFF_PREV_TANGENT = 8
const OFF_NEXT_TANGENT = 10
const OFF_ARC_START = 12
const OFF_PAD_P0 = 14
const OFF_PAD_P1 = 15
const OFF_Z_LIFT = 16
const OFF_WIDTH_OVERRIDE = 17
const OFF_COLOR_PACKED = 18

// Helper: build a DSFUN stride-6 line vertex buffer from plain
// (mx, my, arc_start) tuples. Polygon outlines (stride 5) drop arc_start.
function dsfunLineVerts(coords: Array<[number, number, number?]>): Float32Array {
  const out = new Float32Array(coords.length * 6)
  for (let i = 0; i < coords.length; i++) {
    const [mx, my, arc] = coords[i]
    // Small tile-local meters — Math.fround rounds cleanly, so high + low
    // trivially reconstructs the original value. We still exercise both
    // slots so the reader path matches production.
    out[i * 6 + 0] = Math.fround(mx)
    out[i * 6 + 1] = Math.fround(my)
    out[i * 6 + 2] = 0
    out[i * 6 + 3] = 0
    out[i * 6 + 4] = 0
    out[i * 6 + 5] = arc ?? 0
  }
  return out
}

function dsfunPolyVerts(coords: Array<[number, number]>): Float32Array {
  const out = new Float32Array(coords.length * 5)
  for (let i = 0; i < coords.length; i++) {
    out[i * 5 + 0] = Math.fround(coords[i][0])
    out[i * 5 + 1] = Math.fround(coords[i][1])
    out[i * 5 + 2] = 0
    out[i * 5 + 3] = 0
    out[i * 5 + 4] = 0
  }
  return out
}

describe('packLineLayerUniform', () => {
  it('produces a buffer of exactly LINE_UNIFORM_SIZE bytes', () => {
    const buf = packLineLayerUniform([1, 0, 0, 1], 2, 1, 1000)
    expect(buf.byteLength).toBe(LINE_UNIFORM_SIZE)
  })

  it('writes color, width, and mpp to their fixed slots', () => {
    const buf = packLineLayerUniform([0.2, 0.4, 0.6, 0.8], 3, 0.5, 2500)
    expect(buf[F32_COLOR + 0]).toBeCloseTo(0.2)
    expect(buf[F32_COLOR + 1]).toBeCloseTo(0.4)
    expect(buf[F32_COLOR + 2]).toBeCloseTo(0.6)
    // alpha is pre-multiplied by opacity
    expect(buf[F32_COLOR + 3]).toBeCloseTo(0.8 * 0.5)
    expect(buf[F32_WIDTH_PX]).toBe(3)
    expect(buf[F32_AA_WIDTH]).toBeCloseTo(1.5)
    expect(buf[F32_MPP]).toBe(2500)
  })

  it('leaves dash fields zero when no dash config is supplied', () => {
    const buf = packLineLayerUniform([1, 1, 1, 1], 2, 1, 100)
    const u32 = new Uint32Array(buf.buffer)
    // flags should have dash_enable bit (5) = 0
    expect((u32[U32_FLAGS] >>> 5) & 1).toBe(0)
    expect(u32[U32_DASH_COUNT]).toBe(0)
    expect(buf[F32_DASH_CYCLE]).toBe(0)
    expect(buf[F32_DASH_ARRAY_0]).toBe(0)
  })

  it('packs a 2-value dash array and sets dash_enable + dash_count + cycle', () => {
    const buf = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      { array: [20, 10] },
    )
    const u32 = new Uint32Array(buf.buffer)

    // Flags bit 5 (dash_enable) must be set
    expect((u32[U32_FLAGS] >>> 5) & 1).toBe(1)

    // dash_count must be 2
    expect(u32[U32_DASH_COUNT]).toBe(2)

    // dash_cycle_m must be the sum
    expect(buf[F32_DASH_CYCLE]).toBeCloseTo(30)

    // dash_array[0].xy must hold the values
    expect(buf[F32_DASH_ARRAY_0 + 0]).toBeCloseTo(20)
    expect(buf[F32_DASH_ARRAY_0 + 1]).toBeCloseTo(10)
    // rest of the slot should be zero
    expect(buf[F32_DASH_ARRAY_0 + 2]).toBe(0)
    expect(buf[F32_DASH_ARRAY_0 + 3]).toBe(0)
  })

  it('packs a 4-value composite dash array', () => {
    const buf = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      { array: [6, 2, 1, 2] },
    )
    const u32 = new Uint32Array(buf.buffer)
    expect(u32[U32_DASH_COUNT]).toBe(4)
    expect(buf[F32_DASH_CYCLE]).toBeCloseTo(11)
    expect(buf[F32_DASH_ARRAY_0 + 0]).toBeCloseTo(6)
    expect(buf[F32_DASH_ARRAY_0 + 1]).toBeCloseTo(2)
    expect(buf[F32_DASH_ARRAY_0 + 2]).toBeCloseTo(1)
    expect(buf[F32_DASH_ARRAY_0 + 3]).toBeCloseTo(2)
  })

  it('writes lateral offset_m at slot [44] (px × mpp)', () => {
    const F32_OFFSET = 44
    const mpp = 100
    // offset = 5px → 500 m
    const buf = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, mpp,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], 5,
    )
    expect(buf[F32_OFFSET]).toBeCloseTo(500)
    // negative (right side)
    const buf2 = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, mpp,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], -3,
    )
    expect(buf2[F32_OFFSET]).toBeCloseTo(-300)
  })

  // Regression guard for the fragment-shader feature-gate optimisation:
  // bit 6 (has_pattern) and bit 7 (has_offset) must reflect the uniform's
  // actual payload so the shader can short-circuit the pattern-SDF loop
  // and offset-join math for plain strokes (the mobile-lag hot path).
  it('sets has_pattern bit only when at least one pattern slot is active', () => {
    const FLAG_PATTERN = 1 << 6
    // No patterns → bit clear.
    const empty = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], 0,
    )
    const emptyU32 = new Uint32Array(empty.buffer)
    expect((emptyU32[U32_FLAGS] & FLAG_PATTERN) !== 0).toBe(false)

    // One active slot → bit set.
    const withPat = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null,
      [{ shapeId: 3, spacing: 20, size: 12 }],
      0,
    )
    const withPatU32 = new Uint32Array(withPat.buffer)
    expect((withPatU32[U32_FLAGS] & FLAG_PATTERN) !== 0).toBe(true)

    // Slot with shapeId=0 is inactive — bit stays clear.
    const inactive = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null,
      [{ shapeId: 0, spacing: 20, size: 12 }],
      0,
    )
    const inactiveU32 = new Uint32Array(inactive.buffer)
    expect((inactiveU32[U32_FLAGS] & FLAG_PATTERN) !== 0).toBe(false)
  })

  it('sets has_offset bit only when offsetPx is non-zero', () => {
    const FLAG_OFFSET = 1 << 7
    const zero = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], 0,
    )
    const zeroU32 = new Uint32Array(zero.buffer)
    expect((zeroU32[U32_FLAGS] & FLAG_OFFSET) !== 0).toBe(false)

    const off = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], 5,
    )
    const offU32 = new Uint32Array(off.buffer)
    expect((offU32[U32_FLAGS] & FLAG_OFFSET) !== 0).toBe(true)

    // Negative offset (right-side) still flags.
    const offNeg = packLineLayerUniform(
      [1, 1, 1, 1], 2, 1, 100,
      LINE_CAP_BUTT, LINE_JOIN_MITER, 4,
      null, [], -3,
    )
    const offNegU32 = new Uint32Array(offNeg.buffer)
    expect((offNegU32[U32_FLAGS] & FLAG_OFFSET) !== 0).toBe(true)
  })

  it('LINE_UNIFORM_SIZE includes the offset slot (≥ 192 bytes)', () => {
    expect(LINE_UNIFORM_SIZE).toBeGreaterThanOrEqual(192)
    expect(LINE_UNIFORM_SIZE % 16).toBe(0)
  })
})

describe('buildLineSegments', () => {
  it('bakes per-feature stroke width into segment.width_px_override', () => {
    // Two features, two segments each. Feature 0 (featId=0) has the
    // first 4 vertices; feature 1 (featId=1) has the last 3.
    // Mirrors the worker's compound-layer flow: pre-resolved width
    // map keyed by featId, written into the per-segment slot at
    // offset 17 so the line shader can pick it over layer.width_px.
    const vertices = new Float32Array(7 * 6)
    for (let i = 0; i < 4; i++) {
      vertices[i * 6 + 0] = i * 100
      vertices[i * 6 + 4] = 0  // featId
    }
    for (let i = 4; i < 7; i++) {
      vertices[i * 6 + 0] = i * 100
      vertices[i * 6 + 4] = 1  // featId
    }
    const indices = new Uint32Array([0, 1, 1, 2, 2, 3, 4, 5, 5, 6])
    const widths = new Map<number, number>([[0, 0.5], [1, 2.5]])
    const seg = buildLineSegments(vertices, indices, 6, 0, 0, undefined, widths)
    // First 3 segments belong to featId=0 → width 0.5
    for (let s = 0; s < 3; s++) {
      expect(seg[s * LINE_SEGMENT_STRIDE_F32 + OFF_WIDTH_OVERRIDE]).toBe(0.5)
    }
    // Last 2 segments belong to featId=1 → width 2.5
    for (let s = 3; s < 5; s++) {
      expect(seg[s * LINE_SEGMENT_STRIDE_F32 + OFF_WIDTH_OVERRIDE]).toBe(2.5)
    }
  })

  it('leaves segment.width_px_override at 0 when no widths map supplied', () => {
    const vertices = new Float32Array(2 * 6)
    vertices[0 * 6 + 0] = 0; vertices[0 * 6 + 4] = 0
    vertices[1 * 6 + 0] = 100; vertices[1 * 6 + 4] = 0
    const indices = new Uint32Array([0, 1])
    const seg = buildLineSegments(vertices, indices, 6)
    // 0 = "no override" sentinel — line shader falls through to
    // layer.width_px (legacy / unmerged path).
    expect(seg[OFF_WIDTH_OVERRIDE]).toBe(0)
  })

  it('packs RGBA8 stroke colour into segment.color_packed via Uint32Array view', () => {
    // Worker passes colours as packed u32 values keyed by featId.
    // The segment buffer is a Float32Array; we need to verify that
    // the u32 bit pattern survives — the shader reads it as f32
    // and uses bitcast<u32> to recover. Check via Uint32Array view.
    // Two features, two distinct chains so each segment's p0
    // belongs to a single feature (segment colour samples featId
    // from p0, see line-segment-build.ts:347).
    const vertices = new Float32Array(4 * 6)
    vertices[0 * 6 + 0] = 0;   vertices[0 * 6 + 4] = 0
    vertices[1 * 6 + 0] = 100; vertices[1 * 6 + 4] = 0
    vertices[2 * 6 + 0] = 500; vertices[2 * 6 + 4] = 1
    vertices[3 * 6 + 0] = 600; vertices[3 * 6 + 4] = 1
    const indices = new Uint32Array([0, 1, 2, 3])
    const f0Color = (0xff << 24) | (0x00 << 16) | (0x88 << 8) | 0xff
    const f1Color = (0x80 << 24) | (0xff << 16) | (0xaa << 8) | 0x00
    const colors = new Map<number, number>([[0, f0Color >>> 0], [1, f1Color >>> 0]])
    const seg = buildLineSegments(vertices, indices, 6, 0, 0, undefined, undefined, colors)
    const segU32 = new Uint32Array(seg.buffer)
    expect(segU32[0 * LINE_SEGMENT_STRIDE_F32 + OFF_COLOR_PACKED]).toBe(f0Color >>> 0)
    expect(segU32[1 * LINE_SEGMENT_STRIDE_F32 + OFF_COLOR_PACKED]).toBe(f1Color >>> 0)
  })

  it('carries arc_start from stride-6 vertices into the segment struct', () => {
    // Two segments representing a single polyline with 3 vertices.
    // Arc values simulate what the tiler would write:
    //   v0 arc=0, v1 arc=100m, v2 arc=250m
    // DSFUN layout: [mx_h, my_h, mx_l, my_l, feat_id, arc_start]
    const vertices = dsfunLineVerts([
      [0,    0, 0],     // v0: 0 m along feature
      [1000, 0, 100],   // v1: 1 km east, arc=100
      [2000, 0, 250],   // v2: 2 km east, arc=250
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 6)

    expect(segData.length).toBe(2 * LINE_SEGMENT_STRIDE_F32)

    // Segment 0: arc_start should be 0 (from v0.arc)
    const seg0ArcStart = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_ARC_START]
    expect(seg0ArcStart).toBe(0)

    // Segment 1: arc_start should be 100 (from v1.arc)
    const seg1ArcStart = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_ARC_START]
    expect(seg1ArcStart).toBe(100)
  })

  it('computes prev_tangent/next_tangent for adjacent segments that share a vertex', () => {
    const vertices = dsfunLineVerts([
      [0,    0],
      [1000, 0],
      [2000, 0],
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 6)

    // Segment 0: no prev (first seg), next should point toward v2
    const seg0PrevX = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PREV_TANGENT + 0]
    const seg0PrevY = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PREV_TANGENT + 1]
    const seg0NextX = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_NEXT_TANGENT + 0]
    const seg0NextY = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_NEXT_TANGENT + 1]
    expect(seg0PrevX).toBe(0)
    expect(seg0PrevY).toBe(0)
    expect(Math.abs(seg0NextX)).toBeGreaterThan(0.99) // unit x-ish
    expect(Math.abs(seg0NextY)).toBeLessThan(0.02)

    // Segment 1: prev should be non-zero, next should be zero
    const seg1PrevX = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PREV_TANGENT + 0]
    const seg1NextX = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_NEXT_TANGENT + 0]
    const seg1NextY = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_NEXT_TANGENT + 1]
    expect(Math.abs(seg1PrevX)).toBeGreaterThan(0.99)
    expect(seg1NextX).toBe(0)
    expect(seg1NextY).toBe(0)
  })

  describe('miter pad ratios (cap/join quad shrinking)', () => {
    it('caps: start segment with no prev → pad_p0 = 1 (cap margin, not 4)', () => {
      // Single-segment polyline from (0,0) to (1000,0): both endpoints are caps.
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
      ])
      const indices = new Uint32Array([0, 1])
      const segData = buildLineSegments(vertices, indices, 6)
      expect(segData[OFF_PAD_P0]).toBe(1)
      expect(segData[OFF_PAD_P1]).toBe(1)
    })

    it('straight line join: pad ratio stays at 1 (no miter needed)', () => {
      // Collinear polyline with 3 points. The middle join is a straight
      // continuation, so both segments' p1 (seg 0) / p0 (seg 1) should
      // collapse to pad = 1 instead of the worst-case 4.
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
        [2000, 0],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)
      // seg 0: p0 is a cap (no prev) → 1. p1 is a straight join → 1.
      expect(segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]).toBe(1)
      expect(segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]).toBe(1)
      // seg 1: p0 is a straight join → 1. p1 is a cap → 1.
      expect(segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]).toBe(1)
      expect(segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]).toBe(1)
    })

    it('90° corner join: pad ratio = |tan(45°)| = 1.0', () => {
      // L-shape: (0,0) → (1000,0) → (1000,1000). Middle join is a 90° turn.
      // pad_along = |tan(θ/2)| where θ = 90° → tan(45°) = 1.0.
      // (Previously 1/sin(45°) ≈ 1.414, which over-estimated the along-dir pad.)
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
        [1000, 1000],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)
      const seg0PadP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      expect(seg0PadP1).toBeCloseTo(1.0, 1)
      const seg1PadP0 = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]
      expect(seg1PadP0).toBeCloseTo(1.0, 1)
    })

    it('gentle turn beyond miter limit: pad ratio clamps to 1 (bevel fallback)', () => {
      // Very gentle turn (10° external angle). Half-angle = 5°, sin = 0.0872.
      // That is below 1/miter_limit = 0.25, so the miter is longer than 4×half_w
      // and CPU should fall back to pad = 1 (bevel).
      const cos10 = Math.cos(10 * Math.PI / 180)
      const sin10 = Math.sin(10 * Math.PI / 180)
      const vertices = dsfunLineVerts([
        [0,                      0],
        [1000,                   0],
        [1000 + 1000 * cos10,    1000 * sin10],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)
      const seg0PadP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      expect(seg0PadP1).toBe(1)
    })

    it('pad ratio never exceeds the miter limit (4)', () => {
      // Loop every segment in a randomly shaped polyline and assert pads are
      // in the valid range [1, 4]. Smoke test for unexpected values.
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
        [1000, 1000],
        [2000, 1000],
        [2000, 2000],
      ])
      const indices = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4])
      const segData = buildLineSegments(vertices, indices, 6)
      const segCount = segData.length / LINE_SEGMENT_STRIDE_F32
      for (let i = 0; i < segCount; i++) {
        const pad0 = segData[i * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]
        const pad1 = segData[i * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
        expect(pad0).toBeGreaterThanOrEqual(1)
        expect(pad0).toBeLessThanOrEqual(4)
        expect(pad1).toBeGreaterThanOrEqual(1)
        expect(pad1).toBeLessThanOrEqual(4)
      }
    })
  })

  it('rejects stride-5 polygon-outline input with a clear error', () => {
    // The BFS chain walker that used to handle stride-5 polygon outlines
    // is gone. All callers now route polygon outlines through the
    // unified augmentRingWithArc + clipLineToRect + tessellateLineToArrays
    // pipeline (DSFUN stride-10 with global arc_start) so the line
    // renderer takes a single code path. Calling buildLineSegments with
    // stride < 6 now throws — surfacing any stale call site loudly
    // instead of silently producing zero-arc dashes that drift.
    const vertices = dsfunPolyVerts([
      [0,    0],
      [1000, 0],
      [2000, 0],
    ])
    const indices = new Uint32Array([0, 1, 1, 2])
    expect(() => buildLineSegments(vertices, indices, 5)).toThrow(/stride.*6|outlineVertices/i)
  })

  // Ports the miter-offset formula from vs_line and asserts that two
  // adjacent segments at a right-angle chain compute the SAME outer-vertex
  // position at their shared endpoint. If this regresses, polygon outlines
  // will show visible gaps at corners (the user-reported bug).
  describe('vertex-shader miter geometry (ported math)', () => {
    type V2 = [number, number]
    const perp = (v: V2): V2 => [-v[1], v[0]]
    const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1]
    const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
    const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
    const len = (v: V2) => Math.hypot(v[0], v[1])

    function miterOffset(
      dir: V2,
      neighborTangent: V2 | null,
      side: number, // -1 or +1
      halfW: number,
      miterLimit: number,
    ): V2 {
      const perpCur = mul(perp(dir), side)
      if (!neighborTangent) return mul(perpCur, halfW)
      const perpN = mul(perp(neighborTangent), side)
      const miterVec = add(perpCur, perpN)
      const proj = dot(miterVec, perpCur)
      if (proj < 1e-4 || len(miterVec) < 1e-3) return mul(perpCur, halfW)
      if (len(miterVec) > miterLimit * proj) return mul(perpCur, halfW) // bevel
      return mul(miterVec, halfW / proj)
    }

    // Reconstruct an endpoint (p0 or p1) from a DSFUN segment slot.
    function readP(seg: Float32Array, off: number, which: 'p0' | 'p1'): V2 {
      const hOff = which === 'p0' ? OFF_P0_H : OFF_P1_H
      // low pair comes 4 slots after the high pair in the stride-16 layout
      const lOff = hOff + 4
      return [
        seg[off + hOff] + seg[off + lOff],
        seg[off + hOff + 1] + seg[off + lOff + 1],
      ]
    }

    it('two right-angle adjacent segments share the outer miter vertex', () => {
      // Chain v0=(0,0) → v1=(1000,0) → v2=(1000,1000). 90° left turn at v1.
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
        [1000, 1000],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)

      const s0 = 0 * LINE_SEGMENT_STRIDE_F32
      const s1 = 1 * LINE_SEGMENT_STRIDE_F32

      const p0Seg0 = readP(segData, s0, 'p0')
      const p1Seg0 = readP(segData, s0, 'p1')
      const nextSeg0: V2 = [
        segData[s0 + OFF_NEXT_TANGENT + 0],
        segData[s0 + OFF_NEXT_TANGENT + 1],
      ]

      const p0Seg1 = readP(segData, s1, 'p0')
      const p1Seg1 = readP(segData, s1, 'p1')
      const prevSeg1: V2 = [
        segData[s1 + OFF_PREV_TANGENT + 0],
        segData[s1 + OFF_PREV_TANGENT + 1],
      ]

      // Shared endpoint must match
      expect(p1Seg0[0]).toBeCloseTo(p0Seg1[0], 4)
      expect(p1Seg0[1]).toBeCloseTo(p0Seg1[1], 4)

      // Compute dir of each segment
      const dir0: V2 = [p1Seg0[0] - p0Seg0[0], p1Seg0[1] - p0Seg0[1]]
      const L0 = len(dir0)
      const d0: V2 = [dir0[0] / L0, dir0[1] / L0]

      const dir1: V2 = [p1Seg1[0] - p0Seg1[0], p1Seg1[1] - p0Seg1[1]]
      const L1 = len(dir1)
      const d1: V2 = [dir1[0] / L1, dir1[1] / L1]

      const halfW = 50 // 50 m stroke
      const miterLimit = 4

      for (const side of [-1, +1]) {
        const off0 = miterOffset(d0, nextSeg0, side, halfW, miterLimit)
        const v0: V2 = [p1Seg0[0] + off0[0], p1Seg0[1] + off0[1]]
        const off1 = miterOffset(d1, prevSeg1, side, halfW, miterLimit)
        const v1: V2 = [p0Seg1[0] + off1[0], p0Seg1[1] + off1[1]]

        expect(v0[0]).toBeCloseTo(v1[0], 2)
        expect(v0[1]).toBeCloseTo(v1[1], 2)
      }
    })

    it('miter offset at 90° corner equals half_w × √2 from the endpoint (outer side)', () => {
      const dir: V2 = [0, 1] // current going up
      const neighbor: V2 = [1, 0] // prev arriving from the right
      const halfW = 100
      const off = miterOffset(dir, neighbor, +1, halfW, 4)
      // Miter tip distance = halfW / sin(45°) = halfW × √2 ≈ 141.4
      const d = len(off)
      expect(d).toBeGreaterThan(140)
      expect(d).toBeLessThan(143)
    })

    it('sharp fold beyond miter_limit falls back to bevel (offset = perp × half_w)', () => {
      // 170° deflection — path almost doubles back, miter ratio goes to ~12
      const rad = Math.PI / 180 * 170
      const dir: V2 = [Math.cos(rad), Math.sin(rad)]
      const neighbor: V2 = [1, 0]
      const halfW = 100
      const off = miterOffset(dir, neighbor, +1, halfW, 4)
      // Clamp to perp_cur × halfW — magnitude exactly halfW
      expect(len(off)).toBeCloseTo(halfW, 2)
    })

    // Regression: the fragment-shader offset round-join center used to be a
    // simple perpendicular shift along the current segment's normal — wrong
    // for joins because adjacent segments would land on different points.
    // The correct center is the OFFSET MITER VERTEX, computed by the same
    // miter formula but with offset_m in place of half_w. This test ports
    // the formula and verifies both adjacent segments compute the same
    // center for a canonical right-angle chain.
    it('offset round-join center coincides between adjacent segments at a 90° turn', () => {
      function offsetJoinCenter(
        endpoint: V2,
        currentDir: V2,
        neighborTangent: V2,
        offsetM: number,
      ): V2 {
        const nrmLine = perp(currentDir)
        const nrmPrev = perp(neighborTangent)
        const miterVec = add(nrmLine, nrmPrev)
        const proj = dot(miterVec, nrmLine)
        const scale = offsetM / Math.max(proj, 1e-4)
        return add(endpoint, mul(miterVec, scale))
      }

      // Build a real right-angle chain via buildLineSegments to exercise
      // the same prev_tangent / next_tangent values the shader sees.
      const vertices = dsfunLineVerts([
        [0,    0],
        [1000, 0],
        [1000, 1000],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const seg = buildLineSegments(vertices, indices, 6)

      // Seg 0: end side (p1 = shared join vertex), use next_tangent
      const s0 = 0 * LINE_SEGMENT_STRIDE_F32
      const p0Seg0 = readP(seg, s0, 'p0')
      const p1Seg0 = readP(seg, s0, 'p1')
      const dir0: V2 = [p1Seg0[0] - p0Seg0[0], p1Seg0[1] - p0Seg0[1]]
      const dir0Unit: V2 = mul(dir0, 1 / len(dir0))
      const nextSeg0: V2 = [
        seg[s0 + OFF_NEXT_TANGENT + 0],
        seg[s0 + OFF_NEXT_TANGENT + 1],
      ]

      // Seg 1: start side (p0 = shared join vertex), use prev_tangent
      const s1 = 1 * LINE_SEGMENT_STRIDE_F32
      const p0Seg1 = readP(seg, s1, 'p0')
      const p1Seg1 = readP(seg, s1, 'p1')
      const dir1: V2 = [p1Seg1[0] - p0Seg1[0], p1Seg1[1] - p0Seg1[1]]
      const dir1Unit: V2 = mul(dir1, 1 / len(dir1))
      const prevSeg1: V2 = [
        seg[s1 + OFF_PREV_TANGENT + 0],
        seg[s1 + OFF_PREV_TANGENT + 1],
      ]

      const offsetM = 50

      const center0 = offsetJoinCenter(p1Seg0, dir0Unit, nextSeg0, offsetM)
      const center1 = offsetJoinCenter(p0Seg1, dir1Unit, prevSeg1, offsetM)

      // Both segments must agree on the join center within float tolerance.
      expect(center0[0]).toBeCloseTo(center1[0], 2)
      expect(center0[1]).toBeCloseTo(center1[1], 2)

      // For a 90° left turn the offset-miter vertex on the +left side is
      // displaced by (-offset, +offset) from the corner — verify the
      // structure.
      const cornerX = p1Seg0[0]
      const cornerY = p1Seg0[1]
      const dx = center0[0] - cornerX
      const dy = center0[1] - cornerY
      // Magnitudes should match offset (left side of a left turn).
      expect(Math.abs(dx)).toBeCloseTo(offsetM, 1)
      expect(Math.abs(dy)).toBeCloseTo(offsetM, 1)
    })
  })

  // ═══ Miter / Bevel join geometry tests ═══
  // Miter joins work via body SDF + bisector clip: each segment renders
  // its half of the miter diamond naturally. These tests verify the
  // geometric property that both strips intersect to form the miter.
  describe('miter join geometry (strip intersection)', () => {
    type V2 = [number, number]
    const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1]
    const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
    const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
    const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
    const len = (v: V2) => Math.hypot(v[0], v[1])
    const perp = (v: V2): V2 => [-v[1], v[0]]
    const normalize = (v: V2): V2 => { const l = len(v); return [v[0] / l, v[1] / l] }

    /** Compute the miter SDF at a point p, matching the WGSL logic in
     *  compute_line_color for JOIN_MITER at p1. */
    function miterSDF(
      p: V2,
      p0: V2, p1: V2,
      nextTangent: V2,
      halfW: number,
      offsetM: number,
      miterLimit: number,
    ): number {
      const segVec = sub(p1, p0)
      const segLen = len(segVec)
      const dir: V2 = segLen < 1e-6 ? [1, 0] : [segVec[0] / segLen, segVec[1] / segLen]
      const nrmLine = perp(dir)

      // Body SDF (current segment strip)
      const signedPerp = dot2(sub(p, p0), nrmLine)
      const perpM = Math.abs(signedPerp - offsetM)
      const bodyD = perpM - halfW

      // Next segment strip SDF
      const nextNrm = perp(nextTangent)
      const nextSignedPerp = dot2(sub(p, p1), nextNrm)
      const nextPerpM = Math.abs(nextSignedPerp - offsetM)
      const nextBodyD = nextPerpM - halfW

      // Intersection of both strips
      let miterD = Math.max(bodyD, nextBodyD)

      // Miter limit clip along bisector
      const bis: V2 = add(dir, nextTangent)
      const bisLen = len(bis)
      if (bisLen > 1e-6) {
        const bisUnit = normalize(bis)
        const alongBis = dot2(sub(p, p1), bisUnit)
        miterD = Math.max(miterD, alongBis - miterLimit * halfW)
      }

      return miterD
    }

    it('point at the miter tip center is inside (d ≤ 0) for a 90° corner', () => {
      // Segment from (0,0) to (100,0), next goes up: tangent = (0,1)
      const p0: V2 = [0, 0]
      const p1: V2 = [100, 0]
      const nextT: V2 = [0, 1]
      const halfW = 10
      // A point slightly inside the miter diamond
      const p: V2 = [105, 5]
      const d = miterSDF(p, p0, p1, nextT, halfW, 0, 4)
      expect(d).toBeLessThanOrEqual(0)
    })

    it('point well outside the miter diamond is clipped (d > 0)', () => {
      const p0: V2 = [0, 0]
      const p1: V2 = [100, 0]
      const nextT: V2 = [0, 1]
      const halfW = 10
      // Point far beyond both strips
      const p: V2 = [115, 15]
      const d = miterSDF(p, p0, p1, nextT, halfW, 0, 4)
      expect(d).toBeGreaterThan(0)
    })

    it('miter tip vertex (exact intersection of outer edges) is at boundary (d ≈ 0)', () => {
      // For 90° turn, miter tip = p1 + half_w along each axis
      const p0: V2 = [0, 0]
      const p1: V2 = [100, 0]
      const nextT: V2 = [0, 1]
      const halfW = 10
      // The exact miter tip: perpendicular distance to both strips = halfW
      const tip: V2 = [100 + halfW, halfW]
      const d = miterSDF(tip, p0, p1, nextT, halfW, 0, 4)
      expect(Math.abs(d)).toBeLessThan(0.01)
    })

    it('miter limit clips the tip for a shallow angle', () => {
      // A very gentle turn (10°) → miter ratio ≈ 11.5, exceeds limit 4.
      // CPU sets pad_ratio = 1, so fragment shader miter_d should be > 0
      // at the would-be tip.
      const cos10 = Math.cos(10 * Math.PI / 180)
      const sin10 = Math.sin(10 * Math.PI / 180)
      const p0: V2 = [0, 0]
      const p1: V2 = [100, 0]
      const nextT: V2 = [cos10, sin10]
      const halfW = 10
      const miterLimit = 4
      // Point at the bisector direction, at miter_limit * halfW distance
      const bis = normalize(add([1, 0], nextT))
      const testP: V2 = add(p1, mul(bis, miterLimit * halfW + 1))
      const d = miterSDF(testP, p0, p1, nextT, halfW, 0, miterLimit)
      expect(d).toBeGreaterThan(0)
    })

    it('miter with offset_m shifts the tip correctly', () => {
      const p0: V2 = [0, 0]
      const p1: V2 = [100, 0]
      const nextT: V2 = [0, 1]
      const halfW = 10
      const offsetM = 5
      // With offset, the strip center is shifted +5 in nrm direction.
      // Point at (105, 10): perp to current = 10, abs(10-5)=5 < 10 → inside current.
      // perp to next from p1: next_nrm = (-1,0), dot((5,10),(-1,0)) = -5, abs(-5-5)=10 = halfW → boundary
      const p: V2 = [105, 10]
      const d = miterSDF(p, p0, p1, nextT, halfW, offsetM, 4)
      expect(Math.abs(d)).toBeLessThan(0.01)
    })
  })

  describe('bevel edge clip (ported fragment-shader math)', () => {
    type V2 = [number, number]
    const dot2 = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1]
    const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
    const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
    const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
    const len = (v: V2) => Math.hypot(v[0], v[1])
    const perp = (v: V2): V2 => [-v[1], v[0]]
    const normalize = (v: V2): V2 => { const l = len(v); return [v[0] / l, v[1] / l] }

    /** Compute the bevel edge clip distance at point p. Matches the WGSL
     *  bevel-edge clip in the bisector section of compute_line_color.
     *  Returns > 0 when the point is past the bevel edge (should be clipped). */
    function bevelEdgeClip(
      p: V2,
      joinCenter: V2,
      dir: V2,
      nextTangent: V2,
      halfW: number,
      offsetM: number,
    ): number {
      const nrmLine = perp(dir)
      const nextNrm = perp(nextTangent)

      const crossVal = dir[0] * nextTangent[1] - dir[1] * nextTangent[0]
      if (Math.abs(crossVal) <= 1e-6) return -Infinity // collinear, no clip

      const s = -Math.sign(crossVal)
      const oc = add(joinCenter, mul(nrmLine, offsetM + halfW * s))
      const onBv = add(joinCenter, mul(nextNrm, offsetM + halfW * s))
      const be = sub(onBv, oc)
      const bl = len(be)
      if (bl <= 1e-6) return -Infinity

      const bd = normalize(be)
      const bo: V2 = [-bd[1] * s, bd[0] * s]
      return dot2(sub(p, oc), bo)
    }

    it('point inside bevel triangle has negative clip distance', () => {
      // 90° left turn at (100,0). Outer side = bottom-right.
      // (103, -3) is inside the bevel triangle.
      const d = bevelEdgeClip([103, -3], [100, 0], [1, 0], [0, 1], 10, 0)
      expect(d).toBeLessThan(0)
    })

    it('outer miter tip is clipped by the bevel edge (d > 0)', () => {
      // (110, -10) is the miter tip on the outer side — past the bevel edge
      const d = bevelEdgeClip([110, -10], [100, 0], [1, 0], [0, 1], 10, 0)
      expect(d).toBeGreaterThan(0)
    })

    it('point past bevel edge on outer side is clipped', () => {
      // (108, -8) is inside both strips but past the bevel edge
      const d = bevelEdgeClip([108, -8], [100, 0], [1, 0], [0, 1], 10, 0)
      expect(d).toBeGreaterThan(0)
    })

    it('inner side of turn is not affected by bevel clip (d < 0)', () => {
      // (97, 3) is on the inner side (top-left) of a left turn
      const d = bevelEdgeClip([97, 3], [100, 0], [1, 0], [0, 1], 10, 0)
      expect(d).toBeLessThan(0)
    })

    it('bevel edge with offset_m shifts outer corners correctly', () => {
      // With offset_m = 5, the stroke center shifts +5 in nrm direction.
      // The outer corners shift accordingly.
      const d = bevelEdgeClip([110, -5], [100, 0], [1, 0], [0, 1], 10, 5)
      expect(d).toBeGreaterThan(0)
    })
  })

  describe('miter quad extension uses pad_ratio', () => {
    it('miter pad at 90° is exactly 1.0 (= |tan(45°)|)', () => {
      const vertices = dsfunLineVerts([
        [0, 0], [1000, 0], [1000, 1000],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)
      const padP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      expect(padP1).toBeCloseTo(1.0, 1)
    })

    it('miter pad at obtuse angle (>103.6°) exceeds 1/sin (fixes triangle artifact)', () => {
      // V-shape: (-30,0) → (0,40) → (30,0). θ between dirs ≈ 106°.
      // pad_along = |tan(θ/2)| > 1/sin(θ/2) for this angle.
      const vertices = dsfunLineVerts([
        [-3000, 0], [0, 4000], [3000, 0],
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 6)
      const padP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      // For this geometry tan(θ/2) ≈ 1.333 while 1/sin(θ/2) ≈ 1.25
      expect(padP1).toBeGreaterThan(1.25)
      expect(padP1).toBeLessThan(1.5)
    })
  })

  // Regression: when |offset_m| > half_w_m_aa the inner across-side's
  // `half_w_side` becomes negative. For ROUND/BEVEL joins this used to
  // propagate directly into `along_pad`, pulling the near-edge quad
  // corners INWARD past the endpoint. On short subdivided segments
  // (e.g. 3°-slice equator lines at low zoom) the pulled-in corner
  // crossed past its sibling on the other endpoint, producing a
  // bowtie-shaped quad that failed to cover the round-join circle —
  // visible as a dark V-notch at every segment boundary. Fixed by
  // clamping along_pad to at least endpoint_pad for all join types.
  describe('vs_line along_pad covers offset round joins without halo', () => {
    // Port the shader's along_pad clamp. MITER uses pad_ratio × half_w to
    // cover the miter tip; ROUND/BEVEL use half_w directly — pad_ratio
    // overshoots and creates a sharp-corner halo when stacked layers
    // blend, which the regression guards against.
    const JOIN_MITER = 0
    const JOIN_ROUND = 1
    function alongPad(halfWSide: number, halfWmAa: number, endpointPad: number, joinType: number): number {
      const joinPad = joinType === JOIN_MITER ? endpointPad : halfWmAa
      return Math.max(halfWSide, joinPad)
    }

    it('stroke-10 + offset-right-11 keeps along_pad positive on the near edge (ROUND)', () => {
      // half_w_m_aa = (10 × 0.5 + 1.5) × 1 = 6.5
      const halfWmAa = 6.5
      const offsetM = -11
      const across = +1
      const halfWSide = halfWmAa + offsetM * across  // = -4.5
      expect(halfWSide).toBeLessThan(0)
      // Collinear pad_ratio = 1 → endpointPad = halfWmAa.
      const pad = alongPad(halfWSide, halfWmAa, /* endpointPad */ halfWmAa, JOIN_ROUND)
      expect(pad).toBe(halfWmAa)
      expect(pad).toBeGreaterThan(0)
    })

    it('no-offset + sharp-corner ROUND join does NOT use pad_ratio (no halo)', () => {
      // Regression guard: this used to be `max(half_w_side, endpoint_pad)`
      // which for ROUND with a 150° miter would extend the quad by
      // 3.7× half_w — visible as alpha-blend halo lines on multi-layer
      // polylines. Post-fix, ROUND caps at half_w_m_aa regardless of
      // pad_ratio.
      const halfWmAa = 6.5
      const halfWSide = halfWmAa
      const padRatioSharp = 3.7
      const endpointPadSharp = padRatioSharp * halfWmAa  // 24.05
      const round = alongPad(halfWSide, halfWmAa, endpointPadSharp, JOIN_ROUND)
      const miter = alongPad(halfWSide, halfWmAa, endpointPadSharp, JOIN_MITER)
      expect(round).toBe(halfWmAa)          // ROUND ignores pad_ratio
      expect(miter).toBe(endpointPadSharp)  // MITER still covers the miter tip
      expect(miter).toBeGreaterThan(round)
    })

    it('positive offset (left) on opposite across also stays positive (ROUND)', () => {
      const halfWmAa = 6.5
      const offsetM = +11
      const across = -1
      const halfWSide = halfWmAa + offsetM * across  // = -4.5
      expect(halfWSide).toBeLessThan(0)
      const pad = alongPad(halfWSide, halfWmAa, halfWmAa, JOIN_ROUND)
      expect(pad).toBeGreaterThan(0)
    })
  })

  // ── fs_line compute_line_color ported — the whisker-walk reference ──
  // Line-by-line TS port of line-renderer.ts:1135-1432 for a single
  // fragment. Returns the final d_m plus a string tag naming the code
  // path that set it — the same palette the plan's Stage 2 debug shader
  // would paint. `roundJoinDM` is the only thing unit tests need to
  // satisfy to prove "no fragment on the outer bisector at r > half_w
  // ends up with d_m <= 0".
  describe('fs_line round join — ported math', () => {
    type V2 = readonly [number, number]
    const perp = (v: V2): V2 => [-v[1], v[0]]
    const dot = (a: V2, b: V2) => a[0] * b[0] + a[1] * b[1]
    const add = (a: V2, b: V2): V2 => [a[0] + b[0], a[1] + b[1]]
    const sub = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]]
    const mul = (a: V2, s: number): V2 => [a[0] * s, a[1] * s]
    const len = (v: V2) => Math.hypot(v[0], v[1])

    type Join = 'MITER' | 'ROUND' | 'BEVEL'

    // Ports line-renderer.ts:1135-1432 for a single fragment. prevTan ==
    // (0,0) ⇒ cap at p0; nextTan == (0,0) ⇒ cap at p1. offset_m sign
    // matches the shader convention (stroke-outset uses -halfW on our
    // CCW polygon fixture).
    function roundJoinDM(
      p: V2, p0: V2, p1: V2,
      prevTan: V2, nextTan: V2,
      halfW: number, offsetM: number, miterLimit: number,
      joinType: Join,
    ): { dM: number; branch: string } {
      const dir: V2 = (() => {
        const d = sub(p1, p0)
        const L = len(d)
        return L > 1e-9 ? [d[0] / L, d[1] / L] : [1, 0]
      })()
      const nrmLine: V2 = perp(dir)
      const signedPerp = dot(sub(p, p0), nrmLine)
      const perpM = Math.abs(signedPerp - offsetM)
      const bodyD = perpM - halfW

      const hasPrev = len(prevTan) > 0.001
      const hasNext = len(nextTan) > 0.001

      // Offset miter vertices (1151-1159).
      const nrmPrevOff: V2 = perp(prevTan)
      const miterVecP0: V2 = add(nrmLine, nrmPrevOff)
      const projP0 = dot(miterVecP0, nrmLine)
      const p0JoinCenter: V2 = add(p0, mul(miterVecP0, offsetM / Math.max(projP0, 1e-4)))

      const nrmNextOff: V2 = perp(nextTan)
      const miterVecP1: V2 = add(nrmLine, nrmNextOff)
      const projP1 = dot(miterVecP1, nrmLine)
      const p1JoinCenter: V2 = add(p1, mul(miterVecP1, offsetM / Math.max(projP1, 1e-4)))

      const distP0 = -dot(sub(p, p0), dir)
      const distP1 = dot(sub(p, p1), dir)

      let dM = bodyD
      let branch = 'body'

      // Bisector clip p0 (1221-1244) — only fires when hasPrev.
      if (hasPrev) {
        const bisP0: V2 = add(prevTan, dir)
        const bisLenP0 = len(bisP0)
        if (bisLenP0 > 1e-6) {
          const bisUnitP0: V2 = mul(bisP0, 1 / bisLenP0)
          const alongP0 = dot(sub(p, p0JoinCenter), bisUnitP0)
          if (alongP0 < 0) {
            const newDM = Math.max(dM, -alongP0)
            if (newDM !== dM) { dM = newDM; branch = 'bisector_p0_prev_side' }
          }
        }
        // Bevel-edge clip at p0 (1257-1280).
        const crossP0Mag = Math.abs(prevTan[0] * dir[1] - prevTan[1] * dir[0])
        const bisMagP0 = len(add(prevTan, dir))
        const miterOverP0 = bisMagP0 > miterLimit * crossP0Mag
        const applyBevelP0 = joinType === 'BEVEL' || (joinType === 'MITER' && miterOverP0)
        if (applyBevelP0) {
          const prevNrm: V2 = perp(prevTan)
          const crossP0 = prevTan[0] * dir[1] - prevTan[1] * dir[0]
          if (Math.abs(crossP0) > 1e-6) {
            const s0 = -Math.sign(crossP0)
            const oc0 = add(p0, mul(prevNrm, offsetM + halfW * s0))
            const on0 = add(p0, mul(nrmLine, offsetM + halfW * s0))
            const be0 = sub(on0, oc0)
            const bl0 = len(be0)
            if (bl0 > 1e-6) {
              const bd0: V2 = mul(be0, 1 / bl0)
              const bo0: V2 = mul(perp(bd0), s0)
              const bclip0 = dot(sub(p, oc0), bo0)
              if (bclip0 > 0) {
                const newDM = Math.max(dM, bclip0)
                if (newDM !== dM) { dM = newDM; branch = 'bevel_p0' }
              }
            }
          }
        }
      }

      // Bisector clip p1 (1282-1318).
      if (hasNext) {
        const bisP1: V2 = add(dir, nextTan)
        const bisLenP1 = len(bisP1)
        if (bisLenP1 > 1e-6) {
          const bisUnitP1: V2 = mul(bisP1, 1 / bisLenP1)
          const alongP1 = dot(sub(p, p1JoinCenter), bisUnitP1)
          if (alongP1 > 0) {
            const newDM = Math.max(dM, alongP1)
            if (newDM !== dM) { dM = newDM; branch = 'bisector_p1_next_side' }
          }
        }
        const crossP1Mag = Math.abs(dir[0] * nextTan[1] - dir[1] * nextTan[0])
        const bisMagP1 = len(add(dir, nextTan))
        const miterOverP1 = bisMagP1 > miterLimit * crossP1Mag
        const applyBevelP1 = joinType === 'BEVEL' || (joinType === 'MITER' && miterOverP1)
        if (applyBevelP1) {
          const nextNrmBv: V2 = perp(nextTan)
          const crossP1 = dir[0] * nextTan[1] - dir[1] * nextTan[0]
          if (Math.abs(crossP1) > 1e-6) {
            const s1 = -Math.sign(crossP1)
            const oc1 = add(p1, mul(nrmLine, offsetM + halfW * s1))
            const on1 = add(p1, mul(nextNrmBv, offsetM + halfW * s1))
            const be1 = sub(on1, oc1)
            const bl1 = len(be1)
            if (bl1 > 1e-6) {
              const bd1: V2 = mul(be1, 1 / bl1)
              const bo1: V2 = mul(perp(bd1), s1)
              const bclip1 = dot(sub(p, oc1), bo1)
              if (bclip1 > 0) {
                const newDM = Math.max(dM, bclip1)
                if (newDM !== dM) { dM = newDM; branch = 'bevel_p1' }
              }
            }
          }
        }
      }

      // p0 cap / join (1321-1377).
      if (!hasPrev) {
        // caps not interesting for the whisker test — skip
      } else if (joinType === 'ROUND' && distP0 > 0) {
        const bisP0J: V2 = add(prevTan, dir)
        const bisLenJ = len(bisP0J)
        if (bisLenJ > 1e-6) {
          const bisUnitJ: V2 = mul(bisP0J, 1 / bisLenJ)
          const alongJ = dot(sub(p, p0JoinCenter), bisUnitJ)
          if (alongJ >= 0) {
            dM = len(sub(p, p0JoinCenter)) - halfW
            branch = 'round_p0_replace'
          }
        }
      }

      // p1 cap / join (1380-1431).
      if (!hasNext) {
        // caps not interesting
      } else if (joinType === 'ROUND' && distP1 > 0) {
        const bisP1J: V2 = add(dir, nextTan)
        const bisLenJ = len(bisP1J)
        if (bisLenJ > 1e-6) {
          const bisUnitJ: V2 = mul(bisP1J, 1 / bisLenJ)
          const alongJ = dot(sub(p, p1JoinCenter), bisUnitJ)
          if (alongJ <= 0) {
            dM = len(sub(p, p1JoinCenter)) - halfW
            branch = 'round_p1_replace'
          }
        }
      }

      return { dM, branch }
    }

    // Geometry: 90° CCW left turn at origin. e0 goes east from (-L,0)
    // to (0,0). e1 continues from (0,0) north to (0,L). For stroke-
    // outset on a CCW polygon, offset_m = -halfW in the shader's
    // signed_perp convention — pushes stroke to the RIGHT of motion =
    // SOUTH for e0 = exterior of the polygon. Offset miter vertex at
    // +halfW east, -halfW south of origin: (halfW, -halfW).
    const L = 100
    const halfW = 5
    const offsetM = -halfW
    const miterLimit = 4
    const e0P0: V2 = [-L, 0]
    const e0P1: V2 = [0, 0]
    const e1P0: V2 = [0, 0]
    const e1P1: V2 = [0, L]
    const e0Prev: V2 = [0, 0]          // e0 is line start, cap at p0
    const e0Next: V2 = [0, 1]          // next seg direction
    const e1Prev: V2 = [1, 0]          // prev seg direction
    const e1Next: V2 = [0, 0]          // e1 is line end, cap at p1
    const miterVertex: V2 = [halfW, -halfW]

    // Whisker lives on the outer bisector (SE direction for this turn).
    // The inner bisector (along_j = 0 line) passes through the miter
    // vertex in the SW→NE direction; SE is perpendicular to it ⇒ any
    // SE fragment has along_j == 0 exactly.
    const seUnit: V2 = [1 / Math.SQRT2, -1 / Math.SQRT2]

    const probeAt = (r: number) => {
      const p: V2 = add(miterVertex, mul(seUnit, r))
      const seg0 = roundJoinDM(p, e0P0, e0P1, e0Prev, e0Next, halfW, offsetM, miterLimit, 'ROUND')
      const seg1 = roundJoinDM(p, e1P0, e1P1, e1Prev, e1Next, halfW, offsetM, miterLimit, 'ROUND')
      return { p, seg0, seg1 }
    }

    it('at r = 0.9 × halfW on outer bisector both segments agree (inside circle)', () => {
      const { seg0, seg1 } = probeAt(halfW * 0.9)
      expect(seg0.dM).toBeLessThan(0)
      expect(seg1.dM).toBeLessThan(0)
      expect(seg0.branch).toBe('round_p1_replace') // e0 owns its p1
      expect(seg1.branch).toBe('round_p0_replace') // e1 owns its p0
      // Inclusive-inclusive contract: both replace with identical circle_d.
      expect(Math.abs(seg0.dM - seg1.dM)).toBeLessThan(1e-6)
    })

    it('WHISKER WALK — every pixel at r = 1.3 × halfW on outer bisector is discarded', () => {
      // The bug: at r > halfW past the miter vertex, the pixel should
      // be outside the round-join circle. If either segment returns
      // dM < 0, the whisker is drawn (and the round-join replace
      // protocol is broken).
      const r = halfW * 1.3
      const { p, seg0, seg1 } = probeAt(r)
      // eslint-disable-next-line no-console
      console.log('whisker probe at r=1.3×halfW:', { p, seg0, seg1 })
      expect(seg0.dM).toBeGreaterThan(0)
      expect(seg1.dM).toBeGreaterThan(0)
    })

    it('exterior-arc scan at r = 1.3 × halfW — no whisker past the round-join radius', () => {
      // Only scan angles where BOTH segments consider the fragment to
      // be "past" their corner endpoint (distP1 > 0 for e0, distP0 > 0
      // for e1). That's the geometric definition of the corner's
      // exterior region — inside segment bodies is legitimate body
      // coverage, not a whisker, and must not trigger the assertion.
      const r = halfW * 1.3
      const leaks: Array<{ theta: number; seg: string; branch: string; dM: number }> = []
      let probed = 0
      for (let deg = 0; deg < 360; deg += 1) {
        const theta = (deg * Math.PI) / 180
        const dirVec: V2 = [Math.cos(theta), Math.sin(theta)]
        const p: V2 = add(miterVertex, mul(dirVec, r))
        // Gate: fragment must be past e0's p1 AND past e1's p0 to be in
        // the exterior round-join region.
        const e0Dir: V2 = [1, 0]
        const e1Dir: V2 = [0, 1]
        const distP1e0 = dot(sub(p, e0P1), e0Dir)
        const distP0e1 = -dot(sub(p, e1P0), e1Dir)
        if (distP1e0 <= 0 || distP0e1 <= 0) continue
        probed++
        const seg0 = roundJoinDM(p, e0P0, e0P1, e0Prev, e0Next, halfW, offsetM, miterLimit, 'ROUND')
        const seg1 = roundJoinDM(p, e1P0, e1P1, e1Prev, e1Next, halfW, offsetM, miterLimit, 'ROUND')
        if (seg0.dM <= 0) leaks.push({ theta: deg, seg: 'e0', branch: seg0.branch, dM: seg0.dM })
        if (seg1.dM <= 0) leaks.push({ theta: deg, seg: 'e1', branch: seg1.branch, dM: seg1.dM })
      }
      // eslint-disable-next-line no-console
      console.log(`probed ${probed} exterior angles; leaks=${leaks.length}`)
      if (leaks.length > 0) {
        // eslint-disable-next-line no-console
        console.log('whisker leaks:', leaks.slice(0, 20))
      }
      expect(leaks).toEqual([])
    })
  })
})
