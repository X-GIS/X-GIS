// `?debug=overdraw` is a whole-frame mode, gated behind `isOverdrawActive(caps)`
// at every draw-layer site (#1594). On an immediate device (WebGL2) the mode
// cannot run at all — its compose is raw WebGPU — so the CORRECT behaviour is
// a graceful no-op: the flagged render must be the SAME ordinary map as the
// unflagged one. Before #1594, 19 draw-layer sites read the raw URL flag
// directly and skipped/substituted themselves regardless of the device,
// producing a BROKEN partial render (strokes / fill patterns / the graticule
// missing) instead of either a working heatmap or a clean ordinary map.
//
// The previous version of this spec asserted `nonBlack > 0` — satisfied by
// ANY rendered map, including the broken partial one, so it could not tell
// "heatmap live" from "silently disabled" apart. This version has two parts:
//
// 1) WHOLE-FRAME no-op (PRESETS loop below): an OFF-vs-ON differential across
//    a page reload (the flag is page-load-only, debug-flags.ts, so an in-page
//    toggle isn't available) — a stride-sampled pixel signature per load
//    (cheap across the CDP bridge — never the full buffer), diffed with a
//    tolerance. Deliberately content WITHOUT the graticule: two independent
//    page loads do not guarantee pixel-exact determinism the way a same-page
//    state toggle does (fresh camera-settle convergence, fresh tile decode
//    per load), and thin cross-cutting lines (a world-zoom graticule grid)
//    turned out to amplify that into edge-pixel noise the tolerance couldn't
//    absorb even though the two frames were visually identical on inspection
//    — a real lesson (CLAUDE.md §5: read the image, don't trust the scalar
//    alone) that moved the graticule check to part 2 instead of loosening the
//    tolerance until it stopped meaning anything.
//
// 2) The graticule fix specifically (dedicated test below), using the SAME
//    in-page OFF-vs-ON toggle technique `_graticule-gl2-gate.spec.ts`
//    established: one page load (with `?debug=overdraw` already active,
//    proving the fix survives it), then `setGraticuleEnabled` toggled at
//    runtime — same page, same settled frame lineage, no cross-load noise.
//    This directly targets renderer.ts:933/984 (the raw flag used to
//    short-circuit ABOVE the graticule's own immediate-arm fork).
//
// Part 1 asserts the webgl2 no-op only — `load()` hardcodes `&forcegl2=1` on
// every page load (this sandbox has no WebGPU adapter to fall back to; see
// CLAUDE.md §5), so `flagged.backend` is unconditionally `'webgl2'` here, not
// just in this sandbox. Proving the OTHER half of the contract — that the
// heatmap genuinely replaces the scene on a deferred backend — needs a
// separate spec that does NOT force the backend, run somewhere WebGPU is
// actually available; this file does not attempt it.
//
// v1 coverage: background, vector-tile fills, SDF strokes (line-renderer.ts:628
// — the "every stroke disappears" site), the graticule (part 2). `categorical`
// (local countries.geojson fills + stroked borders, no raster layer; the
// sandbox has no route to external tile servers, so a PMTiles/protomaps demo
// — or any demo with a raster basemap, whose fetch retries at low zoom stall
// the whole page — isn't usable here) has no fill-pattern / extruded /
// fallback-tile content, so this spec does
// not exercise those vector-tile-renderer.ts sites specifically — they share
// the same `isOverdrawActive(this.rhi.caps)` call as the fills this spec DOES
// cover, and the confinement ratchet (debug-overdraw-confinement.test.ts)
// proves structurally that no site anywhere still reads the raw flag.
// v1 gaps (unchanged from the original spec, documented for Phase 2):
// text/halo, SDF points, raster tiles — those renderers skip themselves in
// debug mode rather than crash the pass with a format mismatch.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__overdraw-inspector__')
mkdirSync(OUT, { recursive: true })

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __ovBaseline?: number[]
  __xgisMap?: {
    invalidate?: () => void
    setGraticuleEnabled?: (on: boolean) => void
    ctx?: {
      rhi?: { backend?: string; gl?: WebGL2RenderingContext }
      _validationErrors?: { message: string }[]
    }
  }
}

