import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import {
  addCoverageArrowShowLayer,
  coverageArrowOrigins,
  type CoverageArrowShowHost,
} from './coverage-arrow-show'
import { ARROW_ADVECT_COUNT } from './render/arrow-advect-state'
import type { ShowCommand } from './render/renderer-types'
import { S111_ARROW_BASE_PX, S111_OUTLINE_FRAC } from './render/s111-portrayal'

interface Captured {
  lons: number[]
  lats: number[]
  bearings: number[]
  sizes: number[]
  colors: [number, number, number, number][]
  strokeUnits: number | undefined
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
      ) => {
        calls.push({
          lons: [...lons],
          lats: [...lats],
          bearings: [...bearings],
          sizes: [...sizes],
          colors,
          strokeUnits,
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

  it('places a PROJECTED grid through its own CRS, not as if metres were degrees (#1366)', () => {
    // The arrow field derived positions as `origin + col·spacing` — the grid's own units,
    // which are degrees only for a geographic cell. Every real S-111 cell is geographic,
    // so it read as correct; #1366 INC-3 made PROJECTED cells placeable, and this field
    // would then have pushed UTM metres as lon/lat — 420 768° east, off the planet.
    const handle = coverageFromGrids({
      ...s111Input([1, 1, 1, 1, 1, 1], [0, 0, 0, 0, 0, 0]),
      crs: 32618, // WGS 84 / UTM 18N — the real NOAA S-102 Chesapeake cell's CRS
      origin: [420767.84475419234, 4183856.856912584],
      spacing: [16, 16],
    })
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle)
    const c = calls[0]!
    // Chesapeake Bay, in degrees — NOT the metre numbers the old derivation emitted.
    for (const lon of c.lons) expect(lon).toBeGreaterThan(-76.1)
    for (const lon of c.lons) expect(lon).toBeLessThan(-75.8)
    for (const lat of c.lats) expect(lat).toBeGreaterThan(37.7)
    for (const lat of c.lats) expect(lat).toBeLessThan(37.9)
    // The cells stay ordered west→east and the grid stays north-up.
    expect(c.lons[1]!).toBeLessThan(c.lons[2]!)
    expect(c.lats[0]!).toBeGreaterThan(c.lats[3]!)
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

// ── Advected mode: the arrows ARE the particles (#1409) ──────────────────────────────────
//
// Two contracts, both invisible in a frame:
//
//   1. ORDER. `coverageArrowOrigins` walks the same valid cells with the same stride as the
//      emit, so origin `i` belongs to instance `i`. Two loops staying in step is exactly the
//      kind of agreement that drifts, and the failure is silent: every arrow would advect from
//      SOMEONE ELSE'S origin, sampling the field in the wrong place and reporting a current
//      that does not exist there — while looking like a perfectly working animation.
//
//   2. COUNT. The position state is one TEXEL per arrow, so a grid with more valid cells than
//      texels must thin to fit. An over-count would index past the state texture.

describe('coverageArrowOrigins (#1409 — advected mode)', () => {
  it('is null for a scalar coverage, like the emit', () => {
    const handle = coverageFromGrids({
      product: 's102',
      origin: [0, 0],
      spacing: [1, 1],
      size: [2, 1],
      vertical: { datumCode: null, sign: 'down' },
      bands: [
        {
          name: 'depth',
          unit: 'metres',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from([1, 2]),
        },
      ],
    })
    expect(coverageArrowOrigins(handle)).toBeNull()
  })

  it('emits ONE origin per emitted instance, in the SAME order', () => {
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: true })
    const origins = coverageArrowOrigins(handle)!
    const emitted = calls[0]!

    expect(origins.u).toHaveLength(emitted.lons.length)
    expect(origins.v).toHaveLength(emitted.lons.length)

    // The grid is 3 wide × 2 tall, SW centre (10,50), 1° spacing. Row 0 is the NORTH row
    // (lat 51) and carries the skipped cells, so the drawable set is
    //   (row0,col0) lon 10 lat 51 · (row1,col0..2) lat 50.
    // u = col/(nLon-1), v = row/(nLat-1) — v runs SOUTH from the north row, matching the
    // velocity textures' own packing, so the shader needs no axis fix-up.
    expect([...origins.u]).toEqual([0, 0, 0.5, 1])
    expect([...origins.v]).toEqual([0, 1, 1, 1])

    // ...and that really is instance order: instance 0 is the north-row arrow.
    expect(emitted.lats[0]).toBeCloseTo(51, 9)
    expect(emitted.lats[1]).toBeCloseTo(50, 9)
    expect(emitted.lons[2]).toBeCloseTo(11, 9)
  })

  it('thins to the state texture’s capacity, and the origins thin WITH it', () => {
    // More valid cells than texels. Both sides must apply the identical stride, or the
    // instance/texel correspondence breaks and every arrow reads someone else's position.
    const n = ARROW_ADVECT_COUNT + 1000
    const speed = new Array(n).fill(1.5)
    const dir = new Array(n).fill(90)
    const handle = coverageFromGrids({
      product: 's111',
      origin: [0, 0],
      spacing: [0.01, 0.01],
      size: [n, 1],
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
    })
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: true })
    const origins = coverageArrowOrigins(handle)!
    expect(calls[0]!.lons.length).toBeLessThanOrEqual(ARROW_ADVECT_COUNT)
    expect(origins.u).toHaveLength(calls[0]!.lons.length)
  })

  it('the STATIC path is untouched — no cap at the advect count, no origins needed', () => {
    // Every existing `| arrow` consumer goes through here. The advected ceiling must not
    // silently start thinning the catalogue-conformant one-per-cell portrayal.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle) // no opts
    expect(calls[0]!.lons).toHaveLength(4)
  })
})
