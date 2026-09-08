// ═══ #2093 follow-up — the drape gate must hold through the zoom-in READINESS HOLD ═══
//
// Owner report after #2086 merged: "zooming in, the baked tiles are still visible".
//
// Mechanism. `currentZ` is a HYSTERESED zoom bucket: on a zoom-in the readiness gate
// (tile-selection-cache.ts, READINESS_TIMEOUT_MS = 5 s) holds the OLD LOD until every
// visible tile at the next LOD is cached, so the drawn tiles trail the camera by one —
// up to four — LODs for as long as the network takes. #2086 keyed the drape/direct
// decision on that HELD `currentZ`, so a camera whose own LOD would render direct kept
// DRAPING: 512px bakes of the held tiles, magnified for the whole hold window, on
// every zoom-in. The camera's own LOD (`min(floor(zoom), maxLevel)`) is the quantity
// the budget is priced on; the hold is a tile-residency fact, not a rendering-quality
// one.
//
// #2094 RE-POINT. The gate the hold feeds is now a PIXEL BUDGET
// (map/src/render/globe-drape-budget.ts), not a LOD ceiling, so a step is only a
// witness where the two readings PRICE differently. See HOLD_ZOOM below: z5 → z6
// prices identically (the tiler subdivides both to 1.40625 deg) and would have made
// this gate vacuous; z8 → z9 differs 4x, which is the original report pair.
//
// This gate reproduces the hold DETERMINISTICALLY: the step-LOD tile requests are
// stalled at the Playwright route layer (the offline proxy still serves everything
// else), the camera moves START_ZOOM → HOLD_ZOOM, and the frame is captured while
// `_hysteresisZ` is provably still HELD_LOD with `_czPendingAdvance` set (holding) —
// re-verified after the shot, which is what makes the PNG a held frame.
//
//   CAUSE  — during the hold a source the camera can be SERVED by reports
//            `_drapeGlobeFills === false`: the direct arm owns the held frame.
//   EFFECT — the SAME held frame under `__XGIS_FORCE_VECTOR_DRAPE` (the sever arm, a
//            fresh page so the step tiles are un-cached again) actually PRODUCES
//            drape bakes for every source the camera can be served by
//            (`SourceState.bakedCount > 0`, populated at dumpState), while the
//            direct arm's OWN held frame — `state-held-direct.json`, written by
//            captureHeldFrame — produced none (`bakedCount === 0`) for the SAME
//            sources: 0 bakes is a routing fact a rendered pixel cannot fake. This
//            replaces a rendered-pixel-delta EFFECT retired by #2134; see "WHY NOT A
//            PIXEL-DELTA BETWEEN THE ARMS" below (#2615).
//
// WHY NOT A SHARPNESS METRIC. This gate first asserted that the direct held frame
// scored higher on the mean of the top 1 % of |grad luminance|. It does not, and the
// frames say why: at a coarse held LOD the drape's magnified bake draws each road
// as a DARK 3-px band on a light ground, and the luminance jump across that band's
// edge is bigger than the jump across the thin, faint, correctly-thin road the
// direct arm draws. The metric ranks CONTRAST, not sharpness, so it scored the
// blurry arm higher (251.60 direct vs 256.88 drape at the first camera pair, while
// a full-resolution read of the same two frames shows the drape's roads smeared
// into bands and the direct arm's at Positron's own width). It is kept as a LOGGED
// diagnostic, never an assertion — a metric that inverts on the case the gate
// exists for is a broken ruler (CLAUDE.md sec 12).
//
// WHY NOT A PIXEL-DELTA BETWEEN THE ARMS. This gate's sever test first asserted EFFECT
// as two rendered-pixel deltas: the direct-held and forced-drape-held frames must differ
// by more than a noise-scaled floor (EFFECT 1), and the forced frame must sit FARTHER
// from the converged, LOD-advanced frame than the direct one does (EFFECT 2). #2615's
// render-shard (2/6) reddened EFFECT 1 on a tree with #2134 applied: the two held frames
// differed by 0.74 % against a computed floor of 1.90 %. This is NOT a regression —
// #2134 removed a spurious second alpha multiply from the drape composite, and that
// double-multiply WAS the thing EFFECT 1 measured. MEASURED, one variable (the #2134
// diff), cut and restored by absolute path with the restore grep-asserted,
// SwiftShader/WebGPU, this exact gate, local, reproducing CI to four decimals:
//
//   tree                                   armDelta  floor   forcedVsAdvanced  directVsAdvanced  gate
//   #2134 applied (current branch)         0.0074    0.0192  0.1333            0.1333            FAIL
//   #2134 reverted (blend premult->alpha)  0.1398    0.0163  0.2404            0.1349            PASS
//
// Read the middle two columns: with the defect present (cut) the drape sat 0.2404 from
// the converged frame while direct sat 0.1349 — 78 % further away, exactly what EFFECT 2
// was built to catch. With #2134 applied the two COLLAPSE to 0.1333 and 0.1333 —
// identical. That residual is the held-LOD difference both arms share by construction
// (same held tiles, coarser than the converged frame), not a routing difference: the
// drape now renders those tiles exactly the way the direct path does, so the two paths
// are pixel-EQUIVALENT for this held frame, and a pixel delta between them no longer
// carries signal (0.74 % against a 0.476 % capture noise floor is 1.55× noise). Lowering
// the floor is NOT the fix — an assertion that cannot distinguish its own two states is
// exactly what CLAUDE.md sec 12 forbids ("an assertion carries information only if it
// DISTINGUISHES the states of the thing it tests"). armDelta, forcedVsAdvanced, floor
// and sharpForced are kept as LOGGED diagnostics (report-forced.json stays
// byte-identical in shape) for the same reason sharpness is above — same treatment, same
// reason.
//
// Measured, across every state this gate dumps (real SwiftShader/WebGPU runs of this
// exact gate): `bakedCount` for the servable source `openmaptiles`.
//
//   state-start-direct     0     state-start-forced     10
//   state-held-direct      0     state-held-forced      170
//   state-advanced-direct  0
//
// The direct arm never bakes at any point in this scenario; the forced arm does,
// throughout.
//
// The retired `armDelta` assertion could red for two different reasons: (a) the
// forced arm did not bake at all, so there was nothing to composite differently,
// or (b) the forced arm baked but the result looked the same as direct. #2134 made
// (b) the normal, CORRECT case — which is what destroyed the assertion. The new
// `bakedCount > 0` (EFFECT half 1 below) isolates (a): it keeps the half of the
// old assertion's coverage that was worth keeping, and expresses it on the
// mechanism instead of on pixels.
//
// LIMITATION, stated plainly: neither new assertion can be demonstrated by a
// fail-before source cut, and this is structural, not an oversight. The describe
// block is `test.describe.configure({ mode: 'serial' })`, so any regression that
// reddens the first (direct) test SKIPS the sever test entirely — its assertions
// never run to report anything. And inside the sever test itself, the
// pre-existing `expect(s.drapeGlobeFills).toBe(true)` runs BEFORE
// `expect(s.bakedCount).toBeGreaterThan(0)` in the same loop, so it always
// speaks first. The new assertions are strictly STRONGER than the ones
// preceding them — a decision to drape vs a bake actually produced — so they can
// only fire on states those already pass. Their non-vacuity therefore rests on both
// states having been MEASURED directly, the table above, not on an observed red. A
// cut of #2094's own mechanism was tried anyway: `Math.max(ctx.currentZ,
// ctx.targetZ)` → `ctx.currentZ` at vector-tile-renderer.ts:4014. It did NOT redden
// the gate — it does not change the budget's decision at this camera — so it
// proves nothing in either direction and is recorded here only so nobody retries
// it.
//
// Capture note (capture-canvas skill). The held frame is captured WITHOUT
// captureMapFrame's quiesce: the hold IS a pending-load state — that is the thing
// under test — so the quiesce would wait out its 20 s budget, outlive the 5 s
// readiness timeout, and hand back the post-advance frame. Chrome is hidden with the
// same hideDemoChrome() captureMapFrame uses (before the camera moves, so it costs
// nothing inside the window), the clip is #map's box (captureCanvas's own 'clip'
// strategy), and the hold is re-asserted AFTER the shot so a capture that outlived
// the hold fails loud instead of measuring the wrong frame. The advanced frame (stall
// released, the step LOD resident) goes through captureMapFrame normally and is
// captured twice — the noise floor of the harness is a property of the capture, not
// of the frame, so it is measured where there is no clock to race.
//
// Artifacts: __globe-direct-hold-window__/ (gitignored).

