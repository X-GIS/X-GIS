// Coverage gate — "every pixel has a defined source" (VISION §4, §5 gap #1).
//
// The background pass (render/passes/background-pass.ts) fills the region
// OUTSIDE the world band so a flat CORE/SHOWCASE projection never shows an
// accidental black void (low-zoom letterbox, the sky above a pitched
// horizon). This is the DELIBERATE reversal of the iter-196 black-outside-
// world MapLibre-parity convention for CORE/SHOWCASE (VISION §1).
//
// The numeric invariant (the real gate — the screenshot is only how we
// SEE it): on a flat projection with a style background-color, the share
// of PURE-BLACK (r=g=b=0) pixels must be ~0 — coverage fills the viewport.
// Before the fix the letterbox / above-horizon region was pure black, so
// this ratio was large. OFM-Bright's background is parchment, never black,
// so any pure-black pixel is an uncovered void.
//
// Disc / globe (orthographic / globe) are NOT gated here — their space IS
// defined black; we only capture them for eyeball + a not-all-black smoke.
//
// Real GPU headed (HEADED=1; do NOT set XGIS_SOFTWARE_GPU). Viewport
// 1024x900, style OFM Bright. PNGs -> .omc/shots/coverage-verify/.

import { test, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'

const OUT = 'D:/X-GIS/.omc/shots/coverage-verify'

/** Flat CORE/SHOWCASE: outside-band must be the style background, not black. */
const FLAT_GATE: Array<{ proj: string; scene: 'world' | 'world-pitch' }> = [
  { proj: 'mercator', scene: 'world' },
  { proj: 'mercator', scene: 'world-pitch' },
  { proj: 'equirectangular', scene: 'world' },
  { proj: 'equirectangular', scene: 'world-pitch' },
  { proj: 'natural_earth', scene: 'world' },
  { proj: 'natural_earth', scene: 'world-pitch' },
]

/** Disc / globe: captured for eyeball + not-all-black smoke (space is black). */
const SPACE_SMOKE: Array<{ proj: string; scene: 'world' }> = [
  { proj: 'orthographic', scene: 'world' },
  { proj: 'globe', scene: 'world' },
]

const SCENES: Record<string, { zoom: number; lat: number; lon: number; pitch: number }> = {
  world: { zoom: 0.5, lat: 0, lon: 0, pitch: 0 },
  'world-pitch': { zoom: 0.5, lat: 0, lon: 0, pitch: 60 },
}

/** ≤2% pure-black on a flat view = coverage filled the viewport. */
const FLAT_BLACK_MAX = 0.02

interface MapH {
  setProjection(n: string): void
  jumpTo(o: { center?: [number, number]; zoom?: number; bearing?: number; pitch?: number }): void
  markCameraPositioned(): void
  invalidate?(): void
}

/** Fraction of PURE-BLACK (r=g=b=0) pixels in a PNG screenshot, decoded in
 *  the page via the proven createImageBitmap → drawImage → getImageData
 *  path (a WebGPU canvas can't getImageData directly). */
async function blackRatio(page: import('@playwright/test').Page, png: Buffer): Promise<number> {
  return await page.evaluate(async (b64: string) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let black = 0
    const total = d.length / 4
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 0) black++
    }
    return black / total
  }, png.toString('base64'))
}

async function captureCell(
  page: import('@playwright/test').Page,
  proj: string,
  scene: string,
): Promise<Buffer> {
  const s = SCENES[scene]
  const hash = `#${s.zoom}/${s.lat}/${s.lon}/0/${s.pitch}`
  await page.goto(`/demo.html?id=openfreemap_bright&proj=${proj}${hash}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(1_500)
  await page.evaluate(
    ({ proj, lon, lat, zoom, pitch }) => {
      const m = (window as unknown as { __xgisMap: MapH }).__xgisMap
      m.setProjection(proj)
      m.jumpTo({ center: [lon, lat], zoom, bearing: 0, pitch })
      m.markCameraPositioned()
      m.invalidate?.()
    },
    { proj, lon: s.lon, lat: s.lat, zoom: s.zoom, pitch: s.pitch },
  )
  await page.waitForTimeout(4_500)
  return await page.locator('#map').screenshot({ path: `${OUT}/${proj}__${scene}.png` })
}

test.describe.configure({ mode: 'serial' })

test('coverage: flat CORE/SHOWCASE has no black void; disc/globe render', async ({ page }) => {
  test.setTimeout(8 * 60_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 1024, height: 900 })

  const results: Array<{ cell: string; black: number; gate: number | null; pass: boolean }> = []

  for (const { proj, scene } of FLAT_GATE) {
    const png = await captureCell(page, proj, scene)
    const black = await blackRatio(page, png)
    const pass = black <= FLAT_BLACK_MAX
    results.push({ cell: `${proj}/${scene}`, black, gate: FLAT_BLACK_MAX, pass })

    console.log(
      `[coverage] ${proj}/${scene}  black=${(black * 100).toFixed(2)}%  gate≤${FLAT_BLACK_MAX * 100}%  ${pass ? 'OK' : 'FAIL'}`,
    )
  }

  for (const { proj, scene } of SPACE_SMOKE) {
    const png = await captureCell(page, proj, scene)
    const black = await blackRatio(page, png)
    // Space IS black; just prove SOMETHING rendered (not an all-black frame).
    const pass = black < 0.99
    results.push({ cell: `${proj}/${scene}`, black, gate: null, pass })

    console.log(
      `[coverage] ${proj}/${scene}  black=${(black * 100).toFixed(2)}%  (space-smoke <99%)  ${pass ? 'OK' : 'FAIL'}`,
    )
  }

  console.log(`\nPNGs -> ${OUT}`)

  // Assert flat coverage cells: no accidental black void.
  for (const r of results.filter((r) => r.gate !== null)) {
    expect(
      r.black,
      `${r.cell} pure-black ratio must be ≤ ${FLAT_BLACK_MAX} (coverage void)`,
    ).toBeLessThanOrEqual(FLAT_BLACK_MAX)
  }
  // Smoke: disc/globe rendered something.
  for (const r of results.filter((r) => r.gate === null)) {
    expect(r.black, `${r.cell} is an all-black frame (nothing rendered)`).toBeLessThan(0.99)
  }
})