interface Preset {
  id: string // demo id
  name: string // file slug
  hash: string // #z/lat/lon[/bearing/pitch]
}

// `categorical` (local countries.geojson, per-feature fills + stroked
// borders, no raster layer) rather than a PMTiles/protomaps demo or a demo
// with a raster basemap: this sandbox has no route to external tile servers,
// and a raster layer's fetch retries at world-zoom (many tiles in view) were
// observed to stall the page well past a 90s test timeout even though the
// errors themselves are filtered — a resource-exhaustion problem, not a
// GPU/render one. `categorical`'s content is entirely local at every zoom.
const PRESETS: Preset[] = [
  { id: 'categorical', name: 'world', hash: '#1.5/20/0' },
  // Zoomed on a landmass — exercises line-renderer.ts:628 (the direct
  // "every SDF stroke disappears" site) at a scale where strokes cover a
  // meaningful fraction of the sampled points.
  { id: 'categorical', name: 'zoomed', hash: '#4/40/-30' },
]

// Prime stride: samples ~1/97th of pixels, avoiding periodic aliasing with
// tile/grid boundaries. Returns a SMALL array across the CDP bridge (a few
// thousand numbers for an 800x600 frame) instead of the full 1.92M-element
// buffer — the convention `_graticule-gl2-gate.spec.ts` documents and follows.
const SAMPLE_STRIDE = 97
const DIFF_CHANNEL_TOLERANCE = 12

