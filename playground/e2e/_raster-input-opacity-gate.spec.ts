// ═══ §5 render gate: `input`-driven opacity reaches the raster + DEM passes ═══
//
// #2166 (L3). #1539 made `map.setInput()` move pixels — but only on the layer
// types whose per-frame resolve was handed the live input store. The raster
// pass (opaque-pass.ts) and the DEM-relief pass (hillshade-pass.ts) called
// `resolveNumberShape` WITHOUT it, so an `input-dependent` opacity shape took
// the per-feature fallback of 1: the authored default was gone on frame one and
// `setInput` moved nothing. The unit twin
// (map/src/render/passes/raster-input-opacity.test.ts) proves the value reaches
// `setOpacity`; only a real render can say it reaches the SCREEN.
//
// The #1539 gate could not have caught this — it drives a geojson POLYGON
// fixture whose `input threshold` default is 1.0, so nothing about the raster
// path is exercised and an un-set default renders unchanged by construction.
// The two fixtures here are raster / raster-dem and default to 0.4.
//
// Verdict is DIRECTIONAL and each arm is its own half, so a red run names which
// pass regressed:
//   • CONTROL — two captures with no setInput between them must be
//     byte-identical, or a positive result below proves nothing.
//   • CHANGE  — setInput('dim', 1) must move pixels, and (structure, not a bare
//     count — §12) the moved pixels must form a BROAD SPREAD FIELD: a quarter of
//     the frame overall and at least 5% of EVERY quadrant. That is the signature
//     of a layer-alpha change; an edge band or a single corner — what a geometry
//     shift or a stray overlay looks like — fails it.
//   • ROUND TRIP — setting 0.4 back must reproduce the first capture byte for
//     byte, which distinguishes "the input drove it" from any drift.
// On the pre-fix tree all three captures are identical and CHANGE reads 0.
//
// Backend is PINNED to WebGL2 and asserted from the live #backend-tag, so a
// silent fallback cannot green this. `adaptive=0` pins the adaptive quality
// controller off (its far-LOD boost is wall-clock driven and moves the tile set
// under a hash-equality rung — #2120). Frames are captured with
// `captureMapFrame`, never a raw element screenshot: the demo chrome composites
// over #map and would land in the measured pixels (capture-canvas skill).

import { test, expect, type Page } from '@playwright/test'
import { PNG } from 'pngjs'
import { writeFileSync } from 'node:fs'
import { captureMapFrame } from './helpers/visual'

test.describe.configure({ timeout: 180_000 })

/** Two consecutive engine-quiesced captures that agree byte for byte. Each
 *  `captureMapFrame` runs its own ready + drained-frames + rAF quiesce, so this
 *  is a settle CRITERION, not a sleep — a scene that never stabilises fails the
 *  spec loudly instead of freezing a mid-load frame into a measurement. */
async function settled(page: Page, why: string): Promise<Buffer> {
  let prev = await captureMapFrame(page, { readyTimeoutMs: 45_000 })
  for (let i = 0; i < 10; i++) {
    const next = await captureMapFrame(page, { readyTimeoutMs: 45_000 })
    if (next.equals(prev)) return next
    prev = next
  }
  throw new Error(`${why}: the scene never produced two identical consecutive frames`)
}

interface Diff {
  changed: number
  total: number
  fraction: number
  /** Changed fraction of each quadrant (TL, TR, BL, BR) — the SHAPE of the
   *  change, which is what separates a layer-alpha move from an edge band. */
  quadrants: [number, number, number, number]
}

/** Per-pixel change count over the whole chrome-free canvas, decomposed by
 *  quadrant. Both fixtures cover the full viewport, so a layer-alpha change is
 *  a broad spread field while a geometry shift is a band. */
function diff(a: Buffer, b: Buffer): Diff {
  const ia = PNG.sync.read(a)
  const ib = PNG.sync.read(b)
  const w = Math.min(ia.width, ib.width)
  const h = Math.min(ia.height, ib.height)
  const hitQ = [0, 0, 0, 0]
  const totQ = [0, 0, 0, 0]
  let changed = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y < h / 2 ? 0 : 2) + (x < w / 2 ? 0 : 1)
      totQ[q]!++
      const i = (y * ia.width + x) * 4
      const j = (y * ib.width + x) * 4
      if (
        Math.abs(ia.data[i]! - ib.data[j]!) > 4 ||
        Math.abs(ia.data[i + 1]! - ib.data[j + 1]!) > 4 ||
        Math.abs(ia.data[i + 2]! - ib.data[j + 2]!) > 4
      ) {
        changed++
        hitQ[q]!++
      }
    }
  }
  return {
    changed,
    total: w * h,
    fraction: changed / (w * h),
    quadrants: hitQ.map((n, k) => n / Math.max(1, totQ[k]!)) as [number, number, number, number],
  }
}

