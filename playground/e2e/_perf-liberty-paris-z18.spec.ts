// User-reported 2026-05-20: OFM Liberty perf problem at
// #18.25/48.84778/2.33194/14/70 (Paris, z=18.25, pitch=70, bearing=14).
//
// Probe: measure idle frame time, drag-pan p95, tile/label counts at
// this exact view. Output goes to OUT/REPORT.md for follow-up
// optimisation work.

import { test, expect } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(
  resolve(HERE, '__convert-fixtures', 'liberty.json'), 'utf8',
)
const OUT = resolve(HERE, '__perf-liberty-paris-z18__')
mkdirSync(OUT, { recursive: true })

test('OFM Liberty perf probe — #18.25/48.84778/2.33194/14/70', async ({ page }) => {
  page.on('console', (msg) => {
    if (msg.type() === 'warning' || msg.type() === 'error') {
      // eslint-disable-next-line no-console
      console.warn('[page]', msg.text())
    }
  })
  const xgis = convertMapboxStyle(JSON.parse(fixture) as never)
  await page.addInitScript((args) => {
    sessionStorage.setItem('__xgisImportSource', args.src)
    sessionStorage.setItem('__xgisImportLabel', `Liberty z=18.25 pitch=70 Paris`)
  }, { src: xgis })
  await page.goto(`/demo.html?id=__import#18.25/48.84778/2.33194/14/70`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 60_000 },
  )
  await page.waitForTimeout(8_000) // settle — z=18 takes longer to load all tiles
  // Visual sanity check — write screenshot for inspection.
  const initialBuf = await page.locator('canvas').first().screenshot()
  writeFileSync(join(OUT, 'xgis.png'), initialBuf)

  // ── Idle frame time (no interaction) ──
  const idleMetrics = await page.evaluate(async () => {
    const m = (globalThis as { __xgisMap?: { invalidate: () => void; stats: unknown } }).__xgisMap
    if (!m) return null
    const frames: number[] = []
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now()
      m.invalidate()
      await new Promise<void>(r => requestAnimationFrame(() => r()))
      frames.push(performance.now() - t0)
    }
    frames.sort((a, b) => a - b)
    return {
      median: frames[15],
      p95: frames[28],
      max: frames[29],
      stats: m.stats,
    }
  })

  // ── Drag pan p95 ──
  const dragMetrics = await page.evaluate(async () => {
    const m = (globalThis as { __xgisMap?: { invalidate: () => void; panBy: (offset: [number, number]) => void } }).__xgisMap
    if (!m) return null
    const frames: number[] = []
    for (let i = 0; i < 60; i++) {
      const t0 = performance.now()
      m.panBy([8, 0]) // 8px horizontal pan per frame
      m.invalidate()
      await new Promise<void>(r => requestAnimationFrame(() => r()))
      frames.push(performance.now() - t0)
    }
    frames.sort((a, b) => a - b)
    return { median: frames[30], p95: frames[57], max: frames[59] }
  })

  const lines: string[] = []
  lines.push('# Liberty Paris z=18.25 pitch=70 perf probe')
  lines.push('')
  lines.push(`view: #18.25/48.84778/2.33194/14/70`)
  lines.push('')
  lines.push('## Idle frame time (30 frames, no interaction)')
  if (idleMetrics) {
    lines.push(`- median: ${idleMetrics.median.toFixed(2)} ms`)
    lines.push(`- p95: ${idleMetrics.p95.toFixed(2)} ms`)
    lines.push(`- max: ${idleMetrics.max.toFixed(2)} ms`)
    lines.push('')
    lines.push('## Draw stats')
    lines.push('```json')
    lines.push(JSON.stringify(idleMetrics.stats, null, 2))
    lines.push('```')
  } else {
    lines.push('(map not exposed)')
  }
  lines.push('')
  lines.push('## Drag pan (60 frames, 8 px/frame horizontal)')
  if (dragMetrics) {
    lines.push(`- median: ${dragMetrics.median.toFixed(2)} ms`)
    lines.push(`- p95: ${dragMetrics.p95.toFixed(2)} ms`)
    lines.push(`- max: ${dragMetrics.max.toFixed(2)} ms`)
  }

  const report = lines.join('\n')
  writeFileSync(join(OUT, 'REPORT.md'), report)
  // eslint-disable-next-line no-console
  console.warn(report)
  expect(idleMetrics).not.toBeNull()
})
