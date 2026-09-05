// #1479 — `FrameDrawStats.drawnByZoom`, the observable the adaptive-quality ladder gate
// is judged on.
//
// The accumulator has been maintained since the inspector's "drawn by zoom" display was
// designed, but nothing ever READ it, so it was live-but-unreachable. Exposing it is what
// let `_adaptive-quality-ladder-gate` stop asserting on triangles — a quantity that RISES
// when the horizon coarsens on a source whose features do not generalise by zoom, because
// a coarser tile spans 4x the ground and carries 4x the uniformly-dense geometry. Zoom is
// the one signal that cannot invert: coarsening is defined as a lower drawn zoom.
//
// These pin the shape the gate depends on — ascending order, per-zoom counts, per-frame
// reset — so a change that silently emptied or unsorted it fails here rather than by
// making an e2e gate vacuously green.

import { describe, it, expect } from 'vitest'
import { FrameDrawStats } from './frame-draw-stats'

/** One drawn tile at zoom `z`. Index counts are arbitrary but non-zero, so the draw
 *  registers the same way a real fill does. */
function drawAt(s: FrameDrawStats, key: number, z: number): void {
  // #2309 — the dedup key is now the (tile key, sub-key) pair, both numeric.
  s.markDrawn(key, 0, 3, 0, 3, z)
}

describe('#1479 FrameDrawStats.drawnByZoom', () => {
  it('counts drawn tiles per zoom, ascending', () => {
    const s = new FrameDrawStats()
    s.beginFrame()
    drawAt(s, 1, 14)
    drawAt(s, 2, 13)
    drawAt(s, 3, 14)
    drawAt(s, 4, 12)
    drawAt(s, 5, 14)
    drawAt(s, 6, 13)
    expect(s.drawnByZoom()).toEqual([
      [12, 1],
      [13, 2],
      [14, 3],
    ])
  })

  it('is ascending even when tiles arrive finest-first', () => {
    // The draw walk has no zoom ordering guarantee, and the gate reads [0] and [last]
    // as coarsest/finest — an unsorted histogram would invert both.
    const s = new FrameDrawStats()
    s.beginFrame()
    // Distinct keys per draw: the histogram must count each, not dedup them.
    let kn = 0
    for (const z of [18, 4, 11, 4, 20]) drawAt(s, ++kn, z)
    expect(s.drawnByZoom().map(([z]) => z)).toEqual([4, 11, 18, 20])
  })

  it('resets per frame — a histogram never accumulates across frames', () => {
    const s = new FrameDrawStats()
    s.beginFrame()
    drawAt(s, 1, 13)
    expect(s.drawnByZoom()).toEqual([[13, 1]])
    s.beginFrame()
    expect(s.drawnByZoom()).toEqual([])
    drawAt(s, 1, 9)
    expect(s.drawnByZoom()).toEqual([[9, 1]])
  })

  it('omits a draw with no tile zoom rather than bucketing it as 0', () => {
    // `markDrawn`'s tz is optional (non-tile draws reach it). Bucketing those at 0 would
    // make `coarsest` read 0 forever and the gate's comparison meaningless.
    const s = new FrameDrawStats()
    s.beginFrame()
    s.markDrawn(99, 0, 3, 0, 3, undefined)
    drawAt(s, 100, 15)
    expect(s.drawnByZoom()).toEqual([[15, 1]])
  })

  it('rides getDrawStats(), which is what inspectPipeline() reads', () => {
    const s = new FrameDrawStats()
    s.beginFrame()
    drawAt(s, 1, 12)
    drawAt(s, 2, 14)
    const stats = s.getDrawStats()
    expect(stats.drawnByZoom).toEqual([
      [12, 1],
      [14, 1],
    ])
    expect(stats.tilesVisible).toBe(2)
  })

  it('the coarsest/finest the gate derives track a far-field-only coarsening', () => {
    // The exact shape measured on main when the gate was red: the far-field z13 pair
    // collapses to a single z12 while the four z14 foreground tiles are untouched.
    const control = new FrameDrawStats()
    control.beginFrame()
    for (let i = 0; i < 2; i++) drawAt(control, 1300 + i, 13)
    for (let i = 0; i < 4; i++) drawAt(control, 1400 + i, 14)

    const adaptive = new FrameDrawStats()
    adaptive.beginFrame()
    drawAt(adaptive, 1200, 12)
    for (let i = 0; i < 4; i++) drawAt(adaptive, 1400 + i, 14)

    const ends = (s: FrameDrawStats): [number, number] => {
      const h = s.drawnByZoom()
      return [h[0]![0], h[h.length - 1]![0]]
    }
    const [cCoarse, cFine] = ends(control)
    const [aCoarse, aFine] = ends(adaptive)

    expect(aCoarse).toBeLessThan(cCoarse) // the horizon coarsened
    expect(aFine).toBe(cFine) // the foreground did not
  })
})
