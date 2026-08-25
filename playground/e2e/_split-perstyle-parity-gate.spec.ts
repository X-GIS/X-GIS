// ═══ #2042 INC-4d — PER-STYLE split twins: interactive §5 A/B parity gate ═══
//
// INC-4b/4c covered the DEFAULT flat/ground + solid-stroke pair — which INC-5's
// measurement showed is only the variant-less shows (synthetic earth, polar
// caps, CPU-lowered match buckets): every COMPILED show carries a
// ShaderVariant, and constant paints inline as preamble consts, so converted-
// style fills draw per-style composed pipelines and never split. INC-4d adds
// lazily-built per-style split twins (pipeline-factory.perStyleSplitTwin, an
// emitted-interface eligibility check) and widens the walk-skip qualification
// to them. THIS gate drives exactly that class: a synthetic converted style of
// N constant-colour fill layers (the encode sweep's scenario — distinct
// colours, no filters, so every layer is its own per-style show).
//
// Vacuity guards (the #996 lesson):
//   • the ON arm must report `__xgisVtrSplitDraws > 0` — per-style twins
//     count through the same executed-mechanism counter — AND
//     `__xgisVtrWalkSkips > 0` — the INC-5 pack bypass must now ENGAGE for
//     this class (it measured 0 here before INC-4d, which is the finding
//     this increment answers); the OFF arm must report 0 for both.
//   • No skew arm: these variants INLINE their colours as module consts, so
//     the ShowBlock colour lanes the skew hook inverts are never read — the
//     read-proof for the lanes this class DOES consume (mvp/proj from
//     FrameBlock, extent/clip/dequant from the TileBlock arena) is parity
//     itself: an unread or misaddressed tile block collapses the geometry,
//     which the pose hashes cannot miss. The default-class gate
//     (_split-bind-parity-gate) keeps the skew witness for the lanes that
//     are read through the show block.
//
// __XGIS_SPLIT_BIND is read ONCE at PipelineFactory.build() → per-arm fresh
// browser contexts with addInitScript (same rationale as the INC-4b gate).
// Capture + settle per the capture-canvas skill: captureMapFrame
// (capture:'clip'), awaitMapIdle asserted, bounded stability loop, adaptive=0.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'
// Relative deep import (charter): Playwright transpiles specs in raw Node —
// the @xgis/* workspace alias does not resolve here.
import { convertMapboxStyle } from '../../compiler/src/convert/mapbox-to-xgis'

const CAM = { lon: 10, lat: 30, zoom: 3 }

const SCRIPT: ReadonlyArray<{ bearing: number; zoom: number; pitch: number }> = [
  { bearing: 0, zoom: 3, pitch: 0 },
  { bearing: 25, zoom: 3, pitch: 0 },
  { bearing: 55, zoom: 3.4, pitch: 15 },
  { bearing: 55, zoom: 2.8, pitch: 15 },
  { bearing: 25, zoom: 3, pitch: 0 },
]

/** Same amplitude-class budget as the INC-4b gate: fills-only here, so the
 *  expected tail is pure AA ulp noise; a real bind bug moves whole draws. */
const MAX_DIFF_PX = 12
const MAX_DIFF_PX_SOFT = 96
const MAX_SOFT_DELTA = 16

/** The encode sweep's synthetic style: N unfiltered fill layers, each a
 *  DISTINCT constant colour (unfiltered members never merge, so N layers stay
 *  N per-style shows), over the local countries fixture. */
function syntheticStyle(nLayers: number): string {
  const layers: unknown[] = [
    { id: 'bg', type: 'background', paint: { 'background-color': '#101018' } },
  ]
  for (let i = 0; i < nLayers; i++) {
    layers.push({
      id: `fill_${i}`,
      type: 'fill',
      source: 'c',
      paint: { 'fill-color': `rgb(${(i * 37) % 256},${(i * 91) % 256},${(i * 53) % 256})` },
    })
  }
  return convertMapboxStyle(
    JSON.stringify({
      version: 8,
      sources: { c: { type: 'geojson', data: '/data/countries.geojson' } },
      layers,
    }),
  )
}

