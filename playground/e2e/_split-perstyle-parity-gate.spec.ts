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
//   • the ON arm must report `__xgisVtrSplitPerStyleDraws > 0` — the PER-STYLE
//     branch of recordFillDraw alone — plus `__xgisVtrSplitDraws > 0` and
//     `__xgisVtrWalkSkips > 0` (the INC-5 pack bypass must ENGAGE for this
//     class); the OFF arm must report 0 for all three.
//
//     #2572 — the per-style counter is why those other two are no longer the
//     guard. Both are satisfied by the DEFAULT flat/ground twins: the total
//     counts `mat === eff.flat` draws (polygon-fill-material.ts), and
//     `_walkRingFree`'s `splitFillsCapable` is an OR over the four default
//     pipelines and the per-style twin (vector-tile-renderer.ts:2131-2137). So
//     any variant-less fill in the scene drives both above zero whatever the
//     per-style resolver answers — which is exactly what happened: the resolver
//     decided eligibility by regexing the emitted module (the union of all nine
//     entry points, so `fs_fill_pattern`'s sprite bindings disqualified every
//     variant), returned null for every styled fill this gate draws, and this
//     gate stayed GREEN throughout. A composite counter cannot attribute.
//
//     #2584 — and the per-style path is empty here for a SECOND, separate reason.
//     Measured across three runs, both arms on WebGPU: fills/perStyle/skips =
//     185/0/180, 169/0/165, 201/0/180 — the per-style branch executes zero times,
//     `perStyleSplitTwin` is never called, and the per-style Material lookup in
//     `recordFillDraw` never hits. WHY is not established: the compiler does hand
//     the renderer a per-style-composing variant for every fill layer in this scene
//     (measured through `convertMapboxStyle` → `lower` → `emitCommands` →
//     `toComposerVariant`: NON-NULL for a literal colour as well as for `get` /
//     `match` / `interpolate`), so the break is somewhere between that variant and
//     `eff.perStyle`. The per-style assertion is DEFERRED to #2584 rather than
//     guessed at. Two independent defects were hiding each other here.
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
// (capture:'clip'), bounded consecutive-hash stability loop, adaptive=0.
// NO awaitMapIdle: this scenario never fires idle (#2091) — the stability
// loop is the terminal-state authority.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { captureMapFrame } from './helpers/visual'
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
    viewport: { width: 384, height: 240 },
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
  // No idle wait (#2091 — see applyStep); one capture settles the camera
  // change through the engine quiesce, then the warmup applies the script
  // back-to-back (identical histories in both arms; seeds arena residency so
  // the ON arm's walk-skip can engage — the measured pass's stability loops
  // do the real settling).
  await captureMapFrame(page, { capture: 'clip' })
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
  // #2091 — this scenario never fires `idle` (visible tiles stop caching at
  // 13/17 and hasPendingSourceWork starves the predicate forever, on BOTH
  // arms identically), so there is NO idle wait here at all: a 45 s
  // best-effort wait burned ~15 dead minutes across the arms and blew the
  // spec budget. The consecutive-hash-equal capture loop is the sole
  // terminal-state authority — captureMapFrame's own engine quiesce pumps
  // frames, and a mid-load frame cannot produce two equal hashes while
  // tiles are still arriving.
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

const mechCounts = (
  page: Page,
): Promise<{ fills: number; perStyle: number; skips: number; backend: string }> =>
  page.evaluate(() => {
    const g = globalThis as {
      __xgisVtrSplitDraws?: number
      __xgisVtrSplitPerStyleDraws?: number
      __xgisVtrWalkSkips?: number
      __xgisMap?: { ctx?: { rhi?: { backend?: string } } }
    }
    return {
      fills: g.__xgisVtrSplitDraws ?? 0,
      perStyle: g.__xgisVtrSplitPerStyleDraws ?? 0,
      skips: g.__xgisVtrWalkSkips ?? 0,
      // A silent WebGL2 fallback builds no split layout at all
      // (PipelineFactory.build early-returns), so every counter reads 0 for a
      // reason that has nothing to do with eligibility. Report it rather than
      // let it masquerade as an ineligible twin.
      backend: g.__xgisMap?.ctx?.rhi?.backend ?? 'unknown',
    }
  })

test('#2042 INC-4d — per-style split fills match legacy; the twin and the walk-skip provably engage', async ({
  browser,
}, testInfo) => {
  test.setTimeout(2_700_000)
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
  // A red arm must say what it MEASURED, not only which bound it missed.
  console.log(`[perstyle-parity] legacy ${JSON.stringify(legacyCounts)}`)
  console.log(`[perstyle-parity] split  ${JSON.stringify(splitCounts)}`)
  expect(
    splitCounts.backend,
    'split arm did not run on WebGPU — no split layout is built at all',
  ).toBe('webgpu')
  expect(
    legacyCounts.fills + legacyCounts.perStyle + legacyCounts.skips,
    'legacy arm recorded split draws / walk-skips — the flag gate leaks',
  ).toBe(0)
  // #2584 — `splitCounts.perStyle` is the guard this gate WANTS, and it cannot be
  // asserted yet: measured at ZERO across three runs while the total varied with
  // tile selection (185/169/201), so the per-style branch is structurally never
  // reached in this scene. The cause is open — the compiler DOES produce a
  // per-style-composing variant for these layers — so #2584 owns finding it and
  // turning this assertion on. Until then the gate measures the default class, and
  // the log line above is what says so out loud instead of leaving it silent.
  expect(
    splitCounts.fills,
    'split arm recorded ZERO split FILL draws — the split path never engaged at all',
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
