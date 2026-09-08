// ═══ #2346 — orthographic (disc) drape virtual-overzoom sharpness gate ═══
//
// MIRROR of `_globe-drape-overzoom-gate.spec.ts` (#2024): same source, same camera, same
// metric — only `?proj=orthographic` differs from that spec's `?proj=globe`. The STYLE /
// CENTER / ZOOM fixture, `dumpSources`, `drainUploads`, and the in-page coast-edge pixel
// analysis (`isGreen` / soft-band `fracWide`) below are copied BYTE-FAITHFUL from that file —
// it exports none of them, and importing test-body helpers across sibling `.spec.ts` files is
// not this codebase's pattern, so copying is the only option. They are kept byte-identical
// (module differences aside) so the two gates stay directly comparable — read them side by
// side, not this file alone. Two deliberate departures from a pure copy are called out where
// they occur below: this URL pins `?adaptive=0` (the template's does not; CLAUDE.md §12), and
// the PREMISE/CAUSE assertions are the disc-specific set below, not a re-derivation of the
// sphere gate's own. The fixture, harness and pixel analysis below are copied byte-faithfully
// from that spec so the two gates measure the same coast edge the same way; consolidating
// them into a shared `e2e/helpers/` module is out of scope here, since it would require
// editing the sibling spec too. No `jscpd:ignore` marker is needed for that copy: the
// duplication GATE runs with `TEST_IGNORE` (`scripts/dup-ratchet.ts:112,564`), which excludes
// `**/*.spec.ts`, and `playground/e2e` is walked only by the `--report --tests` lens (`:99-100`).
//
// ── THE DEFECT (#2346) ──────────────────────────────────────────────────────────────────
// #2024 built the windowed virtual-overzoom mechanism: past a source's maxLevel, drape a
// SHARP windowed sub-tile bake of the resident ancestor instead of the fixed 512px bake
// magnified by 2^(camZoom − maxLevel) (the "goes low-res past the source max" blur). It
// shipped gated on `isGlobeProj(a.projType)` — `drape-overzoom-dispatch.ts:169`:
//
//     if (!isGlobeProj(a.projType) || srcMaxLevel <= 0 || effectiveZ <= a.currentZ) {
//       if (diag) diag.reason = !isGlobeProj(a.projType) ? 'not-globe' : ...
//
// `isGlobeProj` (geo/src/projections-table.ts:327) is true ONLY for projType 7 (globe). But
// the fill this dispatch feeds does not gate on projType 7 at all: `_drapeGlobeFills`
// (vector-tile-renderer.ts:4007-4008) and the stroke half `_bakeStrokesGated` (:4000-4002)
// both gate on `bakesVectorDrape(projType, globeMode)`, which is `{3,4,5} ∪ globeMode`
// (geo/src/projections-table.ts:265-268) — orthographic (3), azimuthal_equidistant (4) and
// stereographic (5) ALREADY bake→drape their fills, at every camera, on the production path.
// Tile SELECTION for the same trio is already sphere-routed too: `routeToSphereSelector`
// (geo/src/projections-table.ts:223-226) is `{3,4,5,6} ∪ globeMode` — a strict SUPERSET of
// `bakesVectorDrape` (it also admits oblique_mercator=6, which excludes itself from the fill
// drape for an unrelated reason, projections-table.ts:243) — and `tile-selection-cache.ts:739`
// already branches on it to call `globeVisibleTiles` for exactly this trio. So by the time a
// frame reaches `computeDrapeOverzoom`, the disc trio is already draping its fills and already
// tile-selecting through the sphere-aware selector; the dispatch's OWN internal gate
// (`isGlobeProj`, true only for 7) is a THIRD, narrower predicate that silently excludes the
// very projections the other two gates already committed to. The function's own header admits
// the gap (drape-overzoom-dispatch.ts:85-87): "the flat-disc drape trio (3/4/5) selects via
// SSE and keeps the parent-magnified behaviour for now" — a warning that outlived it (CLAUDE.md
// §12). The fix swaps line 169's `isGlobeProj` for a disc-inclusive predicate so the trio gets
// the same windowed sharpening the globe already has, and renames the declined-branch reason
// string quoted above to `'not-sphere-routed'` — a predicate-only revert on the current
// (post-#2346) tree therefore emits the NEW string, not the old one (measured; see the CAUSE
// assertion below).
//
// ── PITCH MUST BE 0 (do not "fix" this) ─────────────────────────────────────────────────
// `camera.ts:159-163` (`setProjection`) promotes the disc trio to projType 7 (`GLOBE_PROJ_TYPE`,
// geo/src/globe.ts:37) + `globeMode = true` whenever `pitch > 0` (`promotesToGlobeWhenTilted`,
// geo/src/projections-table.ts:245-248 — exactly {3,4,5}). A tilted ortho camera therefore
// runs the ALREADY-correct globe arm (`isGlobeProj(7) === true` regardless of the #2346 fix),
// so a gate that tilts would pass on the UNFIXED tree too and prove nothing about the
// disc-specific bug. The demo's default pitch is 0; this spec never sets one and asserts it.
//
// ── MEASURED (all six arms; cut+restore by absolute path, restore grep-asserted) ─────────
// SwiftShader/WebGPU, offline demotiles mirror (maxzoom 2), Benghazi coast {lon: 20.07, lat:
// 32.17}, zoom 10.3, pitch 0, 1024×720, `?adaptive=0`, engine-counter convergence (residual 0):
//
//   | arm                           | virtualBakes | diag.reason        | greenFrac | fracWide | softMax |
//   | ------------------------------ | ------------ | ------------------ | --------- | -------- | ------- |
//   | globe control, fix ON          | 16           | engaged            | 0.4574    | 0.0250   | -       |
//   | globe control, predicate CUT   | 16           | engaged            | 0.4574    | 0.0250   | -       |
//   | orthographic, fix ON           | 16           | engaged            | 0.4577    | 0.0417   | 2       |
//   | orthographic, predicate CUT    | 0            | not-sphere-routed  | 0.5520    | 0        | 0       |
//   | stereographic, fix ON          | 16           | engaged            | 0.4577    | 0.0417   | -       |
//   | stereographic, predicate CUT   | 0            | not-sphere-routed  | 0.5723    | 0        | -       |
//
// Whole-frame directional diff, ortho fix vs ortho cut: DC 61.65%, meanAbs 32.05, against a
// same-state noise floor of 0.0000% (two captures in one settled state; CLAUDE.md §5's
// diff-needs-a-control-arm rule). Read at x4: with the fix, a crisp black-sea / emerald-land
// boundary; with the cut, NO coastline at all — the whole region is a smooth gradient, because
// the parent-magnified bake smears land straight across it.
//
// On the FIXED tree all three disc-trio projections (orthographic, stereographic, and the
// globe control) produce virtual bakes (`virtualBakes > 0`, baked keys with a trailing
// `z/x/y`) with reason `engaged`, landing within 0.0003 of each other's `greenFrac`. On the
// tree with only the #2346 predicate reverted (`isGlobeProj` restored — #2024's original
// predicate, see "THE DEFECT" above), the disc pair produce ZERO virtual bakes with reason
// `'not-sphere-routed'` (the renamed string; see the note above). Those are this gate's CAUSE
// assertion (`virtualBakes > 0`) and EFFECT assertion (the `greenFrac` band) respectively.
//
// REJECTED DISCRIMINATOR — `fracWide` (CLAUDE.md §12): it looks like the natural effect
// metric (fraction of coast rows whose black→green transition is ≥2px wide, i.e. blurred),
// but it is anti-correlated with correctness on this arm — 0.0417 with the fix, 0 with the
// cut — and PASSES in both, because the cut arm has no coast EDGE to profile at all: the
// smeared frame has no sharp transition for `widths` to measure ≥2px against, so it reports
// nothing wide by having nothing sharp either. Kept computed and logged (`m.fracWide` in the
// test body) for a human reading the two arms side by side; never asserted.
//
// ── WHAT THIS SPEC ASSERTS, IN ORDER (CLAUDE.md §12: cause before effect) ─────────────────
//   (0) PREMISE — webgpu backend; zero drain residual; zero pageerrors; `camera.projType ===
//       3` and `camera.pitch === 0` (the disc arm actually in effect, not promoted — see
//       above); every vt source reports `maxLevel === 2` (the offline mirror) and
//       `_drapeGlobeFills === true`. The projType and drapeGlobeFills checks are two
//       INDEPENDENT vacuity guards that together pin the arm exactly: projType===3 proves the
//       `?proj=orthographic` URL override took and no pitch-driven promotion happened;
//       drapeGlobeFills===true proves the fill is on the bake→drape path at all (only
//       satisfiable for projType ∈ {3,4,5}∪globeMode, i.e. it could not be true by accident on
//       a projType this predicate does not cover). Either alone is weaker than both.
//   (1) CAUSE — `virtualBakedCount > 0` summed across sources: the windowed dispatch actually
//       engaged. Guarded against vacuity twice: no sources fails the premise above already, and
//       a separate assertion here requires at least one live `_drapeOverzoomDiagBySlice` entry
//       to exist before trusting the count — an empty diag map means this harness misread the
//       field, not that the mechanism is idle. The failure message embeds every live
//       `diag.reason` (the switch's own account of why it did nothing).
//   (2) EFFECT — the coast edge is native-sharp: `greenFrac` (the fraction of in-frame
//       pixels classified as land) must land inside the measured band `GREEN_FRAC_MIN`/
//       `GREEN_FRAC_MAX` = [0.44, 0.48] below, calibrated against this arm's own measured
//       values (see "MEASURED" above), not the sphere template's placeholder. Also asserted:
//       the coarse `greenFrac ∈ (0.02, 0.98)` in-frame check and the `rows > 50` sample-size
//       check. `fracWide` (the template's own effect metric) is still computed and logged
//       alongside `greenFrac`, but is a REJECTED discriminator on this arm (see "MEASURED"
//       above and the doc comment beside `GREEN_FRAC_MIN`) — it passes in both the fixed and
//       broken arms, so it is never asserted.
//
// Settling: `drainUploads` polls the engine's own pending upload/load counters (never a sleep,
// per the capture-canvas skill and CLAUDE.md §5); a non-zero residual FAILS rather than being
// measured. The frame comes back chrome-free via `captureMapFrame`.

