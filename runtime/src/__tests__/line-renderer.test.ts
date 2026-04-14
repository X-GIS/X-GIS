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
  it('carries arc_start from stride-4 vertices into the segment struct', () => {
    // Two segments representing a single polyline with 3 vertices.
    // Arc values simulate what the tiler would write:
    //   v0 arc=0, v1 arc=100m, v2 arc=250m
    // vertex layout: [lon_rel, lat_rel, featId, arcStart]
    const vertices = new Float32Array([
      0.00, 0.00, 0, 0,        // v0
      0.01, 0.00, 0, 100,      // v1  (100m along feature)
      0.02, 0.00, 0, 250,      // v2  (250m along feature)
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 0, 4)

    expect(segData.length).toBe(2 * LINE_SEGMENT_STRIDE_F32)

    // Segment 0: arc_start should be 0 (from v0.arc)
    const seg0ArcStart = segData[0 * LINE_SEGMENT_STRIDE_F32 + 8]
    expect(seg0ArcStart).toBe(0)

    // Segment 1: arc_start should be 100 (from v1.arc)
    const seg1ArcStart = segData[1 * LINE_SEGMENT_STRIDE_F32 + 8]
    expect(seg1ArcStart).toBe(100)
  })

  it('computes prev_tangent/next_tangent for adjacent segments that share a vertex', () => {
    const vertices = new Float32Array([
      0.00, 0.00, 0, 0,
      0.01, 0.00, 0, 0,
      0.02, 0.00, 0, 0,
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 0, 4)

    // Segment 0: no prev (first seg), next should point toward v2
    const seg0PrevX = segData[0 * LINE_SEGMENT_STRIDE_F32 + 4]
    const seg0PrevY = segData[0 * LINE_SEGMENT_STRIDE_F32 + 5]
    const seg0NextX = segData[0 * LINE_SEGMENT_STRIDE_F32 + 6]
    const seg0NextY = segData[0 * LINE_SEGMENT_STRIDE_F32 + 7]
    expect(seg0PrevX).toBe(0)
    expect(seg0PrevY).toBe(0)
    expect(Math.abs(seg0NextX)).toBeGreaterThan(0.99) // unit x-ish
    expect(Math.abs(seg0NextY)).toBeLessThan(0.02)

    // Segment 1: prev should be non-zero, next should be zero
    const seg1PrevX = segData[1 * LINE_SEGMENT_STRIDE_F32 + 4]
    const seg1NextX = segData[1 * LINE_SEGMENT_STRIDE_F32 + 6]
    const seg1NextY = segData[1 * LINE_SEGMENT_STRIDE_F32 + 7]
    expect(Math.abs(seg1PrevX)).toBeGreaterThan(0.99)
    expect(seg1NextX).toBe(0)
    expect(seg1NextY).toBe(0)
  })

  describe('miter pad ratios (cap/join quad shrinking)', () => {
    const OFF_PAD_P0 = 10
    const OFF_PAD_P1 = 11

    it('caps: start segment with no prev → pad_p0 = 1 (cap margin, not 4)', () => {
      // Single-segment polyline from (0,0) to (0.01,0): both endpoints are caps.
      const vertices = new Float32Array([
        0.00, 0.00, 0, 0,
        0.01, 0.00, 0, 0,
      ])
      const indices = new Uint32Array([0, 1])
      const segData = buildLineSegments(vertices, indices, 0, 4)
      expect(segData[OFF_PAD_P0]).toBe(1)
      expect(segData[OFF_PAD_P1]).toBe(1)
    })

    it('straight line join: pad ratio stays at 1 (no miter needed)', () => {
      // Collinear polyline with 3 points. The middle join is a straight
      // continuation, so both segments' p1 (seg 0) / p0 (seg 1) should
      // collapse to pad = 1 instead of the worst-case 4.
      const vertices = new Float32Array([
        0.00, 0.00, 0, 0,
        0.01, 0.00, 0, 0,
        0.02, 0.00, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 0, 4)
      // seg 0: p0 is a cap (no prev) → 1. p1 is a straight join → 1.
      expect(segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]).toBe(1)
      expect(segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]).toBe(1)
      // seg 1: p0 is a straight join → 1. p1 is a cap → 1.
      expect(segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]).toBe(1)
      expect(segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]).toBe(1)
    })

    it('90° corner join: pad ratio ≈ 1.41 (1/sin(45°))', () => {
      // L-shape: (0,0) → (1,0) → (1,1). Middle join is a 90° turn.
      // sin(half_angle) = sin(45°) = 0.707 → pad = 1/0.707 ≈ 1.414.
      // Use lat≈0 rows so Mercator is approximately unit per degree × R — the
      // ratio is geometric so the actual scale doesn't matter.
      const vertices = new Float32Array([
        0.00, 0.00, 0, 0,
        0.01, 0.00, 0, 0,
        0.01, 0.01, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 0, 4)
      // seg 0: p1 is the 90° corner (joining with seg 1)
      const seg0PadP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      expect(seg0PadP1).toBeGreaterThan(1.3)
      expect(seg0PadP1).toBeLessThan(1.5)
      // seg 1: p0 is the same 90° corner
      const seg1PadP0 = segData[1 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P0]
      expect(seg1PadP0).toBeGreaterThan(1.3)
      expect(seg1PadP0).toBeLessThan(1.5)
    })

    it('gentle turn beyond miter limit: pad ratio clamps to 1 (bevel fallback)', () => {
      // Very gentle turn (10° external angle). Half-angle = 5°, sin = 0.0872.
      // That is below 1/miter_limit = 0.25, so the miter is longer than 4×half_w
      // and CPU should fall back to pad = 1 (bevel).
      //
      // Note: in stroke rendering, GENTLE turns have LONG miters (the two
      // outer edges are nearly parallel), while sharp U-turns have SHORT
      // miters. Miter limit catches the gentle-turn case.
      const cos10 = Math.cos(10 * Math.PI / 180)
      const sin10 = Math.sin(10 * Math.PI / 180)
      const vertices = new Float32Array([
        0,             0,             0, 0,
        0.01,          0,             0, 0,
        0.01 + 0.01 * cos10, 0.01 * sin10, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 0, 4)
      const seg0PadP1 = segData[0 * LINE_SEGMENT_STRIDE_F32 + OFF_PAD_P1]
      expect(seg0PadP1).toBe(1)
    })

    it('pad ratio never exceeds the miter limit (4)', () => {
      // Loop every segment in a randomly shaped polyline and assert pads are
      // in the valid range [1, 4]. Smoke test for unexpected values.
      const vertices = new Float32Array([
        0.00, 0.00, 0, 0,
        0.01, 0.00, 0, 0,
        0.01, 0.01, 0, 0,
        0.02, 0.01, 0, 0,
        0.02, 0.02, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2, 2, 3, 3, 4])
      const segData = buildLineSegments(vertices, indices, 0, 4)
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

  it('returns zero arc for stride-3 input (polygon outline fallback uses BFS)', () => {
    const vertices = new Float32Array([
      0.00, 0.00, 0,
      0.01, 0.00, 0,
      0.02, 0.00, 0,
    ])
    const indices = new Uint32Array([0, 1, 1, 2])

    const segData = buildLineSegments(vertices, indices, 0, 3)

    // BFS arc: seg 0 start at 0, seg 1 start at seg 0 length
    const seg0ArcStart = segData[0 * LINE_SEGMENT_STRIDE_F32 + 8]
    const seg1ArcStart = segData[1 * LINE_SEGMENT_STRIDE_F32 + 8]
    expect(seg0ArcStart).toBe(0)
    // Seg 1 arc_start should equal seg 0's length (~1113 m for 0.01 lon)
    expect(seg1ArcStart).toBeGreaterThan(1000)
    expect(seg1ArcStart).toBeLessThan(1200)
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
      // Both perps use the same "side of travel" convention:
      // left-perp-of-tangent × side. Matches vs_line exactly.
      const perpCur = mul(perp(dir), side)
      if (!neighborTangent) return mul(perpCur, halfW)
      const perpN = mul(perp(neighborTangent), side)
      const miterVec = add(perpCur, perpN)
      const proj = dot(miterVec, perpCur)
      if (proj < 1e-4 || len(miterVec) < 1e-3) return mul(perpCur, halfW)
      if (len(miterVec) > miterLimit * proj) return mul(perpCur, halfW) // bevel
      return mul(miterVec, halfW / proj)
    }

    it('two right-angle adjacent segments share the outer miter vertex', () => {
      // Chain v0=(0,0) → v1=(1,0) → v2=(1,1). 90° left turn at v1.
      // Mercator projection of tiny lon/lat differences is approximately
      // linear, so we construct directly in tile-local meter space by
      // sampling via the same adjacency logic.
      const vertices = new Float32Array([
        0.000, 0.000, 0, 0,
        0.010, 0.000, 0, 0,
        0.010, 0.010, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const segData = buildLineSegments(vertices, indices, 0, 4)

      // Read seg0: p1=v1, next_tangent = direction from v1 to v2 (≈ (0,1))
      const s0 = 0 * LINE_SEGMENT_STRIDE_F32
      const p0Seg0: V2 = [segData[s0 + 0], segData[s0 + 1]]
      const p1Seg0: V2 = [segData[s0 + 2], segData[s0 + 3]]
      const nextSeg0: V2 = [segData[s0 + 6], segData[s0 + 7]]

      // Read seg1: p0=v1, prev_tangent = direction from v0 to v1 (≈ (1,0))
      const s1 = 1 * LINE_SEGMENT_STRIDE_F32
      const p0Seg1: V2 = [segData[s1 + 0], segData[s1 + 1]]
      const prevSeg1: V2 = [segData[s1 + 4], segData[s1 + 5]]

      // Shared endpoint must match
      expect(p1Seg0[0]).toBeCloseTo(p0Seg1[0], 4)
      expect(p1Seg0[1]).toBeCloseTo(p0Seg1[1], 4)

      // Compute dir of each segment
      const dir0: V2 = [p1Seg0[0] - p0Seg0[0], p1Seg0[1] - p0Seg0[1]]
      const L0 = len(dir0)
      const d0: V2 = [dir0[0] / L0, dir0[1] / L0]

      // For seg1 we need p1 as well
      const p1Seg1: V2 = [segData[s1 + 2], segData[s1 + 3]]
      const dir1: V2 = [p1Seg1[0] - p0Seg1[0], p1Seg1[1] - p0Seg1[1]]
      const L1 = len(dir1)
      const d1: V2 = [dir1[0] / L1, dir1[1] / L1]

      const halfW = 50 // 50 m stroke
      const miterLimit = 4

      // Outer side test: side=+1 on seg0's end (using next_tangent)
      // and seg1's start (using prev_tangent) must hit the same absolute position.
      for (const side of [-1, +1]) {
        // Seg 0 end-side: base=p1Seg0, neighbor=nextSeg0
        const off0 = miterOffset(d0, nextSeg0, side, halfW, miterLimit)
        const v0: V2 = [p1Seg0[0] + off0[0], p1Seg0[1] + off0[1]]
        // Seg 1 start-side: base=p0Seg1, neighbor=prevSeg1
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
      // Replicate fs_line's offset miter computation exactly.
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
      const vertices = new Float32Array([
        0.000, 0.000, 0, 0,
        0.010, 0.000, 0, 0,
        0.010, 0.010, 0, 0,
      ])
      const indices = new Uint32Array([0, 1, 1, 2])
      const seg = buildLineSegments(vertices, indices, 0, 4)

      // Seg 0: end side (p1 = shared join vertex), use next_tangent
      const s0 = 0 * LINE_SEGMENT_STRIDE_F32
      const p1Seg0: V2 = [seg[s0 + 2], seg[s0 + 3]]
      const dir0: V2 = [seg[s0 + 2] - seg[s0 + 0], seg[s0 + 3] - seg[s0 + 1]]
      const dir0Unit: V2 = mul(dir0, 1 / len(dir0))
      const nextSeg0: V2 = [seg[s0 + 6], seg[s0 + 7]]

      // Seg 1: start side (p0 = shared join vertex), use prev_tangent
      const s1 = 1 * LINE_SEGMENT_STRIDE_F32
      const p0Seg1: V2 = [seg[s1 + 0], seg[s1 + 1]]
      const dir1: V2 = [seg[s1 + 2] - seg[s1 + 0], seg[s1 + 3] - seg[s1 + 1]]
      const dir1Unit: V2 = mul(dir1, 1 / len(dir1))
      const prevSeg1: V2 = [seg[s1 + 4], seg[s1 + 5]]

      const offsetM = 50

      // p1 join center (computed from seg 0's perspective at its end)
      const center0 = offsetJoinCenter(p1Seg0, dir0Unit, nextSeg0, offsetM)
      // p0 join center (computed from seg 1's perspective at its start)
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
})
