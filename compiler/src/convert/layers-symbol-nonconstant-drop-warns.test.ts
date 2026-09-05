// #2331: non-constant text-offset / text-translate / icon-rotate and a
// legacy multi-stop symbol-placement were silently dropped with NO
// warning — unlike the sibling `convertIconOffset` (#1977), which warns
// on any non-constant icon-offset shape. Mirrors that pattern: any of
// these four properties present but not reducible to the constant form
// must surface a warning naming the property, never vanish silently.
import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from './mapbox-to-xgis'

function convert(layer: Record<string, unknown>): { out: string; warnings: string[] } {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'lbl',
          type: 'symbol',
          source: 's',
          ...layer,
        },
      ],
    } as never,
    { coverage },
  )
  return { out, warnings: coverage.warnings }
}

describe('non-constant symbol properties warn instead of silently dropping (#2331)', () => {
  it('zoom-interpolated text-offset warns and is not silently dropped', () => {
    const { out, warnings } = convert({
      layout: {
        'text-field': '{name}',
        'text-offset': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['literal', [0, 1]],
          10,
          ['literal', [0, 2]],
        ],
      },
    })
    expect(out).not.toMatch(/label-offset-[xy]-/)
    expect(warnings.some((w) => w.includes('text-offset'))).toBe(true)
  })

  it('zoom-interpolated text-translate warns and is not silently dropped', () => {
    const { out, warnings } = convert({
      layout: { 'text-field': '{name}' },
      paint: {
        'text-translate': [
          'interpolate',
          ['linear'],
          ['zoom'],
          5,
          ['literal', [0, 1]],
          10,
          ['literal', [0, 2]],
        ],
      },
    })
    expect(out).not.toMatch(/label-translate-[xy]-/)
    expect(warnings.some((w) => w.includes('text-translate'))).toBe(true)
  })

  it('data-driven icon-rotate (["get", "angle"]) warns and is not silently dropped', () => {
    const { out, warnings } = convert({
      layout: { 'icon-image': 'arrow', 'icon-rotate': ['get', 'angle'] },
    })
    expect(out).not.toMatch(/label-icon-rotate-/)
    expect(warnings.some((w) => w.includes('icon-rotate'))).toBe(true)
  })

  it('legacy multi-stop symbol-placement warns and is not silently dropped', () => {
    const { out, warnings } = convert({
      layout: {
        'text-field': '{name}',
        'symbol-placement': {
          stops: [
            [10, 'point'],
            [12, 'line'],
          ],
        },
      },
    })
    expect(out).not.toMatch(/label-along-path|label-line-center/)
    expect(warnings.some((w) => w.includes('symbol-placement'))).toBe(true)
  })

  it('control: constant text-offset still emits with no warning', () => {
    const { out, warnings } = convert({
      layout: { 'text-field': '{name}', 'text-offset': [0, 1.5] },
    })
    expect(out).toContain('label-offset-y-1.5')
    expect(warnings.some((w) => w.includes('text-offset'))).toBe(false)
  })

  it('control: constant icon-rotate still emits with no warning', () => {
    const { out, warnings } = convert({
      layout: { 'icon-image': 'arrow', 'icon-rotate': 45 },
    })
    expect(out).toContain('label-icon-rotate-45')
    expect(warnings.some((w) => w.includes('icon-rotate'))).toBe(false)
  })

  it('control: constant icon-rotate 0 emits nothing and does not warn', () => {
    // 0 is the Mapbox default (no rotation), so no utility is emitted — but
    // it is still a constant, so it must NOT be reported as a dropped
    // non-constant value.
    const { out, warnings } = convert({
      layout: { 'icon-image': 'arrow', 'icon-rotate': 0 },
    })
    expect(out).not.toMatch(/label-icon-rotate-/)
    expect(warnings.some((w) => w.includes('icon-rotate'))).toBe(false)
  })

  it('control: constant symbol-placement "line" still emits with no warning', () => {
    const { out, warnings } = convert({
      layout: { 'text-field': '{name}', 'symbol-placement': 'line' },
    })
    expect(out).toContain('label-along-path')
    expect(warnings.some((w) => w.includes('symbol-placement'))).toBe(false)
  })
})
