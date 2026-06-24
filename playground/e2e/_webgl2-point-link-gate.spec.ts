import { test, expect } from '@playwright/test'

// CAPSTONE: the REAL point shader (buildPointModule — 3 storage buffers feat_data/shapes/
// segments, strided + bitcast-u32 + array<Struct> scalar + vecN fields) emits GLSL via the
// storage→data-texture emulation and COMPILES + LINKS on real WebGL2. Proves the WebGL2
// fallback can build an actual vector-primitive shader, not just synthetic probes.
test('REAL point shader compiles + links on WebGL2 (storage emulation end-to-end)', async ({ page }) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  const r = await page.evaluate(async () => (await import('/e2e/_webgl2-proof.ts')).pointLinkAttempt())
  const ctx = `emitVs=${r.emitVs} emitFs=${r.emitFs} vsCompile=${r.vsCompile} fsCompile=${r.fsCompile} link=${r.link}\nlog: ${r.log}`
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.vsCompile, `point VS compile\n${ctx}`).toBe(true)
  expect(r.fsCompile, `point FS compile\n${ctx}`).toBe(true)
  expect(r.link, `point program link\n${ctx}`).toBe(true)
})
