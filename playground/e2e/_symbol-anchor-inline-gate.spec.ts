import { test, expect, type Page } from '@playwright/test'

// ═══ Render-gate for user-symbol coverage of `fixture_symbol_anchor_inline` (#1557) ═══
//
// #1557's inline-data grammar (`source { type: geojson, data: {...} }`) has been render-gated
// since #481 (see inline-data.xgis + its parity gates) — this spec is the narrowed remainder:
// USER-SYMBOL render coverage. Two things that were parse-tested only
// (compiler/src/__tests__/conformance/valid/symbol.xgis — `@case valid`, no rendering) get an
// actual pixel gate here:
//
//   1. `rect` / `circle` symbol elements (#1550, compiler/src/ir/symbol-elements.ts) actually
//      produce visible glyph geometry, not just a parsed AST node.
//   2. A non-`center` `SymbolDef.anchor` (#1550, map/src/text/sdf-shape.ts `anchorGeometry`)
//      actually shifts the rendered glyph relative to the point it marks, not just the stored
//      shape descriptor.
//
// The fixture (playground/src/examples/fixture-symbol-anchor-inline.xgis) draws ONE inline point
// at (0,0) twice: `sym_dot` is a bare `circle` (default/center anchor, fill-red-500), `sym_tab`
// is a bare `rect` with `anchor: left` (fill-blue-500). Each symbol has exactly one geometry
// element, so this sidesteps a separate defect noticed while reading `scene-renderers.ts`
// (`ShapeRegistry.addShape`'s name-keyed dedup means a symbol block that mixes MULTIPLE
// elements — e.g. the conformance fixture's `path` + `rect` + `circle` all in one block — only
// ever registers the FIRST one; not this issue's scope, noted for a follow-up).
//
// FAIL-BEFORE property (what a regression on either axis looks like here):
//   - `rect`/`circle` stop lowering to path geometry (`lowerSymbol` regresses) → the
//     corresponding colour's pixel count drops to ~0 → the coverage assertions fail.
//   - `SymbolDef.anchor` stops reaching `ShapeRegistry.addUserShape` (or `anchorGeometry`
//     regresses to a no-op) → the rect glyph renders center-anchored like the dot → the two
//     centroids coincide → the shift-magnitude assertion (which has a nonzero FLOOR) fails.
//   - The anchor's sign flips → the shift assertion (which requires dx > 0, i.e. `left` moves
//     the glyph screen-RIGHT — see `sdf-shape.ts`'s `ANCHOR_SHIFT` comment, X is not the axis the
//     fragment shader flips) fails on direction instead of magnitude.
//
// Geometry, so the shift-vs-dot-radius ratio isn't arbitrary: both symbols are built from a
// unit-ish path (circle r:0.5 / rect w:1 h:1) at the SAME normalization (`pathToSegments`
// scales the longest raw extent to 1, +0.1 margin) and the SAME `size-70`, so `anchorGeometry`'s
// `left` shift (0.5 * bbox width = 1.1 normalized units) and the dot's own bbox radius
// (1.1 normalized units) are the SAME quantity through the SAME size→px scale factor — the
// shift is expected to land close to 1x the dot's own measured radius, not a fraction of it.
//
// Backend PINNED to WebGL2 (`?forcegl2=1`) and asserted via `window.__xgisActiveBackend` (a
// silent fallback cannot green this) — sibling idiom, e.g. `_1581-static-camera-render-gate`.
// Direct `gl.readPixels` (not a screenshot round-trip) so the canvas's OPAQUE clear is read as
// RGB, not alpha — no alpha-channel involved in the colour predicates below.

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    ctx?: { rhi?: { gl?: WebGL2RenderingContext } }
  }
}

const invalidate = (page: Page) =>
  page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())

/** Settle ON THE TARGET METRIC, not on frame stability: poll until BOTH glyphs' colour
 *  counts clear the assertion floor for two consecutive reads. A hash-stability settle
 *  (this file's first draft) is satisfiable by a stable EMPTY buffer — an all-zeros
 *  readback hashes identically frame after frame, so it exited before the SDF shape
 *  pipeline had painted and the counts read 0 while the compositor screenshot showed
 *  both glyphs (deterministically red in CI, a coin-flip locally). The passing sibling
 *  (`_points-gl2-gate`) polls its red-pixel floor for exactly this reason — the metric
 *  itself is the only settle criterion that cannot be satisfied by not-yet-started. */
async function settleUntilPainted(page: Page, floor = 200, timeoutMs = 60_000): Promise<Centroids> {
  const deadline = Date.now() + timeoutMs
  let last: Centroids | null = null
  let stable = 0
  while (Date.now() < deadline) {
    await invalidate(page)
    await page.waitForTimeout(150)
    const c = await measureCentroids(page)
    if (c && c.red.n > floor && c.blue.n > floor) {
      if (++stable >= 2) return c
    } else {
      stable = 0
    }
    last = c ?? last
  }
  throw new Error(
    `fixture_symbol_anchor_inline never painted both glyphs within ${timeoutMs}ms — ` +
      `last read: red ${last?.red.n ?? 'n/a'} px, blue ${last?.blue.n ?? 'n/a'} px ` +
      `(floor ${floor}). A regression in lowerSymbol's rect/circle branches or in the ` +
      `shape- reference resolution reads as one or both sides never clearing the floor.`,
  )
}

interface ColorStats {
  n: number
  cx: number
  cy: number
}

interface Centroids {
  red: ColorStats
  blue: ColorStats
}

