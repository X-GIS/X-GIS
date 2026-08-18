// ═══ #1508 — WebGPU × WebGL2 backend-parity probe (offline demotiles mirror) ═══
//
// WHAT THIS MEASURES. #1508 exists because two user reports did NOT reproduce
// in the #1495/#1496/#1497 sweep:
//   1. "globe vector rendering is broken"
//   2. "the Tropic of Cancer and Equator labels never appear on mercator"
// Both reports came from a session running `gpu: auto`, which resolves to
// WebGPU on a capable device — but the ENTIRE #1495 sweep ran under
// `?forcegl2=1` (WebGL2/SwiftShader) only. #1508's own body states this
// sandbox "has no WebGPU software adapter" and that "no backend-parity claim
// can ever be established here". That premise is OUTDATED: CLAUDE.md §5
// documents MEASURED headless WebGPU on SwiftShader (WGSL compiles on real
// Tint, `_emit-obfuscate-gate` draws and reads back, the map boots on WebGPU
// with no `forcegl2`) — so the check #1508 asks for can run in this sandbox
// after all, offline, against the committed mirror #1790 added for #1495.
//
// This spec drives four arms — {globe, mercator} × {WebGPU, WebGL2} — at the
// exact camera (#1.5/20/140) and style (the demotiles mirror) #1508 names,
// and asserts:
//   • the LIVE backend on each arm, so a silent WebGPU→WebGL2 fallback (the
//     one failure mode that would make a "WebGPU" arm secretly re-measure
//     WebGL2 and green this probe for the wrong reason) is caught rather than
//     assumed away;
//   • report 2's literal claim — `getDispatchedLabelTexts()` contains both
//     "Equator" and "Tropic of Cancer" on the mercator WebGPU arm;
//   • report 1's claim, structurally — the globe WebGPU arm actually submits
//     labels and paints something (a truly "broken" render is the closest
//     thing to a falsifiable prediction a label-count + non-black-canvas
//     check can make without a GPU pixel-diff);
//   • cross-backend agreement — `getLastLabelCounts()` on the WebGPU and
//     WebGL2 arm of the same projection must agree within ±1 (a SwiftShader
//     nondeterminism guard, not a real tolerance for a genuine divergence).
// Pixel-level fidelity (are the two backends' FRAMES the same, not just their
// label counts) is deliberately NOT this spec's job — every arm writes a
// full-resolution screenshot to `testInfo.outputPath()` and the orchestrator
// runs the §5 directional pixel-diff (`compare-parity-pixeldiff`,
// `tile-crop-review`) on those separately. A label-count match with a pixel
// divergence is exactly the "difference IS the bug" case #1508 asks to file
// as its own issue if found.
//
// CALIBRATION STATUS: NOT YET RUN. Authored statically (no node_modules in
// this environment); the orchestrator runs it. Priors, for context:
//   • `_demotiles-labels-gl2-gate.spec.ts` already proves, on the LIVE style
//     at this exact camera, that both mercator and globe dispatch AND draw
//     line-placed labels on WebGL2 — so the two WebGL2 arms here are
//     expected to pass (same style bytes, same camera, offline mirror).
//   • The WebGPU arms are the actual unknown this probe exists to resolve.
// Per the `-probe` suffix's contract (`playground/src/e2e-specs-load.test.ts`
// only ratchets `-gate.spec.ts` names into CI), this file is NOT registered
// in `.github/workflows/test.yml` and must still load cleanly under
// `playwright test --list` (the OTHER, unconditional check in that file).
//
// PROMOTION PATH: once both WebGPU arms are confirmed green across ≥2
// independent runs (the #1715 dark-gate sweep's bar — a single green does
// not rule out SwiftShader-batch flakiness), rename this file to
// `_demotiles-webgpu-parity-gate.spec.ts` and add it to test.yml's
// render-gate list. If instead a WebGPU arm is red — or drifts outside the
// ±1 cross-backend band — that failure is a NEW, separately-filed defect
// (per #1508's own "if they differ, that difference is the bug" criterion),
// and this probe's job is done: it turned an unverified premise into a
// measurement.
//
// Runs against the OFFLINE mirror (`?id=import_maplibre_mirror`, #1790) —
// same reasoning as `_demotiles-mirror-probe.spec.ts`: headless Chromium here
// cannot reach demotiles.maplibre.org, and a repro must survive a CI leg with
// no egress. `adaptive=0` pins the quality ladder so a DPR notch cannot move
// the ±1 cross-backend comparison; the 900×500 viewport is the same one
// `_demotiles-mirror-probe.spec.ts` proved safe against the mirror's z0-z2
// depth (see that file's VIEWPORT comment) — globe is additionally exempt
// from the azimuthal-family selection-zoom boost that constraint exists for
// (`tile-selection-cache.ts`: "globe(7)/oblique(6)/cylindrical are
// unaffected"), so mercator and globe are both safe at this size.