type Arm = { split: boolean }

interface ArmHandle {
  page: Page
  errors: string[]
  close: () => Promise<void>
}

async function bootArm(browser: Browser, baseURL: string, arm: Arm): Promise<ArmHandle> {
  const ctx = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    viewport: { width: 512, height: 320 },
    reducedMotion: 'reduce',
  })
  const page = await ctx.newPage()
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String((e as Error)?.message ?? e)))
  page.on('console', (m) => {
    if (m.type() === 'error')
      console.log(`[perstyle-parity] console.error(${JSON.stringify(arm)}): ${m.text()}`)
  })
  await page.addInitScript((a: Arm) => {
    ;(globalThis as { __XGIS_SPLIT_BIND?: boolean }).__XGIS_SPLIT_BIND = a.split
    ;(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS = true
  }, arm)
  const b64 = Buffer.from(syntheticStyle(8), 'utf8').toString('base64')
  // The `#src=` import channel occupies the hash → camera via setters below.
  await page.goto(`/demo.html?id=__import&e2e=1&msaa=1&adaptive=0#src=${b64}`, {
    waitUntil: 'domcontentloaded',
  })
  console.log(`[perstyle-parity] boot(${JSON.stringify(arm)}): navigated, load-settling`)
  await captureMapFrame(page, { readyTimeoutMs: 240_000, capture: 'clip' })
  await page.evaluate((cam) => {
    const m = (
      window as unknown as {
        __xgisMap: {
          setCenter: (lon: number, lat: number) => void
          setZoom: (z: number) => void
          markCameraPositioned: () => void
          invalidate: () => void
        }
      }
    ).__xgisMap
    m.setCenter(cam.lon, cam.lat)
    m.setZoom(cam.zoom)
    m.markCameraPositioned()
    m.invalidate()
  }, CAM)
  expect(await awaitMapIdle(page, 220_000), 'map did not idle after camera set').toBe('idle')
  // Full-script warmup in EVERY arm (identical histories → comparable frames;
  // also seeds arena residency so the ON arm's walk-skip can engage).
  for (const step of SCRIPT) await applyStep(page, step)
  return { page, errors, close: () => ctx.close() }
}

async function applyStep(
  page: Page,
  step: { bearing: number; zoom: number; pitch: number },
): Promise<void> {
  await page.evaluate((s) => {
    const m = (
      window as unknown as {
        __xgisMap: {
          getCamera: () => { bearing: number; pitch: number }
          setZoom: (z: number) => void
          invalidate: () => void
        }
      }
    ).__xgisMap
    const cam = m.getCamera()
    cam.bearing = s.bearing
    cam.pitch = s.pitch
    m.setZoom(s.zoom)
    m.invalidate()
  }, step)
  expect(await awaitMapIdle(page, 220_000), 'map did not idle after camera step').toBe('idle')
}

let _stepIdx = 0

async function stepAndCapture(
  page: Page,
  step: { bearing: number; zoom: number; pitch: number },
): Promise<{ hash: string; png: Buffer }> {
  const stepIdx = _stepIdx++
  await applyStep(page, step)
  let prev = ''
  for (let round = 0; round < 8; round++) {
    const png = await captureMapFrame(page, { capture: 'clip' })
    const hash = createHash('sha256').update(png).digest('hex')
    if (hash === prev) {
      console.log(`[perstyle-parity] step ${stepIdx} stable after ${round + 1} captures`)
      return { hash, png }
    }
    prev = hash
  }
  throw new Error(`step ${stepIdx}: no stable frame in 8 captures (last ${prev.slice(0, 12)})`)
}

