import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import {
  addCoverageArrowShowLayer,
  coverageArrowOrigins,
  type CoverageArrowShowHost,
} from './coverage-arrow-show'
import { ARROW_DRIFT_UV } from './shaders/dsl/arrow-advect-step'
import { flowTrueSpans } from './render/flow-advect-params'
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
  advected?: unknown
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
        _region?: string,
        advected?: unknown,
      ) => {
        calls.push({
          lons: [...lons],
          lats: [...lats],
          bearings: [...bearings],
          sizes: [...sizes],
          colors,
          strokeUnits,
          advected,
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
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
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
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
    const origins = coverageArrowOrigins(handle)!
    expect(calls[0]!.lons.length).toBeLessThanOrEqual(ARROW_ADVECT_COUNT)
    expect(origins.u).toHaveLength(calls[0]!.lons.length)
  })

  it('emits the BASE length only — the band multiplier is the shader’s job now (#1419)', () => {
    // Double-scaling is the failure: the shader re-applies the band multiplier from the speed
    // under the arrow's CURRENT position, so a per-cell multiplier baked in here would scale
    // every arrow by the water it launched from AND the water it is in.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
    for (const size of calls[0]!.sizes) expect(size).toBe(S111_ARROW_BASE_PX)
    // The static path still bakes it — 0.3 kn → the 0.40 floor.
    const s = makeHost()
    addCoverageArrowShowLayer(s.host, s111Show, handle)
    expect(s.calls[0]!.sizes[0]).toBeCloseTo(S111_ARROW_BASE_PX * 0.4, 4)
  })

  it('emits the two BASIS ANCHORS, one leash length along each grid axis (#1419)', () => {
    // These are what the advected VS projects to turn a drift into a screen offset. Two things
    // must be right and neither is visible from the shader side:
    //   • the DISTANCE is exactly ARROW_DRIFT_UV of the grid span, because the VS divides by
    //     that constant — a mismatch scales every arrow's displacement by a silent factor;
    //   • grid-v runs SOUTHWARD (row 0 is the north row), so +v steps to LOWER latitude. Get
    //     that backwards and the field flows smoothly against its own arrowheads.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const o = coverageArrowOrigins(handle)!
    // 3 wide × 2 tall, 1° spacing → one uv unit is 2° in lon and 1° in lat.
    const uSpanDeg = ARROW_DRIFT_UV * 2
    const vSpanDeg = ARROW_DRIFT_UV * 1
    // instance 0 = the north-row arrow at (10, 51).
    expect(o.uStepLon[0]).toBeCloseTo(10 + uSpanDeg, 9)
    expect(o.uStepLat[0]).toBeCloseTo(51, 9)
    expect(o.vStepLon[0]).toBeCloseTo(10, 9)
    expect(o.vStepLat[0]).toBeCloseTo(51 - vSpanDeg, 9)
    // …and every instance carries its own pair, parallel to the origins.
    expect(o.uStepLon).toHaveLength(o.u.length)
    expect(o.vStepLat).toHaveLength(o.u.length)
  })

  it('reports the grid’s TRUE-distance aspect, cos(lat) folded in (#1419)', () => {
    // The VS points each glyph along the direction the ADVECTION moves it. Both sides derive
    // that anisotropy from `flowTrueSpans`, so a grid whose uv axes span different true
    // distances cannot end up with the arrowhead at one angle and the motion at another.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    // 3×2 cells, 1° spacing → 2° of lon and 1° of lat between the corner cell centres, at a
    // mid-latitude of 50.5°.
    const expected = flowTrueSpans([2, 1], 50.5)
    expect(coverageArrowOrigins(handle)!.uvAspect).toBeCloseTo(
      expected.trueLon / expected.trueLat,
      9,
    )
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