import { test, expect, type Page } from '@playwright/test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureMapFrame, hideDemoChrome, pixelDiffRatio } from './helpers/visual'
import { installOfflineProxy } from './helpers/offline-proxy'
import { expectDrape, minServableMaxLevel, readChordBudgetPx } from './helpers/drape-budget'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__globe-direct-hold-window__')
const NET_CACHE = join(HERE, '__net-cache__')

const DEMO_ID = 'openfreemap_positron'
/** The #2093 report centre (Seoul west). */
const CENTER = '37.54704/126.81412'
/** Inside the drape budget AND below the Tier-2 zoom-in prefetch trigger
 *  (`camera.zoom > currentZ + 0.5` would pre-cache the step LOD and defeat the
 *  hold). currentZ 8 — the last level the tiler leaves UNSPLIT, so a held reading
 *  here is 4x the error of the camera's own (#2094). */
const START_ZOOM = 8.3
/** floor → 9. The gate steps 8 → 9 and waits on the z9 set.
 *
 *  #2094 RE-POINT. Under a LOD ceiling any step across it was a witness. Under a
 *  PIXEL BUDGET the two readings must price differently, and z5 → z6 does not:
 *  the tiler subdivides both down to the SAME 1.40625° segment, so a held z5 and a
 *  target z6 carry identical chord error and the gate could not tell a currentZ-only
 *  gate from the fixed one. z8 is the last level the tiler leaves UNSPLIT and z9 is
 *  split once, so the error differs 4× across that step: held-z8-at-z9.6 is 4.76 px
 *  (past the budget → drape) while z9-at-z9.6 is 1.19 px (direct). That is the
 *  original #2093 report pair, restored for the reason it was chosen. */
