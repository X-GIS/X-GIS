// ═══ INC-1 PROBE — OFM Positron globe rendering-quality witnesses ═══
//
// PROBE phase only: this file MEASURES and makes NO engine fix. Background
// (established, not re-derived here): on the WebGPU globe, ALL Positron
// vector layers rasterize into fixed 512px DPR-blind single-sample tile
// bakes draped onto the sphere (map/src/render/vector-tile-renderer.ts:
// 3603-3625 — `_drapeGlobeFills` / `_drapeStrokes`=`_bakeStrokeActive`);
// mercator renders vectors directly (no bake). `__XGIS_DISABLE_VECTOR_DRAPE`
// (same file, read at :3622) is the EXISTING escape hatch that forces the
// direct ECEF-chord path even on the globe — toggling it is this probe's
// A/B, not a new capability (already used by _globe-vector-line-drape.spec.ts
// and friends).
//
// Two user-reported cameras (openfreemap_positron demo, playground/src/
// demos/core.ts), source maxzoom 14:
//   9.70/37.54704/126.81412   — native zoom
//   21.10/37.38823/126.9468   — Δz≈7 overzoom (#2024 virtual windowed bakes)
//
// Family M drives the in-page measure-harness (measure-harness skill) with
// the `positron-quality` scenario added alongside this spec — stock vs. the
// disabled-drape "direct" path, at dpr1 and dpr2, cells covering both
// projections at both cameras (4 cells × up to 3 cross-section rows each).
//
// Family F captures whole frames (captureMapFrame — capture-canvas skill)
// plus drape-state / tile-z-histogram dumps, and a MapLibre↔X-GIS
// compare.html pane pair, per camera — the inputs for the mandatory §5
// directional pixel-diff ladder (compare-parity-pixeldiff / tile-crop-review)
// run separately after this suite produces its artifacts.
//
// Every artifact lands under __globe-positron-quality__/ and __net-cache__/
// (both playground/e2e/__*__, gitignored).

import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMapFrame } from './helpers/visual'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-positron-quality__')
const NET_CACHE = join(HERE, '__net-cache__')
mkdirSync(OUT, { recursive: true })

const DEMO_ID = 'openfreemap_positron'
const CAMERAS = [
  { id: '9.70', hash: '9.70/37.54704/126.81412' },
  { id: '21.10', hash: '21.10/37.38823/126.9468' },
] as const

type Win = Window & {
  __xgisReady?: boolean
  __mlReady?: boolean
  __xgisActiveBackend?: string
  __xgisMeasureDone?: boolean
  __xgisMeasureReport?: unknown
  __xgisMap?: {
    invalidate?: () => void
    vtSources?: Map<
      string,
      {
        renderer: Record<string, unknown> & { getPendingUploadCount?: () => number }
        source: { getPendingLoadCount?: () => number }
      }
    >
  }
  __xgisSnapshot?: () => Promise<{
    sources?: Record<string, { tiles?: Array<{ z: number; x: number; y: number }> }>
  }>
  __mlMap?: { loaded?: () => boolean; areTilesLoaded?: () => boolean }
}

interface ArmDump {
  backend: string
  dpr: number
  sources: Record<
    string,
    {
      drapeGlobeFills: boolean
      drapeStrokes: boolean
      bakedCount: number
      virtualBakedCount: number
    }
  >
}
type TileHistogram = Record<string, Record<number, number>>
interface DrainResult {
  convergedMs: number
  residualUploads: number
  residualLoads: number
}
interface ArmResult {
  state: ArmDump
  tiles: TileHistogram
  drain: DrainResult
}
interface SettleResult {
  ok: boolean
  polls: number
  lastKey: string
  residualUploads: number
  residualLoads: number
}

// Generous, matching measure-harness.ts's positron-quality scenario budget: an
// orchestrator review of the first pass found globe-9.70 with 288 pending uploads
// STILL residual after 150s (mercator cells: 0 same run) — the #2053 upload-backlog
// class, a half-loaded frame, not a converged one. 10 minutes is the ceiling to try
// before a cell/arm is reported unreliable rather than presented as drape truth.
const DRAIN_BUDGET_MS = 600_000

function demoUrl(hash: string, opts: { proj?: 'globe' } = {}): string {
  const params = new URLSearchParams({ id: DEMO_ID, e2e: '1', adaptive: '0' })
  if (opts.proj) params.set('proj', opts.proj)
  return `/demo.html?${params.toString()}#${hash}`
}

