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
//   • LEGACY + skew → byte-identical — the hook lives inside syncShow,
//     which never runs without split materials.
//
// UNLIKE the RTC gate's flag, `__XGIS_SPLIT_BIND` is read ONCE, at
// PipelineFactory.build() (the split layout + Material twins are built or
// not) — post-ready injection is too late. And the bundle gate measured
// addInitScript STACKING unreliable across same-context arm navigations.
// So each arm gets a FRESH BROWSER CONTEXT with its own addInitScript —
// no stacking, flag present before the first byte of app code runs.
//
// Scene/settle harness otherwise mirrors _rtc-recombine-parity-gate.spec.ts
// (committed demotiles mirror, zoom < 2 band, idle-event settle, full-script
// warmup per arm, fixed-point wiggle+idle rounds, clipped page.screenshot).

import { test, expect, type Browser, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { PNG } from 'pngjs'

const SCRIPT: ReadonlyArray<{ bearing: number; zoom: number; pitch: number }> = [
  { bearing: 0, zoom: 1.5, pitch: 0 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
  { bearing: 55, zoom: 1.8, pitch: 15 },
  { bearing: 55, zoom: 1.6, pitch: 15 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
]

/** Legacy-vs-split budget: the ulp-flip envelope (same rationale + number as
 *  the RTC gate — a wrong span offset or swapped dynamic offset moves whole
 *  fills, thousands of pixels). */
const MAX_DIFF_PX = 12

type Arm = { split: boolean; skew: boolean }

let _clip: { x: number; y: number; width: number; height: number } | null = null
let _stepIdx = 0

interface ArmHandle {
  page: Page
  errors: string[]
  close: () => Promise<void>
}

async function bootArm(browser: Browser, baseURL: string, arm: Arm): Promise<ArmHandle> {
  const ctx = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    viewport: { width: 288, height: 160 },
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
  await page.goto(`/demo.html?id=import_maplibre_mirror&e2e=1&msaa=1#1.5/20/140`, {
    waitUntil: 'domcontentloaded',
  })
  console.log(`[split-parity] boot(${JSON.stringify(arm)}): navigated, waiting ready`)
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 240_000 },
  )
  await page.waitForTimeout(8_000) // cold-start tile + glyph cascade
  for (const step of SCRIPT) await stepAndSettle(page, step, /* warmup */ true)
  return { page, errors, close: () => ctx.close() }
}

async function shot(page: Page): Promise<{ hash: string; png: Buffer }> {
  if (!_clip) {
    const box = await page.locator('#xg-canv, canvas').first().boundingBox()
    if (!box) throw new Error('canvas has no bounding box')
    _clip = {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    }
    console.log(`[split-parity] clip=${JSON.stringify(_clip)}`)
  }
  const png = await page.screenshot({ clip: _clip, animations: 'disabled', timeout: 120_000 })
  return { hash: createHash('sha256').update(png).digest('hex'), png }
}

function pixelDiff(a: Buffer, b: Buffer): { count: number; maxDelta: number } {
  const pa = PNG.sync.read(a)
  const pb = PNG.sync.read(b)
  if (pa.width !== pb.width || pa.height !== pb.height)
    throw new Error(`size mismatch ${pa.width}x${pa.height} vs ${pb.width}x${pb.height}`)
  let count = 0
  let maxDelta = 0
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c]! - pb.data[i + c]!))
    if (d > 0) {
      count++
      if (d > maxDelta) maxDelta = d
    }
  }
  return { count, maxDelta }
}

/** Apply one script step; settle via the map 'idle' event, then run
 *  fixed-point wiggle+idle rounds until the hash repeats (arm content-
 *  history divergence — see the RTC gate's measured rationale). */
