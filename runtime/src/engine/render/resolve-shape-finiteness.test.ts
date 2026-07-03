// iter-324 — PropertyShape resolver finiteness gate. The values
// resolveNumberShape / resolveColorShape return are packed DIRECTLY
// into the per-show uniform buffer (vector-tile-renderer uf[16..23]
// fill/stroke colour, plus numeric paint uniforms). The iter-319
// layout gate proves the BYTES line up; it does NOT prove the VALUES
// are finite. A NaN colour or out-of-[0,1] channel passes the layout
// gate and renders an invisible / garbage fill — the silent class.
//
// Contracts:
//   numeric resolve  → finite for any camera zoom / elapsed.
//   colour resolve   → every channel finite AND in [0,1] when the
//                      input stops are in [0,1] (interp is a convex
//                      combination, so it must not overshoot).
// Also pins the duplicate-stop / empty-stop / extreme-zoom guards that
// were real past bugs (see interpolateZoom comments: "(zoom-z0)/0 →
// Infinity → NaN colour, GPU sampled undefined behaviour").

import { describe, it, expect } from 'vitest'
import { interpolateZoom, interpolateZoomRgba, interpolateTime } from '@xgis/map'
import { resolveNumberShape, resolveColorShape } from '@xgis/map'
import type { PropertyShape } from '@xgis/compiler'

type Rgba = [number, number, number, number]

// Deterministic xorshift32 — same generator the other fuzz files use.
function makeRng(seed: number): () => number {
  let s = seed | 0
  return () => {
    s ^= s << 13
    s |= 0
    s ^= s >>> 17
    s ^= s << 5
    s |= 0
    return (s >>> 0) / 0x1_0000_0000
  }
}

// Camera zooms that actually occur + adversarial ones a malformed
// camera or a transition could feed.
const EXTREME_ZOOMS = [-1000, -5, 0, 0.5, 11.5, 22, 30, 1e6, NaN, Infinity, -Infinity]
const EXTREME_TIMES = [-1e6, -1, 0, 16, 1000, 1e9, NaN, Infinity]

describe('iter-324 interpolateZoom — finite on boundary/adversarial stops', () => {
  it('empty stops → finite fallback (1.0)', () => {
    for (const z of EXTREME_ZOOMS) {
      expect(Number.isFinite(interpolateZoom([], z))).toBe(true)
    }
  })

  it('single stop → that value, finite, any zoom', () => {
    const stops = [{ zoom: 10, value: 3 }]
    for (const z of EXTREME_ZOOMS) {
      expect(interpolateZoom(stops, z)).toBe(3)
    }
  })

  it('duplicate-zoom stops → no divide-by-zero (finite)', () => {
    // The documented past bug: span===0 → (zoom-z0)/0 → Infinity.
    const stops = [
      { zoom: 5, value: 1 },
      { zoom: 5, value: 9 },
      { zoom: 10, value: 2 },
    ]
    for (const z of [4, 5, 7, 10, 12, NaN, Infinity]) {
      expect(Number.isFinite(interpolateZoom(stops, z)), `z=${z}`).toBe(true)
    }
  })

  it('exponential base across the valid range → finite', () => {
    const stops = [
      { zoom: 0, value: 0 },
      { zoom: 22, value: 100 },
    ]
    for (const base of [0.0001, 0.5, 1, 1.0000001, 1.5, 2, 1000]) {
      for (const z of EXTREME_ZOOMS) {
        expect(Number.isFinite(interpolateZoom(stops, z, base)), `base=${base} z=${z}`).toBe(true)
      }
    }
  })

  it('fuzz: 500 random sorted stop sets → always finite', () => {
    const rng = makeRng(0x13245)
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rng() * 6)
      let z = rng() * 24
      const stops = Array.from({ length: n }, () => {
        z += rng() * 4 // monotonically increasing zoom
        return { zoom: z, value: (rng() * 2 - 1) * 100 }
      })
      const base = rng() < 0.5 ? 1 : 0.1 + rng() * 4
      const zoom = EXTREME_ZOOMS[Math.floor(rng() * EXTREME_ZOOMS.length)]!
      expect(Number.isFinite(interpolateZoom(stops, zoom, base)), `t=${t}`).toBe(true)
    }
  })
})

describe('iter-324 interpolateZoomRgba — finite + in-[0,1] (convex, no overshoot)', () => {
  function assertRgbaInRange(c: Rgba, ctx: string): void {
    for (let i = 0; i < 4; i++) {
      expect(Number.isFinite(c[i]!), `${ctx} ch${i} non-finite`).toBe(true)
      // Convex combination of [0,1] stops must stay in [0,1] (± float).
      expect(c[i]! >= -1e-6 && c[i]! <= 1 + 1e-6, `${ctx} ch${i}=${c[i]} out of [0,1]`).toBe(true)
    }
  }

  it('duplicate-zoom rgba stops → finite, in-range', () => {
    const stops: { zoom: number; value: Rgba }[] = [
      { zoom: 5, value: [0.1, 0.2, 0.3, 1] },
      { zoom: 5, value: [0.9, 0.8, 0.7, 1] },
      { zoom: 10, value: [0.5, 0.5, 0.5, 1] },
    ]
    for (const z of [4, 5, 7, 10, 12, NaN]) {
      assertRgbaInRange(interpolateZoomRgba(stops, z), `z=${z}`)
    }
  })

  it('fuzz: 500 random [0,1] colour-stop sets → finite + in-[0,1]', () => {
    const rng = makeRng(0xc0ffee)
    for (let t = 0; t < 500; t++) {
      const n = 1 + Math.floor(rng() * 5)
      let z = rng() * 24
      const stops = Array.from({ length: n }, () => {
        z += rng() * 5
        const c: Rgba = [rng(), rng(), rng(), rng()] // all in [0,1]
        return { zoom: z, value: c }
      })
      const base = rng() < 0.5 ? 1 : 0.1 + rng() * 4
      const zoom = EXTREME_ZOOMS[Math.floor(rng() * EXTREME_ZOOMS.length)]!
      assertRgbaInRange(interpolateZoomRgba(stops, zoom, base), `t=${t} zoom=${zoom}`)
    }
  })
})

