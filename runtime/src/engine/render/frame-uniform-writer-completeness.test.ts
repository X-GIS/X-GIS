// Completeness gate: every renderer that writes the projection into a uniform
// MUST also write the globe eye-horizon cull field. (#663 / #600 follow-up.)
//
// THE BUG THIS CATCHES — #600 added the `globe_eye` uniform, read by the SHARED
// shader cull `needs_backface_cull`, but the WRITE was wired into only 3 of the 6
// CPU writers (raster/point/heatmap), missing the vector path (vector-tile-renderer,
// renderer.renderToPass, graticule-renderer). With globe_eye left zero those layers
// silently fell back to the centre-hemisphere cull and leaked far-side geometry on
// the globe. Nothing forced the new field into every writer — the contract was
// "by convention", maintained across N independent sites.
//
// THE INVARIANT — `globe_eye` is FRAME-INVARIANT and (projType, center)-derived,
// exactly like `proj_params`: a writer that knows the projection (writes proj_params,
// i.e. "we are on the globe") MUST also know the eye for the cull (writes globe_eye).
// So: any render source that HAND-PACKS `proj_params` must also write `globe_eye`.
// This AUTO-DISCOVERS writers (a future renderer that packs proj_params but forgets
// globe_eye fails here) with no hand-maintained writer list.
//
// SCOPE NOW (ADR-0009 step 2-3 landed): the polygon/line group(0) family
// (vector-tile-renderer / renderer.renderToPass / graticule) NO LONGER hand-packs
// these — it routes through `frame-projection-uniform.ts:writeFrameProjectionUniform`,
// which writes proj_params + globe_eye TOGETHER, so a partial write is structurally
// unrepresentable there (no guard needed). This test now auto-narrows to the families
// that STILL hand-pack their own struct (raster / heatmap) and holds the line for them
// until they adopt the same coupled writer — at which point DELETE this file. The
// coupled writer itself (frame-projection-uniform.ts) is excluded: it is the fix, not
// a consumer to police. Do not grow this into a permanent parallel registry.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

const RENDER_DIR = join(process.cwd(), 'runtime/src/engine/render')

/** Recursively list non-test .ts files under the render dir (incl. spec-wiring/, passes/). */
function renderSources(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { out.push(...renderSources(p)); continue }
    if (!name.endsWith('.ts')) continue
    if (name.endsWith('.test.ts')) continue
    // The coupled writer IS the structural fix (writes proj_params + globe_eye
    // together) — it's not a per-renderer consumer to police, and it trivially
    // satisfies the check. Exclude so the tripwire counts only real hand-packers.
    if (name === 'frame-projection-uniform.ts') continue
    out.push(p)
  }
  return out
}

// A "frame uniform writer" packs the projection into a uniform — match the slot-write
// idioms the renderers use: `XS.proj_params` (reflected-slot proxy) or `.proj_params * 4`
// (Float32Array byte-offset). The globe_eye write uses the SAME idioms.
const WRITES_PROJ_PARAMS = /\b[A-Z]{1,3}\.proj_params\b|\.proj_params\s*\*\s*4/
const WRITES_GLOBE_EYE = /\b[A-Z]{1,3}\.globe_eye\b|\.globe_eye\s*\*\s*4/

describe('frame-uniform writer completeness (#600 globe_eye leak gate)', () => {
  it('every renderer that writes proj_params also writes globe_eye', () => {
    const offenders: string[] = []
    let writerCount = 0
    for (const path of renderSources(RENDER_DIR)) {
      const src = readFileSync(path, 'utf8')
      if (!WRITES_PROJ_PARAMS.test(src)) continue
      writerCount++
      if (!WRITES_GLOBE_EYE.test(src)) {
        offenders.push(
          `${path.slice(path.indexOf('runtime/'))}: writes proj_params but NOT globe_eye — ` +
          `on the globe its cull falls back to the centre-hemisphere model and leaks far-side ` +
          `geometry (#600). Pack globe_eye via globeEyeUniform(frame.eye) too.`,
        )
      }
    }
    // Guard against the regex silently matching nothing (e.g. a slot-proxy rename) —
    // that would make this test vacuously pass while protecting nothing. After the
    // polygon/line family moved to the coupled writer, the remaining hand-packers are
    // raster + heatmap (≥2). When those also adopt a coupled writer this drops to 0 —
    // delete the file then rather than lowering this further.
    expect(writerCount, 'no proj_params hand-packers found — the detector regex has drifted').toBeGreaterThanOrEqual(2)
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
