// ═══════════════════════════════════════════════════════════════════
// XGISMap.setPaintProperty / getPaintProperty (plan P6 first cut)
// ═══════════════════════════════════════════════════════════════════
//
// Verifies the Mapbox GL JS-compatible thin adapter that delegates
// to XGISLayerStyle setters. The setters themselves are covered by
// their own suite (commit 7724b5c); these tests lock the property-
// name mapping and the return-value semantics.

import { describe, expect, it } from 'vitest'
import { XGISMap } from './map'
import { XGISLayer } from './layer'
import type { ShowCommand } from './render/renderer'

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

/** Minimal ShowCommand built so XGISLayerStyle setters have a real
 *  object to mutate. Default values mirror the compiler's emit so
 *  setter snapshots (for resetStyle) work correctly. */
function makeShow(name: string): ShowCommand {
  return {
    targetName: name,
    fill: '#ff0000',
    stroke: '#000000',
    strokeWidth: 1,
    opacity: 1,
    size: null,
    sizeUnit: null,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    paintShapes: {
      fill: { kind: 'constant', value: [1, 0, 0, 1] },
      stroke: { kind: 'constant', value: [0, 0, 0, 1] },
      opacity: { kind: 'constant', value: 1 },
      strokeWidth: { kind: 'constant', value: 1 },
      size: null,
    },
    shaderVariant: null,
    filterExpr: null,
    geometryExpr: null,
  } as unknown as ShowCommand
}

/** Inject a synthetic XGISLayer into the map's private xgisLayers
 *  Map. This bypasses the rebuildLayers GPU pipeline (which a unit
 *  test can't reach without a device); the setPaintProperty path
 *  itself is GPU-free. */
function injectLayer(map: XGISMap, name: string): { show: ShowCommand; layer: XGISLayer } {
  const show = makeShow(name)
  const invalidate = () => {} // unit tests don't need invalidation propagation
  const layer = new XGISLayer(name, show, invalidate)
  // Reach into the private Map — the test relies on the internal
  // representation but only for setup; the assertions are on the
  // public API.
  ;(map as unknown as { xgisLayers: Map<string, XGISLayer> }).xgisLayers.set(name, layer)
  return { show, layer }
}

describe('XGISMap.setPaintProperty — recognised properties', () => {
  it('fill-color: hex string → updates paintShapes.fill', () => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'borders')
    const ok = map.setPaintProperty('borders', 'fill-color', '#00ff00')
    expect(ok).toBe(true)
    expect(show.fill).toBe('#00ff00')
    expect(show.paintShapes.fill).toEqual({
      kind: 'constant',
      value: [0, 1, 0, 1],
    })
  })

  it('line-color: hex string → updates paintShapes.stroke', () => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'roads')
    const ok = map.setPaintProperty('roads', 'line-color', '#0000ff')
    expect(ok).toBe(true)
    expect(show.stroke).toBe('#0000ff')
    expect(show.paintShapes.stroke).toEqual({
      kind: 'constant',
      value: [0, 0, 1, 1],
    })
  })

  it('fill-color: null clears the fill shape', () => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'borders')
    const ok = map.setPaintProperty('borders', 'fill-color', null)
    expect(ok).toBe(true)
    expect(show.fill).toBeNull()
    expect(show.paintShapes.fill).toBeNull()
  })

  it.each([
    ['fill-opacity', 0.5],
    ['line-opacity', 0.25],
    ['opacity',      0.75],
  ])('%s: number → updates paintShapes.opacity', (prop, value) => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'L')
    const ok = map.setPaintProperty('L', prop, value)
    expect(ok).toBe(true)
    expect(show.opacity).toBe(value)
    expect(show.paintShapes.opacity).toEqual({ kind: 'constant', value })
  })

  it('line-width: number → updates paintShapes.strokeWidth', () => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'roads')
    const ok = map.setPaintProperty('roads', 'line-width', 4)
    expect(ok).toBe(true)
    expect(show.strokeWidth).toBe(4)
    expect(show.paintShapes.strokeWidth).toEqual({ kind: 'constant', value: 4 })
  })

  it.each([
    ['visible' as const, true],
    ['none'    as const, false],
  ])('visibility: %s → updates show.visible to %s', (vis, expected) => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'L')
    const ok = map.setPaintProperty('L', 'visibility', vis)
    expect(ok).toBe(true)
    expect(show.visible).toBe(expected)
  })
})

describe('XGISMap.setPaintProperty — invalid inputs return false', () => {
  it('unknown layer → false, no mutation', () => {
    const map = new XGISMap(mockCanvas())
    const ok = map.setPaintProperty('does-not-exist', 'fill-color', '#fff')
    expect(ok).toBe(false)
  })

  it('unknown property → false, no mutation', () => {
    const map = new XGISMap(mockCanvas())
    const { show } = injectLayer(map, 'L')
    const ok = map.setPaintProperty('L', 'not-a-real-property', '#fff')
    expect(ok).toBe(false)
    // Verify the layer's state is untouched.
    expect(show.fill).toBe('#ff0000')
  })

  it('fill-color with non-string value → false', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    expect(map.setPaintProperty('L', 'fill-color', 42)).toBe(false)
    expect(map.setPaintProperty('L', 'fill-color', true)).toBe(false)
    expect(map.setPaintProperty('L', 'fill-color', {})).toBe(false)
  })

  it('opacity with non-number value → false', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    expect(map.setPaintProperty('L', 'opacity', '0.5')).toBe(false)
    expect(map.setPaintProperty('L', 'opacity', null)).toBe(false)
  })

  it('visibility with unsupported string → false', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    expect(map.setPaintProperty('L', 'visibility', 'hidden')).toBe(false)
    expect(map.setPaintProperty('L', 'visibility', true)).toBe(false)
  })
})

describe('XGISMap.getPaintProperty — reads current value', () => {
  it('returns the compiled default before any mutation', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    expect(map.getPaintProperty('L', 'fill-color')).toBe('#ff0000')
    expect(map.getPaintProperty('L', 'opacity')).toBe(1)
    expect(map.getPaintProperty('L', 'line-width')).toBe(1)
    expect(map.getPaintProperty('L', 'visibility')).toBe('visible')
  })

  it('returns the mutated value after setPaintProperty', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    map.setPaintProperty('L', 'fill-color', '#00ff00')
    map.setPaintProperty('L', 'opacity', 0.3)
    expect(map.getPaintProperty('L', 'fill-color')).toBe('#00ff00')
    expect(map.getPaintProperty('L', 'opacity')).toBe(0.3)
  })

  it('returns undefined for unknown layer', () => {
    const map = new XGISMap(mockCanvas())
    expect(map.getPaintProperty('nope', 'fill-color')).toBeUndefined()
  })

  it('returns undefined for unknown property', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    expect(map.getPaintProperty('L', 'not-a-real-prop')).toBeUndefined()
  })
})

describe('XGISMap.setPaintProperty — round-trip with getPaintProperty', () => {
  it('every recognised property survives set → get → set', () => {
    const map = new XGISMap(mockCanvas())
    injectLayer(map, 'L')
    const cases: [string, unknown][] = [
      ['fill-color',   '#abcdef'],
      ['line-color',   '#123456'],
      ['fill-opacity', 0.42],
      ['line-width',   7],
      ['visibility',   'none'],
    ]
    for (const [prop, value] of cases) {
      const setOk = map.setPaintProperty('L', prop, value)
      expect(setOk).toBe(true)
      expect(map.getPaintProperty('L', prop)).toEqual(value)
    }
  })
})
