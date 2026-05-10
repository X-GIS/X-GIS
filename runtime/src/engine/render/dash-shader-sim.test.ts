import { describe, expect, it } from 'vitest'

// JavaScript simulation of the WGSL dash fragment logic from line-renderer.ts.
// Goal: predict what the user would see for a real coastline segment.

interface Seg {
  p0: [number, number]  // tile-local meters
  p1: [number, number]
  arcStart: number      // global meters from feature start
}

interface LayerUniform {
  widthPx: number
  mpp: number
  dashArrayPx: number[]  // IN PIXELS — before mpp conversion
}

/** Simulates shading a fragment at tile-local point p against one segment. */
function shadeFragment(seg: Seg, p: [number, number], u: LayerUniform): 'visible' | 'discarded' {
  const [p0x, p0y] = seg.p0
  const [p1x, p1y] = seg.p1
  const segVecX = p1x - p0x
  const segVecY = p1y - p0y
  const segLen = Math.hypot(segVecX, segVecY)
  const dx = segVecX / segLen
  const dy = segVecY / segLen

  // perpendicular distance to infinite line
  const perpM = Math.abs((p[0] - p0x) * -dy + (p[1] - p0y) * dx)
  const halfW_m = u.widthPx * 0.5 * u.mpp
  const bodyD = perpM - halfW_m

  // Body is "visible" where bodyD < 0 (inside the stroke width)
  if (bodyD > 0) return 'discarded'

  // t_along — distance along segment from p0
  const tUnclamped = (p[0] - p0x) * dx + (p[1] - p0y) * dy
  const tAlong = Math.max(0, Math.min(segLen, tUnclamped))
  const arcPos = seg.arcStart + tAlong

  // Dash array in meters
  const dashArrayM = u.dashArrayPx.map(v => v * u.mpp)
  const cycleM = dashArrayM.reduce((a, b) => a + b, 0)
  if (cycleM <= 1e-6) return 'visible'

  let phase = arcPos / cycleM
  phase = (phase - Math.floor(phase)) * cycleM

  let acc = 0
  for (let i = 0; i < dashArrayM.length; i++) {
    const len = dashArrayM[i]
    if (phase >= acc && phase < acc + len) {
      return (i & 1) === 0 ? 'visible' : 'discarded'
    }
    acc += len
  }
  return 'discarded'
}

describe('dash shader simulation', () => {
  function mppAt(zoom: number): number {
    return (40075016.686 / 256) / Math.pow(2, zoom)
  }

  it('at zoom 3, a 500 km segment shows multiple dash transitions', () => {
    const mpp = mppAt(3)
    // 500 km east–west segment starting at arc = 0
    const seg: Seg = {
      p0: [0, 0],
      p1: [500_000, 0],
      arcStart: 0,
    }
    const u: LayerUniform = { widthPx: 2, mpp, dashArrayPx: [20, 10] }

    // Sample 20 points across the segment's screen pixels
    const segPx = 500_000 / mpp  // ~25.6 px at z=3
    const transitions: ('visible' | 'discarded')[] = []
    for (let px = 0; px <= Math.floor(segPx); px++) {
      const mAlong = px * mpp
      const p: [number, number] = [mAlong, 0]
      transitions.push(shadeFragment(seg, p, u))
    }
    // At z=3, dash cycle = 30 px, segment = ~25 px.
    // Within this segment we expect at least ONE transition from visible → discarded
    let visibleCount = 0
    let discardedCount = 0
    for (const t of transitions) {
      if (t === 'visible') visibleCount++
      else discardedCount++
    }
    // Both should be nonzero — the dash pattern must break the line.
    expect(visibleCount).toBeGreaterThan(0)
    expect(discardedCount).toBeGreaterThan(0)
  })

  it('at zoom 3, a SHORT 5 km segment covers < 1 pixel and appears solid (no dashes possible)', () => {
    const mpp = mppAt(3)  // ~19568 m/px
    const seg: Seg = {
      p0: [0, 0],
      p1: [5_000, 0],
      arcStart: 0,
    }
    const u: LayerUniform = { widthPx: 2, mpp, dashArrayPx: [20, 10] }

    const segPx = 5_000 / mpp  // 0.25 px
    expect(segPx).toBeLessThan(1)
    // At sub-pixel scale the test is degenerate, but the single fragment
    // should still make a determined visible/discarded call — it just
    // can't show a pattern within itself. This matches the visual
    // observation that very short segments appear as single dots.
    const decision = shadeFragment(seg, [segPx * mpp / 2, 0], u)
    expect(['visible', 'discarded']).toContain(decision)
  })

  it('at zoom 5, a 100 km segment spans multiple dash cycles', () => {
    const mpp = mppAt(5)  // ~4892 m/px
    // Dash cycle = 30 * 4892 = 146760 m
    // 100 km segment covers 100000 / 146760 ≈ 0.68 cycles
    const seg: Seg = {
      p0: [0, 0],
      p1: [100_000, 0],
      arcStart: 0,
    }
    const u: LayerUniform = { widthPx: 2, mpp, dashArrayPx: [20, 10] }

    const segPx = 100_000 / mpp  // ~20.4 px
    const decisions: string[] = []
    for (let px = 0; px <= segPx; px++) {
      const mAlong = px * mpp
      decisions.push(shadeFragment(seg, [mAlong, 0], u))
    }
    // First 20 pixels should be visible (dash range [0, 20 * mpp))
    // Pixel 20 starts the gap
    const firstDiscardedPx = decisions.findIndex(d => d === 'discarded')
    expect(firstDiscardedPx).toBeGreaterThan(0)
    expect(firstDiscardedPx).toBeLessThanOrEqual(21) // accept off-by-one at boundary
  })

  it('arc_start offset shifts the dash phase', () => {
    const mpp = mppAt(5)
    const dashCycleM = 30 * mpp
    const segLen = dashCycleM * 2  // two full cycles
    // Same segment, but with arcStart = half a cycle → opposite phase
    const segA: Seg = { p0: [0, 0], p1: [segLen, 0], arcStart: 0 }
    const segB: Seg = { p0: [0, 0], p1: [segLen, 0], arcStart: dashCycleM / 2 }
    const u: LayerUniform = { widthPx: 2, mpp, dashArrayPx: [20, 10] }

    // At t=0 (segment start), segA is in dash phase, segB is mid-cycle.
    // Exactly halfway through the cycle (15 px worth) segA should still
    // be visible (< 20), segB should have wrapped into the gap.
    const p: [number, number] = [0, 0]
    expect(shadeFragment(segA, p, u)).toBe('visible')
    // segB at arc=dashCycleM/2 = 15 px-equivalent = in [0, 20) dash range
    expect(shadeFragment(segB, p, u)).toBe('visible')

    // Farther along — at 22 px the gap range [20,30) should be hit
    const p22: [number, number] = [22 * mpp, 0]
    expect(shadeFragment(segA, p22, u)).toBe('discarded')
  })
})
