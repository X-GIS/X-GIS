// Visual parity probe between MapLibre GL JS and X-GIS, both
// rendering the SAME style.json. Drives the compare.html page that
// mounts both engines side-by-side with synchronised camera. For
// each (style × camera) preset, screenshots each canvas, runs
// pixelmatch, and writes the two source PNGs + diff overlay PNG +
// JSON metrics into `__style-parity-diff__/<fixture>__<name>/`.
//
// Soft gate by design — symbol rendering is not implemented in X-GIS
// yet (Batch 1c on the roadmap), so OFM styles will show a multi-percent
// diff in label-dense scenes. The job here is to *capture* the
// difference, not gate it. Once symbols ship, per-preset thresholds
// can be added next to PRESETS and the soft-log calls flipped to
// expect().
//
// Future toggle (not yet implemented): `?noSymbols=1` query on
// compare.html would strip symbol layers from MapLibre before mount,
// for a labels-removed apples-to-apples comparison. Until then the
// captured metrics include the symbol-layer gap.

import { test, expect } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pixelmatch from 'pixelmatch'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__style-parity-diff__')
mkdirSync(OUT, { recursive: true })

// Per-preset diffRatio ceilings. Source of truth in BASELINES.json so
// the gate can be rebased without touching the spec — every edit must
// land in a PR that explains the regression / improvement.
interface BaselineDoc {
  _doc: string
  _headroom: number
  presets: Record<string, number>
}
const BASELINES: BaselineDoc = JSON.parse(
  readFileSync(join(OUT, 'BASELINES.json'), 'utf8'),
) as BaselineDoc

interface Preset {
  fixture: string  // style id in compare-runner.ts STYLES catalogue
  name: string     // human label for the camera framing
  hash: string     // #z/lat/lon[/bearing/pitch] — applied via URL fragment
}

const PRESETS: Preset[] = [
  { fixture: 'maplibre-demotiles',   name: 'world',     hash: '#1/0/0' },
  { fixture: 'openfreemap-bright',   name: 'world',     hash: '#2/20/0' },
  { fixture: 'openfreemap-bright',   name: 'tokyo',     hash: '#12/35.68/139.76' },
  { fixture: 'openfreemap-bright',   name: 'manhattan', hash: '#14/40.78/-73.97/0/45' },
  { fixture: 'openfreemap-liberty',  name: 'tokyo',     hash: '#12/35.68/139.76' },
  { fixture: 'openfreemap-positron', name: 'world',     hash: '#2/20/0' },
]

interface PresetMetric extends Preset {
  width: number
  height: number
  diffPixels: number
  diffRatio: number
  threshold: number
  durationMs: number
  timestamp: string
}

const metrics: PresetMetric[] = []

