// P2 (4-tier bind group) + P8 (render bundles) feasibility probe.
//
// Both plan items target draw-call / setBindGroup encoding cost. Before
// committing weeks of architecture work, check the actual numbers on
// the styles we ship: how many drawCalls per frame, how many tiles
// visible, how stable across pan/zoom/idle. P8 win scales with stable
// draws (encode once → reuse). P2 win scales with bind-group rebinds
// per frame.

import { test, type Page } from '@playwright/test'

test.describe.configure({ mode: 'serial' })

interface Stats {
  fps: number
  drawCalls: number
  vertices: number
  triangles: number
  lines: number
  tilesVisible: number
  zoom: number
}

async function setup(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(2000) // settle tile cascade
}

async function sampleStats(page: Page, n: number, intervalMs: number): Promise<Stats[]> {
  return await page.evaluate(async ({ n, intervalMs }) => {
    interface M { stats: Stats }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) return []
    const samples: Stats[] = []
    for (let i = 0; i < n; i++) {
      const s = map.stats
      if (s) samples.push({ ...s })
      await new Promise(r => setTimeout(r, intervalMs))
    }
    return samples
  }, { n, intervalMs })
}

function aggregate(samples: Stats[], label: string): void {
  if (samples.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`  ${label}: NO SAMPLES`)
    return
  }
  const draws = samples.map(s => s.drawCalls).sort((a, b) => a - b)
  const tiles = samples.map(s => s.tilesVisible).sort((a, b) => a - b)
  const verts = samples.map(s => s.vertices).sort((a, b) => a - b)
  const tris = samples.map(s => s.triangles).sort((a, b) => a - b)
  const lines = samples.map(s => s.lines).sort((a, b) => a - b)
  const fps = samples.map(s => s.fps).sort((a, b) => a - b)
  const med = <T>(a: T[]): T => a[Math.floor(a.length / 2)]!
  // eslint-disable-next-line no-console
  console.log(
    `  ${label.padEnd(18)} ${samples.length}× | `
    + `draws ${med(draws)} (${draws[0]}-${draws[draws.length - 1]}) | `
    + `tilesVis ${med(tiles)} | tris ${med(tris).toLocaleString()} | `
    + `lines ${med(lines).toLocaleString()} | fps ${med(fps)}`,
  )
}

async function probeView(page: Page, label: string, url: string): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(`\n══ ${label} ══`)
  await setup(page, url)

  // Idle: just sample at fixed intervals.
  const idle = await sampleStats(page, 12, 250)
  aggregate(idle, 'idle')

  // Pan: drive a programmatic east pan, sample during motion.
  const pan = await page.evaluate(async () => {
    interface M {
      camera: { centerX: number; centerY: number }
      invalidate: () => void
      stats: Stats
    }
    interface Stats { fps: number; drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number; zoom: number }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) return []
    const startX = map.camera.centerX
    const samples: Stats[] = []
    return await new Promise<Stats[]>(res => {
      const t0 = performance.now()
      const tick = () => {
        const elapsed = performance.now() - t0
        if (elapsed >= 3000) { res(samples); return }
        map.camera.centerX = startX + elapsed * 100
        map.invalidate()
        const s = map.stats
        if (s) samples.push({ ...s })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  aggregate(pan, 'pan (3s)')

  // Zoom: triangle wave to capture LOD transitions.
  const zoom = await page.evaluate(async () => {
    interface M {
      camera: { zoom: number }
      invalidate: () => void
      stats: Stats
    }
    interface Stats { fps: number; drawCalls: number; vertices: number; triangles: number; lines: number; tilesVisible: number; zoom: number }
    const map = (window as unknown as { __xgisMap?: M }).__xgisMap
    if (!map) return []
    const startZ = map.camera.zoom
    const samples: Stats[] = []
    return await new Promise<Stats[]>(res => {
      const t0 = performance.now()
      const tick = () => {
        const elapsed = performance.now() - t0
        if (elapsed >= 4000) { res(samples); return }
        const t = elapsed / 4000
        const tri = t < 0.5 ? t * 2 : (1 - t) * 2
        map.camera.zoom = startZ + tri * 1.5
        map.invalidate()
        const s = map.stats
        if (s) samples.push({ ...s })
        requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    })
  })
  aggregate(zoom, 'zoom (4s)')
}

test('draw-stats probe — Bright + osm-style across views', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })

  await probeView(page, 'OFM Bright @ Seoul z=17 (worst case)',
    '/demo.html?id=openfreemap_bright#17.85/37.12665/126.92430')
  await probeView(page, 'OFM Bright @ Tokyo z=12 (typical)',
    '/demo.html?id=openfreemap_bright#12/35.68/139.76')
  await probeView(page, 'OFM Bright @ world z=3 (overview)',
    '/demo.html?id=openfreemap_bright#3/30/120')
  await probeView(page, 'osm-style @ Tokyo z=14',
    '/demo.html?id=osm_style#14/35.68/139.76')
})
