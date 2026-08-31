// #2117 line-gradient — REAL-GPU acceptance gate (CLAUDE.md §5), WebGL2 / SwiftShader.
//
// The whole chain in one readback: converter → `stroke-gradient-[…]` binding → IR
// StrokeValue.gradientStops → LineLayer uniform ramp lane → fs_line's
// `arc_pos / line_length` sample. A unit test can see every hop EXCEPT the last one.
//
// STRUCTURE, not a pixel count (#1221's lesson — a count passes on a broken image):
//   1. the graded line's LEFT end is the authored start colour and its RIGHT end the
//      authored end colour (ends, not "some blue somewhere");
//   2. red rises and blue falls MONOTONICALLY across the span (a repeated / reset ramp,
//      a per-segment progress, or a reversed ramp all break monotonicity while leaving
//      the end colours intact);
//   3. NO pixel of the graded line is the base colour — the ramp REPLACES the solid
//      stroke rather than blending with it;
//   4. the CONTROL line, same base colour and width with no ramp, is FLAT green end to
//      end — the ramp lane cannot leak into a layer that never authored one.
//
// The base stroke is GREEN, neither ramp endpoint, so "ramp dropped" and "ramp drawn"
// differ in hue, not in shade.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = join(dirname(fileURLToPath(import.meta.url)), '__line-gradient-gl2__')

// FILE scope, not the test body (CLAUDE.md §12): a body-scoped budget governs the body
// only, so a loaded SwiftShader runner times out in FIXTURE SETUP on the config default.
test.describe.configure({ timeout: 240_000 })

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    getCamera?: () => { centerX: number; centerY: number; zoom: number }
    ctx?: { rhi?: { backend?: string } }
    getTileLoadDiagnostic?: () => Record<string, { catalogLoading: number; uploadQueued: number }>
  }
}

/** One horizontal stroke band: its row, and the stroke colour sampled at N columns. */
type Band = { row: number; x0: number; x1: number; samples: [number, number, number][] }

