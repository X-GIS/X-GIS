// Replay-from-paste workflow.
//
// User's intended flow:
//   1. User encounters the bug in the playground demo.
//   2. User opens devtools console, runs:
//        copy(JSON.stringify(await __xgisSnapshot(), null, 2))
//      → snapshot JSON is on clipboard.
//   3. User pastes the JSON into a test scenario.
//   4. The test reads the snapshot, sets the EXACT viewport + DPR,
//      navigates to the EXACT pageUrl (camera baked into hash),
//      then asks the runtime to replay the snapshot — wait for
//      every captured tile to be loaded, force a render, capture a
//      fresh side-by-side screenshot.
//
// This spec is the IMPLEMENTATION of step 4. To use it, replace the
// `PASTED_SNAPSHOT` constant below with a snapshot the user pastes,
// then run:
//   playwright test _snapshot-from-paste --workers=1 --reporter=list
//
// The test produces:
//   - test-results/replay-from-paste.png: visual rendering of the
//     replayed scene (the user can compare to their original).
//   - Console output of camera / viewport / tile counts / render
//     order length so the user can confirm the reproduction matches.

import { test, expect } from '@playwright/test'

// ═══ PASTE SNAPSHOT JSON BETWEEN THE BACKTICKS ═══
//
// Default is null — test is skipped when no snapshot is provided.
// To use: paste the output of `await __xgisSnapshot()` here as
// a JSON string literal.
const PASTED_SNAPSHOT_JSON: string | null = null

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
  renderOrder: unknown[]
  pixelHash: string
  pixelHashBy: 'subtle' | 'fnv'
}

test.describe('snapshot replay from pasted JSON', () => {
  test('reproduce a user-pasted snapshot', async ({ browser }) => {
    test.skip(PASTED_SNAPSHOT_JSON === null,
      'No snapshot pasted — set PASTED_SNAPSHOT_JSON in this file to enable.')
    test.setTimeout(120_000)
    const snap = JSON.parse(PASTED_SNAPSHOT_JSON!) as Snapshot

    if (snap.schemaVersion !== 1) {
      throw new Error(`unsupported snapshot schema ${snap.schemaVersion}`)
    }

    // eslint-disable-next-line no-console
    console.log('[paste-replay] received snapshot:')
    // eslint-disable-next-line no-console
    console.log(`  pageUrl: ${snap.pageUrl}`)
    // eslint-disable-next-line no-console
    console.log(`  camera: lon=${snap.camera.lon.toFixed(4)} lat=${snap.camera.lat.toFixed(4)} z=${snap.camera.zoom.toFixed(2)} bearing=${snap.camera.bearing.toFixed(1)}° pitch=${snap.camera.pitch.toFixed(1)}°`)
    // eslint-disable-next-line no-console
    console.log(`  page viewport: ${snap.pageViewport.width}×${snap.pageViewport.height}`)
    // eslint-disable-next-line no-console
    console.log(`  canvas: ${snap.viewport.cssWidth}×${snap.viewport.cssHeight} (backing ${snap.viewport.width}×${snap.viewport.height}, dpr=${snap.viewport.dpr})`)
    const totalTiles = Object.values(snap.sources).reduce((acc, s) => acc + s.tiles.length, 0)
    // eslint-disable-next-line no-console
    console.log(`  tiles to reproduce: ${totalTiles} across ${Object.keys(snap.sources).length} source(s)`)

    const ctx = await browser.newContext({
      viewport: { width: snap.pageViewport.width, height: snap.pageViewport.height },
      deviceScaleFactor: snap.viewport.dpr,
      userAgent: snap.userAgent || undefined,
    })
    const page = await ctx.newPage()

    await page.goto(snap.pageUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )

    // Replay — converge on the snapshot's tile set + camera.
    const result = await page.evaluate(async (s) => {
      const fn = (window as unknown as {
        __xgisReplaySnapshot?: (snap: unknown, o?: unknown) => Promise<unknown>
      }).__xgisReplaySnapshot
      if (!fn) return { error: 'replay not exposed' }
      return await fn(s, { timeoutMs: 30_000 })
    }, snap) as { matched: boolean; missingTiles: number; pendingFetchTotal: number; pendingUploadTotal: number } | { error: string }

    if ('error' in result) throw new Error(`replay error: ${result.error}`)

    // eslint-disable-next-line no-console
    console.log(`[paste-replay] replay: matched=${result.matched}, missing=${result.missingTiles}, pendingFetch=${result.pendingFetchTotal}, pendingUpload=${result.pendingUploadTotal}`)

    // Capture for visual comparison.
    await page.locator('#map').screenshot({ path: 'test-results/replay-from-paste.png' })

    // Echo the live snapshot so the user can confirm the reproduction.
    const live = await page.evaluate(async () => {
      const fn = (window as unknown as { __xgisSnapshot?: () => Promise<unknown> }).__xgisSnapshot
      return fn ? await fn() : null
    }) as Snapshot | null
    if (live) {
      // eslint-disable-next-line no-console
      console.log(`[paste-replay] live: pixelHash=${live.pixelHash.slice(0, 16)}, tiles=${Object.values(live.sources).reduce((a, s) => a + s.tiles.length, 0)}`)
      // eslint-disable-next-line no-console
      console.log(`[paste-replay] orig: pixelHash=${snap.pixelHash.slice(0, 16)}, tiles=${totalTiles}`)
      // eslint-disable-next-line no-console
      console.log(`[paste-replay] note: pixel hash will differ across browser processes — visual comparison is the source of truth.`)
    }

    await ctx.close()

    expect(result.matched, `replay couldn't load all snapshot tiles (missing=${result.missingTiles})`).toBe(true)
  })
})
