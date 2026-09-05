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
import { decideIdle, runIdleDecisionInPage } from './idle-decision'

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
  /**
   * Screenshot strategy for the final capture. Defaults to `'element'`:
   * `page.locator('#map').screenshot()`, which performs a scroll-into-view
   * + element-stability wait (bounding box identical across consecutive
   * animation frames) before capturing. That wait can hang indefinitely
   * under heavy multi-arm SwiftShader load — a raised timeout is not a fix,
   * since observed hangs outlive any budget tried (#1802).
   *
   * `'clip'` bypasses the stability wait: it reads `#map`'s bounding box
   * ONCE via `locator.boundingBox()` and captures with
   * `page.screenshot({ clip, animations: 'disabled' })` instead. This is
   * opt-in, not the default — ~100 other specs already depend on the
   * element path's exact behavior and output (CLAUDE.md §3), so only a
   * spec that has actually hit the hang should switch.
   */
  capture?: 'element' | 'clip'
}

/**
 * Diagnostic-only: log `#map`'s ancestor chain animation/transition state
 * plus the bounding box, so a future clip-capture failure names its
 * mechanism (rAF starvation vs. a running layout animation — #1802's two
 * candidate mechanisms) instead of just timing out silently. Cheap, and
 * only ever called on the failure path.
 */
async function logClipCaptureFailure(
  page: Page,
  box: { x: number; y: number; width: number; height: number } | null,
): Promise<void> {
  let ancestors: unknown
  try {
    ancestors = await page.evaluate(() => {
      const chain: Array<{
        tag: string
        id: string
        animationName: string
        animationPlayState: string
        transitionProperty: string
        transitionDuration: string
        rect: { x: number; y: number; width: number; height: number }
      }> = []
      let el: Element | null = document.getElementById('map')
      while (el) {
        const cs = getComputedStyle(el)
        const r = el.getBoundingClientRect()
        chain.push({
          tag: el.tagName,
          id: el.id,
          animationName: cs.animationName,
          animationPlayState: cs.animationPlayState,
          transitionProperty: cs.transitionProperty,
          transitionDuration: cs.transitionDuration,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        })
        el = el.parentElement
      }
      return chain
    })
  } catch (evalErr) {
    ancestors = `getComputedStyle probe itself failed: ${String(evalErr)}`
  }
  console.log(`CAPTURE_CLIP_FAIL box=${JSON.stringify(box)} ancestors=${JSON.stringify(ancestors)}`)
}

/** The pending-work kinds a settle may be scoped to — mirrors
 *  `PENDING_WORK_KINDS` (map/src/pending-work.ts:36). Spelled here rather than
 *  imported because the e2e helpers do not depend on `map`'s internals; the
 *  registry validates the names at the call, so a stale entry reds loudly. */
export type PendingWorkKindName =
  | 'glyph'
  | 'sprite'
  | 'coverage'
  | 'raster-fetch'
  | 'raster-retry'
  | 'dem-fetch'
  | 'dem-retry'
  | 'vt-fetch'
  | 'vt-replaced'
  | 'vt-upload'
  | 'vt-missed'
  | 'vt-lod'

/** Settle on the engine's pending-work registry — the SAME predicate
 *  `captureCanvas` settles on, without capturing anything.
 *
 *  Poll `_pendingWork.hasPending()` (#2149 — the engine's own "async resource
 *  work still draining" union, every kind deadline-bounded by construction)
 *  until it has been clear for five consecutive frames. A data-bearing demo
 *  keeps it true while its fetch is in flight, so this waits for the real first
 *  paint; an animated scene (which never goes idle) still settles once its
 *  registered work drains; a static demo settles in ~80ms; the bounded fallback
 *  prevents a hang. The legacy `hasPendingSourceWork()` probe is kept for
 *  pre-#2149 builds, and `_wasIdle` for builds without either — when the method
 *  was deleted (#2149 increment 6) this chain missing the registry arm made
 *  EVERY capture burn the full timeout before resolving.
 *
 *  Exported because a spec that needs only the settle should not have to take a
 *  SCREENSHOT to get it. `page.screenshot` adds a fonts-load wait, a
 *  scroll-into-view stability wait and a PNG encode on top of this, and on a
 *  loaded shard that surplus is what runs a spec out of its budget (#2366).
 *
 *  `scope` narrows the wait to specific kinds. Waiting on ALL of them is a
 *  fixed timeout on any data-heavy demo: measured on `import_maplibre_mirror`,
 *  the union never goes clear (still pending at 125 s) because `vt-upload` keeps
 *  draining slice uploads at the per-frame cap, while `glyph` alone clears in
 *  under 20 s. A spec that depends on glyph work should say so and get a real
 *  convergence instead of waiting out a budget.
 *
 *  Not interchangeable with `awaitMapIdle`: that one resolves on the map-event-bus
 *  `idle` transition (camera at rest and nothing left to draw), while this one
 *  resolves on registered WORK draining — a glyph range or a tile fetch. Wait on
 *  whichever one the assertion actually depends on. */
