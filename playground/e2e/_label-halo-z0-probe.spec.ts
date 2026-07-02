// z0 label-halo probe (user report #1, 2026-05-19).
//
// "줌레벨 0에서 라벨 할로가 너무 크게 평가되는 문제" on OFM bright.
// iter-151 code-read ruled the packUniforms formula correct
// (haloWidthNorm = halo.width·3/(def.size·dpr) == MapLibre's
// halo·3/sizePx, dpr cancels) and narrowed the question to what the
// LIVE pipeline RESOLVES at z0 — resolved text-size and halo width —
// which a unit probe cannot reach. This reads map.getHaloDebug()
// (iter-152 instrumentation) at z0 vs a deeper zoom on the real OFM
// bright style and emits the numbers so the divergence (if any) is
// localised to resolved-size vs halo-width vs the pack math.
//
// memory project_z0_halo_too_large_2026_05_19.

import { test, type Page } from '@playwright/test'
// Relative deep import (charter): Playwright transpiles specs in raw Node — the @xgis/* workspace alias does not resolve here, so specs import package SOURCES relatively (see _glsl-compile-gate.spec.ts).
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(
  resolve(__dirname, '__convert-fixtures', 'bright.json'), 'utf8',
)
const OUT = resolve(__dirname, '__label-halo-z0-probe__')
mkdirSync(OUT, { recursive: true })

interface HaloRow {
  text: string; fontSize: number; rasterFontSize: number
  haloWidth: number; haloWidthNorm: number
}

async function setup(page: Page, hash: string): Promise<void> {
  const xgis = convertMapboxStyle(fixture)
  await page.addInitScript((src) => {
    sessionStorage.setItem('__xgisImportSource', src)
    sessionStorage.setItem('__xgisImportLabel', 'Bright')
  }, xgis)
  await page.goto(`/demo.html?id=__import${hash}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(3_000)
}

async function readHalo(page: Page): Promise<HaloRow[]> {
  return page.evaluate(() => {
    const m = (window as unknown as {
      __xgisMap?: { getHaloDebug?: () => HaloRow[] | null }
    }).__xgisMap
    return m?.getHaloDebug?.() ?? []
  }) as Promise<HaloRow[]>
}

function summarise(rows: HaloRow[]): {
  n: number; maxNorm: number; medNorm: number
  sample: HaloRow | undefined
} {
  const haloed = rows.filter(r => r.haloWidth > 0)
  const norms = haloed.map(r => r.haloWidthNorm).sort((a, b) => a - b)
  return {
    n: haloed.length,
    maxNorm: norms.length ? +norms[norms.length - 1]!.toFixed(4) : 0,
    medNorm: norms.length ? +norms[Math.floor(norms.length / 2)]!.toFixed(4) : 0,
    sample: haloed.find(r => r.haloWidthNorm === norms[norms.length - 1]),
  }
}

test.describe.configure({ mode: 'serial' })

test('label-halo z0 vs z6 — OFM bright', async ({ page }) => {
  test.setTimeout(90_000)

  await setup(page, '#0/20/0/0/0')
  const z0 = summarise(await readHalo(page))

  await setup(page, '#6/37.55/126.98/0/0')
  const z6 = summarise(await readHalo(page))

  const lines = [
    '# z0 label-halo probe — OFM bright',
    '',
    `Run: ${new Date().toISOString()}`,
    '',
    'haloWidthNorm = the buf[12] the shader receives = halo extends',
    'this far (in [0,1] SDF space) inward from the ~0.75 edge. A',
    'value approaching/exceeding ~0.4 means the halo eats most of the',
    'glyph SDF range = the reported oversized z0 halo.',
    '',
    '| zoom | haloed labels | median norm | max norm | widest-label sample |',
    '|---|--:|--:|--:|---|',
    `| z0 | ${z0.n} | ${z0.medNorm} | ${z0.maxNorm} | ${z0.sample ? `"${z0.sample.text}" size=${z0.sample.fontSize.toFixed(1)} raster=${z0.sample.rasterFontSize} haloW=${z0.sample.haloWidth}` : '—'} |`,
    `| z6 | ${z6.n} | ${z6.medNorm} | ${z6.maxNorm} | ${z6.sample ? `"${z6.sample.text}" size=${z6.sample.fontSize.toFixed(1)} raster=${z6.sample.rasterFontSize} haloW=${z6.sample.haloWidth}` : '—'} |`,
    '',
    'Diagnosis split:',
    '- z0 maxNorm ≫ z6 maxNorm AND z0 sample.fontSize small →',
    '  resolved text-size collapses at z0 (zoom-interp / clamp);',
    '  halo-width is constant px so norm = halo·3/size blows up.',
    '  Fix is upstream in size resolution, NOT the pack formula.',
    '- z0 sample.haloWidth ≫ authored text-halo-width → halo-width',
    '  resolution bug.',
    '- z0 ≈ z6 and both moderate → X-GIS matches MapLibre; the',
    '  report is a perceptual/other-projection effect, reclassify.',
  ]
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n'))
  // eslint-disable-next-line no-console
  console.log(
    `[halo-z0] z0 n=${z0.n} medNorm=${z0.medNorm} maxNorm=${z0.maxNorm}`
    + ` | z6 n=${z6.n} medNorm=${z6.medNorm} maxNorm=${z6.maxNorm}`,
  )
})
