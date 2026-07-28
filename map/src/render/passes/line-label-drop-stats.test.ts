// Line-label drop attribution (see line-label-drop-stats.ts).
//
// The counters exist because "MapLibre labels this road and X-GIS does not"
// cannot be answered from screenshots — a missing label looks identical whether
// the walk found no anchor, the edge inset rejected it, the dedupe suppressed it,
// or collision dropped it downstream. Three attempts in one session to localise
// such a drop by re-rendering and comparing crops each ended up probing a code
// path that was not the one in play.
//
// So the property that matters is that the buckets ACCOUNT for every attempt: a
// drop that falls through every bucket would restore exactly the silence the
// counters exist to remove. That, plus the walk-level predicate, is what is
// pinned here.

import { describe, expect, it } from 'vitest'
import {
  LineLabelDropStats,
  countedCull,
  countedEmit,
  latticeMissesRun,
} from './line-label-drop-stats'
import { placeLabelsAlongLine, lineLabelFirstStopPx } from './place-labels-along-line'

describe('LineLabelDropStats', () => {
  it('starts at zero and counts each bucket independently', () => {
    const s = new LineLabelDropStats()
    expect(LineLabelDropStats.attempts(s.snapshot())).toBe(0)
    s.bump('edgeInset')
    s.bump('edgeInset')
    s.bump('emitted')
    const c = s.snapshot()
    expect(c.edgeInset).toBe(2)
    expect(c.emitted).toBe(1)
    expect(c.noLatticeStop).toBe(0)
  })

  it('reset clears every bucket', () => {
    const s = new LineLabelDropStats()
    s.bump('runTooShort')
    s.bump('emitted')
    s.reset()
    const c = s.snapshot()
    expect(Object.values(c).every((v) => v === 0)).toBe(true)
  })

  it('snapshot is a COPY — a held snapshot does not follow later bumps', () => {
    // The counters are a per-frame quantity; a live view would keep changing under
    // a caller that captured it, so "nothing was dropped" could be read off a frame
    // that is no longer the one being asked about.
    //
    // The bump must come with NO intervening reset. `reset()` REPLACES the counts
    // object rather than zeroing it in place, so a held reference survives a reset
    // whether or not snapshot() copies — a reset-based test passes against a
    // deliberately live snapshot and proves nothing (found by fail-before probe).
    const s = new LineLabelDropStats()
    s.bump('emitted')
    const held = s.snapshot()
    s.bump('emitted')
    s.bump('edgeInset')
    expect(held.emitted).toBe(1)
    expect(held.edgeInset).toBe(0)
  })

  it('attempts() excludes runTooShort — a run that never reached the walk', () => {
    const s = new LineLabelDropStats()
    s.bump('runTooShort')
    expect(LineLabelDropStats.attempts(s.snapshot())).toBe(0)
    s.bump('emitted')
    expect(LineLabelDropStats.attempts(s.snapshot())).toBe(1)
  })
})

describe('latticeMissesRun', () => {
  const SPACING = 200

  it('is false when the lattice lands on the run', () => {
    expect(latticeMissesRun(40, SPACING, 1000)).toBe(false)
    expect(latticeMissesRun(40, SPACING, 40)).toBe(false) // exactly at the end still lands
  })

  it('is true only for a run that CLEARS the short-line branch and holds no stop', () => {
    // total 180: >= spacing/2 (100) so the midpoint branch does not fire, yet the
    // only stop sits at 190 — past the end.
    expect(latticeMissesRun(190, SPACING, 180)).toBe(true)
  })

  it('is false below the short-line threshold — that run gets a midpoint label', () => {
    // Attributing this as a lattice miss would over-report: the walk DOES place.
    expect(latticeMissesRun(190, SPACING, 90)).toBe(false)
  })

  it('is false for line-center (spacing 0), which always places once', () => {
    expect(latticeMissesRun(0, 0, 500)).toBe(false)
  })

  it('agrees with the walk it describes, across a sweep', () => {
    // The predicate and placeLabelsAlongLine must not drift: for every
    // (phase, total) pair, "predicate says missed" ⟺ "the walk emitted nothing".
    for (let phase = 0; phase < SPACING; phase += 17) {
      for (let total = 20; total <= 600; total += 13) {
        let emitted = 0
        placeLabelsAlongLine(
          new Float32Array([0, total]),
          new Float32Array([0, 0]),
          2,
          SPACING,
          () => emitted++,
          undefined,
          phase,
        )
        const first = lineLabelFirstStopPx(phase, SPACING)
        expect(latticeMissesRun(first, SPACING, total), `phase=${phase} total=${total}`).toBe(
          emitted === 0,
        )
      }
    }
  })
})

describe('attribution wrappers account for every walk outcome', () => {
  const SPACING = 200

  /** Run the walk through the counted wrappers and return the snapshot. */
  function walk(total: number, phase: number | undefined, keep: (x: number, y: number) => boolean) {
    const s = new LineLabelDropStats()
    if (latticeMissesRun(lineLabelFirstStopPx(phase, SPACING), SPACING, total))
      s.bump('noLatticeStop')
    placeLabelsAlongLine(
      new Float32Array([0, total]),
      new Float32Array([0, 0]),
      2,
      SPACING,
      countedEmit(s, () => {}),
      countedCull(s, keep),
      phase,
    )
    return s.snapshot()
  }
  const keepAll = (_x: number, _y: number) => true
  const keepNone = (_x: number, _y: number) => false

  it('counts every placed stop', () => {
    const c = walk(1000, 40, keepAll)
    expect(c.emitted).toBe(5) // 40, 240, 440, 640, 840
    expect(c.edgeInset).toBe(0)
  })

  it('counts every culled stop, and none as emitted', () => {
    const c = walk(1000, 40, keepNone)
    expect(c.edgeInset).toBe(5)
    expect(c.emitted).toBe(0)
  })

  it('EVERY stop the walk visits lands in exactly one bucket', () => {
    // The load-bearing property. An unaccounted drop would read as silence —
    // precisely the ambiguity these counters exist to remove.
    for (let phase = 0; phase < SPACING; phase += 23) {
      for (let total = 20; total <= 900; total += 29) {
        for (const keep of [keepAll, keepNone, (x: number, _y: number) => x > 300]) {
          let visited = 0
          placeLabelsAlongLine(
            new Float32Array([0, total]),
            new Float32Array([0, 0]),
            2,
            SPACING,
            () => {},
            (x, y) => {
              visited++
              return keep(x, y)
            },
            phase,
          )
          const c = walk(total, phase, keep)
          expect(c.emitted + c.edgeInset, `phase=${phase} total=${total}`).toBe(visited)
          // And a run with no visited stop is exactly the lattice-miss case.
          expect(c.noLatticeStop === 1, `phase=${phase} total=${total}`).toBe(visited === 0)
        }
      }
    }
  })
})