for (const preset of PRESETS) {
  test(`overdraw inspector: ${preset.name} (?forcegl2=1)`, async ({ page }) => {
    test.setTimeout(90_000)
    await page.setViewportSize({ width: 800, height: 600 })

    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (t.includes('vite/dist/client')) return
      if (t.includes('Failed to load resource')) return
      errors.push(t)
    })

    const load = async (withOverdraw: boolean) => {
      const flag = withOverdraw ? '&debug=overdraw' : ''
      await page.goto(`/demo.html?id=${preset.id}&forcegl2=1&e2e=1${flag}${preset.hash}`, {
        waitUntil: 'domcontentloaded',
      })
      await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
        timeout: 30_000,
      })
      await page.waitForTimeout(4_000)
    }

    const readFrame = () =>
      page.evaluate((stride) => {
        const w = window as unknown as MapWin
        const ctx = w.__xgisMap?.ctx
        const gl = ctx?.rhi?.gl
        if (!gl) return { ok: false as const }
        const W = gl.drawingBufferWidth
        const H = gl.drawingBufferHeight
        const buf = new Uint8Array(W * H * 4)
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
        const sample: number[] = []
        for (let p = 0; p < W * H; p += stride) {
          const i = p * 4
          sample.push(buf[i]!, buf[i + 1]!, buf[i + 2]!)
        }
        return {
          ok: true as const,
          backend: ctx?.rhi?.backend,
          marker: w.__xgisActiveBackend,
          validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
          glError: gl.getError(),
          w: W,
          h: H,
          sample,
        }
      }, SAMPLE_STRIDE)

    // 1) Baseline — no overdraw flag.
    await load(false)
    const baseline = await readFrame()
    expect(baseline.ok, 'forced-WebGL2 context present (baseline load)').toBe(true)
    if (!baseline.ok) return
    expect(baseline.marker, 'window.__xgisActiveBackend').toBe('webgl2')
    expect(baseline.backend, 'host.ctx.rhi.backend').toBe('webgl2')

    const pngOff = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `${preset.name}-off.png`), pngOff)

    // 2) Reload with ?debug=overdraw active, same camera.
    await load(true)
    const flagged = await readFrame()
    expect(flagged.ok, 'forced-WebGL2 context present (flagged load)').toBe(true)
    if (!flagged.ok) return
    expect(flagged.glError, 'no gl error').toBe(0)
    expect(flagged.validation, 'no validation errors').toEqual([])
    // GPU validation / console errors are catastrophic — any pipeline format
    // mismatch shows up as a [X-GIS frame-validation] console.error. Fail
    // loudly so a debug-mode regression doesn't get masked by the diff check.
    expect(
      errors,
      `GPU validation / console errors across both loads:\n${errors.join('\n')}`,
    ).toEqual([])

    const pngOn = await page.locator('#map').screenshot()
    writeFileSync(join(OUT, `${preset.name}-on.png`), pngOn)

    // 3) Diff the two stride-sampled signatures.
    expect(flagged.w).toBe(baseline.w)
    expect(flagged.h).toBe(baseline.h)
    const n = Math.min(baseline.sample.length, flagged.sample.length)
    let diffPoints = 0
    for (let i = 0; i < n; i += 3) {
      const d =
        Math.abs(flagged.sample[i]! - baseline.sample[i]!) +
        Math.abs(flagged.sample[i + 1]! - baseline.sample[i + 1]!) +
        Math.abs(flagged.sample[i + 2]! - baseline.sample[i + 2]!)
      if (d > DIFF_CHANNEL_TOLERANCE) diffPoints++
    }
    const sampledPoints = n / 3

    // `load()` forces `?forcegl2=1` unconditionally, so this is always webgl2
    // (see the header comment) — asserted explicitly so a change to `load()`
    // that accidentally let another backend through fails loudly here rather
    // than silently changing what this branch actually checks.
    expect(flagged.backend, 'host.ctx.rhi.backend').toBe('webgl2')
    // The mode cannot run on an immediate device (isOverdrawActive forces it
    // off) — the flagged render must be the SAME ordinary map, not a heatmap
    // and not a partial render missing strokes / patterns / the graticule.
    expect(
      diffPoints,
      `?debug=overdraw changed ${diffPoints}/${sampledPoints} sampled points on webgl2 — the ` +
        `mode should be a no-op on an immediate device; a non-trivial diff means some ` +
        `draw-layer site is still reading the raw flag instead of isOverdrawActive(caps)`,
    ).toBeLessThan(sampledPoints * 0.01)
  })
}

// ─────────────────────────────────────────────────────────────────────────
// Part 2 — the graticule fix (renderer.ts:933/984), same-page toggle
// ─────────────────────────────────────────────────────────────────────────

