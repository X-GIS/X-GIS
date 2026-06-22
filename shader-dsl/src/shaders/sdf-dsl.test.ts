import { describe, expect, it } from 'vitest'
import { compileModule } from '../core/oracle'
import { emitModule } from '../core/backends/wgsl'
import { SDF_MODULE } from './sdf'

// US-P0-5 (PoC-B): the imperative thesis. sdf_shape exercises for-loops,
// switch, var, compound assign (min=/+=), early return and nested if — the
// machinery compute_line_color needs. This proves those statement-list nodes
// lower correctly: the CPU interpreter reproduces a hand transcription of
// WGSL_SDF_SHAPE, and the WGSL backend emits a structurally well-formed
// shader (executed-GPU compile is the e2e gate, US-P0-4 family).

type V2 = [number, number]
const mix = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
const dist2 = (p: V2, q: V2): number => Math.hypot(p[0] - q[0], p[1] - q[1])

function distToSegmentRef(p: V2, a: V2, b: V2): number {
  const ab: V2 = [b[0] - a[0], b[1] - a[1]]
  const len2 = ab[0] * ab[0] + ab[1] * ab[1]
  if (len2 < 1e-10) return dist2(p, a)
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / len2))
  return Math.hypot(p[0] - a[0] - ab[0] * t, p[1] - a[1] - ab[1] * t)
}
function distToQuadRef(p: V2, a: V2, b: V2, c: V2): number {
  let best = 1e10
  for (let i = 0; i <= 16; i++) { const t = i / 16; best = Math.min(best, dist2(p, mix(mix(a, b, t), mix(b, c, t), t))) }
  return best
}
function distToCubicRef(p: V2, a: V2, b: V2, c: V2, d: V2): number {
  let best = 1e10
  for (let i = 0; i <= 24; i++) {
    const t = i / 24
    const ab = mix(a, b, t), bc = mix(b, c, t), cd = mix(c, d, t)
    best = Math.min(best, dist2(p, mix(mix(ab, bc, t), mix(bc, cd, t), t)))
  }
  return best
}
function windingRef(p: V2, a: V2, b: V2): number {
  if (a[1] <= p[1]) {
    if (b[1] > p[1]) { const cv = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]); if (cv > 0) return 1 }
  } else {
    if (b[1] <= p[1]) { const cv = (b[0] - a[0]) * (p[1] - a[1]) - (p[0] - a[0]) * (b[1] - a[1]); if (cv < 0) return -1 }
  }
  return 0
}

interface Seg { kind: number; color_idx: number; flags: number; _pad: number; p0: V2; p1: V2; p2: V2; p3: V2 }
interface Shape { seg_start: number; seg_count: number; bbox_min_x: number; bbox_min_y: number; bbox_max_x: number; bbox_max_y: number; _pad0: number; _pad1: number }
const seg = (kind: number, p0: V2, p1: V2, p2: V2 = [0, 0], p3: V2 = [0, 0]): Seg => ({ kind, color_idx: 0, flags: 0, _pad: 0, p0, p1, p2, p3 })

function sdfRef(uvIn: V2, shapes: Shape[], segs: Seg[], shapeId: number): number {
  const uv: V2 = [uvIn[0], -uvIn[1]]
  const s = shapes[shapeId]
  if (uv[0] < s.bbox_min_x || uv[0] > s.bbox_max_x || uv[1] < s.bbox_min_y || uv[1] > s.bbox_max_y) return 2
  let md = 1e10, w = 0
  const end = Math.min(s.seg_start + s.seg_count, s.seg_start + 32)
  for (let i = s.seg_start; i < end; i++) {
    const g = segs[i]
    switch (g.kind) {
      case 0: md = Math.min(md, distToSegmentRef(uv, g.p0, g.p1)); w += windingRef(uv, g.p0, g.p1); break
      case 1: md = Math.min(md, distToQuadRef(uv, g.p0, g.p1, g.p2)); w += windingRef(uv, g.p0, g.p2); break
      case 2: md = Math.min(md, distToCubicRef(uv, g.p0, g.p1, g.p2, g.p3)); w += windingRef(uv, g.p0, g.p3); break
    }
  }
  return w !== 0 ? 1 - md : 1 + md
}

const M = compileModule(SDF_MODULE)

describe('PoC-B: SDF dist/winding helpers (cpu interpreter ↔ hand reference)', () => {
  it('dist_to_segment matches reference', () => {
    const cases: Array<[V2, V2, V2]> = [
      [[0, 0], [-1, 0], [1, 0]], [[0.5, 0.5], [0, 0], [1, 0]], [[2, 2], [0, 0], [1, 1]],
    ]
    for (const [p, a, b] of cases) {
      expect(M.fns.dist_to_segment(p, a, b) as number).toBeCloseTo(distToSegmentRef(p, a, b), 6)
    }
  })
  it('winding_line matches reference (the +1/-1/0 ray-cast)', () => {
    const cases: Array<[V2, V2, V2]> = [
      [[0, 0], [-1, -1], [1, 1]], [[0, 0], [1, 1], [-1, -1]], [[0, 0], [1, -1], [1, 1]], [[5, 5], [0, 0], [1, 1]],
    ]
    for (const [p, a, b] of cases) {
      expect(M.fns.winding_line(p, a, b) as number).toBe(windingRef(p, a, b))
    }
  })
  it('dist_to_quadratic / dist_to_cubic loops match reference (16/24-step)', () => {
    const p: V2 = [0.3, 0.2]
    expect(M.fns.dist_to_quadratic(p, [-1, 0], [0, 1], [1, 0]) as number)
      .toBeCloseTo(distToQuadRef(p, [-1, 0], [0, 1], [1, 0]), 6)
    expect(M.fns.dist_to_cubic(p, [-1, 0], [-0.3, 1], [0.3, -1], [1, 0]) as number)
      .toBeCloseTo(distToCubicRef(p, [-1, 0], [-0.3, 1], [0.3, -1], [1, 0]), 6)
  })
})

