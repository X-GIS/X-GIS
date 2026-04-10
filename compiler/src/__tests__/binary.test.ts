import { describe, expect, it } from 'vitest'
import { serializeXGB, deserializeXGB, type BinaryScene } from '../binary/format'

describe('XGB Binary Format', () => {
  it('round-trips a scene', () => {
    const scene: BinaryScene = {
      loads: [
        { name: 'world', url: '/data/countries.geojson' },
        { name: 'roads', url: 'https://tiles.example.com/{z}/{x}/{y}.pbf' },
      ],
      shows: [
        { targetName: 'world', fill: '#f2efe9', stroke: '#ccc', strokeWidth: 1 },
        { targetName: 'roads', fill: null, stroke: '#888', strokeWidth: 2.5 },
      ],
    }

    const buffer = serializeXGB(scene)
    const restored = deserializeXGB(buffer)

    expect(restored.loads).toHaveLength(2)
    expect(restored.loads[0].name).toBe('world')
    expect(restored.loads[0].url).toBe('/data/countries.geojson')
    expect(restored.loads[1].url).toBe('https://tiles.example.com/{z}/{x}/{y}.pbf')

    expect(restored.shows).toHaveLength(2)
    expect(restored.shows[0].fill).toBe('#f2efe9')
    expect(restored.shows[0].stroke).toBe('#ccc')
    expect(restored.shows[0].strokeWidth).toBe(1)
    expect(restored.shows[1].fill).toBeNull()
    expect(restored.shows[1].strokeWidth).toBeCloseTo(2.5)
  })

  it('produces smaller output than source', () => {
    const scene: BinaryScene = {
      loads: [{ name: 'world', url: '/data/countries.geojson' }],
      shows: [{ targetName: 'world', fill: '#3a6b4e', stroke: '#2a4a3a', strokeWidth: 1 }],
    }

    const buffer = serializeXGB(scene)

    // The equivalent source code is ~120 bytes
    // Binary should be smaller
    expect(buffer.byteLength).toBeLessThan(120)
  })

  it('round-trips v2 fields (projection, visible, opacity, zOrder)', () => {
    const scene: BinaryScene = {
      loads: [{ name: 'world', url: 'countries.geojson' }],
      shows: [{
        targetName: 'world', fill: '#ff0000', stroke: '#000', strokeWidth: 2,
        projection: 'natural_earth', visible: false, opacity: 0.75, zOrder: 10,
      }],
    }

    const buffer = serializeXGB(scene)
    const restored = deserializeXGB(buffer)

    expect(restored.shows[0].projection).toBe('natural_earth')
    expect(restored.shows[0].visible).toBe(false)
    expect(restored.shows[0].opacity).toBeCloseTo(0.75)
    expect(restored.shows[0].zOrder).toBe(10)
  })

  it('defaults v2 fields when not provided', () => {
    const scene: BinaryScene = {
      loads: [{ name: 'x', url: 'x.geojson' }],
      shows: [{ targetName: 'x', fill: '#fff', stroke: null, strokeWidth: 1 }],
    }

    const buffer = serializeXGB(scene)
    const restored = deserializeXGB(buffer)

    expect(restored.shows[0].projection).toBe('mercator')
    expect(restored.shows[0].visible).toBe(true)
    expect(restored.shows[0].opacity).toBeCloseTo(1.0)
    expect(restored.shows[0].zOrder).toBe(0)
  })

  it('rejects invalid magic', () => {
    const badBuffer = new ArrayBuffer(8)
    new DataView(badBuffer).setUint32(0, 0xDEADBEEF, true)

    expect(() => deserializeXGB(badBuffer)).toThrow('Invalid .xgb file')
  })
})
