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
// So: any render source that writes `proj_params` into a uniform must also write
// `globe_eye`. This AUTO-DISCOVERS writers (a future renderer that packs proj_params
// but forgets globe_eye fails here) with no hand-maintained writer list.
//
// ⚠ STOP-GAP, NOT THE CURE. This is a guard that holds the line until the durable
// fix lands: a single per-frame uniform block written ONCE by a shared producer (see
// docs/adr/0009-frame-invariant-uniform-block.md). Once frame-invariant fields are
// packed in one place, "missing from 3 of 6 writers" becomes unrepresentable and
// THIS TEST SHOULD BE DELETED. Do not grow it into a permanent parallel registry.

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
    // that would make this test vacuously pass while protecting nothing.
    expect(writerCount, 'no proj_params writers found — the detector regex has drifted').toBeGreaterThanOrEqual(5)
    expect(offenders, offenders.join('\n')).toEqual([])
  })
})
