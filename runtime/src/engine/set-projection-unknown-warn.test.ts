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
//
// The ALIASES + VALID sets live on ViewportModeController (the
// projection-mode collaborator extracted from map.ts); XGISMap.setProjection
// is a one-line forwarder. Inspect the controller source for the contract.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { PROJECTIONS } from '@xgis/engine'

describe('setProjection validity set', () => {
  it('every ALIASES entry maps to a VALID name', () => {
    const src = readFileSync(
      join(__dirname, 'render', 'viewport-mode-controller.ts'),
      'utf8',
    )
    // ALIASES → canonical.
    const aliasMatch = src.match(/const ALIASES: Record<string, string> = \{([\s\S]*?)\}/)
    expect(aliasMatch).not.toBeNull()
    const aliasMap = aliasMatch![1]
      .split('\n').map(l => l.trim())
      .filter(l => l.includes("':"))
      .map(l => {
        const m = l.match(/'([^']+)':\s*'([^']+)'/)
        return m ? { alias: m[1], canonical: m[2] } : null
      })
      .filter((x): x is { alias: string; canonical: string } => x !== null)
    expect(aliasMap.length).toBeGreaterThan(0)

    const validMatch = src.match(/const VALID = new Set\(\[([\s\S]*?)\]\)/)
    const validNames = new Set((validMatch![1].match(/'([a-z_]+)'/g) ?? []).map(s => s.slice(1, -1)))

    for (const { alias, canonical } of aliasMap) {
      expect(validNames.has(canonical), `alias '${alias}' maps to '${canonical}' which is not in VALID`).toBe(true)
    }
  })

  it('VALID set matches the renderFrame projType lookup', () => {
    const src = readFileSync(
      join(__dirname, 'render', 'viewport-mode-controller.ts'),
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

    // renderFrame's projType lookup is now derived from the single-source
    // PROJECTIONS table (render-loop.ts uses PROJECTION_NAME_TO_TYPE, built
    // from this table). The VALID set in ViewportModeController must stay in
    // sync with the table's projection names — checked here against runtime.
    expect(PROJECTIONS.map((p) => p.name).sort()).toEqual(validNames.sort())
  })
})