export async function awaitPendingWorkClear(
  page: Page,
  timeoutMs = 20_000,
  scope?: readonly PendingWorkKindName[],
): Promise<'clear' | 'timeout'> {
  const arm = (await page.evaluate(
    ([budget, kinds]: [number, readonly string[] | undefined]) => {
      return new Promise<'clear' | 'timeout'>((resolve) => {
        const m = (
          window as unknown as {
            __xgisMap?: {
              _pendingWork?: { hasPending?: (scope?: readonly string[]) => boolean }
              hasPendingSourceWork?: () => boolean
              _wasIdle?: boolean
            }
          }
        ).__xgisMap
        if (!m) {
          resolve('clear')
          return
        }
        const t0 = performance.now()
        let stable = 0
        const tick = () => {
          let settled = false
          try {
            settled =
              typeof m._pendingWork?.hasPending === 'function'
                ? m._pendingWork.hasPending(kinds) === false
                : typeof m.hasPendingSourceWork === 'function'
                  ? m.hasPendingSourceWork() === false
                  : m._wasIdle === true
          } catch {
            settled = false
          }
          stable = settled ? stable + 1 : 0
          if (stable >= 5) resolve('clear')
          else if (performance.now() - t0 > budget) resolve('timeout')
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    [timeoutMs, scope] as [number, readonly string[] | undefined],
  )) as 'clear' | 'timeout'
  if (arm === 'timeout') {
    // #2370 — SAY WHICH ARM ENDED THE WAIT. Silence here is how a fixed wait
    // passes for a convergence: `_import-glyphs-wired-gate` documented its
    // settle as "a frame is not captured while a glyph range is still in
    // flight" while the mechanism actually delivering it was this budget
    // expiring, and on `import_maplibre_mirror` the un-scoped union never goes
    // clear at all (measured: 20358 ms, every time). A caller that reads
    // `'timeout'` — or just sees this line — knows its settle is a sleep.
    console.warn(
      `[awaitPendingWorkClear] budget ${timeoutMs}ms EXPIRED with work still pending` +
        `${scope ? ` (scope: ${scope.join(', ')})` : ' (scope: all kinds)'}` +
        ' — this settle did NOT converge; it timed out (#2370).',
    )
  }
  return arm
}

/** The wait every capture shares: ready, then painted, then composed. Split out
 *  so `captureCanvas` and `captureCanvasInPage` cannot drift apart in their
 *  settle semantics — only in how they read the finished frame. */
async function settleForCapture(page: Page, opts: CaptureOptions): Promise<void> {
  const readyTimeout = opts.readyTimeoutMs ?? 20_000

  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: readyTimeout },
  )

  // Wait for the engine to actually PAINT the scene, not just for the render
  // loop to start: __xgisReady flips true when the loop starts, but URL/inline
  // source data loads ASYNC and paints a frame or two later via invalidate(),
  // so a fixed rAF count can screenshot the empty pre-data frame.
  await awaitPendingWorkClear(page, readyTimeout)

  // Two extra rAF ticks so any shader-variant pipeline created on the
  // first frame can compose into the visible swap chain on frame 2.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )

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
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())))
  }
}

/** Read the finished frame through the COMPOSITOR (`page.screenshot`).
 *
 *  Prefer `captureCanvasInPage` for a frame nothing outside the canvas needs to
 *  appear in: this path pays a fonts-load wait, a scroll-into-view stability
 *  wait and a compositor round trip, and #2242 is that round trip hanging rather
 *  than running slowly. Measured on `_demotiles-mirror-gate`'s orthographic arm
 *  in this container: 198 662 ms once, 13 026 ms on the next run, against 75 ms
 *  for the in-page readback of the same 900x500 frame.
 *
 *  It stays because it is the only path that captures what the PAGE shows —
 *  DOM overlays included — which a chrome-visibility gate genuinely needs. */
