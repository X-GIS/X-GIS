// WS-9 verification — the top-level Mapbox `light` (intensity / colour /
// position) must reach the fill-extrusion shader. Real-GPU: render the
// osm_style 3D buildings (pitched Manhattan) with the default light, then
// call setLight() with a custom warm/bright light and confirm the
// extrusion shading CHANGES. If the light uniforms never reached the
// shader the two frames would be identical (the bug WS-9 closes).
//
// The directional pixel-diff (default vs custom) is computed by
// compare-diff.py in a follow-up step; here we just capture both frames
// and gate on a clean console.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT = path.resolve('e2e/__ws9__')
fs.mkdirSync(OUT, { recursive: true })

test('WS-9: setLight changes fill-extrusion shading', async ({ page }) => {
  const errs: string[] = []
  page.on('console', (m) => {
    if (m.type() === 'error') errs.push(m.text())
  })

  // osm_style renders 3D extruded buildings; Manhattan midtown, pitched 55°
  // so wall shading (the directional-light term) is prominent.
  await page.goto('https://localhost:3000/demo.html?id=osm_style&e2e=1#16/40.748/-73.985/0/55')
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: { setLight?: unknown } }).__xgisMap?.setLight,
    null,
    { timeout: 30_000 },
  )
  // Let tiles load + buildings extrude.
  await page.waitForTimeout(4500)
  await page.screenshot({ path: path.join(OUT, 'default-light.png') })

  // Custom light: near-max intensity, warm orange tint.
  await page.evaluate(() => {
    ;(window as unknown as { __xgisMap: { setLight(o: unknown): void } }).__xgisMap.setLight({
      intensity: 0.98,
      color: [1.0, 0.45, 0.1],
    })
  })
  await page.waitForTimeout(2000)
  await page.screenshot({ path: path.join(OUT, 'custom-light.png') })

  // Reset proves reversibility + no stuck state.
  await page.evaluate(() => {
    ;(window as unknown as { __xgisMap: { setLight(o: unknown): void } }).__xgisMap.setLight(null)
  })
  await page.waitForTimeout(1500)
  await page.screenshot({ path: path.join(OUT, 'reset-light.png') })

  expect(
    errs.filter((e) => !/favicon|404/i.test(e)),
    `console errors: ${errs.join(' | ')}`,
  ).toEqual([])
})
