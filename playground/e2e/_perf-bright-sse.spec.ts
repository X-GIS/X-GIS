// A/B comparison: SSE selector (`__XGIS_USE_SSE_SELECTOR = true`) vs
// the existing `visibleTilesFrustum` / `visibleTilesFrustumSampled`
// pair. Both run on the same Bright fixture at z=14 Tokyo across the
// pitch sweep so we can see whether the new metric solves the
// foreshortening problem.

import { test, type Page } from '@playwright/test'
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixture = readFileSync(resolve(__dirname, '__convert-fixtures/bright.json'), 'utf8')

const PITCHES = [0, 40, 60, 80]
const SAMPLE_MS = 3000

interface Sample {
  median: number
  p95: number
  frames: number
  tilesVisible: number
  drawCalls: number
}

async function measureAt(page: Page, pitch: number, _useSSE: boolean): Promise<Sample> {
  // Toggle is installed via context.addInitScript before page creation
  // (see test body). All we do here is navigate, settle, and sample.
  await page.goto(`/demo.html?id=__import#14/35.68/139.76/0/${pitch}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  await page.waitForTimeout(5_000)

  const out = await page.evaluate(async (durationMs: number) => {
    const frames: number[] = []
    let last = performance.now()
    const start = last
    return await new Promise<{ frames: number[]; pipeline: unknown }>((res) => {
      const tick = () => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        if (now - start < durationMs) requestAnimationFrame(tick)
        else {
          const map = (window as unknown as {
            __xgisMap?: { inspectPipeline?: () => unknown }
          }).__xgisMap
          const pipeline = map?.inspectPipeline?.()
          res({ frames, pipeline })
        }
      }
      requestAnimationFrame(tick)
    })
  }, SAMPLE_MS)

  const sorted = [...out.frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0
  const pipeline = out.pipeline as { sources?: Array<{ frame?: { tilesVisible?: number; drawCalls?: number } }> } | null
  const f = pipeline?.sources?.[0]?.frame
  return {
    median, p95,
    frames: out.frames.length,
    tilesVisible: f?.tilesVisible ?? -1,
    drawCalls: f?.drawCalls ?? -1,
  }
}

test('Bright SSE-selector A/B sweep at z=14 Tokyo', async ({ browser }) => {
  test.setTimeout(360_000)
  const xgis = convertMapboxStyle(fixture)
  const rows: { pitch: number; sel: string; sample: Sample }[] = []

  for (const pitch of PITCHES) {
    for (const useSSE of [false, true]) {
      // Fresh context per measurement so addInitScript doesn't
      // accumulate stale flags from the previous run.
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } })
      await ctx.addInitScript((src: string) => {
        sessionStorage.setItem('__xgisImportSource', src)
        sessionStorage.setItem('__xgisImportLabel', 'Bright (SSE A/B)')
      }, xgis)
      await ctx.addInitScript((flag: boolean) => {
        ;(window as unknown as { __XGIS_USE_SSE_SELECTOR?: boolean }).__XGIS_USE_SSE_SELECTOR = flag
      }, useSSE)
      const page = await ctx.newPage()
      const sample = await measureAt(page, pitch, useSSE)
      rows.push({ pitch, sel: useSSE ? 'SSE' : 'frustum', sample })
      await ctx.close()
    }
  }

  // eslint-disable-next-line no-console
  console.log('\n=== Bright pitch sweep — SSE selector A/B ===\n')
  // eslint-disable-next-line no-console
  console.log('pitch  selector    median (fps)        p95     tiles  drawCalls')
  // eslint-disable-next-line no-console
  console.log('-----  ----------  ------------------  ------  -----  ---------')
  for (const r of rows) {
    const label = r.sel.padEnd(10)
    const fps = r.sample.median > 0 ? (1000 / r.sample.median).toFixed(0).padStart(3) : '---'
    // eslint-disable-next-line no-console
    console.log(
      `  ${r.pitch.toString().padStart(2)}°  ${label}  ${r.sample.median.toFixed(1).padStart(6)} ms (${fps} fps)  ${r.sample.p95.toFixed(0).padStart(4)}ms  ${r.sample.tilesVisible.toString().padStart(5)}  ${r.sample.drawCalls.toString().padStart(9)}`,
    )
  }
})