const HOLD_ZOOM = 9.6
const HELD_LOD = 8
const STEP_LOD = 9
/** OFM planet tiles: https://tiles.openfreemap.org/planet/<snapshot>/{z}/{x}/{y}.pbf */
const STEP_TILE_RE = /\/planet\/[^/]+\/9\/\d+\/\d+\.pbf(\?.*)?$/

/** Sever discriminator: the held direct frame vs the held drape frame must differ
 *  by more than this multiple of the measured same-frame capture noise, and by at
 *  least ARM_DELTA_MIN of the frame (the _globe-direct-overzoom-sharpness-gate
 *  floors). */
const ARM_DELTA_FLOOR_MULT = 4
const ARM_DELTA_MIN = 0.01

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __holdT0?: number
  __holdTimeline?: Array<Record<string, unknown>>
  __holdTimelineStop?: () => void
  __xgisMap?: {
    camera: { zoom: number }
    _frameCount?: number
    running?: boolean
    invalidate?: () => void
    _scheduleFrame?: () => void
    vtSources?: Map<
      string,
      {
        renderer: Record<string, unknown>
        source: { maxLevel: number; getPendingLoadCount?: () => number }
      }
    >
  }
}

interface SourceState {
  maxLevel: number
  hysteresisZ: number
  lastZoom: number
  pendingAdvance: { target: number; since: number } | null
  drapeGlobeFills: boolean
  drapeStrokes: boolean
  bakedCount: number
  pendingLoads: number
  frameCount: number
}
interface StateDump {
  backend: string
  dpr: number
  cameraZoom: number
  sources: Record<string, SourceState>
}

function demoUrl(zoom: number): string {
  const params = new URLSearchParams({ id: DEMO_ID, e2e: '1', adaptive: '0', proj: 'globe' })
  return `/demo.html?${params.toString()}#${zoom}/${CENTER}`
}

