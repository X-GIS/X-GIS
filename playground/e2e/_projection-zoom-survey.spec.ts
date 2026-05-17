// Original projection×zoom sweep. For every projection in {mercator,
// equirectangular, natural_earth, orthographic, azimuthal_equidistant,
// stereographic, oblique_mercator, globe} render the `dark` demo
// (countries.geojson — clean visible fill + stroke) at four canonical
// camera positions:
//   - z0 (whole-world view, default load)
//   - dateline (lon=180)
//   - north pole (lat≈85)
//   - south pole (lat≈-85)
//
// Each cell asserts:
//   (a) `__xgisReady` flipped (renderer survived projection switch)
//   (b) camera.zoom is finite (no Infinity-class regression)
//   (c) NO frame-validation / no pageerror
//   (d) the map area paints something (non-bg pixels in the central
//       60×60% region — excludes UI chrome that defeated the audit's
//       loose threshold).
//
// Screenshots land under __projection-zoom-survey__/<proj>-<scenario>
// .png so visual review of expected per-projection behaviour (mercator
// clips poles vs NE renders them, oblique_mercator strip shape, globe
// hemisphere, etc.) is one open-folder away.

import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__projection-zoom-survey__')
mkdirSync(OUT, { recursive: true })

const PROJECTIONS = [
  'mercator',
  'equirectangular',
  'natural_earth',
  'orthographic',
  'azimuthal_equidistant',
  'stereographic',
  'oblique_mercator',
  'globe',
] as const

const SCENARIOS: Array<{ slug: string; hash: string }> = [
  // Default load — playground auto-fits to data bounds, so this is
  // the "whole world" view for each projection.
  { slug: 'z0',        hash: '' },
  // hash format: #zoom/lat/lon/bearing/pitch
  { slug: 'dateline',  hash: '#2/0/180' },
  { slug: 'north-pole', hash: '#3/85/0' },
  { slug: 'south-pole', hash: '#3/-85/0' },
]

interface CellResult {
  proj: string
  scenario: string
  ready: boolean
  cameraZoom: number | null
  paintCenter: number
  errors: string[]
  screenshot: string
}

const results: CellResult[] = []

for (const proj of PROJECTIONS) {
  for (const sc of SCENARIOS) {
    test(`${proj} / ${sc.slug}`, async ({ page }) => {
      test.setTimeout(20_000)
      await page.setViewportSize({ width: 1024, height: 720 })

      const errors: string[] = []
      const onConsole = (m: import('@playwright/test').ConsoleMessage): void => {
        if (m.type() === 'error') errors.push(m.text())
      }
      page.on('console', onConsole)
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

      const url = `/demo.html?id=dark&proj=${proj}${sc.hash}`
      let ready = false
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' })
        await page.waitForFunction(
          () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
          null, { timeout: 15_000 },
        )
        ready = true
      } catch { /* leave ready=false; spec still runs the screenshot */ }
      // Drop pre-ready noise (same reasoning as the demo audit's filter).
      if (ready) errors.length = 0
      await page.waitForTimeout(2000)

      const cam = await page.evaluate(() => {
        const m = (window as unknown as { __xgisMap?: { camera: { zoom: number; centerX: number; centerY: number } } }).__xgisMap
        return m ? { zoom: m.camera.zoom, cx: m.camera.centerX, cy: m.camera.centerY } : null
      })

      const png = await page.locator('#map').screenshot({ type: 'png' })
      const screenshotPath = `${proj}-${sc.slug}.png`
      writeFileSync(join(OUT, screenshotPath), png)

      // Central 60×60% region paint — excludes the zoom-badge top-left,
      // the Copy-snapshot button top-right, and the status bar bottom.
      // Demo background is dark (~#06080c); anything visibly above it
      // counts.
      const paintCenter = await page.evaluate(async (bytes) => {
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
        const xMin = Math.floor(w * 0.20), xMax = Math.floor(w * 0.80)
        const yMin = Math.floor(h * 0.20), yMax = Math.floor(h * 0.80)
        const data = ctx.getImageData(0, 0, w, h).data
        let n = 0
        for (let y = yMin; y < yMax; y++) {
          for (let x = xMin; x < xMax; x++) {
            const i = (y * w + x) * 4
            const r = data[i], g = data[i + 1], b = data[i + 2]
            if (r > 30 || g > 30 || b > 40) n++
          }
        }
        URL.revokeObjectURL(url)
        return n
      }, Array.from(png))

      page.off('console', onConsole)

      results.push({
        proj, scenario: sc.slug, ready,
        cameraZoom: cam?.zoom ?? null,
        paintCenter,
        errors: errors.slice(0, 3),
        screenshot: screenshotPath,
      })

      // Universal expectations — every cell must satisfy these.
      expect(ready, `${proj}/${sc.slug}: __xgisReady never flipped`).toBe(true)
      expect(Number.isFinite(cam?.zoom ?? NaN),
        `${proj}/${sc.slug}: camera.zoom non-finite (${cam?.zoom})`).toBe(true)
      expect(errors, `${proj}/${sc.slug}: console errors\n  ${errors.join('\n  ')}`)
        .toHaveLength(0)

      // Projection-specific paint expectations.
      // Mercator clips at ±85.051°, so the pole scenarios are
      // EXPECTED to be (mostly) blank — they wedge the camera at the
      // clip limit. Anything else MUST paint the whole-world fill
      // somewhere in the central region.
      const expectBlankPole =
        proj === 'mercator' && (sc.slug === 'north-pole' || sc.slug === 'south-pole')
      if (!expectBlankPole) {
        expect(paintCenter, `${proj}/${sc.slug}: central region empty (${paintCenter}px)`)
          .toBeGreaterThan(2000)
      }
    })
  }
}

test.afterAll(() => {
  // REPORT.md table for human review.
  const lines = ['# Projection × zoom survey', '', '| Projection | Scenario | Ready | Zoom | Central paint | Errors |',
                 '|---|---|---:|---:|---:|---:|']
  for (const r of results.sort((a, b) =>
    a.proj.localeCompare(b.proj) || a.scenario.localeCompare(b.scenario))) {
    lines.push(`| ${r.proj} | ${r.scenario} | ${r.ready ? 'Y' : '**N**'} ` +
      `| ${r.cameraZoom?.toFixed(2) ?? 'n/a'} | ${r.paintCenter} | ${r.errors.length} |`)
  }
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
})
