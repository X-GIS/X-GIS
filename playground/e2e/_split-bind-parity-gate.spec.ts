// ═══ #2042 INC-4b — split-bind (Frame/Show/Tile) rebind: interactive §5 A/B
//     parity gate ═══
//
// Under `__XGIS_SPLIT_BIND` the qualifying default flat fills draw through
// the DERIVED three-block module (polygon-split.ts) bound as TileBlock(7,
// dyn) / ShowBlock(10, dyn) / FrameBlock(11), with contents span-copied from
// the live legacy polygonU bytes (uniform-split-bind.ts — byte-parity by
// construction, pinned by uniform-split-bind.test.ts). The derived module's
// retired lanes ALWAYS recombine in-VS (both select arms were rewritten to
// the recombination), so split-vs-legacy carries the SAME ulp-relative
// divergence the INC-1/6 gates measured (≤ 2.95e-4 px whole-domain) — the
// A/B rung is BOUNDED PIXEL DIFF, not hash equality.
//
// Vacuity guards (the #996 lesson — "both arms equal" proves nothing if the
// split path never engaged):
//   • the ARM-B run must report `__xgisVtrSplitDraws > 0` (the executed-
//     mechanism counter recordFillDraw's split branch increments) and arm A
//     must report 0;
//   • SPLIT + __XGIS_SPLIT_BIND_SKEW (uniform-split-bind.ts inverts the
//     staged ShowBlock fill colour R/G) → the frame MUST change massively —
//     proves the fragment actually READS the ShowBlock bytes through the
//     split bind, not the legacy ring;
//   • LEGACY + skew → identical — the hook lives inside syncShow, which
//     never runs without split materials.
//
// This gate already caught two real defects before first green: the show-
// slot aliasing (one pickId shared by a lowered match()'s filter buckets —
// every country painted one bucket's colour) and the rewrite-walker identity
// break (auto-var fission collapsed the position var to its zero initializer
// — split vertices all at (0,0,0,0): valid draws, EMPTY frames, no
// validation error). Both are pinned in unit suites now; this gate is the
// end-to-end tripwire.
//
// UNLIKE the RTC gate's flag, `__XGIS_SPLIT_BIND` is read ONCE, at
// PipelineFactory.build() (the split layout + Material twins are built or
// not) — post-ready injection is too late. And the bundle gate measured
// addInitScript STACKING unreliable across same-context arm navigations.
// So each arm gets a FRESH BROWSER CONTEXT with its own addInitScript —
// no stacking, flag present before the first byte of app code runs.
//
// Capture + settle follow the capture-canvas skill: chrome-free
// `captureMapFrame` (capture: 'clip' — whole-world low-zoom views are the
// #1802 element-stability hang trigger), `awaitMapIdle` asserted after every
// camera change, and a BOUNDED consecutive-capture stability loop instead of
// sleeps (two equal hashes = the frame is at its terminal state; the bound
// fails the spec rather than freezing a mid-animation frame into a
// "converged" measurement).

