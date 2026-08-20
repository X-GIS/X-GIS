import { test, expect } from '@playwright/test'

// The standalone WebGL2 GPGPU recipe published on /shader-dsl/webgl2-compute, run on a
// REAL WebGL2 GPU. The page prints two host functions (createDataTexture,
// dispatchToR32UI) for consumers who vendor @xgis/shader-dsl ALONE — no rhi packages —
// so the snippet has to be a proven program. `_webgl2-compute-recipe.ts` holds those two
// functions verbatim and drives them against the CPU-f64 oracle.
//
// Fails when: the page's recipe drifts from the harness, the emit changes what the host
// must bind (a UBO where the page says bare uniform, a different sampler name), or the
// compute→fragment lowering stops being value-faithful.
test('the documented standalone WebGL2 GPGPU recipe byte-matches the oracle', async ({ page }) => {
  await page.goto('/demo.html?id=minimal&forcegl2=1', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_webgl2-compute-recipe.ts')
    return mod.runWebGl2ComputeRecipe()
  })

  // The emit is the lowered FRAGMENT program, not a compute one — the page's whole claim.
  expect(r.glsl, `NOTE: ${r.note}`).toContain('#version 300 es')
  expect(r.glsl).toContain('void main()')
  expect(r.glsl).toMatch(/layout\(location = 0\) out uint \w+;/)
  expect(r.glsl).toContain('uniform sampler2D feat_data;')
  expect(r.glsl).toContain('uniform uvec4 u_dispatch;') // bare, not a std140 block
  expect(r.glsl).not.toContain('@compute')

  for (const c of r.cases) {
    expect(c.n).toBeGreaterThan(0)
    expect(
      c.mismatches.length,
      `${c.name}: ${c.mismatches.length} mismatches (i: got vs want) ${JSON.stringify(c.mismatches)}`,
    ).toBe(0)
  }
  expect(r.ok, `NOTE: ${r.note}`).toBe(true)
  expect(r.cases.length).toBeGreaterThanOrEqual(2)
})
