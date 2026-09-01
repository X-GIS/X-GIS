// #2166 — a zoom-axis `["interpolate", ["cubic-bezier", …], ["zoom"], …]` over
// COLOUR stops must reach the pixel with its authored easing (render gate).
//
// The data-driven densifier (expr-interpolate.ts) samples hex-colour stops at
// the bezier-eased fraction; its zoom-axis twin (paint-helpers.ts
// interpolateZoomStops) admitted numeric stops only and returned the plain
// two-stop shape with a "folded to linear" warning. Measured on a0a8337a, the
// zoom-axis emit for a bezier ramp was BYTE-IDENTICAL to the same ramp
// authored with ["linear"] — the curve reached no pixel at all.
//
// This gate drives the REAL converter in the browser (`__xgisImportMapbox` →
// convertMapboxStyle → runSource) over `["cubic-bezier", 0.9, 0, 1, 1]` from
// #ff0000 (z0) to #0000ff (z6), with the camera parked at z3 — the exact
// midpoint, where the two hypotheses are maximally far apart:
//
//   linear fold (pre-fix)     eased(0.5) = 0.5    → #800080  (128, 0, 128)
//   bezier densify (post-fix) eased(0.5) = 0.1328 → #dd0022  (221, 0,  34)
//
// Three arms:
//   control       ["linear"] ramp        → #800080, and #dd0022 must be 0.
//                                          GREEN IN BOTH STATES — it is what
//                                          proves the fix eased the bezier
//                                          ramp rather than recolouring every
//                                          zoom ramp.
//   discriminating cubic-bezier ramp     → #dd0022, and #800080 must be 0.
//   oracle        the seven eased stops  → frame hash EQUAL to the bezier
//                 authored by hand as a    arm's. An independent check that
//                 plain ["linear"] ramp    the curve was applied CORRECTLY,
//                                          not merely that something changed.

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureMapFrame, awaitMapIdle, colorHistogram, hashScreenshot } from './helpers/visual'

const EASED_RGB: [number, number, number] = [221, 0, 34] // #dd0022
const LINEAR_RGB: [number, number, number] = [128, 0, 128] // #800080
const BG_HEX = '#000010'
const SOURCE_ID = 'aoi'

/** The seven stops paint-helpers.ts emits for cubic-bezier(0.9, 0, 1, 1) over
 *  #ff0000 → #0000ff on [0, 6] (6 samples per segment + the endpoint). */
const EASED_STOPS = [
  0,
  '#ff0000',
  1,
  '#fc0003',
  2,
  '#f1000e',
  3,
  '#dd0022',
  4,
  '#bb0044',
  5,
  '#81007e',
  6,
  '#0000ff',
]

function style(fillColor: unknown): Record<string, unknown> {
  return {
    version: 8,
    name: 'bezier zoom colour gate',
    sources: {
      [SOURCE_ID]: {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: {
                type: 'Polygon',
                coordinates: [
                  [
                    [-30, -20],
                    [30, -20],
                    [30, 20],
                    [-30, 20],
                    [-30, -20],
                  ],
                ],
              },
            },
          ],
        },
      },
    },
    layers: [
      { id: 'bg', type: 'background', paint: { 'background-color': BG_HEX } },
      { id: 'aoi-fill', type: 'fill', source: SOURCE_ID, paint: { 'fill-color': fillColor } },
    ],
  }
}

type ArmResult = {
  backend: string | undefined
  zoom: number | undefined
  eased: number
  linear: number
  hash: string
}

