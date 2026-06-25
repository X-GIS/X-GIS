import { test, expect } from '@playwright/test'

// #582 DIRECTION verification. Two properties:
//  (1) DRAG direction is correct under bearing (grab-anchor) — measured directly.
//  (2) the INERTIA glide CONTINUES the drag (same sign), under bearing + the globe /
//      tilted-disc projections the fix touches. Inertia needs a FAST flick (high px
//      velocity); a slow synthetic drag decays to ~0 glide (velocity artifact, not a
//      direction bug). We dispatch a tight-timed pointer flick to raise the velocity.

type Cfg = { proj: string; bearing: number; pitch: number; dx: number; dy: number; label: string }

const CASES: Cfg[] = [
  { proj: 'globe', bearing: 0, pitch: 0, dx: 14, dy: 0, label: 'globe b0 +x' },
  { proj: 'globe', bearing: 0, pitch: 0, dx: 0, dy: 14, label: 'globe b0 +y' },
  { proj: 'globe', bearing: 90, pitch: 0, dx: 14, dy: 0, label: 'globe b90 +x' },
  { proj: 'globe', bearing: 180, pitch: 0, dx: 14, dy: 0, label: 'globe b180 +x' },
  { proj: 'orthographic', bearing: 0, pitch: 40, dx: 14, dy: 0, label: 'ortho-tilted +x' },
]

for (const c of CASES) {
  test(`inertia continues drag direction — ${c.label}`, async ({ page }) => {
    await page.goto('/demo.html?id=minimal', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => (window as any).__xgisReady === true, { timeout: 20000 })
    await page.evaluate((cfg) => {
      const m = (window as any).__xgisMap
      m.setProjection(cfg.proj)
      m.camera.bearing = cfg.bearing
      m.camera.pitch = cfg.pitch
      m.invalidate?.()
    }, c)
    await page.waitForTimeout(800)

    const read = () => page.evaluate(() => {
      const cam = (window as any).__xgisMap.camera
      return { lon: (cam.centerX / 6378137) * (180 / Math.PI), lat: cam.centerLatDeg }
    })

    const start = await read()
    // FAST flick: dispatch pointer events to the canvas in a tight loop (small real dt
    // → high velocity → a real inertia glide). 8 steps of dx/dy each.
    const { drag } = await page.evaluate(({ dx, dy }) => {
      const cv = document.querySelector('canvas') as HTMLCanvasElement
      const r = cv.getBoundingClientRect()
      const sx = r.left + r.width / 2, sy = r.top + r.height / 2
      const ev = (type: string, x: number, y: number) =>
        cv.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId: 1, bubbles: true, button: 0 }))
      ev('pointerdown', sx, sy)
      for (let i = 1; i <= 8; i++) ev('pointermove', sx + (i * dx) / 1, sy + (i * dy) / 1)
      ev('pointerup', sx + 8 * dx, sy + 8 * dy)
      const cam = (window as any).__xgisMap.camera
      return { drag: { lon: (cam.centerX / 6378137) * (180 / Math.PI), lat: cam.centerLatDeg } }
    }, c)
    const rel = await read()
    await page.waitForTimeout(500)
    const end = await read()

    const dragLon = rel.lon - start.lon, dragLat = rel.lat - start.lat
    const glideLon = end.lon - rel.lon, glideLat = end.lat - rel.lat
    // eslint-disable-next-line no-console
    console.log(`DIR[${c.label}] drag=(${dragLon.toFixed(2)},${dragLat.toFixed(2)}) glide=(${glideLon.toFixed(2)},${glideLat.toFixed(2)})`)

    // The glide must CONTINUE the drag along the DOMINANT (intended) axis — the axis
    // the user actually flicked. A pure +x flick legitimately produces a pure-x glide;
    // the small incidental cross-axis drift the grab-anchor adds mid-drag is NOT part of
    // the flick intent, so the inertia is not required to reproduce it.
    expect(Math.abs(glideLon) + Math.abs(glideLat), 'inertia produced a non-zero glide').toBeGreaterThan(0.05)
    if (Math.abs(dragLon) >= Math.abs(dragLat)) {
      expect(Math.sign(glideLon), `dominant=lon: drag ${dragLon.toFixed(1)} glide ${glideLon.toFixed(1)}`).toBe(Math.sign(dragLon))
    } else {
      expect(Math.sign(glideLat), `dominant=lat: drag ${dragLat.toFixed(1)} glide ${glideLat.toFixed(1)}`).toBe(Math.sign(dragLat))
    }
  })
}