/** Pixels that differ from the frame's own top-left pixel — the non-blank floor.
 *  Without it a blank scene would satisfy the CONTROL arm trivially. */
function nonUniform(png: Buffer): number {
  const im = PNG.sync.read(png)
  const [r0, g0, b0] = [im.data[0]!, im.data[1]!, im.data[2]!]
  let n = 0
  for (let p = 0; p < im.width * im.height; p++) {
    const i = p * 4
    if (
      Math.abs(im.data[i]! - r0) > 8 ||
      Math.abs(im.data[i + 1]! - g0) > 8 ||
      Math.abs(im.data[i + 2]! - b0) > 8
    ) {
      n++
    }
  }
  return n
}

async function setInput(page: Page, name: string, value: number): Promise<void> {
  await page.evaluate(
    ([n, v]) => {
      const m = (window as unknown as { __xgisMap?: { setInput(k: string, x: unknown): void } })
        .__xgisMap
      if (!m) throw new Error('__xgisMap not exposed — the demo shell did not publish the map')
      m.setInput(n as string, v)
    },
    [name, value] as const,
  )
}

/** One half of the gate. `half` names the pass under test so a red run says
 *  WHICH resolve lost the store, not merely that something changed. */
function armFor(half: 'RASTER (opaque-pass)' | 'HILLSHADE (hillshade-pass)', demoId: string) {
  return async ({ page }: { page: Page }): Promise<void> => {
    await page.setViewportSize({ width: 900, height: 700 })
    await page.goto(`/demo.html?id=${demoId}&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0`, {
      waitUntil: 'domcontentloaded',
    })
    await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })

    const atDefault = await settled(page, `${half} default capture`)
    writeFileSync(test.info().outputPath('at-default-0.4.png'), atDefault)
    expect(
      nonUniform(atDefault),
      `${half}: the scene rendered blank, so every comparison below would be vacuous`,
    ).toBeGreaterThan(10_000)

    // ── CONTROL ──
    const control = await settled(page, `${half} control capture`)
    writeFileSync(test.info().outputPath('control.png'), control)
    const dcControl = diff(atDefault, control)
    expect(
      dcControl.changed,
      `${half}: two captures with NO setInput between them differ in ${dcControl.changed} px — ` +
        'this harness is nondeterministic, so the CHANGE arm below would prove nothing',
    ).toBe(0)

    // ── CHANGE ──
    await setInput(page, 'dim', 1)
    const atOne = await settled(page, `${half} post-setInput capture`)
    writeFileSync(test.info().outputPath('at-1.0.png'), atOne)
    const dc = diff(atDefault, atOne)
    // Printed so a passing run still carries its §5 numbers into the log.
    console.log(
      `[${half}] DC=${dc.changed}/${dc.total} (${(dc.fraction * 100).toFixed(1)}%) ` +
        `quadrants=${dc.quadrants.map((q) => (q * 100).toFixed(1) + '%').join(' ')}`,
    )
    expect(
      dc.changed,
      `${half}: setInput('dim', 1) moved ZERO pixels. The pass is resolving ` +
        'paintShapes.common.opacity without the InputStore, so the input-dependent shape takes ' +
        'the per-feature fallback of 1 and neither the authored 0.4 default nor any later ' +
        'setInput can reach the screen.',
    ).toBeGreaterThan(0)
    expect(
      dc.fraction,
      `${half}: only ${(dc.fraction * 100).toFixed(1)}% of the frame moved. A layer-alpha ` +
        'change is a broad field over the tile extent; a sliver would mean something other ' +
        'than the layer alpha moved.',
    ).toBeGreaterThan(0.25)
    expect(
      Math.min(...dc.quadrants),
      `${half}: the change is not spread — quadrant coverage was ` +
        `${dc.quadrants.map((q) => (q * 100).toFixed(1) + '%').join(' / ')}. A layer-alpha ` +
        'change reaches every quadrant the layer covers; a band or a corner is a geometry ' +
        'or overlay artefact, not an alpha change.',
    ).toBeGreaterThan(0.05)

    // ── ROUND TRIP ──
    await setInput(page, 'dim', 0.4)
    const back = await settled(page, `${half} round-trip capture`)
    writeFileSync(test.info().outputPath('back-to-0.4.png'), back)
    expect(
      diff(atDefault, back).changed,
      `${half}: returning the input to its declared 0.4 did not reproduce the first frame — the ` +
        'resolved opacity is not a pure function of the input value',
    ).toBe(0)
  }
}

test(
  'RASTER: an input-dependent opacity reaches the screen through the opaque pass (webgl2)',
  armFor('RASTER (opaque-pass)', 'fixture_raster_input_opacity'),
)

test(
  'HILLSHADE: an input-dependent opacity reaches the screen through the DEM-relief pass (webgl2)',
  armFor('HILLSHADE (hillshade-pass)', 'fixture_dem_input_opacity'),
)
