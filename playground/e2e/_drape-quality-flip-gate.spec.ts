// ═══ #2292 — a quality flip rebuilds the globe drape at the new sample count ═══
//
// `setQuality({msaa|picking})` re-allocates the opaque pass at the new sample
// count, but its per-VTR loop only re-wired bind-group layouts and pipelines. The
// lazily-built VectorDrapeRenderer holds RasterDraper Materials whose multisample
// count is BAKED at creation, so after a flip the drape handed 4x pipelines to a
// 1x pass: a WebGPU setPipeline validation error that invalidates the whole opaque
// pass — a black globe every frame while draping. The fix drops `_drape` in
// VectorTileRenderer.rebuildForQuality() so the existing `??=` rebuilds it at the
// live getSampleCount().
//
// WHY THIS SPEC EXISTS SEPARATELY from the vitest gate: that one proves the
// renderer CALLS destroy() and rebuilds, against a stub. A stub has no validator,
// so it cannot show the thing that actually breaks — a real device rejecting the
// pipeline — nor that the globe still paints afterwards. This is that arm.
//
// The instrument is the per-context validation queue `initGPU` installs, read
// through clearValidationErrors/getValidationErrors rather than
// withValidationCapture: that wrapper reads the queue once, after the body's last
// navigation (#2352), and this body flips quality inside one realm.
//
// Two assertions, because either alone is satisfiable the wrong way: a silent
// validator says nothing about whether anything drew, and a painted frame says
// nothing about a validation error the pass swallowed.

import { test, expect, type Page } from '@playwright/test'
import { captureMapFrame, awaitMapIdle } from './helpers/visual'
import { clearValidationErrors, getValidationErrors } from './helpers/validation'

type MapWin = {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: {
    setSourceData?: (id: string, fc: unknown) => void
    invalidate?: () => void
    getQuality?: () => { msaa: number }
    setQuality?: (patch: { msaa: number }) => void
    vtSources?: Map<string, { renderer: Record<string, unknown> }>
  }
}

/** Shared with _drape-fill-opacity-gate: one quad both fixture layers drape. */
const QUAD = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [-25, -16],
            [25, -16],
            [25, 16],
            [-25, 16],
            [-25, -16],
          ],
        ],
      },
    },
  ],
}

async function paintedCount(page: Page, png: Buffer): Promise<number> {
  return await page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob())
    const bmp = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data
    let n = 0
    for (let i = 0; i < d.length; i += 4) if (d[i + 1]! > 20) n++
    return n
  }, png.toString('base64'))
}

async function drapeState(page: Page): Promise<{ draping: boolean; baked: number }> {
  return await page.evaluate(() => {
    let draping = false
    let baked = 0
    for (const [key, entry] of (window as unknown as MapWin).__xgisMap?.vtSources ?? []) {
      if (key === '__synthetic_earth_surface__') continue
      const r = entry.renderer
      if (r['_drapeGlobeFills'] === true) draping = true
      baked += [
        ...((r['_drape'] as { baked?: Map<string, unknown> } | undefined)?.baked?.keys() ?? []),
      ].length
    }
    return { draping, baked }
  })
}

test.describe.configure({ timeout: 600_000 })

test('#2292 — the globe drape survives a setQuality msaa flip', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(String(e)))

  await page.goto(`/demo.html?id=fixture_drape_opacity&preserve=1&adaptive=0&proj=globe#2/0/0`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as MapWin).__xgisReady === true, null, {
    timeout: 120_000,
  })

  // The drape bake is WebGPU-only, and so is the validator this gate reads — a
  // silent WebGL2 fallback would make both instruments say nothing (§12).
  expect(
    await page.evaluate(() => (window as unknown as MapWin).__xgisActiveBackend),
    'this gate must not measure a WebGL2 fallback',
  ).toBe('webgpu')

  await page.evaluate(() => {
    const g = globalThis as { __XGIS_FORCE_VECTOR_DRAPE?: boolean }
    g.__XGIS_FORCE_VECTOR_DRAPE = true
    ;(window as unknown as MapWin).__xgisMap?.invalidate?.()
  })
  await page.evaluate((fc) => {
    ;(window as unknown as MapWin).__xgisMap!.setSourceData!('poly', fc)
  }, QUAD)
  await awaitMapIdle(page, 90_000)

  const before = await paintedCount(page, await captureMapFrame(page))
  const stateBefore = await drapeState(page)
  expect(stateBefore.draping, 'the drape never engaged, so the flip below tests nothing').toBe(true)
  expect(before, 'nothing painted before the flip').toBeGreaterThan(10_000)

  // Flip to the OTHER sample count, whichever the page booted at, so the gate does
  // not encode an assumption about the default.
  await clearValidationErrors(page)
  const flip = await page.evaluate(() => {
    const m = (window as unknown as MapWin).__xgisMap!
    const from = m.getQuality!().msaa
    const to = from === 1 ? 4 : 1
    m.setQuality!({ msaa: to })
    m.invalidate?.()
    return { from, to }
  })
  expect(flip.from, 'the flip must change the sample count').not.toBe(flip.to)
  await awaitMapIdle(page, 90_000)

  const after = await paintedCount(page, await captureMapFrame(page))
  const stateAfter = await drapeState(page)
  const validation = await getValidationErrors(page)

  // (1) the device accepted every pipeline the flipped pass bound. Under #2292 the
  //     drape binds a pipeline baked at the OLD sample count and this is non-empty.
  expect(
    validation.map((v) => v.message),
    `WebGPU validation errors after the msaa ${flip.from} -> ${flip.to} flip`,
  ).toEqual([])
  expect(errors, `page errors: ${errors.join(' | ')}`).toHaveLength(0)

  // (2) and the globe still PAINTS through the drape. A validator that stayed
  //     quiet because the pass was skipped entirely would satisfy (1) alone.
  expect(stateAfter.draping, 'the drape stopped draping after the flip').toBe(true)
  expect(
    after,
    `painted ${after} px after the flip vs ${before} before — the invalidated opaque pass draws a black globe`,
  ).toBeGreaterThan(before * 0.8)
})
