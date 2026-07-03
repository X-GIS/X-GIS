// User-reported 2026-05-20: OFM Liberty #0/0/-54/90.0/63 world-copy
// render check.
//   - Labels NOT world-copied
//   - Raster layer renders only in last world copy
//   - Ocean rendering as WHITE
//
// Probe: load the exact view, screenshot, and dump aggregate pixel
// stats so each symptom is confirmed before diving into renderer code.

import { test, expect } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(HERE, '__convert-fixtures', 'liberty.json'), 'utf8')
const OUT = resolve(HERE, '__screenshot-liberty-worldcopy__')
mkdirSync(OUT, { recursive: true })

test('OFM Liberty world-copy probe — #0/0/-54/90/63', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[page]', msg.text())
    }
  })
  const xgis = convertMapboxStyle(JSON.parse(fixture) as never)
  await page.addInitScript(
    (args) => {
      sessionStorage.setItem('__xgisImportSource', args.src)
      sessionStorage.setItem('__xgisImportLabel', `Liberty z=0 p=63 bearing=90 lon=-54`)
    },
    { src: xgis },
  )
  // hash: #zoom/lat/lon/bearing/pitch
  await page.goto(`/demo.html?id=__import#0/0/-54/90/63`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
  await page.waitForTimeout(3_500)
  const buf = await page.locator('canvas').first().screenshot()
  writeFileSync(join(OUT, 'xgis.png'), buf)
  const png = PNG.sync.read(buf)
  const w = png.width,
    h = png.height
  const total = w * h
  let whiteish = 0,
    blackish = 0,
    blueish = 0,
    beigeish = 0,
    otherCount = 0
  for (let i = 0; i < total; i++) {
    const off = i * 4
    const r = png.data[off],
      g = png.data[off + 1],
      b = png.data[off + 2]
    if (r > 240 && g > 240 && b > 240) whiteish++
    else if (r < 16 && g < 16 && b < 16) blackish++
    else if (b > r + 20 && b > g + 20)
      blueish++ // water blue
    else if (r > 220 && g > 215 && b > 200)
      beigeish++ // Liberty bg #f8f4f0 ish
    else otherCount++
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[Liberty z0 p63] ${w}x${h} white=${whiteish} (${((100 * whiteish) / total).toFixed(1)}%) blue=${blueish} (${((100 * blueish) / total).toFixed(1)}%) beige=${beigeish} (${((100 * beigeish) / total).toFixed(1)}%) black=${blackish} other=${otherCount} total=${total}`,
  )
  expect(total).toBeGreaterThan(0)
})
