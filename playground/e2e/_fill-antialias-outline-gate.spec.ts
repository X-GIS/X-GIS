// #2166 — `fill-antialias` gates the fill-OUTLINE draw (render gate).
//
// MapLibre creates its context with `antialias: false` (map.ts:457), so its
// only fill-edge AA is the 1 px feathered outline pass, drawn ONLY when
// `fill-antialias` is true (draw_fill.ts:44). The style spec encodes it:
// `fill-outline-color.requires = [{"!":"fill-pattern"},{"fill-antialias":true}]`.
// X-GIS emitted `stroke-<color> stroke-1` unconditionally, so an
// antialias:false polygon got a wrong-direction border MapLibre never paints.
//
// This gate drives the REAL converter in the browser (`__xgisImportMapbox` →
// convertMapboxStyle → runSource) with two arms that differ in exactly one
// key, and counts MAGENTA pixels — a colour that can exist in the frame only
// if the outline was emitted and drawn:
//
//   discriminating   fill-antialias: false   → outline pixels MUST be 0
//   negative control (property absent)       → outline pixels MUST be > 0
//
// The control arm is green in BOTH states: it is what proves the fix skipped
// only the `false` case rather than simply ceasing to emit outlines.
//
// Fail-before / mechanism cut, measured on this container by severing exactly
// the `if (aa !== false)` guard in paint-fill.ts: the two arms then rendered
// BYTE-IDENTICAL frames (same md5), outline≈2296px in both — `fill-antialias:
// false` changed nothing at all. The control arm PASSED and the discriminating
// arm failed naming the severed half:
//
//   Error: fill-antialias:false must suppress the fill-outline pass (MapLibre
//   draw_fill.ts:44); ≈2296 #ff00ff pixels means the converter still emitted
//   stroke-#ff00ff stroke-1.
//
// With the guard in place: control 2296px (md5 unchanged, DC 0.0000%),
// discriminating 0px, DC 0.7429% concentrated on the box's four edges.

import { test, expect } from '@playwright/test'
import { writeFileSync } from 'node:fs'
import { captureMapFrame, awaitMapIdle, colorHistogram } from './helpers/visual'

/** Outline colour. Magenta is chosen so no blend of the fill (green) with the
 *  background (near-black) can land in its bucket: it is the only colour in
 *  the frame with R and B both high while G is low. */
const OUTLINE_RGB: [number, number, number] = [255, 0, 255]
const FILL_RGB: [number, number, number] = [31, 158, 31]
const OUTLINE_HEX = '#ff00ff'
const FILL_HEX = '#1f9e1f'
const BG_HEX = '#000010'
const SOURCE_ID = 'aoi'

/** One box whose edges sit well inside the map canvas at z3/0/0, so a 1 px
 *  stroke leaves a couple of thousand countable device pixels. */
function style(antialias?: boolean): Record<string, unknown> {
  const paint: Record<string, unknown> = {
    'fill-color': FILL_HEX,
    'fill-outline-color': OUTLINE_HEX,
  }
  if (antialias !== undefined) paint['fill-antialias'] = antialias
  return {
    version: 8,
    name: 'fill-antialias outline gate',
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
      { id: 'aoi-fill', type: 'fill', source: SOURCE_ID, paint },
    ],
  }
}

type ArmResult = { backend: string | undefined; outline: number; fill: number }

async function renderArm(
  page: import('@playwright/test').Page,
  antialias: boolean | undefined,
  label: string,
): Promise<ArmResult> {
  // Default backend (WebGPU on SwiftShader here). `?forcegl2=1` is NOT used:
  // __xgisImportMapbox re-runs runSource, and the second forced WebGL2 boot
  // loses the first context ("[X-GIS] WebGL2 context lost", measured on this
  // container) — a harness fact, not a fill-antialias fact.
  // `adaptive=0` pins the quality controller so the tile set cannot move
  // between the two arms (§12).
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
  }, style(antialias))

  // Engine-counter wait for THIS source's tiles (a state `idle` can be reached
  // before): the background layer installs an always-present synthetic
  // vtSources entry whose cache fills first, so an "any entry" wait reads a
  // pre-first-frame frame (#1845).
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
    { name: 'outline', rgb: OUTLINE_RGB, tolerance: 70 },
    { name: 'fill', rgb: FILL_RGB, tolerance: 40 },
  ])
  const backend = await page.evaluate(
    () => (window as unknown as { __xgisActiveBackend?: string }).__xgisActiveBackend,
  )
  // colorHistogram returns RATIOS over the captured bitmap, and the captured
  // canvas is NOT the viewport — the demo's editor pane makes `#map` ~860×720
  // inside a 1280×720 window. Read the real size out of the PNG's IHDR so the
  // reported pixel counts are the measured ones, not a rescaled guess.
  const total = png.readUInt32BE(16) * png.readUInt32BE(20)
  const r = {
    backend,
    outline: Math.round(ratios.outline * total),
    fill: Math.round(ratios.fill * total),
  }
  console.log(
    `[fill-antialias-outline] ${label}: outline≈${r.outline}px fill≈${r.fill}px backend=${backend}`,
  )
  return r
}

test.describe.configure({ timeout: 240_000 })

test.describe('fill-antialias gates the fill-outline draw (#2166)', () => {
  test.use({ viewport: { width: 1280, height: 720 } })

  test('negative control — fill-antialias ABSENT still draws the outline', async ({ page }) => {
    const r = await renderArm(page, undefined, 'control-antialias-absent')
    expect(r.backend, 'window.__xgisActiveBackend').toBe('webgpu')
    expect(r.fill, `the polygon itself must render (fill ≈${r.fill}px)`).toBeGreaterThan(20_000)
    expect(
      r.outline,
      `the spec default for fill-antialias is TRUE, so the ${OUTLINE_HEX} outline must be ` +
        `drawn; got ≈${r.outline}px. If this is 0 the gate below is vacuous — the change ` +
        `suppressed EVERY outline, not just the antialias:false one.`,
    ).toBeGreaterThan(200)
  })

  test('fill-antialias: false draws NO outline', async ({ page }) => {
    const r = await renderArm(page, false, 'discriminating-antialias-false')
    expect(r.backend, 'window.__xgisActiveBackend').toBe('webgpu')
    expect(r.fill, `the polygon itself must still render (fill ≈${r.fill}px)`).toBeGreaterThan(
      20_000,
    )
    expect(
      r.outline,
      `fill-antialias:false must suppress the fill-outline pass (MapLibre draw_fill.ts:44); ` +
        `≈${r.outline} ${OUTLINE_HEX} pixels means the converter still emitted ` +
        `stroke-${OUTLINE_HEX} stroke-1.`,
    ).toBe(0)
  })
})
