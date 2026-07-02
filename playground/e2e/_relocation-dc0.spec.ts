// LOCAL-ONLY relocation DC=0 gate (real GPU). NOT a CI test.
//
// The P3 @xgis/map extraction is a PURE SOURCE RELOCATION: moving content files
// (renderers / materials / passes / VTR / formats) out of runtime/src/engine into
// map/src and rewriting import paths must move ZERO pixels. This spec captures a
// deterministic multi-style fixture set at a frozen camera so a before/after
// pixelmatch (scripts: ../../scratch dc0-diff.mjs) can prove DC=0 after each step.
//
// A non-zero DC = the move changed module-init order (eager reflect() /
// projections-table init / uniform-ring grow — the #612/#193 hazards) = a real bug.
//
//   cd playground
//   RELOC_DC0_DIR=<out-dir> ./node_modules/.bin/playwright test e2e/_relocation-dc0.spec.ts --headed --reporter=line
//
// Deterministic by construction: anim_* (continuous keyframe) fixtures are excluded;
// each fixture is loaded, settled, then FROZEN via jumpTo to the auto-fit-settled
// camera so no residual ease perturbs the captured frame.

import { test } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT_DIR = process.env.RELOC_DC0_DIR ?? 'test-results/relocation-dc0'

// Offline, deterministic fixtures spanning the content renderer surface a relocation
// could perturb: polygon fill, SDF line, SDF point, VTR (flat + 3D extrude), globe
// back-face, SDF billboard, fill-pattern material, uniform-ring boundary, match().
const FIXTURES: Array<{ id: string; extra?: string }> = [
  { id: 'fixture_stress_all_renderers' }, // polygon + SDF line + SDF point (merc, 3 renderers)
  { id: 'fixture_extrude_local' },        // VTR + 3D extrude (merc)
  { id: 'fixture_flat_local' },           // VTR fill flat (merc)
  { id: 'fixture_projection_orthographic' }, // globe / back-face cull
  { id: 'fixture_sdf_point' },            // SDF billboard (OPAQUE pin) — copy-count-invariant, unlike
                                          // the translucent fixture_sdf_glow whose halo overdraws once
                                          // per visible world copy and flips with sub-pixel zoom at the
                                          // getVisibleWorldCopies 4↔6 boundary (non-deterministic → bad gate)
  { id: 'fixture_fill_pattern', extra: '&sprite=/fixture-sprite' }, // pattern material twin
  { id: 'fixture_stress_many_layers' },   // 8 layers — uniform ring boundary
  { id: 'fixture_categorical' },          // match() data-driven fill
  { id: 'fixture_raster_local' },         // offline raster tile — raster global+tile uniform path (#733 P2b)
]

type W = {
  __xgisReady?: boolean
  __xgisMap?: {
    jumpTo?: (o: object) => void
    getCenter?: () => [number, number]
    getZoom?: () => number
    getBearing?: () => number
    getPitch?: () => number
  }
}

// Camera is INSTANT in this engine (easeTo/flyTo alias jumpTo — map.ts:1123), so there is no
// ease to wait out. The real non-determinism is ASYNC content streaming (VTR tiles, SDF glyph
// atlas, sprites): the frame at a fixed wall-clock differs run-to-run by how much has streamed.
// Fix = poll FRAME STABILITY — rendering is on-demand, so once loading completes the scene stops
// repainting and consecutive screenshots become byte-identical. Capture that settled frame.
async function captureSettled(page: import('@playwright/test').Page, out: string, id: string) {
  let prev: Buffer | null = null
  let buf: Buffer = await page.screenshot()
  let stable = 0
  let i = 0
  for (; i < 24 && stable < 3; i++) {
    await page.waitForTimeout(350)
    buf = await page.screenshot()
    if (prev && Buffer.compare(prev, buf) === 0) stable++
    else { stable = 0; prev = buf }
  }
  fs.writeFileSync(path.join(out, `${id}.png`), buf)
  console.log(`[reloc-dc0] ${id} ${stable >= 3 ? 'SETTLED' : 'UNSETTLED'} after ${i} polls, ${buf.length}B`)
}

test('capture relocation DC=0 fixture set (settled frame, real-GPU)', async ({ page }) => {
  test.setTimeout(12 * 60_000)
  fs.mkdirSync(OUT_DIR, { recursive: true })
  await page.setViewportSize({ width: 600, height: 600 })

  for (const fx of FIXTURES) {
    const url = `/demo.html?id=${fx.id}&e2e=1${fx.extra ?? ''}`
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 30_000 })

    // Freeze the (already-instant) camera so a stray re-fit can't perturb the frame, then wait
    // for the scene to fully settle before capturing.
    await page.evaluate(() => {
      const m = (window as unknown as W).__xgisMap
      if (!m?.jumpTo || !m.getCenter) return
      m.jumpTo({ center: m.getCenter(), zoom: m.getZoom?.(), bearing: m.getBearing?.(), pitch: m.getPitch?.() })
    })
    await captureSettled(page, OUT_DIR, fx.id)
  }
})
