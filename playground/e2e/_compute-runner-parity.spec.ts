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

// The WebGPU tier, on real SwiftShader WebGPU (#1903).
//
// NOT at `?forcegl2=1`: this arm needs `navigator.gpu`, which the playwright config already
// enables headlessly (`--enable-unsafe-swiftshader` plus the dev server's secure context —
// both are required, and a probe missing either concludes the platform has no WebGPU).
//
// This is the arm the WebGL2 one cannot stand in for. WebGL2 proves the compute→fragment
// LOWERING is value-faithful; this proves the same authored kernel, emitted UNCHANGED as
// `@compute`, computes the same thing — which is the portable tier's actual claim.
test('createComputeRunner: the webgpu tier agrees with the oracle and with the cpu tier', async ({
  page,
}) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_compute-runner-parity.ts')
    return mod.runComputeRunnerWebGpuParity()
  })

  // A missing device is a HARD failure here, not a skip: CLAUDE.md §5 records that WebGPU
  // does run headlessly in this container, and a test.fixme() whose stated reason is "no
  // real GPU here" is the exact claim that cost real work once already.
  expect(r.unavailable ?? '', `WebGPU unavailable: ${r.unavailable ?? ''}`).toBe('')
  // Asserted before any value: `prefer: ['webgpu']` is pinned, so a different backend here
  // would mean the numbers below came from somewhere else entirely.
  expect(r.backend, `NOTE: ${r.note}`).toBe('webgpu')
  // A dispatch that never legally ran reads back a zero-filled buffer, which looks like a
  // real answer for a zero input — so the validation log is checked, not just the values.
  expect(r.gpuErrors, `uncaptured WebGPU errors: ${r.gpuErrors.join(' | ')}`).toEqual([])

  for (const c of r.cases) {
    expect(c.gotLen, `${c.name}: wrong output length`).toBe(c.n)
    expect(
      c.mismatches.length,
      `${c.name}: webgpu tier diverged from the oracle — ${JSON.stringify(c.mismatches)}`,
    ).toBe(0)
  }
  expect(r.cases.length).toBe(5)
  expect(
    r.crossTierMismatches.length,
    `webgpu and cpu tiers disagree — ${JSON.stringify(r.crossTierMismatches)}`,
  ).toBe(0)
  expect(r.ok, `NOTE: ${r.note}`).toBe(true)
})
