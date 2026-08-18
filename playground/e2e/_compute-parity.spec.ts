import { test, expect } from '@playwright/test'

// M5 — cross-backend compute parity on a REAL WebGL2 GPU. The M2 compute->fragment-GPGPU
// lowering (emitGlslModule {emulateCompute}) must produce, for a real per-feature paint
// kernel, byte-IDENTICAL out_color to the CPU-f64 oracle when actually drawn into an
// R32UI offscreen FBO and read back with gl.readPixels. Proves "WebGL2 has no compute"
// is no excuse: the feature runs, correctly, on real WebGL2.
//
// #1812 — the same run also carries the PORTABLE KERNEL tier's GPU half: the fragment shader
// is emitted through the DECLARATION path (no emit-site option), pinned byte-identical to the
// `emulateCompute: true` emit, and it is the portable-path source that is compiled, linked,
// drawn and compared below. A tier that emits different bytes on a real driver is not a tier.
test('M2 compute->fragment-GPGPU byte-matches the oracle on real WebGL2', async ({ page }) => {
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => {
    const mod = await import('/e2e/_compute-parity.ts')
    return mod.runComputeParity()
  })
  expect(
    r.portableIdentical,
    `#1812 portable-path GLSL differs from the emulateCompute emit:\n${r.portableDiff}`,
  ).toBe(true)
  expect(r.vsLog, `fullscreen VS compile:\n${r.vsLog}`).toBe('')
  expect(r.fsLog, `lowered FS compile log:\n${r.fsLog}\n--- GLSL ---\n${r.glslFs}`).toBe('')
  expect(r.linkLog, `program link:\n${r.linkLog}`).toBe('')
  expect(r.fbStatus, `R32UI FBO status: ${r.fbStatus}`).toBe('complete')
  expect(r.n).toBeGreaterThan(0)
  expect(
    r.ok,
    `parity mismatches (fid: got vs want): ${JSON.stringify(r.mismatches)}\nNOTE: ${r.note}`,
  ).toBe(true)
})