import { test, expect, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

const SCRIPT: ReadonlyArray<{ bearing: number; zoom: number; pitch: number }> = [
  { bearing: 0, zoom: 1.5, pitch: 0 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
  { bearing: 55, zoom: 1.8, pitch: 15 },
  { bearing: 55, zoom: 1.6, pitch: 15 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
]

/** Legacy-vs-split budgets, per amplitude CLASS. A wrong span offset /
 *  swapped dynamic offset / dead bind moves WHOLE draws — hundreds-to-
 *  thousands of pixels at saturated deltas — so the two bounds are:
 *  - HIGH-amplitude pixels (Δ > MAX_SOFT_DELTA in any channel): ≤ MAX_DIFF_PX.
 *    INC-4c measured why they exist at all: a dashed stroke's SDF coverage is
 *    DISCRETE, so the recombination's ≤2.95e-4-px divergence can snap one
 *    dash-dot edge sample across the coverage threshold — measured exactly
 *    ONE such pixel (Δ113, a 55%-blend dot edge becoming full stroke) per
 *    settled pose, isolated in the dotted-graticule region.
 *  - TOTAL differing pixels: ≤ MAX_DIFF_PX_SOFT — the low-amplitude tail is
 *    plain AA ulp noise (measured 19-25 px at Δ≤6; 0.0% of the frame above
 *    the pixeldiff skill's own threshold of 8).
 *  A real bind bug blows the high-amplitude bound by two orders. */
const MAX_DIFF_PX = 12
const MAX_DIFF_PX_SOFT = 96
const MAX_SOFT_DELTA = 16

type Arm = { split: boolean; skew: boolean }

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
      console.log(`[split-parity] console.error(${JSON.stringify(arm)}): ${m.text()}`)
  })
  // BEFORE any app code: the factory reads __XGIS_SPLIT_BIND at build().
  await page.addInitScript((a: Arm) => {
    ;(globalThis as { __XGIS_SPLIT_BIND?: boolean }).__XGIS_SPLIT_BIND = a.split
    ;(globalThis as { __XGIS_SPLIT_BIND_SKEW?: boolean }).__XGIS_SPLIT_BIND_SKEW = a.skew
    ;(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS = true
  }, arm)
  // adaptive=0 (#1620): the quality ladder reads SwiftShader as a struggling
  // machine and its notch can differ between arms — a cross-arm A/B needs the
  // scale pinned (the capture-canvas template carries it; step-3 zoom-out
  // measured 25k px of pure tier divergence before this pin).
  await page.goto(`/demo.html?id=import_maplibre_mirror&e2e=1&msaa=1&adaptive=0#1.5/20/140`, {
    waitUntil: 'domcontentloaded',
  })
  console.log(`[split-parity] boot(${JSON.stringify(arm)}): navigated, load-settling`)
  // Ready + tile/glyph load quiesce + chrome hide, in one call — no sleeps.
  await captureMapFrame(page, { readyTimeoutMs: 240_000, capture: 'clip' })
  // Full-script warmup in EVERY arm (identical histories → comparable frames).
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

/** Apply one pose, settle on `idle`, then capture until two CONSECUTIVE
 *  captures hash-equal (terminal-state frame — per-frame animations advance
 *  with rendered frames, and each capture's quiesce pumps them; the bound
 *  fails loud instead of freezing a transient into a measurement). */
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
      console.log(`[split-parity] step ${stepIdx} stable after ${round + 1} captures`)
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

async function runScript(page: Page): Promise<{ hash: string; png: Buffer }[]> {
  const out: { hash: string; png: Buffer }[] = []
  for (const step of SCRIPT) out.push(await stepAndCapture(page, step))
  return out
}

const splitDrawCount = (page: Page): Promise<{ fills: number; strokes: number }> =>
  page.evaluate(() => ({
    fills: (globalThis as { __xgisVtrSplitDraws?: number }).__xgisVtrSplitDraws ?? 0,
    strokes: (globalThis as { __xgisVtrSplitStrokeDraws?: number }).__xgisVtrSplitStrokeDraws ?? 0,
  }))

test('#2042 INC-4b — split-bind fills match legacy; the split path provably executes and is read', async ({
  browser,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _stepIdx = 0
  const baseURL = testInfo.project.use.baseURL
  if (!baseURL) throw new Error('project baseURL missing — per-arm contexts need it')

  // Arm A — legacy (flag off): the reference. The split counter must stay 0.
  const armA = await bootArm(browser, baseURL, { split: false, skew: false })
  const legacy = await runScript(armA.page)
  const legacyDraws = await splitDrawCount(armA.page)
  await armA.close()

  // Arm B — split bind ON.
  const armB = await bootArm(browser, baseURL, { split: true, skew: false })
  const split = await runScript(armB.page)
  const splitDraws = await splitDrawCount(armB.page)

  // Arm C — split + ShowBlock skew witness (fresh context; single pose).
  const armC = await bootArm(browser, baseURL, { split: true, skew: true })
  const splitSkew = await stepAndCapture(armC.page, SCRIPT[0]!)

  // Arm D — legacy + skew: must equal arm A (the hook is unreachable
  // without split materials).
  const armD = await bootArm(browser, baseURL, { split: false, skew: true })
  const legacySkew = await stepAndCapture(armD.page, SCRIPT[0]!)

  // ── Verdicts ──
  for (const [name, arm] of [
    ['A', armA],
    ['B', armB],
    ['C', armC],
    ['D', armD],
  ] as const) {
    expect(arm.errors, `arm ${name} page errors:\n${arm.errors.join('\n')}`).toEqual([])
  }
  expect(
    legacyDraws.fills + legacyDraws.strokes,
    'legacy arm recorded split draws — the flag gate leaks',
  ).toBe(0)
  // Executed-mechanism witness half 1: BOTH split families actually drew
  // (#2042 INC-4b fills, INC-4c strokes).
  expect(
    splitDraws.fills,
    'split arm recorded ZERO split FILL draws — the rebind never engaged; the A/B below is vacuous',
  ).toBeGreaterThan(0)
  expect(
    splitDraws.strokes,
    'split arm recorded ZERO split STROKE draws — the line rebind never engaged (INC-4c vacuous)',
  ).toBeGreaterThan(0)
  console.log(
    `[split-parity] splitDraws: legacy=${JSON.stringify(legacyDraws)} split=${JSON.stringify(splitDraws)}`,
  )

  expect(new Set(legacy.map((s) => s.hash)).size, 'reference frames all identical').toBeGreaterThan(
    1,
  )

  for (let i = 0; i < SCRIPT.length; i++) {
    const equal = legacy[i]!.hash === split[i]!.hash
    const d = equal
      ? { count: 0, highCount: 0, maxDelta: 0 }
      : pixelDiff(legacy[i]!.png, split[i]!.png)
    console.log(
      `[split-parity] step ${i} ${JSON.stringify(SCRIPT[i])} legacy=${legacy[i]!.hash.slice(0, 12)} ` +
        `split=${split[i]!.hash.slice(0, 12)} ${equal ? 'EQUAL' : `DIFF count=${d.count} maxΔ=${d.maxDelta}`}`,
    )
    if (d.count > MAX_DIFF_PX) {
      const pl = testInfo.outputPath(`split-step${i}-legacy.png`)
      const ps = testInfo.outputPath(`split-step${i}-split.png`)
      writeFileSync(pl, legacy[i]!.png)
      writeFileSync(ps, split[i]!.png)
      console.log(`[split-parity] saved failing frames: ${pl} ${ps}`)
    }
    expect(
      d.highCount <= MAX_DIFF_PX && d.count <= MAX_DIFF_PX_SOFT,
      `step ${i}: legacy↔split pixel diff count=${d.count} (high-amplitude ${d.highCount}, ` +
        `maxΔ=${d.maxDelta}) — beyond the ulp envelope (≤${MAX_DIFF_PX} at Δ>${MAX_SOFT_DELTA}, ` +
        `≤${MAX_DIFF_PX_SOFT} total); the rebind reads different bytes (span table, offsets, or bind order)`,
    ).toBe(true)
  }

  // Executed-mechanism witness half 2: the fragment READS the ShowBlock
  // through the split bind — inverting the staged colour must repaint fills.
  const cd = pixelDiff(split[0]!.png, splitSkew.png)
  console.log(`[split-parity] witness SPLIT+skew vs SPLIT: count=${cd.count} maxΔ=${cd.maxDelta}`)
  expect(
    cd.count,
    'SPLIT + ShowBlock skew did not change the frame — the split draws are not reading the ' +
      'ShowBlock slot (dead bind or wrong offset); the A/B above is vacuous',
  ).toBeGreaterThan(100)

  // Legacy immunity: the skew hook cannot leak into the legacy path. Bounded
  // diff (not hash) — arms are separate contexts, so ulp-benign variation is
  // possible; a leak inverts fill colours = thousands of pixels.
  const ld = pixelDiff(legacy[0]!.png, legacySkew.png)
  console.log(`[split-parity] witness LEGACY+skew vs LEGACY: count=${ld.count} maxΔ=${ld.maxDelta}`)
  expect(
    ld.count,
    'LEGACY + skew changed the frame — the skew hook is reachable without split materials',
  ).toBeLessThanOrEqual(MAX_DIFF_PX)

  await armB.close()
  await armC.close()
  await armD.close()
})