function pixelDiff(a: Buffer, b: Buffer): { count: number; highCount: number; maxDelta: number } {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  if (pa.width !== pb.width || pa.height !== pb.height)
    throw new Error(`size mismatch ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
  let count = 0
  let highCount = 0
  let maxDelta = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c]! - pb.data[i + c]!))
    if (d > 0) {
      count++
      if (d > MAX_SOFT_DELTA) highCount++
      if (d > maxDelta) maxDelta = d
    }
  }
  return { count, highCount, maxDelta }
}

const mechCounts = (page: Page): Promise<{ fills: number; skips: number }> =>
  page.evaluate(() => ({
    fills: (globalThis as { __xgisVtrSplitDraws?: number }).__xgisVtrSplitDraws ?? 0,
    skips: (globalThis as { __xgisVtrWalkSkips?: number }).__xgisVtrWalkSkips ?? 0,
  }))

test('#2042 INC-4d — per-style split fills match legacy; the twin and the walk-skip provably engage', async ({
  browser,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  const baseURL = testInfo.project.use.baseURL
  if (!baseURL) throw new Error('project baseURL missing — per-arm contexts need it')

  // Arm A — legacy (flag off): the reference. Counters must stay 0.
  const armA = await bootArm(browser, baseURL, { split: false })
  const legacy: { hash: string; png: Buffer }[] = []
  for (const step of SCRIPT) legacy.push(await stepAndCapture(armA.page, step))
  const legacyCounts = await mechCounts(armA.page)
  await armA.close()

  // Arm B — split bind ON: per-style twins + walk-skip.
  const armB = await bootArm(browser, baseURL, { split: true })
  const split: { hash: string; png: Buffer }[] = []
  for (const step of SCRIPT) split.push(await stepAndCapture(armB.page, step))
  const splitCounts = await mechCounts(armB.page)
  await armB.close()

  for (const [name, arm] of [
    ['A', armA],
    ['B', armB],
  ] as const) {
    expect(arm.errors, `arm ${name} page errors:\n${arm.errors.join('\n')}`).toEqual([])
  }
  expect(
    legacyCounts.fills + legacyCounts.skips,
    'legacy arm recorded split draws / walk-skips — the flag gate leaks',
  ).toBe(0)
  expect(
    splitCounts.fills,
    'split arm recorded ZERO split FILL draws — the per-style twin never engaged; the A/B below is vacuous',
  ).toBeGreaterThan(0)
  expect(
    splitCounts.skips,
    'split arm recorded ZERO walk-skips — INC-4d did not widen the INC-5 qualification to this class',
  ).toBeGreaterThan(0)
  console.log(
    `[perstyle-parity] counts: legacy=${JSON.stringify(legacyCounts)} split=${JSON.stringify(splitCounts)}`,
  )

  expect(new Set(legacy.map((s) => s.hash)).size, 'reference frames all identical').toBeGreaterThan(
    1,
  )

  for (let i = 0; i < SCRIPT.length; i++) {
    const equal = legacy[i]!.hash === split[i]!.hash
    const diff = equal
      ? { count: 0, highCount: 0, maxDelta: 0 }
      : pixelDiff(legacy[i]!.png, split[i]!.png)
    console.log(
      `[perstyle-parity] step ${i} ${JSON.stringify(SCRIPT[i])} legacy=${legacy[i]!.hash.slice(0, 12)} split=${split[i]!.hash.slice(0, 12)}${
        equal ? ' HASH-EQUAL' : ` DIFF count=${diff.count} maxΔ=${diff.maxDelta}`
      }`,
    )
    if (!equal) {
      const dir = testInfo.outputPath('')
      const lp = `${dir}/perstyle-step${i}-legacy.png`
      const sp = `${dir}/perstyle-step${i}-split.png`
      writeFileSync(lp, legacy[i]!.png)
      writeFileSync(sp, split[i]!.png)
      console.log(`[perstyle-parity] saved failing frames: ${lp} ${sp}`)
    }
    expect(
      diff.highCount,
      `step ${i}: ${diff.highCount} high-amplitude pixels (>${MAX_SOFT_DELTA}) exceed ${MAX_DIFF_PX}`,
    ).toBeLessThanOrEqual(MAX_DIFF_PX)
    expect(
      diff.count,
      `step ${i}: ${diff.count} total differing pixels exceed ${MAX_DIFF_PX_SOFT}`,
    ).toBeLessThanOrEqual(MAX_DIFF_PX_SOFT)
  }
})
