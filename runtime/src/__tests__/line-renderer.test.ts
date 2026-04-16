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

  it('LINE_UNIFORM_SIZE includes the offset slot (≥ 192 bytes)', () => {
    expect(LINE_UNIFORM_SIZE).toBeGreaterThanOrEqual(192)
    expect(LINE_UNIFORM_SIZE % 16).toBe(0)
  })
})

describe('buildLineSegments', () => {
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

  it('returns zero arc for stride-5 polygon-outline input (BFS fallback)', () => {
    // DSFUN polygon vertices: stride 5 [mx_h, my_h, mx_l, my_l, feat_id].
    const vertices = dsfunPolyVerts([
      [0,    0],
      [1000, 0],
      [2000, 0],
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 5)

    // BFS arc: seg 0 start at 0, seg 1 start at seg 0 length
    const seg0ArcStart = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_ARC_START]
    const seg1ArcStart = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_ARC_START]
    expect(seg0ArcStart).toBe(0)
    // Seg 1 arc_start should equal seg 0's length (1000 m)
    expect(seg1ArcStart).toBeCloseTo(1000, 0)
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
})