import { test, expect, type Page } from '@playwright/test'
import { captureMapFrame } from './helpers/visual'

const STYLE = [
  'xgis 1',
  '',
  'source world {',
  '  type: tilejson',
  '  url: "/vendor/demotiles-mirror/tiles/tiles.json"',
  '}',
  '',
  'layer land {',
  '  source: world',
  '  sourceLayer: "countries"',
  '  | fill-emerald-400',
  '}',
].join('\n')

/** The template gate's camera position, verbatim (Benghazi coast). */
const CENTER = { lon: 20.07, lat: 32.17 }
const ZOOM = 10.3

/** Convergence budget. The mirror is 22 tiny local pbf tiles, but the `dark` demo still
 *  compiles its own 14.6 MB countries.geojson at boot before the inline style replaces it —
 *  a boot-time cost the URL's `?proj=` does not change. Measured ~44 s to steady state under
 *  SwiftShader on the template's globe arm; 5 minutes, and a residual FAILS rather than being
 *  measured (#2053). */
const DRAIN_BUDGET_MS = 300_000

// File scope so FIXTURE setup is covered, not just the body (§12).
test.describe.configure({ timeout: 900_000 })

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisRunSource?: (s: string) => Promise<unknown>
  __xgisMap?: {
    invalidate?: () => void
    setCenter: (lon: number, lat: number) => void
    setZoom: (z: number) => void
    /** map/src/map.ts:297 declares `camera: Camera` as a PUBLIC field; read directly rather
     *  than through an accessor invented for this spec. map/src/camera/camera.ts:104 declares
     *  `projType` public and :159-163 (`setProjection`) resolves it AFTER the
     *  azimuthal-when-tilted promotion, so this is the RESOLVED value, not the requested one. */
    camera?: { pitch?: number; projType?: number }
    vtSources?: Map<
      string,
      {
        renderer: Record<string, unknown> & { getPendingUploadCount?: () => number }
        source: { getPendingLoadCount?: () => number; maxLevel?: number }
      }
    >
  }
}

