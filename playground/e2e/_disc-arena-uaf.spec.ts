// Regression: poly-arena use-after-free on the non-merc z0 disc cells.
//
// SYMPTOM (intermittent, real GPU):
//   [WebGPU validation] [Buffer "poly-vertex-arena"] used in submit while destroyed.
//   [WebGPU validation] [Buffer "poly-index-arena"]  used in submit while destroyed.
//
// CAUSE: the page boots `fixture_synth_bg_only` at the source's DEFAULT
// projection (mercator, worldBand 'mercator-clamped'). The
// SyntheticEarthSurfaceBackend's single z=0 DSFUN POLYGON tile is uploaded
// via the ASYNC route (VTR.doUploadTileAsync), which SUSPENDS on the
// staging-buffer mapAsync round-trip BEFORE it submits its
// copyBufferToBuffer-into-arena commands. The `?proj=` override to a
// sphere-full disc projection (ortho/azi/stereo) then runs setProjection
// SYNCHRONOUSLY in that suspension window; crossing mercator-clamped →
// sphere-full fires setBackgroundFill(null) → teardownSource →
// VTR.destroy(), which destroys the poly-vertex/index arena buffers. When
// the suspended upload resumes it submits an encoder whose copy targets the
// now-destroyed arena buffer → "used in submit while destroyed".
//
// FIX (runtime/src/engine/render/vector-tile-renderer.ts): VTR.destroy()
// sets a sticky `_destroyed` flag and drops all queued uploads BEFORE
// destroying the arenas; doUploadTileAsync re-checks `_destroyed` after its
// last await and bails WITHOUT submitting when torn down. This spec is the
// permanent gate that the destroy→submit ordering stays closed.
//
// Only mercator → ortho/azi/stereo crosses the worldBand boundary that
// triggers the teardown, so the disc projections are the precise repro. The
// race is intermittent (depends on whether the upload is still suspended on
// mapAsync when the boot-time setProjection runs), so each projection is
// driven over several iterations of a fresh load to make a regression
// reliably reproduce.
//
// This gate is INDEPENDENT of the disc-fraction assertions in
// _disc-coverage-matrix.spec.ts (azi/stereo are EXPECTED-RED there for an
// unrelated flatViewHeightCapM table-completeness defect): it never inspects
// coverage — only the presence of the buffer-destroy validation error.
//
// Real GPU headed (HEADED=1; do NOT set XGIS_SOFTWARE_GPU). LOCAL/pre-push
// gate (SwiftShader does not exercise the same async-upload timing). Clear
// playground/node_modules/.vite before a run.

import { test, expect, type Page } from '@playwright/test'

const READY_TIMEOUT_MS = 30_000

// The disc projections whose worldBand (sphere-full) differs from the boot
// default (mercator → mercator-clamped); only these trip the teardown.
const DISC_PROJECTIONS = ['orthographic', 'azimuthal_equidistant', 'stereographic'] as const

// Re-load each projection a few times — the UAF is a timing race on whether
// the synthetic z0 upload is still suspended on mapAsync when the boot
// setProjection lands. Several fresh loads make the pre-fix error reliably
// surface on at least one.
const ITERATIONS = 4

// A validation error that names a poly arena AND says it was used after
// destroy — the exact UAF signature. Matches both the global
// `[WebGPU validation]` (uncaptured, the upload-path submit) and the
// per-frame `[X-GIS frame-validation]` (render-path) reporter prefixes.
function isPolyArenaUAF(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('while destroyed') &&
    (t.includes('poly-vertex-arena') || t.includes('poly-index-arena'))
  )
}

async function waitForXgisReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: READY_TIMEOUT_MS },
  )
}

test.describe.configure({ mode: 'serial' })

for (const proj of DISC_PROJECTIONS) {
  test(`disc-arena-uaf: no "used in submit while destroyed" switching into ${proj}`, async ({ page }) => {
    test.setTimeout(2 * 60_000)
    await page.setViewportSize({ width: 1024, height: 768 })

    const uafErrors: string[] = []
    page.on('pageerror', (e) => { if (isPolyArenaUAF(e.message)) uafErrors.push(`[pageerror] ${e.message}`) })
    page.on('console', (m) => {
      if (m.type() === 'error' && isPolyArenaUAF(m.text())) uafErrors.push(m.text())
    })

    for (let i = 0; i < ITERATIONS; i++) {
      // Boot the synthetic-bg-only fixture and switch INTO the disc
      // projection via ?proj=. The page boots at mercator (the source
      // default), so the ?proj override is the band-crossing setProjection
      // that tears down the synthetic VTR while its z0 upload may still be
      // suspended on mapAsync — the exact repro.
      await page.goto(
        `/demo.html?id=fixture_synth_bg_only&e2e=1&proj=${proj}#0/0/0/0/0`,
        { waitUntil: 'domcontentloaded', timeout: 60_000 },
      )
      await waitForXgisReady(page)

      // Pump several rAFs so any in-flight upload's submit (or its skipped
      // submit, post-fix) and the next frames land — the validation error,
      // if any, fires on the upload coroutine resuming after teardown.
      await page.evaluate(() => new Promise<void>((r) => {
        let n = 0
        const loop = () => { if (++n >= 12) r(); else requestAnimationFrame(loop) }
        requestAnimationFrame(loop)
      }))
      await page.waitForTimeout(250) // let the async upload's microtask settle
    }

    if (uafErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[disc-arena-uaf] ${proj}: ${uafErrors.length} poly-arena UAF error(s):`)
      for (const e of uafErrors.slice(0, 5)) console.log(`  ${e}`)
    }

    expect(
      uafErrors,
      `poly-arena "used in submit while destroyed" fired switching mercator → ${proj} ` +
      `(${ITERATIONS} iterations). The synthetic VTR's async z0 upload submitted into a ` +
      `destroyed poly-vertex/index arena — destroy→submit ordering regressed.`,
    ).toEqual([])
  })
}
