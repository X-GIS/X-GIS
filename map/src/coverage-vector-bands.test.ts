import { describe, it, expect } from 'vitest'
import { coverageFromGrids, type CoverageInput } from '@xgis/data/coverage'
import { resolveVectorBands, isVectorFieldCoverage } from './coverage-vector-bands'

// The vector-field predicate (#1333). The load-bearing gate is the S-102 one: it is a
// REGRESSION test for a proven defect, not a hypothetical — the old index fallback in
// coverage-arrow-show.ts resolved a bathymetry depth/uncertainty pair as speed/direction and
// emitted four arrows whose bearings were uncertainty values in metres read as degrees.

function grid(bands: CoverageInput['bands'], product: CoverageInput['product'] = 's111') {
  return coverageFromGrids({
    product,
    origin: [10, 50],
    spacing: [1, 1],
    size: [2, 2],
    vertical: { datumCode: null, sign: 'up' },
    bands,
  })
}

const f = (...v: number[]) => Float32Array.from(v)

describe('resolveVectorBands (#1333)', () => {
  it('resolves the conforming S-111 pair by NAME', () => {
    const h = grid([
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: f(1, 2, 3, 4),
      },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: -9999,
        values: f(0, 90, 180, 270),
      },
    ])
    const v = resolveVectorBands(h)
    expect(v).not.toBeNull()
    expect([...v!.speed]).toEqual([1, 2, 3, 4])
    expect([...v!.direction]).toEqual([0, 90, 180, 270])
    expect(isVectorFieldCoverage(h)).toBe(true)
  })

  it('THE S-102 GATE: a bathymetry depth/uncertainty pair is NOT a vector field', () => {
    // The exact witness that proved the old fallback wrong. Both bands are metres; neither
    // carries an angle; the pair must be rejected outright.
    const h = grid(
      [
        { name: 'depth', unit: 'metres', kind: 'f32', nodata: -9999, values: f(12, 30, 5, 100) },
        {
          name: 'uncertainty',
          unit: 'metres',
          kind: 'f32',
          nodata: -9999,
          values: f(0.5, 1.2, 0.3, 2),
        },
      ],
      's102',
    )
    expect(resolveVectorBands(h)).toBeNull()
    expect(isVectorFieldCoverage(h)).toBe(false)
  })

  it('still rescues an ODDLY-NAMED vector field, on the unit evidence', () => {
    // The fallback's legitimate motivation: a producer that did not use the conforming names.
    // Narrowed, not removed — the second band's unit must say "angle".
    const h = grid([
      { name: 'spd', unit: 'm s-1', kind: 'f32', nodata: -9999, values: f(1, 2, 3, 4) },
      { name: 'dir', unit: 'arc-degrees', kind: 'f32', nodata: -9999, values: f(0, 90, 180, 270) },
    ])
    const v = resolveVectorBands(h)
    expect(v).not.toBeNull()
    expect([...v!.direction]).toEqual([0, 90, 180, 270])
  })

  it('accepts the real-producer spellings of an angular unit, case/space-insensitively', () => {
    for (const unit of ['degrees', 'Degree', ' DEG ', 'arc-degree']) {
      const h = grid([
        { name: 'a', unit: 'knots', kind: 'f32', nodata: -9999, values: f(1, 1, 1, 1) },
        { name: 'b', unit, kind: 'f32', nodata: -9999, values: f(0, 0, 0, 0) },
      ])
      expect(resolveVectorBands(h), `unit "${unit}" should read as angular`).not.toBeNull()
    }
  })

  it('rejects a non-angular second band even when the FIRST band looks like a speed', () => {
    // A scalar coverage whose leading band happens to be in knots (e.g. a wind-speed-only
    // product) still has no direction, so there is nothing to orient.
    const h = grid([
      { name: 'windSpeed', unit: 'knots', kind: 'f32', nodata: -9999, values: f(5, 6, 7, 8) },
      { name: 'gust', unit: 'knots', kind: 'f32', nodata: -9999, values: f(9, 9, 9, 9) },
    ])
    expect(resolveVectorBands(h)).toBeNull()
  })

  it('rejects a single-band coverage (nothing can orient a magnitude alone)', () => {
    const h = grid([
      { name: 'depth', unit: 'metres', kind: 'f32', nodata: -9999, values: f(1, 2, 3, 4) },
    ])
    expect(resolveVectorBands(h)).toBeNull()
  })

  it('prefers the CONFORMING names over position, whatever order they sit in', () => {
    // A file that carries extra bands, or carries them out of order, must still resolve by
    // name — otherwise index 0/1 would silently pick the wrong pair.
    const h = grid([
      { name: 'uncertainty', unit: 'metres', kind: 'f32', nodata: -9999, values: f(9, 9, 9, 9) },
      {
        name: 'surfaceCurrentDirection',
        unit: 'arc-degrees',
        kind: 'f32',
        nodata: -9999,
        values: f(10, 20, 30, 40),
      },
      {
        name: 'surfaceCurrentSpeed',
        unit: 'knots',
        kind: 'f32',
        nodata: -9999,
        values: f(1, 2, 3, 4),
      },
    ])
    const v = resolveVectorBands(h)!
    expect([...v.speed]).toEqual([1, 2, 3, 4])
    expect([...v.direction]).toEqual([10, 20, 30, 40])
  })
})
