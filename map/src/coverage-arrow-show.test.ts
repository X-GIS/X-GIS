import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { addCoverageArrowShowLayer, type CoverageArrowShowHost } from './coverage-arrow-show'
import type { ShowCommand } from './render/renderer-types'
import { S111_ARROW_BASE_PX, S111_OUTLINE_FRAC } from './render/s111-portrayal'
import {
  S111_DRIFT_LIFETIME_SECONDS,
  S111_DRIFT_PX_PER_KNOT,
  S111_DRIFT_MAX_LENGTHS,
} from './coverage-arrow-show'
import type { CompiledArrowDrift } from './graphics/retained-arrow-packer'

interface Captured {
  lons: number[]
  lats: number[]
  bearings: number[]
  sizes: number[]
  colors: [number, number, number, number][]
  strokeUnits: number | undefined
  drift: CompiledArrowDrift | undefined
}

function makeHost(): { host: CoverageArrowShowHost; calls: Captured[] } {
  const calls: Captured[] = []
  const host = {
    graphics: {
      addCompiledArrowLayer: (
        lons: Float64Array,
        lats: Float64Array,
        bearings: Float32Array,
        sizes: Float32Array,
        colors: [number, number, number, number][],
        strokeUnits?: number,
        drift?: CompiledArrowDrift,
      ) => {
        calls.push({
          lons: [...lons],
          lats: [...lats],
          bearings: [...bearings],
          sizes: [...sizes],
          colors,
          strokeUnits,
          drift,
        })
      },
    },
  } as unknown as CoverageArrowShowHost
  return { host, calls }
}

// 3×2 north-up S-111-like grid; SW cell centre (10,50), 1° spacing. Speed in knots:
//   row0 (north, lat 51): [0.3, 0, NaN]   — the 0 and the noData get NO arrow
//   row1 (south, lat 50): [2.5, 5.0, 20.0]
// Direction (deg true): row0 [90,0,0] · row1 [180,270,45].
function s111Input(speed: number[], dir: number[]): CoverageInput {
  return {
    product: 's111',
    origin: [10, 50],
    spacing: [1, 1],
    size: [3, 2],
    vertical: { datumCode: null, sign: 'up' },
    bands: [
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(speed),
      },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: -9999,
        values: Float32Array.from(dir),
      },
    ],
  }
}

const s111Show = { ramp: 's111-speed' } as unknown as ShowCommand

describe('addCoverageArrowShowLayer (#1333 — engine S-111 arrow field)', () => {
  it('emits one arrow per valid (speed > 0) cell, dropping speed 0 + noData', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    expect(calls).toHaveLength(1)
    const c = calls[0]!
    expect(c.lons).toEqual([10, 10, 11, 12]) // 0.3@col0, then row1 cols 0/1/2
    expect(c.lats).toEqual([51, 50, 50, 50]) // north-up: row0 → lat 51, row1 → lat 50
    expect(c.bearings).toEqual([90, 180, 270, 45]) // = the direction band, verbatim
  })

  it('requests a speed-proportional drift, capped at S111_DRIFT_MAX_LENGTHS of the glyph', () => {
    // Speeds span the scale rule: 0.3 + 2.5 are fixed-scale bands, 5.0 and 20.0 are not.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    const d = calls[0]!.drift!
    expect(d.lifetimeSeconds).toBe(S111_DRIFT_LIFETIME_SECONDS)
    const drift = [...(d.driftPx as Float32Array)]
    const sizes = calls[0]!.sizes
    const speeds = [0.3, 2.5, 5.0, 20.0] // the four emitted cells, in emission order

    // Every arrow drifts either its speed-proportional distance or the length cap.
    // (toBeCloseTo, not toEqual: the drift lands in a Float32Array, so 5.4 comes back as
    // the nearest f32 — an exact compare would fail on the storage, not on the rule.)
    const expected = speeds.map((sp, i) =>
      Math.min(sp * S111_DRIFT_PX_PER_KNOT, sizes[i]! * S111_DRIFT_MAX_LENGTHS),
    )
    expect(drift).toHaveLength(expected.length)
    for (let i = 0; i < expected.length; i++) expect(drift[i]!).toBeCloseTo(expected[i]!, 4)
    // The cap must actually BIND somewhere, or this test would pass on an uncapped
    // implementation and the fast bands would smear across the field.
    const capped = speeds.filter(
      (sp, i) => sp * S111_DRIFT_PX_PER_KNOT > sizes[i]! * S111_DRIFT_MAX_LENGTHS,
    )
    expect(capped.length).toBeGreaterThan(0)
    // ...and it must NOT bind everywhere, or drift would be pure size and carry no speed
    // information at all — the exact failure the per-band scale rule invites.
    expect(capped.length).toBeLessThan(speeds.length)

    // A slow cell drifts less than a fast one: the field reads as a current, not a uniform crawl.
    expect(drift[0]!).toBeLessThan(drift[3]!)
  })

  it('requests the official black outline (S111_OUTLINE_FRAC) — a proper shader-level SDF stroke, not a second batch', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    expect(calls).toHaveLength(1) // ONE batch — the outline is a GPU-shader stroke, not a 2nd draw
    expect(calls[0]!.strokeUnits).toBe(S111_OUTLINE_FRAC)
  })

  it('sizes by the per-band scale rule and colours by the s111-speed band', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    const c = calls[0]!
    // length = base × scale: 0.3→0.40, 2.5→0.50, 5.0→1.0, 20→2.60
    expect(c.sizes[0]).toBeCloseTo(S111_ARROW_BASE_PX * 0.4, 4)
    expect(c.sizes[1]).toBeCloseTo(S111_ARROW_BASE_PX * 0.5, 4)
    expect(c.sizes[2]).toBeCloseTo(S111_ARROW_BASE_PX * 1.0, 4)
    expect(c.sizes[3]).toBeCloseTo(S111_ARROW_BASE_PX * 2.6, 4)
    // colour (0..1) = band rgb / 255 — band1 purple … band9 red
    expect(c.colors[0]).toEqual([118 / 255, 82 / 255, 226 / 255, 1])
    expect(c.colors[3]).toEqual([255 / 255, 30 / 255, 30 / 255, 1])
  })

  it('no-ops when no cell is drawable (all speed 0 / noData)', () => {
    const handle = coverageFromGrids(s111Input([0, 0, NaN, 0, NaN, 0], [0, 0, 0, 0, 0, 0]))
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    expect(calls).toHaveLength(0)
  })

  it('no-ops on a single-band coverage (no direction to orient the arrow)', () => {
    const input: CoverageInput = {
      product: 's111',
      origin: [10, 50],
      spacing: [1, 1],
      size: [3, 2],
      vertical: { datumCode: null, sign: 'up' },
      bands: [
        {
          name: 'surfaceCurrentSpeed',
          unit: 'knots',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from([1, 1, 1, 1, 1, 1]),
        },
      ],
    }
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, coverageFromGrids(input))
    expect(calls).toHaveLength(0)
  })
})
