// Minimal-layer reproducer: one water fill against the OpenFreeMap
// TileJSON. If THIS doesn't render at z=4 over the Pacific we know
// the problem isn't bright-style-specific (filter expressions, layer
// merging) but somewhere deeper in the TileJSON → MVT → render path.

import { test, expect } from '@playwright/test'

const minSrc = `
background { fill: #f8f4f0 }

source om {
  type: tilejson
  url: "https://tiles.openfreemap.org/planet"
}

layer water {
  source: om
  sourceLayer: "water"
  | fill-#3399cc
}
`

test('minimal water layer over OpenFreeMap TileJSON renders SOMETHING', async ({ page }) => {
  test.setTimeout(60_000)

  const consoleErrors: string[] = []
  const allConsole: string[] = []
  const tileFetches: { url: string; status: number }[] = []
  page.on('console', m => {
    allConsole.push(`[${m.type()}] ${m.text()}`)
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  page.on('response', resp => {
    const u = resp.url()
    if (/openfreemap\.org\/.*\.pbf/.test(u)) {
      tileFetches.push({ url: u, status: resp.status() })
    }
  })

  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'min-water')
  }, minSrc)

  await page.goto('/demo.html?id=__import#3/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 })
  await page.waitForTimeout(8_000)

  // page.screenshot() captures the rendered canvas correctly (incl.
  // WebGPU surfaces); reading back via Canvas2D drawImage on a
  // WebGPU canvas yields transparent pixels under Chromium.
  const buf = await page.locator('#map').screenshot()
  const stats = await page.evaluate(async (b64: string) => {
    return await new Promise<{ uniqueColors: number; sampleColors: string[]; bluePixels: number }>((resolve) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = 80; c.height = 80
        const ctx = c.getContext('2d')!
        ctx.drawImage(img, 0, 0, 80, 80)
        const data = ctx.getImageData(0, 0, 80, 80).data
        const colors = new Set<string>()
        let blue = 0
        for (let i = 0; i < data.length; i += 4) {
          colors.add(`${data[i]},${data[i+1]},${data[i+2]}`)
          if (Math.abs(data[i] - 51) < 30 && Math.abs(data[i+1] - 153) < 30 && Math.abs(data[i+2] - 204) < 30) {
            blue++
          }
        }
        resolve({ uniqueColors: colors.size, sampleColors: [...colors].slice(0, 10), bluePixels: blue })
      }
      img.src = `data:image/png;base64,${b64}`
    })
  }, buf.toString('base64'))

  // eslint-disable-next-line no-console
  console.log('tile fetches:', tileFetches.length)
  // eslint-disable-next-line no-console
  console.log('pixel stats:', JSON.stringify(stats))
  // eslint-disable-next-line no-console
  console.log('console (last 12):', allConsole.slice(-12).join('\n  '))

  await page.locator('#map').screenshot({ path: 'test-results/convert-bright-min-map.png' })

  expect(tileFetches.length, 'should fetch some pbf tiles').toBeGreaterThan(0)
  expect(stats.bluePixels, 'water polygons should produce some blue pixels').toBeGreaterThan(50)
})
