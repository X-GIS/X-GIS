// Pin setProjection rejecting unknown projection names. Pre-fix an
// unknown name (`setProjection("globey")` typo) silently fell to
// mercator at renderFrame's projType lookup (`?? 0`); the previous
// projection state was lost AND the visual behaviour matched
// mercator with no warning — a debugging footgun.
//
// Note: we can't easily exercise XGISMap.setProjection without a
// GPU context. Instead, pin the validity set contract through
// direct inspection of the warning text — the source has both an
// ALIASES map and a VALID set, and any future renderFrame lookup
// must stay in sync with VALID.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

describe('setProjection validity set', () => {
  it('VALID set matches the renderFrame projType lookup', () => {
    const src = readFileSync(
      join(__dirname, 'map.ts'),
      'utf8',
    )
    // VALID set declared in setProjection.
    const validMatch = src.match(/const VALID = new Set\(\[([\s\S]*?)\]\)/)
    expect(validMatch).not.toBeNull()
    const validNames = (validMatch![1].match(/'([a-z_]+)'/g) ?? []).map(s => s.slice(1, -1))
    expect(validNames.sort()).toEqual([
      'azimuthal_equidistant',
      'equirectangular',
      'globe',
      'mercator',
      'natural_earth',
      'oblique_mercator',
      'orthographic',
      'stereographic',
    ])

    // renderFrame projType lookup — names → ids.
    const projTypeMatch = src.match(/let projType = \{([\s\S]*?)\}\[this\.projectionName\]/)
    expect(projTypeMatch).not.toBeNull()
    const projTypeNames = (projTypeMatch![1].match(/([a-z_]+):/g) ?? []).map(s => s.slice(0, -1))
    expect(projTypeNames.sort()).toEqual(validNames.sort())
  })
})