async function stepAndSettle(
  page: Page,
  step: { bearing: number; zoom: number; pitch: number },
  warmup = false,
): Promise<{ hash: string; png: Buffer }> {
  const stepIdx = _stepIdx++
  console.log(
    `[split-parity] step ${stepIdx}${warmup ? ' (warmup)' : ''} apply ${JSON.stringify(step)}`,
  )
  await page.evaluate(
    async ({ s, timeoutMs }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            getCamera: () => { bearing: number; pitch: number }
            setZoom: (z: number) => void
            invalidate: () => void
            on: (t: string, cb: () => void) => unknown
          }
        }
      ).__xgisMap
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`idle timeout after ${timeoutMs}ms`)), timeoutMs)
        m.on('idle', () => {
          clearTimeout(t)
          res()
        })
        const cam = m.getCamera()
        cam.bearing = s.bearing
        cam.pitch = s.pitch
        m.setZoom(s.zoom)
        m.invalidate()
      })
    },
    { s: step, timeoutMs: 220_000 },
  )
  if (warmup) return { hash: '', png: Buffer.alloc(0) }
  let prev = ''
  let s1: { hash: string; png: Buffer } | null = null
  for (let round = 0; round < 8; round++) {
    await page.evaluate(async (baseBearing: number) => {
      const m = (
        window as unknown as {
          __xgisMap: { getCamera: () => { bearing: number }; invalidate: () => void }
        }
      ).__xgisMap
      const cam = m.getCamera()
      for (let i = 0; i < 6; i++) {
        cam.bearing = baseBearing + (i % 2 === 0 ? 2 : -2)
        m.invalidate()
        await Promise.race([
          new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
          new Promise<void>((r) => setTimeout(r, 20_000)),
        ])
      }
      cam.bearing = baseBearing
      m.invalidate()
    }, step.bearing)
    await page.evaluate(async (timeoutMs: number) => {
      const m = (
        window as unknown as {
          __xgisMap: { on: (t: string, cb: () => void) => unknown; invalidate: () => void }
        }
      ).__xgisMap
      await new Promise<void>((res, rej) => {
        const t = setTimeout(
          () => rej(new Error(`re-idle timeout after ${timeoutMs}ms`)),
          timeoutMs,
        )
        m.on('idle', () => {
          clearTimeout(t)
          res()
        })
        m.invalidate()
      })
    }, 220_000)
    s1 = await shot(page)
    if (s1.hash === prev) {
      console.log(`[split-parity] step ${stepIdx} fixed point after ${round + 1} rounds`)
      return s1
    }
    prev = s1.hash
  }
  throw new Error(
    `step ${stepIdx}: no fixed point in 8 wiggle+idle rounds (last ${prev.slice(0, 12)})`,
  )
}

async function runScript(page: Page): Promise<{ hash: string; png: Buffer }[]> {
  const out: { hash: string; png: Buffer }[] = []
  for (const step of SCRIPT) out.push(await stepAndSettle(page, step))
  return out
}

const splitDrawCount = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as { __xgisVtrSplitDraws?: number }).__xgisVtrSplitDraws ?? 0)

test('#2042 INC-4b — split-bind fills match legacy; the split path provably executes and is read', async ({
  browser,
}, testInfo) => {
  test.setTimeout(2_100_000)
  _clip = null
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

  // Arm C — split + ShowBlock skew witness: single pose on ARM B's page
  // family (fresh context; must move massively vs arm B's step 0).
  const armC = await bootArm(browser, baseURL, { split: true, skew: true })
  const splitSkew = await stepAndSettle(armC.page, SCRIPT[0]!)

  // Arm D — legacy + skew: single pose, must be byte-identical to arm A
  // (the hook lives inside syncShow — unreachable without split materials).
  const armD = await bootArm(browser, baseURL, { split: false, skew: true })
  const legacySkew = await stepAndSettle(armD.page, SCRIPT[0]!)

  // ── Verdicts ──
  for (const [name, arm] of [
    ['A', armA],
    ['B', armB],
    ['C', armC],
    ['D', armD],
  ] as const) {
    expect(arm.errors, `arm ${name} page errors:\n${arm.errors.join('\n')}`).toEqual([])
  }
  expect(legacyDraws, 'legacy arm recorded split draws — the flag gate leaks').toBe(0)
  // Executed-mechanism witness half 1: the split branch actually drew.
  expect(
    splitDraws,
    'split arm recorded ZERO split draws — the rebind never engaged; the A/B below is vacuous',
  ).toBeGreaterThan(0)
  console.log(`[split-parity] splitDraws: legacy=${legacyDraws} split=${splitDraws}`)

  expect(new Set(legacy.map((s) => s.hash)).size, 'reference frames all identical').toBeGreaterThan(
    1,
  )

  for (let i = 0; i < SCRIPT.length; i++) {
    const equal = legacy[i]!.hash === split[i]!.hash
    const d = equal ? { count: 0, maxDelta: 0 } : pixelDiff(legacy[i]!.png, split[i]!.png)
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
      d.count,
      `step ${i}: legacy↔split pixel diff ${d.count} > ${MAX_DIFF_PX} (maxΔ=${d.maxDelta}) — ` +
        'beyond the ulp envelope; the rebind reads different bytes (span table, offsets, or bind order)',
    ).toBeLessThanOrEqual(MAX_DIFF_PX)
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

  // Legacy immunity: the skew hook cannot leak into the legacy path.
  console.log(
    `[split-parity] witness LEGACY+skew vs LEGACY: legacy=${legacy[0]!.hash.slice(0, 12)} skew=${legacySkew.hash.slice(0, 12)}`,
  )
  expect(
    legacySkew.hash,
    'LEGACY + skew changed the frame — the skew hook is reachable without split materials',
  ).toBe(legacy[0]!.hash)

  await armB.close()
  await armC.close()
  await armD.close()
})
