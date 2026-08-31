// ═══ A data-driven `fill gradient(…)` paints per-feature colours on the POINT and ARROW paths (#1592) ═══
//
// #1655 wired the per-feature fill for VT POLYGONS on WebGL2 (per-variant Material + per-tile
// feat_data). Its completion note left `coops-currents` unverified, calling it "a coverage/S-111
// style". It is not: coops-currents.xgis is a pushed-GeoJSON POINT style whose two layers ride two
// paths #1655 never touched —
//
//   station_dots  | fill gradient(.speed, …) …  | size-[…]                 → SDF point renderer
//   arrows        | arrow bearing-[.dir] …      | fill gradient(.speed, …) → compiled-arrow batch
//
// Neither goes through the polygon variant. BOTH resolve their colour on the CPU at scene-build
// time and hand the runtime a baked RGBA:
//
//   dots   map/src/map.ts:3802 evalPerFeatureColor → :3831 perFeatureFills →
//          map/src/render/point-renderer.ts:816 `fc = perFeatureFills[i] ?? fill` → feat_data fill_rgba
//   arrows map/src/arrow-show.ts:54 fillAst → :92 evaluate() per feature →
//          graphics-manager.addCompiledArrowLayer → packCompiledArrowTint (retained-arrow-packer.ts:161)
//
// So the question this gate answers is NOT "does the WebGL2 backend have a per-feature colour
// sink" (it demonstrably does — both paths upload per-instance colour buffers, GLSL twins since
// #1648). It is "does the CPU bake produce five DIFFERENT colours for a `gradient()` ramp".
//
// WHY NOT A PAINTED-PIXEL COUNT (CLAUDE.md §12): the plausible failure is a ramp that collapses to
// ONE colour — every feature falling back to the layer constant. A painted fraction is identical
// for "five colours" and "one colour five times", so it is blind to the exact thing under test.
//
// WHY NOT AN RGB HISTOGRAM EITHER, which is the trap this gate fell into on its first run: a SOLID
// fill's anti-aliased edge quantises into SEVERAL rgb buckets (measured: the constant-fill arrow
// twin reported SIX at a 2%-of-painted floor), so "count the dominant rgb buckets" reports ≥4 for a
// flat fill too — an assertion that passes either way, the 2026-07-28 shape. The invariant that
// actually separates the two states is HUE ANGLE: blending a colour toward black (edge coverage)
// or toward white (the stroke ring) leaves its hue EXACTLY unchanged, while the five ramp stops sit
// at five different hues (≈199° / 213° / 314° / 340° / 347°). So the measurement clusters chromatic
// pixels by hue and the claim is ≥4 clusters spanning both endpoint families. The same-code
// constant-fill twin then reports exactly ONE cluster and 0° of spread — measured, not assumed.
//
// THREE FAILURE STATES, THREE MESSAGES. `stroke-white` on the dots layer is load-bearing: it makes
// "the layer never drew" (painted ≈ 0) distinguishable from "the layer drew but its FILL colour was
// lost" (painted > 0, chromatic ≈ 0) distinguishable from "the layer drew one flat colour"
// (chromatic > 0, one hue cluster). Each fails with a message naming which.
//
// Pixels are read straight off the WebGL2 drawing buffer (?e2e=1 → preserveDrawingBuffer), not from
// a page screenshot: `gl` exists ONLY on the WebGL2 RHI, so a silent fallback to another backend
// cannot green this gate, and the demo page's DOM chrome (status pill, errors panel) cannot land in
// the histogram the way it did for the sibling `_fill-data-driven-gl2-gate`.
//
// WebGPU cannot be the control: there is no software WebGPU adapter here or on the CI render-gate
// leg (CLAUDE.md §5), which is why the control is a same-backend twin. Runs GPU-less under
// HEADED=0 XGIS_SOFTWARE_GPU=1 on SwiftShader.
//
// ── MEASURED STATE AT AUTHORING TIME: THIS GATE WAS RED. It is the fail-before for the gap. ────
//
//   dotsTwin   painted=0.01567 chromatic=0.01535 hues=1 spread=0.0° [199°(sky)@100%]
//   arrowsTwin painted=0.00439 chromatic=0.00404 hues=1 spread=0.0° [199°(sky)@100%]
//   dots       painted=0.00236 chromatic=0.00000 hues=0     ← only the white stroke rings drew
//   arrows     painted=0.00439 chromatic=0.00000 hues=0     ← full silhouettes, all flat WHITE
//
// ── GREEN after #1664 (same harness, SwiftShader, backend=webgl2, buffer 480×700). The `painted`
//    figures moved because the fixture spacing was corrected too — see the Fixture note below;
//    the CHROMATIC 0 → nonzero and hues 0 → 4 are the fix. ─────────────────────────────────────
//
//   dotsTwin   painted=0.02470 chromatic=0.02417 hues=1 spread=0.0°   [199°(sky)@99.9%]
//   arrowsTwin painted=0.00709 chromatic=0.00679 hues=1 spread=0.0°   [199°(sky)@100.0%]
//   dots       painted=0.02458 chromatic=0.02312 hues=4 spread=143.9° [343°(rose)@61.2%
//                                            314°(mid)@19.6% 223°(sky)@13.9% 199°(sky)@5.0%]
//   arrows     painted=0.00685 chromatic=0.00665 hues=4 spread=143.5° [343°(rose)@41.4%
//                                            200°(sky)@20.6% 223°(sky)@19.0% 314°(mid)@18.8%]
//
// The four clusters are the five stops with the top two (339.5° / 346.8°, 7.3° apart) merged,
// exactly as predicted above — and the twins still report ONE hue at 0.0° spread, so the
// measurement still distinguishes the two states it was built to distinguish.
//
// The fix: `gradient()` became a CPU builtin (compiler/src/eval/evaluator-helpers.ts) replicating
// the GPU ramp at codegen/shader-gen.ts:380-388, and colour TOKENS in a data-driven colour now
// resolve to hex literals at lower time (ir/lower-helpers.ts resolveColorTokenLiterals), so both
// back-ends read the same literal. An expression that still cannot be baked reports itself
// (map/src/render/per-feature-color-warning.ts) instead of falling back in silence.
//
// Both paths lose the colour in the SAME place, and it is not the renderer: the CPU bake never
// produces an RGBA at all, so the per-instance colour buffers both backends upload are fed the
// layer constant — which for a data-driven fill is NULL by construction.
//
//   compiler/src/ir/emit-commands.ts:781 colorToHex() has no `data-driven` case → show.fill = null,
//     so every fallback below resolves to "no colour".
//   compiler/src/eval/evaluator-helpers.ts:717 callBuiltin throws `unknown function 'gradient'` —
//     `gradient` is deliberately a GPU-codegen-only form, excluded from BUILTIN_FN_NAMES (:32).
//     map/src/map.ts:3821 and arrow-show.ts:97 catch it and return that null fallback.
//   map/src/render/point-renderer.ts:816 `fc = perFeatureFills[i] ?? fill` → null →
//     :823 fill_a = 0: the dots' fill is fully transparent, only `stroke-white` survives.
//   map/src/arrow-show.ts:56 `fillConst = show.fill ? … : null` → :90 colour defaults to
//     [1,1,1,1]: every arrow paints flat white.
//
// The failure is NOT gradient-specific, which a `match()` probe on this same fixture settled: an
// AUTHORED `fill match(.band) { "a" -> sky-300, … }` fails identically (chromatic=0), because the
// evaluator reads the palette token `sky-300` as the arithmetic `sky - 300` and returns -300, and
// map.ts:3826 only accepts a `string`. The Mapbox-converter form `fill-[match(…) { "a" -> "#7dd3fc" }]`
// — hex STRING literals, which is what compiler/src/__tests__/point-fill-color-expr.test.ts covers —
// evaluates to "#7dd3fc" and works. That is why a green unit test coexists with a blank render.

