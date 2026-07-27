import { test, expect, type Page } from '@playwright/test'

// PITCH COST SWEEP — diagnostic for #1367 ("performance drops sharply when
// LOWERING pitch"). Reports; it does not gate.
//
// Hypothesis under test, from _mobile-overdraw-flat-pitch.spec.ts's header
// (real-device iPhone, Tokyo z=11.5, pitch 0, 430x429 canvas):
//
//     drawn by zoom : z=10:6  z=11:24  z=12:60    <- 90 draws
//     viewport math : ~6 unique tiles needed for z=12
//
// At HIGH pitch, drawing several zoom levels at once is correct — each z
// covers a different distance band. At FLAT pitch every z covers the SAME
// pixels, so it is pure overdraw and the cost scales with fill rate rather
// than tile count. The signature to look for is therefore the per-zoom drawn
// histogram showing >=2 levels with large counts as pitch approaches 0.
//
// REQUIRES A DENSE MULTI-LAYER SOURCE. Against a sparse fixture the effect is
// not reachable: a control run on `physical_map` (3 sparse 110m GeoJSON
// sources, z=10.35) measured the OPPOSITE — draws 7->4 and triangles 1095->8
// as pitch fell, with multi-z drawing appearing only ABOVE 60 deg. That result
// is sound but non-probative, which is why this spec defaults to a PMTiles
// demo and says so loudly when the source has no data.
//
// As of writing, every dense vector fixture in this repo needs network egress
// (`pmtiles_layered` -> api.protomaps.com; the OFM gates -> a `/ofm-mirror`
// snapshot that is not committed; `physical_map_50m` -> 50m Natural Earth,
// excluded by .gitignore). That is the same step-1 blocker as #1349, and it is
// why this spec is NOT proposed for CI yet.
//
//   DEMO=pmtiles_layered CAM='#11.52/35.7553/139.6973/0/0' \
//   HEADED=0 XGIS_SOFTWARE_GPU=1 \
//     playwright test _perf-pitch-cost-sweep.spec.ts
//
// Absolute milliseconds under SwiftShader are meaningless; the RATIO across
// pitch is the signal, and drawCalls / triangles / the per-zoom histogram are
// rasterizer-independent.

const DEMO = process.env.DEMO ?? 'pmtiles_layered'
const CAM = process.env.CAM ?? '#11.52/35.7553/139.6973/0/0'
/** Mobile-class by default: it matches the original report AND puts the
 *  un-migrated budget sites into phone-grade caps (#1350). */
const VW = Number(process.env.VW ?? 430)
const VH = Number(process.env.VH ?? 715)
const PITCHES = (process.env.PITCHES ?? '60,50,40,30,20,10,0')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n))
/** Settle window per stop, ms. Raise on a slow link. */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 3500)

interface Sample {
  drawCalls: number
  triangles: number
  lines: number
  tilesVisible: number
  cacheEntries: number
  liveSources: number
  deadSources: string[]
  byZoom: Record<string, number>
}

async function sampleFrame(page: Page): Promise<Sample> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: {
        vtSources?: Map<
          string,
          { renderer: { _drawStats?: { _frameDrawnByZoom?: Map<number, number> } } }
        >
        inspectPipeline(): unknown
      }
    }
    const pipe = w.__xgisMap?.inspectPipeline() as
      | {
          sources?: Array<{
            name: string
            cache: { size: number; hasData?: boolean }
            frame: { drawCalls: number; triangles: number; lines: number; tilesVisible: number }
          }>
        }
      | undefined
    const acc: Sample = {
      drawCalls: 0,
      triangles: 0,
      lines: 0,
      tilesVisible: 0,
      cacheEntries: 0,
      liveSources: 0,
      deadSources: [],
      byZoom: {},
    }
    for (const s of pipe?.sources ?? []) {
      acc.drawCalls += s.frame.drawCalls
      acc.triangles += s.frame.triangles
      acc.lines += s.frame.lines
      acc.tilesVisible += s.frame.tilesVisible
      acc.cacheEntries += s.cache.size
      // Liveness, not just counters: #1364 Path B showed a dead source
      // reporting missedTiles=0 while `loaded()` was true. A cost sweep over
      // sources with no data would be equally meaningless.
      //
      // `__`-prefixed sources (the synthetic earth surface) are engine-injected
      // background, not style data — they are always present and would mask a
      // fully dead style. Their draw cost still counts above; only the liveness
      // verdict excludes them.
      if (s.name.startsWith('__')) continue
      if (s.cache.hasData && s.cache.size > 0) acc.liveSources++
      else acc.deadSources.push(s.name)
    }
    for (const entry of w.__xgisMap?.vtSources?.values() ?? []) {
      const bz = entry.renderer._drawStats?._frameDrawnByZoom
      if (bz && typeof bz.forEach === 'function') {
        bz.forEach((n: number, z: number) => {
          acc.byZoom[String(z)] = (acc.byZoom[String(z)] ?? 0) + n
        })
      }
    }
    return acc
  })
}

