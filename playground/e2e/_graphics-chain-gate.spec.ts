// ═══ Retained host-drawing icon renders on the WebGPU chain (#1046 Inc-2a) ═══
//
// The twin side has `_graphics-retained-gl2-gate` in CI (#823's GLSL twin);
// the CHAIN side — the ORIGINAL WGSL retained draper, driven by GraphicsPass
// through the RHI frame encoder since Inc-2a — had no CI pixel check. Same
// probe on the default backend: a solid WHITE 32×32 sprite tinted MAGENTA via
// getColor, anchored at the camera centre. A magenta cluster proves the whole
// chain at once (feat pack → atlas upload → tint storage path → pointU frame
// UBO); a tint failure reads back WHITE, an atlas failure nothing — each
// failure mode distinguishable. Zero-egress: the basemap's tile fetches may
// fail (tolerated as console noise), the icon is host-pushed and local.
//
// Readback is the composited frame (no gl on this backend): a centred 64-CSS-px
// box is cropped from the #map screenshot — CSS-sized, so the crop is
// dpr-invariant where the gl2 gate read device pixels.
//
// Headless SwiftShader WebGPU (HEADED=0 XGIS_SOFTWARE_GPU=1) — the chain arm.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__render-verify__')

test('a retained icon batch renders through the chain', async ({ page }) => {
  test.setTimeout(120_000)
  mkdirSync(OUT, { recursive: true })
  await page.setViewportSize({ width: 600, height: 600 })
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // Camera pinned by hash; the icon anchors at the SAME lon/lat, so it must
  // land at the canvas centre (RTC: camera centre IS clip origin).
  await page.goto('/demo.html?id=minimal&e2e=1#4/20/0', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(300)

  await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: {
        addImage(name: string, image: ImageData): void
        graphics: { add(spec: unknown): unknown }
        invalidate?: () => void
      }
    }
    const map = w.__xgisMap!
    // Solid WHITE 32×32 — the tint does the colouring, so magenta on screen
    // proves the tint storage path, not just the atlas (the gl2 gate's probe).
    const px = new Uint8ClampedArray(32 * 32 * 4).fill(255)
    map.addImage('e2e-dot', new ImageData(px, 32, 32))
    map.graphics.add({
      type: 'icon',
      data: [0],
      getPosition: [0, 20], // [lon, lat] = the hash camera centre
      getImage: 'e2e-dot',
      getSize: 2, // 64 CSS px — a comfortably readable cluster
      getColor: '#ff00ff',
    })
    map.invalidate?.()
  })

  // The icon anchors at the CANVAS centre = the screenshot's own centre; the
  // 64-CSS-px probe box converts through the screenshot's measured scale (the
  // demo layout may size #map below the viewport width).
  const cssSize = await page.evaluate(() => {
    const r = (document.querySelector('#map') as HTMLCanvasElement).getBoundingClientRect()
    return { w: r.width, h: r.height }
  })
  const measure = (png: PNG, cssW: number, cssH: number) => {
    const sx = png.width / cssW
    const sy = png.height / cssH
    const x0 = Math.floor(png.width / 2 - 32 * sx)
    const x1 = Math.floor(png.width / 2 + 32 * sx)
    const y0 = Math.floor(png.height / 2 - 32 * sy)
    const y1 = Math.floor(png.height / 2 + 32 * sy)
    let magenta = 0
    let white = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4
        const r = png.data[i]!,
          g = png.data[i + 1]!,
          b = png.data[i + 2]!
        if (r > 200 && g < 60 && b > 200) magenta++
        else if (r > 200 && g > 200 && b > 200) white++
      }
    }
    return { magenta, white, box: (x1 - x0) * (y1 - y0) }
  }

  // Poll until the retained draw lands (SwiftShader settle contract).
  let png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
  let m = measure(png, cssSize.w, cssSize.h)
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && m.magenta <= m.box * 0.5) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(2000)
    png = PNG.sync.read(await page.locator('#map').screenshot({ type: 'png' }))
    m = measure(png, cssSize.w, cssSize.h)
  }
  writeFileSync(join(OUT, 'graphics-chain-gate.png'), PNG.sync.write(png))

  const state = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: { ctx?: { _validationErrors?: { message: string }[] } }
    }
    return {
      marker: w.__xgisActiveBackend,
      validation: (w.__xgisMap?.ctx?._validationErrors ?? []).map((e) => e.message).slice(0, 5),
    }
  })
  console.log(
    `[graphics-chain] marker=${state.marker} magenta=${m.magenta}/${m.box} white=${m.white} ` +
      `errors=${errors.length}`,
  )

  expect(state.marker, 'default backend resolved to the WebGPU chain').toBe('webgpu')
  expect(state.validation, 'no GPU validation errors').toEqual([])
  expect(errors, 'no page/console errors').toEqual([])

  // The 64-CSS-px icon fills most of the 64×64 probe box — solid magenta
  // cluster (tint applied), and NO white cluster (tint NOT applied).
  expect(m.magenta, `magenta pixels ${m.magenta}/${m.box}`).toBeGreaterThan(m.box * 0.5)
  expect(m.white, `white (untinted) pixels ${m.white}/${m.box}`).toBeLessThan(m.box * 0.05)
})
