// Diagnose user-reported stripe/crack artefacts in the per-layer
// PMTiles demo at low zoom. Two probes:
//
//  1. Capture canvas at user-reported view (z≈3 over Pacific).
//  2. Per-layer-isolated render (one MVT layer at a time) — pinpoints
//     which slice contributes the bad geometry.

import { test, type Page } from '@playwright/test'
import * as fs from 'node:fs'

async function waitForXgisReady(page: Page) {
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
}

async function snap(page: Page, name: string) {
  fs.mkdirSync('test-results', { recursive: true })
  await page.locator('canvas#map').screenshot({ path: `test-results/diag-${name}.png` })
}

async function dumpCatalogs(page: Page, label: string) {
  const state = await page.evaluate(() => {
    type Cat = { maxLevel: number; getCacheSize(): number; getPendingLoadCount(): number }
    const m = (window as unknown as { __xgisMap?: { vtSources?: Map<string, { source: Cat }> } }).__xgisMap
    if (!m?.vtSources) return null
    const out: Record<string, { cache: number; pending: number; max: number }> = {}
    for (const [name, e] of m.vtSources.entries()) {
      out[name] = {
        cache: e.source.getCacheSize(),
        pending: e.source.getPendingLoadCount(),
        max: e.source.maxLevel,
      }
    }
    return out
  })
  console.log(`\n[${label}] catalogs:`, JSON.stringify(state, null, 2))
}

test('layered z=3 over Pacific — capture artefact', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  const logs: string[] = []
  page.on('console', m => { logs.push(m.text()) })

  await page.goto('/demo.html?id=pmtiles_layered#3/40/-150', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(8000)
  await snap(page, 'layered-z3-pacific')
  await dumpCatalogs(page, 'layered z=3 Pacific')
  for (const l of logs) {
    if (l.includes('PMTiles attached')) console.log('  ATTACH:', l.slice(0, 200))
  }
})

test('only-landuse z=3 over Pacific — isolate landuse', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/demo.html?id=pmtiles_only_landuse#3/40/-150', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(8000)
  await snap(page, 'only-landuse-z3-pacific')
  await dumpCatalogs(page, 'only-landuse z=3 Pacific')
})

test('single-source v4 z=3 over Pacific — baseline (no layered)', async ({ page }) => {
  test.setTimeout(60_000)
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/demo.html?id=pmtiles_v4#3/40/-150', { waitUntil: 'domcontentloaded' })
  await waitForXgisReady(page)
  await page.waitForTimeout(8000)
  await snap(page, 'single-z3-pacific')
  await dumpCatalogs(page, 'single z=3 Pacific')
})