async function dumpState(page: Page): Promise<StateDump> {
  return page.evaluate(() => {
    const w = window as unknown as Win
    const out: StateDump = {
      backend: w.__xgisActiveBackend ?? 'unknown',
      dpr: window.devicePixelRatio,
      cameraZoom: w.__xgisMap?.camera.zoom ?? NaN,
      sources: {},
    }
    const vt = w.__xgisMap?.vtSources
    if (!vt) return out
    for (const [name, entry] of vt) {
      const r = entry.renderer
      const sel = r['_selection'] as
        | { _hysteresisZ?: number; _czPendingAdvance?: { target: number; since: number } | null }
        | undefined
      const drape = r['_drape'] as { baked?: Map<string, unknown> } | undefined
      out.sources[name] = {
        maxLevel: entry.source.maxLevel,
        hysteresisZ: sel?._hysteresisZ ?? -1,
        lastZoom: (r['lastZoom'] as number | undefined) ?? -1,
        pendingAdvance: sel?._czPendingAdvance ?? null,
        drapeGlobeFills: Boolean(r['_drapeGlobeFills']),
        drapeStrokes: Boolean(r['_drapeStrokes']),
        bakedCount: drape?.baked?.size ?? 0,
        pendingLoads: entry.source.getPendingLoadCount?.() ?? 0,
        frameCount: (r['frameCount'] as number | undefined) ?? -1,
      }
    }
    return out
  })
}

/** Mean of the top 1 % of |∇luminance| over the interior rows — crisp edges score
 *  high, a magnified bake's feather scores low. Decoded in-page like pixelDiffRatio. */
async function edgeSharpness(page: Page, png: Buffer): Promise<number> {
  return page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const { data, width: w, height: h } = ctx.getImageData(0, 0, bmp.width, bmp.height)
    const lum = new Float32Array(w * h)
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      lum[p] = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!
    }
    const margin = 40
    const grads: number[] = []
    for (let y = margin; y < h - margin; y++) {
      for (let x = 1; x < w - 1; x++) {
        const p = y * w + x
        grads.push(Math.abs(lum[p + 1]! - lum[p - 1]!) + Math.abs(lum[p + w]! - lum[p - w]!))
      }
    }
    grads.sort((a, b) => b - a)
    const n = Math.max(1, Math.floor(grads.length * 0.01))
    let s = 0
    for (let i = 0; i < n; i++) s += grads[i]!
    return s / n
  }, png.toString('base64'))
}

/** Stall every step-LOD tile request until `release()`; registered AFTER the offline
 *  proxy so Playwright tries it first, and `route.fallback()` hands the released
 *  request to the proxy. */
async function installStepTileStall(
  page: Page,
): Promise<{ release: () => void; stalledCount: () => number }> {
  let released = false
  let resolveRelease: () => void = () => {}
  const releasePromise = new Promise<void>((r) => (resolveRelease = r))
  let stalled = 0
  await page.route(STEP_TILE_RE, async (route) => {
    if (!released) {
      stalled++
      await releasePromise
    }
    await route.fallback()
  })
  return {
    release: () => {
      released = true
      resolveRelease()
    },
    stalledCount: () => stalled,
  }
}

/** The sources the camera can be SERVED by at HOLD_ZOOM — the only ones whose
 *  drape state says anything about the #2094 budget. A maxLevel-0 synthetic source
 *  legitimately keeps the drape at every camera, so judging it here would accuse
 *  the gate's own subject of failing. */
function servableSources(dump: StateDump): [string, SourceState][] {
  return Object.entries(dump.sources).filter(([, s]) => !expectDrape(s.maxLevel, HOLD_ZOOM))
}

/** Load at START_ZOOM, settle, hide chrome, move to HOLD_ZOOM under the stall, wait
 *  for the gate to be provably holding, capture, re-verify the hold. Returns the held
 *  PNG + state and leaves the stall in place (caller releases).
 *
 *  Timing: the readiness timeout is counted from the FIRST frame that evaluates the
 *  gate under the new camera (`_czPendingAdvance.since`), not from the camera write —
 *  on SwiftShader that first frame can itself take seconds (the zoom-bucket change
 *  re-bakes every held tile). So the witness waits for that frame with a long budget,
 *  captures immediately, and the post-shot state (`_hysteresisZ` still HELD_LOD) is
 *  what proves the PNG holds a held frame. */
