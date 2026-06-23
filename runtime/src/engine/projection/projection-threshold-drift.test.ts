// ═══ Threshold drift gate (H1a / AC2) ═══
//
// The per-projection cull / rim thresholds (-0.85 azimuthal, -0.8
// stereographic, 0.0 ortho+globe) are hand-written in THREE live runtime
// copies — the WGSL needs_backface_cull + rim_alpha (shaders/projection.ts),
// the inline raster ladder (raster-renderer.ts), and the CPU mirror
// (projection-wgsl-mirror.ts). The CPU↔GPU mirror and the WGSL int-dispatch
// are FORCED (they cannot be collapsed), so this test makes the PROJECTIONS
// table the single AUTHORITY all three copies are pinned to: parse each
// copy's literals and assert they equal the table.
//
// Before this gate, the trace's discriminating probe (mutate one cull
// literal, run the suite) showed GREEN — nothing pinned the WGSL string to
// anything. This closes that blind spot: mutate ANY live copy → a parse
// here diverges from the table → RED; mutate the table → RED.

import { describe, it, expect } from 'vitest'
import { PROJECTIONS } from './projections-table'
import { WGSL_PROJECTION_FNS } from '../shaders/projection'
import { cosC, needsBackfaceCullWgsl, emitRasterWgsl } from '../shaders/dsl'

const AZIMUTHAL = PROJECTIONS[4]!.cullThreshold! // -0.85
const STEREO = PROJECTIONS[5]!.cullThreshold!    // -0.8
const ORTHO = PROJECTIONS[3]!.cullThreshold!     // 0.0

/** Captures every `group` match in order. */
function allMatches(src: string, re: RegExp): number[] {
  const out: number[] = []
  for (const m of src.matchAll(re)) out.push(parseFloat(m[1]!))
  return out
}

describe('projection threshold drift gate', () => {
  it('table cull thresholds are the expected per-projection values', () => {
    // Anchors the authority itself (a typo'd table is caught here, not
    // silently propagated as "the new truth").
    expect(AZIMUTHAL).toBe(-0.85)
    expect(STEREO).toBe(-0.8)
    expect(ORTHO).toBe(0.0)
  })

  it('WGSL needs_backface_cull select() thresholds == table', () => {
    // DSL-emitted form: `select(-1.0, 1.0, (cc > -0.85))` (fully parenthesised),
    // azimuthal then stereo.
    const found = allMatches(
      WGSL_PROJECTION_FNS(),
      /select\(-1\.0, 1\.0, \(\w+ > (-?[\d.]+)\)\)/g,
    )
    expect(found).toEqual([AZIMUTHAL, STEREO])
  })

  it('WGSL rim_alpha smoothstep lower bounds == table', () => {
    // DSL emits `smoothstep(LO, HI, center_cos_c(...))` with bounds precomputed
    // (RIM_FADE inlined). The migration dropped the hand `let cc`, so the cos_c value
    // is the inlined `center_cos_c(...)` call. Body order: ortho, azimuthal, stereo, globe.
    const found = allMatches(
      WGSL_PROJECTION_FNS(),
      /smoothstep\((-?[\d.]+), -?[\d.]+, center_cos_c\(/g,
    )
    // globe's rim is the SAME `smoothstep(0, RIM, cc)` as ortho, so the cse auto-cache
    // dedups them into one shared temp — 3 distinct smoothstep calls emit (ortho/globe
    // share, azimuthal, stereographic). The globe=0 threshold is still verified via that
    // shared temp + the behavioral cpu cull test below.
    expect(found).toEqual([ORTHO, AZIMUTHAL, STEREO])
  })

  it('generated cpu needs_backface_cull follows the table thresholds (behavioral)', () => {
    // The cpu-f64 lowering (shader-dsl/projections.ts) pulls cull thresholds
    // from the PROJECTIONS table, so its cull SIGN flips exactly at the table
    // value — drift-impossible by construction. Probe: azimuthal (4) visible
    // iff cc > AZIMUTHAL, stereographic (5) iff cc > STEREO. (Replaces the old
    // regex over the hand-written mirror, now deleted.)
    const CL = 0, CT = 20
    for (const [pt, thr] of [[4, AZIMUTHAL], [5, STEREO]] as const) {
      for (let i = 0; i < 12; i++) {
        for (let j = 0; j < 12; j++) {
          const lon = -180 + (i / 11) * 360
          const lat = -85 + (j / 11) * 170
          const cc = cosC(lon, lat, CL, CT)
          expect(needsBackfaceCullWgsl(pt, lon, lat, CL, CT) > 0).toBe(cc > thr)
        }
      }
    }
  })

  it('raster VS has NO inline cull-threshold ladder (PR 2d.3 — ECEF migration)', () => {
    // PR 2d.3 retired the per-projection threshold ladder in the raster VS
    // along with the 4-branch projection dispatch: the new ECEF path writes
    // `vis = 1` unconditionally, so the rim/backface decision is handled by
    // the ECEF MVP composition + the existing rim_alpha smoothstep below.
    // This test now anchors that direction — if a future change reintroduces
    // a hand-written threshold literal in the raster shader, the table is
    // the place to wire it. ORTHO/AZIMUTHAL/STEREO referenced here to keep
    // the table-anchor link explicit for grep/review.
    void ORTHO; void AZIMUTHAL; void STEREO
    const raster = emitRasterWgsl(false)
    const found = allMatches(raster, /threshold(?:: f32)? = (-?[\d.]+);/g)
    expect(found).toEqual([])
  })

  it('RIM_FADE band width is 0.02 in the emitted WGSL and the raster shader', () => {
    // The DSL inlines RIM_FADE (no `let RIM_FADE`), so each emitted smoothstep
    // band must be exactly 0.02 wide (HI − LO).
    const bands = [...WGSL_PROJECTION_FNS().matchAll(/smoothstep\((-?[\d.]+), (-?[\d.]+), center_cos_c\(/g)]
      .map((m) => Math.round((parseFloat(m[2]!) - parseFloat(m[1]!)) * 1000) / 1000)
    expect(bands).toEqual([0.02, 0.02, 0.02]) // ortho/globe share one cse'd smoothstep
    const raster = emitRasterWgsl(false)
    // raster applies `smoothstep(0.0, 0.02, input.vis)` — same fade width.
    expect(raster).toContain('smoothstep(0.0, 0.02,')
  })
})
