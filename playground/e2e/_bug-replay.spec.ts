// Replay the user's bug snapshot from test-results/bug-snapshot.json.
// Captures a screenshot at the same camera + viewport so we can SEE
// what the user reported as "buildings behind appearing in front".

import { test, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'
import { fileURLToPath } from 'url'

const __dirname_local = path.dirname(fileURLToPath(import.meta.url))

interface Snapshot {
  schemaVersion: 1
  pageUrl: string
  userAgent: string
  camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
  viewport: { width: number; height: number; cssWidth: number; cssHeight: number; dpr: number }
  pageViewport: { width: number; height: number }
  sources: Record<string, {
    gpuCacheCount: number
    pendingFetch: number
    pendingUpload: number
    tiles: Array<{ z: number; x: number; y: number }>
  }>
}

test('replay user-reported bug snapshot', async ({ browser }) => {
  test.setTimeout(120_000)
  const snapPath = path.join(__dirname_local, '..', 'e2e-fixtures', 'bug-snapshot.json')
  if (!fs.existsSync(snapPath)) {
    test.skip(true, `no bug-snapshot.json at ${snapPath}`)
    return
  }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf-8')) as Snapshot

  // eslint-disable-next-line no-console
  console.log(`[bug-replay] camera lon=${snap.camera.lon.toFixed(4)} lat=${snap.camera.lat.toFixed(4)} z=${snap.camera.zoom.toFixed(2)} pitch=${snap.camera.pitch.toFixed(1)}° bearing=${snap.camera.bearing.toFixed(0)}°`)
  // eslint-disable-next-line no-console
  console.log(`[bug-replay] viewport ${snap.viewport.cssWidth}×${snap.viewport.cssHeight} dpr=${snap.viewport.dpr}`)

  const ctx = await browser.newContext({
    viewport: { width: snap.pageViewport.width, height: snap.pageViewport.height },
    deviceScaleFactor: snap.viewport.dpr,
  })
  const page = await ctx.newPage()

  // Strip the production host — replay against the local dev server.
  // The hash (camera) is what we actually need preserved.
  const hash = new URL(snap.pageUrl).hash
  const search = new URL(snap.pageUrl).search
  const localUrl = `/demo.html${search}${hash}`

  page.on('console', (msg) => {
    if (msg.type() === 'error' || msg.text().includes('WebGPU') || msg.text().includes('validation')) {
      // eslint-disable-next-line no-console
      console.log(`[browser ${msg.type()}] ${msg.text().slice(0, 500)}`)
    }
  })
  page.on('pageerror', (err) => {
    // eslint-disable-next-line no-console
    console.log(`[browser pageerror] ${err.message.slice(0, 500)}`)
  })

  await page.goto(localUrl, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )

  // Capture state at MULTIPLE moments to see the bug evolve:
  //   1. Right after ready (still loading) — should show the BUG state
  //   2. After 8s settle — should show the FIXED state
  await page.waitForTimeout(500) // very brief — capture loading-phase render
  await page.locator('#map').screenshot({ path: 'test-results/bug-replay-loading.png' })

  await page.waitForTimeout(8_000) // settle
  await page.locator('#map').screenshot({ path: 'test-results/bug-replay-settled.png' })

  await page.waitForTimeout(20_000) // longer settle
  await page.locator('#map').screenshot({ path: 'test-results/bug-replay-fully-settled.png' })

  // Capture a settled snapshot for comparison.
  const live = await page.evaluate(async () => {
    const w = window as unknown as {
      __xgisStartDrawOrderTrace?: () => void
      __xgisMap?: { invalidate?: () => void }
      __xgisSnapshot?: () => Promise<unknown>
    }
    w.__xgisStartDrawOrderTrace?.()
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((res) => setTimeout(res, 100))
    return w.__xgisSnapshot ? await w.__xgisSnapshot() : null
  }) as { renderOrder: Array<{ slice: string; tileKey?: number }>; sources: Record<string, { gpuCacheCount: number }> } | null

  if (live) {
    const buildingDraws = live.renderOrder.filter(e => e.slice === 'buildings')
    const uniqueBuildingTiles = new Set(buildingDraws.map(e => e.tileKey).filter(k => k !== undefined))
    // eslint-disable-next-line no-console
    console.log(`[bug-replay settled] gpuCache=${live.sources.pm_world?.gpuCacheCount}, building draws=${buildingDraws.length}, unique tiles=${uniqueBuildingTiles.size}`)

    // Z-distribution of building draws — should be all z=15 in the
    // settled state; any z<15 means fallbacks are still active.
    const byZ = new Map<number, number>()
    for (const e of buildingDraws) {
      const tk = e.tileKey
      if (tk === undefined) continue
      let z = 0
      while (4 ** (z + 1) <= tk) z++
      byZ.set(z, (byZ.get(z) ?? 0) + 1)
    }
    const zStr = [...byZ.entries()].sort((a, b) => a[0] - b[0]).map(([z, n]) => `z=${z}:${n}`).join(' ')
    // eslint-disable-next-line no-console
    console.log(`[bug-replay settled] building draws by z-level: ${zStr}`)
  }

  await ctx.close()
  expect(true).toBe(true)
})