async function captureHeldFrame(
  page: Page,
  tag: string,
): Promise<{
  png: Buffer
  state: StateDump
  holdElapsedMs: number
  startState: StateDump
  stall: { release: () => void; stalledCount: () => number }
}> {
  await installOfflineProxy(page, { cacheDir: NET_CACHE })
  const stall = await installStepTileStall(page)
  await page.goto(demoUrl(START_ZOOM), { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 180_000,
  })
  // Converge the START_ZOOM scene (its z8 set is served by the proxy) before the move,
  // so the only pending work inside the hold window is the stalled step LOD.
  await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  const startState = await dumpState(page)
  writeFileSync(join(OUT, `state-start-${tag}.json`), JSON.stringify(startState, null, 2))
  // Chrome off BEFORE the move — nothing inside the window but the shot.
  await hideDemoChrome(page)
  const box = await page.locator('#map').boundingBox()
  if (!box) throw new Error('#map has no bounding box')

  await page.evaluate(
    ({ z, minMaxLevel }) => {
      const w = window as unknown as Win
      w.__holdT0 = performance.now()
      w.__xgisMap!.camera.zoom = z
      w.__xgisMap!.invalidate?.()
      // 50 ms timeline of the hold dynamics — written to the report even when the
      // witness below times out, so a failure names the mechanism.
      const timeline: Array<Record<string, unknown>> = []
      w.__holdTimeline = timeline
      const id = setInterval(() => {
        const m = w.__xgisMap
        const row: Record<string, unknown> = {
          t: Math.round(performance.now() - (w.__holdT0 ?? 0)),
          zoom: m?.camera.zoom,
          mapFrames: m?._frameCount,
        }
        for (const [name, e] of m?.vtSources ?? []) {
          if (e.source.maxLevel < minMaxLevel) continue
          const sel = e.renderer['_selection'] as
            { _hysteresisZ?: number; _czPendingAdvance?: unknown } | undefined
          row[name] = {
            hystZ: sel?._hysteresisZ,
            pend: !!sel?._czPendingAdvance,
            lastZoom: e.renderer['lastZoom'],
            loads: e.source.getPendingLoadCount?.() ?? -1,
            drape: !!e.renderer['_drapeGlobeFills'],
          }
        }
        timeline.push(row)
        if (timeline.length > 2400) clearInterval(id)
      }, 50)
      w.__holdTimelineStop = () => clearInterval(id)
    },
    { z: HOLD_ZOOM, minMaxLevel: minServableMaxLevel(HOLD_ZOOM) },
  )
  // The gate is provably holding: a frame has evaluated it under the new camera
  // (`_czPendingAdvance` set), and every SERVABLE source still draws HELD_LOD.
  // The SAME page task then PAUSES the render loop (`running = false`; the queued rAF
  // tick early-returns), so no later frame can replace the held one before the shot —
  // on SwiftShader a frame here takes ~7 s, longer than the 5 s readiness timeout, so
  // without the pause the very next frame is already the timed-out advance (measured:
  // the first version of this gate captured LOD 9 while asserting LOD 8). The loop is
  // resumed by captureAdvancedFrame (or never, if the test fails here).
  try {
    await page.waitForFunction(
      ({ heldLod, z, minMaxLevel }) => {
        const w = window as unknown as Win
        const m = w.__xgisMap
        if (!m?.vtSources || Math.abs(m.camera.zoom - z) > 1e-9) return false
        let any = false
        for (const [, e] of m.vtSources) {
          if (e.source.maxLevel < minMaxLevel) continue
          any = true
          const sel = e.renderer['_selection'] as
            { _hysteresisZ?: number; _czPendingAdvance?: unknown } | undefined
          if (
            sel?._hysteresisZ !== heldLod ||
            !sel?._czPendingAdvance ||
            e.renderer['lastZoom'] !== heldLod
          ) {
            m.invalidate?.()
            return false
          }
        }
        if (any) m.running = false
        return any
      },
      { heldLod: HELD_LOD, z: HOLD_ZOOM, minMaxLevel: minServableMaxLevel(HOLD_ZOOM) },
      { timeout: 180_000, polling: 50 },
    )
  } catch (err) {
    const failure = {
      error: String(err),
      stalledStepRequests: stall.stalledCount(),
      state: await dumpState(page),
      timeline: await page.evaluate(() => (window as unknown as Win).__holdTimeline ?? []),
    }
    writeFileSync(join(OUT, `failure-${tag}.json`), JSON.stringify(failure, null, 2))
    throw err
  }
  const png = await page.screenshot({ clip: box, animations: 'disabled' })
  // Elapsed since the gate's own timer started (the first held frame), for the record.
  const holdElapsedMs = await page.evaluate((minMaxLevel) => {
    const w = window as unknown as Win
    let since = w.__holdT0 ?? 0
    for (const [, e] of w.__xgisMap?.vtSources ?? []) {
      if (e.source.maxLevel < minMaxLevel) continue
      const sel = e.renderer['_selection'] as
        { _czPendingAdvance?: { since: number } | null } | undefined
      if (sel?._czPendingAdvance) since = sel._czPendingAdvance.since
    }
    return performance.now() - since
  }, minServableMaxLevel(HOLD_ZOOM))
  const state = await dumpState(page)
  const timeline = await page.evaluate(() => {
    const w = window as unknown as Win
    w.__holdTimelineStop?.()
    return w.__holdTimeline ?? []
  })
  writeFileSync(join(OUT, `timeline-${tag}.json`), JSON.stringify(timeline))
  writeFileSync(join(OUT, `held-${tag}.png`), png)
  writeFileSync(join(OUT, `state-held-${tag}.json`), JSON.stringify(state, null, 2))
  return { png, state, holdElapsedMs, startState, stall }
}

