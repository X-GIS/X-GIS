// #2137 — the emitted vs_tile must POSITION from the CPU trig table, not derive
// the ECEF from angles.
//
// This is the wiring half of the migration. `_raster-grid-lat-parity.spec.ts`
// proves the MATH — that the table formulation lands inside the f32 floor while
// the angle formulation is displaced ~3000x further — but it runs a standalone
// compute pass over a transcription of both, so it cannot see which one the
// shipped shader actually uses. Nothing there would go red if `raster.ts`
// silently reverted. This test is what closes that: it reads the emitted WGSL.
//
// The hazard being pinned: every transcendental on the ECEF path multiplies the
// EARTH RADIUS, so a backend's relative trig error becomes METRES of ground
// displacement (1.17e+3 m measured on SwiftShader). The table removes the
// transcendentals from that path entirely rather than making them more precise —
// deriving the latitude more accurately was measured and does NOT help, because
// `lonlat_to_ecef`'s own sin/cos/sqrt dominate.

import { describe, it, expect } from 'vitest'
// Through the barrel, like the other emit tests (rim-rollout-coverage.test.ts):
// it installs the projection specs `buildRasterModule` needs, which a direct
// module import does not.
import { emitRasterWgsl } from '@xgis/map'

function wgsl(): string {
  return emitRasterWgsl(false)
}

describe('#2137 raster grid trig-table wiring', () => {
  it('declares both trig tables on TileUniforms', () => {
    const w = wgsl()
    expect(w).toMatch(/row_trig\s*:\s*array<vec4<f32>\s*,\s*9>/)
    expect(w).toMatch(/col_trig\s*:\s*array<vec4<f32>\s*,\s*9>/)
  })

  it('READS both tables in the vertex stage', () => {
    const w = wgsl()
    // A declared-but-unread table is the exact shape of a migration that looks
    // done and changes nothing — the #2089 gate had to pin the same thing about
    // its twelve lanes.
    expect(w).toMatch(/tile\.row_trig\[/)
    expect(w).toMatch(/tile\.col_trig\[/)
  })

  it('indexes the tables by the grid row/col, not by a constant', () => {
    const w = wgsl()
    // Constant indices would read one row for every vertex — geometry collapsed
    // onto a single parallel/meridian, which a hash-equality render gate would
    // catch only after the fact. The indices must be the same integer lane the
    // grid derives its position from.
    const rowIdx = /tile\.row_trig\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(w)
    const colIdx = /tile\.col_trig\[([A-Za-z_][A-Za-z0-9_]*)\]/.exec(w)
    expect(rowIdx, 'row_trig must be indexed by an identifier').not.toBeNull()
    expect(colIdx, 'col_trig must be indexed by an identifier').not.toBeNull()
    expect(rowIdx?.[1]).not.toBe(colIdx?.[1]) // row and col cannot be the same lane
  })

  it('still keeps the angle path for the tiles the table does not cover', () => {
    const w = wgsl()
    // gridN > 8 (tileZoom 0-3) and the pole caps keep deriving — the table is
    // sized 9 and the cap latitude comes from the cap fan, not the row grid. If
    // this disappears those tiles lose their latitude entirely.
    expect(w).toContain('atan(')
    expect(w).toContain('exp(')
  })
})
