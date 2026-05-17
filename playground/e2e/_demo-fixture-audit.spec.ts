// ═══════════════════════════════════════════════════════════════════
// Demo + fixture audit — every entry in DEMOS, "does it render?"
// ═══════════════════════════════════════════════════════════════════
//
// Per-demo test() so Playwright workers can parallelize across the
// gallery (was a single test sweeping 123 demos sequentially, ~13 min
// on SwiftShader). With WORKERS=4 in CI, wall-clock drops to ~3-4 min.
//
// Each demo asserts: ready + no errors + paint > 200 + center > 200.
// Per-demo JSON + screenshot are still written under `__demo-audit__/`
// so the aggregator (`_demo-audit-report.spec.ts`, runs last via
// alphabetical ordering of `_demo-audit-*`) can build REPORT.md the
// CI artifact references.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__demo-audit__')
mkdirSync(OUT, { recursive: true })
mkdirSync(join(OUT, 'screens'), { recursive: true })
mkdirSync(join(OUT, 'per-demo'), { recursive: true })

// Enumerate demo IDs at spec-discovery time by parsing demos.ts source.
// import.meta.glob makes runtime import unworkable from Node; the
// top-level key pattern is stable enough to regex.
const DEMOS_SRC = readFileSync(resolve(HERE, '../src/demos.ts'), 'utf8')
const DEMO_IDS = [...DEMOS_SRC.matchAll(/^  ([a-z_][a-z_0-9]*):\s*\{/gm)].map(m => m[1]!)

// Console noise that fires on nearly every demo and isn't actionable.
const CONSOLE_NOISE = /\[vite\]|Monaco|DevTools|powerPreference|ignoreHTTPSErrors|countries-sample|favicon|Failed to load resource|FLICKER/
// Error-class console messages that *would* normally be ignored under
// CONSOLE_NOISE but indicate a real demo problem if they appear.
const HARD_ERROR_RE = /\[X-GIS frame-validation\]|\[X-GIS pass:|\[VTR tile-drop|\[xgvt-pool parse\]|XGVT|WGSL|GPU|Shader|wgpu/i

interface DemoResult {
  id: string
  ready: boolean
  readyMs: number
  paintedPx: number
  centerPx: number
  cameraZoom: number | null
  cameraFinite: boolean
  errors: string[]
  warns: string[]
  failedRequests: string[]
  screenshotPath: string
}

for (const id of DEMO_IDS) {
  test(`audit ${id}`, async ({ page }) => {
    test.setTimeout(45_000)
    await page.setViewportSize({ width: 1024, height: 720 })

    const errors: string[] = []
    const warns: string[] = []
    const failedRequests: string[] = []

    page.on('console', m => {
      const t = m.text()
      const type = m.type()
      if (type !== 'error' && type !== 'warning') return
      if (CONSOLE_NOISE.test(t)) {
        if (!HARD_ERROR_RE.test(t)) return
      }
      if (type === 'error') errors.push(t)
      else warns.push(t)
    })
    page.on('pageerror', e => errors.push(`[pageerror] ${e.message}`))
    page.on('requestfailed', r => {
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${u} (${r.failure()?.errorText ?? '?'})`)
    })
    page.on('response', r => {
      const s = r.status()
      if (s < 400) return
      const u = r.url()
      if (CONSOLE_NOISE.test(u)) return
      failedRequests.push(`${s} ${u}`)
    })

    let ready = false
    let readyMs = 0
    let paintedPx = 0
    let centerPx = 0
    let screenshotPath = ''
    let camera: { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number } | null = null

    try {
      const t0 = Date.now()
      await page.goto(`/demo.html?id=${id}`, { waitUntil: 'domcontentloaded' })
      try {
        await page.waitForFunction(
          () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
          null, { timeout: 15_000 },
        )
        ready = true
      } catch { ready = false }
      readyMs = Date.now() - t0
      await page.waitForTimeout(1500)

      camera = await page.evaluate(() => {
        interface Cam { zoom: number; centerX: number; centerY: number; pitch: number; bearing: number }
        const m = (window as unknown as { __xgisMap?: { camera: Cam } }).__xgisMap
        if (!m) return null
        return {
          zoom: m.camera.zoom, centerX: m.camera.centerX, centerY: m.camera.centerY,
          pitch: m.camera.pitch, bearing: m.camera.bearing,
        }
      })

      const png = await page.locator('#map').screenshot({ type: 'png' })
      screenshotPath = `screens/${id}.png`
      writeFileSync(join(OUT, screenshotPath), png)

      const paintCounts = await page.evaluate(async (bytes) => {
        const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
        const url = URL.createObjectURL(blob)
        const img = new Image()
        await new Promise<void>((res, rej) => {
          img.onload = () => res(); img.onerror = () => rej(new Error('img'))
          img.src = url
        })
        const off = new OffscreenCanvas(img.width, img.height)
        const ctx = off.getContext('2d')!
        ctx.drawImage(img, 0, 0)
        const w = img.width, h = img.height
        const data = ctx.getImageData(0, 0, w, h).data
        const isPaint = (i: number): boolean => {
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!
          return r > 15 || g > 15 || b > 18
        }
        let whole = 0, center = 0
        const xMin = Math.floor(w * 0.20), xMax = Math.floor(w * 0.80)
        const yMin = Math.floor(h * 0.20), yMax = Math.floor(h * 0.80)
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4
            if (!isPaint(i)) continue
            whole++
            if (x >= xMin && x < xMax && y >= yMin && y < yMax) center++
          }
        }
        URL.revokeObjectURL(url)
        return { whole, center }
      }, Array.from(png))
      paintedPx = paintCounts.whole
      centerPx = paintCounts.center
    } catch (err) {
      errors.push(`[spec-error] ${(err as Error).message}`)
    }

    const cameraFinite = camera !== null
      && Number.isFinite(camera.zoom)
      && Number.isFinite(camera.centerX)
      && Number.isFinite(camera.centerY)
    const result: DemoResult = {
      id,
      ready,
      readyMs,
      paintedPx,
      centerPx,
      cameraZoom: camera?.zoom ?? null,
      cameraFinite,
      errors: [...new Set(errors)],
      warns: [...new Set(warns)],
      failedRequests: [...new Set(failedRequests)],
      screenshotPath,
    }
    writeFileSync(join(OUT, 'per-demo', `${id}.json`), JSON.stringify(result, null, 2))

    // Per-demo assertions — Playwright reports each independently so a
    // failing demo doesn't mask the rest. Soft expect (collected at end
    // of the test) lets the per-demo JSON capture the full set of
    // signals even when one assertion fails.
    expect.soft(ready, `${id} never reached __xgisReady`).toBe(true)
    expect.soft(result.errors, `${id} produced console errors`).toEqual([])
    expect.soft(cameraFinite, `${id} camera has non-finite zoom/center`).toBe(true)
    expect.soft(paintedPx, `${id} painted only ${paintedPx} px (UI chrome only?)`)
      .toBeGreaterThanOrEqual(200)
    expect.soft(centerPx, `${id} central region painted only ${centerPx} px (UI chrome only?)`)
      .toBeGreaterThanOrEqual(200)
  })
}