export async function captureCanvas(page: Page, opts: CaptureOptions = {}): Promise<Buffer> {
  await settleForCapture(page, opts)

  if (opts.capture === 'clip') {
    const locator = page.locator('#map')
    let box: { x: number; y: number; width: number; height: number } | null = null
    try {
      box = await locator.boundingBox()
      if (!box) throw new Error('locator.boundingBox() returned null')
      return await page.screenshot({ clip: box, animations: 'disabled' })
    } catch (err) {
      await logClipCaptureFailure(page, box)
      throw err
    }
  }

  return await page.locator('#map').screenshot()
}

/** Read the finished frame from the CANVAS ITSELF, never asking the compositor
 *  for one. Same settle as `captureCanvas`; the only difference is where the
 *  bytes come from.
 *
 *  Two properties fall out of that, and both are things the screenshot path has
 *  cost this repo:
 *
 *    * It cannot hang on the compositor. `page.screenshot` needs the page to
 *      keep producing frames, and when it stops the call log ends after
 *      "fonts loaded" and the budget is what ends the test (#2242, #1802).
 *    * It is chrome-free BY CONSTRUCTION. The canvas backing store contains no
 *      DOM, so an overlay that re-shows itself mid-capture cannot land in the
 *      measured pixels — the whole #2282 / #2284 failure mode is unreachable
 *      here rather than defended against.
 *
 *  MEASURED EQUIVALENT to the clip screenshot on `_demotiles-mirror-gate`'s
 *  orthographic arm: identical dimensions (900x500 at dpr 1), and the canvas is
 *  fully opaque there (minimum alpha 255, zero sub-255 pixels), so no
 *  compositing against the page background is needed to match. The residual
 *  pixel difference between the two paths is TEMPORAL, not a capture-path
 *  difference: two in-page readbacks two seconds apart differ by 15.7% on that
 *  still-converging scene, above the 18.3% measured between the two paths.
 *
 *  REQUIRES a readable drawing buffer. `preserveDrawingBuffer` is
 *  WebGL2-backend-only (map/src/gpu-boot.ts:47) and the demo sets it from
 *  `?e2e=1` / `?preserve=1` (playground/src/demo-runner.ts:1707). On a WebGPU
 *  page without it the read can come back blank, and a blank frame is a
 *  measurement that reads like a finding (CLAUDE.md §12) — so a caller must
 *  assert something POSITIVE about the pixels, never just that they parsed. */
export async function captureCanvasInPage(page: Page, opts: CaptureOptions = {}): Promise<Buffer> {
  await settleForCapture(page, opts)

  const dataUrl = await page.evaluate(() => {
    const canvas = document.querySelector('#map') as HTMLCanvasElement | null
    if (!canvas) throw new Error('captureCanvasInPage: no #map canvas on the page')
    return canvas.toDataURL('image/png')
  })
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
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
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
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
 * Compare two PNG buffers in the page context and return the
 * fraction of pixels that differ by more than `tolerance` per
 * channel (0-255). Used by reftest pairs where byte-equal hash
 * comparison is too strict (anti-aliasing jitter from per-pass
 * GPU state changes produces tiny pixel differences even when
 * two paths semantically render the same thing).
 *
 * Returns a value in [0, 1] — 0 means pixel-identical, 1 means
 * every pixel differs.
 */
export async function pixelDiffRatio(
  page: Page,
  pngA: Buffer,
  pngB: Buffer,
  tolerance = 12,
): Promise<number> {
  return await page.evaluate(
    async ({ a64, b64, tol }) => {
      const decode = async (b64: string) => {
        const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        return {
          data: ctx.getImageData(0, 0, bmp.width, bmp.height).data,
          w: bmp.width,
          h: bmp.height,
        }
      }
      const A = await decode(a64)
      const B = await decode(b64)
      if (A.w !== B.w || A.h !== B.h) return 1
      let differing = 0
      for (let i = 0; i < A.data.length; i += 4) {
        if (
          Math.abs(A.data[i] - B.data[i]) > tol ||
          Math.abs(A.data[i + 1] - B.data[i + 1]) > tol ||
          Math.abs(A.data[i + 2] - B.data[i + 2]) > tol
        ) {
          differing++
        }
      }
      return differing / (A.w * A.h)
    },
    { a64: pngA.toString('base64'), b64: pngB.toString('base64'), tol: tolerance },
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
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
  }, pngBuffer.toString('base64'))
}

