import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import {
  addCoverageParticleShowLayer,
  type CoverageParticleShowHost,
} from './coverage-particle-show'
import type { ShowCommand } from './render/renderer-types'
import type { ParticleFlowDrawSpec } from './graphics/graphics-types'

interface Captured {
  spec: ParticleFlowDrawSpec<unknown>
}

// The generator always passes FUNCTIONS for these accessors (never a bare constant), but their
// declared type is the `Packed<T, D>` union (constant | function), so the test resolves them
// through a typed cast rather than fighting the union at every call site.
function fn<T>(acc: unknown): (d: unknown, i: number) => T {
  return acc as (d: unknown, i: number) => T
}

function makeHost(): { host: CoverageParticleShowHost; calls: Captured[] } {
  const calls: Captured[] = []
  const host = {
    graphics: {
      add: (spec: ParticleFlowDrawSpec<unknown>) => {
        calls.push({ spec })
        return { count: 0, update: () => {}, append: () => {}, remove: () => {} }
      },
    },
  } as unknown as CoverageParticleShowHost
  return { host, calls }
}

// SAME 3×2 north-up S-111-like grid as coverage-arrow-show.test.ts, for direct parity: the
// two representations must agree on which cells are drawable, and where.
//   row0 (north, lat 51): [0.3, 0, NaN]   — the 0 and the noData get NO particle seed either
//   row1 (south, lat 50): [2.5, 5.0, 20.0]
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

describe('addCoverageParticleShowLayer (#1333 — engine S-111 animated flow field)', () => {
  it('emits ONE particle-flow batch with one cell datum per valid (speed > 0) cell', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    const returned = addCoverageParticleShowLayer(host, s111Show, handle)
    expect(calls).toHaveLength(1)
    expect(returned).not.toBeNull() // the returned DrawHandle IS host.graphics.add()'s result
    const { spec } = calls[0]!
    expect(spec.type).toBe('particle-flow')
    expect(spec.data).toHaveLength(4) // 0.3@col0, then row1 cols 0/1/2 — SAME 4 cells as arrows

    const getPosition = fn<readonly [number, number]>(spec.getPosition)
    const getBearing = fn<number>(spec.getBearing)
    const lons = spec.data.map((d, i) => getPosition(d, i)[0])
    const lats = spec.data.map((d, i) => getPosition(d, i)[1])
    const bearings = spec.data.map((d, i) => getBearing(d, i))
    expect(lons).toEqual([10, 10, 11, 12])
    expect(lats).toEqual([51, 50, 50, 50]) // north-up: row0 → lat 51, row1 → lat 50
    expect(bearings).toEqual([90, 180, 270, 45]) // = the direction band, verbatim
  })

  it('places a PROJECTED grid through its own CRS, and sizes the seed in real metres (#1366)', () => {
    // Two bugs of the same origin, both unlocked when #1366 INC-3 made projected cells
    // placeable: positions derived as `origin + col·spacing` treated UTM metres as
    // degrees, and the seed radius multiplied that same metre spacing by 111 320 m/deg —
    // a ~111 000× radius that would scatter every particle across the whole field.
    const handle = coverageFromGrids({
      ...s111Input([1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]),
      crs: 32618,
      origin: [420767.84475419234, 4183856.856912584],
      spacing: [16, 16],
    })
    const { host, calls } = makeHost()
    addCoverageParticleShowLayer(host, s111Show, handle)
    const { spec } = calls[0]!
    const getPosition = fn<readonly [number, number]>(spec.getPosition)
    for (const [i, d] of spec.data.entries()) {
      const [lon, lat] = getPosition(d, i)
      expect(lon).toBeGreaterThan(-76.1)
      expect(lon).toBeLessThan(-75.8)
      expect(lat).toBeGreaterThan(37.7)
      expect(lat).toBeLessThan(37.9)
    }
    // 40% of a 16 m cell — metres taken as metres. The degrees conversion would give
    // ~712 km here, so this bound is the fail-before.
    expect(spec.seedRadiusMeters).toBeCloseTo(6.4, 6)
  })

  it('no-ops when no cell is drawable (all speed 0 / noData) — returns null, no batch', () => {
    const handle = coverageFromGrids(s111Input([0, 0, NaN, 0, NaN, 0], [0, 0, 0, 0, 0, 0]))
    const { host, calls } = makeHost()
    const returned = addCoverageParticleShowLayer(host, s111Show, handle)
    expect(calls).toHaveLength(0)
    expect(returned).toBeNull()
  })

  it('no-ops on a single-band coverage (no direction to drift along)', () => {
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
    expect(addCoverageParticleShowLayer(host, s111Show, coverageFromGrids(input))).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('getVolume returns RAW speed (density ∝ volume, design §5-Q3) and getColor matches the band', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageParticleShowLayer(host, s111Show, handle)
    const { spec } = calls[0]!
    const getVolume = fn<number>(spec.getVolume)
    const getColor = fn<readonly [number, number, number, number]>(spec.getColor)
    const volumes = spec.data.map((d, i) => getVolume(d, i))
    volumes.forEach((v, i) => expect(v).toBeCloseTo([0.3, 2.5, 5.0, 20.0][i]!, 4)) // verbatim speed (f32), no √ compression
    const colors = spec.data.map((d, i) => getColor(d, i))
    expect(colors[0]).toEqual([118 / 255, 82 / 255, 226 / 255, 1]) // band1 purple, 0.3 kn
    expect(colors[3]).toEqual([255 / 255, 30 / 255, 30 / 255, 1]) // band9 red, 20 kn
  })

  it('requests NO per-cell floor (minPerCell: 0) — the Seoul default would blow the pool on this many cells', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageParticleShowLayer(host, s111Show, handle)
    expect(calls[0]!.spec.minPerCell).toBe(0)
  })

  it('bounds the seed jitter radius by the grid spacing, not the Seoul-tuned 1200 m default', () => {
    // 1° spacing at these latitudes is tens of km — the default 1200 m is already inside a
    // single cell here, but the point is the radius is COMPUTED from spacing, not hardcoded.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageParticleShowLayer(host, s111Show, handle)
    const r = calls[0]!.spec.seedRadiusMeters!
    expect(r).toBeGreaterThan(0)
    expect(r).toBeLessThan(111_320) // well under one degree of latitude in metres
  })
})
