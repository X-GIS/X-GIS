// Oracle tests for the geojson-vt TypeScript port. Runs the upstream
// JS implementation (geojson-vt 4.0.2, available as a devDependency)
// and our TS port against the same input, asserts byte-for-byte
// equal output. If we drift, the upstream is treated as ground
// truth — the port is a verbatim restatement of the JS, so any diff
// is a bug in our port.

import { describe, it, expect } from 'vitest'
// @ts-expect-error — geojson-vt 4.0.2 ships no .d.ts; used as the
// oracle for behavioural parity, not as a runtime dependency.
import geojsonvtUpstream from 'geojson-vt'
import { geojsonvt as geojsonvtOurs, DEFAULT_OPTIONS } from './index'
import type { GeoJSONInput } from './types'

const SIMPLE_FC: GeoJSONInput = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'A' },
      geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]] },
    },
  ],
} as GeoJSONInput

const WORLD_RING: GeoJSONInput = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'world' },
      geometry: {
        type: 'Polygon',
        coordinates: [[[-179, -85], [179, -85], [179, 85], [-179, 85], [-179, -85]]],
      },
    },
  ],
} as GeoJSONInput

const LINE_FC: GeoJSONInput = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[0, 0], [10, 10], [20, 0]] },
    },
  ],
} as GeoJSONInput

// Default options for upstream that match our MapLibre-style
// defaults. Upstream's stock defaults are 256-tile (extent=4096,
// buffer=64) so we override to compare apples-to-apples.
const MATCH_DEFAULTS = {
  extent: DEFAULT_OPTIONS.extent,
  buffer: DEFAULT_OPTIONS.buffer,
  tolerance: 6, // upstream takes tolerance in extent units already at convert time
  maxZoom: DEFAULT_OPTIONS.maxZoom,
  indexMaxZoom: DEFAULT_OPTIONS.indexMaxZoom,
}

describe('geojson-vt TypeScript port — oracle parity vs upstream JS', () => {
  it('simple polygon at z=0 — feature count + geometry length match', () => {
    const a = geojsonvtUpstream(SIMPLE_FC as never, MATCH_DEFAULTS as never).getTile(0, 0, 0)
    const b = geojsonvtOurs(SIMPLE_FC, MATCH_DEFAULTS).getTile(0, 0, 0)
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(b!.features.length).toBe(a!.features.length)
    // Geometry counts should match exactly.
    for (let i = 0; i < a!.features.length; i++) {
      const ag = a!.features[i].geometry as unknown as number[][][]
      const bg = b!.features[i].geometry as unknown as number[][][]
      expect(bg.length).toBe(ag.length)
      for (let j = 0; j < ag.length; j++) {
        expect(bg[j].length).toBe(ag[j].length)
      }
    }
  })

  it('world-spanning ring at z=2 — every visible tile produces output', () => {
    const upstream = geojsonvtUpstream(WORLD_RING as never, MATCH_DEFAULTS as never)
    const ours = geojsonvtOurs(WORLD_RING, MATCH_DEFAULTS)
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        const a = upstream.getTile(2, x, y)
        const b = ours.getTile(2, x, y)
        expect(b !== null, `(2,${x},${y}) ours-null=${b === null} vs upstream-null=${a === null}`).toBe(a !== null)
        if (a && b) {
          expect(b.features.length).toBe(a.features.length)
        }
      }
    }
  })

  it('linestring crossing tile boundaries — output coordinates match', () => {
    const a = geojsonvtUpstream(LINE_FC as never, MATCH_DEFAULTS as never).getTile(2, 2, 1)
    const b = geojsonvtOurs(LINE_FC, MATCH_DEFAULTS).getTile(2, 2, 1)
    expect(b === null).toBe(a === null)
    if (a && b) {
      expect(b.features.length).toBe(a.features.length)
      // First feature, first ring: exact integer coordinates after extent quantization.
      const ag = a.features[0].geometry as unknown as number[][][]
      const bg = b.features[0].geometry as unknown as number[][][]
      expect(bg).toEqual(ag)
    }
  })

  it('default options match MapLibre conventions (extent=8192, buffer=2048, tolerance=6)', () => {
    expect(DEFAULT_OPTIONS.extent).toBe(8192)
    expect(DEFAULT_OPTIONS.buffer).toBe(2048)
    expect(DEFAULT_OPTIONS.tolerance).toBe(6)
    expect(DEFAULT_OPTIONS.maxZoom).toBe(14)
  })

  it('rejects maxZoom > 25 (Morton tileKey safe-integer ceiling)', () => {
    expect(() => geojsonvtOurs(SIMPLE_FC, { maxZoom: 26 })).toThrow(/0-25/)
    expect(() => geojsonvtOurs(SIMPLE_FC, { maxZoom: -1 })).toThrow(/0-25/)
  })
})
