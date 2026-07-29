import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import {
  addCoverageArrowShowLayer,
  coverageArrowGrid,
  type CoverageArrowShowHost,
} from './coverage-arrow-show'
import { flowTrueSpans } from './render/flow-advect-params'
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

// ── Advected mode: the glyphs ARE the particles (#1409, #1520) ───────────────────────────
//
// WHAT THIS SECTION USED TO TEST, and why none of it applies. The advected arm used to emit one
// instance per grid cell and a parallel array of origins, and the two contracts that mattered were
// ORDER (origin `i` belongs to instance `i` — two loops staying in step, whose failure is silent
// and looks like a working animation) and COUNT (one state texel per arrow, so an over-count
// indexed past the texture).
//
// #1520 step 2 removed both by removing what they were about. The instance set is a lattice on the
// SCREEN whose size is a per-frame decision, so the arm emits NO instances and no origins: there
// is no order to keep and no count to cap. What is left for this arm to get right is the grid BOX
// — four numbers that turn a lon/lat the shader recovered back into grid-uv — and the fallback for
// the coverages that box cannot describe.

describe('the advected arm emits a grid BOX, not instances (#1520)', () => {
  const anyFlow = () =>
    coverageFromGrids(s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]))

  it('emits ONE batch with NO per-instance arrays at all', () => {
    // The whole per-cell walk is skipped: it would allocate six arrays of up to 100 000 entries
    // for a buffer nothing binds. A regression that re-adds them is re-adding the z17 ceiling.
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, anyFlow(), '', { advected: { peakSpeed: 20 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.lons).toHaveLength(0)
    expect(calls[0]!.sizes).toHaveLength(0)
    expect(calls[0]!.advected).toBeTruthy()
  })

  it('still arms nothing when NO cell is drawable — an empty hour draws no field', () => {
    // The screen lattice would otherwise paint a field over a coverage that has no current at
    // all; the velocity texture's packed (0, 0) keeps glyphs off land, but "no data anywhere" is
    // a different statement and has to be made here.
    const handle = coverageFromGrids(s111Input([0, 0, NaN, 0, NaN, 0], [90, 0, 0, 180, 270, 45]))
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
    expect(calls).toHaveLength(0)
  })

  it('the box maps the grid CORNERS to uv (0,0) and (1,1) — v runs SOUTHWARD', () => {
    // The convention the velocity textures are packed in: `u = col/(nLon−1)` eastward and
    // `v = row/(nLat−1)` with row 0 the NORTHERNMOST. Get the v sign backwards and the field
    // flows smoothly against its own arrowheads, reading as a working animation of a current
    // that is not there.
    const g = coverageArrowGrid(anyFlow()) // 3×2 cells, 1° spacing, SW centre (10, 50)
    const uvOf = (lon: number, lat: number): [number, number] => [
      (lon - g.originLon) * g.invSpanLon,
      (lat - g.originLat) * g.invSpanLat,
    ]
    expect(uvOf(10, 51)[0], 'north-west node is u = 0').toBe(0)
    // `-0`, because the southward span makes the reciprocal negative — the same point.
    expect(uvOf(10, 51)[1], 'north-west node is v = 0').toBeCloseTo(0, 12)
    expect(uvOf(12, 51)[0], 'north-east node is u = 1').toBeCloseTo(1, 12)
    expect(uvOf(10, 50)[1], 'south-west node is v = 1').toBeCloseTo(1, 12)
    expect(g.invSpanLat, 'the southward sign rides the reciprocal').toBeLessThan(0)
  })

  it('a DEGENERATE axis pins uv to 0 rather than dividing by zero', () => {
    // A single-column or single-row coverage has one sample on that axis, so uv 0 is the correct
    // and only answer. An unguarded reciprocal would be Infinity, and every node would land
    // outside [0, 1] and draw nothing — a blank field from a coverage that has data.
    const handle = coverageFromGrids({
      product: 's111',
      origin: [10, 50],
      spacing: [1, 1],
      size: [1, 2],
      vertical: { datumCode: null, sign: 'up' },
      bands: [
        {
          name: 'surfaceCurrentSpeed',
          unit: 'knots',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from([1, 2]),
        },
        {
          name: 'surfaceCurrentDirection',
          unit: 'degrees',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from([0, 90]),
        },
      ],
    })
    expect(coverageArrowGrid(handle).invSpanLon).toBe(0)
  })

  it('reports the grid’s TRUE-distance aspect, cos(lat) folded in (#1419)', () => {
    // The shader points each glyph along the direction the walk actually moves it. Both sides
    // derive that anisotropy from `flowTrueSpans`, so a grid whose uv axes span different true
    // distances cannot end up with the arrowhead at one angle and the motion at another.
    const expected = flowTrueSpans([2, 1], 50.5)
    expect(coverageArrowGrid(anyFlow()).uvAspect).toBeCloseTo(
      expected.trueLon / expected.trueLat,
      9,
    )
  })

  it('a PROJECTED coverage falls back to the STATIC portrayal rather than drawing nothing', () => {
    // STATED SCOPE, not a gap. `arrow_grid_uv` is an affine map in the shader and a projected CRS
    // is not one; supporting it needs that CRS's forward ladder on the GPU (#1366 INC-3). The
    // fallback is asserted here so it cannot rot into a silent blank — which is exactly what an
    // unguarded advected arm would produce, since every recovered lon/lat would land outside the
    // unit box and every glyph would collapse.
    const handle = coverageFromGrids({
      ...s111Input([1, 1, 1, 1, 1, 1], [0, 45, 90, 135, 180, 225]),
      crs: 32618, // WGS 84 / UTM 18N — the real NOAA S-102 Chesapeake cell's CRS
      origin: [420767.84475419234, 4183856.856912584],
      spacing: [16, 16],
    })
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
    expect(calls).toHaveLength(1)
    expect(calls[0]!.advected, 'the advected arm declined it').toBeFalsy()
    expect(calls[0]!.lons.length, 'the static portrayal drew it instead').toBe(6)
  })

  it('the STATIC path is untouched — one symbol per drawable cell, sized by the band rule', () => {
    // Every existing `| arrow` consumer goes through here.
    const { host, calls } = makeHost()
    addCoverageArrowShowLayer(host, s111Show, anyFlow()) // no opts
    expect(calls[0]!.lons).toHaveLength(4)
    expect(calls[0]!.sizes[0]).toBeCloseTo(S111_ARROW_BASE_PX * 0.4, 4) // 0.3 kn → the floor
  })
})
