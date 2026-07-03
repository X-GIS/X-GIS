import { test, expect } from '@playwright/test'

// US-M4 — the runtime WebGl2Device compute-dispatch path on a REAL WebGL2 GPU. The
// production helper dispatchComputeKernelWebGl2 routes a per-feature compute kernel as a
// fullscreen draw into an R32UI offscreen FBO; the read-back out_color must byte-match the
// CPU-f64 oracle for every feature (incl. the multi-row over-grid/discard case). This is
// the §8.6 cross-backend feature-parity gate, driven through the runtime device — not hand GL.
test('runtime WebGl2Device compute dispatch byte-matches the oracle on real WebGL2', async ({
  page,
}) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_compute-dispatch-parity.ts')
    return mod.runComputeDispatchParity()
  })
  for (const c of r.cases) {
    expect(c.n).toBeGreaterThan(0)
    expect(
      c.mismatches.length,
      `${c.name}: ${c.mismatches.length} mismatches (fid: got vs want) ${JSON.stringify(c.mismatches)}`,
    ).toBe(0)
  }
  expect(r.ok, `NOTE: ${r.note}`).toBe(true)
  expect(r.cases.length).toBeGreaterThanOrEqual(2)
})
