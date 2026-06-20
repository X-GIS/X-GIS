// WS-8 verification — the top-level Mapbox style-spec `projection` field
// must drive XGISMap.setProjection() at import time (no `?proj=` flag),
// the same host-applied path as center/zoom. Real-GPU: the engine must
// actually switch projection AND render the globe.
//
// This proves the WIRING (extractMapboxProjectionName → setProjection in
// demo-runner.__xgisImportMapbox). Globe RENDER correctness itself is
// already covered by _projection-coverage / _projection-zoom-survey.

import { test, expect } from '@playwright/test'
import * as fs from 'node:fs'
import * as path from 'node:path'

const OUT = path.resolve('e2e/__ws8__')
fs.mkdirSync(OUT, { recursive: true })
const SOFTWARE_GPU = process.env.XGIS_SOFTWARE_GPU === '1'

// Minimal Mapbox style declaring globe projection — no sources/tiles
// needed, a background layer is enough to prove the projection switch +
// a rendered (non-blank) globe frame.
const GLOBE_STYLE = {
  version: 8,
  projection: { type: 'globe' },
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#102040' } }],
}

test('WS-8: style projection:globe drives setProjection without ?proj=', async ({ page }) => {
  const errs: string[] = []
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()) })

  await page.goto('https://localhost:3000/demo.html?id=minimal&e2e=1')
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisImportMapbox?: unknown }).__xgisImportMapbox
       && !!(window as unknown as { __xgisMap?: { getProjectionName?: () => string } }).__xgisMap?.getProjectionName,
    null, { timeout: 30_000 },
  )

  const before = await page.evaluate(
    () => (window as unknown as { __xgisMap: { getProjectionName(): string } }).__xgisMap.getProjectionName(),
  )

  await page.evaluate((style) => {
    ;(window as unknown as { __xgisImportMapbox: (j: string) => void }).__xgisImportMapbox(JSON.stringify(style))
  }, GLOBE_STYLE)

  // Wait for the imported style's projection to take effect.
  await page.waitForFunction(
    () => (window as unknown as { __xgisMap?: { getProjectionName?: () => string } }).__xgisMap?.getProjectionName?.() === 'globe',
    null, { timeout: 30_000 },
  )
  const after = await page.evaluate(
    () => (window as unknown as { __xgisMap: { getProjectionName(): string } }).__xgisMap.getProjectionName(),
  )

  await page.waitForTimeout(800)
  await page.screenshot({ path: path.join(OUT, 'ws8-globe-from-style.png') })

  // Behavioral assertions (GPU-independent — the real WS-8 proof).
  expect(before, 'minimal demo starts non-globe').not.toBe('globe')
  expect(after, 'style projection:globe must flip the engine to globe').toBe('globe')
  expect(errs.filter(e => !/favicon|404/i.test(e)), `console errors: ${errs.join(' | ')}`).toEqual([])
})
