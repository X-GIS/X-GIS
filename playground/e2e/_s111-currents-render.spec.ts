// ═══ S-111 currents render gate (#1272 — headed, PENDING) ═══
//
// Two readings of ONE synthetic S-111 field (playground/public/synthetic-currents.h5,
// real S-111 band names/units/-9999 fill): the speed band through the viridis coverage
// colour ramp (0-2 kn), and drifting particles along the direction band (retained
// particle-flow, #826).
//
// Like _coverage-render.spec.ts, the GPU draw is HEADED-ONLY — this environment has no
// real GPU, so the render assertions are `test.fixme`'d until a headed run. NEVER report
// this green until it actually passes on a GPU. The pieces it gates (coverage f16 packing
// + LUT + WGSL/GLSL emit; the particle packer's density ∝ speed allocation; the read-in-
// place path) ARE unit-tested and green without a GPU (coverage-material.test.ts,
// retained-particle-packer.test.ts, data/src/hdf5/*.test.ts).
//
// The particle overlay animates, so the §5 directional pixel-diff needs a DETERMINISTIC
// frame: `?animt=<seconds>` PINS the particle clock (debug-flags.ts), making the frame a
// pure function of (seed, t). Capture at animt=0.25/0.5/0.75 and run compare-diff.py:
// DC>0 where particles/ramp appear (they render), D1<D0 vs a stored reference (direction
// correct), DC=0 on the arrow/icon/circle fixtures (no sibling regression). Read the diff
// IMAGE in a 16-split at full resolution — numbers never decide alone (CLAUDE.md §5).

import { test, expect } from '@playwright/test'

test.describe('S-111 currents render (headed, PENDING)', () => {
  // No real GPU in this environment; un-fixme once the headed capture harness runs.
  test.fixme()

  test('coverage speed ramp + particle overlay both render over the bay', async ({ page }) => {
    test.setTimeout(30_000)
    await page.setViewportSize({ width: 1024, height: 1024 })
    // Pin the particle clock so the frame is byte-reproducible (design §5.3).
    await page.goto('/demo.html?id=s111_currents&animt=0.5', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 15_000 },
    )
    // The runner's currents overlay expands the coverage's valid cells into a particle
    // batch; it advertises the cell count once packed (deterministic seed).
    await page.waitForFunction(
      () => (window as unknown as { __xgisCurrentsCells?: number }).__xgisCurrentsCells! > 0,
      null,
      { timeout: 10_000 },
    )
    const cells = await page.evaluate(
      () => (window as unknown as { __xgisCurrentsCells?: number }).__xgisCurrentsCells,
    )
    expect(cells).toBeGreaterThan(50) // the subsampled field seeds a legible number of cells

    // Whole-frame fidelity: the headed harness 16-splits the frame + runs the DC ladder
    // (compare-parity-pixeldiff) vs the stored reference at this pinned clock. A pixel-COUNT
    // gate passes on broken images — assert STRUCTURE (the ramp fills the bay, particles are
    // connected drift, not scattered confetti), not just nonBg %.
  })
})