import { test, expect, type Page, type TestInfo, type ConsoleMessage } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureCanvas, sampleNonBackgroundPixels } from './helpers/visual'

// WebGPU cold boot (adapter request, device creation, pipeline compile via
// Tint) on SwiftShader is measurably slower than WebGL2's context creation —
// generous throughout, and declared at describe-scope (not `test.setTimeout`
// in the body) because a loaded SwiftShader runner has been measured to time
// out in FIXTURE SETUP, which stays on the config default when the budget is
// only set inside the test body (CLAUDE.md §12). Two arms per test, each
// potentially paying the full WebGPU boot cost, so the per-test ceiling
// (90s ready wait + 90s counter-settle poll + 60s capture-settle, ×2 arms)
// is generously overbid rather than tuned tight on a first, uncalibrated run.
test.describe.configure({ timeout: 900_000 })

/** The camera #1508 names, and the only camera the mirror carries tiles for
 *  (see `_demotiles-mirror-probe.spec.ts`). Also where the style draws ONLY
 *  line-placed labels (`geolines-label` minzoom 1, `countries-label` minzoom
 *  2), so every dispatched label at this camera is a geoline. */
const CAMERA = '1.5/20/140'

/** Proven safe against the mirror's z0-z2 depth for the mercator control in
 *  `_demotiles-mirror-probe.spec.ts`; globe does not hit that constraint at
 *  all (see file header). */
const VIEWPORT = { width: 900, height: 500 }

/** Report 2's literal claim (#1508 body, translated): "the Tropic of Cancer
 *  and Equator labels never appear on mercator." Both strings, not either. */
const REPORT2_LABELS = ['Equator', 'Tropic of Cancer'] as const

/** DOM chrome that overlaps the `#map` canvas at this viewport (same list as
 *  `_demotiles-mirror-probe.spec.ts`) — hidden before every screenshot so a
 *  passing arm's saved frame is the map, not the demo shell. */
const HIDE_IDS = [
  'log-overlay',
  'status',
  'status-popover',
  'hash-badge',
  'map-tools',
  'editor-collapse-btn',
  'demo-actions',
]

type Proj = 'globe' | 'mercator'
type Backend = 'webgpu' | 'webgl2'

interface LabelCounts {
  submitted: number
  drawn: number
}

interface ArmResult {
  label: string
  proj: Proj
  intendedBackend: Backend
  actualBackend: string | null
  counts: LabelCounts | null
  texts: string[]
  nonBg: number
  errors: string[]
  mirrorFailed: string[]
  framePath: string
}

/** Drive one arm end to end: navigate, wait ready + settle, assert nothing
 *  (assertions are deferred to the caller so BOTH arms of a pair are always
 *  fully measured — and their console lines fully printed — before either
 *  arm's `expect()` can abort the test), capture a full-resolution
 *  screenshot, and return every number the pair-level assertions need. */