test('#2117 line-gradient renders the authored ramp on WebGl2Device (?forcegl2=1)', async ({
  page,
}) => {
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1000, height: 700 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.goto('/demo.html?id=fixture_line_gradient&forcegl2=1&e2e=1', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 60_000,
  })

  // Pin the camera: zoom 2 centred on the fixture's lon 45 / lat 12. Load-bearing, not
  // cosmetic — ["line-progress"] is normalised over the TILE-CLIPPED chain, so the scene
  // must render at a zoom where both lines stay inside the one tile spanning lon 0..90
  // (see the fixture header). An auto-fit camera also drifts with viewport size, which
  // would let a layout change masquerade as a ramp change.
  await page.evaluate(() => {
    const m = (window as unknown as Win).__xgisMap!
    const R = 6378137
    const RAD = Math.PI / 180
    const c = m.getCamera!()
    c.zoom = 2
    c.centerX = 45 * RAD * R
    c.centerY = Math.log(Math.tan(Math.PI / 4 + (12 * RAD) / 2)) * R
    m.markCameraPositioned!()
    m.invalidate?.()
  })

  /** Find the two stroke bands and sample each across its span. */
  const readBands = () =>
    page.evaluate(async () => {
      const w = window as unknown as Win
      w.__xgisMap?.invalidate?.()
      // The demo page carries several canvases (UI overlays); the map's is the first
      // one, and `#map canvas` is a belt-and-braces lookup for a future DOM change.
      const all = Array.from(document.querySelectorAll('canvas')) as HTMLCanvasElement[]
      const cv = (document.querySelector('#map canvas') as HTMLCanvasElement | null) ?? all[0]
      if (!cv) return { ok: false as const, why: 'no canvas' }
      const c = document.createElement('canvas')
      c.width = cv.width
      c.height = cv.height
      const ctx = c.getContext('2d')!
      ctx.drawImage(cv, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
      const at = (x: number, y: number): [number, number, number, number] => {
        const i = (y * c.width + x) * 4
        return [d[i]!, d[i + 1]!, d[i + 2]!, d[i + 3]!]
      }
      // A stroke pixel: opaque and clearly not the (dark / empty) background.
      const isStroke = (p: [number, number, number, number]) =>
        p[3] > 200 && Math.max(p[0], p[1], p[2]) > 90

      // Rows carrying a long contiguous stroke run — the two horizontal lines.
      const rows: { row: number; x0: number; x1: number; len: number }[] = []
      for (let y = 0; y < c.height; y++) {
        let run = 0
        let best = { len: 0, x0: 0, x1: 0 }
        for (let x = 0; x < c.width; x++) {
          if (isStroke(at(x, y))) {
            run++
            if (run > best.len) best = { len: run, x0: x - run + 1, x1: x }
          } else run = 0
        }
        if (best.len > c.width * 0.5) rows.push({ row: y, ...best })
      }
      if (rows.length === 0) return { ok: false as const, why: 'no stroke band row' }

      // Group contiguous rows into bands; take each band's centre row.
      const groups: (typeof rows)[] = []
      for (const r of rows) {
        const g = groups[groups.length - 1]
        if (g && r.row - g[g.length - 1]!.row <= 2) g.push(r)
        else groups.push([r])
      }
      const N = 21
      const bands = groups.map((g) => {
        const mid = g[Math.floor(g.length / 2)]!
        // Inset 4 px from each end so cap antialiasing never colours a sample.
        const x0 = mid.x0 + 4
        const x1 = mid.x1 - 4
        const samples: [number, number, number][] = []
        for (let k = 0; k < N; k++) {
          const x = Math.round(x0 + ((x1 - x0) * k) / (N - 1))
          const p = at(x, mid.row)
          samples.push([p[0], p[1], p[2]])
        }
        return { row: mid.row, x0, x1, samples }
      })
      return {
        ok: true as const,
        marker: w.__xgisActiveBackend,
        backend: w.__xgisMap?.ctx?.rhi?.backend,
        bands,
      }
    })

  // Poll until both bands are on screen — SwiftShader tile upload timing varies a lot
  // under parallel load, so this waits on the CONTENT, never on a fixed sleep.
  let r = await readBands()
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline && !(r.ok && r.bands.length >= 2)) {
    await page.waitForTimeout(2_000)
    r = await readBands()
  }
  writeFileSync(join(OUT, 'frame.png'), await page.locator('#map').screenshot())

  expect(r.ok, `canvas readback: ${'why' in r ? r.why : ''}`).toBe(true)
  if (!r.ok) return
  expect(r.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(r.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(errors, 'no page/console errors').toEqual([])
  expect(r.bands.length, `expected 2 stroke bands, got ${r.bands.length}`).toBe(2)

  // Upper band (smaller row) = the fixture's lat 20 line = GRADED; lower = lat 5 control.
  const [graded, control] = (r.bands as Band[]).sort((a, b) => a.row - b.row)
  const fmt = (b: Band) => b.samples.map((s) => s.join(',')).join(' | ')
  console.log(`GRADED  row=${graded!.row} x=${graded!.x0}..${graded!.x1}\n  ${fmt(graded!)}`)
  console.log(`CONTROL row=${control!.row} x=${control!.x0}..${control!.x1}\n  ${fmt(control!)}`)

  const g = graded!.samples
  const first = g[0]!
  const last = g[g.length - 1]!

  // 1. The authored END COLOURS land at the line's ENDS.
  expect(first[2], `left end is the authored blue: ${first}`).toBeGreaterThan(150)
  expect(first[0], `left end carries no red: ${first}`).toBeLessThan(60)
  expect(last[0], `right end is the authored red: ${last}`).toBeGreaterThan(150)
  expect(last[2], `right end carries no blue: ${last}`).toBeLessThan(60)

  // 2. MONOTONE blend between. A repeated / reset / per-segment ramp breaks this while
  //    leaving both ends correct, which is exactly the failure a two-point check misses.
  //    Tolerance 8/255 absorbs SwiftShader's 8-bit rounding without admitting a reset.
  for (let i = 1; i < g.length; i++) {
    expect(g[i]![0], `red must not fall at sample ${i}: ${fmt(graded!)}`).toBeGreaterThan(
      g[i - 1]![0] - 8,
    )
    expect(g[i]![2], `blue must not rise at sample ${i}: ${fmt(graded!)}`).toBeLessThan(
      g[i - 1]![2] + 8,
    )
  }
  // …and it must actually TRAVERSE, not sit flat at one end.
  expect(last[0] - first[0], 'red must climb across the span').toBeGreaterThan(150)
  expect(first[2] - last[2], 'blue must fall across the span').toBeGreaterThan(150)

  // 3. The ramp REPLACES the base colour — no green survives on the graded line.
  for (const s of g) {
    expect(s[1], `base green leaked into the ramp: ${s}`).toBeLessThan(90)
  }

  // 4. The control line never authored a ramp: flat base green, end to end.
  for (const s of control!.samples) {
    expect(s[1], `control line is base green: ${s}`).toBeGreaterThan(150)
    expect(Math.max(s[0], s[2]), `control line carries no ramp colour: ${s}`).toBeLessThan(90)
  }
})