import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'

// ── Fixture ───────────────────────────────────────────────────────────────────
//
// Five stations on one parallel, speeds spanning the ramp exactly (0 / 30 / 60 / 90 / 120 → t =
// 0 / .25 / .5 / .75 / 1). Longitudes are 3° apart, which at the pinned zoom 4 is ~68 device px —
// wider than the largest dot (27.5 px) and the arrow (44 px), so nothing touches and every feature
// owns its own pixels. Bearings differ per station so the arrow arm shows per-feature orientation
// working even in a run where its colour does not.
//
// The spacing was 6° at authoring time, from a scale that assumed a 256-px tile base. X-GIS's zoom
// is 512-based, so zoom 4 is a 8192-px world — 22.8 device px per degree, not 11.4 — and the ±12°
// pair projected to x = -33 / 513 in a 480×700 drawing buffer: OFF SCREEN. MEASURED, not inferred:
// a per-column census of the painted pixels returned three runs, [84,122] [216,263] [350,402], for
// a fixture that places five stations, and the three surviving hues (223° / 314° / 340°) are
// exactly the ±6°/0° speeds 30 / 60 / 90. At 3° all five land at x = 103…377, inside the buffer
// with ≥ 89 px of margin, and the ~68 device px this comment always claimed is now true.
const STATIONS = {
  type: 'FeatureCollection',
  features: [-6, -3, 0, 3, 6].map((lon, i) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, 20] },
    properties: { speed: i * 30, dir: i * 45 },
  })),
}

