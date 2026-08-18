// ═══ #1495 — the demotiles-style defects, made reproducible offline ═══
//
// This spec is EXPECTED TO FAIL on the arms it names. That is its job: it is the
// fail-before witness for the symptom #1495 still has after its author
// retracted the rest, and it is deliberately NOT named `*-gate.spec.ts` and NOT
// registered in `.github/workflows/test.yml` — a red spec on a shared CI leg is a
// broken build, and the `-gate` suffix is a ratchet (`e2e-specs-load.test.ts`,
// #1715: a gate-named spec must be run by CI or listed as knowingly dark).
// RENAME it to `_demotiles-mirror-gate.spec.ts` and register it in test.yml's
// render-gate list the moment the arms below go green — the name is the contract.
//
// RENAME BLOCKER (both halves must land first). The subject arms are red for TWO
// independent reasons, and each one alone is enough to keep them red at THIS
// camera + canvas, so neither fix flips them by itself:
//   • #1791 — the azimuthal disc-detail boost raises `selMaxZ` past the source's
//     own maxLevel. At camera z1.5 on a 480×500 canvas the boost fires
//     (`log2(500/128)` = 1.97 > 1.5), so the maxLevel-0 synthetic earth-surface
//     source is asked for z2 and every selected tile is over-zoom.
//   • #1792 — the non-Mercator z=0 root split swaps that source's ONLY tile for
//     four z=1 keys it can never serve. This is what keeps the arms red at the
//     cameras where the boost does NOT fire.
// With both landed the source selects its z=0 root again and the forced-WebGL2
// fills path (primary-only, no fallback-ancestor pass) can draw it. Do the rename
// in whichever of the two PRs merges SECOND, after re-running these arms.
//
// ── What #1495 actually is, after two retractions by its own author ──
//
// Filed as "azimuthal projections are broken". It is not:
//   • RETRACTED — "the azimuthal family is broken". `?id=line_styles` (local
//     GeoJSON) renders correctly on orthographic and stereographic at this exact
//     camera. The projection math, the disc silhouette, the backface cull and the
//     flat-branch line-width correction all produce a correct frame.
//   • RETRACTED — "there is no background; the corner should be #D8F2FF". Pure
//     black IS the designed clear for a `sphere-full` world band
//     (`background-pass.ts` `backgroundClearValue`: projTypes 3/4/5/7 clear to
//     opaque black as defined space). The ocean is supplied ON TOP of that by the
//     synthetic earth-surface show, which carries the style's `background-color`
//     through the ordinary polygon ECEF pipeline
//     (`synthetic-earth-surface-show.ts`). So the criterion is not "the corner is
//     blue"; it is "the earth surface is blue where the earth is". Assertion 2
//     below is the issue's criterion 1 in that corrected form, and the corner
//     reads are kept as reported diagnostics so the retraction stays visible
//     instead of being re-filed.
//   • DEAD — the chord-subdivision hypothesis. `decomposeFeatures` densifies
//     every source regardless of origin, and the parallels fixture renders
//     pixel-identical with great-circle densification on and off. The kink half
//     became #1522 and was closed by #1771.
//
// What SURVIVES, and is what this spec measures:
//   1. the synthetic earth-surface show is absent for this style on the
//      azimuthal family → assertion 2, and it is the ONLY arm-red criterion.
//      Measured: `__synthetic_earth_surface__` issues 2 draw calls on the
//      mercator control and 0 on orthographic / stereographic, so every named
//      open-ocean coordinate reads the sphere-full clear (0,0,0) instead of
//      #D8F2FF while the country fills on top of it draw normally.
//   2. "MVT line layers shatter into disconnected dots" → assertion 3. It does
//      NOT reproduce on the mirror at this camera (see the calibration note on
//      MIN_CONNECTED_RUN); the assertion stays as the calibrated guard for it.
//   3. `orthographic` reports `submitted 4 / drawn 0` → assertion 4. Was
//      DOWNGRADED to a dispatch-only check because the mercator CONTROL measured
//      `submitted 6 / drawn 0` here too — `drawn` wasn't projection-discriminating
//      and asserting on it failed the control. Root-caused and fixed as #1793 (see
//      the note at assertion 4): TextStage's curved-line fit check DROPPED every
//      candidate whose along-line lattice stop landed within a few px of its
//      (viewport-truncated) run's end, even though the run had hundreds of spare
//      px elsewhere — a positioning artifact, not a real space shortage. Fixed by
//      clamping the anchor inward instead of dropping (map/src/text/text-stage.ts);
//      `drawn > 0` is restored below.
// They are independent; nothing ties them together now the chord story is dead.
//
// ── Why a committed mirror, and not the live style ──
//
// None of the three reproduce on the local `long_chords` stand-in (#1521), so the
// style itself is the discriminator and the repro needs its real bytes. Headless
// Chromium here cannot reach demotiles.maplibre.org (`ERR_CONNECTION_RESET` on
// every TLS-flag combination tried; `curl` reaches it fine), and CI's render-gate
// leg runs no azimuthal spec at all. `playground/public/vendor/demotiles-mirror/`
// is the fix: the upstream style.json with exactly two URLs rewritten, its
// TileJSON, its z0-z2 MVT tiles and one glyph range, committed. See
// `playground/src/examples/import-maplibre-mirror.xgis` for the provenance and
// the rewrite list. (`helpers/offline-proxy.ts` solves the neighbouring problem
// by fetching through node at test time; a committed mirror is preferred here
// because a repro must be deterministic and must survive a CI leg with no
// egress.)
//
// ── Why every assertion is structural (CLAUDE.md §12) ──
//
// The issue's own sweep is the cautionary tale: `painted` (fraction of pixels
// differing from pixel 0,0) put broken `orthographic` at 0.327, BETWEEN two
// healthy projections. A pixel COUNT passes on a broken image. So:
//   • the earth-surface check samples NAMED open-ocean coordinates through
//     `map.project()` — a colour at a place, not a ratio — and its failure
//     message carries the offending show's own draw-call count, so the pixel and
//     the mechanism are reported together;
//   • the coastline check measures the LARGEST 8-CONNECTED COMPONENT of
//     stroke-coloured pixels. "Shattered into ~1px fragments along the correct
//     path" and "a continuous stroke" have the same pixel count and differ by
//     three orders of magnitude in connectedness. That is the quantity the
//     symptom actually moves;
//   • the label check reads the same `getLastLabelCounts()` counters
//     `_demotiles-labels-gl2-gate.spec.ts` asserts on, so a failure names its
//     stage (never dispatched vs dispatched-then-dropped).
//
// Non-vacuity is asserted first, and includes the fixture itself: if a mirrored
// asset 404s, every measurement below would go red for a reason that is not the
// bug. `mirror.failed` must be empty and `mirror.ok` must cover style + manifest
// + tiles before any verdict is believed.
//
// Runs on WebGl2Device under headless SwiftShader (`?forcegl2=1`), the same
// backend the issue measured on. `adaptive=0` pins the quality ladder so a dpr
// notch cannot change the connectivity measurement; `e2e=1` turns on
// `preserveDrawingBuffer` so the screenshot reads the drawn frame.

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureCanvas } from './helpers/visual'