async function measureArm(
  page: Page,
  testInfo: TestInfo,
  proj: Proj,
  intendedBackend: Backend,
): Promise<ArmResult> {
  const label = `${proj}-${intendedBackend}`
  const errors: string[] = []
  const mirrorFailed: string[] = []
  const isMirror = (u: string) => u.includes('/vendor/demotiles-mirror/')
  const short = (u: string) => u.slice(u.indexOf('/vendor/demotiles-mirror/'))

  // Named handlers (not inline closures) so they can be `page.off()`'d at the
  // end of this arm — the same `page` is reused across both arms of a pair,
  // and a listener left attached would keep pushing the NEXT arm's events
  // into THIS arm's already-returned `errors`/`mirrorFailed` arrays.
  const onPageError = (e: Error): void => {
    errors.push(e.message.slice(0, 300))
  }
  const onConsole = (m: ConsoleMessage): void => {
    const t = m.text()
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push(t.slice(0, 300))
  }
  const onResponse = (r: import('@playwright/test').Response): void => {
    const u = r.url()
    if (!isMirror(u)) return
    if (r.status() >= 400) mirrorFailed.push(`${short(u)} → HTTP ${r.status()}`)
  }
  const onRequestFailed = (r: import('@playwright/test').Request): void => {
    if (isMirror(r.url())) mirrorFailed.push(`${short(r.url())} → ${r.failure()?.errorText}`)
  }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)

  await page.setViewportSize(VIEWPORT)
  const q = new URLSearchParams({ id: 'import_maplibre_mirror', e2e: '1', adaptive: '0', proj })
  // Default (`gpu: auto`) boots WebGPU with WebGL2 fallback — the exact path
  // #1508's reports ran under. `?forcegl2=1` is the legacy pin the rest of
  // this leg uses for the WebGL2 arm.
  if (intendedBackend === 'webgl2') q.set('forcegl2', '1')
  await page.goto(`/demo.html?${q.toString()}#${CAMERA}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 90_000 },
  )

  const readCounters = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisActiveBackend?: string
        __xgisMap?: {
          getDispatchedLabelTexts?: () => string[] | null
          getLastLabelCounts?: () => { submitted: number; drawn: number } | null
        }
      }
      return {
        backend: w.__xgisActiveBackend ?? null,
        texts: w.__xgisMap?.getDispatchedLabelTexts?.() ?? null,
        counts: w.__xgisMap?.getLastLabelCounts?.() ?? null,
      }
    })

  // Settle on a PREDICATE (submitted > 0), not a fixed wait — same reasoning
  // as `_demotiles-mirror-probe.spec.ts`. Generous iteration budget for a
  // cold WebGPU boot.
  let seen = await readCounters()
  for (let i = 0; i < 90 && (seen.counts?.submitted ?? 0) === 0; i++) {
    await page.waitForTimeout(1000)
    seen = await readCounters()
  }

  const hiddenChrome = await page.evaluate((ids) => {
    const hidden: string[] = []
    for (const id of ids) {
      const el = document.getElementById(id)
      if (!el) continue
      if (getComputedStyle(el).display !== 'none') hidden.push(id)
      el.style.display = 'none'
    }
    return hidden
  }, HIDE_IDS)

  const png = await captureCanvas(page, { readyTimeoutMs: 60_000 })
  const framePath = testInfo.outputPath(`${label}.png`)
  writeFileSync(framePath, png)
  await testInfo.attach(`${label}.png`, { body: png, contentType: 'image/png' })

  // Re-read AFTER the capture settle, so the returned counts describe the
  // same frame the screenshot does.
  seen = await readCounters()
  const nonBg = await sampleNonBackgroundPixels(page, png, { r: 0, g: 0, b: 0 })

  const shortTexts = JSON.stringify((seen.texts ?? []).slice(0, 20))
  console.log(
    `[webgpu-parity] ${label} intended=${intendedBackend} actual=${seen.backend} ` +
      `counts=${JSON.stringify(seen.counts)} texts=${shortTexts} ` +
      `nonBg=${nonBg} errors=${errors.length} mirrorFailed=${mirrorFailed.length} ` +
      `chromeHidden=[${hiddenChrome.join(',')}] frame=${framePath}`,
  )
  if (errors.length > 0) console.log(`[webgpu-parity] ${label} ERRORS ${errors.join(' | ')}`)
  if (mirrorFailed.length > 0)
    console.log(`[webgpu-parity] ${label} MIRROR-FAILED ${mirrorFailed.join(' | ')}`)

  page.off('pageerror', onPageError)
  page.off('console', onConsole)
  page.off('response', onResponse)
  page.off('requestfailed', onRequestFailed)

  return {
    label,
    proj,
    intendedBackend,
    actualBackend: seen.backend,
    counts: seen.counts,
    texts: seen.texts ?? [],
    nonBg,
    errors,
    mirrorFailed,
    framePath,
  }
}

/** Non-vacuity + backend identity, common to every arm. */
function assertArmHealthy(a: ArmResult): void {
  expect(
    a.mirrorFailed,
    `[${a.label}] mirrored assets did not serve: ${a.mirrorFailed.join(' | ')}`,
  ).toEqual([])
  expect(a.errors, `[${a.label}] page errors: ${a.errors.join(' | ')}`).toEqual([])
  // The load-bearing assertion: a silent WebGPU→WebGL2 auto-fallback would
  // otherwise let a "WebGPU" arm quietly re-measure WebGL2 and green this
  // probe without ever exercising the backend #1508 asks about.
  expect(
    a.actualBackend,
    `[${a.label}] backend mismatch — intended ${a.intendedBackend}, live ${a.actualBackend}. ` +
      `A silent fallback would make this arm measure the WRONG backend.`,
  ).toBe(a.intendedBackend)
  expect(
    a.nonBg,
    `[${a.label}] canvas reads as uniform black — nothing rendered (frame: ${a.framePath})`,
  ).toBeGreaterThan(0)
  expect(a.counts, `[${a.label}] no label counters — TextStage was never built`).not.toBeNull()
}

/** Cross-backend agreement, logged loudly before the hard ±1 assertion so a
 *  real divergence (not SwiftShader nondeterminism) is legible from the
 *  numbers alone. */
function assertCrossBackendCounts(a: ArmResult, b: ArmResult): void {
  console.log(
    `[webgpu-parity] ${a.proj} cross-backend submitted ${a.label}=${a.counts!.submitted} ` +
      `${b.label}=${b.counts!.submitted}`,
  )
  console.log(
    `[webgpu-parity] ${a.proj} cross-backend drawn ${a.label}=${a.counts!.drawn} ` +
      `${b.label}=${b.counts!.drawn}`,
  )
  expect(
    Math.abs(a.counts!.submitted - b.counts!.submitted),
    `[${a.proj}] submitted diverges beyond the SwiftShader ±1 guard: ` +
      `${a.label}=${a.counts!.submitted} vs ${b.label}=${b.counts!.submitted}`,
  ).toBeLessThanOrEqual(1)
  expect(
    Math.abs(a.counts!.drawn - b.counts!.drawn),
    `[${a.proj}] drawn diverges beyond the SwiftShader ±1 guard: ` +
      `${a.label}=${a.counts!.drawn} vs ${b.label}=${b.counts!.drawn}`,
  ).toBeLessThanOrEqual(1)
}

test('#1508 globe backend parity — WebGPU vs WebGL2 (offline mirror)', async ({
  page,
}, testInfo) => {
  const webgpu = await measureArm(page, testInfo, 'globe', 'webgpu')
  const webgl2 = await measureArm(page, testInfo, 'globe', 'webgl2')

  assertArmHealthy(webgpu)
  assertArmHealthy(webgl2)

  // Report 1: "globe vector rendering is broken". The structural signal a
  // GPU-less pixel check CAN make: labels reached the renderer at all. The
  // frame itself is saved above for the orchestrator's §5 pixel-diff pass.
  expect(
    webgpu.counts!.submitted,
    `[${webgpu.label}] no label reached TextStage — report 1's "broken" symptom`,
  ).toBeGreaterThan(0)

  assertCrossBackendCounts(webgpu, webgl2)
})

test('#1508 mercator backend parity — WebGPU vs WebGL2 (offline mirror)', async ({
  page,
}, testInfo) => {
  const webgpu = await measureArm(page, testInfo, 'mercator', 'webgpu')
  const webgl2 = await measureArm(page, testInfo, 'mercator', 'webgl2')

  assertArmHealthy(webgpu)
  assertArmHealthy(webgl2)

  // Report 2's direct, literal claim: BOTH "Equator" and "Tropic of Cancer"
  // must reach TextStage on the WebGPU arm (the backend the report actually
  // ran on).
  const missing = REPORT2_LABELS.filter((t) => !webgpu.texts.some((x) => x.includes(t)))
  expect(
    missing,
    `[${webgpu.label}] report 2's labels never dispatched: ${missing.join(', ')}. ` +
      `Got: ${webgpu.texts.slice(0, 20).join(', ')}`,
  ).toEqual([])

  assertCrossBackendCounts(webgpu, webgl2)
})