interface SourceState {
  drapeGlobeFills: boolean
  maxLevel: number
  bakedCount: number
  virtualBakedCount: number
  /** One entry per slice the renderer has drawn this source through this frame, verbatim from
   *  `computeDrapeOverzoom`'s own `diag.reason` (drape-overzoom-dispatch.ts) via
   *  `_drapeOverzoomDiagBySlice` (vector-tile-renderer.ts:400) — the switch's own account of
   *  why it did or did not engage. */
  diagReasons: string[]
}

async function dumpSources(page: Page): Promise<Record<string, SourceState>> {
  return page.evaluate(() => {
    const out: Record<string, SourceState> = {}
    const vt = (window as unknown as Win).__xgisMap?.vtSources
    if (vt) {
      for (const [name, entry] of vt) {
        const r = entry.renderer
        const drape = r['_drape'] as { baked?: Map<string, unknown> } | undefined
        const keys = [...(drape?.baked?.keys() ?? [])]
        const diagBySlice = r['_drapeOverzoomDiagBySlice'] as
          Map<string, { reason?: string }> | undefined
        out[name] = {
          drapeGlobeFills: r['_drapeGlobeFills'] === true,
          maxLevel: entry.source.maxLevel ?? -1,
          bakedCount: keys.length,
          // Virtual-coord keys are `slice:parentKey:z/x/y`; a plain parent bake
          // has no trailing z/x/y.
          virtualBakedCount: keys.filter((k) => /:\d+\/\d+\/\d+$/.test(k)).length,
          diagReasons: diagBySlice
            ? [...diagBySlice.values()].map((d) => d.reason ?? '(reason unset)')
            : [],
        }
      }
    }
    return out
  })
}