// File-scope, not `test.setTimeout` in the body: a body-scope budget governs the
// body only, and a loaded SwiftShader runner times out in FIXTURE SETUP
// (`Test timeout of 60000ms exceeded while setting up "context"`), which is still
// on the config default. Three WebGL2 pages plus a whole-frame connectivity pass
// is the heavy shape that warning was written for (CLAUDE.md §12).
test.describe.configure({ timeout: 180_000 })

/** The camera the issue swept, and the only camera the mirror carries tiles for.
 *  It is also the window where `geolines-label` (minzoom 1) is live and
 *  `countries-label` (minzoom 2) is not — so the label counters are
 *  line-label-specific here, exactly as in `_demotiles-labels-gl2-gate`. */
const CAMERA = '1.5/20/140'

/** The mirror's declared TileJSON depth. Load-bearing for the VIEWPORT below,
 *  not just for which tiles exist — see MAX_CANVAS_CSS_PX. */
const MIRROR_MAXZOOM = 2

/** Viewport, chosen so the map canvas lands at 480×500 CSS px in the demo
 *  page's WIDE layout (the editor is a side panel; the canvas keeps the full
 *  window height). Two independent constraints pin it, and both are asserted
 *  below rather than trusted:
 *
 *  1. FIXTURE DEPTH. `tile-selection-cache.ts:736-743` gives the azimuthal disc
 *     family (projTypes 3/4/5) a selection-zoom boost — a screen-filling
 *     hemisphere drawn from one coarse tile shows straight-edge coastlines, so
 *     the selector's max level is raised to `ceil(log2(max(cssW,cssH)/128))`
 *     whenever `camera.zoom` is below that. That boost is applied AFTER the
 *     `cz > source.maxLevel` clamp and does NOT re-clamp, so on a shallow
 *     archive it selects tiles the source does not have. Measured on this
 *     fixture at a 580×800 canvas: boost → z3 against the mirror's maxzoom 2,
 *     every visible tile classifies over-zoom, and orthographic drew ZERO tiles
 *     from ALL THREE sources — a fully black frame with `submitted 0 / drawn 0`,
 *     which is a FIXTURE ARTIFACT, not #1495. At 480×500 the boost resolves to
 *     z2 == the mirror's maxzoom and orthographic draws 52 tiles, which is the
 *     state in which the real defect (assertion 2) is visible. The live style's
 *     maxzoom is 6, so this interaction cannot happen there — but any shallow
 *     vector source hits it, which is filed separately.
 *  2. DOM OVERLAYS. `captureCanvas` screenshots the `#map` LOCATOR, so every
 *     absolutely/fixed-positioned piece of demo chrome painted over the canvas
 *     lands in the frame — the on-screen error console (`#log-overlay`, opened
 *     by the `?forcegl2=1` warning), the `#status` pill, the live `#hash-badge`
 *     and the `#map-tools` cluster all overlap at this size. They are hidden
 *     before the capture and the list of the ones that were actually visible is
 *     reported on the PROBE line. */