// The two fill CLAUSES compared. `RAMP` is byte-identical to the one both coops-currents layers
// author; `FLAT` is its constant twin. Whole clauses, not just the colour token: the data-driven
// form is `fill <fn>(…)` (a bare utility argument) while the constant is the hyphenated
// `fill-<token>`, so the grammar around the colour differs too.
const RAMP = 'fill gradient(.speed, 0, 120, sky-300, rose-600)'
const FLAT = 'fill-sky-300'

/** coops-currents' station_dots, minus `opacity-55`. The constant opacity is not one of the two
 *  mechanisms under test and it scales every channel by 0.55, which drags the dimmer ramp stops
 *  under the chroma cutoff below — the histogram would then be measuring the cutoff. The size ramp
 *  is KEPT: `sqrt` is a CPU builtin, so five different radii prove the per-feature machinery is
 *  alive on this path and isolate any colour failure to the colour axis alone. `fill` is the whole
 *  fill clause (RAMP or FLAT). */
const dotsStyle = (fill: string): string => `xgis 1
source stations { type: geojson }
layer station_dots {
  source: stations
  | ${fill} stroke-white stroke-1
  | size-[10 + sqrt(.speed) * 1.6]
}
`

/** coops-currents' arrows layer with a CONSTANT size. The per-feature arrow size ramp clamps two of
 *  the five stations to the same value and drives the smallest to ~1% of the painted area — below
 *  any dominance floor that still rejects noise. A constant size gives five equal-area arrows, so
 *  each authored colour owns ~20% and the floor has real margin. Bearing and fill — the two
 *  per-feature axes — are exactly coops'. `fill` is the whole clause (RAMP or FLAT). */
const arrowsStyle = (fill: string): string => `xgis 1
source stations { type: geojson }
layer arrows {
  source: stations
  | arrow bearing-[.dir] size-[44]
  | ${fill}
}
`

type Family = 'sky' | 'mid' | 'rose'
interface HueCluster {
  /** Intensity-weighted centre of the cluster, degrees. */
  hue: number
  /** Fraction of the frame's chromatic pixels in this cluster. */
  share: number
  family: Family
}
interface Probe {
  ok: boolean
  reason?: string
  backend?: string
  glError?: number
  size?: string
  /** Non-background pixels, as a fraction of the drawing buffer. */
  painted: number
  /** Of those, the ones carrying a colour (not the white ring / grey edges). */
  chromatic: number
  /** Widest angular distance between two clusters. 0 for a single colour. */
  spread: number
  hues: HueCluster[]
  /** Everything ≥0.5%, including sub-dominant clusters — diagnostics only. */
  all: HueCluster[]
}

/** A hue counts as DOMINANT at ≥1.5% of the chromatic pixels. The smallest dot is ~4% of the
 *  painted area by construction and each arrow is ~20%, so every authored stop clears this with
 *  margin, while stray clusters from raster noise do not. */
const DOMINANT = 0.015
/** Clusters are separated by an empty arc of more than this many degrees. The five ramp stops'
 *  closest neighbours are 7.3° apart in hue at the top of the ramp (they merge, so five stops
 *  report four clusters — hence the ≥4 claim), while a single solid colour's entire anti-aliased
 *  hue range measured 5.4° end to end and therefore cannot contain a gap this wide. */