/** Poll the engine's own pending-work counters instead of sleeping, and
 *  `invalidate()` while they are non-zero so a render-on-demand engine actually
 *  drains rather than idling with a backlog (#2053). */
async function drainUploads(
  page: Page,
  budgetMs: number,
): Promise<{ convergedMs: number; residualUploads: number; residualLoads: number }> {
  return page.evaluate(async (budget) => {
    const w = window as unknown as Win
    const nextFrame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))
    const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
    const counts = (): { uploads: number; loads: number } => {
      let uploads = 0
      let loads = 0
      const vt = w.__xgisMap?.vtSources
      if (vt) {
        for (const [, entry] of vt) {
          uploads += entry.renderer.getPendingUploadCount?.() ?? 0
          loads += entry.source.getPendingLoadCount?.() ?? 0
        }
      }
      return { uploads, loads }
    }
    const t0 = performance.now()
    let stable = 0
    while (performance.now() - t0 < budget) {
      const { uploads, loads } = counts()
      const busy = uploads > 0 || loads > 0
      stable = busy ? 0 : stable + 1
      if (stable >= 5) break
      if (busy) w.__xgisMap?.invalidate?.()
      await nextFrame()
      await sleep(30)
    }
    const final = counts()
    return {
      convergedMs: Math.round(performance.now() - t0),
      residualUploads: final.uploads,
      residualLoads: final.loads,
    }
  }, budgetMs)
}

/** #2346 — `greenFrac` acceptance band, derived from the measured six-arm table in the file
 *  header (SwiftShader/WebGPU, offline demotiles mirror maxzoom 2, lon 20.07 / lat 32.17,
 *  z10.3, pitch 0, 1024x720, `?adaptive=0`, engine-counter convergence, residual 0): the
 *  passing value is orthographic fix ON at 0.4577; the nearest failing value is orthographic
 *  predicate CUT at 0.5520 (0.072 outside this band); the globe control (both arms,
 *  unaffected by the #2346 predicate) lands at 0.4574, independently cross-checking that
 *  0.4577 — not 0.5520 — is the correct land fraction for this scene. [0.44, 0.48] keeps
 *  0.4577 near its centre and leaves 0.5520 clearly outside it. A value above this band means
 *  the windowed bake was skipped and the magnified parent bake smeared land over the
 *  coastline — not merely that the coast edge went soft. */
const GREEN_FRAC_MIN = 0.44
const GREEN_FRAC_MAX = 0.48

/** REJECTED DISCRIMINATOR (CLAUDE.md §12): `fracWide` (fraction of profiled coast rows whose
 *  black→green transition is ≥2px wide) was the template's own effect metric, but on this arm
 *  it is anti-correlated with correctness — measured 0.0417 with the #2346 fix, 0 with the
 *  predicate cut. It PASSES in BOTH arms: the broken arm has no coast EDGE to profile at all
 *  (the parent-magnified bake smears land straight across the frame, so `widths` finds no
 *  sharp transition to measure ≥2px against, rather than a wide one). Still computed and
 *  logged (`m.fracWide` below) for a human comparing the two arms side by side; never
 *  asserted. */