/** Per-colour pixel count + centroid, computed IN-PAGE so only the aggregates (not the raw
 *  buffer) cross the CDP bridge. red-500 = #ef4444 (239,68,68); blue-500 = #3b82f6 (59,130,246)
 *  — tolerant "dominant channel" predicates (AA-robust), same style as `_1246`'s rose/amber. */
const measureCentroids = (page: Page): Promise<Centroids | null> =>
  page.evaluate(() => {
    const w = window as unknown as MapWin
    const gl = w.__xgisMap?.ctx?.rhi?.gl
    if (!gl) return null
    const W = gl.drawingBufferWidth
    const H = gl.drawingBufferHeight
    const buf = new Uint8Array(W * H * 4)
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
    const isRed = (r: number, g: number, b: number) => r > 170 && r - g > 90 && r - b > 90
    const isBlue = (r: number, g: number, b: number) => b > 170 && b - r > 90 && b - g > 60
    const mk = () => ({ n: 0, sx: 0, sy: 0 })
    const red = mk()
    const blue = mk()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        const r = buf[i]!,
          g = buf[i + 1]!,
          b = buf[i + 2]!
        let s: typeof red | null = null
        if (isRed(r, g, b)) s = red
        else if (isBlue(r, g, b)) s = blue
        if (!s) continue
        s.n++
        s.sx += x
        s.sy += y
      }
    }
    const finish = (s: typeof red): ColorStats => ({
      n: s.n,
      cx: s.n ? s.sx / s.n : 0,
      cy: s.n ? s.sy / s.n : 0,
    })
    return { red: finish(red), blue: finish(blue) }
  })

test.describe.configure({ timeout: 90_000 })

test('#1557 user-symbol render coverage: rect/circle glyphs render, `anchor: left` shifts the rect glyph off the point', async ({
  page,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto(
    '/demo.html?id=fixture_symbol_anchor_inline&forcegl2=1&e2e=1&adaptive=0&preserve=1',
    {
      waitUntil: 'domcontentloaded',
    },
  )
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 30_000,
  })
  // Backend PIN, asserted next to the pixel work — a silent WebGPU/CPU fallback must not be
  // able to green this (CLAUDE.md §5).
  expect(await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend)).toBe(
    'webgl2',
  )

  const c = await settleUntilPainted(page)

  // §5 — persist the settled frame so the verdict below can be image-inspected at full
  // resolution, not judged from a scalar.
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('settled.png') })

  // Non-vacuous floor: both glyphs must actually have painted their colour. A regression in
  // `lowerSymbol`'s `rect`/`circle` branches (or in the `shape-` reference resolving to the
  // built-in fallback instead of the user symbol) reads as one side collapsing to ~0.
  expect(c.red.n, `circle glyph (sym_dot, red-500) painted only ${c.red.n} px`).toBeGreaterThan(200)
  expect(c.blue.n, `rect glyph (sym_tab, blue-500) painted only ${c.blue.n} px`).toBeGreaterThan(
    200,
  )

  // The dot's own measured radius is the yardstick — self-referential, no absolute pixel
  // positions or golden image (CLAUDE.md §5). Derived from area (πr² = n) rather than the
  // colour-threshold bbox, which is noisier at the AA edge.
  const dotRadius = Math.sqrt(c.red.n / Math.PI)
  const dx = c.blue.cx - c.red.cx
  const dy = c.blue.cy - c.red.cy

  console.log(
    `[symbol-anchor-inline] red n=${c.red.n} centroid=(${c.red.cx.toFixed(1)},${c.red.cy.toFixed(1)}) ` +
      `blue n=${c.blue.n} centroid=(${c.blue.cx.toFixed(1)},${c.blue.cy.toFixed(1)}) ` +
      `dotRadius=${dotRadius.toFixed(1)} dx=${dx.toFixed(1)} dy=${dy.toFixed(1)}`,
  )

  // DIRECTION: `anchor: left` shifts the rect glyph's bbox so its LEFT edge sits at the point
  // — the box extends to screen-RIGHT of it (+X; sdf-shape.ts's ANCHOR_SHIFT comment: X is not
  // the axis the fragment shader flips, so path-space +X is screen +X unchanged). If the anchor
  // were ignored, dx would sit at ~0; if the sign were backwards, dx would be negative.
  const shiftMsg =
    `rect glyph centroid did not shift right of the dot's (dx=${dx.toFixed(1)}px, ` +
    `dotRadius=${dotRadius.toFixed(1)}px) — anchor: left is not moving the glyph`
  expect(dx, shiftMsg).toBeGreaterThan(0.3 * dotRadius)
  // MAGNITUDE band: geometry (see header) puts the expected shift close to 1x the dot's own
  // radius. Generous band (not a point estimate) — it only needs to rule out "no shift" (floor
  // above) and "wildly implausible" (e.g. a whole-canvas jump from measuring the wrong glyph).
  const farMsg = `rect glyph shifted implausibly far (dx=${dx.toFixed(1)}px vs dotRadius=${dotRadius.toFixed(1)}px)`
  expect(dx, farMsg).toBeLessThan(3 * dotRadius)

  // `anchor: left` touches only the X axis (ANCHOR_SHIFT.left = [0.5, 0]) — Y should stay near
  // the dot's, not drift by anything close to the X shift.
  expect(
    Math.abs(dy),
    `rect glyph drifted vertically (dy=${dy.toFixed(1)}px) — anchor: left should be X-only`,
  ).toBeLessThan(Math.max(0.6 * dotRadius, 8))

  expect(errors, 'no page errors').toEqual([])
})
