// #1154 — background-pattern PIXEL gate (fail-before/verified).
//
// The defect this pins: `background { fill:#1a1a2e pattern: pat }` rendered SOLID
// NAVY — zero pattern pixels — on flat AND globe. The only prior coverage asserted
// a draw COUNTER, which stayed green while the fill drew nothing (the vertex shader
// applied the pattern-repeat, packed into the fill_translate slots, as an NDC
// position offset and flung every vertex off-screen). A counter cannot catch that;
// a pixel assertion can. The sprite `pat` is 128 red + 128 blue opaque texels, so a
// correctly-tiled world-anchored pattern MUST paint BOTH red and blue on the canvas.
//
// Real headed GPU (Windows headless enumerates no WebGPU adapter). An
// `uncapturederror` hook fails the test on any GPU validation error.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'

type Win = Window & { __xgisReady?: boolean; __xgisMap?: { invalidate?: () => void } }

const INSTALL_GPU_ERROR_HOOK = () => {
  const w = window as unknown as { __xgisGpuErrors?: string[] }
  w.__xgisGpuErrors = []
  const g = navigator as unknown as {
    gpu?: { requestAdapter: (o?: unknown) => Promise<unknown> }
  }
  if (!g.gpu) return
  const origReq = g.gpu.requestAdapter.bind(g.gpu)
  g.gpu.requestAdapter = async (o?: unknown) => {
    const adapter = (await origReq(o)) as {
      requestDevice: (d?: unknown) => Promise<unknown>
    } | null
    if (adapter) {
      const origDev = adapter.requestDevice.bind(adapter)
      adapter.requestDevice = async (d?: unknown) => {
        const dev = (await origDev(d)) as {
          addEventListener?: (t: string, cb: (e: { error?: { message?: string } }) => void) => void
        }
        dev.addEventListener?.('uncapturederror', (e) =>
          w.__xgisGpuErrors!.push(e.error?.message ?? 'unknown'),
        )
        return dev
      }
    }
    return adapter
  }
}

function countRedBlue(buf: Buffer): { red: number; blue: number; total: number } {
  const png = PNG.sync.read(buf)
  const d = png.data
  let red = 0
  let blue = 0
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]!
    const g = d[i + 1]!
    const b = d[i + 2]!
    if (r > 140 && g < 90 && b < 90) red++
    else if (b > 120 && r < 90 && g < 110) blue++
  }
  return { red, blue, total: d.length / 4 }
}

for (const proj of ['flat', 'globe'] as const) {
  test(`background-pattern paints red AND blue pixels (${proj})`, async ({ page }) => {
    test.setTimeout(120_000)
    await page.addInitScript(INSTALL_GPU_ERROR_HOOK)
    await page.setViewportSize({ width: 800, height: 600 })
    const projQ = proj === 'globe' ? '&proj=globe' : ''
    await page.goto(`/demo.html?id=fixture_bg_pattern&sprite=/fixture-sprite${projQ}#2/20/10/0/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
      timeout: 40_000,
    })
    // Let the sprite atlas land + a few frames settle, pumping invalidations.
    await page.waitForTimeout(4000)
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => (window as unknown as Win).__xgisMap?.invalidate?.())
      await page.waitForTimeout(400)
    }
    const shot = await page.locator('canvas').first().screenshot()
    const { red, blue, total } = countRedBlue(shot)
    const gpuErrors = await page.evaluate(
      () => (window as unknown as { __xgisGpuErrors?: string[] }).__xgisGpuErrors ?? [],
    )
    console.log(
      `[bg-pattern:${proj}] red=${red} blue=${blue} of ${total}; gpuErrors=${gpuErrors.length}`,
    )
    expect(gpuErrors, `GPU validation errors: ${gpuErrors.join(' | ')}`).toEqual([])
    // A correctly tiled red/blue pattern paints a substantial share of BOTH.
    expect(red, 'expected RED pattern pixels (>1% of canvas)').toBeGreaterThan(total * 0.01)
    expect(blue, 'expected BLUE pattern pixels (>1% of canvas)').toBeGreaterThan(total * 0.01)
  })
}