const GAP_DEG = 6

/** Read the WebGL2 drawing buffer and cluster its CHROMATIC pixels by hue.
 *
 *  `painted` counts every non-background pixel (the demo's clear colour is black). A pixel is
 *  CHROMATIC when its channel span is ≥24 and its brightest channel ≥40 — that drops the white
 *  stroke ring, the grey edge blend, and the very dark coverage pixels whose 8-bit hue is noise. */
function probeDrawingBuffer(cfg: { dominant: number; gap: number }): Probe {
  const empty = { painted: 0, chromatic: 0, spread: 0, hues: [], all: [] }
  const w = window as unknown as {
    __xgisMap?: { ctx?: { rhi?: { backend?: string; gl?: WebGL2RenderingContext } } }
  }
  const rhi = w.__xgisMap?.ctx?.rhi
  const gl = rhi?.gl
  if (!gl) return { ok: false, reason: 'no WebGL2 context on the RHI', ...empty }
  const W = gl.drawingBufferWidth
  const H = gl.drawingBufferHeight
  const buf = new Uint8Array(W * H * 4)
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf)

  const bins = new Float64Array(360)
  let painted = 0
  let chromatic = 0
  for (let i = 0; i < W * H; i++) {
    const r = buf[i * 4]!
    const g = buf[i * 4 + 1]!
    const b = buf[i * 4 + 2]!
    if (r <= 24 && g <= 24 && b <= 24) continue
    painted++
    const mx = Math.max(r, g, b)
    const mn = Math.min(r, g, b)
    const d = mx - mn
    if (d < 24 || mx < 40) continue
    chromatic++
    let h: number
    if (mx === r) h = 60 * (((g - b) / d) % 6)
    else if (mx === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
    if (h < 0) h += 360
    bins[Math.min(359, Math.floor(h))]! += 1
  }

  // Cluster the 1° histogram: drop bins under 0.15% of the chromatic total (raster noise), then
  // walk the circle breaking a cluster wherever the empty arc exceeds `gap`.
  const floor = chromatic * 0.0015
  const live: number[] = []
  for (let d = 0; d < 360; d++) if (bins[d]! >= floor) live.push(d)
  const all: HueCluster[] = []
  if (live.length > 0) {
    let start = 0
    for (let k = 0; k < live.length; k++) {
      const prev = live[(k - 1 + live.length) % live.length]!
      if (((live[k]! - prev + 360) % 360) - 1 > cfg.gap) {
        start = k
        break
      }
    }
    let cur: number[] = []
    const flush = (): void => {
      if (cur.length === 0) return
      let wsum = 0
      let hsum = 0
      for (const d of cur) {
        wsum += bins[d]!
        // Offsets from the cluster's first bin keep the mean correct across the 0/360 seam.
        hsum += bins[d]! * (((d - cur[0]! + 360) % 360) + 0.5)
      }
      const hue = (cur[0]! + hsum / wsum) % 360
      const family: Family =
        hue >= 170 && hue < 260 ? 'sky' : hue >= 320 || hue < 20 ? 'rose' : 'mid'
      all.push({ hue, share: wsum / chromatic, family })
      cur = []
    }
    for (let k = 0; k < live.length; k++) {
      const d = live[(start + k) % live.length]!
      if (cur.length > 0 && ((d - cur[cur.length - 1]! + 360) % 360) - 1 > cfg.gap) flush()
      cur.push(d)
    }
    flush()
  }
  all.sort((a, b) => b.share - a.share)
  const hues = all.filter((c) => c.share >= cfg.dominant)
  let spread = 0
  for (const a of hues)
    for (const b of hues) {
      const raw = Math.abs(a.hue - b.hue)
      spread = Math.max(spread, Math.min(raw, 360 - raw))
    }
  return {
    ok: true,
    backend: rhi?.backend,
    glError: gl.getError(),
    size: `${W}x${H}`,
    painted: painted / (W * H),
    chromatic: chromatic / (W * H),
    spread,
    hues,
    all: all.filter((c) => c.share >= 0.005),
  }
}

