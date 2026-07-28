// text-pitch-alignment: map runtime gap surface.
// Compiler still emits the alignment utility; the WARNING surfaces
// to the user that the runtime won't actually project labels onto
// the ground plane. Plan §3.1 deferred runtime work.

import { describe, expect, it } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

function buildStyle(pitchAlign: string) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id: 'labels',
        type: 'symbol',
        source: 'v',
        'source-layer': 'poi',
        layout: {
          'text-field': '{name}',
          'text-pitch-alignment': pitchAlign,
        },
      },
    ],
  }
}

describe('text-pitch-alignment runtime-gap warning', () => {
  it('map mode warns that runtime renders labels viewport-aligned regardless', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('map') as never, { coverage })
    const w = coverage.warnings.find((w) => w.includes('text-pitch-alignment "map"'))
    expect(w).toBeDefined()
    expect(w).toContain('ground-projection not yet implemented')
  })

  it('viewport mode does NOT warn (no runtime gap there)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('viewport') as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('text-pitch-alignment "map"'))).toBe(false)
  })

  it('auto mode does NOT warn (auto resolves to viewport in current runtime)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('auto') as never, { coverage })
    expect(coverage.warnings.some((w) => w.includes('text-pitch-alignment "map"'))).toBe(false)
  })

  it('invalid enum still warns with the existing enum-validation message', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(buildStyle('horizontal') as never, { coverage })
    const w = coverage.warnings.find((w) => w.includes('is not a valid enum'))
    expect(w).toBeDefined()
  })
})

// The gap is reached by the spec DEFAULT, not only by authoring "map":
// text-pitch-alignment `auto` matches text-rotation-alignment, whose own
// `auto` is `map` for line / line-center placement. Every road-name layer in
// every real basemap therefore lands on map — and used to convert with a
// silent notes block. These lock the resolved-value warning (#777 IV3).
function buildResolutionStyle(layout: Record<string, unknown>) {
  return {
    version: 8,
    sources: { v: { type: 'vector', url: 'x.pmtiles' } },
    layers: [
      {
        id: 'road_name',
        type: 'symbol',
        source: 'v',
        'source-layer': 'transportation_name',
        layout: { 'text-field': '{name}', ...layout },
      },
    ],
  }
}
const resolvedWarning = (layout: Record<string, unknown>): string | undefined => {
  const coverage = { sources: [], layers: [], warnings: [] as string[] }
  convertMapboxStyle(buildResolutionStyle(layout) as never, { coverage })
  return coverage.warnings.find((w) => w.includes('text-pitch-alignment resolves to "map"'))
}

describe('text-pitch-alignment default resolution — the auto → map path', () => {
  it('line placement with NOTHING authored warns (the real-basemap case)', () => {
    const w = resolvedWarning({ 'symbol-placement': 'line' })
    expect(w).toBeDefined()
    expect(w).toContain('for "line" placement')
    expect(w).toContain('upright billboards')
  })

  it('line-center placement with nothing authored warns', () => {
    expect(resolvedWarning({ 'symbol-placement': 'line-center' })).toBeDefined()
  })

  it('explicit text-rotation-alignment: map on a POINT layer warns (rotation drives it)', () => {
    expect(resolvedWarning({ 'text-rotation-alignment': 'map' })).toBeDefined()
  })

  it('point placement with nothing authored does NOT warn (resolves to viewport)', () => {
    expect(resolvedWarning({})).toBeUndefined()
  })

  it('explicit text-pitch-alignment: viewport wins over line placement — no warn', () => {
    expect(
      resolvedWarning({ 'symbol-placement': 'line', 'text-pitch-alignment': 'viewport' }),
    ).toBeUndefined()
  })

  it('explicit text-rotation-alignment: viewport on a line layer — no warn', () => {
    expect(
      resolvedWarning({ 'symbol-placement': 'line', 'text-rotation-alignment': 'viewport' }),
    ).toBeUndefined()
  })

  it('explicit "map" keeps the original message and does not double-warn', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      buildResolutionStyle({ 'symbol-placement': 'line', 'text-pitch-alignment': 'map' }) as never,
      { coverage },
    )
    expect(coverage.warnings.some((w) => w.includes('text-pitch-alignment "map" set but'))).toBe(
      true,
    )
    expect(coverage.warnings.some((w) => w.includes('resolves to "map"'))).toBe(false)
  })

  it('an icon-only line layer does NOT get a TEXT warning (its gap is icon-pitch-alignment)', () => {
    const coverage = { sources: [], layers: [], warnings: [] as string[] }
    convertMapboxStyle(
      {
        version: 8,
        sources: { v: { type: 'vector', url: 'x.pmtiles' } },
        layers: [
          {
            id: 'road_oneway',
            type: 'symbol',
            source: 'v',
            'source-layer': 'transportation',
            layout: { 'icon-image': 'oneway', 'symbol-placement': 'line' },
          },
        ],
      } as never,
      { coverage },
    )
    expect(coverage.warnings.some((w) => w.includes('text-pitch-alignment resolves to'))).toBe(
      false,
    )
  })

  it('the v8 strict ["literal", …] wrap resolves the same way', () => {
    expect(
      resolvedWarning({
        'symbol-placement': ['literal', 'line'],
        'text-pitch-alignment': ['literal', 'viewport'],
      }),
    ).toBeUndefined()
    expect(resolvedWarning({ 'symbol-placement': ['literal', 'line'] })).toBeDefined()
  })
})
