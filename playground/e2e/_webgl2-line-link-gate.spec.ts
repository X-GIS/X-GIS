import { test, expect } from '@playwright/test'

// CAPSTONE: the REAL line shader (buildLineModule — 3 storage buffers segments/shapes/
// shape_segments, strided + array<Struct> fields) emits GLSL via the storage→data-texture
// emulation and COMPILES + LINKS on real WebGL2. Mirrors _webgl2-point-link-gate.spec.ts.
test('REAL line shader compiles + links on WebGL2 (storage emulation end-to-end)', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  // Wait for the demo's own boot (which calls configureProjections()) rather than
  // racing it on domcontentloaded — with 2 tests per file sharing one Vite dev
  // session, the SECOND test's dynamic import of _webgl2-proof.ts is warm-cache-fast
  // enough to reach buildLineModule() before an unguarded first test's boot
  // sequence would have finished (mirrors _webgl2-point-link-gate.spec.ts).
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    {
      timeout: 25_000,
    },
  )
  const r = await page.evaluate(async () =>
    (await import('/e2e/_webgl2-proof.ts')).lineLinkAttempt(),
  )
  const ctx = `emitVs=${r.emitVs} emitFs=${r.emitFs} vsCompile=${r.vsCompile} fsCompile=${r.fsCompile} link=${r.link}\nlog: ${r.log}`
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.vsCompile, `line VS compile\n${ctx}`).toBe(true)
  expect(r.fsCompile, `line FS compile\n${ctx}`).toBe(true)
  expect(r.link, `line program link\n${ctx}`).toBe(true)
})

// #1605 Phase 3 Step 0 — the untested combination: does emulateStorage's storage→
// data-texture lowering coexist with a COMPOSED module (a real strokeExpr swapped into
// the placeholder, PLUS extra preamble consts/funcs — the shape a real match()-authored
// @stroke body would produce), when actually compiled+linked on real WebGL2? Verified in
// isolation, before any renderer wiring change lets a real variant reach WebGL2 in
// production (that's PR B's job). Also proves emitLineGlsl's 3-fragment-entry filter
// (fs_line/fs_line_pattern/fs_line_max) still selects the right one after composition.
test('REAL line shader WITH a composer variant (preamble consts/funcs + real expr) compiles + links on WebGL2', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  // Wait for the demo's own boot (which calls configureProjections()) rather than
  // racing it on domcontentloaded — with 2 tests per file sharing one Vite dev
  // session, the SECOND test's dynamic import of _webgl2-proof.ts is warm-cache-fast
  // enough to reach buildLineModule() before an unguarded first test's boot
  // sequence would have finished (mirrors _webgl2-point-link-gate.spec.ts).
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    {
      timeout: 25_000,
    },
  )
  const r = await page.evaluate(async () => {
    const { lineLinkAttempt, testLineVariant } = await import('/e2e/_webgl2-proof.ts')
    return lineLinkAttempt(testLineVariant())
  })
  const ctx = `emitVs=${r.emitVs} emitFs=${r.emitFs} vsCompile=${r.vsCompile} fsCompile=${r.fsCompile} link=${r.link}\nlog: ${r.log}`
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.vsCompile, `line VS compile (variant)\n${ctx}`).toBe(true)
  expect(r.fsCompile, `line FS compile (variant)\n${ctx}`).toBe(true)
  expect(r.link, `line program link (variant)\n${ctx}`).toBe(true)
})