/** Block until the engine reports its source work drained for several consecutive frames, then give
 *  the on-demand renderer two more frames to compose. Deterministic and OUTCOME-BLIND — it never
 *  polls for painted pixels, so a blank layer settles just as fast as a drawn one and cannot be
 *  mistaken for "not finished yet". */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const m = (
          window as unknown as {
            __xgisMap?: {
              _pendingWork?: { hasPending?: () => boolean }
              hasPendingSourceWork?: () => boolean
            }
          }
        ).__xgisMap
        const t0 = performance.now()
        let stable = 0
        const tick = (): void => {
          let idle = false
          try {
            // #2149 inc 6: registry probe first; legacy method for older builds.
            idle =
              typeof m?._pendingWork?.hasPending === 'function'
                ? !m._pendingWork.hasPending()
                : typeof m?.hasPendingSourceWork === 'function'
                  ? !m.hasPendingSourceWork()
                  : true
          } catch {
            idle = false
          }
          stable = idle ? stable + 1 : 0
          if (stable >= 8 || performance.now() - t0 > 8000) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
  )
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  )
}

/** Run one style, push the stations into its source, and measure.
 *
 *  The demo runner SWALLOWS a compile failure into its `#error` panel and leaves the previous scene
 *  up, so a typo in a style below would otherwise be measured as a rendering result. The panel is
 *  read back and thrown, which is how an unparsable arm fails as a broken fixture rather than as a
 *  broken renderer. */
async function renderArm(page: Page, style: string): Promise<Probe> {
  await page.evaluate(
    async ({ style, fc }) => {
      const w = window as unknown as {
        __xgisRunSource?: (s: string) => Promise<unknown>
        __xgisMap?: { setSourceData(id: string, fc: unknown): void; invalidate?: () => void }
      }
      await w.__xgisRunSource!(style)
      const panel = document.getElementById('error')
      if (panel && panel.style.display !== 'none' && panel.textContent?.trim())
        throw new Error(`style did not compile: ${panel.textContent.trim().slice(0, 400)}`)
      w.__xgisMap!.setSourceData('stations', fc)
      w.__xgisMap!.invalidate?.()
    },
    { style, fc: STATIONS },
  )
  await settle(page)
  return await page.evaluate(probeDrawingBuffer, { dominant: DOMINANT, gap: GAP_DEG })
}

const fmt = (p: Probe): string =>
  `painted=${p.painted.toFixed(5)} chromatic=${p.chromatic.toFixed(5)} ` +
  `hues=${p.hues.length} spread=${p.spread.toFixed(1)}° ` +
  `[${p.all.map((h) => `${h.hue.toFixed(0)}°(${h.family})@${(h.share * 100).toFixed(1)}%`).join(' ')}]`

/** The claim, applied to one arm. `drewWhat` names what is on screen when the fill colour is lost
 *  but the layer itself still drew — the white stroke ring for the dots, the white fallback
 *  silhouette for the arrows — so the achromatic failure reads as a diagnosis, not a riddle. */
function assertPerFeatureRamp(p: Probe, layer: string, drewWhat: string): void {
  expect(
    p.painted,
    `${layer}: the layer painted NOTHING on WebGL2 — a blank frame, not a ramp (${fmt(p)})`,
  ).toBeGreaterThan(0.0005)
  expect(
    p.chromatic,
    `${layer}: the layer DREW (${drewWhat}) but not one pixel carries a colour — the per-feature ` +
      `FILL never reached the fragment, so every feature fell back to the layer constant (${fmt(p)})`,
  ).toBeGreaterThan(0.0002)
  expect(
    p.hues.length,
    `${layer}: \`${RAMP}\` must paint its five features FIVE colours — ${p.hues.length} dominant ` +
      `hue(s) means the ramp collapsed and every feature took the same colour (${fmt(p)})`,
  ).toBeGreaterThanOrEqual(4)
  expect(
    p.spread,
    `${layer}: the ramp must SPAN its two stops — sky-300 (≈199°) to rose-600 (≈347°) is ~148° of ` +
      `hue, and ${p.spread.toFixed(1)}° means the features are shades of one colour (${fmt(p)})`,
  ).toBeGreaterThan(90)
  expect(
    p.hues.map((h) => h.family),
    `${layer}: both ramp ENDPOINTS must be on screen — a sky-300-ish low stop and a rose-600-ish ` +
      `high stop (${fmt(p)})`,
  ).toEqual(expect.arrayContaining(['sky', 'rose']))
}

