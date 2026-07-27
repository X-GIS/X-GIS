import { describe, expect, it, vi } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { CoverageTimePlayer } from '@xgis/map'
import { playS111Time, type S111PlaybackPort } from './s111-time-playback'

// A 2×2 S-111-shaped grid; `size` varies so a test can simulate a mosaic region swap (the two
// hours stop being the same grid, which interpolateVectorCoverage refuses by design).
function grid(size: [number, number] = [2, 2]): CoverageInput {
  const n = size[0] * size[1]
  return {
    product: 's111',
    origin: [10, 50],
    spacing: [1, 1],
    size,
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: NaN,
        values: Float32Array.from({ length: n }, (_v, i) => 1 + i),
      },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: NaN,
        values: Float32Array.from({ length: n }, (_v, i) => i * 10),
      },
    ],
  }
}

interface Fake {
  port: S111PlaybackPort
  landed: number[]
  peeks: number[]
  frames: number
  index(): number
}

/** A port whose decode (`peek`) and swap (`land`) each burn `costMs` of the fake clock — the
 *  shape a real 258k-cell CBOFS cell has, where one transition costs more than its dwell. */
function fakePort(costMs: number, count = 4, peekSize?: () => [number, number]): Fake {
  const state = { index: 0, frames: 0 }
  const landed: number[] = []
  const peeks: number[] = []
  const displayed = coverageFromGrids(grid())
  return {
    landed,
    peeks,
    get frames() {
      return state.frames
    },
    index: () => state.index,
    port: {
      axis: () => ({ index: state.index, count }),
      displayed: () => displayed,
      peek: async (hour) => {
        peeks.push(hour)
        vi.advanceTimersByTime(costMs) // a real peek decodes the whole grid — blocking work
        return coverageFromGrids(grid(peekSize?.() ?? [2, 2]))
      },
      land: async (hour) => {
        vi.advanceTimersByTime(costMs)
        landed.push(hour)
        state.index = hour
      },
      frame: () => void state.frames++,
    },
  }
}

describe('playS111Time (#1362 — the S-111 play button)', () => {
  it('ADVANCES the forecast hour even when one transition costs more than its dwell', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      // 300 ms per decode/swap × (peek + land) alone exceeds the 900 ms dwell once the blended
      // frames are added — exactly the case where the old fixed-tick loop cancelled itself
      // mid-transition and replayed hour 0→1 forever.
      const f = fakePort(300)
      playS111Time(player, f.port, { stepMs: 900, interpolateSteps: 6 })
      await vi.advanceTimersByTimeAsync(10_000)
      player.pause()
      expect(f.landed.slice(0, 5)).toEqual([1, 2, 3, 0, 1]) // advances and wraps — never stuck
    } finally {
      vi.useRealTimers()
    }
  })

  it('decodes the target hour ONCE per transition, not once per blended frame', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      const f = fakePort(0)
      playS111Time(player, f.port, { stepMs: 900, interpolateSteps: 6 })
      await vi.advanceTimersByTimeAsync(900) // one full hour transition
      player.pause()
      expect(f.landed).toEqual([1])
      expect(f.peeks).toEqual([1]) // 5 blended frames, ONE decode of hour 1
      expect(f.frames).toBe(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps playing when a mid-transition region swap makes the two hours un-blendable', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      // The peeked hour comes back on a DIFFERENT grid (the mosaic swapped regions), so every
      // blend throws a geometry mismatch. Playback must shrug it off, not stop.
      const f = fakePort(0, 4, () => [3, 3])
      playS111Time(player, f.port, { stepMs: 900, interpolateSteps: 6 })
      await vi.advanceTimersByTimeAsync(2700)
      player.pause()
      expect(f.frames).toBe(0) // no frame could be blended…
      expect(f.landed).toEqual([1, 2, 3]) // …yet the hours still land, one per dwell
    } finally {
      vi.useRealTimers()
    }
  })

  it('interpolateSteps ≤ 1 plays hour-to-hour with no blending and no peek at all', async () => {
    vi.useFakeTimers()
    try {
      const player = new CoverageTimePlayer()
      const f = fakePort(0)
      playS111Time(player, f.port, { stepMs: 900, interpolateSteps: 1 })
      await vi.advanceTimersByTimeAsync(1800)
      player.pause()
      expect(f.landed).toEqual([1, 2])
      expect(f.peeks).toEqual([])
      expect(f.frames).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
