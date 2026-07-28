// Where the pitch-72.4 cost actually lands, per source, per pitch.
//
// The CPU probe in `scripts/probe-tile-selection-pitch.ts` drives
// `visibleTilesFrustum`, but the VECTOR render path routes through
// `visibleTilesSSE` (tile-selection-cache.ts) — `visibleTilesFrustum` only
// serves the raster renderer, the pitch>=30 prefetch, and the SSE-disabled
// fallback. So the frustum numbers do not describe the reported OFM Liberty
// camera at all. This spec asks the running engine directly.
//
// Reports, per pitch: canvas dims + dpr, and per source the draw calls,
// tilesVisible, missedTiles and triangle count the renderer actually
// submitted, alongside frame-interval percentiles and the [FLICKER] /
// arena-oom console traffic.
//
// RESTART THE DEV SERVER BETWEEN THE TWO SIDES OF AN A/B. A `git stash` /
// `git stash pop` around a measurement does not reliably invalidate Vite's
// module cache, and a stale run reproduces the other side's numbers to the
// digit — which reads exactly like "the change had no effect" rather than
// like a broken harness. Paid for during #1427: an after-run reported
// tris=320418, identical to the before-run, and only a `rm -rf
// node_modules/.vite` + restart revealed the real 74031.
//
// Measured at the reported camera, pane 639x704, both sides on FRESH servers:
//
//   pitch   draws          tilesVisible    triangles              cache
//      30   106 -> 106     114 -> 114      18 870 ->  18 870      unchanged
//      65   181 -> 161     194 -> 174      28 664 ->  25 300      117 -> 132
//    72.4   814 -> 501     899 -> 538     320 418 ->  74 031      313 -> 182
//      80   570 -> 447     625 -> 485     340 620 ->  65 497      268 -> 202
//
// (pitch 80 is noisy run-to-run — a separate before-run measured 165 253
// triangles there. pitch 72.4 reproduced 320 418 on two independent
// before-runs, so that is the row to quote.)

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installOfflineProxy } from './helpers/offline-proxy'

const HERE = dirname(fileURLToPath(import.meta.url))
const TAG = process.env.DS_TAG ?? 'run'
const OUT = join(HERE, '__debug-liberty-drawstats__', TAG)
mkdirSync(OUT, { recursive: true })

const STYLE = process.env.DS_STYLE ?? 'openfreemap-liberty'
const BASE = process.env.DS_BASE ?? '16.00/51.50466/-0.11813/60.0'
const PITCHES = (process.env.DS_PITCHES ?? '30,59,72.4').split(',')

for (const pitch of PITCHES) {
  test(`liberty drawstats p${pitch} [${TAG}]`, async ({ page }) => {
    test.setTimeout(300_000)
    const warnings: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (/FLICKER|arena-oom/i.test(t)) warnings.push(t.slice(0, 240))
    })
    await installOfflineProxy(page, { cacheDir: join(HERE, '__net-cache__') })
    await page.setViewportSize({ width: 1280, height: 800 })
    await page.goto(`/compare.html?style=${STYLE}#${BASE}/${pitch}`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 150_000 },
    )
    await page.waitForTimeout(25_000)

    const report = await page.evaluate(async () => {
      interface DrawStats {
        drawCalls: number
        tilesVisible: number
        missedTiles: number
        triangles: number
      }
      interface VTEntry {
        renderer: { getDrawStats: () => DrawStats; getCacheSize: () => number }
      }
      interface M {
        ctx?: { canvas: { width: number; height: number } }
        camera: { zoom: number; pitch: number; bearing: number }
        vtSources: Map<string, VTEntry>
        getTileLoadDiagnostic: () => Record<string, Record<string, number>>
      }
      const m = (window as unknown as { __xgisMap: M }).__xgisMap

      // Frame intervals over ~4 s of held camera.
      const dts: number[] = []
      await new Promise<void>((resolve) => {
        let prev = performance.now()
        const t0 = prev
        const tick = () => {
          const now = performance.now()
          dts.push(now - prev)
          prev = now
          if (now - t0 >= 4000) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      dts.sort((a, b) => a - b)
      const pct = (p: number) => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))] ?? -1

      const sources: Record<string, DrawStats & { cacheSize: number }> = {}
      for (const [name, entry] of m.vtSources) {
        sources[name] = {
          ...entry.renderer.getDrawStats(),
          cacheSize: entry.renderer.getCacheSize(),
        }
      }
      return {
        canvas: { w: m.ctx?.canvas.width ?? -1, h: m.ctx?.canvas.height ?? -1 },
        dpr: window.devicePixelRatio,
        camera: { zoom: m.camera.zoom, pitch: m.camera.pitch, bearing: m.camera.bearing },
        frameMs: {
          p50: +pct(0.5).toFixed(2),
          p95: +pct(0.95).toFixed(2),
          max: +(dts[dts.length - 1] ?? -1).toFixed(2),
        },
        sources,
        diag: m.getTileLoadDiagnostic(),
      }
    })

    const full = {
      pitch,
      ...report,
      flickerWarnings: warnings.length,
      warnings: warnings.slice(0, 5),
    }
    writeFileSync(join(OUT, `p${pitch}.json`), JSON.stringify(full, null, 2))
    const vt = report.sources['openmaptiles']
    console.warn(
      `[drawstats p${pitch}] canvas=${report.canvas.w}x${report.canvas.h} dpr=${report.dpr} ` +
        `draws=${vt?.drawCalls} tilesVisible=${vt?.tilesVisible} missed=${vt?.missedTiles} ` +
        `tris=${vt?.triangles} cache=${vt?.cacheSize} ` +
        `frameMs p50=${report.frameMs.p50} p95=${report.frameMs.p95} max=${report.frameMs.max} ` +
        `flicker=${warnings.length}`,
    )
    expect(report.canvas.w).toBeGreaterThan(0)
  })
}
