import { test, expect } from '@playwright/test'

// Symbol-fade §5 gate — fade-OUT during CAMERA MOTION (the "labels blink on
// zoom" fix). A label that leaves the placement set while the camera moves used
// to POP: its holdover clone bakes absolute screen px, so TextStage suppressed
// it under motion (holdoverOk === false) while fade-IN kept working — an
// asymmetric blink. The fix reprojects the frozen clone onto the current frame
// via the #1177 replay similarity (holdover-reproject.ts), so it fades IN PLACE.
//
// This drives the REAL integration end-to-end (label-pass builds the
// motionHoldover ctx → TextStage/IconStage reproject → the renderer draws the
// fading holdover): boot two shields, then PAN so one leaves the viewport. While
// the camera moves, a fading-out holdover (0 < alpha < 1) must be DRAWN — a
// state the pre-fix code could not produce under motion (holdover suppressed →
// dropped label absent → zero fading slices mid-pan). The fixture is the local
// symbol/icon atlas under forced WebGL2 + headless SwiftShader (no network),
// mirroring _label-fade-gate.spec.ts.

interface FadeSnapshot {
  slices: number
  textAlphas: number[]
  iconAlphas: number[]
  centerX: number
}

async function boot(page: import('@playwright/test').Page, fade: number): Promise<void> {
  await page.setViewportSize({ width: 800, height: 600 })
  await page.goto(
    `/demo.html?id=fixture_symbol_icon_textfit&sprite=/fixture-sprite&forcegl2=1&preserve=1&fade=${fade}`,
    { waitUntil: 'domcontentloaded' },
  )
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
}

function readFade(page: import('@playwright/test').Page): Promise<FadeSnapshot> {
  return page.evaluate(async () => {
    const w = window as unknown as {
      __xgisMap?: {
        invalidate?: () => void
        getCamera?: () => { centerX: number }
        textStage?: {
          renderer?: { drawSlices?: { fade?: { ref: { a: number } } }[] }
        } | null
        iconStage?: { renderer?: { fadePatches?: { ref: { a: number } }[] } } | null
      }
    }
    w.__xgisMap?.invalidate?.()
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))
    const m = w.__xgisMap
    const ds = m?.textStage?.renderer?.drawSlices ?? []
    const patches = m?.iconStage?.renderer?.fadePatches ?? []
    return {
      slices: ds.length,
      textAlphas: ds.filter((s) => s.fade !== undefined).map((s) => s.fade!.ref.a),
      iconAlphas: patches.map((p) => p.ref.a),
      centerX: m?.getCamera?.().centerX ?? 0,
    }
  })
}

function panCenterX(page: import('@playwright/test').Page, dx: number): Promise<void> {
  return page.evaluate((d) => {
    const m = (window as unknown as { __xgisMap?: { getCamera: () => { centerX: number } } })
      .__xgisMap!
    m.getCamera().centerX += d
  }, dx)
}

async function converge(
  page: import('@playwright/test').Page,
  timeoutMs: number,
): Promise<FadeSnapshot> {
  const deadline = Date.now() + timeoutMs
  let prev = await readFade(page)
  for (;;) {
    await page.waitForTimeout(400)
    const cur = await readFade(page)
    const allUp = cur.textAlphas.length >= 2 && cur.textAlphas.every((a) => a > 0.98)
    if (allUp && cur.slices === prev.slices) return cur
    if (Date.now() > deadline) return cur
    prev = cur
  }
}

test('symbol fade — a dropped label fades OUT (reprojected) during a pan instead of popping', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text()))
      errors.push(m.text().slice(0, 300))
  })

  // Long fade so a fade-out is caught mid-ramp across the pan's frames.
  await boot(page, 12_000)
  const settled = await converge(page, 90_000)
  expect(
    settled.textAlphas.length,
    'both shields placed + faded in before the pan',
  ).toBeGreaterThanOrEqual(2)
  expect(
    settled.textAlphas.every((a) => a > 0.9),
    'both shields solid before the pan',
  ).toBe(true)

  // Pan the centre rightward in steps so the LEFT shield exits the viewport.
  // Each step is a real camera move (holdoverOk === false) → the drop rides the
  // motion-holdover reproject path. Step ~90 merc-px worth per frame (mpp scales
  // with zoom; the fixture boots wide so a few 2e6 m steps clear a hemisphere).
  let sawFadingText = false
  let sawFadingIcon = false
  let minText = 1
  let droppedToOne = false
  const STEP = 1_500_000 // merc metres per pan frame
  for (let i = 0; i < 24 && !(sawFadingText && droppedToOne); i++) {
    await panCenterX(page, STEP)
    const f = await readFade(page)
    for (const a of f.textAlphas) {
      if (a > 0.02 && a < 0.95) sawFadingText = true
      minText = Math.min(minText, a)
    }
    for (const a of f.iconAlphas) if (a > 0.02 && a < 0.95) sawFadingIcon = true
    if (f.textAlphas.filter((a) => a > 0.9).length <= 1) droppedToOne = true
  }

  expect(errors, 'no page errors during the pan').toEqual([])
  // THE FIX: a fading-out label was DRAWN while the camera moved. Pre-fix the
  // holdover was suppressed under motion, so a dropped label produced ZERO
  // sub-1 fading slices mid-pan — this assertion is exactly what could not hold.
  expect(
    sawFadingText,
    `a text holdover faded out mid-pan (min alpha seen ${minText.toFixed(3)})`,
  ).toBe(true)
  // The paired badge fades WITH its text (icon reproject), not a frame behind.
  expect(sawFadingIcon, 'the paired icon holdover also faded out mid-pan').toBe(true)
})
