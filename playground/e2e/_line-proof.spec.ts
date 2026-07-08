import { test, expect } from '@playwright/test'

// #834 M5 slice 1 — isolation proof: one synthetic segment through the REAL
// line twins on a scratch WebGl2Device (no VTR). Permanent regression gate
// for the autoVars/pre-pass ordering class — see _line-proof.ts.

test('line twin renders one synthetic segment on WebGl2Device', async ({ page }) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 400)))
  await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )
  const r = await page.evaluate(async () => {
    const m = (await import('/e2e/_line-proof.ts')) as {
      runLineProof(): Promise<{ colored: number; total: number; glError: number }>
    }
    return m.runLineProof()
  })
  expect(errors, 'no page errors').toEqual([])
  expect(r.glError, 'no gl error').toBe(0)
  // A 40px-wide bar across a 64px canvas ≈ 2560 px footprint; require a
  // conservative floor so cap/join extension variance can't flake it.
  expect(r.colored, `colored ${r.colored}/${r.total}`).toBeGreaterThan(500)
})
