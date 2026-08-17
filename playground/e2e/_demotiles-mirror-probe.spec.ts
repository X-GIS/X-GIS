// ═══ #1495 — the demotiles-style defects, made reproducible offline ═══
//
// This spec is EXPECTED TO FAIL on the arms it names. That is its job: it is the
// fail-before witness for the two symptoms #1495 still has after its author
// retracted the rest, and it is deliberately NOT named `*-gate.spec.ts` and NOT
// registered in `.github/workflows/test.yml` — a red spec on a shared CI leg is a
// broken build, and the `-gate` suffix is a ratchet (`e2e-specs-load.test.ts`,
// #1715: a gate-named spec must be run by CI or listed as knowingly dark).
// RENAME it to `_demotiles-mirror-gate.spec.ts` and register it in test.yml's
// render-gate list the moment the arms below go green — the name is the contract.
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
//   1. MVT line layers shatter into disconnected dots on this style (the path is
//      right, the stroke is not there)  → assertion 3
//   2. the synthetic earth-surface show is absent for this style → assertion 2
//   3. `orthographic` reports `submitted 4 / drawn 0`             → assertion 4
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
//     `map.project()` — a colour at a place, not a ratio;
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

/** The style's `background-color`, and therefore the colour the synthetic
 *  earth-surface show paints the sphere. #D8F2FF. */
const EARTH_SURFACE: readonly [number, number, number] = [216, 242, 255]

/** Per-channel slack on a flat-fill colour read. Same default `expectPixelAt`
 *  uses: covers AA / MSAA-resolve drift without waving through a real change. */
const COLOR_TOLERANCE = 12

/** Every colour the style can put on screen, so a pixel is classified by WHICH
 *  style entity drew it rather than by a hand-tuned distance to one of them.
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

/** A pixel joins the stroke mask only if its nearest palette entry is a line
 *  class AND it is within this Euclidean distance of it — i.e. it is stroke
 *  CORE, not an edge blend. At the ~3px stroke this style draws at z1.5 the core
 *  is always present; keeping the mask tight stops AA halos from bridging two
 *  genuinely disconnected fragments and hiding the very defect being measured. */
const LINE_CORE_DIST = 48

/** Open Pacific at this camera. Chosen to sit clear of both neighbouring
 *  `geolines` parallels — the Equator at 0° and the Tropic of Cancer at 23.44°
 *  are ≥10° away from each probe, ~40 px at z1.5 — and clear of any landmass in
 *  the demotiles `countries` layer. This is where the earth surface must be
 *  #D8F2FF, and the whole point of naming COORDINATES rather than screen
 *  positions is that the claim stays true under every projection in ARMS. */
const OCEAN_PROBES: Array<[number, number]> = [
  [140, 10],
  [155, 12],
]

/** A coastline crossing this frame is hundreds of pixels of continuous ~3px
 *  stroke, so a healthy component is O(10^3). The shattered frame the issue
 *  photographed is isolated ~1px fragments, so components are O(1). Anywhere in
 *  between is a new phenomenon that deserves a human reading the frame — the
 *  measured `top` sizes are printed on every run so a miscalibrated threshold is
 *  visible rather than silently authoritative. */
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
  probes: Array<{
    lon: number
    lat: number
    onScreen: boolean
    x: number | null
    y: number | null
    rgb: [number, number, number] | null
  }>
  corners: Array<{ x: number; y: number; rgb: [number, number, number]; onGlobe: boolean }>
  line: { total: number; components: number; largest: number; top: number[] }
}