test('overdraw inspector: graticule draws under ?debug=overdraw on WebGl2Device (#1594)', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // The URL flag is active from the FIRST frame — proving the fix survives
  // it, not just that graticule works when overdraw is off.
  await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1&debug=overdraw', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, {
    timeout: 30_000,
  })

  const invalidate = () =>
    page.evaluate(() => (window as unknown as MapWin).__xgisMap?.invalidate?.())
  const setGraticule = (on: boolean) =>
    page.evaluate((o) => (window as unknown as MapWin).__xgisMap?.setGraticuleEnabled?.(o), on)

  // Settle signal before the OFF baseline — `_graticule-gl2-gate.spec.ts`'s
  // own convergence check on the SAME `id=minimal` demo (stone-200 country
  // fills, 231/229/228), "so tile pop-in never contaminates the OFF
  // baseline." Without it, residual scene-settling noise in the snapshot
  // window could satisfy the later diff-floor check independent of whether
  // the graticule fix actually works.
  const fillFraction = () =>
    page.evaluate(() => {
      const gl = (window as unknown as MapWin).__xgisMap?.ctx?.rhi?.gl
      if (!gl) return -1
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      let fill = 0
      for (let p = 0; p < W * H; p++) {
        const i = p * 4
        if (
          Math.abs(buf[i]! - 231) < 14 &&
          Math.abs(buf[i + 1]! - 229) < 14 &&
          Math.abs(buf[i + 2]! - 228) < 14
        )
          fill++
      }
      return fill / (W * H)
    })

  const snapshotBaseline = () =>
    page.evaluate(() => {
      const w = window as unknown as MapWin
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      if (!gl) return false
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      w.__ovBaseline = Array.from(buf)
      return true
    })

  // Count pixels that changed vs the OFF baseline — scalars only across the
  // bridge (`_graticule-gl2-gate.spec.ts`'s convention).
  const readFrame = () =>
    page.evaluate(() => {
      const w = window as unknown as MapWin
      const ctx = w.__xgisMap?.ctx
      const gl = ctx?.rhi?.gl
      if (!gl) return { ok: false as const }
      const W = gl.drawingBufferWidth
      const H = gl.drawingBufferHeight
      const buf = new Uint8Array(W * H * 4)
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)
      const base = w.__ovBaseline
      let changed = 0
      if (base) {
        for (let p = 0; p < W * H; p++) {
          const i = p * 4
          const d =
            Math.abs(buf[i]! - base[i]!) +
            Math.abs(buf[i + 1]! - base[i + 1]!) +
            Math.abs(buf[i + 2]! - base[i + 2]!)
          if (d > 18) changed++
        }
      }
      return {
        ok: true as const,
        backend: ctx?.rhi?.backend,
        marker: w.__xgisActiveBackend,
        validation: (ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
        glError: gl.getError(),
        total: W * H,
        changed,
      }
    })

  // 1) Settle the scene (graticule still OFF) until the fills have converged,
  // then snapshot the baseline.
  let frac = await fillFraction()
  const settleDeadline = Date.now() + 30_000
  while (Date.now() < settleDeadline && !(frac > 0.08)) {
    await invalidate()
    await page.waitForTimeout(1_000)
    frac = await fillFraction()
  }
  expect(frac, `country-fill fraction ${frac} (scene converged)`).toBeGreaterThan(0.08)
  expect(await snapshotBaseline(), 'baseline captured').toBe(true)

  // 2) Enable the graticule, settle, read.
  await setGraticule(true)
  let on = await readFrame()
  const onDeadline = Date.now() + 20_000
  while (Date.now() < onDeadline && !(on.ok && on.changed > on.total * 0.0005)) {
    await invalidate()
    await page.waitForTimeout(1_000)
    on = await readFrame()
  }

  expect(on.ok, 'forced-WebGL2 context present').toBe(true)
  if (!on.ok) return
  expect(on.marker, 'window.__xgisActiveBackend').toBe('webgl2')
  expect(on.backend, 'host.ctx.rhi.backend').toBe('webgl2')
  expect(on.glError, 'no gl error').toBe(0)
  expect(on.validation, 'no validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // Pre-#1594: renderer.ts:933's raw-flag check short-circuited ABOVE its own
  // immediate-arm fork (:939), so the graticule NEVER reached
  // renderGraticuleOverlayRhi under ?debug=overdraw on WebGL2 — `changed`
  // would stay ~0 here regardless of how long this loop settles.
  expect(
    on.changed,
    `graticule-changed pixels ${on.changed}/${on.total} under ?debug=overdraw on webgl2 — ` +
      `the immediate-arm fork (renderGraticuleOverlayRhi) never ran`,
  ).toBeGreaterThan(on.total * 0.0005)

  // §5 — persist the ON frame so the pixel-count verdict can be image-inspected.
  await page
    .locator('#xg-canv, canvas')
    .first()
    .screenshot({ path: testInfo.outputPath('graticule-under-overdraw-on.png') })

  // The ON-vs-OFF differential mechanism itself (does toggling genuinely
  // produce a collapsing diff, not incidental scene noise) is
  // `_graticule-gl2-gate.spec.ts`'s job, exercised without the ?debug=overdraw
  // complication. This test's unique claim is narrower and already proven
  // above: the graticule draws AT ALL under the URL flag on an immediate
  // device, which pre-#1594 it structurally could not.
})
