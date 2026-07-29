import { describe, expect, it } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import {
  addCoverageArrowShowLayer,
  coverageArrowOrigins,
  type CoverageArrowShowHost,
} from './coverage-arrow-show'
import { ARROW_DRIFT_UV } from './shaders/dsl/arrow-advect-step'
import { flowTrueSpans } from './render/flow-advect-params'
import { COVERAGE_ARROW_MAX } from './coverage-arrow-show'
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
    // u = x/(nLon-1), v = y/(nLat-1) — v runs SOUTH from the north row, matching the
    // velocity textures' own packing, so the shader needs no axis fix-up. `x`/`y` are the
    // LATTICE position in cell units, which is the cell's own index only at `sub = 1` (#1511).
    //
    // The ORDER is per cell, and each cell's own nodes are contiguous — so instance 0 is still
    // the north-row cell's first node, and the lon/lat arrays agree with it.
    expect(origins.u[0]).toBe(0)
    expect(origins.v[0]).toBe(0)
    expect(emitted.lats[0]).toBeCloseTo(51, 9)
    // The cell centres are still emitted, and still in cell order: filter the lattice down to
    // its integer nodes and the pre-subdivision origin set comes back exactly.
    const centres = [...origins.u]
      .map((u, i) => [u * 2, origins.v[i]! * 1] as const)
      .filter(([x, y]) => Number.isInteger(x) && Number.isInteger(y))
    expect(centres).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ])
  })

  it('seeds SUB-CELL nodes, and every one of them belongs to a DRAWABLE cell (#1511)', () => {
    // THE risk the design had to dissolve: `s111HasArrow` is per cell, so a lattice that let a
    // node stray past half a cell would put arrows over land — a visibly wrong chart. Here the
    // offsets are half-open on [-0.5, 0.5), so each node is within half a cell of exactly one
    // centre, and the walker only ever visits nodes of a cell it already accepted.
    //
    // Non-vacuous on THIS grid: row 0 carries a speed-0 cell at col 1 and a noData at col 2, so
    // a lattice that reached a whole cell east of (row0, col0) — which the obvious `col + j/S`
    // form does — lands on them and this goes red.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const o = coverageArrowOrigins(handle)!
    const drawable = new Set(['0,0', '0,1', '1,1', '2,1']) // col,row
    expect(o.u.length).toBeGreaterThan(drawable.size) // it really did subdivide

    for (let i = 0; i < o.u.length; i++) {
      const x = o.u[i]! * 2 // uv → cell units: u = x/(nLon-1), nLon = 3
      const y = o.v[i]! * 1 //                  v = y/(nLat-1), nLat = 2
      const owner = `${Math.round(x)},${Math.round(y)}`
      expect(drawable, `node (${x}, ${y}) is owned by cell ${owner}`).toContain(owner)
      // …and "owned" is the strong statement: strictly within the owner's own footprint.
      expect(Math.abs(x - Math.round(x))).toBeLessThanOrEqual(0.5)
      expect(Math.abs(y - Math.round(y))).toBeLessThanOrEqual(0.5)
    }
  })

  it('the LEVEL-0 RUNG of the lattice IS the catalogue cell set, in order (#1511)', () => {
    // THE CONTRACT THAT REPLACES FRAME-0 PIXEL PARITY. `_s111-advected-arrows-gate` used to
    // assert "frame 0 of the advected field IS the static catalogue placement" against the
    // rendered pixels; at the zoom where the drawn set actually is the cell set, the leash is
    // 1.55× the cell spacing, so the arrows out-run the read and that comparison can no longer
    // be made. It is made HERE instead, where it is exact and needs no GPU.
    //
    // The VS keeps nodes whose lattice index is divisible by `keepEvery`, and `keepEvery = sub`
    // is one rung of that ladder. This asserts what that rung selects: the drawable cells, all of
    // them, in emit order and nothing else. If the lattice ever stopped containing the cell
    // centres — a cell-centred subdivision would, for instance — the catalogue placement would
    // simply not be on the ladder any more, and no render gate would say so.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const o = coverageArrowOrigins(handle)!
    const sub = o.stepsU / 2 // stepsU = (nLon - 1) · sub, nLon = 3
    expect(sub).toBeGreaterThan(1) // the fixture really is subdivided, so this is not trivial

    // The shader's own recovery: index = round(uv · steps), kept when index % sub === 0.
    const rung: Array<[number, number]> = []
    for (let i = 0; i < o.u.length; i++) {
      const iu = Math.round(o.u[i]! * o.stepsU)
      const iv = Math.round(o.v[i]! * o.stepsV)
      if (iu % sub === 0 && iv % sub === 0) rung.push([iu / sub, iv / sub])
    }
    // …which is exactly the drawable cells (col, row), in the order the static path emits them.
    expect(rung).toEqual([
      [0, 0],
      [0, 1],
      [1, 1],
      [2, 1],
    ])

    // And the static portrayal emits those same four positions — the two are one set, not two
    // that happen to agree in this test's head.
    const s = makeHost()
    addCoverageArrowShowLayer(s.host, s111Show, handle)
    expect(s.calls[0]!.lons).toHaveLength(rung.length)
  })

  it('reports the lattice STEPS per uv unit, which is what the VS measures spacing with', () => {
    // `(n - 1) · sub`, not the cell count: it is the reciprocal of the lattice's own uv step, so
    // both of the VS's uses — the on-screen spacing of adjacent arrows and the node's own index
    // — are exact. A cell count is off by n/(n-1), which is a whole node of skew once the
    // lattice is finer than a cell.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const o = coverageArrowOrigins(handle)!
    const step = o.u.length > 1 ? Math.min(...[...o.u].filter((u) => u > 0)) : 0
    expect(o.stepsU).toBeCloseTo(1 / step, 6)
    expect(o.stepsU % 2).toBe(0) // (3-1) · a power of two
    expect(o.stepsV).toBe(o.stepsU / 2) // (2-1) against (3-1), same sub
  })

  it('does NOT subdivide over the ceiling — filling and thinning spend one budget', () => {
    // The two halves are mutually exclusive by construction rather than by a rule someone has to
    // keep: a grid that needs striding cannot afford a second arrow anywhere, so the level is 0
    // and `stepsU` is the bare cell span.
    const n = 40_000
    const handle = coverageFromGrids({
      product: 's111',
      origin: [0, 0],
      spacing: [0.001, 0.001],
      size: [n, 1],
      vertical: { datumCode: null, sign: 'up' },
      bands: [
        {
          name: 'surfaceCurrentSpeed',
          unit: 'knots',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from(new Array(n).fill(1.5)),
        },
        {
          name: 'surfaceCurrentDirection',
          unit: 'arc-degrees',
          kind: 'f32',
          nodata: -9999,
          values: Float32Array.from(new Array(n).fill(90)),
        },
      ],
    })
    const o = coverageArrowOrigins(handle)!
    // 40 000 · 4 = 160 000 is over COVERAGE_ARROW_MAX, so not even one level fits.
    expect(o.u).toHaveLength(n)
    expect(o.stepsU).toBe(n - 1)
  })

  it('the STATIC portrayal never subdivides — one symbol per cell is the catalogue rule', () => {
    // `main.xsl` places one symbol per cell. That is not an implementation choice this may
    // optimise away, so the sub-cell lattice exists only where the portrayal already
    // re-symbolizes at an untabulated position: the advected field.
    const handle = coverageFromGrids(
      s111Input([0.3, 0, NaN, 2.5, 5.0, 20.0], [90, 0, 0, 180, 270, 45]),
    )
    const s = makeHost()
    addCoverageArrowShowLayer(s.host, s111Show, handle)
    expect(s.calls[0]!.lons).toHaveLength(4) // the four drawable cells, and nothing between them
    const a = makeHost()
    addCoverageArrowShowLayer(a.host, s111Show, handle, '', { advected: { peakSpeed: 20 } })
    expect(a.calls[0]!.lons.length).toBeGreaterThan(4)
  })

  it('thins to the ONE ceiling both portrayals share, and the origins thin WITH it', () => {
    // More valid cells than texels. Both sides must apply the identical stride, or the
    // instance/texel correspondence breaks and every arrow reads someone else's position.
    const n = COVERAGE_ARROW_MAX + 1000
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
    expect(calls[0]!.lons.length).toBeLessThanOrEqual(COVERAGE_ARROW_MAX)
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