// ─────────────────────────────────────────────────────────────────
// Pixel-matching helpers (PR: E2E speed + pixel matching toolkit)
// ─────────────────────────────────────────────────────────────────
//
// Three additions complement `toMatchSnapshot` (whole-frame match)
// and `sampleNonBackgroundPixels` (presence count) with content-
// aware assertions:
//
//   - expectPixelAt          single coordinate color check
//   - expectRegionMatch      sub-rectangle baseline diff
//   - expectColorHistogram   ratio of pixels per color bucket
//
// All three follow the existing pattern: PNG decoded in the page
// context via `createImageBitmap` + 2D canvas, no node-side image
// dependencies. The returned shapes are plain JS so callers do their
// own `expect(...)` assertions — keeps the helpers usable from any
// test framework, not just Playwright's `expect`.

/** A simple [r, g, b] tuple in 0-255 range. */
export type RGB = [number, number, number]

/**
 * Extract the RGB at a single coordinate of a screenshot.
 *
 * Returns the pixel triple so the caller can `expect(...).toEqual(...)`
 * with a tolerance of their choice. Coordinates are in canvas pixel
 * space (top-left origin).
 *
 * Use this for "the canvas at (430, 360) must be amber after the
 * heat keyframe morph completes" style assertions — the kind of
 * test that catches "everything went transparent" silent failures
 * that whole-frame baselines miss.
 */
export async function pixelAt(page: Page, pngBuffer: Buffer, x: number, y: number): Promise<RGB> {
  return await page.evaluate(
    async ({ b64, px, py }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const data = ctx.getImageData(px, py, 1, 1).data
      return [data[0], data[1], data[2]] as [number, number, number]
    },
    { b64: pngBuffer.toString('base64'), px: x, py: y },
  )
}

/**
 * Assert that the pixel at `(x, y)` matches `expected` within
 * `tolerance` per channel (0-255). Throws a descriptive error if
 * any channel differs by more than the tolerance.
 *
 * The default tolerance of 12 covers anti-aliasing noise and minor
 * MSAA resolve drift while still catching real color regressions
 * (a 12/255 tolerance ≈ 5% of dynamic range per channel).
 */
export async function expectPixelAt(
  page: Page,
  pngBuffer: Buffer,
  x: number,
  y: number,
  expected: RGB,
  tolerance = 12,
): Promise<void> {
  const actual = await pixelAt(page, pngBuffer, x, y)
  const dr = Math.abs(actual[0] - expected[0])
  const dg = Math.abs(actual[1] - expected[1])
  const db = Math.abs(actual[2] - expected[2])
  if (dr > tolerance || dg > tolerance || db > tolerance) {
    throw new Error(
      `pixel(${x},${y}): expected RGB(${expected.join(',')}) ±${tolerance}, ` +
        `got RGB(${actual.join(',')}) (Δ=${dr},${dg},${db})`,
    )
  }
}

/** Rectangular region in canvas pixel coordinates. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Extract a sub-rectangle from a screenshot and return it as a fresh
 * PNG buffer. Useful for `expect(...).toMatchSnapshot(name)` on just
 * the static portion of a canvas — e.g. to baseline a UI region
 * while the animated portion changes every frame.
 *
 * Implementation: decode → 2D canvas → re-encode via `toBlob`. All
 * happens in the page context so we don't pull a node-side PNG
 * encoder into the dev dependencies.
 */
export async function extractRegion(
  page: Page,
  pngBuffer: Buffer,
  region: Region,
): Promise<Buffer> {
  const b64Out = await page.evaluate(
    async ({ b64, r }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((rr) => rr.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = r.width
      c.height = r.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
      const outBlob: Blob = await new Promise((resolve) =>
        c.toBlob((b) => resolve(b!), 'image/png'),
      )
      const ab = await outBlob.arrayBuffer()
      // Encode to base64 inside the page context; node side decodes back.
      let s = ''
      const u8 = new Uint8Array(ab)
      for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i])
      return btoa(s)
    },
    { b64: pngBuffer.toString('base64'), r: region },
  )
  return Buffer.from(b64Out, 'base64')
}

/**
 * Convenience: extract a region and Playwright-snapshot match it
 * against a baseline PNG stored under
 * `playground/e2e/smoke.spec.ts-snapshots/<name>`. Caller passes
 * `expect(...)` from `@playwright/test` so the helper stays
 * framework-aware without importing the matcher itself.
 *
 * Use this when most of a canvas is volatile (animation, time-based
 * effects) but a known sub-region is supposed to stay static — the
 * full-screenshot baseline can't represent that, but a region
 * baseline can.
 */