async function captureAdvancedFrame(
  page: Page,
  tag: string,
  stall: { release: () => void },
): Promise<{ png: Buffer; png2: Buffer; state: StateDump }> {
  stall.release()
  await page.evaluate(() => {
    const m = (window as unknown as Win).__xgisMap
    if (!m) return
    m.running = true
    m.invalidate?.()
    m._scheduleFrame?.()
  })
  await page.waitForFunction(
    ({ stepLod, minMaxLevel }) => {
      const w = window as unknown as Win
      const m = w.__xgisMap
      if (!m?.vtSources) return false
      let pending = 0
      for (const [, e] of m.vtSources) {
        pending += e.source.getPendingLoadCount?.() ?? 0
        if (e.source.maxLevel < minMaxLevel) continue
        const sel = e.renderer['_selection'] as { _hysteresisZ?: number } | undefined
        if (sel?._hysteresisZ !== stepLod) return false
      }
      if (pending > 0) m.invalidate?.()
      return pending === 0
    },
    { stepLod: STEP_LOD, minMaxLevel: minServableMaxLevel(HOLD_ZOOM) },
    { timeout: 180_000, polling: 100 },
  )
  const png = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  const png2 = await captureMapFrame(page, { readyTimeoutMs: 120_000, capture: 'clip' })
  const state = await dumpState(page)
  writeFileSync(join(OUT, `advanced-${tag}.png`), png)
  writeFileSync(join(OUT, `state-advanced-${tag}.json`), JSON.stringify(state, null, 2))
  return { png, png2, state }
}