/** The negative case, through the SAME measurement. A constant fill must be ONE hue with ZERO
 *  spread; if this ever reported the treatment's ≥4 the assertions above would be reporting the
 *  raster rather than the fill and would pass either way. */
function assertFlat(p: Probe, layer: string): void {
  expect(
    p.chromatic,
    `control: a CONSTANT-fill ${layer} must paint on WebGL2 — if this is blank the fixture, the ` +
      `source push or this harness is broken and the rest of this gate proves nothing (${fmt(p)})`,
  ).toBeGreaterThan(0.0005)
  expect(
    p.hues.length,
    `control: a constant fill is ONE hue — ${p.hues.length} means the clustering is measuring the ` +
      `raster's edge blend, not the fill, and the treatment's hue count proves nothing (${fmt(p)})`,
  ).toBe(1)
  expect(
    p.hues.map((h) => h.family),
    `control: a constant sky-300 fill must show the sky family and nothing else (${fmt(p)})`,
  ).toEqual(['sky'])
}

test.describe.configure({ timeout: 240_000 })

test.describe('data-driven `fill gradient()` on points + arrows, WebGL2 (#1592)', () => {
  test('coops-currents’ two per-feature colour paths paint per feature', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 })
    const errors: string[] = []
    const warnings: string[] = []
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text())
      if (m.type() === 'warning') warnings.push(m.text())
    })

    // Camera pinned by hash (#zoom/lat/lon) so the fixture's longitudes land at known spacing and
    // nothing in the frame depends on a fit-bounds or an animation clock.
    await page.goto('/demo.html?id=minimal&forcegl2=1&e2e=1#4/20/0', {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null,
      { timeout: 30_000 },
    )

    // ── CONTROLS first: the same scenes with a CONSTANT fill. ──
    const dotsTwin = await renderArm(page, dotsStyle(FLAT))
    const arrowsTwin = await renderArm(page, arrowsStyle(FLAT))
    // ── TREATMENTS: identical scenes, the coops ramp. ──
    const dots = await renderArm(page, dotsStyle(RAMP))
    const arrows = await renderArm(page, arrowsStyle(RAMP))

    console.log(`[point-gradient-gl2] dotsTwin   ${fmt(dotsTwin)}`)
    console.log(`[point-gradient-gl2] arrowsTwin ${fmt(arrowsTwin)}`)
    console.log(`[point-gradient-gl2] dots       ${fmt(dots)}`)
    console.log(`[point-gradient-gl2] arrows     ${fmt(arrows)}`)
    console.log(
      `[point-gradient-gl2] backend=${dots.backend} buffer=${dots.size} warnings=${warnings.length}`,
    )

    // Provably measured on WebGl2Device, with no gl or page error in any arm.
    for (const [name, p] of [
      ['dotsTwin', dotsTwin],
      ['arrowsTwin', arrowsTwin],
      ['dots', dots],
      ['arrows', arrows],
    ] as const) {
      expect(p.ok, `${name}: ${p.reason ?? ''}`).toBe(true)
      expect(p.backend, `${name}: measured backend`).toBe('webgl2')
      expect(p.glError, `${name}: gl error`).toBe(0)
    }
    expect(errors, 'no page/console errors').toEqual([])

    assertFlat(dotsTwin, 'dots layer')
    assertFlat(arrowsTwin, 'arrows layer')

    // ── THE CLAIM, per path. ──
    assertPerFeatureRamp(
      dots,
      'station_dots (SDF point path)',
      'its white stroke ring is on screen',
    )
    assertPerFeatureRamp(
      arrows,
      'arrows (compiled-arrow path)',
      'the arrow silhouettes are on screen',
    )

    // A path this backend draws must not announce itself as an unsupported gap (#1583).
    expect(
      warnings.filter((w) => /data-driven fill/.test(w)),
      'a fill these paths now draw must not report itself as an unsupported gap',
    ).toHaveLength(0)
  })
})