const VIEWPORT = { width: 900, height: 500 }

/** Ceiling on the canvas's larger CSS dimension implied by constraint 1 above:
 *  `ceil(log2(px/128)) <= MIRROR_MAXZOOM`  ⟺  `px <= 128 * 2^MIRROR_MAXZOOM`. */
const MAX_CANVAS_CSS_PX = 128 * 2 ** MIRROR_MAXZOOM

/** The style's `background-color`, and therefore the colour the synthetic
 *  earth-surface show paints the sphere. #D8F2FF. */
const EARTH_SURFACE: readonly [number, number, number] = [216, 242, 255]

/** Per-channel slack on a flat-fill colour read. Same default `expectPixelAt`
 *  uses: covers AA / MSAA-resolve drift without waving through a real change.
 *  The control measures 0 on every probe (exact #D8F2FF, and uniform across a
 *  5×5 neighbourhood), so this is pure headroom. */
const COLOR_TOLERANCE = 12

/** Every colour the style can put on screen. Used for TWO things: naming which
 *  style entity a failing probe pixel actually hit, and the construction check
 *  below that no non-line entity can leak into the stroke mask.
 *  `coastline` and `geoline` are the line classes; `fill-1..8` plus `white` are
 *  the nine `countries-fill` match arms (`white` doubles as the
 *  `countries-boundary` stroke); `space` is the sphere-full clear. */
const PALETTE: Array<{ name: string; rgb: [number, number, number] }> = [
  { name: 'earth', rgb: [216, 242, 255] }, // #D8F2FF background / earth surface
  { name: 'coastline', rgb: [25, 142, 200] }, // #198EC8 coastline
  { name: 'geoline', rgb: [16, 119, 176] }, // #1077B0 geolines (dashed)
  { name: 'white', rgb: [255, 255, 255] }, // #FFFFFF fill arm + boundary stroke
  { name: 'space', rgb: [0, 0, 0] }, // sphere-full designed clear
  { name: 'fill-1', rgb: [214, 199, 255] }, // #D6C7FF
  { name: 'fill-2', rgb: [235, 202, 138] }, // #EBCA8A
  { name: 'fill-3', rgb: [193, 229, 153] }, // #C1E599
  { name: 'fill-4', rgb: [231, 229, 143] }, // #E7E58F
  { name: 'fill-5', rgb: [152, 221, 161] }, // #98DDA1
  { name: 'fill-6', rgb: [131, 213, 244] }, // #83D5F4
  { name: 'fill-7', rgb: [177, 187, 249] }, // #B1BBF9
  { name: 'fill-8', rgb: [234, 179, 143] }, // #EAB38F
]

const LINE_CLASSES: string[] = ['coastline', 'geoline']
const LINE_RGB: Array<[number, number, number]> = PALETTE.filter((p) =>
  LINE_CLASSES.includes(p.name),
).map((p) => p.rgb)