test.describe('#2094 — the drape budget holds through the zoom-in readiness hold', () => {
  // Serial: the sever arm compares against the direct arm's held frame on disk.
  //
  // The budget is 2x the sum of this gate's OWN declared inner waits, and it has to be:
  // at 900_000 it was EQUAL to that sum, so the gate could spend exactly the allowances
  // it documents and still be killed by its parent, with nothing left for boot, frame
  // time or the four in-page PNG decodes. captureHeldFrame declares 180 s (ready) +
  // 120 s (converge) + 180 s (hold witness); captureAdvancedFrame declares 180 s
  // (drain) + 2x120 s (capture) = 900 s. It only ever passed because those waits
  // normally return early -- which is not headroom, it is luck, and CI spent it
  // (#2483: three attempts, each killed at 900 s inside a page.evaluate PNG decode;
  // the same test passes here on SwiftShader in 12.3 min, i.e. 82 % of the old budget).
  test.describe.configure({ mode: 'serial', timeout: 1_800_000 })
  test.use({ viewport: { width: 1024, height: 720 } })

  test.beforeAll(() => {
    mkdirSync(OUT, { recursive: true })
  })

  test('held frame past the ceiling renders DIRECT (cause) and is not the drape (effect)', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

    const held = await captureHeldFrame(page, 'direct')
    const adv = await captureAdvancedFrame(page, 'direct', held.stall)

    const noiseFloor = await pixelDiffRatio(page, adv.png, adv.png2)
    const heldVsAdvanced = await pixelDiffRatio(page, held.png, adv.png)
    const sharpHeld = await edgeSharpness(page, held.png)
    const sharpAdvanced = await edgeSharpness(page, adv.png)
    const report = {
      budgetPx: readChordBudgetPx(),
      holdElapsedMs: held.holdElapsedMs,
      stalledStepRequests: held.stall.stalledCount(),
      noiseFloor,
      heldVsAdvanced,
      sharpHeld,
      sharpAdvanced,
      startState: held.startState,
      heldState: held.state,
      advancedState: adv.state,
      pageErrors: errors,
    }
    writeFileSync(join(OUT, 'report-direct.json'), JSON.stringify(report, null, 2))
    console.log(
      `[hold-window direct] backend=${held.state.backend} holdElapsed=${held.holdElapsedMs.toFixed(0)}ms ` +
        `stalled=${held.stall.stalledCount()} noise=${noiseFloor.toFixed(4)} ` +
        `heldVsAdvanced=${heldVsAdvanced.toFixed(4)} sharpHeld=${sharpHeld.toFixed(2)} ` +
        `sharpAdvanced=${sharpAdvanced.toFixed(2)}`,
    )

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
    expect(
      held.state.backend,
      'the drape is WebGPU-only; a WebGL2 fallback greens this vacuously',
    ).toBe('webgpu')
    const heldSources = servableSources(held.state)
    expect(heldSources.length, 'no source reaches the ceiling — nothing to gate').toBeGreaterThan(0)
    // The hold itself, re-verified after the shot: the frame in the PNG is a held one.
    for (const [name, s] of heldSources) {
      expect(
        s.hysteresisZ,
        `${name}: the gate was not holding at LOD ${HELD_LOD} when captured`,
      ).toBe(HELD_LOD)
      expect(
        s.pendingAdvance,
        `${name}: no pending advance — the hold was not active`,
      ).not.toBeNull()
      expect(held.state.cameraZoom).toBe(HOLD_ZOOM)
    }
    expect(
      held.stall.stalledCount(),
      'no step-LOD request was stalled — the hold was not network-bound',
    ).toBeGreaterThan(0)
    // CAUSE — direct during the hold, because the CAMERA is past the ceiling even
    // though the drawn LOD is not yet.
    for (const [name, s] of heldSources) {
      expect(
        s.drapeGlobeFills,
        `${name}: the held frame is still DRAPED at camera z${HOLD_ZOOM} (currentZ ${s.hysteresisZ}) — ` +
          `the drape budget is being priced on the held LOD, not the camera's, so every ` +
          `zoom-in through this band shows 2^(zoom−${HELD_LOD})×-magnified bakes until the ` +
          `step tiles land`,
      ).toBe(false)
      expect(s.drapeStrokes, `${name}: strokes still baked during the hold`).toBe(false)
    }
    // After the advance the frame is direct at LOD 9 — the #2086 state.
    for (const [name, s] of servableSources(adv.state)) {
      expect(s.hysteresisZ, `${name}: did not advance to ${STEP_LOD} after the release`).toBe(
        STEP_LOD,
      )
      expect(s.drapeGlobeFills, `${name}: draping at LOD ${STEP_LOD}`).toBe(false)
    }
  })

  test('sever — the same hold under __XGIS_FORCE_VECTOR_DRAPE is measurably the drape', async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    await page.addInitScript(() => {
      ;(globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }).__XGIS_FORCE_VECTOR_DRAPE = true
    })

    const held = await captureHeldFrame(page, 'forced')
    held.stall.release()

    const directHeld = readFileSync(join(OUT, 'held-direct.png'))
    const advanced = readFileSync(join(OUT, 'advanced-direct.png'))
    const directReport = JSON.parse(readFileSync(join(OUT, 'report-direct.json'), 'utf8')) as {
      noiseFloor: number
      sharpHeld: number
      heldVsAdvanced: number
    }
    const armDelta = await pixelDiffRatio(page, directHeld, held.png)
    // The DIRECTIONAL half (§5 ladder): both held arms draw the SAME held-LOD tiles, so the
    // only thing separating them from the converged, direct, LOD-advanced frame is
    // the render path. The arm that renders those tiles the way the advanced frame
    // does must be the closer one.
    const forcedVsAdvanced = await pixelDiffRatio(page, advanced, held.png)
    const sharpForced = await edgeSharpness(page, held.png)
    const floor = Math.max(directReport.noiseFloor * ARM_DELTA_FLOOR_MULT, ARM_DELTA_MIN)
    const report = {
      holdElapsedMs: held.holdElapsedMs,
      stalledStepRequests: held.stall.stalledCount(),
      armDelta,
      floor,
      forcedVsAdvanced,
      directVsAdvanced: directReport.heldVsAdvanced,
      sharpForced,
      sharpDirect: directReport.sharpHeld,
      heldState: held.state,
      pageErrors: errors,
    }
    writeFileSync(join(OUT, 'report-forced.json'), JSON.stringify(report, null, 2))
    console.log(
      `[hold-window sever] armDelta=${armDelta.toFixed(4)} floor=${floor.toFixed(4)} ` +
        `forcedVsAdvanced=${forcedVsAdvanced.toFixed(4)} ` +
        `directVsAdvanced=${directReport.heldVsAdvanced.toFixed(4)} ` +
        `sharpForced=${sharpForced.toFixed(2)} sharpDirect=${directReport.sharpHeld.toFixed(2)} ` +
        `(sharpness is DIAGNOSTIC ONLY — see the header)`,
    )

    expect(errors, `pageerrors: ${errors.join(' | ')}`).toEqual([])
    const heldSources = servableSources(held.state)
    expect(heldSources.length).toBeGreaterThan(0)
    for (const [name, s] of heldSources) {
      expect(s.hysteresisZ, `${name}: not holding`).toBe(HELD_LOD)
      expect(s.drapeGlobeFills, `${name}: the force flag did not reach the drape routing`).toBe(
        true,
      )
      // EFFECT, half 1 of 2 (replaces the retired pixel-delta EFFECT — see header "WHY
      // NOT A PIXEL-DELTA BETWEEN THE ARMS", #2134 / #2615): the forced arm must have
      // actually PRODUCED a bake, not merely claim to be draping. #2134 changed how a
      // bake is COMPOSITED, not whether one is produced, so this survives it.
      expect(
        s.bakedCount,
        `${name}: drapeGlobeFills is true but bakedCount is ${s.bakedCount} — the routing ` +
          `claims to be draping without having produced a bake to draw`,
      ).toBeGreaterThan(0)
    }
    // EFFECT, half 2 of 2: the SAME servable sources, read from the direct arm's own
    // held-state dump — same reader idiom as report-direct.json above — must show
    // ZERO bakes at the same camera and the same held tiles. 0 vs >0 (half 1, in the
    // loop above) is the routing moving, a fact #2134's composite fix cannot touch
    // (see header "WHY NOT A PIXEL-DELTA BETWEEN THE ARMS").
    const directHeldState = JSON.parse(
      readFileSync(join(OUT, 'state-held-direct.json'), 'utf8'),
    ) as StateDump
    const directHeldSources = servableSources(directHeldState)
    expect(
      directHeldSources.length,
      'state-held-direct.json has no servable source — the discriminator has nothing to ' +
        'compare the forced arm against',
    ).toBeGreaterThan(0)
    for (const [name, s] of directHeldSources) {
      expect(
        s.bakedCount,
        `${name}: the direct-held arm reports ${s.bakedCount} drape bakes at the same camera ` +
          `and held tiles the forced arm baked for — bakedCount, not a rendered-pixel delta ` +
          `(#2134 retired that form; see header), is what separates the two arms`,
      ).toBe(0)
    }
  })
})
