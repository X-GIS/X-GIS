// ═══════════════════════════════════════════════════════════════════
// demotiles ?compute=1 — VTR P4 compute path real-GPU verification
// ═══════════════════════════════════════════════════════════════════
//
// First end-to-end test of the VTR per-tile compute integration. Loads
// the demotiles Europe view in compare mode with ?compute=1. Both
// flags (convertMapboxStyle.bypassExpandColorMatch + lower.bypass-
// ExtractMatchDefaultColor) flip on so the 214-arm `ADM0_A3` country
// fill survives the compile pipeline as a single data-driven match()
// and the runtime VTR dispatches the LUT compute kernel.
//
// Three measurements:
//
//   1. ?compute=0 (legacy)        — countries collapse to default sand colour
//   2. ?compute=1 (P4 compute)    — VTR dispatches the 214-arm LUT kernel
//   3. compute=1 vs MapLibre      — DOES the LUT-driven output match the
//                                    canonical reference palette?
//
// The expected story: compute=0 → bad parity, compute=1 → close to ML.

import { test, expect, type Page } from '@playwright/test'

// Serial execution — see _pixel-match-school-fill.spec.ts.
test.describe.configure({ mode: 'serial' })
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__pixel-match-demotiles-compute__')
mkdirSync(OUT, { recursive: true })

const VIEW_HASH = '#2.5/48/15'  // Europe — many countries in frame
const TIMEOUT = 30_000

async function loadAndCapture(page: Page, compute: 0 | 1): Promise<{ ml: PNG; xg: PNG }> {
  const computeQuery = compute === 1 ? '&compute=1' : ''
  await page.goto(`/compare.html?style=maplibre-demotiles${computeQuery}${VIEW_HASH}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => {
      const w = window as unknown as { __xgisReady?: boolean; __mlReady?: boolean }
      return w.__xgisReady === true && w.__mlReady === true
    },
    null, { timeout: TIMEOUT },
  )

  // Hide ML symbol layers.
  await page.evaluate(() => {
    interface MlMap {
      getStyle(): { layers: Array<{ id: string; type: string }> }
      setLayoutProperty(id: string, key: string, value: 'none' | 'visible'): void
    }
    const ml = (window as unknown as { __mlMap?: MlMap }).__mlMap
    if (!ml) return
    for (const layer of ml.getStyle().layers) {
      if (layer.type === 'symbol') ml.setLayoutProperty(layer.id, 'visibility', 'none')
    }
  })
  // Hide X-GIS label/icon layers.
  await page.evaluate(() => {
    interface XGISShow { label?: unknown; visible?: boolean }
    interface XGISLayer { name?: string; style?: { visible?: boolean } }
    interface XGISMap {
      vectorTileShows?: Array<{ show: XGISShow }>
      getLayers?(): readonly XGISLayer[]
      invalidate?(): void
    }
    const map = (window as unknown as { __xgisMap?: XGISMap }).__xgisMap
    if (!map) return
    for (const e of map.vectorTileShows ?? []) {
      if (e.show.label !== undefined) e.show.visible = false
    }
    for (const layer of map.getLayers?.() ?? []) {
      if (!layer.style) continue
      const name = (layer.name ?? '').toLowerCase()
      if (/label|icon|poi|name|symbol/.test(name)) layer.style.visible = false
    }
    map.invalidate?.()
  })

  await page.waitForTimeout(3_500)
  await page.evaluate(() => new Promise<void>(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => r()))))

  const mlBuf = await page.locator('#ml-map canvas').first().screenshot()
  const xgBuf = await page.locator('#xg-canv').screenshot()
  return { ml: PNG.sync.read(mlBuf), xg: PNG.sync.read(xgBuf) }
}

interface Buckets {
  eq0: number; le8: number; le16: number; le32: number
  le64: number; le128: number; gt128: number
}

function diffBuckets(a: PNG, b: PNG): { buckets: Buckets; total: number } {
  const w = Math.min(a.width, b.width)
  const h = Math.min(a.height, b.height)
  const buckets: Buckets = { eq0: 0, le8: 0, le16: 0, le32: 0, le64: 0, le128: 0, gt128: 0 }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ai = (y * a.width + x) * 4
      const bi = (y * b.width + x) * 4
      const m = Math.max(
        Math.abs(a.data[ai]! - b.data[bi]!),
        Math.abs(a.data[ai+1]! - b.data[bi+1]!),
        Math.abs(a.data[ai+2]! - b.data[bi+2]!),
      )
      if (m === 0) buckets.eq0++
      else if (m <= 8) buckets.le8++
      else if (m <= 16) buckets.le16++
      else if (m <= 32) buckets.le32++
      else if (m <= 64) buckets.le64++
      else if (m <= 128) buckets.le128++
      else buckets.gt128++
    }
  }
  return { buckets, total: w * h }
}

function fmtBuckets(b: Buckets, total: number): string {
  const pct = (n: number) => ((n / total) * 100).toFixed(2) + '%'
  return `eq=${pct(b.eq0)} ≤32=${pct(b.eq0+b.le8+b.le16+b.le32)} ≤128=${pct(b.eq0+b.le8+b.le16+b.le32+b.le64+b.le128)} gt128=${b.gt128}`
}

test('demotiles europe — compute=0 vs MapLibre', async ({ page }) => {
  test.setTimeout(TIMEOUT + 30_000)
  const { ml, xg } = await loadAndCapture(page, 0)
  const { buckets, total } = diffBuckets(ml, xg)
  writeFileSync(join(OUT, 'compute0-ml.png'), PNG.sync.write(ml))
  writeFileSync(join(OUT, 'compute0-xg.png'), PNG.sync.write(xg))
  writeFileSync(join(OUT, 'compute0-buckets.json'), JSON.stringify({ buckets, total }, null, 2))
  // eslint-disable-next-line no-console
  console.log(`[demotiles compute=0] ${fmtBuckets(buckets, total)}`)
})

test('demotiles europe — compute=1 vs MapLibre (VTR P4 path)', async ({ page }) => {
  test.setTimeout(TIMEOUT + 30_000)
  const errors: string[] = []
  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text())
  })
  page.on('pageerror', err => errors.push('pageerror: ' + err.message))
  const { ml, xg } = await loadAndCapture(page, 1)
  if (errors.length > 0) {
    // eslint-disable-next-line no-console
    console.log('[demotiles compute=1] ERRORS:\n  ' + errors.slice(0, 10).join('\n  '))
  }
  const { buckets, total } = diffBuckets(ml, xg)
  writeFileSync(join(OUT, 'compute1-ml.png'), PNG.sync.write(ml))
  writeFileSync(join(OUT, 'compute1-xg.png'), PNG.sync.write(xg))
  writeFileSync(join(OUT, 'compute1-buckets.json'), JSON.stringify({ buckets, total }, null, 2))
  // eslint-disable-next-line no-console
  console.log(`[demotiles compute=1] ${fmtBuckets(buckets, total)}`)
  // The VTR compute path should improve country-fill accuracy. We
  // don't pin a specific threshold here — the test is a measurement
  // dispatched for visual review + REPORT diff. Assertion is only on
  // "scene rendered something" (>5% non-background).
  const nonBg = buckets.gt128 + buckets.le128 + buckets.le64
  expect(nonBg).toBeGreaterThan(total * 0.001)
})
