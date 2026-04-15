// ═══ WebGPU validation capture helper ═══
//
// Subscribes to the per-context validation error queue installed
// by `runtime/src/engine/gpu.ts initGPU()` and exposes a
// test-friendly wrapper that fails the test when ANY validation
// error fires during the wrapped body.
//
// The queue lives on the live XGISMap instance (exposed by the
// playground demo runner via `window.__xgisMap`). Tests interact
// via this helper rather than touching `__xgisMap` directly so
// the page-context API stays in one place.
//
// Coverage:
//   - Bind group missing or wrong index
//   - Bind group layout mismatch with pipeline
//   - Buffer / texture size mismatch
//   - Vertex buffer slot mismatch
//   - WGSL compile errors at pipeline creation
//   - Blend / depth / stencil state mismatches
//
// What it doesn't catch:
//   - Logical errors that produce wrong pixels (use pixel asserts
//     for that — see expectPixelAt / expectColorHistogram in
//     visual.ts)
//   - Validation errors that fire BEFORE the test calls this
//     helper (use clearValidationErrors() at test start to reset)

import type { Page } from '@playwright/test'

export interface CapturedValidationError {
  message: string
  t: number
}

/**
 * Drain the validation error queue from the live XGISMap context
 * in the page. Returns a snapshot of the array; the helper does
 * NOT clear the queue (use `clearValidationErrors` for that).
 */
export async function getValidationErrors(page: Page): Promise<CapturedValidationError[]> {
  return await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { ctx?: { _validationErrors?: CapturedValidationError[] } } }).__xgisMap
    return [...(m?.ctx?._validationErrors ?? [])]
  })
}

/**
 * Reset the validation error queue. Call at the start of each test
 * so per-test assertions only see errors fired during THIS test.
 */
export async function clearValidationErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { ctx?: { _validationErrors?: CapturedValidationError[] } } }).__xgisMap
    if (m?.ctx?._validationErrors) m.ctx._validationErrors.length = 0
  })
}

/**
 * Wrap a test body so that any WebGPU validation error fired
 * during the body causes the wrapper to throw. Used by the
 * fixture / interaction / reftest specs to make the validation
 * queue an ENFORCED contract (not just a logged one).
 *
 * Usage:
 *   test('fixture: point', async ({ page }) => {
 *     await withValidationCapture(page, async () => {
 *       await page.goto('/demo.html?id=fixture_point', ...)
 *       // ... the rest of the test ...
 *     })
 *   })
 *
 * If validation errors fire INSIDE `fn`, the helper aggregates
 * them into a single multi-line error message so the failure
 * report shows every validation failure, not just the first.
 */
export async function withValidationCapture<T>(
  page: Page,
  fn: () => Promise<T>,
): Promise<T> {
  // Wait until __xgisMap is on window before clearing — otherwise
  // we'd reset a missing queue and then the new map's queue would
  // start fresh anyway, but it's cleaner to ensure the queue
  // exists before wrapping.
  // (The page.goto inside `fn` is what installs __xgisMap, so we
  // can't clear here unconditionally — fn is responsible for the
  // initial nav. We poll-clear right after fn establishes the
  // context, then re-check at end.)
  const result = await fn()

  // Drain the queue and assert empty.
  const errors = await getValidationErrors(page)
  if (errors.length > 0) {
    const lines = errors.map((e, i) => `  [${i}] ${e.message}`)
    throw new Error(
      `WebGPU validation errors fired during test (${errors.length}):\n${lines.join('\n')}`,
    )
  }
  return result
}
