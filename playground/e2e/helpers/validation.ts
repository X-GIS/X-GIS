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
    const m = (
      window as unknown as {
        __xgisMap?: { ctx?: { _validationErrors?: CapturedValidationError[] } }
      }
    ).__xgisMap
    return [...(m?.ctx?._validationErrors ?? [])]
  })
}

/**
 * Reset the validation error queue. Call at the start of each test
 * so per-test assertions only see errors fired during THIS test.
 */
export async function clearValidationErrors(page: Page): Promise<void> {
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { ctx?: { _validationErrors?: CapturedValidationError[] } }
      }
    ).__xgisMap
    if (m?.ctx?._validationErrors) m.ctx._validationErrors.length = 0
  })
}

/**
 * A drain point a multi-navigation body must take BEFORE each
 * `page.goto`: it moves the current realm's queue into the
 * wrapper's accumulator and resets it, so those errors survive the
 * navigation that destroys the realm holding them.
 */
export type ValidationCheckpoint = () => Promise<void>

/**
 * Wrap a test body so that any WebGPU validation error fired
 * during the body causes the wrapper to throw. Used by the
 * fixture / interaction / reftest specs to make the validation
 * queue an ENFORCED contract (not just a logged one).
 *
 * Usage — one navigation, the argument is simply ignored:
 *   test('fixture: point', async ({ page }) => {
 *     await withValidationCapture(page, async () => {
 *       await page.goto('/demo.html?id=fixture_point', ...)
 *       // ... the rest of the test ...
 *     })
 *   })
 *
 * Usage — the body navigates more than once:
 *   await withValidationCapture(page, async (checkpoint) => {
 *     await checkpoint()          // nothing to drain yet: no map
 *     await page.goto('/demo.html?id=A', ...)
 *     // ... assert on A ...
 *     await checkpoint()          // drains A's queue before it dies
 *     await page.goto('/demo.html?id=B', ...)
 *   })
 *
 * WHY the checkpoint exists (#2352). `getValidationErrors` is a
 * `page.evaluate`, so it can only ever read the queue of the JS
 * realm that is live RIGHT NOW. A cross-document navigation inside
 * the body installs a fresh realm and takes the previous one's
 * queue with it, unread — so a single read after the body could
 * only ever cover the LAST realm. `reftest.spec.ts` validated the
 * second of the two fixtures it exists to compare and was blind to
 * the first; `_inline-match-virt.spec.ts` covered one route of
 * three.
 *
 * If validation errors fire INSIDE `fn`, the helper aggregates
 * every checkpointed realm plus the final one into a single
 * multi-line error message, so the failure report shows every
 * validation failure, not just the first.
 */
export async function withValidationCapture<T>(
  page: Page,
  fn: (checkpoint: ValidationCheckpoint) => Promise<T>,
): Promise<T> {
  // Errors drained from realms the body has already left behind.
  const seen: CapturedValidationError[] = []

  // Documents (i.e. realms) installed while the body runs.
  // `domcontentloaded` is a page-level event — Playwright emits it
  // for the MAIN frame only — and it fires exactly once per parsed
  // document, which is precisely the event that replaces the realm
  // this helper reads.
  //
  // Deliberately NOT `framenavigated`: that fires for SAME-document
  // navigations too, and the demo runner performs several of those
  // per load — `loadDemo` normalises the URL with
  // `history.replaceState(?id=…)` and `startHashSync`'s rAF tick
  // writes the camera pose back at up to 5 Hz
  // (playground/src/demo-runner.ts). Counting those would trip the
  // guard below on every single-navigation caller, on a page that
  // never lost a realm.
  let documents = 0
  let checkpoints = 0
  let checkpointsSinceLastDocument = 0
  let unreadRealms = 0

  const onDocument = (): void => {
    documents++
    // The body owns the FIRST navigation: before it there is no map
    // and no queue, so nothing can be lost. Every LATER document
    // destroys a realm, and destroying one that was never drained is
    // exactly the silent false negative this guards.
    if (documents > 1 && checkpointsSinceLastDocument === 0) unreadRealms++
    checkpointsSinceLastDocument = 0
  }
  page.on('domcontentloaded', onDocument)

  const checkpoint: ValidationCheckpoint = async () => {
    seen.push(...(await getValidationErrors(page)))
    await clearValidationErrors(page)
    checkpoints++
    checkpointsSinceLastDocument++
  }

  let result: T
  try {
    result = await fn(checkpoint)
  } finally {
    page.off('domcontentloaded', onDocument)
  }

  // A realm died unread, so the assertion below covers only part of
  // the run. Fail loudly rather than report "no validation errors"
  // about queues nobody ever looked at.
  if (unreadRealms > 0) {
    throw new Error(
      `withValidationCapture: the body navigated ${documents} time(s) but took ` +
        `${checkpoints} checkpoint(s) — validation errors from ${unreadRealms} realm(s) ` +
        `were discarded unread. Call checkpoint() before each page.goto so the queue of ` +
        `the realm being replaced is drained first (#2352).`,
    )
  }

  // Drain the surviving realm and assert the union is empty.
  const errors = [...seen, ...(await getValidationErrors(page))]
  if (errors.length > 0) {
    const lines = errors.map((e, i) => `  [${i}] ${e.message}`)
    throw new Error(
      `WebGPU validation errors fired during test (${errors.length}):\n${lines.join('\n')}`,
    )
  }
  return result
}
