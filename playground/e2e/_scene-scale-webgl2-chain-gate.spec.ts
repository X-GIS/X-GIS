// ═══ The SCALED scene target on the WebGL2 CHAIN frame (#1046 Inc-F3) ═══
//
// This path has never executed. `_scene-scale-seam-gate` boots WITHOUT
// `forcegl2`, so it only ever exercises the WebGPU chain; `_twin-parity-ratchet`
// pins `scenescale=1` on both arms deliberately. Nothing has ever driven the
// adaptive ladder on a WebGL2 chain frame.
//
// It becomes the DEFAULT the moment the twin is deleted. Today:
//
//     rendersViaTwin = asScreenPassDevice(rhi) !== null && !(RHI_CHAIN && chainRunsOnWebgl2)
//     canvasScale    = rendersViaTwin ? adaptiveScale : 1
//     sceneScale     = rendersViaTwin ? 1 : adaptiveScale
//
// so the twin shrinks the CANVAS and the chain shrinks the SCENE TARGET, adding
// a scene-upscale seam pass and leaving the overlays (labels, graphics) at
// native resolution — the whole point of the split
// (docs/architecture/design/overlay-native-resolution.md). Deleting the twin
// makes `rendersViaTwin` constant-false, i.e. flips every WebGL2 client onto the
// second arm.
//
// This gate was written BEFORE the deletion and run through the
// `XGIS_E2E_CHAIN` harness, which made `rendersViaTwin` false while the twin was
// still there to fall back on — the deletion's fail-before, run early rather
// than discovered late. It passed, which is why the deletion went ahead.
//
// The harness requirement is now GONE, and removing it was mandatory rather than
// tidy-up: with the twin deleted `?forcegl2=1` IS the chain, so a
// `skip(!XGIS_E2E_CHAIN)` guard would have turned this gate into a permanent
// skip — green forever, measuring nothing. The `__xgisFrameArm === 'chain'`
// assertion stays and is now unconditionally true; if it ever fails, a second
// frame shape survived the deletion.
//
// `?debug=checker` supplies the CONTENT. A sourceless `id=minimal` frame draws
// nothing by design (#1041 parity), so without it both arms read 0/25 painted
// texels and the gate would report the ladder as broken when the fixture simply
// had nothing to draw — which is what the first draft of this file did. The
// CONTROL below (scenescale=1, same everything else) exists to make that
// mistake impossible to repeat: it varies exactly one axis.

import { test, expect } from '@playwright/test'

const VIEW = { width: 800, height: 600 }

async function probe(page: import('@playwright/test').Page, sceneScale: string) {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  await page.setViewportSize(VIEW)
  await page.goto(`/demo.html?id=minimal&e2e=1&forcegl2=1&debug=checker&scenescale=${sceneScale}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(600)

  const read = () =>
    page.evaluate(() => {
      const w = window as unknown as {
        __xgisActiveBackend?: string
        __xgisFrameArm?: string
        __xgisSceneUpscaleDraws?: number
        __xgisMap?: {
          ctx?: {
            rhi?: { backend?: string; gl?: WebGL2RenderingContext }
            _validationErrors?: unknown[]
          }
          invalidate?: () => void
        }
      }
      const c = document.querySelector('canvas') as HTMLCanvasElement | null
      const gl = w.__xgisMap?.ctx?.rhi?.gl
      let painted = 0
      if (gl) {
        const px = new Uint8Array(4)
        for (let i = 1; i < 6; i++)
          for (let j = 1; j < 6; j++) {
            gl.readPixels(
              Math.floor((gl.drawingBufferWidth * i) / 6),
              Math.floor((gl.drawingBufferHeight * j) / 6),
              1,
              1,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              px,
            )
            if (px[0]! + px[1]! + px[2]! > 24) painted++
          }
      }
      return {
        marker: w.__xgisActiveBackend,
        arm: w.__xgisFrameArm,
        rhiBackend: w.__xgisMap?.ctx?.rhi?.backend,
        seamDraws: w.__xgisSceneUpscaleDraws ?? 0,
        validationErrors: (w.__xgisMap?.ctx?._validationErrors ?? []).length,
        glError: gl ? gl.getError() : -1,
        canvasW: c?.width ?? 0,
        canvasH: c?.height ?? 0,
        clientW: c?.clientWidth ?? 0,
        dpr: window.devicePixelRatio,
        painted,
      }
    })

  // ── The arm, first. A silent fallback to the twin (or to WebGPU) must not be
  // able to green anything below — that is exactly how a sweep reports success
  // while measuring the path it was meant to replace.
  const s = await read()
  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
  )
  await page.waitForTimeout(400)
  const s2 = await read()
  return { s, s2, errors }
}

test('CONTROL: scenescale=1 on the WebGL2 chain paints (the fixture is not the problem)', async ({
  page,
}) => {
  const { s } = await probe(page, '1')
  expect(s.arm, 'control must also run on the chain arm').toBe('chain')
  expect(
    s.painted,
    `the CONTROL is blank too (${s.painted}/25) — the fixture or the threshold is wrong, not ` +
      'the ladder; fix this gate before reading anything into the scaled case',
  ).toBeGreaterThan(12)
})

test('the adaptive ladder scales the SCENE on a WebGL2 chain frame (#1046 Inc-F3)', async ({
  page,
}) => {
  const { s, s2, errors } = await probe(page, '0.72')
  expect(s.rhiBackend, 'device is WebGl2Device').toBe('webgl2')
  expect(s.marker, 'the boot marker agrees').toBe('webgl2')
  expect(
    s.arm,
    'this ran on the TWIN arm — the harness did not arm the chain, so every assertion below ' +
      'would describe the frame this gate exists to replace',
  ).toBe('chain')

  // ── The single number that distinguishes the two arms. The twin scales the
  // CANVAS; the chain must leave it native and shrink the scene target instead.
  const expectedW = Math.round(s.clientW * s.dpr)
  expect(
    s.canvasW,
    `canvas is ${s.canvasW}px for a ${s.clientW}css × ${s.dpr}dpr box — the ladder shrank the ` +
      'CANVAS, which is the twin behaviour; the chain must scale the scene target instead',
  ).toBe(expectedW)

  // ── Constructive proof the scaled pair actually allocated and drew: the seam
  // pass throws when its flags and bridges disagree, so a rising counter means
  // the offscreen scene target exists and was reinflated to the swapchain.
  expect(
    s.seamDraws,
    'the scene-upscale seam never drew — the scaled pair did not run',
  ).toBeGreaterThan(0)
  expect(s2.seamDraws, 'the seam pass stopped drawing across frames').toBeGreaterThan(s.seamDraws)

  // ── It has to PAINT. A seam that clears without drawing presents black, and a
  // pixel-count gate alone would call that a pass.
  expect(s.painted, `only ${s.painted}/25 sampled texels are non-black`).toBeGreaterThan(12)

  // ── And the untested part: the offscreen-vs-sentinel dispatch on WebGL2.
  expect(s.glError, 'a GL error was raised').toBe(0)
  expect(s.validationErrors, 'RHI validation errors were recorded').toBe(0)
  expect(errors, `page/console errors: ${errors.join(' | ')}`).toEqual([])
})