/** Drive N invalidate -> rAF -> rAF cycles and time each. */
async function frameCost(page: Page, frames: number): Promise<number[]> {
  return await page.evaluate(async (n) => {
    const m = (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      m?.invalidate?.()
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      out.push(performance.now() - t0)
    }
    return out
  }, frames)
}

function pct(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

async function waitReady(page: Page, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (
      await page.evaluate(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      )
    )
      return true
    await page.waitForTimeout(200)
  }
  return false
}

test.describe('pitch cost sweep (#1367 diagnostic)', () => {
  test.use({ viewport: { width: VW, height: VH } })

  test(`cost vs pitch on ${DEMO}`, async ({ page }) => {
    test.setTimeout(60_000 + PITCHES.length * (SETTLE_MS + 20_000))

    const warnings: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('arena-oom') || t.includes('FLICKER')) warnings.push(t.slice(0, 200))
    })

    await page.goto(`/demo.html?id=${DEMO}&e2e=1${CAM}`, { waitUntil: 'domcontentloaded' })
    const ready = await waitReady(page, 60_000)
    expect(ready, '__xgisReady never became true').toBe(true)
    await page.waitForTimeout(SETTLE_MS)

    const probe = await sampleFrame(page)
    if (probe.liveSources === 0) {
      // Do not report a cost curve measured over sources that hold no data —
      // that is the #1364 Path B trap. Fail loudly with the reason instead.
      throw new Error(
        `No source has data (dead: ${probe.deadSources.join(', ') || 'none named'}).\n` +
          `This sweep needs a dense multi-layer source that actually loaded. ` +
          `"${DEMO}" resolved to nothing — most likely no network egress to its ` +
          `tile/manifest host. See #1367 and #1349 (fixture provenance).`,
      )
    }

    const rows: string[] = []
    const header =
      '  pitch |  med ms   p90 ms |  draws    tris   lines   vis | cache | drawn-by-zoom'
    const rule = '  ------+------------------+------------------------------+-------+--------------'
    console.log(`\n  demo=${DEMO} viewport=${VW}x${VH} cam=${CAM}`)
    console.log(`  live sources=${probe.liveSources} dead=[${probe.deadSources.join(',')}]\n`)
    console.log(header)
    console.log(rule)

    for (let i = 0; i < PITCHES.length; i++) {
      await page.evaluate((p) => {
        ;(window as unknown as { __xgisMap?: { setPitch(p: number): void } }).__xgisMap?.setPitch(p)
      }, PITCHES[i])
      await page.waitForTimeout(SETTLE_MS)
      const times = await frameCost(page, 12)
      const s = await sampleFrame(page)
      const zs = Object.entries(s.byZoom)
        .sort((a, b) => Number(a[0]) - Number(b[0]))
        .map(([z, n]) => `z${z}:${n}`)
        .join(' ')
      const row =
        `  ${String(PITCHES[i]).padStart(5)} | ${pct(times, 0.5).toFixed(1).padStart(7)} ` +
        `${pct(times, 0.9).toFixed(1).padStart(8)} | ${String(s.drawCalls).padStart(6)} ` +
        `${String(s.triangles).padStart(7)} ${String(s.lines).padStart(7)} ` +
        `${String(s.tilesVisible).padStart(5)} | ${String(s.cacheEntries).padStart(5)} | ${zs}`
      console.log(row)
      rows.push(row)
    }

    console.log(`\n  arena-oom / FLICKER warnings: ${warnings.length}`)
    for (const w of warnings.slice(0, 10)) console.log('   !', w)
    console.log(
      '\n  Reading it: the #1367 signature is the drawn-by-zoom column keeping TWO OR MORE\n' +
        '  zoom levels with large counts as pitch approaches 0, together with med-ms rising.\n' +
        '  Multi-z at HIGH pitch alone is expected and not the bug.\n',
    )

    // Diagnostic: the table is the deliverable. The only hard assertion is the
    // liveness gate above, so this never becomes a flaky blocking gate.
    expect(rows.length).toBe(PITCHES.length)
  })
})
