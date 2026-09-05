// #2331 — non-constant text-offset / text-translate / icon-rotate and a legacy
// multi-stop symbol-placement used to be dropped with NO conversion note: the
// constant-form `if` at each site had no else arm, unlike the #1977 sibling
// `convertIconOffset`. AGENTS.md's contract is "unsupported properties emit a
// once-per-kind warning rather than throwing"; these pin that the four sites
// now honour it, and (control arms) that the constant forms still emit their
// utilities with no warning — a converter that warned about everything would
// satisfy the first half and fail the second.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function convert(
  layout: Record<string, unknown>,
  paint: Record<string, unknown> = {},
): { out: string; warnings: string[] } {
  const warnings: string[] = []
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { s: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } },
      layers: [
        {
          id: 'l1',
          type: 'symbol',
          source: 's',
          layout: { 'text-field': ['get', 'name'], ...layout },
          paint,
        },
      ],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { out, warnings }
}

const dropped = (warnings: string[], prop: string): string[] =>
  warnings.filter((w) => w.includes(`${prop} non-constant form`))

describe('#2331 — non-constant symbol properties warn instead of vanishing', () => {
  it('zoom-interpolated text-offset warns once, names the layer, and emits no offset utility', () => {
    const { out, warnings } = convert({
      'text-offset': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10,
        ['literal', [0, 0]],
        14,
        ['literal', [0, -1.5]],
      ],
    })
    expect(out).not.toContain('label-offset-')
    const hits = dropped(warnings, 'text-offset')
    expect(hits.length).toBe(1)
    expect(hits[0]).toContain('Symbol layer "l1"')
  })

  it('legacy-stops text-translate (paint) warns once and emits no translate utility', () => {
    const { out, warnings } = convert(
      {},
      {
        'text-translate': {
          stops: [
            [10, [0, 0]],
            [14, [0, -8]],
          ],
        },
      },
    )
    expect(out).not.toMatch(/label-translate-[xy]-/) // the #2170 anchor utility may still appear
    expect(dropped(warnings, 'text-translate').length).toBe(1)
  })

  it('data-driven icon-rotate warns once and emits no rotate utility', () => {
    const { out, warnings } = convert({ 'icon-image': 'arrow', 'icon-rotate': ['get', 'angle'] })
    expect(out).not.toContain('label-icon-rotate-')
    expect(dropped(warnings, 'icon-rotate').length).toBe(1)
  })

  it('legacy multi-stop symbol-placement warns once and stays point-placed', () => {
    // Only SINGLE-stop legacy functions fold to a constant (zoom-function-fold.ts);
    // a multi-stop one reaches the placement chain as an object.
    const { out, warnings } = convert({
      'symbol-placement': {
        stops: [
          [10, 'point'],
          [12, 'line'],
        ],
      },
    })
    expect(out).not.toContain('label-along-path')
    expect(out).not.toContain('label-line-center')
    expect(dropped(warnings, 'symbol-placement').length).toBe(1)
  })

  it('control: the constant forms still emit their utilities with NO such warning', () => {
    const { out, warnings } = convert(
      {
        'text-offset': [0, -1.5],
        'icon-image': 'arrow',
        'icon-rotate': 45,
        'symbol-placement': 'line',
      },
      { 'text-translate': [0, -8] },
    )
    expect(out).toContain('label-offset-y-')
    expect(out).toContain('label-translate-y-')
    expect(out).toContain('label-icon-rotate-')
    expect(out).toContain('label-along-path')
    expect(warnings.some((w) => w.includes('non-constant form'))).toBe(false)
  })

  it('control: absent properties warn nothing (the arms key on presence, not on the failed unwrap)', () => {
    expect(convert({}).warnings.some((w) => w.includes('non-constant form'))).toBe(false)
  })
})