for (const { proj, role } of ARMS) {
  test(`#1495 demotiles mirror — ${proj} (${role}, ?forcegl2=1)`, async ({ page }) => {
    const errors: string[] = []
    // Which mirrored assets actually arrived. A 404 here would make every
    // measurement below meaningless, so this is asserted before any verdict.
    const mirrorOk: string[] = []
    const mirrorFailed: string[] = []
    const isMirror = (u: string) => u.includes('/vendor/demotiles-mirror/')
    const short = (u: string) => u.slice(u.indexOf('/vendor/demotiles-mirror/'))

    page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
        errors.push(m.text().slice(0, 300))
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

    await page.setViewportSize({ width: 1000, height: 800 })
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
    // because `drawn: 0` on orthographic is the defect under test and waiting on
    // it would turn this arm into a timeout instead of a measurement.
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

    const png = await captureCanvas(page, { readyTimeoutMs: 60_000 })
    // Re-read AFTER the capture settle, so assertion 4 describes the same frame
    // assertions 2 and 3 measure rather than a snapshot taken before quiescence.
    seen = await readCounters()

    const m: Measurement = await page.evaluate(
      async ({ b64, palette, lineClasses, probes, coreDist }) => {
        const canvas = document.querySelector('#map') as HTMLCanvasElement
        const map = (
          window as unknown as {
            __xgisMap?: {
              project?: (ll: readonly [number, number]) => [number, number] | null
              unproject?: (s: readonly [number, number]) => [number, number] | null
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
        const scale = W / canvas.getBoundingClientRect().width
        const at = (x: number, y: number): [number, number, number] => {
          const i = (y * W + x) * 4
          return [data[i]!, data[i + 1]!, data[i + 2]!]
        }

        const probeReads = probes.map(([lon, lat]) => {
          const p = map?.project?.([lon, lat]) ?? null
          if (!p) return { lon, lat, onScreen: false, x: null, y: null, rgb: null }
          const x = Math.round(p[0] * scale)
          const y = Math.round(p[1] * scale)
          if (x < 0 || y < 0 || x >= W || y >= H)
            return { lon, lat, onScreen: false, x, y, rgb: null }
          return { lon, lat, onScreen: true, x, y, rgb: at(x, y) }
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

        const mask = new Uint8Array(W * H)
        let total = 0
        for (let i = 0, p = 0; p < W * H; i += 4, p++) {
          const r = data[i]!
          const g = data[i + 1]!
          const b = data[i + 2]!
          let best = 0
          let bestD = Infinity
          for (let k = 0; k < palette.length; k++) {
            const q = palette[k]!.rgb
            const d = (r - q[0]) ** 2 + (g - q[1]) ** 2 + (b - q[2]) ** 2
            if (d < bestD) {
              bestD = d
              best = k
            }
          }
          if (lineClasses.includes(palette[best]!.name) && bestD <= coreDist * coreDist) {
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

        return {
          width: W,
          height: H,
          probes: probeReads,
          corners,
          line: {
            total,
            components: sizes.length,
            largest: sizes[0] ?? 0,
            top: sizes.slice(0, 5),
          },
        }
      },
      {
        b64: png.toString('base64'),
        palette: PALETTE,
        lineClasses: LINE_CLASSES,
        probes: OCEAN_PROBES,
        coreDist: LINE_CORE_DIST,
      },
    )

    // One machine-readable line per arm, so the gate-phase sweep has the numbers
    // even for the arms that throw before reaching the later assertions.
    const cornerStr = m.corners
      .map((c) => `(${c.x},${c.y})${c.onGlobe ? 'globe' : 'space'}=${c.rgb.join(',')}`)
      .join(' ')
    console.log(
      `PROBE1495 ${proj} ${m.width}x${m.height} counts=${JSON.stringify(seen.counts)} ` +
        `probes=${JSON.stringify(m.probes.map((p) => p.rgb))} corners=[${cornerStr}] ` +
        `line=${JSON.stringify(m.line)} mirrorOk=${mirrorOk.length} ` +
        `mirrorFailed=${mirrorFailed.length}`,
    )

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

    // ── 2. The synthetic earth-surface show painted the ocean (#1495 symptom 3)
    //      The issue's criterion 1, in the form its author's correction left it:
    //      the earth surface is the style background colour WHERE THE EARTH IS,
    //      not at a corner that may legitimately be space.
    for (const p of m.probes) {
      expect(
        p.onScreen,
        `ocean probe ${p.lon},${p.lat} did not project on screen — the camera is not the one this spec measures`,
      ).toBe(true)
      const rgb = p.rgb!
      const delta = rgb.map((v, i) => Math.abs(v - EARTH_SURFACE[i]!))
      expect(
        Math.max(...delta) <= COLOR_TOLERANCE,
        `earth surface at ${p.lon},${p.lat} (px ${p.x},${p.y}): expected RGB(${EARTH_SURFACE.join(',')}) ` +
          `±${COLOR_TOLERANCE}, got RGB(${rgb.join(',')}). Corners: ${cornerStr}`,
      ).toBe(true)
    }

    // ── 3. MVT line layers draw a CONNECTED stroke (#1495 symptom 1) ──────
    expect(
      m.line.total,
      `no stroke-coloured pixel at all — the line layers did not draw, which is a different failure than shattering`,
    ).toBeGreaterThan(0)
    expect(
      m.line.largest,
      `MVT line layers are shattered: ${m.line.total} stroke px in ${m.line.components} disconnected ` +
        `components, largest ${m.line.largest} (top: ${m.line.top.join(', ')}). A continuous coastline ` +
        `at this camera is one component of O(10^3).`,
    ).toBeGreaterThanOrEqual(MIN_CONNECTED_RUN)

    // ── 4. Line labels survive to the renderer (#1495 symptom 2) ──────────
    //      Same counters `_demotiles-labels-gl2-gate` reads, so a failure names
    //      its stage: `submitted` counts what reached TextStage, `drawn` what
    //      survived shaping + collision into setDraws. The issue measured
    //      `submitted 4 / drawn 0` here on orthographic.
    expect(seen.counts, 'no label counters — TextStage was never built').not.toBeNull()
    expect(
      seen.counts!.drawn,
      `labels were dispatched (submitted=${seen.counts!.submitted}) but none reached the renderer. ` +
        `Dispatched texts: ${(seen.texts ?? []).slice(0, 20).join(', ')}`,
    ).toBeGreaterThan(0)
  })
}
