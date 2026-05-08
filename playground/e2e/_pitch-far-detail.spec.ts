// User report: at non-zero pitch, far-from-camera areas still
// render at full detail instead of dropping to lower zoom levels.
// This spec captures the exact tile selection — unique tile keys
// (not slice-draws) grouped by zoom, plus a screen-space sample of
// where each zoom level lives in the viewport — so we can tell
// whether the LOD pyramid is actually pyramidal or whether high-z
// tiles bleed into the horizon.

import { test, expect } from '@playwright/test'

interface Scenario {
  label: string
  url: string
  /** iPhone 14 = 390 × 844 DPR=3, the user's reported environment. */
  viewport: { width: number; height: number }
  /** Camera the URL hash sets — duplicated here for the report. */
  expect: { zoom: number; pitch: number }
}

const SCENARIOS: Scenario[] = [
  // bright @ z=15 over Tokyo — pitch sweep across the LOD-mode threshold
  // (30° flips between sampled and DFS) and into the high-pitch regime.
  // Identical iPhone-ish viewport everywhere so comparisons hold.
  { label: 'bright pitch=0',  url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/0',  viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 0  } },
  { label: 'bright pitch=20', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/20', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 20 } },
  { label: 'bright pitch=30', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/30', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 30 } },
  { label: 'bright pitch=45', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/45', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 45 } },
  { label: 'bright pitch=60', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/60', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 60 } },
  { label: 'bright pitch=70', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/70', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 70 } },
  { label: 'bright pitch=80', url: '/demo.html?id=openfreemap_bright#15.0/35.68/139.76/0/80', viewport: { width: 390, height: 844 }, expect: { zoom: 15, pitch: 80 } },
  // User's exact inspector report — desktop 1500×945, Seoul, z=14 pitch=73.2°.
  { label: 'desktop seoul pitch=73', url: '/demo.html?id=openfreemap_bright#14.0/37.54044/127.00441/75.0/73.2', viewport: { width: 1500, height: 945 }, expect: { zoom: 14, pitch: 73 } },
]

for (const scn of SCENARIOS) {
  test(scn.label, async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize(scn.viewport)

  await page.goto(scn.url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000) // settle

  const result = await page.evaluate(() => {
    const map = (window as unknown as {
      __xgisMap?: {
        camera: { lon: number; lat: number; zoom: number; bearing: number; pitch: number }
        vtSources?: Map<string, {
          renderer?: {
            _frameTileCache?: {
              tiles?: Array<{ z: number; x: number; y: number }>
            }
          }
        }>
      }
    }).__xgisMap

    if (!map) return { error: 'no map' }
    // Pick whichever vector-tile source the demo registered. bright
    // uses "openmaptiles", pmtiles_layered uses "pm_world".
    const vt = (map.vtSources && [...map.vtSources.values()][0]) || undefined
    const tiles = vt?.renderer?._frameTileCache?.tiles ?? []

    // Group tiles by z and dedupe (a tile shows up in cache.tiles
    // for every world-copy + every render call, but the (z,x,y)
    // triple is the unique identity).
    const uniqueByZoom = new Map<number, Set<string>>()
    for (const t of tiles) {
      const set = uniqueByZoom.get(t.z) ?? new Set()
      set.add(`${t.x}/${t.y}`)
      uniqueByZoom.set(t.z, set)
    }
    const byZoom: Record<number, number> = {}
    for (const [z, s] of uniqueByZoom) byZoom[z] = s.size

    // Compute each tile's centre in lon/lat → screen-Y so we can
    // see whether high-z tiles cluster near foreground (top of
    // ground plane in screen) or bleed up to the horizon. With
    // pitch=70 looking north, foreground is bottom of viewport,
    // horizon is top.
    const camLat = map.camera.lat
    const camLon = map.camera.lon
    const tileCentre = (z: number, x: number, y: number) => {
      const n = Math.pow(2, z)
      const lon = (x + 0.5) / n * 360 - 180
      const lat0 = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / n))) * 180 / Math.PI
      return { lon, lat: lat0 }
    }
    // Approximate "distance from camera" in degrees along the
    // bearing direction (north = bearing 0). With bearing=0 the
    // forward axis is +lat.
    const tilesByDistance: Array<{ z: number; lat: number; lon: number; dLat: number; dLon: number }> = []
    const seen = new Set<string>()
    for (const t of tiles) {
      const key = `${t.z}/${t.x}/${t.y}`
      if (seen.has(key)) continue
      seen.add(key)
      const c = tileCentre(t.z, t.x, t.y)
      tilesByDistance.push({
        z: t.z, lat: c.lat, lon: c.lon,
        dLat: c.lat - camLat,
        dLon: c.lon - camLon,
      })
    }

    // Bucket by forward-distance (dLat). With bearing=0 + pitch=70
    // the camera is looking north, so positive dLat = foreground
    // → horizon, negative = behind camera.
    const buckets = {
      behindCam:        tilesByDistance.filter(t => t.dLat < -0.005),
      foreground:       tilesByDistance.filter(t => t.dLat >= -0.005 && t.dLat <  0.01),
      midground:        tilesByDistance.filter(t => t.dLat >=  0.01  && t.dLat <  0.05),
      farground:        tilesByDistance.filter(t => t.dLat >=  0.05  && t.dLat <  0.20),
      horizon:          tilesByDistance.filter(t => t.dLat >=  0.20),
    }
    const summary = (arr: typeof tilesByDistance) => {
      const z: Record<number, number> = {}
      for (const t of arr) z[t.z] = (z[t.z] ?? 0) + 1
      return { count: arr.length, byZoom: z }
    }

    return {
      camera: map.camera,
      uniqueTileTotal: seen.size,
      uniqueByZoom: byZoom,
      buckets: {
        behindCam: summary(buckets.behindCam),
        foreground: summary(buckets.foreground),
        midground: summary(buckets.midground),
        farground: summary(buckets.farground),
        horizon: summary(buckets.horizon),
      },
    }
  })

  // eslint-disable-next-line no-console
  console.log(`\n=== ${scn.label} ===`)
  const r = result as { uniqueTileTotal?: number; uniqueByZoom?: Record<number, number> }
  if (r.uniqueByZoom) {
    const entries = Object.entries(r.uniqueByZoom).sort((a, b) => Number(a[0]) - Number(b[0]))
    // eslint-disable-next-line no-console
    console.log(`unique tiles total: ${r.uniqueTileTotal}`)
    // eslint-disable-next-line no-console
    console.log(`by zoom: ${entries.map(([z, n]) => `z${z}:${n}`).join(' · ')}`)
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result))
  }

  const slug = scn.label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  await page.locator('#map').screenshot({ path: `test-results/pitch-far-${slug}.png` })

  expect(typeof result === 'object' && result !== null).toBe(true)
  // High-pitch sanity gate. Pre-fix the LOD selector emitted z=14
  // for nearly every visible tile at pitch ≥ 60° — the screen-AABB
  // metric kept horizon strips above the subdivide threshold despite
  // their large foreshortening. The fix replaces the screen-AABB
  // metric with MapLibre-style distance-based desired-zoom, which
  // produces a natural pyramid at any pitch + viewport. At pitch ≥
  // 60° we expect at least 4 distinct zoom levels.
  if (scn.expect.pitch >= 60 && r.uniqueByZoom) {
    const distinctZooms = Object.keys(r.uniqueByZoom).length
    expect(distinctZooms,
      `pitch=${scn.expect.pitch} should produce a multi-level LOD pyramid (saw ${JSON.stringify(r.uniqueByZoom)})`,
    ).toBeGreaterThanOrEqual(4)
  }
  })
}