for (const preset of PRESETS) {
  test(`parity: ${preset.fixture} — ${preset.name}`, async ({ page }) => {
    test.setTimeout(120_000)

    const t0 = Date.now()
    await page.setViewportSize({ width: 1280, height: 800 })

    const consoleErrors: string[] = []
    page.on('pageerror', (e) => consoleErrors.push(`[pageerror] ${e.message}`))
    page.on('console', (m) => {
      if (m.type() !== 'error') return
      const t = m.text()
      if (t.includes('vite/dist/client')) return
      if (t.includes('Failed to load resource')) return
      consoleErrors.push(t)
    })

    await page.goto(`/compare.html?style=${preset.fixture}${preset.hash}`, {
      waitUntil: 'domcontentloaded',
    })
    // Wait for both engines to signal ready (mount complete).
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean; __mlReady?: boolean })
        .__xgisReady === true
        && (window as unknown as { __mlReady?: boolean }).__mlReady === true,
      null, { timeout: 60_000 },
    )
    // Wait for BOTH engines to reach a steady render state. The
    // previous `waitForTimeout(6_000)` was the source of the ~20 %
    // intermittent spike we saw on Bright Tokyo (last-frame caught
    // a tile mid-upload): tile fetch / decode / pipeline-create are
    // all async, and 6 s wasn't long enough on a cold server. Both
    // sides have an authoritative "settled" signal:
    //   - MapLibre fires `idle` when no more tiles + no animations
    //     + no fade are pending.
    //   - X-GIS has no direct event; we proxy by polling tile-cache
    //     size for 500 ms of no change.
    await page.evaluate(() => new Promise<void>((resolve) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ml = (window as any).__mlMap
      if (!ml) { resolve(); return }
      // Already idle? loaded() === true means there's nothing in-flight.
      if (ml.loaded()) { resolve(); return }
      ml.once('idle', () => resolve())
      // Hard cap so a misbehaving style doesn't hang the whole spec.
      setTimeout(resolve, 30_000)
    }))
    await page.waitForFunction(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const map = (window as any).__xgisMap
      if (!map?.vtSources) return true  // no VT sources → nothing to settle
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const w = window as any
      let total = 0
      for (const entry of map.vtSources.values()) {
        total += entry.renderer?.getCacheSize?.() ?? 0
      }
      const prev = w.__xgisParityCacheSnapshot ?? -1
      w.__xgisParityCacheSnapshot = total
      if (prev !== total) {
        w.__xgisParityCacheStableSince = Date.now()
        return false
      }
      const stableMs = Date.now() - (w.__xgisParityCacheStableSince ?? Date.now())
      return stableMs >= 500
    }, null, { timeout: 30_000, polling: 100 })
    // Belt-and-suspenders frame settle — one rAF round to let the
    // last drained-tile upload's render call commit to the swap chain.
    await page.evaluate(() => new Promise<void>(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))))

    // Capture + diff + retry-on-catastrophe. Roughly 1 in 30 cold
    // mounts EITHER canvas comes up blank (X-GIS WebGPU init race
    // or MapLibre worker race), yielding a 50-80 %+ diff that's
    // really an init failure, not a rendering correctness issue.
    // Take a snapshot, compute the diff, and if it looks
    // catastrophic (> 25 % — well above every legitimate baseline)
    // give it another 8 s + rAF round and re-snapshot. The
    // determinism gates above make the second pass byte-identical
    // to the steady-state.
    const cropped = (src: PNG, w: number, h: number): PNG => {
      const out = new PNG({ width: w, height: h })
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const si = (y * src.width + x) * 4
          const di = (y * w + x) * 4
          out.data[di] = src.data[si]!
          out.data[di + 1] = src.data[si + 1]!
          out.data[di + 2] = src.data[si + 2]!
          out.data[di + 3] = src.data[si + 3]!
        }
      }
      return out
    }
    const captureAndDiff = async (): Promise<{
      diff: PNG; diffPixels: number; diffRatio: number; w: number; h: number; mlNorm: PNG; xgNorm: PNG
    }> => {
      const mlPng = await page.locator('#ml-map canvas').first().screenshot()
      const xgPng = await page.locator('#xg-canv').screenshot()
      const ml = PNG.sync.read(mlPng)
      const xg = PNG.sync.read(xgPng)
      const w = Math.min(ml.width, xg.width)
      const h = Math.min(ml.height, xg.height)
      const mlNorm = ml.width === w && ml.height === h ? ml : cropped(ml, w, h)
      const xgNorm = xg.width === w && xg.height === h ? xg : cropped(xg, w, h)
      const d = new PNG({ width: w, height: h })
      const px = pixelmatch(mlNorm.data, xgNorm.data, d.data, w, h,
        { threshold: 0.15, includeAA: false })
      return { diff: d, diffPixels: px, diffRatio: px / (w * h), w, h, mlNorm, xgNorm }
    }
    // Catastrophe = first capture diff exceeds 2× the gate ceiling.
    // Below 2× could still be a real regression worth investigating;
    // above 2× is almost always an init race (canvas fully blank vs
    // fully rendered = 70 %+ diff is the typical pattern). The
    // baseline + headroom together give a per-preset "expected
    // good" upper bound, so 2× of that is the natural cutoff.
    const baselineForRetry = BASELINES.presets[`${preset.fixture}__${preset.name.replace(/[^a-z0-9]+/gi, '-')}`]
    const catastropheCeiling = baselineForRetry !== undefined
      ? baselineForRetry * BASELINES._headroom * 2
      : 0.30  // no baseline registered → 30 % absolute
    let result = await captureAndDiff()
    // Two retries — empirically each retry recovers about half the
    // catastrophes (one 74 % → 8.8 %, but the other 69 % → 19 % which
    // is still way above the gate). Two passes catches both.
    for (let attempt = 1; attempt <= 2 && result.diffRatio > catastropheCeiling; attempt++) {
      // eslint-disable-next-line no-console
      console.log(
        `[parity] ${preset.fixture}__${preset.name} catastrophic ` +
        `(${(result.diffRatio * 100).toFixed(1)} %, attempt ${attempt}/2) — retry after 15 s`,
      )
      await page.waitForTimeout(15_000)
      await page.evaluate(() => new Promise<void>(r =>
        requestAnimationFrame(() => requestAnimationFrame(() => r()))))
      result = await captureAndDiff()
    }
    const { diff, diffPixels, diffRatio, w, h, mlNorm, xgNorm } = result

    const slug = `${preset.fixture}__${preset.name.replace(/[^a-z0-9]+/gi, '-')}`
    const dir = join(OUT, slug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'maplibre.png'), PNG.sync.write(mlNorm))
    writeFileSync(join(dir, 'xgis.png'), PNG.sync.write(xgNorm))
    writeFileSync(join(dir, 'diff.png'), PNG.sync.write(diff))

    const metric: PresetMetric = {
      ...preset,
      width: w, height: h,
      diffPixels, diffRatio,
      threshold: 0.15,
      durationMs: Date.now() - t0,
      timestamp: new Date().toISOString(),
    }
    writeFileSync(join(dir, 'metrics.json'), JSON.stringify(metric, null, 2))
    metrics.push(metric)

    // eslint-disable-next-line no-console
    console.log(`[parity] ${slug}  ${w}×${h}  ` +
      `diffPixels=${diffPixels}  diffRatio=${(diffRatio * 100).toFixed(2)}%  ` +
      `consoleErrors=${consoleErrors.length}`)
    if (consoleErrors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[parity] ${slug} errors:\n` + consoleErrors.map(e => '  - ' + e).join('\n'))
    }

    // Hard gate. Diff ratio must stay below the per-preset baseline
    // × headroom. A failure here means VISIBLE drift from the last
    // captured-good state — investigate the diff PNG, then either fix
    // the cause or update BASELINES.json explicitly in the same PR.
    const baseline = BASELINES.presets[slug]
    if (baseline !== undefined) {
      const ceiling = baseline * BASELINES._headroom
      expect(
        diffRatio,
        `${slug} diffRatio=${(diffRatio * 100).toFixed(2)}% exceeded ` +
        `baseline ${(baseline * 100).toFixed(2)}% × headroom ${BASELINES._headroom} ` +
        `(=${(ceiling * 100).toFixed(2)}%). Investigate the diff PNG at ` +
        `__style-parity-diff__/${slug}/diff.png. If the regression is intentional ` +
        `update BASELINES.json with a note explaining what changed.`,
      ).toBeLessThanOrEqual(ceiling)
    }
  })
}

test.afterAll(() => {
  if (metrics.length === 0) return
  metrics.sort((a, b) => a.fixture.localeCompare(b.fixture) || a.name.localeCompare(b.name))
  writeFileSync(join(OUT, 'REPORT.json'), JSON.stringify(metrics, null, 2))

  const lines: string[] = []
  lines.push('# Style parity diff report')
  lines.push('')
  lines.push(`Generated ${new Date().toISOString()} by \`_style-parity-diff.spec.ts\`.`)
  lines.push('')
  lines.push('| Fixture | Preset | Size | Diff pixels | Diff ratio |')
  lines.push('|---|---|---:|---:|---:|')
  for (const m of metrics) {
    lines.push(`| ${m.fixture} | ${m.name} | ${m.width}×${m.height} | ${m.diffPixels} | ${(m.diffRatio * 100).toFixed(2)}% |`)
  }
  lines.push('')
  lines.push('Soft-gated — diffs include the expected symbol-layer gap.')
  lines.push('See `<fixture>__<preset>/diff.png` for visualisations.')
  writeFileSync(join(OUT, 'REPORT.md'), lines.join('\n') + '\n')
})
