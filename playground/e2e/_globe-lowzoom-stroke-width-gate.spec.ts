// ═══ #2332 — a constant-px stroke is constant px on the globe BELOW z* (real GPU) ═══
//
// `Camera.effectiveMpp` mirrored buildECEFFrameView's cos-lat view-height cap in its
// globe arm, but a globeMode camera renders through buildGlobeFrame → globeAltitude,
// which is UNCAPPED for the perspective globe (#450). Below z* — the zoom where the
// raw metres-per-pixel crosses that cap, ≈ log2(H·π/512) — every world-metre-scaled
// consumer therefore read a scale up to 6.6× smaller than the frame drew at. The
// largest pixel mover among them is LINE STROKE WIDTH: the line renderer expands a
// px width in world space through `writeLayerSlot(..., mpp, ...)`, so a `stroke-8`
// parallel came out ~1.2 px at z0 on a 1080 px canvas. #2332 gives effectiveMpp one
// arm per builder getViewForProjection can actually reach.
//
// WHY THIS SPEC EXISTS SEPARATELY from the vitest gate: that one proves effectiveMpp
// equals the scale measured from the MVP matrix. It cannot show the value reaches a
// PIXEL through the line renderer on a device. This is the §5 arm, and the authored
// width is its ground truth: no MapLibre reference is needed for "8 px must be 8 px".
//
// THE INSTRUMENT is _1222-drape-stroke-zoom-width's — the median vertical amber run
// per column across the central band is the on-screen stroke width — applied to the
// DIRECT path (`__XGIS_DISABLE_VECTOR_DRAPE`, which the VTR documents as forcing
// every direct draw), so the value measured is the line renderer's own expansion and
// not the drape bake's #1222 zoom bucket.
//
// THE CONTROL is the same scene ABOVE z*, where rawMpp is under the cap and every arm
// of effectiveMpp returned the same number before and after #2332 — so it measures
// what this device draws for `stroke-8` (SwiftShader's AA thresholds shave the
// edges), and the low-zoom arms are asserted against THAT rather than against a
// literal 8. Under the defect the two low-zoom widths are ~31 % and ~55 % of the
// control on this canvas (cap/rawMpp at z0.8 and z1.6); ±25 % separates both from
// the fixed value with room for a pixel of rounding.

import { test, expect, type Page } from '@playwright/test'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'

/** Three long stroke-8 amber parallels — _1222's scene, unchanged. */
const SRC = `xgis 1

source parallels {
  type: geojson
  data: { "type": "FeatureCollection", "features": [
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,-20],[-30,-20],[0,-20],[30,-20],[60,-20]] }, "properties": {} },
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,0],[-30,0],[0,0],[30,0],[60,0]] }, "properties": {} },
    { "type": "Feature", "geometry": { "type": "LineString", "coordinates": [[-60,20],[-30,20],[0,20],[30,20],[60,20]] }, "properties": {} }
  ] }
}

layer bands {
  source: parallels
  | stroke-amber-500 stroke-8
}
`

/** 1100×900 at dpr 1: z* = log2(900·π/512) ≈ 2.47. Two arms below, one control above. */
const VIEW = { width: 1100, height: 900 }
const LOW_ZOOMS = [0.8, 1.6]
const CONTROL_ZOOM = 3.2

type MapWin = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    invalidate?: () => void
    markCameraPositioned?: () => void
    getCamera?: () => { zoom: number; maxZoom: number; globeMode?: boolean }
  }
}

async function setZoom(page: Page, zoom: number): Promise<void> {
  await page.evaluate((z) => {
    const m = (window as unknown as MapWin).__xgisMap!
    const c = m.getCamera!()
    c.zoom = Math.max(0, Math.min(c.maxZoom, z))
    m.markCameraPositioned?.()
    m.invalidate?.()
  }, zoom)
  await awaitMapIdle(page, 90_000)
}

/** Median vertical amber run per column in the central band — the on-screen stroke
 *  width (the parallels are near-horizontal there; at the limb a slope would inflate
 *  a vertical run). Verbatim _1222's measurement. */
async function strokeWidthPx(
  page: Page,
  png: Buffer,
): Promise<{ median: number; samples: number }> {
  return await page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    const x0 = Math.floor(bmp.width * 0.35)
    const x1 = Math.floor(bmp.width * 0.65)
    const runs: number[] = []
    for (let x = x0; x < x1; x++) {
      let run = 0
      for (let y = 0; y < bmp.height; y++) {
        const i = (y * bmp.width + x) * 4
        // amber-500 #f59e0b
        const isStroke = d[i]! > 200 && d[i + 1]! > 110 && d[i + 1]! < 200 && d[i + 2]! < 90
        if (isStroke) run++
        else {
          if (run >= 1 && run <= 60) runs.push(run)
          run = 0
        }
      }
      if (run >= 1 && run <= 60) runs.push(run)
    }
    runs.sort((a, b) => a - b)
    return { median: runs.length ? runs[Math.floor(runs.length / 2)]! : 0, samples: runs.length }
  }, png.toString('base64'))
}

test.describe.configure({ timeout: 600_000 })

test('#2332 — a stroke-8 parallel keeps its px width on the globe below z*', async ({ page }) => {
  await page.setViewportSize(VIEW)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  const src = Buffer.from(SRC, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1&adaptive=0&proj=globe#src=${src}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 120_000,
  })
  // The direct path is what is measured, on either backend; the flag is read per
  // render, so it takes effect on the next frame (the sibling drape gates' idiom).
  await page.evaluate(() => {
    ;(globalThis as { __XGIS_DISABLE_VECTOR_DRAPE?: boolean }).__XGIS_DISABLE_VECTOR_DRAPE = true
    ;(window as unknown as MapWin).__xgisMap?.invalidate?.()
  })
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisMap?.getCamera?.()?.globeMode),
    'the scene must be in globeMode — the arm #2332 fixed',
  ).toBe(true)

  await setZoom(page, CONTROL_ZOOM)
  const control = await strokeWidthPx(page, await captureMapFrame(page))
  expect(control.samples, `z${CONTROL_ZOOM}: stroke visible`).toBeGreaterThan(50)
  // The division guard, and the premise that the control measures a STROKE: an
  // edge-only reading would let every ratio below pass against a 1-px control.
  expect(control.median, `z${CONTROL_ZOOM}: control width ${control.median}px`).toBeGreaterThan(4)

  const widths: number[] = []
  for (const z of LOW_ZOOMS) {
    await setZoom(page, z)
    const m = await strokeWidthPx(page, await captureMapFrame(page))
    expect(m.samples, `z${z}: stroke visible`).toBeGreaterThan(50)
    widths.push(m.median)
  }
  console.log(
    `#2332 widths: control z${CONTROL_ZOOM}=${control.median}px, ${LOW_ZOOMS.map((z, i) => `z${z}=${widths[i]}px`).join(', ')}`,
  )
  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0)

  for (let i = 0; i < LOW_ZOOMS.length; i++) {
    const ratio = widths[i]! / control.median
    expect(
      ratio,
      `z${LOW_ZOOMS[i]}: ${widths[i]}px is ${(ratio * 100).toFixed(0)}% of the above-z* width ${control.median}px — under #2332 the line renderer expanded the stroke with a capped mpp the globe frame never used`,
    ).toBeGreaterThan(0.75)
    expect(ratio, `z${LOW_ZOOMS[i]}: wider than the control`).toBeLessThan(1.25)
  }
})
