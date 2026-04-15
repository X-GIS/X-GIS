// ═══ Visual regression helpers (PR B) ═══
//
// Wraps Playwright's `locator.screenshot()` with the deterministic
// quiescing X-GIS needs before the canvas content is stable:
//
//   1. Wait for `__xgisReady` (renderer init + first frame done)
//   2. Wait for two more rAF callbacks so any late-loaded tile or
//      shader-variant pipeline has had a chance to compose into the
//      visible canvas
//   3. Optional `elapsedMsAtLeast`: spin until `map._elapsedMs` has
//      grown past a threshold. Used by animation tests so a baseline
//      taken at t≈3000ms catches mid-cycle freezes that t=0 would
//      miss (this is exactly the shape of Bug 1 — animation that
//      cycled once then stopped).
//
// Returns the screenshot buffer; the caller decides whether to
// `expect(...).toMatchSnapshot(...)` or do its own pixel analysis.

import type { Page } from '@playwright/test'

export interface CaptureOptions {
  /**
   * Skip the screenshot until `map._elapsedMs >= this value`.
   * Useful for animation regression tests that need to observe a
   * specific point in the animation cycle.
   */
  elapsedMsAtLeast?: number
  /**
   * Per-test timeout for waiting on `__xgisReady`. The smoke harness
   * default is 15s — visual baselines pay extra in cold-start cases
   * so 20s is a safer cap.
   */
  readyTimeoutMs?: number
}

/**
 * Wait for a demo to be fully composed, then return the canvas
 * screenshot as a Buffer. Centralizes the rAF + quiescence sequence
 * so every visual test gets the same wait semantics — no flakes from
 * "screenshot fired one frame too early".
 */
export async function captureCanvas(
  page: Page,
  opts: CaptureOptions = {},
): Promise<Buffer> {
  const readyTimeout = opts.readyTimeoutMs ?? 20_000

  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: readyTimeout },
  )

  // Two extra rAF ticks so any shader-variant pipeline created on the
  // first frame can compose into the visible swap chain on frame 2.
  await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r()))))

  if (opts.elapsedMsAtLeast !== undefined) {
    const target = opts.elapsedMsAtLeast
    await page.waitForFunction(
      (t) => {
        const m = (window as unknown as { __xgisMap?: { _elapsedMs?: number } }).__xgisMap
        return m !== undefined && m._elapsedMs !== undefined && m._elapsedMs >= t
      },
      target,
      { timeout: 30_000 },
    )
    // One more rAF after the elapsed threshold so the frame at t≈target
    // is actually composed.
    await page.evaluate(() => new Promise<void>(r => requestAnimationFrame(() => r())))
  }

  return await page.locator('#map').screenshot()
}

/**
 * Sample N evenly-spaced pixels from a screenshot and return how
 * many of them differ from the expected "background" color by more
 * than `tolerance` (0-255 per channel). Used by the SDF point
 * regression test: a points demo MUST have at least one non-background
 * sample, otherwise the points didn't render (Bug 2's exact symptom).
 *
 * Uses pure JS PNG decoding via the Page context to avoid pulling
 * in a node-side image library. We pass the screenshot buffer into
 * the page, decode in a 2D canvas, and read pixel data there.
 */
export async function sampleNonBackgroundPixels(
  page: Page,
  pngBuffer: Buffer,
  background: { r: number; g: number; b: number },
  tolerance = 30,
  sampleCount = 40,
): Promise<number> {
  return await page.evaluate(
    async ({ b64, bg, tol, count }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then(r => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const stepX = Math.floor(bmp.width / Math.sqrt(count))
      const stepY = Math.floor(bmp.height / Math.sqrt(count))
      let differing = 0
      for (let y = stepY; y < bmp.height; y += stepY) {
        for (let x = stepX; x < bmp.width; x += stepX) {
          const px = ctx.getImageData(x, y, 1, 1).data
          const dr = Math.abs(px[0] - bg.r)
          const dg = Math.abs(px[1] - bg.g)
          const db = Math.abs(px[2] - bg.b)
          if (dr > tol || dg > tol || db > tol) differing++
        }
      }
      return differing
    },
    { b64: pngBuffer.toString('base64'), bg: background, tol: tolerance, count: sampleCount },
  )
}

/**
 * Hash a screenshot buffer to a short hex string. Used to assert
 * that two captures (e.g. animation @ t=0 vs t=3000ms) produced
 * DIFFERENT frames — proof that the animation is still cycling.
 */
export async function hashScreenshot(page: Page, pngBuffer: Buffer): Promise<string> {
  return await page.evaluate(async (b64) => {
    const bin = atob(b64)
    const arr = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
    const digest = await crypto.subtle.digest('SHA-256', arr)
    return Array.from(new Uint8Array(digest))
      .slice(0, 12)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  }, pngBuffer.toString('base64'))
}