export async function expectRegionMatch(
  page: Page,
  pngBuffer: Buffer,
  region: Region,
  baselineName: string,
  expectFn: (received: Buffer) => { toMatchSnapshot(name: string): void },
): Promise<void> {
  const slice = await extractRegion(page, pngBuffer, region)
  expectFn(slice).toMatchSnapshot(baselineName)
}

/**
 * Bucketed color histogram. Each bucket has a center RGB and a
 * per-channel tolerance — pixels falling within ±tolerance of the
 * center on every channel are counted into that bucket. A pixel can
 * land in multiple buckets if they overlap.
 */
export interface ColorBucket {
  /** Friendly name for assertion messages. */
  name: string
  /** Center color in 0-255 RGB. */
  rgb: RGB
  /** Per-channel ± tolerance in 0-255 units. */
  tolerance: number
}

/**
 * Compute the fraction of pixels falling into each bucket. Returns
 * a `Record<bucketName, ratio>` where ratio is in [0, 1].
 *
 * Used for content-aware assertions like "right now ≥10% of the
 * canvas is rose-colored" without needing a pixel-perfect baseline.
 * Catches regressions that the whole-frame snapshot misses (e.g.
 * tile loaded slightly differently shifts hashes but the visual
 * intent is still met) AND regressions that the snapshot catches
 * but where we want a more semantic error message.
 */
export async function colorHistogram(
  page: Page,
  pngBuffer: Buffer,
  buckets: ColorBucket[],
): Promise<Record<string, number>> {
  return await page.evaluate(
    async ({ b64, bs }) => {
      const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
      const bmp = await createImageBitmap(blob)
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      const data = ctx.getImageData(0, 0, bmp.width, bmp.height).data
      const counts: Record<string, number> = {}
      for (const b of bs) counts[b.name] = 0
      const totalPixels = bmp.width * bmp.height
      // One scan over the pixel array, test each pixel against every
      // bucket. Overlap is allowed — a single pixel can count into
      // multiple buckets.
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i],
          g = data[i + 1],
          blu = data[i + 2]
        for (const b of bs) {
          if (
            Math.abs(r - b.rgb[0]) <= b.tolerance &&
            Math.abs(g - b.rgb[1]) <= b.tolerance &&
            Math.abs(blu - b.rgb[2]) <= b.tolerance
          ) {
            counts[b.name]++
          }
        }
      }
      const ratios: Record<string, number> = {}
      for (const b of bs) ratios[b.name] = counts[b.name] / totalPixels
      return ratios
    },
    { b64: pngBuffer.toString('base64'), bs: buckets },
  )
}

/**
 * Assert that each bucket's pixel ratio is within `[min, max]` of
 * `expectedRatios`. Throws a descriptive error listing every bucket
 * that's out of range. Use the broad-tolerance version when you
 * want "approximately N% of the canvas is rose" — the actual
 * percentage drifts with viewport size + camera position, so a
 * range like [0.05, 0.30] is more robust than a point estimate.
 */
export async function expectColorHistogram(
  page: Page,
  pngBuffer: Buffer,
  buckets: ColorBucket[],
  expectedRanges: Record<string, [number, number]>,
): Promise<void> {
  const actual = await colorHistogram(page, pngBuffer, buckets)
  const failures: string[] = []
  for (const [name, [min, max]] of Object.entries(expectedRanges)) {
    const v = actual[name] ?? 0
    if (v < min || v > max) {
      failures.push(
        `  ${name}: expected ${(min * 100).toFixed(1)}-${(max * 100).toFixed(1)}%, got ${(v * 100).toFixed(1)}%`,
      )
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `color histogram out of range:\n${failures.join('\n')}\n` +
        `(full ratios: ${JSON.stringify(actual, (_, v) => (typeof v === 'number' ? Number(v.toFixed(4)) : v))})`,
    )
  }
}

