import { describe, expect, it } from 'vitest'
import { Lexer, Parser, lower, optimize, emitCommands } from '@xgis/compiler'
import { packLineLayerUniform, LINE_CAP_BUTT, LINE_JOIN_MITER } from '../engine/render/line-renderer'

// Replicates the exact DSL → IR → ShowCommand → VTR dash conversion →
// packLineLayerUniform pipeline that runs in the browser, without any
// WebGPU dependency. Lets us assert the final uniform bytes match what
// the WGSL dash branch expects, for the actual demo source strings.
//
// IMPORTANT: this includes the `optimize` pass — the pass that silently
// stripped dashArray in an earlier version of optimizeNode. Keep it.

function compileDemo(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = optimize(lower(ast), ast)
  return emitCommands(scene)
}

/** Mirrors the VTR dash object that `writeLayerUniform` receives. */
function vtrDash(show: { dashArray?: number[]; dashOffset?: number }, mpp: number) {
  if (!show.dashArray || show.dashArray.length < 2) return null
  return {
    array: show.dashArray.map(v => v * mpp),
    offset: (show.dashOffset ?? 0) * mpp,
  }
}

describe('end-to-end dash pipeline', () => {
  const DASHED_LINES_DEMO = `
    source coast {
      type: geojson
      url: "ne_110m_coastline.geojson"
    }
    layer simple_dash {
      source: coast
      | stroke-sky-400 stroke-2
      | stroke-dasharray-20-10
    }
  `

  it('dashed-lines demo: emitted ShowCommand has dashArray = [20, 10]', () => {
    const commands = compileDemo(DASHED_LINES_DEMO)
    expect(commands.shows).toHaveLength(1)
    expect(commands.shows[0].dashArray).toEqual([20, 10])
  })

  it('dashed-lines demo: uniform buffer has dash_enable bit and correct cycle at zoom 5', () => {
    const commands = compileDemo(DASHED_LINES_DEMO)
    const show = commands.shows[0]
    const mpp = (40075016.686 / 256) / Math.pow(2, 5) // ≈ 4891.97
    const dash = vtrDash(show, mpp)
    expect(dash).not.toBeNull()
    expect(dash!.array).toEqual([20 * mpp, 10 * mpp])

    const buf = packLineLayerUniform(
      [0, 0.7, 0.95, 1],
      show.strokeWidth ?? 1,
      show.opacity ?? 1,
      mpp,
      LINE_CAP_BUTT,
      LINE_JOIN_MITER,
      4,
      dash,
    )
    const u32 = new Uint32Array(buf.buffer)

    // Flags: bit 5 = dash_enable must be set
    const flags = u32[8]
    expect((flags >>> 5) & 1).toBe(1)

    // dash_count = 2
    expect(u32[9]).toBe(2)

    // dash_cycle_m ≈ 30 * 4891.97
    expect(buf[10]).toBeCloseTo(30 * mpp, 2)

    // dash_array[0].x = 20 * mpp, [0].y = 10 * mpp
    expect(buf[12]).toBeCloseTo(20 * mpp, 2)
    expect(buf[13]).toBeCloseTo(10 * mpp, 2)
  })

  it('pattern-lines demo: both composite dash and railway_tie pattern reach their slots', () => {
    const PATTERN_DEMO = `
      symbol railway_tie {
        path "M -0.25 -1 L 0.25 -1 L 0.25 1 L -0.25 1 Z"
      }
      source coast {
        type: geojson
        url: "ne_110m_coastline.geojson"
      }
      layer railway_coast {
        source: coast
        | stroke-amber-300 stroke-2 stroke-arrow-cap
        | stroke-dasharray-40-10
        | stroke-pattern-railway_tie stroke-pattern-spacing-60px stroke-pattern-size-14px
      }
    `
    const commands = compileDemo(PATTERN_DEMO)
    expect(commands.shows).toHaveLength(1)
    const show = commands.shows[0]
    expect(show.linecap).toBe('arrow')
    expect(show.dashArray).toEqual([40, 10])
    expect(show.patterns).toBeDefined()
    expect(show.patterns).toHaveLength(1)
    expect(show.patterns![0].shape).toBe('railway_tie')
    expect(show.patterns![0].spacing).toBe(60)
    expect(show.patterns![0].spacingUnit).toBe('px')
  })

  it('probes phase calculation: at zoom 5, a fragment at arc=0 is in the DASH range', () => {
    const mpp = (40075016.686 / 256) / Math.pow(2, 5)
    const dashArrayM = [20 * mpp, 10 * mpp]
    const cycleM = dashArrayM[0] + dashArrayM[1]
    // Emulate shader's phase calc: fract((arc_pos + offset) / cycle) * cycle
    function phaseAt(arc: number): number {
      const p = (arc + 0) / cycleM
      return (p - Math.floor(p)) * cycleM
    }
    // Walk a few arc positions and confirm the pattern alternates dash/gap.
    // Dash range = [0, 20*mpp). Gap range = [20*mpp, 30*mpp).
    const DASH = 20 * mpp
    function isVisible(arc: number): boolean {
      const ph = phaseAt(arc)
      return ph < DASH
    }
    // Sample across one cycle
    const samples: boolean[] = []
    for (let t = 0; t < 30; t++) {
      samples.push(isVisible(t * mpp))
    }
    // The first 20 samples (0..19 px) should be visible, next 10 invisible.
    for (let i = 0; i < 20; i++) expect(samples[i]).toBe(true)
    for (let i = 20; i < 30; i++) expect(samples[i]).toBe(false)
  })

  // Regression guard for issue 3(c) in the polish plan: dense vertices
  // (multiple line vertices spaced closer than the stroke width) must
  // still produce a continuous dash phase. The shader computes
  // arc_pos = arc_start + t_along per fragment, where arc_start is
  // precomputed cumulatively in the tiler. As long as adjacent segments'
  // arc_start values are monotonically increasing by the segment length,
  // dash phase is continuous regardless of vertex density.
  it('dense vertices: arc_start advances monotonically across segments', async () => {
    // Bypass the tiler and call buildLineSegments directly with a synth
    // DSFUN stride-6 chain of 10 vertices spaced ~1 m apart. The arc
    // field (slot 5) carries the cumulative distance the tiler would
    // compute.
    const { buildLineSegments, LINE_SEGMENT_STRIDE_F32 } = await import('../engine/render/line-renderer')
    const arcs = [0, 1, 2.1, 3.05, 4.2, 5.0, 6.3, 7.1, 8.4, 9.0]
    const verts = new Float32Array(arcs.length * 6)
    for (let i = 0; i < arcs.length; i++) {
      // DSFUN layout: [mx_h, my_h, mx_l, my_l, feat_id, arc_start]
      // Use small tile-local Mercator meters for the position.
      verts[i * 6 + 0] = i * 1.0 // 1 m spacing
      verts[i * 6 + 1] = 0
      verts[i * 6 + 2] = 0
      verts[i * 6 + 3] = 0
      verts[i * 6 + 4] = 0
      verts[i * 6 + 5] = arcs[i]
    }
    const idx: number[] = []
    for (let i = 0; i < arcs.length - 1; i++) idx.push(i, i + 1)
    // stride 6 (line features), no tile-bounds so no boundary detection.
    const seg = buildLineSegments(verts, new Uint32Array(idx), 6)

    // Check arc_start at slot 12 of each segment (DSFUN layout):
    // [p0_h, p1_h, p0_l, p1_l, prev_t, next_t, arc_start, len, pad, pad].
    let prev = -Infinity
    for (let s = 0; s < arcs.length - 1; s++) {
      const arcStart = seg[s * LINE_SEGMENT_STRIDE_F32 + 12]
      expect(arcStart).toBeGreaterThanOrEqual(prev)
      // Must equal the source vertex's arc value (stride-6 path reads
      // directly from the vertex buffer — no recomputation).
      expect(arcStart).toBeCloseTo(arcs[s], 4)
      prev = arcStart
    }
  })
})
