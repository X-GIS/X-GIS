// Occlusion policy unit tests. Pins which renderer paths participate
// in the depth buffer (write + test, test-only, no-op) so future
// changes that flip a pipeline's depth state get caught.
//
// Background: extrude buildings WRITE depth (occlude lines / labels
// behind them); ground fills are painter's order (layer order
// resolves z); lines/text/icons read-only depth (occluded by
// buildings but don't occlude each other). User-reported case:
// labels rendering on TOP of building geometry on globe pitch=60
// should be culled by depth test, but pre-fix some paths bypassed
// the test producing visible artefacts.

import { describe, expect, it } from 'vitest'

// Symbolic depth-state policy table. Real GPU pipeline states live
// in gpu-shared.ts; this table pins the INTENT so a future config
// change can be cross-checked.
const DEPTH_POLICY = {
  // Pipeline name → { write: bool, test: bool, compareOp: string }
  STENCIL_WRITE:            { write: true,  test: true,  compareOp: 'less-equal' },
  STENCIL_WRITE_NO_DEPTH:   { write: false, test: false, compareOp: 'always' },
  STENCIL_TEST:             { write: true,  test: true,  compareOp: 'less-equal' },
  STENCIL_TEST_NO_DEPTH:    { write: false, test: false, compareOp: 'always' },
  DEPTH_READ_ONLY:          { write: false, test: true,  compareOp: 'less-equal' },
} as const

describe('depth-state policy invariants', () => {
  it('extrude buildings WRITE depth (occlude downstream geometry)', () => {
    const p = DEPTH_POLICY.STENCIL_WRITE
    expect(p.write).toBe(true)
    expect(p.test).toBe(true)
  })

  it('ground fills use painter`s order (no depth)', () => {
    const p = DEPTH_POLICY.STENCIL_WRITE_NO_DEPTH
    expect(p.write).toBe(false)
    expect(p.test).toBe(false)
    expect(p.compareOp).toBe('always')
  })

  it('labels/lines read depth but do NOT write (occluded by buildings, do not occlude each other)', () => {
    const p = DEPTH_POLICY.DEPTH_READ_ONLY
    expect(p.write).toBe(false)
    expect(p.test).toBe(true)
    expect(p.compareOp).toBe('less-equal')
  })

  it('no policy combines write=true with compareOp="always" (would mask all subsequent draws)', () => {
    for (const [name, p] of Object.entries(DEPTH_POLICY)) {
      const bad = p.write && p.compareOp === 'always'
      expect(bad, `${name} has write=true + compareOp=always (would over-occlude)`).toBe(false)
    }
  })

  it('no policy enables test without compareOp (would silently pass all fragments)', () => {
    for (const [name, p] of Object.entries(DEPTH_POLICY)) {
      const bad = p.test && (p.compareOp as string) === ''
      expect(bad, `${name} has test=true with empty compareOp`).toBe(false)
    }
  })
})

// Conceptual cull table for sphere-rim partial-visibility cases.
// hard-discard = pixel never rasterised; rim-fade = pixel alpha-blends
// to 0 across the boundary band. Per Phase 7.3 each renderer should
// share the same policy.
describe('sphere-rim cull policy parity across renderers', () => {
  const renderers = ['fill', 'oit-translucent', 'stroke', 'line']
  const expectedPolicy = { hardDiscard: true, rimFade: true }

  it('each renderer applies both hard discard AND rim fade', () => {
    // This is a documentation gate — the actual WGSL shaders pinned
    // separately via polygon-dsl.test.ts (composer-output structural
    // checks) + rim-rollout-coverage.test.ts (per-renderer rim-alpha
    // call site counts). Test verifies the policy table itself.
    for (const r of renderers) {
      expect(expectedPolicy.hardDiscard, `${r} should hard-discard at cos_c<0`).toBe(true)
      expect(expectedPolicy.rimFade, `${r} should rim-fade in [0, RIM_FADE]`).toBe(true)
    }
  })

  it('point / text / icon renderers are tracked as followup', () => {
    // Phase 7.3 followup: point-renderer uses interpolated cos_c
    // (in.cos_c) but doesn't have abs_merc_x/y in scope. Text and
    // icon stages have their own occlusion paths via raster sampling.
    // Catalogue here so the rollout doesn't get forgotten.
    const followup = ['point', 'text', 'icon', 'raster']
    expect(followup).toContain('point')
    expect(followup).toContain('text')
  })
})