function compareUrl(hash: string, opts: { proj?: 'globe' } = {}): string {
  const params = new URLSearchParams({ style: 'openfreemap-positron' })
  if (opts.proj) params.set('proj', opts.proj)
  return `/compare.html?${params.toString()}#${hash}`
}

function attachErrorCollector(page: Page, errors: string[]): void {
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
}

async function gotoDemo(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  // 180s, not 60s: the 9.70 camera's DIRECT (drape-disabled) arm timed out twice at
  // 60s on a fresh context — z9.7's globe tile selection is a z9-majority + z10-focal-
  // column busy scene (background facts), so the direct ECEF-chord path has to submit
  // + software-rasterize far more raw geometry than the drape's cheap textured-quad
  // path, and a fresh page/context also pays cold shader-variant compilation. 21.10
  // (few overzoomed tiles) booted fine at 60s on the same arm — this is a real cost
  // signal (recorded in the report), not a broken wait.
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 180_000,
  })
}

async function gotoCompare(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      (window as unknown as Win).__xgisReady === true &&
      (window as unknown as Win).__mlReady === true,
    null,
    { timeout: 60_000 },
  )
}

// Drape-state introspection recipe from _globe-drape-overzoom-gate.spec.ts:136-149
// (`__xgisMap.vtSources` → `renderer['_drapeGlobeFills']` / `['_drapeStrokes']` /
// `[...renderer['_drape']?.baked?.keys() ?? []]`), extended with backend + dpr so a
// WebGL2 fallback (where the drape never engages regardless of the flag — the drape
// is WebGPU-only per vector-tile-renderer.ts:3615) is visible in the dump rather than
// silently misread as "direct path confirmed".
async function dumpArmState(page: Page): Promise<ArmDump> {
  return page.evaluate(() => {
    const w = window as unknown as Win
    const out: ArmDump = {
      backend: w.__xgisActiveBackend ?? 'unknown',
      dpr: window.devicePixelRatio,
      sources: {},
    }
    const vt = w.__xgisMap?.vtSources
    if (vt) {
      for (const [name, entry] of vt) {
        const r = entry.renderer
        const drape = r['_drape'] as { baked?: Map<string, unknown> } | undefined
        const keys = [...(drape?.baked?.keys() ?? [])]
        out.sources[name] = {
          drapeGlobeFills: Boolean(r['_drapeGlobeFills']),
          drapeStrokes: Boolean(r['_drapeStrokes']),
          bakedCount: keys.length,
          virtualBakedCount: keys.filter((k) => /:\d+\/\d+\/\d+$/.test(k)).length,
        }
      }
    }
    return out
  })
}

// Drain the GPU-upload backlog before trusting a captured frame (§12 — "the map
// fossilized half-loaded"; captureMapFrame's own quiesce (capture-canvas skill)
// waits for `hasPendingSourceWork()` to clear but never actively `invalidate()`s to
// force draining, so a render-on-demand engine can idle with uploads still pending
// and captureCanvas's OWN internal poll times out silently rather than failing loud).
// Mirrors measure-harness.ts's converge()/pendingCounts() exactly — same methodology,
// same residual semantics — so Family F frames and Family M's measure-harness rows
// are comparable statements about the SAME kind of converged state. Residuals are
// RETURNED, never hidden: a non-zero residual means the frame that follows is not
// the converged frame, and the caller decides whether to still capture it (recording
// the residual) or treat it as unreliable.
async function drainUploads(page: Page, budgetMs: number): Promise<DrainResult> {
  return page.evaluate(async (budget) => {
    const w = window as unknown as Win
    const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const counts = (): { uploads: number; loads: number } => {
      let uploads = 0
      let loads = 0
      const vt = w.__xgisMap?.vtSources
      if (vt) {
        for (const [, entry] of vt) {
          uploads += entry.renderer.getPendingUploadCount?.() ?? 0
          loads += entry.source.getPendingLoadCount?.() ?? 0
        }
      }
      return { uploads, loads }
    }
    const t0 = performance.now()
    let stable = 0
    while (performance.now() - t0 < budget) {
      const { uploads, loads } = counts()
      const busy = uploads > 0 || loads > 0
      stable = busy ? 0 : stable + 1
      if (stable >= 5) break
      if (busy) w.__xgisMap?.invalidate?.()
      await nextFrame()
      await sleep(30)
    }
    const final = counts()
    return {
      convergedMs: Math.round(performance.now() - t0),
      residualUploads: final.uploads,
      residualLoads: final.loads,
    }
  }, budgetMs)
}

