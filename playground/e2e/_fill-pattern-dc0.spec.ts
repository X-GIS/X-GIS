// LOCAL-ONLY fill-pattern raw↔RHI DC=0 gate (real GPU). NOT a CI test.
//
// Renders fill-pattern via the Mapbox converter (`__xgisImportMapbox`) with an inline
// polygon (data URL) + a local sprite, then A/Bs the `__xgisVtrFillViaRhi` kill-switch
// (RHI pattern twin vs raw native draw) in ONE served bundle — DC must be 0. Requires the
// dead-layer-elim fillPattern guard (else the pattern layer is dropped → solid fallback).
//
//   cd playground
//   ./node_modules/.bin/playwright test e2e/_fill-pattern-dc0.spec.ts --headed --reporter=line

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'

type W = {
  __xgisReady?: boolean
  __xgisVtrFillRhiDraws?: number
  __xgisVtrFillViaRhi?: boolean
  __xgisMap?: {
    invalidate?: () => void
    showCommands?: Array<{ fillPattern?: unknown; fillPatternUV?: unknown }>
  }
}

test('fill-pattern raw↔RHI DC=0 (local, real-GPU)', async ({ page }) => {
  test.setTimeout(70_000)
  const errs: string[] = []
  page.on('pageerror', (e) => errs.push(e.message))
  await page.setViewportSize({ width: 600, height: 600 })
  await page.goto('/demo.html?id=fixture_fill_pattern&e2e=1&sprite=/fixture-sprite', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as W).__xgisReady === true, null, { timeout: 30_000 })

  await page.evaluate(() => (window as unknown as { __xgisMap?: { jumpTo?: (o: object) => void } }).__xgisMap?.jumpTo?.({ center: [0, 0], zoom: 1.5 }))
  const uvResolved = await page.waitForFunction(() => {
    const shows = (window as unknown as W).__xgisMap?.showCommands ?? []
    return shows.some((s) => s.fillPattern != null && s.fillPatternUV != null)
  }, null, { timeout: 25_000 }).then(() => true).catch(() => false)

  const drawsRhi = await page.evaluate(() => (window as unknown as W).__xgisVtrFillRhiDraws ?? 0)
  console.log(`uvResolved=${uvResolved} fillRhiDraws=${drawsRhi} pageErrors=${errs.length}`)

  const rhiBuf = await page.locator('#map').screenshot()
  await page.evaluate(() => { (window as unknown as W).__xgisVtrFillViaRhi = false; (window as unknown as W).__xgisMap?.invalidate?.() })
  await page.waitForTimeout(2000)
  const rawBuf = await page.locator('#map').screenshot()

  const a = PNG.sync.read(rhiBuf), b = PNG.sync.read(rawBuf)
  // The bottom ~50px of #map is the demo CAPTION (a DOM text overlay, not the rendered
  // map) whose sub-pixel text AA differs between two screenshots. Gate DC on the MAP
  // region only — mask the caption strip.
  const CAPTION_H = 55
  const mapRows = a.height - CAPTION_H
  const diff = new PNG({ width: a.width, height: a.height })
  const nd = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0, diffMask: false })
  let mapDiff = 0, maxD = 0; const distinct = new Set<number>()
  for (let y = 0; y < mapRows; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = (y * a.width + x) * 4
      let d = false
      for (let c = 0; c < 3; c++) { const dc = Math.abs(a.data[i + c] - b.data[i + c]); if (dc > 0) d = true; maxD = Math.max(maxD, dc) }
      if (d) mapDiff++
      distinct.add((a.data[i] << 16) | (a.data[i + 1] << 8) | a.data[i + 2])
    }
  }
  const { writeFileSync, mkdirSync } = await import('node:fs')
  mkdirSync('test-results/fp-dc0', { recursive: true })
  writeFileSync('test-results/fp-dc0/rhi.png', PNG.sync.write(a))
  writeFileSync('test-results/fp-dc0/raw.png', PNG.sync.write(b))
  writeFileSync('test-results/fp-dc0/diff.png', PNG.sync.write(diff))
  console.log(`DC: fullDiffPx=${nd} MAP-region diffPx=${mapDiff} maxΔ=${maxD} | distinctColors=${distinct.size}`)

  expect(uvResolved, 'fill-pattern UV must resolve (pattern path exercised)').toBe(true)
  expect(drawsRhi, 'pattern fill must route through the RHI seam').toBeGreaterThan(0)
  expect(distinct.size, 'RHI frame must be non-blank').toBeGreaterThan(2)
  expect(mapDiff, 'raw↔RHI fill-pattern (map region) must be byte-identical (DC=0)').toBe(0)
})