describe('iter-324 interpolateTime — finite across loop/delay/easing', () => {
  const stops = [
    { timeMs: 0, value: 0 },
    { timeMs: 500, value: 10 },
    { timeMs: 1000, value: 0 },
  ]
  const easings = ['linear', 'ease-in', 'ease-out', 'ease-in-out'] as const

  it('every elapsed × loop × easing → finite', () => {
    for (const e of easings) {
      for (const loop of [true, false]) {
        for (const ms of EXTREME_TIMES) {
          for (const delay of [0, 250, -100]) {
            expect(
              Number.isFinite(interpolateTime(stops, ms, loop, e, delay)),
              `e=${e} loop=${loop} ms=${ms} delay=${delay}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('duplicate-time stops → finite', () => {
    const dup = [
      { timeMs: 0, value: 1 },
      { timeMs: 500, value: 5 },
      { timeMs: 500, value: 9 },
    ]
    for (const ms of EXTREME_TIMES) {
      expect(Number.isFinite(interpolateTime(dup, ms, false, 'linear', 0)), `ms=${ms}`).toBe(true)
    }
  })
})

describe('iter-324 resolveNumberShape / resolveColorShape — uniform-bound output finite', () => {
  it('resolveNumberShape: all variants finite across extreme zoom/time', () => {
    const shapes: PropertyShape<number>[] = [
      { kind: 'constant', value: 4 },
      {
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 0, value: 0 },
          { zoom: 22, value: 8 },
        ],
        base: 1,
      },
      {
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 0, value: 1 },
          { zoom: 22, value: 64 },
        ],
        base: 2,
      },
      {
        kind: 'time-interpolated',
        stops: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 1 },
        ],
        loop: true,
        easing: 'ease-in-out',
        delayMs: 0,
      },
      {
        kind: 'zoom-time',
        zoomStops: [
          { zoom: 0, value: 0 },
          { zoom: 22, value: 2 },
        ],
        zoomBase: 2,
        timeStops: [
          { timeMs: 0, value: 0 },
          { timeMs: 1000, value: 1 },
        ],
        loop: false,
        easing: 'linear',
        delayMs: 0,
      },
      { kind: 'data-driven' } as PropertyShape<number>,
    ]
    for (const shape of shapes) {
      for (const z of EXTREME_ZOOMS) {
        for (const ms of EXTREME_TIMES) {
          const r = resolveNumberShape(shape, z, ms)
          expect(Number.isFinite(r.value), `${shape.kind} z=${z} ms=${ms}`).toBe(true)
        }
      }
    }
  })

  it('resolveColorShape: interpolated channels finite + in-[0,1]', () => {
    const shapes: PropertyShape<Rgba>[] = [
      {
        kind: 'zoom-interpolated',
        stops: [
          { zoom: 0, value: [0, 0, 0, 1] },
          { zoom: 22, value: [1, 1, 1, 1] },
        ],
        base: 1,
      } as unknown as PropertyShape<Rgba>,
      {
        kind: 'time-interpolated',
        stops: [
          { timeMs: 0, value: [0.2, 0.4, 0.6, 1] },
          { timeMs: 1000, value: [0.8, 0.6, 0.4, 0.5] },
        ],
        loop: true,
        easing: 'ease-out',
        delayMs: 0,
      } as unknown as PropertyShape<Rgba>,
    ]
    for (const shape of shapes) {
      for (const z of EXTREME_ZOOMS) {
        for (const ms of EXTREME_TIMES) {
          const r = resolveColorShape(shape, z, ms)
          if (r === null) continue // constant / data-driven use static path
          for (let i = 0; i < 4; i++) {
            expect(Number.isFinite(r.value[i]!), `${shape.kind} ch${i} z=${z} ms=${ms}`).toBe(true)
            expect(
              r.value[i]! >= -1e-6 && r.value[i]! <= 1 + 1e-6,
              `${shape.kind} ch${i}=${r.value[i]} z=${z}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('resolveColorShape constant / data-driven → null (static path, no per-frame value)', () => {
    expect(
      resolveColorShape(
        { kind: 'constant', value: [1, 0, 0, 1] } as unknown as PropertyShape<Rgba>,
        10,
        0,
      ),
    ).toBeNull()
    expect(
      resolveColorShape({ kind: 'data-driven' } as unknown as PropertyShape<Rgba>, 10, 0),
    ).toBeNull()
  })
})