test('#2346 — orthographic fill drape stays native-sharp past the source maxLevel', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 720 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.goto('/demo.html?id=dark&proj=orthographic&adaptive=0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, null, {
    timeout: 180_000,
  })
  await page.evaluate(
    async (args) => {
      const w = window as unknown as Win
      await w.__xgisRunSource!(args.style)
      w.__xgisMap!.setCenter(args.lon, args.lat)
      w.__xgisMap!.setZoom(args.zoom)
    },
    { style: STYLE, lon: CENTER.lon, lat: CENTER.lat, zoom: ZOOM },
  )

  const drain = await drainUploads(page, DRAIN_BUDGET_MS)
  expect(
    drain.residualUploads + drain.residualLoads,
    `the engine never converged — ${drain.residualUploads} uploads / ${drain.residualLoads} ` +
      `loads still pending after ${drain.convergedMs}ms. A half-loaded frame is not the ` +
      `converged frame (#2053) and must not be measured as one.`,
  ).toBe(0)

  // ── (0) PREMISE — nothing crashed getting here ────────────────────────────
  expect(errors, `pageerrors during boot/drain: ${errors.join(' | ')}`).toHaveLength(0)

  const backend = await page.evaluate(
    () => (window as unknown as Win).__xgisActiveBackend ?? 'unknown',
  )
  expect(
    backend,
    'the drape is WebGPU-only (vector-tile-renderer.ts:3623), so on WebGL2 this camera renders ' +
      'direct and every assertion below would be measuring the wrong path',
  ).toBe('webgpu')

  // ── (0) PREMISE — the disc arm is actually in effect, not promoted ────────
  // Two independent facts pin the arm: projType===3 proves the URL override took and no
  // pitch-driven promotion happened (camera.ts:159-163); the drapeGlobeFills check below
  // proves the fill is on the bake→drape path at all. Fail loudly on `undefined` rather than
  // defaulting it away — a missing witness must red the gate, not silently pass it.
  const camera = await page.evaluate(() => {
    const c = (window as unknown as Win).__xgisMap?.camera
    return { pitch: c?.pitch, projType: c?.projType }
  })
  expect(
    camera.projType,
    `__xgisMap.camera.projType = ${camera.projType}, expected 3 (orthographic). camera.ts:104 ` +
      `declares projType a PUBLIC field and :159-163 (setProjection) resolves it AFTER the ` +
      `azimuthal-when-tilted promotion — a value of 7 means pitch > 0 fired that promotion and ` +
      `this run is measuring the ALREADY-correct globe arm, not the disc-specific #2346 fix. ` +
      `undefined means __xgisMap.camera (map.ts:297, public) was not reachable at all.`,
  ).toBe(3)
  expect(
    camera.pitch,
    `__xgisMap.camera.pitch = ${camera.pitch}, expected 0. The demo's default pitch is 0 and ` +
      `this spec never sets one; pitch > 0 would promote the disc trio to projType 7 (see the ` +
      `projType assertion above) and make this whole gate vacuous (camera.ts:159-163).`,
  ).toBe(0)

  const state = await dumpSources(page)
  const names = Object.keys(state)
  expect(names.length, 'no vt source — the inline style never took').toBeGreaterThan(0)
  console.log(`[#2346 overzoom state] ${JSON.stringify(state)}`)

  // ── (0) PREMISE — every source is the fixture the measured numbers assume ─
  const wrongMaxLevel = names.filter((k) => state[k].maxLevel !== 2)
  expect(
    wrongMaxLevel.map((k) => `${k}{maxLevel:${state[k].maxLevel}}`),
    'every source must report maxLevel 2 — the offline /vendor/demotiles-mirror tilejson ' +
      '(tiles.json advertises maxzoom 2). A different maxLevel changes the overzoom depth ' +
      '(camera − maxLevel) the GREEN_FRAC_MIN/GREEN_FRAC_MAX band below was measured against.',
  ).toEqual([])
  // bakesVectorDrape(3, false) is true by construction (geo/src/projections-table.ts:265-268:
  // {3,4,5}∪globeMode), so this is a harness sanity check, not a coin flip — combined with
  // camera.projType===3 above it pins the arm exactly (see header).
  const notDraping = names.filter((k) => !state[k].drapeGlobeFills)
  expect(
    notDraping.map((k) => `${k}{maxLevel:${state[k].maxLevel}}`),
    'every source must report _drapeGlobeFills — orthographic fills should ALWAYS bake→drape ' +
      'regardless of the #2346 fix (bakesVectorDrape(3, false) === true). If this is false the ' +
      'fill is rendering direct and the windowed-overzoom mechanism below never runs at all.',
  ).toEqual([])

  // ── (1) CAUSE — the windowed path is ACTIVE (§12: mechanism before effect) ──
  const allDiagReasons = names.flatMap((k) => state[k].diagReasons)
  expect(
    allDiagReasons.length,
    `no per-slice drape-overzoom diagnostics recorded at all (sources: ${names.join(', ')}) — ` +
      '_drapeOverzoomDiagBySlice (vector-tile-renderer.ts:400) is populated every frame ' +
      '_drapeGlobeFills is true, which the premise above just confirmed; an empty map here ' +
      'means this harness is reading the wrong field, not that the mechanism is idle — fail ' +
      'loudly rather than let the count below pass by accident.',
  ).toBeGreaterThan(0)
  const virtualBakes = names.reduce((acc, k) => acc + state[k].virtualBakedCount, 0)
  expect(
    virtualBakes,
    'no virtual windowed bakes on orthographic — computeDrapeOverzoom (drape-overzoom-' +
      "dispatch.ts) declined. It declines with reason 'not-sphere-routed' when the projection " +
      'is not sphere-routed; before #2346 the predicate there was `isGlobeProj`, true only for ' +
      'projType 7 (geo/src/projections-table.ts:327), so orthographic (projType 3) always took ' +
      `that branch. Live diag reasons: ${JSON.stringify(allDiagReasons)}`,
  ).toBeGreaterThan(0)

  // ── (2) EFFECT — the coast edge ────────────────────────────────────────────
  const png = await captureMapFrame(page, { readyTimeoutMs: 180_000, capture: 'clip' })
  const m = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const w = img.width,
      h = img.height
    const d = ctx.getImageData(0, 0, w, h).data
    const isGreen = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4
      return d[i + 1]! > 120 && d[i + 1]! > d[i]! + 30 && d[i + 1]! > d[i + 2]! + 10
    }
    let green = 0
    let n = 0
    for (let y = 40; y < h - 40; y++) {
      for (let x = 0; x < w; x++) {
        n++
        if (isGreen(x, y)) green++
      }
    }
    // Per-row soft-band width across the black→green coast transition: the
    // count of intermediate-green pixels (20 < G < 120) hugging the first
    // green pixel. A native-density bake gives ≈1 px; the parent-magnified
    // bake gives ≈2^(zoom − maxLevel) px.
    const widths: number[] = []
    for (let y = 120; y < h - 120; y += 2) {
      let firstGreen = -1
      for (let x = 2; x < w - 2; x++) {
        if (isGreen(x, y)) {
          firstGreen = x
          break
        }
      }
      if (firstGreen < 4) continue
      let soft = 0
      for (let x = firstGreen - 1; x >= 0; x--) {
        const i = (y * w + x) * 4
        const g = d[i + 1]!
        if (g > 20 && g < 120) soft++
        else break
      }
      widths.push(soft)
    }
    // Robust discriminator: on a diagonal edge the per-row soft band alternates
    // with the stair phase, so a bare median rides the 1↔2 boundary. The
    // FRACTION of rows whose band is ≥ 2 px separates cleanly.
    const wide = widths.filter((v) => v >= 2).length
    const fracWide = widths.length > 0 ? wide / widths.length : 1
    URL.revokeObjectURL(url)
    return { greenFrac: green / n, fracWide, rows: widths.length }
  }, Array.from(png))
  console.log(`[#2346 overzoom coast] ${JSON.stringify(m)}`)

  // (a) paints at overzoom, coast in frame. Pre-fix the drape drew NOTHING past the source
  // max, or only the magnified parent bake.
  expect(m.greenFrac, 'coast edge must be in frame with land painted').toBeGreaterThan(0.02)
  expect(m.greenFrac, 'coast edge must be in frame (not all-land)').toBeLessThan(0.98)
  expect(m.rows, 'edge profile must sample enough rows').toBeGreaterThan(50)
  // (c) native sharpness discriminator — greenFrac must land in the measured band (see the
  // GREEN_FRAC_MIN/GREEN_FRAC_MAX doc comment above and the file header's MEASURED table).
  // fracWide is computed and logged above but deliberately never asserted (REJECTED
  // DISCRIMINATOR — see the doc comment above): it passes in both the fixed and broken arms.
  const greenBandMsg =
    `greenFrac = ${m.greenFrac.toFixed(4)} — must land in [${GREEN_FRAC_MIN}, ` +
    `${GREEN_FRAC_MAX}] (measured: orthographic fix ON 0.4577, predicate CUT 0.5520, globe ` +
    'control 0.4574 — see the file header). A value above this band means the windowed bake ' +
    'was skipped and the magnified parent bake smeared land over the coastline — not merely ' +
    'that the coast edge went soft.'
  expect(m.greenFrac, greenBandMsg).toBeGreaterThanOrEqual(GREEN_FRAC_MIN)
  expect(m.greenFrac, greenBandMsg).toBeLessThanOrEqual(GREEN_FRAC_MAX)
})
