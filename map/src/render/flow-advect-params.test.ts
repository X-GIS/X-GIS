import { describe, it, expect } from 'vitest'
import { flowAdvectParams, FLOW_MAX_DT_SECONDS } from './flow-advect-params'

// The advection step arithmetic (#1333). This is the piece that is silently wrong rather than
// visibly broken — a sheared flow still animates, it just points the current in the wrong
// direction — and this environment has no GPU to notice. So the properties are asserted
// directly, not inferred from a picture.

const base = {
  spanDeg: [2, 2] as const,
  midLatDeg: 0,
  dtSeconds: 1 / 60,
  ratePerSec: 0.1,
  decay: 0.95,
  inject: 0.08,
}

describe('flowAdvectParams (#1333)', () => {
  it('THE ISOTROPY GATE: equal east/north components travel equal TRUE distance', () => {
    // uv.x and uv.y span different ground distances, so dividing both by the same number would
    // shear the field: a northeasterly current would drift at the wrong ANGLE, which reads as
    // plausible motion pointing the wrong way.
    //
    // At the equator a 2°×2° cell IS square on the ground, so the steps must match.
    const eq = flowAdvectParams({ ...base, spanDeg: [2, 2], midLatDeg: 0 })
    expect(eq.stepX).toBeCloseTo(eq.stepY, 12)

    // At 60°N a degree of longitude is half a degree of latitude on the ground, so the same
    // 2°×2° cell is TWICE as tall as it is wide — and a unit east component must cover twice
    // the uv to travel the same true distance.
    const hi = flowAdvectParams({ ...base, spanDeg: [2, 2], midLatDeg: 60 })
    expect(hi.stepX / hi.stepY).toBeCloseTo(2, 6)
    expect(hi.stepY).toBeCloseTo(eq.stepY, 12) // latitude spans are unaffected
  })

  it('a cell WIDER in longitude takes a proportionally smaller x step', () => {
    // Same true speed across a wider cell = a smaller fraction of the grid per second.
    const narrow = flowAdvectParams({ ...base, spanDeg: [1, 2] })
    const wide = flowAdvectParams({ ...base, spanDeg: [4, 2] })
    expect(narrow.stepX / wide.stepX).toBeCloseTo(4, 9)
    expect(narrow.stepY).toBeCloseTo(wide.stepY, 12) // the y axis is untouched
  })

  it('scales linearly with dt and with the display rate', () => {
    const a = flowAdvectParams({ ...base, dtSeconds: 1 / 60 })
    const b = flowAdvectParams({ ...base, dtSeconds: 2 / 60 })
    expect(b.stepX / a.stepX).toBeCloseTo(2, 9)
    const fast = flowAdvectParams({ ...base, ratePerSec: base.ratePerSec * 3 })
    expect(fast.stepX / a.stepX).toBeCloseTo(3, 9)
  })

  it('THE HITCH GATE: a huge dt is clamped, not honoured', () => {
    // A restored tab or a GC pause hands over a dt of seconds. Advecting by it would teleport
    // the field in one step, and a RECURSIVE filter cannot recover from that — the history it
    // would rebuild from is the smeared frame. A stateless animation would just skip ahead.
    const normal = flowAdvectParams({ ...base, dtSeconds: FLOW_MAX_DT_SECONDS })
    const hitch = flowAdvectParams({ ...base, dtSeconds: 30 })
    expect(hitch.stepX).toBeCloseTo(normal.stepX, 12)
    // ...and the clamp is not so tight that ordinary frames are affected: 60 fps is well under.
    expect(1 / 60).toBeLessThan(FLOW_MAX_DT_SECONDS)
  })

  it('a negative or zero dt produces no motion rather than reversing the flow', () => {
    // A clock that steps backwards (system time adjustment) must not run the current in
    // reverse — that is worse than freezing, because it looks like real data.
    expect(flowAdvectParams({ ...base, dtSeconds: -1 }).stepX).toBe(0)
    expect(flowAdvectParams({ ...base, dtSeconds: 0 }).stepX).toBe(0)
  })

  it('a polar cell cannot divide by zero and fling the field across the grid', () => {
    const polar = flowAdvectParams({ ...base, midLatDeg: 90 })
    expect(Number.isFinite(polar.stepX)).toBe(true)
    expect(polar.stepX).toBeGreaterThan(0)
    // Symmetric in hemisphere — cos is even, so a southern cell behaves identically.
    expect(flowAdvectParams({ ...base, midLatDeg: -60 }).stepX).toBeCloseTo(
      flowAdvectParams({ ...base, midLatDeg: 60 }).stepX,
      12,
    )
  })

  it('a degenerate (zero-span) grid produces no motion rather than Infinity', () => {
    // One Infinity in the uniform would poison every texel it advects on the first frame, and
    // the history would carry it forever.
    const z = flowAdvectParams({ ...base, spanDeg: [0, 0] })
    expect(z.stepX).toBe(0)
    expect(z.stepY).toBe(0)
  })

  it('passes decay and inject through untouched — they are not distances', () => {
    const p = flowAdvectParams({ ...base, decay: 0.9, inject: 0.05 })
    expect(p.decay).toBe(0.9)
    expect(p.inject).toBe(0.05)
  })
})