// ─── Chrome-free, event-driven map capture (#2053 process fix) ───────────────
//
// `captureCanvas` screenshots the `#map` LOCATOR, which composites every
// absolutely/fixed-positioned piece of demo chrome painted over the canvas —
// the on-screen error console, the status pill, the live hash badge, the
// map-tools cluster and the demo-actions bar. Their pixels land INSIDE the
// frame a spec then measures (a cross-section scan reads the side panel as a
// "stroke run") and inside the artifact a human reads at full resolution
// (CLAUDE.md §5). Every gate that measured pixels has had to re-discover the
// hide-ids list by hand (`_demotiles-mirror-gate` carries the reference copy).
//
// `captureMapFrame` is the pit-of-success wrapper: hide the chrome once,
// then run the ordinary `captureCanvas` quiesce + shot. Additive — the ~100
// existing element-path specs keep their exact behavior (CLAUDE.md §3).

/** Demo-page chrome ids that overlap the `#map` canvas. Single authority —
 *  keep in sync ONLY here; specs must not re-declare the list. */
export const DEMO_CHROME_IDS = [
  'log-overlay',
  'status',
  'status-popover',
  'hash-badge',
  'map-tools',
  'editor-collapse-btn',
  'demo-actions',
] as const

/** Hide every demo-chrome element that is currently visible. Returns the ids
 *  actually hidden (log it — a gate's output should say what left the frame).
 *
 *  Hides through a stylesheet rule with `!important`, NOT an inline
 *  `display:none`: chrome that toggles its own inline display later undoes
 *  the inline form. The log overlay does exactly that — its `repaint()`
 *  (demo-runner.ts) writes `display:flex` on every console.warn — so the DEV
 *  owner-leak warnings (#2266) re-showed it mid-run and the recombine parity
 *  gate hashed the overlay instead of the canvas (#2284). An important author
 *  rule outranks any non-important inline declaration, whenever it is set. */
export async function hideDemoChrome(page: Page): Promise<string[]> {
  return await page.evaluate(
    (ids) => {
      const ATTR = 'data-xgis-chrome-hidden'
      if (!document.getElementById('xgis-chrome-hide')) {
        const style = document.createElement('style')
        style.id = 'xgis-chrome-hide'
        style.textContent = `[${ATTR}]{display:none!important}`
        document.head.appendChild(style)
      }
      const hidden: string[] = []
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        if (getComputedStyle(el).display !== 'none') hidden.push(id)
        el.setAttribute(ATTR, '')
      }
      return hidden
    },
    DEMO_CHROME_IDS as readonly string[] as string[],
  )
}

export interface MapFrameOptions extends CaptureOptions {
  /** Leave the demo chrome visible (screenshot-for-humans of the whole demo
   *  UI). Default false — measurement frames must be chrome-free. */
  keepChrome?: boolean
}

/** THE capture entry point for map-frame measurement in e2e specs: hides the
 *  demo chrome, then runs `captureCanvas`'s ready + quiesce + shot. Use
 *  `capture: 'clip'` when a view hits the #1802 element-stability hang
 *  (whole-globe views are a known trigger). */
export async function captureMapFrame(page: Page, opts: MapFrameOptions = {}): Promise<Buffer> {
  if (!opts.keepChrome) await hideDemoChrome(page)
  return await captureCanvas(page, opts)
}

/** Event-driven settle: resolve when the map reaches MapLibre-semantics
 *  `idle` (camera at rest AND no pending source work AND nothing left to
 *  draw — map-event-bus.ts). Prefer this over `waitForTimeout` after any
 *  programmatic camera change. Two traps this wrapper owns so specs don't:
 *  `idle` fires only on the busy→idle TRANSITION (a map that is already
 *  idle never re-fires — checked via `_wasIdle` before subscribing), and a
 *  scene that legitimately never idles (animated source, stuck upload
 *  backlog) must time out loudly rather than hang the spec.
 *
 *  The DECISION lives in `./idle-decision` so vitest can drive it with a fake
 *  clock — an end-to-end arm cannot, because this function is a `page.evaluate`
 *  and the CDP round-trip outlasts the one-tick staleness window it would have
 *  to observe (#2231). Both halves are stringified and composed into ONE
 *  expression here: `page.evaluate` evaluates a string directly, so the page
 *  needs no `eval` and there is no second copy of the logic to drift. */
export async function awaitMapIdle(page: Page, timeoutMs = 30_000): Promise<'idle' | 'timeout'> {
  // The sources are transpiled before `toString()` sees them; both functions are
  // closure-free (see idle-decision.ts's header), so the emitted text stands alone.
  const script = `(${runIdleDecisionInPage.toString()})(${decideIdle.toString()}, ${JSON.stringify(timeoutMs)})`
  return (await page.evaluate(script)) as 'idle' | 'timeout'
}