// window.__xgisSnapshot() (map/src/diagnostics.ts captureMapSnapshot) — sources[name]
// .tiles is the same {z,x,y} list the engine actually selected/resident this frame.
async function tileZHistogram(page: Page): Promise<TileHistogram> {
  return page.evaluate(async () => {
    const w = window as unknown as Win
    const snap = w.__xgisSnapshot ? await w.__xgisSnapshot() : null
    const out: TileHistogram = {}
    for (const [name, s] of Object.entries(snap?.sources ?? {})) {
      const hist: Record<number, number> = {}
      for (const t of s.tiles ?? []) hist[t.z] = (hist[t.z] ?? 0) + 1
      out[name] = hist
    }
    return out
  })
}

// Settle compare.html WITHOUT sleeps (capture-canvas skill): Playwright's own
// `polling` option re-invokes this predicate every 300ms (its own budget, not a
// `waitForTimeout`) until ALL of: (i) MapLibre reports `loaded()` (+ `areTilesLoaded()`
// when present); (ii) the X-GIS tile-key string (from __xgisSnapshot, the same source
// tileZHistogram reads) has been byte-identical for 3 consecutive polls; (iii) the
// X-GIS pane's GPU-upload backlog is drained (same #2053 half-loaded-frame concern
// drainUploads guards for demo.html — a compare.html pane goes through the SAME
// VectorTileRenderer upload pipeline). State lives on `window.__xgisPositronProbe`
// because the predicate is re-evaluated fresh each poll and has no closure across
// polls otherwise; it also actively `invalidate()`s while uploads are pending, same
// as drainUploads/measure-harness's converge(), so a render-on-demand engine doesn't
// idle before the backlog is actually drained.
async function settleComparePanes(page: Page, budgetMs: number): Promise<SettleResult> {
  await page.evaluate(() => {
    delete (window as unknown as { __xgisPositronProbe?: unknown }).__xgisPositronProbe
  })
  let ok = true
  try {
    await page.waitForFunction(
      async () => {
        const w = window as unknown as Win & {
          __xgisPositronProbe?: { lastKey: string; stable: number; polls: number }
        }
        const st = (w.__xgisPositronProbe ??= { lastKey: '', stable: 0, polls: 0 })
        const ml = w.__mlMap
        const mlOk =
          !!ml &&
          ml.loaded?.() === true &&
          (typeof ml.areTilesLoaded !== 'function' || ml.areTilesLoaded() === true)
        let uploads = 0
        let loads = 0
        const vt = w.__xgisMap?.vtSources
        if (vt) {
          for (const [, entry] of vt) {
            uploads += entry.renderer.getPendingUploadCount?.() ?? 0
            loads += entry.source.getPendingLoadCount?.() ?? 0
          }
        }
        const uploadsIdle = uploads === 0 && loads === 0
        if (!uploadsIdle) w.__xgisMap?.invalidate?.()
        const snap = w.__xgisSnapshot ? await w.__xgisSnapshot() : null
        const key = snap
          ? Object.entries(snap.sources ?? {})
              .map(
                ([name, s]) =>
                  `${name}:${(s.tiles ?? [])
                    .map((t) => `${t.z}/${t.x}/${t.y}`)
                    .sort()
                    .join(',')}`,
              )
              .sort()
              .join('|')
          : ''
        st.polls++
        st.stable = key !== '' && key === st.lastKey ? st.stable + 1 : key !== '' ? 1 : 0
        st.lastKey = key
        ;(st as { residualUploads?: number; residualLoads?: number }).residualUploads = uploads
        ;(st as { residualUploads?: number; residualLoads?: number }).residualLoads = loads
        return mlOk && st.stable >= 3 && uploadsIdle
      },
      null,
      { timeout: budgetMs, polling: 300 },
    )
  } catch {
    ok = false
  }
  const dbg = await page.evaluate(
    () =>
      (
        window as unknown as {
          __xgisPositronProbe?: {
            lastKey: string
            stable: number
            polls: number
            residualUploads?: number
            residualLoads?: number
          }
        }
      ).__xgisPositronProbe ?? null,
  )
  return {
    ok,
    polls: dbg?.polls ?? 0,
    lastKey: dbg?.lastKey ?? '',
    residualUploads: dbg?.residualUploads ?? -1,
    residualLoads: dbg?.residualLoads ?? -1,
  }
}

