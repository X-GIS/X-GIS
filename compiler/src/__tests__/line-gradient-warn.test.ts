// line-gradient surface (#2117) — the interpolate-over-["line-progress"] form now
// LOWERS to a ramp binding (`stroke-gradient-[interpolate(line_progress, …)]`); every
// other form warns PRECISELY (property + reason + alternative, ADR-0012 §1) instead of
// dropping silently or blaming a generic "not implemented".
//
// Fail-before anchor: before #2117 every case here produced the single
// "requires the line-progress accessor … not implemented (Plan §4 deferred)" warning
// and NO utility, so `emits the ramp binding` was red and every deferred-form case
// matched the wrong text.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

/** A GeoJSON-sourced line layer — no `source-layer`, which is what marks a vector
 *  source (validateLayerSourceLayer enforces the same rule). */
function buildStyle(extra: Record<string, unknown>, layerExtra: Record<string, unknown> = {}) {
  return {
    version: 8,
    sources: { g: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
    layers: [
      {
        id: 'route',
        type: 'line',
        source: 'g',
        ...layerExtra,
        paint: {
          'line-color': '#ff0000',
          'line-width': 3,
          ...extra,
        },
      },
    ],
  }
}

function convert(extra: Record<string, unknown>, layerExtra: Record<string, unknown> = {}) {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  const code = convertMapboxStyle(buildStyle(extra, layerExtra) as never, { coverage })
  return { code, warnings: coverage.warnings }
}

const LINEAR_2 = ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 1, '#0000ff']

describe('line-gradient — supported form', () => {
  it('omitted → no warning, no binding', () => {
    const { code, warnings } = convert({})
    expect(warnings.some((w) => w.includes('line-gradient'))).toBe(false)
    expect(code).not.toContain('stroke-gradient')
  })

  it('null → no warning (spec fallback)', () => {
    const { code, warnings } = convert({ 'line-gradient': null })
    expect(warnings.some((w) => w.includes('line-gradient'))).toBe(false)
    expect(code).not.toContain('stroke-gradient')
  })

  it('emits the ramp binding for interpolate/linear over ["line-progress"]', () => {
    const { code, warnings } = convert({ 'line-gradient': LINEAR_2 })
    expect(code).toContain(
      'stroke-gradient-[interpolate(line_progress, 0, #ff0000ff, 1, #0000ffff)]',
    )
    expect(warnings.some((w) => w.includes('line-gradient'))).toBe(false)
  })

  it('normalises named / short-hex / alpha stop colours to 8-digit hex', () => {
    const { code } = convert({
      'line-gradient': [
        'interpolate',
        ['linear'],
        ['line-progress'],
        0,
        '#0f0',
        0.5,
        'rgba(255, 0, 0, 0.5)',
        1,
        'blue',
      ],
    })
    expect(code).toContain(
      'stroke-gradient-[interpolate(line_progress, 0, #00ff00ff, 0.5, #ff000080, 1, #0000ffff)]',
    )
  })

  it('carries the ramp at exactly the 8-stop uniform budget', () => {
    const stops: unknown[] = ['interpolate', ['linear'], ['line-progress']]
    for (let i = 0; i < 8; i++) stops.push(i / 7, '#112233')
    const { code, warnings } = convert({ 'line-gradient': stops })
    expect(code).toContain('stroke-gradient-[interpolate(line_progress,')
    expect(warnings.some((w) => w.includes('line-gradient'))).toBe(false)
  })
})

describe('line-gradient — deferred forms warn precisely and drop', () => {
  /** Every deferred warning must name the PROPERTY, a REASON, and an ALTERNATIVE. */
  function expectPreciseDrop(warnings: string[], code: string, reason: RegExp) {
    const w = warnings.find((x) => x.includes('line-gradient'))
    expect(w, `expected a line-gradient warning in ${JSON.stringify(warnings)}`).toBeDefined()
    expect(w).toContain('Layer "route"')
    expect(w).toMatch(reason)
    // Alternative half: every message ends with a sentence telling the author what to do.
    expect(w!.split('. ').length).toBeGreaterThan(1)
    expect(code).not.toContain('stroke-gradient')
  }

  it('vector-tile source (declares source-layer)', () => {
    const { code, warnings } = convert({ 'line-gradient': LINEAR_2 }, { 'source-layer': 'roads' })
    expectPreciseDrop(warnings, code, /vector-tile source/)
    expect(warnings.find((w) => w.includes('line-gradient'))).toContain('GeoJSON')
  })

  it('step ramp', () => {
    const { code, warnings } = convert({
      'line-gradient': ['step', ['line-progress'], '#ff0000', 0.5, '#0000ff'],
    })
    expectPreciseDrop(warnings, code, /\["step", …\] is not supported yet/)
  })

  it('non-linear interpolation curve', () => {
    const { code, warnings } = convert({
      'line-gradient': [
        'interpolate',
        ['exponential', 2],
        ['line-progress'],
        0,
        '#ff0000',
        1,
        '#0000ff',
      ],
    })
    expectPreciseDrop(warnings, code, /\["exponential"\] interpolation curve is not wired/)
  })

  it('data-driven input instead of ["line-progress"]', () => {
    const { code, warnings } = convert({
      'line-gradient': ['interpolate', ['linear'], ['get', 'speed'], 0, '#ff0000', 1, '#0000ff'],
    })
    expectPreciseDrop(warnings, code, /not \["line-progress"\]/)
    expect(warnings.find((w) => w.includes('line-gradient'))).toContain('per-feature')
  })

  it('non-constant stop colour', () => {
    const { code, warnings } = convert({
      'line-gradient': [
        'interpolate',
        ['linear'],
        ['line-progress'],
        0,
        ['get', 'colour'],
        1,
        '#0000ff',
      ],
    })
    expectPreciseDrop(warnings, code, /is not a constant colour/)
  })

  it('more stops than the uniform carries', () => {
    const stops: unknown[] = ['interpolate', ['linear'], ['line-progress']]
    for (let i = 0; i < 9; i++) stops.push(i / 8, '#112233')
    const { code, warnings } = convert({ 'line-gradient': stops })
    expectPreciseDrop(warnings, code, /has 9 stops; the line layer uniform carries 8/)
  })

  it('descending stop positions', () => {
    const { code, warnings } = convert({
      'line-gradient': ['interpolate', ['linear'], ['line-progress'], 1, '#ff0000', 0, '#0000ff'],
    })
    expectPreciseDrop(warnings, code, /stop positions must ascend/)
  })

  it('out-of-range stop position', () => {
    const { code, warnings } = convert({
      'line-gradient': ['interpolate', ['linear'], ['line-progress'], 0, '#ff0000', 2, '#0000ff'],
    })
    expectPreciseDrop(warnings, code, /is not a number in \[0, 1\]/)
  })

  it('non-expression value', () => {
    const { code, warnings } = convert({ 'line-gradient': '#ff0000' })
    expectPreciseDrop(warnings, code, /value is not an expression/)
  })

  it('never duplicates into the generic ignored-paint blob', () => {
    const { warnings } = convert({ 'line-gradient': LINEAR_2 }, { 'source-layer': 'roads' })
    expect(
      warnings.find((w) => w.includes('ignored paint properties') && w.includes('line-gradient')),
    ).toBeUndefined()
  })
})
