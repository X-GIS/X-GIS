// iter-297 — buildLineSegments fuzz. Edge cases:
//   empty vertices / indices
//   single-segment (2 indices)
//   odd index count (incomplete pair)
//   zero-length segment (p0 == p1)
//   NaN vertices (DSFUN can carry NaN if upstream decoder corrupted)
//   stride=6 vs 10 dispatch
//   tileWidthMerc=0 (no boundary join)

import { describe, it, expect } from 'vitest'
import { buildLineSegments, LINE_SEGMENT_STRIDE_F32 } from './line-segment-build'

// DSFUN stride 6 minimum: [mx_h, my_h, mx_l, my_l, feat_id, arc_start].
function v6(...rows: number[][]): Float32Array {
  const out = new Float32Array(rows.length * 6)
  for (let i = 0; i < rows.length; i++) {
    for (let k = 0; k < 6; k++) out[i * 6 + k] = rows[i]![k] ?? 0
  }
  return out
}

function idx(...ks: number[]): Uint32Array {
  return new Uint32Array(ks)
}

describe('iter-297 buildLineSegments fuzz', () => {
  it('empty vertices + indices → empty output', () => {
    const r = buildLineSegments(new Float32Array(0), new Uint32Array(0), 6)
    expect(r.length).toBe(0)
  })

  it('zero indices but non-empty vertices → empty output', () => {
    const v = v6([0, 0, 0, 0, 0, 0])
    const r = buildLineSegments(v, new Uint32Array(0), 6)
    expect(r.length).toBe(0)
  })

  it('single segment (2 indices) → 1 segment in output', () => {
    const v = v6([0, 0, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100])
    const r = buildLineSegments(v, idx(0, 1), 6)
    expect(r.length).toBe(LINE_SEGMENT_STRIDE_F32)
  })

  it('odd index count (3 indices) → does not crash', () => {
    const v = v6([0, 0, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100], [200, 0, 0, 0, 0, 200])
    expect(() => buildLineSegments(v, idx(0, 1, 2), 6)).not.toThrow()
  })

  it('zero-length segment (p0 == p1) → no crash', () => {
    const v = v6([50, 50, 0, 0, 0, 0], [50, 50, 0, 0, 0, 0])
    expect(() => buildLineSegments(v, idx(0, 1), 6)).not.toThrow()
  })

  it('NaN vertex does not crash builder', () => {
    const v = v6([NaN, NaN, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100])
    expect(() => buildLineSegments(v, idx(0, 1), 6)).not.toThrow()
  })

  it('Infinity vertex does not crash', () => {
    const v = v6([Infinity, 0, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100])
    expect(() => buildLineSegments(v, idx(0, 1), 6)).not.toThrow()
  })

  it('stride=10 (DSFUN with tangents) decodes', () => {
    // [mx_h, my_h, mx_l, my_l, feat_id, arc_start, tan0, tan1, tan2, tan3]
    const v = new Float32Array([
      0, 0, 0, 0, 0, 0, 1, 0, 1, 0,
      100, 0, 0, 0, 0, 100, 1, 0, 1, 0,
    ])
    expect(() => buildLineSegments(v, idx(0, 1), 10)).not.toThrow()
  })

  it('stride<6 throws explicit error (defensive)', () => {
    const v = new Float32Array([0, 0, 0, 0, 0, 100, 0, 0, 0, 0])
    expect(() => buildLineSegments(v, idx(0, 1), 5)).toThrow(/stride/)
  })

  it('large chain (1000 segments) does not OOM', () => {
    const N = 1000
    const v = new Float32Array(N * 6)
    const i = new Uint32Array((N - 1) * 2)
    for (let k = 0; k < N; k++) {
      v[k * 6] = k * 10
      v[k * 6 + 1] = k * 10
      v[k * 6 + 5] = k * 10  // arc_start
    }
    for (let k = 0; k < N - 1; k++) {
      i[k * 2] = k
      i[k * 2 + 1] = k + 1
    }
    expect(() => buildLineSegments(v, i, 6)).not.toThrow()
  })

  it('tileWidthMerc=0 still produces valid output', () => {
    const v = v6([0, 0, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100])
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0)
    expect(r.length).toBe(LINE_SEGMENT_STRIDE_F32)
  })

  it('heights map with no matching featId falls back to defaultHeight', () => {
    const v = v6([0, 0, 0, 0, 99, 0], [100, 0, 0, 0, 99, 100])
    const heights = new Map<number, number>([[42, 50]])  // 99 absent
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0, heights, undefined, undefined, 0)
    expect(r[16]).toBe(0)  // z_lift_m at offset 16
  })

  it('heights map with matching featId writes z_lift_m', () => {
    const v = v6([0, 0, 0, 0, 42, 0], [100, 0, 0, 0, 42, 100])
    const heights = new Map<number, number>([[42, 50]])
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0, heights, undefined, undefined, 0)
    expect(r[16]).toBe(50)
  })

  it('widths map per-feature override at offset 17', () => {
    const v = v6([0, 0, 0, 0, 7, 0], [100, 0, 0, 0, 7, 100])
    const widths = new Map<number, number>([[7, 3.5]])
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0, undefined, widths, undefined, 0)
    expect(r[17]).toBe(3.5)
  })

  it('widths absent for featId → 0 (legacy fallthrough)', () => {
    const v = v6([0, 0, 0, 0, 99, 0], [100, 0, 0, 0, 99, 100])
    const widths = new Map<number, number>([[42, 5]])
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0, undefined, widths, undefined, 0)
    expect(r[17]).toBe(0)
  })

  it('colors packed RGBA writes through u32 view at offset 18', () => {
    const v = v6([0, 0, 0, 0, 7, 0], [100, 0, 0, 0, 7, 100])
    const colors = new Map<number, number>([[7, 0xff0000ff]])
    const r = buildLineSegments(v, idx(0, 1), 6, 0, 0, undefined, undefined, colors, 0)
    const u32 = new Uint32Array(r.buffer)
    expect(u32[18]).toBe(0xff0000ff)
  })

  it('NaN featId does not crash heights/widths/colors lookup', () => {
    // Map.get(NaN) returns undefined, which falls back. Should be
    // safe but worth pinning.
    const v = v6([0, 0, 0, 0, NaN, 0], [100, 0, 0, 0, NaN, 100])
    const heights = new Map<number, number>([[42, 50]])
    expect(() => buildLineSegments(v, idx(0, 1), 6, 0, 0, heights, undefined, undefined, 0)).not.toThrow()
  })

  it('output buffer size is exactly segCount × LINE_SEGMENT_STRIDE_F32', () => {
    const N = 5
    const v = new Float32Array(N * 6)
    const i = new Uint32Array((N - 1) * 2)
    for (let k = 0; k < N - 1; k++) {
      i[k * 2] = k
      i[k * 2 + 1] = k + 1
    }
    const r = buildLineSegments(v, i, 6)
    expect(r.length).toBe((N - 1) * LINE_SEGMENT_STRIDE_F32)
  })

  // iter-316 — render-error gate: the SDF segment buffer feeds the
  // GPU line shader directly. A single non-finite float (from a
  // miter / tangent / pad-ratio computation on a degenerate chain)
  // poisons the segment quad → blank or smeared line. iter-297
  // checked offsets + no-crash; this asserts EVERY output float is
  // finite across realistic + degenerate chains.
  describe('iter-316 every-float-finite render gate', () => {
    function assertAllFinite(buf: Float32Array, ctx: string): void {
      for (let i = 0; i < buf.length; i++) {
        if (!Number.isFinite(buf[i]!)) throw new Error(`${ctx}[${i}] non-finite: ${buf[i]}`)
      }
    }

    function makeRng(seed: number): () => number {
      let s = seed | 0
      return () => {
        s ^= s << 13; s |= 0
        s ^= s >>> 17
        s ^= s << 5; s |= 0
        return ((s >>> 0) / 0x1_0000_0000)
      }
    }

    it('straight chain — all segment floats finite', () => {
      const v = v6([0, 0, 0, 0, 0, 0], [100, 0, 0, 0, 0, 100], [200, 50, 0, 0, 0, 250])
      const r = buildLineSegments(v, idx(0, 1, 1, 2), 6, 1000, 1000)
      assertAllFinite(r, 'straight')
    })

    it('sharp hairpin (near-180° turn) — miter pad stays finite', () => {
      // A→B→A' where B is the apex: tangent reverses, miter pad
      // formula can blow up if not guarded.
      const v = v6([0, 0, 0, 0, 0, 0], [100, 0.001, 0, 0, 0, 100], [0, 0.002, 0, 0, 0, 200])
      const r = buildLineSegments(v, idx(0, 1, 1, 2), 6, 1000, 1000)
      assertAllFinite(r, 'hairpin')
    })

    it('FAIL-BEFORE (#463): a ~180° reversal BEVELS (pad 1), not miterLimit — no whisker spike', () => {
      // seg0 = (0,0)→(100,0), seg1 = (100,0)→(0,0): the join at the apex is a
      // ~180° reversal. Pre-#463 the denom<1e-6 guard returned miterLimit (4),
      // extending the quad 4×half_w along the reversed segment → a perpendicular
      // whisker at dense-vertex clusters. It must bevel (pad 1) instead.
      const v = v6([0, 0, 0, 0, 0, 0], [100, 0.0001, 0, 0, 0, 100], [0, 0.0002, 0, 0, 0, 200])
      const r = buildLineSegments(v, idx(0, 1, 1, 2), 6, 1000, 1000)
      const padP1Seg0 = r[0 * LINE_SEGMENT_STRIDE_F32 + 15] // slot 15 = pad_ratio_p1 (join at apex)
      expect(padP1Seg0).toBeLessThanOrEqual(1)
    })

    it('coincident consecutive vertices — zero tangent guarded', () => {
      const v = v6([5, 5, 0, 0, 0, 0], [5, 5, 0, 0, 0, 0], [10, 10, 0, 0, 0, 7])
      const r = buildLineSegments(v, idx(0, 1, 1, 2), 6, 1000, 1000)
      assertAllFinite(r, 'coincident')
    })

    it('200 random chains of varying angle — all finite', () => {
      const rng = makeRng(0x11ce)
      for (let trial = 0; trial < 200; trial++) {
        const n = 2 + Math.floor(rng() * 8)
        const rows: number[][] = []
        for (let k = 0; k < n; k++) {
          rows.push([(rng() * 2 - 1) * 1000, (rng() * 2 - 1) * 1000, 0, 0, 0, k * 10])
        }
        const v = v6(...rows)
        const ix: number[] = []
        for (let k = 0; k < n - 1; k++) { ix.push(k, k + 1) }
        const r = buildLineSegments(v, idx(...ix), 6, 1000, 1000)
        assertAllFinite(r, `rand-${trial}`)
      }
    })

    it('boundary-coincident endpoints (tile-join detection) finite', () => {
      // Chain ending exactly on the tile boundary triggers the
      // virtual-join (no-cap) path. Width/height set so detection
      // fires.
      const W = 1000, H = 1000
      const v = v6([0, 500, 0, 0, 0, 0], [W, 500, 0, 0, 0, W])  // ends on east edge
      const r = buildLineSegments(v, idx(0, 1), 6, W, H)
      assertAllFinite(r, 'boundary-join')
    })
  })
})
