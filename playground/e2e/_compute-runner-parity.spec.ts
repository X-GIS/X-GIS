import { test, expect } from '@playwright/test'

// createComputeRunner's cross-tier value parity on a REAL WebGL2 GPU (#1903).
//
// The vitest suite proves tier RESOLUTION and the CPU tier's numbers; it cannot touch the
// WebGL2 tier because Node has no GL context. This is that half: the same module and the
// same input through `prefer: ['webgl2', …]` and through `prefer: ['cpu']`, both compared
// against the tree-walk interpreter — three engines, one answer.
test('createComputeRunner: the webgl2 and cpu tiers agree with the oracle', async ({ page }) => {
  await page.goto('/demo.html?id=minimal&forcegl2=1', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_compute-runner-parity.ts')
    return mod.runComputeRunnerParity()
  })

  // Resolution is order-driven: asserted FIRST, because if a tier silently resolved
  // elsewhere the parity below would compare cpu against cpu and prove nothing — the
  // assertion-that-passes-either-way shape (§12).
  expect(r.glBackend, `NOTE: ${r.note}`).toBe('webgl2')
  expect(r.cpuBackend).toBe('cpu')

  // `rejected` is populated on a real host, not just in the Node unit test: the CPU-pinned
  // runner names why it skipped nothing (cpu is first in its list), and the GL runner
  // proves a live context wins over the CPU fallback.
  expect(r.cpuRejected).toEqual([])

  for (const c of r.cases) {
    expect(c.n).toBeGreaterThan(0)
    expect(
      c.glMismatches.length,
      `${c.name}: webgl2 tier diverged from the oracle — ${JSON.stringify(c.glMismatches)}`,
    ).toBe(0)
    expect(
      c.cpuMismatches.length,
      `${c.name}: cpu tier diverged from the oracle — ${JSON.stringify(c.cpuMismatches)}`,
    ).toBe(0)
  }
  expect(r.cases.length).toBeGreaterThanOrEqual(2)
  expect(r.ok, `NOTE: ${r.note}`).toBe(true)
})
