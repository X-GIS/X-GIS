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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECTIONS } from './projections-table'
import { WGSL_PROJECTION_FNS } from '../shaders/projection'
import { cosC, needsBackfaceCullWgsl } from '../shader-dsl/cpu-projections'

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
    // `return select(-1.0, 1.0, cc > -0.85)` (azimuthal then stereo).
    const found = allMatches(
      WGSL_PROJECTION_FNS,
      /select\(-1\.0, 1\.0, cc > (-?[\d.]+)\)/g,
    )
    expect(found).toEqual([AZIMUTHAL, STEREO])
  })

  it('WGSL rim_alpha smoothstep lower bounds == table', () => {
    // `smoothstep(-0.85, -0.85 + RIM_FADE, cc)` — azimuthal then stereo.
    const found = allMatches(
      WGSL_PROJECTION_FNS,
      /smoothstep\((-?[\d.]+), -?[\d.]+ \+ RIM_FADE, cc\)/g,
    )
    expect(found).toEqual([AZIMUTHAL, STEREO])
    // ortho + globe rim fade from the visibility boundary (0.0).
    const orthoGlobe = allMatches(
      WGSL_PROJECTION_FNS,
      /smoothstep\((-?[\d.]+), RIM_FADE, cc\)/g,
    )
    expect(orthoGlobe).toEqual([ORTHO, ORTHO])
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

  it('inline raster cull ladder thresholds == table', () => {
    const raster = readFileSync(
      join(__dirname, '..', 'render', 'raster-renderer.ts'),
      'utf8',
    )
    // `var threshold = 0.0;` then `threshold = -0.85;` (azimuthal),
    // `threshold = -0.8;` (stereo).
    const found = allMatches(raster, /threshold = (-?[\d.]+);/g)
    expect(found).toEqual([ORTHO, AZIMUTHAL, STEREO])
  })

  it('RIM_FADE is the same 0.02 in WGSL and the raster shader', () => {
    const wgslFade = allMatches(WGSL_PROJECTION_FNS, /let RIM_FADE = ([\d.]+);/g)
    expect(wgslFade).toEqual([0.02])
    const raster = readFileSync(
      join(__dirname, '..', 'render', 'raster-renderer.ts'),
      'utf8',
    )
    // raster applies `smoothstep(0.0, 0.02, input.vis)` (rim-rollout pins
    // the exact string; here we pin the fade WIDTH agrees with the WGSL).
    expect(raster).toContain('smoothstep(0.0, 0.02,')
  })
})