/** A pixel joins the stroke mask when its Euclidean RGB distance to the NEAREST
 *  line colour is within this bound — i.e. the line contributes more than about
 *  half of it. 110 is just over half of |#D8F2FF − #198EC8| = 223, so the
 *  ≥50%-covered centre band of the stroke is admitted along its whole length
 *  while the outer AA feather is not.
 *
 *  This is DISTANCE-TO-A-LINE-COLOUR, not "nearest palette entry is a line
 *  class", and the difference is the whole calibration. The nearest-entry form
 *  measured largest-component 22 on a control frame whose coastlines are
 *  visibly continuous, because two of the style's own country fills sit ON the
 *  coastline↔ocean AA ramp: #83D5F4 (fill-6) is 135 from #198EC8 and #B1BBF9
 *  (fill-7) is 166, so most half-covered stroke pixels voted FILL and the mask
 *  fell apart into 2px specks. A classifier that shatters the healthy control
 *  shatters a broken frame identically — it cannot distinguish the states it
 *  exists to test (CLAUDE.md §12, `the assertion that failed either way`).
 *
 *  `paletteGuard` below asserts, on every run, that no non-line palette entry is
 *  within this bound, so the collision cannot come back silently. Measured
 *  margin: the closest is fill-6 at 135 vs the 110 bound. */
const LINE_CORE_DIST = 110

/** Open Pacific at this camera, verified clean on the control: each reads
 *  EXACTLY #D8F2FF and is uniform over a 5×5 neighbourhood, so a one-pixel
 *  projection drift cannot change the verdict. Chosen to sit clear of both
 *  neighbouring `geolines` parallels — the Equator at 0° and the Tropic of
 *  Cancer at 23.44° are ≥8° away, ~35 px at this camera — and clear of any
 *  landmass in the demotiles `countries` layer. The whole point of naming
 *  COORDINATES rather than screen positions is that the claim stays true under
 *  every projection in ARMS.
 *
 *  The retired probe [140,10] is why the 5×5 check exists: it reads (164,215,240)
 *  — an exact 73% earth / 27% coastline blend — because it lands on the AA
 *  fringe of the Philippine coastline, so it failed the control for a reason
 *  that had nothing to do with the earth surface. */
const OCEAN_PROBES: Array<[number, number]> = [
  [155, 12],
  [160, 15],
]

/** A coastline crossing this frame is hundreds of pixels of continuous stroke,
 *  so a healthy largest component is O(10^2-10^3). The shattered frame the issue
 *  photographed is isolated ~1px fragments, so components are O(1).
 *
 *  Calibrated against BOTH states rather than guessed. On the mercator control
 *  the mask's largest component measures 344 px (top five 344/338/332/324/303 —
 *  the style draws many separate islands, so a high COMPONENT COUNT is normal
 *  and only the largest is diagnostic). Re-running the identical metric over the
 *  same mask thinned deterministically to one pixel in three — the "shatter into
 *  dots" symptom, synthesised from the real frame — collapses the largest
 *  component to 10. 150 sits between the two with >2× margin on each side.
 *  The measured `top` sizes are printed on every run so a miscalibrated
 *  threshold is visible rather than silently authoritative. */
const MIN_CONNECTED_RUN = 150

/** `mercator` is the control: the same style, the same camera, the same tiles,
 *  a `flat` world band. The issue's sweep had it healthy, so a red control means
 *  the mirror or the harness is wrong, not that the bug is projection-general. */
const ARMS = [
  { proj: 'mercator', role: 'control' },
  { proj: 'orthographic', role: 'subject' },
  { proj: 'stereographic', role: 'subject' },
] as const

interface Measurement {
  width: number
  height: number
  cssWidth: number
  cssHeight: number
  probes: Array<{
    lon: number
    lat: number
    onScreen: boolean
    x: number | null
    y: number | null
    rgb: [number, number, number] | null
    nearest: string | null
  }>
  corners: Array<{ x: number; y: number; rgb: [number, number, number]; onGlobe: boolean }>
  line: { total: number; components: number; largest: number; top: number[] }
  draws: Array<{ source: string; drawCalls: number; tilesVisible: number }>
}

