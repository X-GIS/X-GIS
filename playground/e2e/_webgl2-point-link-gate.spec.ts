import { test, expect } from '@playwright/test'

// CAPSTONE: the REAL point shader (buildPointModule — 3 storage buffers feat_data/shapes/
// segments, strided + bitcast-u32 + array<Struct> scalar + vecN fields) emits GLSL via the
// storage→data-texture emulation and COMPILES + LINKS on real WebGL2. Proves the WebGL2
// fallback can build an actual vector-primitive shader, not just synthetic probes.
test('REAL point shader compiles + links on WebGL2 (storage emulation end-to-end)', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  // Wait for the demo's own boot (which calls configureProjections()) rather than
  // racing it on domcontentloaded — with 2 tests per file sharing one Vite dev
  // session, the SECOND test's dynamic import of _webgl2-proof.ts is warm-cache-fast
  // enough to reach buildPointModule() before an unguarded first test's boot
  // sequence would have finished (#1605 Phase 3: exposed by adding a 2nd test here).
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    {
      timeout: 25_000,
    },
  )
  const r = await page.evaluate(async () =>
    (await import('/e2e/_webgl2-proof.ts')).pointLinkAttempt(),
  )
  const ctx = `emitVs=${r.emitVs} emitFs=${r.emitFs} vsCompile=${r.vsCompile} fsCompile=${r.fsCompile} link=${r.link}\nlog: ${r.log}`
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.vsCompile, `point VS compile\n${ctx}`).toBe(true)
  expect(r.fsCompile, `point FS compile\n${ctx}`).toBe(true)
  expect(r.link, `point program link\n${ctx}`).toBe(true)
})

// #1605 Phase 3 Step 0 — the untested combination: does the default storage→
// data-texture lowering coexist with a COMPOSED module (a real fillExpr/strokeExpr
// swapped into the placeholder, PLUS extra preamble consts/funcs — the shape a real
// match()-authored @color body would produce), when actually compiled+linked on real
// WebGL2? This is verified in isolation, before any renderer wiring change lets a real
// variant reach WebGL2 in production (that's PR C's job).
test('REAL point shader WITH a composer variant (preamble consts/funcs + real exprs) compiles + links on WebGL2', async ({
  page,
}) => {
  test.setTimeout(30_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  // Wait for the demo's own boot (which calls configureProjections()) rather than
  // racing it on domcontentloaded — with 2 tests per file sharing one Vite dev
  // session, the SECOND test's dynamic import of _webgl2-proof.ts is warm-cache-fast
  // enough to reach buildPointModule() before an unguarded first test's boot
  // sequence would have finished (#1605 Phase 3: exposed by adding a 2nd test here).
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    {
      timeout: 25_000,
    },
  )
  const r = await page.evaluate(async () => {
    const { pointLinkAttempt, testPointVariant } = await import('/e2e/_webgl2-proof.ts')
    return pointLinkAttempt(testPointVariant())
  })
  const ctx = `emitVs=${r.emitVs} emitFs=${r.emitFs} vsCompile=${r.vsCompile} fsCompile=${r.fsCompile} link=${r.link}\nlog: ${r.log}`
  expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([])
  expect(r.vsCompile, `point VS compile (variant)\n${ctx}`).toBe(true)
  expect(r.fsCompile, `point FS compile (variant)\n${ctx}`).toBe(true)
  expect(r.link, `point program link (variant)\n${ctx}`).toBe(true)
})
