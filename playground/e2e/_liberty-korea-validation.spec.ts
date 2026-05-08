// Repro: convert OpenFreeMap "liberty" style, zoom into Korea — user
// reports a WebGPU pipeline-attachment-state validation error tied
// to `line-pipeline-max` (offscreen MAX-blend pass for translucent
// lines). Captures the exact validation message + a screenshot so
// the bug class has a regression anchor.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/liberty.json'), 'utf8')

test('liberty over Korea: no WebGPU pipeline validation errors', async ({ page }) => {
  test.setTimeout(60_000)

  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src: string) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Liberty (OpenFreeMap)')
  }, xgis)

  const consoleErrors: string[] = []
  const validationErrors: string[] = []
  page.on('console', m => {
    const t = m.text()
    if (m.type() === 'error') consoleErrors.push(t)
    if (/validation|pipeline|attachment/i.test(t)) validationErrors.push(`[${m.type()}] ${t}`)
  })
  page.on('pageerror', e => consoleErrors.push(`[pageerror] ${e.message}`))

  // User's URL — zoom into Korea (Sejong area earlier; try Seoul too).
  await page.goto('/demo.html?id=__import#13/37.5665/126.978/0/45', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(8_000)

  // eslint-disable-next-line no-console
  console.log('=== console.error count:', consoleErrors.length)
  for (const e of consoleErrors.slice(0, 10)) {
    // eslint-disable-next-line no-console
    console.log('  ', e.slice(0, 300))
  }
  // eslint-disable-next-line no-console
  console.log('=== pipeline / validation / attachment messages:', validationErrors.length)
  for (const e of validationErrors.slice(0, 10)) {
    // eslint-disable-next-line no-console
    console.log('  ', e.slice(0, 300))
  }

  await page.locator('#map').screenshot({ path: 'test-results/liberty-korea.png' })

  const pipelineErrors = consoleErrors.filter(s => /attachment state of render pipeline|line-pipeline-max|compatible with render pass/i.test(s))
  expect(pipelineErrors, 'no pipeline-attachment-state validation errors').toEqual([])
})