for (const { proj, role } of ARMS) {
  test(`#1495 demotiles mirror — ${proj} (${role}, ?forcegl2=1)`, async ({ page }, testInfo) => {
    const errors: string[] = []
    const warnings: string[] = []
    // Which mirrored assets actually arrived. A 404 here would make every
    // measurement below meaningless, so this is asserted before any verdict.
    const mirrorOk: string[] = []
    const mirrorFailed: string[] = []
    const isMirror = (u: string) => u.includes('/vendor/demotiles-mirror/')
    const short = (u: string) => u.slice(u.indexOf('/vendor/demotiles-mirror/'))

    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    page.on('console', (m) => {
      const t = m.text()
      if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push(t.slice(0, 300))
      // GL-level complaints arrive as WARNINGS, not errors, and the issue's
      // step-1 ask is exactly "what does the console say". Captured and
      // reported; never asserted on, because SwiftShader emits its own
      // performance chatter on every backend.
      else if (m.type() === 'warning' && /WebGL|GL_INVALID|no buffer is bound/.test(t))
        warnings.push(t.slice(0, 200))
    })
    page.on('response', (r) => {
      const u = r.url()
      if (!isMirror(u)) return
      if (r.status() >= 400) mirrorFailed.push(`${short(u)} → HTTP ${r.status()}`)
      else mirrorOk.push(short(u))
    })
    page.on('requestfailed', (r) => {
      if (isMirror(r.url())) mirrorFailed.push(`${short(r.url())} → ${r.failure()?.errorText}`)
    })

    await page.setViewportSize(VIEWPORT)
    await page.goto(
      `/demo.html?id=import_maplibre_mirror&forcegl2=1&e2e=1&adaptive=0&proj=${proj}#${CAMERA}`,
      { waitUntil: 'domcontentloaded' },
    )
    // `null` for the (unused) page-function argument is load-bearing: Playwright's
    // signature is `(fn, arg, options)`, so an options object passed in slot 2 is
    // silently taken as the ARG and the budget falls back to the default.
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 60_000 },
    )

    // Settle on a PREDICATE, not a fixed wait. The issue records a 6 s fixed wait
    // leaving the z1 tile unsettled and swinging stroke pixels 26% on identical
    // code. `captureCanvas` already polls the engine's own
    // `hasPendingSourceWork()` to quiescence; this loop adds the label pipeline,
    // which drains later than source work (decode → shaping → collision) and is
    // what assertion 4 reads. `submitted` — not `drawn` — is the predicate,
    // because `drawn` is the counter under discussion and waiting on it would
    // turn an arm into a timeout instead of a measurement.
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
    let seen = await readCounters()
    for (let i = 0; i < 60 && (seen.counts?.submitted ?? 0) === 0; i++) {
      await page.waitForTimeout(1000)
      seen = await readCounters()
    }

    // `captureCanvas` screenshots the `#map` LOCATOR, which composites every
    // absolutely/fixed-positioned piece of demo chrome painted over it — the
    // on-screen error console (opened by the `?forcegl2=1` warning), the status
    // pill, the live hash badge and the map-tools cluster all overlap the canvas
    // at this viewport. Their greys would otherwise land inside the frame the
    // assertions below measure AND inside the artifact a human reads.
    const hiddenChrome = await page.evaluate(() => {
      const ids = [
        'log-overlay',
        'status',
        'status-popover',
        'hash-badge',
        'map-tools',
        'editor-collapse-btn',
        'demo-actions',
      ]
      const hidden: string[] = []
      for (const id of ids) {
        const el = document.getElementById(id)
        if (!el) continue
        if (getComputedStyle(el).display !== 'none') hidden.push(id)
        el.style.display = 'none'
      }
      return hidden
    })

    const png = await captureCanvas(page, { readyTimeoutMs: 60_000 })
    // On disk for every arm, passing ones included: the frame is the artifact a
    // human reads at full resolution (CLAUDE.md §5), and an attachment alone
    // lives inside the trace zip where a passing arm never writes one.
    const framePath = testInfo.outputPath(`frame-${proj}.png`)
    writeFileSync(framePath, png)
    await testInfo.attach(`frame-${proj}.png`, { body: png, contentType: 'image/png' })
    // Re-read AFTER the capture settle, so assertion 4 describes the same frame
    // assertions 2 and 3 measure rather than a snapshot taken before quiescence.
    seen = await readCounters()

    const m: Measurement = await page.evaluate(
      async ({ b64, palette, lineRgb, probes, coreDist }) => {
        const canvas = document.querySelector('#map') as HTMLCanvasElement
        const map = (
          window as unknown as {
            __xgisMap?: {
              project?: (ll: readonly [number, number]) => [number, number] | null
              unproject?: (s: readonly [number, number]) => [number, number] | null
              inspectPipeline?: () => {
                sources: Array<{
                  name: string
                  frame: { drawCalls: number; tilesVisible: number }
                }>
              }
            }
          }
        ).__xgisMap

        const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
        const bmp = await createImageBitmap(blob)
        const c = document.createElement('canvas')
        c.width = bmp.width
        c.height = bmp.height
        const ctx = c.getContext('2d')!
        ctx.drawImage(bmp, 0, 0)
        const W = c.width
        const H = c.height
        const data = ctx.getImageData(0, 0, W, H).data
        // `project`/`unproject` speak canvas-local CSS px; the screenshot is the
        // element's device px. Derive the factor from the two widths rather than
        // trusting devicePixelRatio, which the quality ladder can decouple from
        // the swapchain size.
        const rect = canvas.getBoundingClientRect()
        const scale = W / rect.width
        const at = (x: number, y: number): [number, number, number] => {
          const i = (y * W + x) * 4
          return [data[i]!, data[i + 1]!, data[i + 2]!]
        }
        const nearestName = (r: number, g: number, b: number): string => {
          let best = ''
          let bestD = Infinity
          for (const q of palette) {
            const d = (r - q.rgb[0]) ** 2 + (g - q.rgb[1]) ** 2 + (b - q.rgb[2]) ** 2
            if (d < bestD) {
              bestD = d
              best = q.name
            }
          }
          return best
        }

        const probeReads = probes.map(([lon, lat]) => {
          const p = map?.project?.([lon, lat]) ?? null
          if (!p) return { lon, lat, onScreen: false, x: null, y: null, rgb: null, nearest: null }
          const x = Math.round(p[0] * scale)
          const y = Math.round(p[1] * scale)
          if (x < 0 || y < 0 || x >= W || y >= H)
            return { lon, lat, onScreen: false, x, y, rgb: null, nearest: null }
          const rgb = at(x, y)
          return { lon, lat, onScreen: true, x, y, rgb, nearest: nearestName(...rgb) }
        })

        // Corners are DIAGNOSTIC, not asserted — `onGlobe` is what makes them
        // readable at all. A black corner OFF the globe is the designed
        // sphere-full clear; a black corner ON the globe is the missing earth
        // surface. The issue's original "the corner should be #D8F2FF" could not
        // tell those apart, which is why it was retracted.
        const cornerPts: Array<[number, number]> = [
          [2, 2],
          [W - 3, 2],
          [2, H - 3],
          [W - 3, H - 3],
        ]
        const corners = cornerPts.map(([x, y]) => ({
          x,
          y,
          rgb: at(x, y),
          onGlobe: (map?.unproject?.([x / scale, y / scale]) ?? null) !== null,
        }))

        // Stroke mask: distance to the NEAREST line colour. See LINE_CORE_DIST.
        const mask = new Uint8Array(W * H)
        let total = 0
        for (let i = 0, p = 0; p < W * H; i += 4, p++) {
          const r = data[i]!
          const g = data[i + 1]!
          const b = data[i + 2]!
          let bestD = Infinity
          for (const q of lineRgb) {
            const d = (r - q[0]!) ** 2 + (g - q[1]!) ** 2 + (b - q[2]!) ** 2
            if (d < bestD) bestD = d
          }
          if (bestD <= coreDist * coreDist) {
            mask[p] = 1
            total++
          }
        }

        // 8-connected components, iterative so a frame-long coastline cannot
        // blow the JS stack.
        const seenPx = new Uint8Array(W * H)
        const sizes: number[] = []
        const stack: number[] = []
        for (let p0 = 0; p0 < mask.length; p0++) {
          if (!mask[p0] || seenPx[p0]) continue
          let size = 0
          stack.length = 0
          stack.push(p0)
          seenPx[p0] = 1
          while (stack.length > 0) {
            const p = stack.pop()!
            size++
            const x = p % W
            const y = (p - x) / W
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue
                const nx = x + dx
                const ny = y + dy
                if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue
                const q = ny * W + nx
                if (mask[q] && !seenPx[q]) {
                  seenPx[q] = 1
                  stack.push(q)
                }
              }
            }
          }
          sizes.push(size)
        }
        sizes.sort((a, b) => b - a)

        // Per-source draw stats for the SAME frame. This is what turns "the
        // ocean pixel is black" into "the show that paints it issued no draw".
        const draws = (map?.inspectPipeline?.()?.sources ?? []).map((s) => ({
          source: s.name,
          drawCalls: s.frame.drawCalls,
          tilesVisible: s.frame.tilesVisible,
        }))

        return {
          width: W,
          height: H,
          cssWidth: Math.round(rect.width),
          cssHeight: Math.round(rect.height),
          probes: probeReads,
          corners,
          line: {
            total,
            components: sizes.length,
            largest: sizes[0] ?? 0,
            top: sizes.slice(0, 5),
          },
          draws,
        }
      },
      {
        b64: png.toString('base64'),
        palette: PALETTE,
        lineRgb: LINE_RGB,
        probes: OCEAN_PROBES,
        coreDist: LINE_CORE_DIST,
      },
    )

    // One machine-readable line per arm, so the gate-phase sweep has the numbers
    // even for the arms that throw before reaching the later assertions.
    const cornerStr = m.corners
      .map((c) => `(${c.x},${c.y})${c.onGlobe ? 'globe' : 'space'}=${c.rgb.join(',')}`)
      .join(' ')
    const drawStr = m.draws.map((d) => `${d.source}=${d.drawCalls}/${d.tilesVisible}`).join(' ')
    console.log(
      `PROBE1495 ${proj} ${m.width}x${m.height} counts=${JSON.stringify(seen.counts)} ` +
        `probes=${JSON.stringify(m.probes.map((p) => p.rgb))} corners=[${cornerStr}] ` +
        `line=${JSON.stringify(m.line)} draws=[${drawStr}] mirrorOk=${mirrorOk.length} ` +
        `mirrorFailed=${mirrorFailed.length} errors=${errors.length} warnings=${warnings.length} ` +
        `chromeHidden=[${hiddenChrome.join(',')}] frame=${framePath}`,
    )
    if (errors.length > 0) console.log(`PROBE1495 ${proj} ERRORS ${errors.join(' | ')}`)
    if (warnings.length > 0) console.log(`PROBE1495 ${proj} WARNINGS ${warnings.join(' | ')}`)

    // ── 1. Non-vacuity ────────────────────────────────────────────────────
    expect(mirrorFailed, `mirrored assets did not serve: ${mirrorFailed.join(' | ')}`).toEqual([])
    expect(
      mirrorOk.filter((u) => u.endsWith('.pbf')).length,
      `no mirrored MVT tile was requested — the fixture never drove the vector path. Got: ${mirrorOk.join(' ')}`,
    ).toBeGreaterThan(0)
    expect(
      mirrorOk.some((u) => u.endsWith('/style.json')) &&
        mirrorOk.some((u) => u.endsWith('/tiles.json')),
      `style.json + tiles.json must both have been fetched from the mirror. Got: ${mirrorOk.join(' ')}`,
    ).toBe(true)
    expect(seen.backend, 'must be running on WebGl2Device').toBe('webgl2')
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])

    // The fixture-depth constraint VIEWPORT exists to satisfy, asserted rather
    // than assumed: the demo page's layout decides the canvas size, and a CSS
    // change there would silently push the azimuthal selection boost past the
    // mirror's maxzoom and blank the subject arms for a reason that is not
    // #1495. Named here so that failure reads as the harness, not the bug.
    const canvasMax = Math.max(m.cssWidth, m.cssHeight)
    expect(
      canvasMax,
      `canvas is ${m.cssWidth}x${m.cssHeight} CSS px; the azimuthal selection boost ` +
        `(tile-selection-cache.ts:736) then asks for z${Math.ceil(Math.log2(canvasMax / 128))} ` +
        `against a mirror that stops at z${MIRROR_MAXZOOM}, which blanks the subject arms as a ` +
        `FIXTURE artifact. Keep the canvas at or under ${MAX_CANVAS_CSS_PX} CSS px.`,
    ).toBeLessThanOrEqual(MAX_CANVAS_CSS_PX)

    // The stroke mask must not be able to swallow a non-line style colour — the
    // failure mode that made the previous connectedness metric measure 22 on a
    // healthy control. Construction check, not a sample.
    const paletteGuard = PALETTE.filter((p) => !LINE_CLASSES.includes(p.name)).map((p) => {
      let d = Infinity
      for (const q of LINE_RGB)
        d = Math.min(d, Math.hypot(p.rgb[0] - q[0], p.rgb[1] - q[1], p.rgb[2] - q[2]))
      return { name: p.name, d: Math.round(d) }
    })
    const leaks = paletteGuard.filter((p) => p.d <= LINE_CORE_DIST)
    expect(
      leaks,
      `these non-line style colours are within LINE_CORE_DIST=${LINE_CORE_DIST} of a stroke ` +
        `colour and would leak into the connectedness mask: ${leaks
          .map((l) => `${l.name}@${l.d}`)
          .join(', ')}. Closest overall: ${paletteGuard
          .slice()
          .sort((a, b) => a.d - b.d)
          .slice(0, 2)
          .map((l) => `${l.name}@${l.d}`)
          .join(', ')}`,
    ).toEqual([])

    // ── 2. The synthetic earth-surface show painted the ocean (#1495 symptom 1)
    //      The issue's criterion 1, in the form its author's correction left it:
    //      the earth surface is the style background colour WHERE THE EARTH IS,
    //      not at a corner that may legitimately be space.
    const earthShow = m.draws.find((d) => d.source === '__synthetic_earth_surface__')
    const earthShowStr = earthShow
      ? `__synthetic_earth_surface__ issued ${earthShow.drawCalls} draw calls / ` +
        `${earthShow.tilesVisible} tiles this frame (mercator control: 2/2)`
      : `__synthetic_earth_surface__ is not registered as a source at all`
    for (const p of m.probes) {
      expect(
        p.onScreen,
        `ocean probe ${p.lon},${p.lat} did not project on screen — the camera is not the one this spec measures`,
      ).toBe(true)
      const rgb = p.rgb!
      const delta = rgb.map((v, i) => Math.abs(v - EARTH_SURFACE[i]!))
      expect(
        Math.max(...delta) <= COLOR_TOLERANCE,
        `EARTH SURFACE ABSENT — open ocean at ${p.lon},${p.lat} (px ${p.x},${p.y}) reads ` +
          `RGB(${rgb.join(',')}) [nearest style entity: ${p.nearest}], expected the style's ` +
          `background #D8F2FF = RGB(${EARTH_SURFACE.join(',')}) ±${COLOR_TOLERANCE}. ` +
          `${earthShowStr}. Country fills on this frame: ${drawStr}. Corners: ${cornerStr}`,
      ).toBe(true)
    }

    // ── 3. MVT line layers draw a CONNECTED stroke (#1495 symptom 2) ──────
    expect(
      m.line.total,
      `no stroke-coloured pixel at all — the line layers did not draw, which is a different failure than shattering`,
    ).toBeGreaterThan(0)
    expect(
      m.line.largest,
      `MVT line layers are shattered: ${m.line.total} stroke px in ${m.line.components} disconnected ` +
        `components, largest ${m.line.largest} (top: ${m.line.top.join(', ')}). The mercator control ` +
        `measures 344 with this metric, and the same mask thinned to dots measures 10.`,
    ).toBeGreaterThanOrEqual(MIN_CONNECTED_RUN)

    // ── 4. Line labels reach the renderer AND survive placement (#1495 symptom 3,
    //      #1793) ─────────────────────────────────────────────────────────
    //      Same counters `_demotiles-labels-gl2-gate` reads: `submitted` counts
    //      what reached TextStage, `drawn` what survived shaping + collision
    //      into setDraws. The issue measured `submitted 4 / drawn 0` on
    //      orthographic against the LIVE style.
    //
    //      `drawn > 0` was DOWNGRADED to `submitted > 0` because the mercator
    //      CONTROL measured `submitted 6 / drawn 0` on this mirror — every
    //      curved geolines-label candidate (Equator, Tropic of Cancer, …) died
    //      in TextStage's fit check, which dropped a label whenever the along-
    //      line lattice's stop landed within a few px of its (viewport-
    //      truncated) run's end, even though the run had ample spare length.
    //      Root-caused and fixed as #1793 (map/src/text/text-stage.ts: the fit
    //      check now CLAMPS the anchor inward instead of dropping the label
    //      when it fits the run but not centered exactly at the lattice stop).
    //      `drawn > 0` is the original, restored assertion.
    expect(seen.counts, 'no label counters — TextStage was never built').not.toBeNull()
    expect(
      seen.counts!.submitted,
      `no label reached TextStage at all (drawn=${seen.counts!.drawn}). ` +
        `Dispatched texts: ${(seen.texts ?? []).slice(0, 20).join(', ')}`,
    ).toBeGreaterThan(0)
    expect(
      seen.counts!.drawn,
      `labels reached TextStage (submitted=${seen.counts!.submitted}) but none survived ` +
        `shaping + collision (#1793 fit-check regression check). Dispatched texts: ` +
        `${(seen.texts ?? []).slice(0, 20).join(', ')}`,
    ).toBeGreaterThan(0)
  })
}