describe('PoC-B: sdf_shape full imperative core (bbox cull + segment loop + switch)', () => {
  // Triangle in path (flipped-y) space: A=(-0.5,-0.5) B=(0.5,-0.5) C=(0,0.5).
  const shapes: Shape[] = [{ seg_start: 0, seg_count: 3, bbox_min_x: -1, bbox_min_y: -1, bbox_max_x: 1, bbox_max_y: 1, _pad0: 0, _pad1: 0 }]
  const tri: Seg[] = [
    seg(0, [-0.5, -0.5], [0.5, -0.5]),
    seg(0, [0.5, -0.5], [0, 0.5]),
    seg(0, [0, 0.5], [-0.5, -0.5]),
  ]
  M.setBinding('shapes', shapes as unknown as never)
  M.setBinding('segments', tri as unknown as never)

  it('matches the hand reference across a grid (for/switch/compound-assign correct)', () => {
    for (let x = -1.2; x <= 1.2; x += 0.2) {
      for (let y = -1.2; y <= 1.2; y += 0.2) {
        const uvIn: V2 = [x, y]
        const got = M.fns.sdf_shape(uvIn, 0) as number
        expect(got).toBeCloseTo(sdfRef(uvIn, shapes, tri, 0), 5)
      }
    }
  })

  it('point outside the bbox short-circuits to 2.0', () => {
    expect(M.fns.sdf_shape([5, 5], 0) as number).toBe(2)
  })

  it('inside the triangle: winding != 0 → value < 1 (1 - min_dist)', () => {
    // Centroid (0, -0.166…) in path space = uv_in (0, +0.166…).
    const got = M.fns.sdf_shape([0, 0.1667], 0) as number
    expect(got).toBeLessThan(1)
  })

  it('a quadratic + cubic segment shape also matches reference (kinds 1 & 2)', () => {
    const sh: Shape[] = [{ seg_start: 0, seg_count: 2, bbox_min_x: -2, bbox_min_y: -2, bbox_max_x: 2, bbox_max_y: 2, _pad0: 0, _pad1: 0 }]
    const segs: Seg[] = [
      seg(1, [-1, 0], [0, 1], [1, 0]),
      seg(2, [1, 0], [0.3, -1], [-0.3, -1], [-1, 0]),
    ]
    const m2 = compileModule(SDF_MODULE)
    m2.setBinding('shapes', sh as unknown as never)
    m2.setBinding('segments', segs as unknown as never)
    for (let x = -1.5; x <= 1.5; x += 0.3) {
      for (let y = -1.5; y <= 1.5; y += 0.3) {
        expect(m2.fns.sdf_shape([x, y], 0) as number).toBeCloseTo(sdfRef([x, y], sh, segs, 0), 5)
      }
    }
  })
})

describe('PoC-B: WGSL backend emits a structurally valid sdf shader', () => {
  const wgsl = emitModule(SDF_MODULE)
  it('declares the storage structs + bindings', () => {
    expect(wgsl).toContain('struct ShapeDesc {')
    expect(wgsl).toContain('struct ShapeSegment {')
    expect(wgsl).toContain('@group(0) @binding(8) var<storage, read> shapes: array<ShapeDesc>;')
    expect(wgsl).toContain('@group(0) @binding(9) var<storage, read> segments: array<ShapeSegment>;')
  })
  it('emits the imperative constructs (for / switch / compound assign)', () => {
    expect(wgsl).toContain('fn sdf_shape(uv_in: vec2<f32>, shape_id: u32) -> f32')
    // for-counter `i` (u32) iterating up to a bound with step 1u. The old hand
    // `let end = …` was dropped in the inline migration, so the loop bound is now
    // an inlined/cse'd expr — generalize the RHS of `(i < …)` to any non-`;` expr
    // while still pinning the for-construct, the u32 counter, the `i < bound`
    // comparison, and the increment-by-1u update.
    expect(wgsl).toMatch(/for \(var i: u32 = [^;]+; \(i < [^;]+\); i = \(i \+ 1u\)\)/)
    expect(wgsl).toContain('switch ') // segment-kind dispatch
    expect(wgsl).toContain('case 0u: {')
    // min_dist + winding are authored as plain `const` (no Var); the auto-vars pass materialises
    // them as vars with auto names (`_avN`), so pin the assign SHAPE, not the name.
    expect(wgsl).toMatch(/(\w+) = min\(\1,/)        // acc = min(acc, …)  (min-fold accumulator)
    expect(wgsl).toMatch(/\w+ \+= winding_line\(/)   // acc += winding_line(…)  (compound assign)
  })
  it('is structurally balanced', () => {
    expect((wgsl.match(/{/g) ?? []).length).toBe((wgsl.match(/}/g) ?? []).length)
    expect((wgsl.match(/\(/g) ?? []).length).toBe((wgsl.match(/\)/g) ?? []).length)
  })
})
