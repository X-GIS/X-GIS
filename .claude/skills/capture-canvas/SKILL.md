---
name: capture-canvas
description: >
  MANDATORY capture + settle discipline for every playground e2e spec or
  probe that screenshots the map. Use whenever writing or editing Playwright
  code that captures a frame, measures pixels, or waits for the map to
  settle — "screenshot the map", "capture the frame", "wait for tiles",
  "settle then measure", render gates, visual probes, A/B arms. Forces
  `captureMapFrame` (chrome-free, engine-quiesced) over raw
  `locator('#map').screenshot()` / `page.screenshot()`, and map-event /
  engine-counter waits over `waitForTimeout` sleeps. Carries the
  copy-paste template and the paid-for traps (#1802 stability hang,
  idle-transition-only events, chrome pixels polluting measurements).
---

# capture-canvas — the only allowed way to capture and settle a map frame

Owner-mandated (2026-08-25): sessions kept screenshotting the raw `#map`
DOM element (demo chrome and all) and settling with ad-hoc
`waitForTimeout` sleeps, despite `captureCanvas` existing since PR B. The
cost is real and recurring: a cross-section measurement read the side
panel as a "stroke run" (#2053 session), sleeps froze mid-load frames
into "converged" measurements, and the whole-globe view hung the
element-stability wait for entire 3-minute test budgets (#1802). This
skill makes the correct path the short path.

## Hard rules

1. **Capture ONLY via `captureMapFrame`** (`e2e/helpers/visual.ts`).
   Never `page.locator('#map').screenshot()`, never `page.screenshot()`
   for a map frame. `captureMapFrame` = hide demo chrome (single
   authority: `DEMO_CHROME_IDS`) → `captureCanvas` quiesce (`__xgisReady`
   → `hasPendingSourceWork()` drained 5 consecutive frames → 2 rAF) →
   shot. Pass `{ keepChrome: true }` only for a human-facing
   whole-demo-UI screenshot, never for a frame you measure.
2. **Never `waitForTimeout` to wait for map CONTENT.** Sleeps encode a
   guess; every budget is wrong on a loaded SwiftShader runner and slow
   on a fast one. Allowed settle signals, in order of preference:
   - `captureMapFrame` itself — its quiesce IS the load/first-paint wait.
   - `awaitMapIdle(page, budget)` after any programmatic camera change
     (`setZoom`/`setBearing`/`easeTo`) — resolves on the engine's
     MapLibre-semantics `idle` (camera at rest AND no pending source work
     AND nothing left to draw), immediately if already idle. It returns
     `'idle' | 'timeout'` — **assert on the result**; a `'timeout'`
     swallowed silently is a sleep with extra steps.
   - `opts.elapsedMsAtLeast` for animation-phase captures.
   - An engine counter loop for states `idle` deliberately excludes —
     e.g. `getPendingUploadCount() === 0` (bounded, and the bound
     FAILS the spec rather than proceeding).

   A `waitForTimeout` is acceptable ONLY as a deliberate real-time gap
   between two captures of an animation, with a comment saying so.

3. **`capture: 'clip'` on views that hit the #1802 hang.** The element
   path waits for `#map` bounding-box stability and can hang past any
   budget; whole-globe/low-zoom views are a known trigger. `'clip'`
   reads the box once and clips a page screenshot. Existing element-path
   specs stay as they are (CLAUDE.md §3) — new specs that hit the hang
   switch to `'clip'`, they don't hand-roll `page.screenshot` calls.
4. **Measure the returned buffer, read frames at full resolution**
   (CLAUDE.md §5 pairs with this skill; `compare-parity-pixeldiff` /
   `tile-crop-review` own the diff/crop methods). Never re-derive the
   chrome-id list in a spec — import `DEMO_CHROME_IDS` /
   `hideDemoChrome` if a special flow needs them directly.

## Template (validated 2026-08-25 — copy, then edit)

```ts
import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

test.describe.configure({ timeout: 180_000 }) // file scope — covers fixtures (§12)

test('my gate', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/demo.html?id=<demo>&e2e=1&adaptive=0&proj=globe#9/37.5/129.35', {
    waitUntil: 'domcontentloaded',
  })

  // Load + first-paint settle and the shot, in one call. No sleeps.
  const before = await captureMapFrame(page, { readyTimeoutMs: 45_000 })

  // Programmatic camera change → EVENT-driven settle, assert it settled.
  await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { setZoom?: (z: number) => void } }).__xgisMap
    m?.setZoom?.(8.5)
  })
  expect(await awaitMapIdle(page, 30_000)).toBe('idle')
  const after = await captureMapFrame(page)

  // Frames on disk for §5 full-res human reads, passing runs included.
  writeFileSync(test.info().outputPath('before.png'), before)
  writeFileSync(test.info().outputPath('after.png'), after)

  // ... measure on the buffers (structure, not bare pixel counts — §12) ...
})
```

For a view that hangs the element capture (whole-globe z0-2, heavy
multi-arm runs): `captureMapFrame(page, { capture: 'clip' })`.

## Traps this skill exists to stop re-paying

- **Chrome pixels are measurement pixels.** The hash badge, status pill,
  log overlay, map-tools, demo-actions bar and editor collapse button
  all composite over `#map`. A row-scan "stroke run x589-603" was the
  side panel. `captureMapFrame` removes the class.
- **`idle` fires on the busy→idle TRANSITION only.** Subscribing when
  the map is already idle waits forever — `awaitMapIdle` checks the
  current idle state before subscribing so callers never learn this the
  hard way.
- **A sleep that "works" is a race that hasn't lost yet.** The fixed 4s
  settle in the oblique seam gate passed for a day, then captured a
  frame the countries layer hadn't reached (19 bright px) on a loaded
  runner. Its fix (poll content, then assert) predates this skill;
  `captureMapFrame`'s quiesce is the general form.
- **A frozen mid-load frame can look converged.** Render-on-demand can
  idle with fallback content on screen (upload backlog — #2053 defect
  2). `awaitMapIdle` inherits the engine's own pending-work signal, so
  it does not settle early; if it times out, the spec should FAIL loud,
  because the frame is not the converged frame.
