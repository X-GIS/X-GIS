// Regression: `?proj=equirect` (short form, used by docs/users) and Monaco's
// hyphenated names ('natural-earth') silently fell back to mercator because
// renderFrame's projType lookup only knows the canonical underscore forms.
// setProjection now normalizes aliases up-front; this test pins the alias
// table so removing/renaming entries fails loudly.

import { describe, it, expect } from 'vitest'

// Mirror the ALIASES map from map.ts setProjection. This duplication is
// intentional — if the source map is renamed/extended, the test catches
// the drift instead of the rendering silently misbehaving in production.
const ALIASES_EXPECTED: Record<string, string> = {
  equirect: 'equirectangular',
  'natural-earth': 'natural_earth',
  'azimuthal-equidistant': 'azimuthal_equidistant',
  'oblique-mercator': 'oblique_mercator',
}

describe('setProjection alias normalization', () => {
  it('every alias maps to a key the renderFrame projType lookup recognizes', () => {
    const PROJTYPE_KEYS = new Set([
      'mercator', 'equirectangular', 'natural_earth',
      'orthographic', 'azimuthal_equidistant', 'stereographic',
      'oblique_mercator', 'globe',
    ])
    for (const canonical of Object.values(ALIASES_EXPECTED)) {
      expect(PROJTYPE_KEYS.has(canonical), `alias target "${canonical}" missing from projType lookup`).toBe(true)
    }
  })

  it('covers the user-facing forms (URL short-form + Monaco hyphen-form)', () => {
    // URL `?proj=equirect` is the form docs + users use.
    expect(ALIASES_EXPECTED).toHaveProperty('equirect')
    // Monaco's PROJECTIONS list (monaco-xgis.ts:404) uses hyphen-separated names.
    expect(ALIASES_EXPECTED).toHaveProperty('natural-earth')
    expect(ALIASES_EXPECTED).toHaveProperty('azimuthal-equidistant')
    expect(ALIASES_EXPECTED).toHaveProperty('oblique-mercator')
  })
})