// Steps 1-3 of Family F: globe-stock / globe-direct / mercator frame + state, shared
// by the per-camera dpr1 tests and the dpr2 9.70 repeat.
async function captureThreeArms(
  page: Page,
  hash: string,
  suffix: string,
): Promise<{ globeStock: ArmResult; globeDirect: ArmResult; merc: ArmResult }> {
  // 1. globe stock
  await gotoDemo(page, demoUrl(hash, { proj: 'globe' }))
  const globeStockDrain = await drainUploads(page, DRAIN_BUDGET_MS)
  const globeStockPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  writeFileSync(join(OUT, `globe-stock-${suffix}.png`), globeStockPng)
  const globeStock: ArmResult = {
    state: await dumpArmState(page),
    tiles: await tileZHistogram(page),
    drain: globeStockDrain,
  }

  // 2. globe direct — SAME page, live-toggled (the _globe-vector-line-drape.spec.ts /
  // _globe-vector-drape-i2.spec.ts idiom: `_drapeGlobeFills` is recomputed every
  // render call, so flipping the global + forcing a repaint takes effect immediately,
  // no reload needed). A first version of this probe opened a FRESH page (`page.context()
  // .newPage()` + `addInitScript`) for the direct arm instead, keeping BOTH pages'
  // WebGPU render loops alive at once — that hung `__xgisReady` indefinitely at the
  // busy 9.70 camera (reproduced twice, unaffected by a 60s→180s budget bump) while
  // 21.10's much lighter tile set booted fine; SwiftShader's software Vulkan path
  // appears to livelock under two simultaneous heavy WebGPU contexts in one browser
  // process. Toggling in place on one page sidesteps the double-context path entirely.
  await page.evaluate(() => {
    ;(globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE = true
    ;(window as unknown as Win).__xgisMap?.invalidate?.()
  })
  // The toggle only affects tiles baked/drawn AFTER it flips — the stock capture above
  // already fully drained (uploads are DONE, not just resident), so this re-drain is
  // mostly cheap; it also re-proves the mechanism actually moved the pending count
  // (a flag that silently failed to reach the page would drain instantly here too,
  // which is exactly why drapeState — read next, in dumpArmState — is the real
  // cause-assertion, not this timing).
  const globeDirectDrain = await drainUploads(page, DRAIN_BUDGET_MS)
  const globeDirectPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  writeFileSync(join(OUT, `globe-direct-${suffix}.png`), globeDirectPng)
  const globeDirect: ArmResult = {
    state: await dumpArmState(page),
    tiles: await tileZHistogram(page),
    drain: globeDirectDrain,
  }
  // Clear it before the mercator/pitch60 steps — mercator never consults the flag
  // (bakesVectorDrape gates on globe/sphere projections only) but a later globe-stock
  // capture on this same page (the 9.70 pitch-60 arm) must NOT inherit "direct".
  await page.evaluate(() => {
    delete (globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE
  })

  // 3. mercator control (no proj= — vectors render direct on mercator either way)
  await gotoDemo(page, demoUrl(hash))
  const mercDrain = await drainUploads(page, DRAIN_BUDGET_MS)
  const mercPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  writeFileSync(join(OUT, `merc-${suffix}.png`), mercPng)
  const merc: ArmResult = {
    state: await dumpArmState(page),
    tiles: await tileZHistogram(page),
    drain: mercDrain,
  }

  return { globeStock, globeDirect, merc }
}

// ─── Family M — measure-harness positron-quality runs ──────────────────────

test.describe('Family M — measure-harness positron-quality runs', () => {
  for (const dpr of [1, 2] as const) {
    test.describe(`dpr${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr })
      for (const arm of ['stock', 'direct'] as const) {
        test(`positron-quality measure — ${arm} dpr${dpr}`, async ({ page }) => {
          // 45min (was 15min): measure-harness's own convergeBudgetMs for this
          // scenario is 600s/cell × 4 cells worst case (raised 2026-08-25 — a first
          // pass measured globe cells still carrying a 288/37-upload residual after
          // 150s while mercator cells converged at 0; see measure-harness.ts).
          test.setTimeout(2_700_000)
          const errors: string[] = []
          attachErrorCollector(page, errors)
          await installOfflineProxy(page, { cacheDir: NET_CACHE })
          if (arm === 'direct') {
            await page.addInitScript(() => {
              ;(
                globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }
              ).__XGIS_DISABLE_VECTOR_DRAPE = true
            })
          }
          await page.goto(`/demo.html?id=${DEMO_ID}&e2e=1&adaptive=0&measure=positron-quality`, {
            waitUntil: 'domcontentloaded',
          })
          await page.waitForFunction(
            () => (window as unknown as Win).__xgisMeasureDone === true,
            null,
            { timeout: 2_600_000 },
          )
          const report = await page.evaluate(() => (window as unknown as Win).__xgisMeasureReport)
          const outPath = join(OUT, `measure-${arm}-dpr${dpr}.json`)
          writeFileSync(
            outPath,
            JSON.stringify({ arm, ...(report as Record<string, unknown>) }, null, 2),
          )
          console.log(`[positron-quality measure] wrote ${outPath}`)
          expect(errors, `pageerrors (${arm} dpr${dpr}): ${errors.join(' | ')}`).toEqual([])
        })
      }
    })
  }
})

// ─── Family F — full frames + state dumps ───────────────────────────────────

test.describe('Family F — full frames + state dumps', () => {
  for (const cam of CAMERAS) {
    test(`frames + state @ ${cam.id}`, async ({ page }) => {
      // 45min (was 15min) — three drainUploads() calls up to 10min each (stock/
      // direct/merc) plus two compare.html settles; see DRAIN_BUDGET_MS.
      test.setTimeout(2_700_000)
      const errors: string[] = []
      attachErrorCollector(page, errors)
      await installOfflineProxy(page, { cacheDir: NET_CACHE })

      const arms = await captureThreeArms(page, cam.hash, cam.id)

      if (cam.id === '9.70') {
        // Optional pitch-60 horizon-strip look, globe stock only.
        await gotoDemo(page, demoUrl(`${cam.hash}/0/60`, { proj: 'globe' }))
        const pitchPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
        writeFileSync(join(OUT, `globe-stock-${cam.id}-pitch60.png`), pitchPng)
      }

      // 4. compare.html panes — ml-<cam>.png / xg-globe-pane-<cam>.png from the
      // ?proj=globe load, xg-merc-pane-<cam>.png from the no-proj load. MapLibre's
      // globe auto-transitions to mercator above ~z6 (compare-runner.ts), and both
      // cameras are well past that, so the ML pane is expected mercator either way.
      await gotoCompare(page, compareUrl(cam.hash, { proj: 'globe' }))
      const settleGlobe = await settleComparePanes(page, 300_000)
      const panesGlobe = page.locator('#panes .pane')
      writeFileSync(join(OUT, `ml-${cam.id}.png`), await panesGlobe.nth(0).screenshot())
      writeFileSync(join(OUT, `xg-globe-pane-${cam.id}.png`), await panesGlobe.nth(1).screenshot())

      await gotoCompare(page, compareUrl(cam.hash))
      const settleMerc = await settleComparePanes(page, 300_000)
      const panesMerc = page.locator('#panes .pane')
      writeFileSync(join(OUT, `xg-merc-pane-${cam.id}.png`), await panesMerc.nth(1).screenshot())

      writeFileSync(
        join(OUT, `state-${cam.id}.json`),
        JSON.stringify(
          {
            camera: cam,
            globeStock: arms.globeStock,
            globeDirect: arms.globeDirect,
            merc: arms.merc,
            compareSettle: {
              globePane: settleGlobe,
              mercPane: settleMerc,
              note:
                'ML pane renders mercator at both compare.html loads — ML globe auto-transitions ' +
                'to mercator above ~z6 (compare-runner.ts), both cameras are z9.7/z21.1.',
            },
          },
          null,
          2,
        ),
      )

      console.log(
        `[positron-quality frames] @ ${cam.id} backend=${arms.globeStock.state.backend} ` +
          `settle(globe)=${settleGlobe.ok} settle(merc)=${settleMerc.ok}`,
      )
      expect(errors, `pageerrors @ ${cam.id}: ${errors.join(' | ')}`).toEqual([])
    })
  }

  test.describe('dpr2 repeat — 9.70 only', () => {
    test.use({ deviceScaleFactor: 2 })
    test('frames @ 9.70 dpr2', async ({ page }) => {
      test.setTimeout(2_700_000)
      const errors: string[] = []
      attachErrorCollector(page, errors)
      await installOfflineProxy(page, { cacheDir: NET_CACHE })
      const cam = CAMERAS[0]
      const arms = await captureThreeArms(page, cam.hash, `${cam.id}-dpr2`)
      writeFileSync(
        join(OUT, `state-${cam.id}-dpr2.json`),
        JSON.stringify({ camera: cam, dpr: 2, ...arms }, null, 2),
      )
      expect(errors, `pageerrors @ ${cam.id} dpr2: ${errors.join(' | ')}`).toEqual([])
    })
  })
})