async function renderArm(
  page: import('@playwright/test').Page,
  fillColor: unknown,
  label: string,
): Promise<ArmResult> {
  // `adaptive=0` pins the quality controller so the tile set cannot move
  // between arms (§12). The camera hash parks the view at exactly z3.
  await page.goto('/demo.html?e2e=1&adaptive=0#3/0/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __xgisImportMapbox?: unknown }).__xgisImportMapbox ===
      'function',
    null,
    { timeout: 45_000 },
  )
  await page.evaluate((s) => {
    ;(window as unknown as { __xgisImportMapbox: (j: object) => void }).__xgisImportMapbox(s)
  }, style(fillColor))

  // Engine-counter wait for THIS source's tiles — the background layer's
  // synthetic entry fills first, so an "any entry" wait reads a pre-first-frame
  // frame (#1845).
  await page.waitForFunction(
    (sourceId) => {
      const map = (window as unknown as { __xgisMap?: { vtSources?: Map<string, unknown> } })
        .__xgisMap
      const entry = map?.vtSources?.get(sourceId) as
        { renderer?: { getCacheSize?: () => number } } | undefined
      return (entry?.renderer?.getCacheSize?.() ?? 0) > 0
    },
    SOURCE_ID,
    { timeout: 45_000 },
  )
  expect(await awaitMapIdle(page, 45_000), `${label}: map never reached idle`).toBe('idle')

  const png = await captureMapFrame(page, { readyTimeoutMs: 45_000 })
  writeFileSync(test.info().outputPath(`${label}.png`), png)

  const ratios = await colorHistogram(page, png, [
    { name: 'eased', rgb: EASED_RGB, tolerance: 24 },
    { name: 'linear', rgb: LINEAR_RGB, tolerance: 24 },
  ])
  const total = png.readUInt32BE(16) * png.readUInt32BE(20)
  const r: ArmResult = {
    backend: await page.evaluate(
      () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
    ),
    zoom: await page.evaluate(
      () =>
        (window as unknown as { __xgisMap?: { camera: { zoom: number } } }).__xgisMap?.camera.zoom,
    ),
    eased: Math.round(ratios.eased * total),
    linear: Math.round(ratios.linear * total),
    hash: await hashScreenshot(page, png),
  }
  console.log(
    `[bezier-zoom-color] ${label}: eased(#dd0022)≈${r.eased}px linear(#800080)≈${r.linear}px ` +
      `zoom=${r.zoom} hash=${r.hash} backend=${r.backend}`,
  )
  return r
}

test.describe.configure({ timeout: 300_000 })

test.describe('zoom-axis cubic-bezier colour ramp reaches the pixel (#2166)', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('negative control — a ["linear"] ramp still resolves to #800080 at z3', async ({ page }) => {
    const r = await renderArm(
      page,
      ['interpolate', ['linear'], ['zoom'], 0, '#ff0000', 6, '#0000ff'],
      'control-linear',
    )
    expect(r.backend, 'window.__xgisActiveBackend').toBe('webgpu')
    expect(r.zoom, 'the camera must sit on the exact ramp midpoint').toBeCloseTo(3, 5)
    expect(
      r.linear,
      `a plain linear ramp must still land on #800080 at the midpoint (got ≈${r.linear}px). ` +
        `If this is 0 the gate below is vacuous — the change moved EVERY zoom colour ramp, ` +
        `not just the cubic-bezier one.`,
    ).toBeGreaterThan(20_000)
    expect(r.eased, `a linear ramp must not paint the eased colour`).toBe(0)
  })

  test('a cubic-bezier ramp paints the EASED colour, and equals its hand-computed oracle', async ({
    page,
  }) => {
    const bez = await renderArm(
      page,
      ['interpolate', ['cubic-bezier', 0.9, 0, 1, 1], ['zoom'], 0, '#ff0000', 6, '#0000ff'],
      'discriminating-bezier',
    )
    expect(bez.backend, 'window.__xgisActiveBackend').toBe('webgpu')
    expect(bez.zoom, 'the camera must sit on the exact ramp midpoint').toBeCloseTo(3, 5)
    expect(
      bez.eased,
      `cubic-bezier(0.9, 0, 1, 1) eases the midpoint to #dd0022; ≈${bez.eased}px of it means ` +
        `the zoom-axis densifier still discarded the curve and the runtime interpolated the ` +
        `authored endpoints linearly.`,
    ).toBeGreaterThan(20_000)
    expect(
      bez.linear,
      `≈${bez.linear}px of #800080 is the LINEAR fold of the same endpoints — the pre-#2166 ` +
        `two-stop emit reaching the pixel.`,
    ).toBe(0)

    // Direction, not just difference: the same seven stops authored by hand as
    // a plain linear ramp must produce the identical frame.
    const oracle = await renderArm(
      page,
      ['interpolate', ['linear'], ['zoom'], ...EASED_STOPS],
      'oracle-hand-eased',
    )
    expect(
      oracle.hash,
      `the bezier ramp must render exactly as its hand-computed eased stop list; ` +
        `bezier=${bez.hash} oracle=${oracle.hash}`,
    ).toBe(bez.hash)
  })
})
