// Deterministic snapshot test for the 3D building depth-sort bug.
// User reports: buildings BEHIND visually appear IN FRONT — bug
// persists across previous fixes (23453f3 + 0a59bbc per-feature
// depth jitter, b4fb2f9 two-phase opaque, dec154f OIT routing).
//
// Strategy: capture a deterministic scene snapshot (camera +
// loaded tiles + render-order trace + pixel hash) at a known camera.
// Repeated runs produce the same hash IF the pipeline is
// deterministic. Snapshots from "before fix" can be compared with
// "after fix" to verify behavioural change. The render-order trace
// surfaces tile-routing decisions (which pipeline ran for each
// tile) that the audit identified as suspect causes:
//   1. OIT path used for opaque buildings (depthWriteEnabled=false)
//   2. Cross-tile draw order independent of world Z
//   3. per-feature mode falling back to fillPipeline when zBuffer null
//
// This test runs at 4 known scenes (3 osm-style + 1 user-bug
// reference URL). Each scene logs the snapshot for inspection.

import { test, expect } from '@playwright/test'

const SCENES: Array<{ slug: string; url: string }> = [
  // Manhattan — tallest building variance, mid-pitch from south.
  { slug: 'manhattan-pitch60', url: '/demo.html?id=osm_style#15.5/40.7508/-73.9851/0/60' },
  // Tokyo — dense buildings + previous coplanar bug URL (23453f3).
  { slug: 'tokyo-pitch63', url: '/demo.html?id=osm_style#16.33/35.6585/139.7454/0/63.5' },
  // Tokyo lower pitch — height ordering most visually obvious.
  { slug: 'tokyo-pitch45', url: '/demo.html?id=osm_style#16/35.6585/139.7454/0/45' },
  // Seoul — different city, similar density.
  { slug: 'seoul-pitch60', url: '/demo.html?id=osm_style#15.5/37.5665/126.978/0/60' },
]

interface Snapshot {
  camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
  viewport: { width: number; height: number }
  sources: Record<string, {
    gpuCacheCount: number
    pendingFetch: number
    pendingUpload: number
    tiles: Array<{ z: number; x: number; y: number }>
  }>
  renderOrder: Array<{
    seq: number; slice: string; phase: string; extrude: string;
    tileKey?: number; isFill?: boolean;
    pipelineRoute?: 'oit' | 'extrude' | 'fill' | 'skip';
    hasZBuffer?: boolean;
  }>
  pixelHash: string
  pixelHashBy: 'subtle' | 'fnv'
}

