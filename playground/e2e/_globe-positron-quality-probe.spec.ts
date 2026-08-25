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
    vtSources?: Map<string, { renderer: Record<string, unknown> }>
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
interface ArmResult {
  state: ArmDump
  tiles: TileHistogram
}
interface SettleResult {
  ok: boolean
  polls: number
  lastKey: string
}

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
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 60_000,
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
// `waitForTimeout`) until BOTH MapLibre reports `loaded()` (+ `areTilesLoaded()`
// when present) AND the X-GIS tile-key string (from __xgisSnapshot, the same
// source tileZHistogram reads) has been byte-identical for 3 consecutive polls.
// State lives on `window.__xgisPositronProbe` because the predicate is
// re-evaluated fresh each poll and has no closure across polls otherwise.
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
        return mlOk && st.stable >= 3
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
          __xgisPositronProbe?: { lastKey: string; stable: number; polls: number }
        }
      ).__xgisPositronProbe ?? null,
  )
  return { ok, polls: dbg?.polls ?? 0, lastKey: dbg?.lastKey ?? '' }
}

// Steps 1-3 of Family F: globe-stock / globe-direct / mercator frame + state, shared
// by the per-camera dpr1 tests and the dpr2 9.70 repeat.
async function captureThreeArms(
  page: Page,
  hash: string,
  suffix: string,
  errors: string[],
): Promise<{ globeStock: ArmResult; globeDirect: ArmResult; merc: ArmResult }> {
  // 1. globe stock
  await gotoDemo(page, demoUrl(hash, { proj: 'globe' }))
  const globeStockPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  writeFileSync(join(OUT, `globe-stock-${suffix}.png`), globeStockPng)
  const globeStock: ArmResult = {
    state: await dumpArmState(page),
    tiles: await tileZHistogram(page),
  }

  // 2. globe direct — a FRESH page, so `__XGIS_DISABLE_VECTOR_DRAPE` (set via
  // addInitScript, which persists for every subsequent nav on the page it is
  // added to) never leaks onto the stock/mercator arms sharing `page`.
  const directPage = await page.context().newPage()
  attachErrorCollector(directPage, errors)
  await installOfflineProxy(directPage, { cacheDir: NET_CACHE })
  await directPage.addInitScript(() => {
    ;(globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE = true
  })
  await gotoDemo(directPage, demoUrl(hash, { proj: 'globe' }))
  const globeDirectPng = await captureMapFrame(directPage, {
    readyTimeoutMs: 120_000,
    capture: 'clip',
  })
  writeFileSync(join(OUT, `globe-direct-${suffix}.png`), globeDirectPng)
  const globeDirect: ArmResult = {
    state: await dumpArmState(directPage),
    tiles: await tileZHistogram(directPage),
  }
  await directPage.close()

  // 3. mercator control (no proj= — vectors render direct on mercator either way)
  await gotoDemo(page, demoUrl(hash))
  const mercPng = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  writeFileSync(join(OUT, `merc-${suffix}.png`), mercPng)
  const merc: ArmResult = { state: await dumpArmState(page), tiles: await tileZHistogram(page) }

  return { globeStock, globeDirect, merc }
}

// ─── Family M — measure-harness positron-quality runs ──────────────────────

test.describe('Family M — measure-harness positron-quality runs', () => {
  for (const dpr of [1, 2] as const) {
    test.describe(`dpr${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr })
      for (const arm of ['stock', 'direct'] as const) {
        test(`positron-quality measure — ${arm} dpr${dpr}`, async ({ page }) => {
          test.setTimeout(900_000)
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
            { timeout: 850_000 },
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
      test.setTimeout(900_000)
      const errors: string[] = []
      attachErrorCollector(page, errors)
      await installOfflineProxy(page, { cacheDir: NET_CACHE })

      const arms = await captureThreeArms(page, cam.hash, cam.id, errors)

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
      const settleGlobe = await settleComparePanes(page, 120_000)
      const panesGlobe = page.locator('#panes .pane')
      writeFileSync(join(OUT, `ml-${cam.id}.png`), await panesGlobe.nth(0).screenshot())
      writeFileSync(join(OUT, `xg-globe-pane-${cam.id}.png`), await panesGlobe.nth(1).screenshot())

      await gotoCompare(page, compareUrl(cam.hash))
      const settleMerc = await settleComparePanes(page, 120_000)
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
      test.setTimeout(900_000)
      const errors: string[] = []
      attachErrorCollector(page, errors)
      await installOfflineProxy(page, { cacheDir: NET_CACHE })
      const cam = CAMERAS[0]
      const arms = await captureThreeArms(page, cam.hash, `${cam.id}-dpr2`, errors)
      writeFileSync(
        join(OUT, `state-${cam.id}-dpr2.json`),
        JSON.stringify({ camera: cam, dpr: 2, ...arms }, null, 2),
      )
      expect(errors, `pageerrors @ ${cam.id} dpr2: ${errors.join(' | ')}`).toEqual([])
    })
  })
})
