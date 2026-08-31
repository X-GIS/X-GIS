// Pin warning surfacing for Mapbox v2+ / v3 top-level style fields
// not implemented in X-GIS: `lights` (v3 standard-style ambient +
// directional rig), `models` (v3 standard-style 3D glTF placements).
// Pre-fix these dropped silently.
//
// `sky` LEFT the ignored list in T5 Phase 1 (#2052): the MapLibre sky
// root's zenith ramp is host-applied via XGISMap.setAtmosphere({ sky })
// exactly as `light` is via setLight, so listing it as "ignored" would
// be false. What replaces it is a PARTIAL warning naming the
// sub-properties the phase does not carry — the ADR-0012 §1 "partial
// with a precise, warning-backed degradation note" endpoint. Both
// directions are pinned below, because a bare "does not say ignored"
// assertion would pass just as well if the converter had gone silent.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

describe('top-level v2+/v3 fields surface as gaps', () => {
  it('sky is NOT in the ignored list — it is host-applied (#2052 Phase 1)', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      sky: { 'sky-color': '#88c' },
    }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Top-level style fields ignored/)
  })

  it('a sky authoring ONLY carried properties warns nothing at all', () => {
    const code = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [],
      sky: { 'sky-color': '#88c', 'horizon-color': '#fff', 'sky-horizon-blend': 0.5 },
    } as never)
    expect(code).not.toMatch(/Top-level style fields ignored/)
    expect(code).not.toMatch(/partially applied/)
  })

  it('a sky authoring later-phase properties warns precisely, naming each', () => {
    const code = convertMapboxStyle({
      version: 8,
      sources: {},
      layers: [],
      sky: {
        'sky-color': '#88c',
        'fog-color': '#fff',
        'fog-ground-blend': 0.5,
        'atmosphere-blend': 0.8,
      },
    } as never)
    expect(code).toMatch(/"sky" is partially applied/)
    for (const k of ['fog-color', 'fog-ground-blend', 'atmosphere-blend']) {
      expect(code, `expected "${k}" named in the partial-sky warning`).toContain(k)
    }
    // The carried three must be described as carried, not as dropped.
    expect(code).toMatch(/sky-color \/ horizon-color \/ sky-horizon-blend are host-applied/)
  })

  it('lights warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      lights: [{ id: 'ambient', type: 'ambient', properties: { color: '#fff' } }],
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/lights/)
  })

  it('models warns', () => {
    const style = {
      version: 8,
      sources: {},
      layers: [],
      models: { 'tree-1': 'https://example.com/tree.glb' },
    }
    const code = convertMapboxStyle(style as never)
    expect(code).toMatch(/models/)
  })

  it('plain style does NOT warn (regression guard)', () => {
    const style = { version: 8, sources: {}, layers: [] }
    const code = convertMapboxStyle(style as never)
    expect(code).not.toMatch(/Top-level style fields ignored/)
  })
})