test.describe('3D building depth-sort: scene snapshot', () => {
  for (const scn of SCENES) {
    test(`snapshot ${scn.slug}`, async ({ page }) => {
      test.setTimeout(60_000)
      await page.setViewportSize({ width: 1280, height: 720 })
      await page.goto(scn.url, { waitUntil: 'domcontentloaded' })
      await page.waitForFunction(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
        null, { timeout: 30_000 },
      )
      // Settle: tile fetch + decode + upload + first render.
      await page.waitForTimeout(5_000)

      // Arm draw-order trace BEFORE forcing a re-render. The trace is
      // populated per drawIndexed call within the next render frame.
      await page.evaluate(() => {
        const w = window as unknown as {
          __xgisStartDrawOrderTrace?: () => void
          __xgisMap?: { invalidate?: () => void }
        }
        w.__xgisStartDrawOrderTrace?.()
        w.__xgisMap?.invalidate?.()
      })
      // Wait one frame so the invalidated render runs and emits trace
      // events. 2 frames @ 60 fps + a margin.
      await page.waitForTimeout(50)

      const snap = await page.evaluate(async () => {
        const fn = (window as unknown as {
          __xgisSnapshot?: () => Promise<unknown>
        }).__xgisSnapshot
        if (!fn) return { error: 'snapshot not exposed' }
        return await fn()
      }) as Snapshot | { error: string }

      if ('error' in snap) {
        throw new Error(`snapshot failed: ${snap.error}`)
      }

      // Distil: which pipelines ran per tile? Detects the audit's
      // suspect routings.
      const fillEvents = snap.renderOrder.filter(e => e.isFill === true)
      const byRoute = new Map<string, number>()
      const byExtrude = new Map<string, number>()
      const tilesWithoutZBuffer: number[] = []
      for (const e of fillEvents) {
        const route = e.pipelineRoute ?? 'unknown'
        byRoute.set(route, (byRoute.get(route) ?? 0) + 1)
        const ex = e.extrude ?? 'unknown'
        byExtrude.set(`${ex}-${route}`, (byExtrude.get(`${ex}-${route}`) ?? 0) + 1)
        if (e.extrude === 'feature' && e.hasZBuffer === false && e.tileKey !== undefined) {
          tilesWithoutZBuffer.push(e.tileKey)
        }
      }

      // eslint-disable-next-line no-console
      console.log(`\n[building-snapshot ${scn.slug}]`)
      // eslint-disable-next-line no-console
      console.log(`  camera: lon=${snap.camera.lon.toFixed(4)} lat=${snap.camera.lat.toFixed(4)} z=${snap.camera.zoom.toFixed(2)} pitch=${snap.camera.pitch.toFixed(1)}°`)
      // eslint-disable-next-line no-console
      console.log(`  pixelHash: ${snap.pixelHash.slice(0, 16)}... (${snap.pixelHashBy})`)
      // eslint-disable-next-line no-console
      console.log(`  fill events: ${fillEvents.length} total`)
      // eslint-disable-next-line no-console
      console.log(`    by route: ${[...byRoute.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`)
      // eslint-disable-next-line no-console
      console.log(`    by extrude+route: ${[...byExtrude.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`)
      if (tilesWithoutZBuffer.length > 0) {
        // eslint-disable-next-line no-console
        console.log(`  ⚠ ${tilesWithoutZBuffer.length} feature-extrude tiles WITHOUT zBuffer (fell back to fillPipeline)`)
      }
      for (const [name, src] of Object.entries(snap.sources)) {
        // eslint-disable-next-line no-console
        console.log(`  source[${name}]: gpu=${src.gpuCacheCount}, pendingFetch=${src.pendingFetch}, pendingUpload=${src.pendingUpload}, tiles=${src.tiles.length}`)
      }

      // Save screenshot alongside the snapshot for visual review.
      await page.locator('#map').screenshot({ path: `test-results/building-snap-${scn.slug}.png` })

      // Sanity: the snapshot infrastructure should produce a non-empty
      // pixelHash and at least some draw events.
      expect(snap.pixelHash.length, 'pixel hash empty').toBeGreaterThan(0)
      expect(fillEvents.length, 'no fill draw events captured').toBeGreaterThan(0)
    })
  }

  test('determinism: same camera, two snapshots, identical hash', async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize({ width: 1280, height: 720 })
    await page.goto('/demo.html?id=osm_style#15.5/40.7508/-73.9851/0/60', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 30_000 },
    )
    await page.waitForTimeout(8_000) // long settle so all tiles arrive

    const grab = async (): Promise<{ pixelHash: string; tileCount: number }> => {
      const s = await page.evaluate(async () => {
        const fn = (window as unknown as {
          __xgisSnapshot?: () => Promise<unknown>
        }).__xgisSnapshot
        return fn ? await fn() : null
      }) as Snapshot | null
      if (!s) throw new Error('no snapshot')
      const tileCount = Object.values(s.sources).reduce((acc, src) => acc + src.tiles.length, 0)
      return { pixelHash: s.pixelHash, tileCount }
    }

    const a = await grab()
    // Wait without moving the camera. If pipeline is deterministic,
    // the second hash should match.
    await page.waitForTimeout(1500)
    const b = await grab()

    // eslint-disable-next-line no-console
    console.log(`[determinism] a.hash=${a.pixelHash.slice(0, 16)} b.hash=${b.pixelHash.slice(0, 16)}`)
    // eslint-disable-next-line no-console
    console.log(`[determinism] a.tiles=${a.tileCount}, b.tiles=${b.tileCount}`)
    // Same tile count is the bare-minimum determinism check (cache
    // shouldn't shift just because we waited). Pixel hash equality
    // is stricter — if it diverges, something is changing under the
    // hood (animation? stale GPU state? non-deterministic order?).
    expect(b.tileCount, 'tile count drifted between snapshots').toBe(a.tileCount)
    expect(b.pixelHash, 'pixel hash drifted — non-deterministic render').toBe(a.pixelHash)
  })
})
