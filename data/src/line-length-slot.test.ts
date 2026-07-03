import { describe, expect, it } from 'vitest'
import { buildLineSegments, LINE_SEGMENT_STRIDE_F32 } from './line-segment-build'

// line_length lives at f32 offset 13 of each segment (see the layout
// comment in line-segment-build.ts). The pattern shader reads it as
// `seg.line_length` to place END/CENTER patterns in polyline-arc space.
const OFF_ARC_START = 12
const OFF_LINE_LENGTH = 13

/**
 * Build a stride-6 DSFUN line vertex stream:
 *   [mx_h, my_h, mx_l, my_l, feat_id, arc_start]
 * `arc` mirrors what the compiler's augmentChainWithArc bakes at vertex[5]
 * (per-polyline-relative cumulative arc length). Small tile-local meters so
 * Math.fround high/low reconstruction is exact.
 */
function dsfunLineVerts(coords: Array<[number, number, number]>): Float32Array {
  const out = new Float32Array(coords.length * 6)
  for (let i = 0; i < coords.length; i++) {
    const [mx, my, arc] = coords[i]
    out[i * 6 + 0] = Math.fround(mx)
    out[i * 6 + 1] = Math.fround(my)
    out[i * 6 + 2] = 0
    out[i * 6 + 3] = 0
    out[i * 6 + 4] = 0
    out[i * 6 + 5] = arc
  }
  return out
}

describe('buildLineSegments — line_length (slot 13)', () => {
  it('(a) sets slot 13 to the polyline total length for every segment', () => {
    // A single straight polyline, 4 vertices along +x. Total length L = 300.
    // arc_start increases per vertex; the far endpoint carries arc=300.
    const L = 300
    const vertices = dsfunLineVerts([
      [0, 0, 0],
      [100, 0, 100],
      [200, 0, 200],
      [300, 0, 300],
    ])
    const indices = new Uint32Array([0, 1, 1, 2, 2, 3])
    const seg = buildLineSegments(vertices, indices, 6)

    const segCount = indices.length / 2
    expect(seg.length).toBe(segCount * LINE_SEGMENT_STRIDE_F32)
    for (let s = 0; s < segCount; s++) {
      const lineLength = seg[s * LINE_SEGMENT_STRIDE_F32 + OFF_LINE_LENGTH]
      // Fails before the fix (slot 13 was always 0); passes after.
      expect(lineLength).toBeCloseTo(L, 3)
    }
  })

  it('(b) two disjoint polylines each carry their OWN total length', () => {
    // Polyline A: vertices 0..2, total length 300.
    // Polyline B: vertices 3..4, total length 50.
    // No shared endpoint → two connected components.
    const vertices = dsfunLineVerts([
      [0, 0, 0], // A v0
      [200, 0, 200], // A v1
      [300, 0, 300], // A v2  (A total = 300)
      [0, 1000, 0], // B v0
      [50, 1000, 50], // B v1  (B total = 50)
    ])
    const indices = new Uint32Array([0, 1, 1, 2, 3, 4])
    const seg = buildLineSegments(vertices, indices, 6)

    // Segments 0,1 belong to A → 300
    expect(seg[0 * LINE_SEGMENT_STRIDE_F32 + OFF_LINE_LENGTH]).toBeCloseTo(300, 3)
    expect(seg[1 * LINE_SEGMENT_STRIDE_F32 + OFF_LINE_LENGTH]).toBeCloseTo(300, 3)
    // Segment 2 belongs to B → 50, NOT 300
    expect(seg[2 * LINE_SEGMENT_STRIDE_F32 + OFF_LINE_LENGTH]).toBeCloseTo(50, 3)
  })

  it('(c) arc_start increases per segment while line_length stays constant = L', () => {
    // Proves the two slots have the right relationship for the shader's
    // END (line_length - startM) / CENTER (line_length * 0.5) math:
    // arc_start is the per-segment baseline, line_length is the shared total.
    const L = 600
    const vertices = dsfunLineVerts([
      [0, 0, 0],
      [100, 0, 100],
      [350, 0, 350],
      [600, 0, 600],
    ])
    const indices = new Uint32Array([0, 1, 1, 2, 2, 3])
    const seg = buildLineSegments(vertices, indices, 6)

    const arcStarts: number[] = []
    const segCount = indices.length / 2
    for (let s = 0; s < segCount; s++) {
      arcStarts.push(seg[s * LINE_SEGMENT_STRIDE_F32 + OFF_ARC_START])
      expect(seg[s * LINE_SEGMENT_STRIDE_F32 + OFF_LINE_LENGTH]).toBeCloseTo(L, 3)
    }
    // arc_start strictly increases per segment.
    expect(arcStarts).toEqual([0, 100, 350])
    for (let s = 1; s < arcStarts.length; s++) {
      expect(arcStarts[s]).toBeGreaterThan(arcStarts[s - 1])
    }
    // arc_start of the last segment + its length == line_length (END lands
    // on the polyline's far endpoint).
    const lastStart = arcStarts[arcStarts.length - 1]
    expect(lastStart + 250).toBeCloseTo(L, 3) // last seg spans 350→600 = 250
  })
})
