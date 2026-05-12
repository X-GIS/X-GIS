// Phase 5f perf comparison: cold-start time to first non-bg pixel
// on styled_world for the legacy GeoJSONRuntimeBackend vs the new
// VirtualPMTilesBackend. Equivalence at the output layer was
// verified in _phase5e-yellow-sea-verify.spec.ts; this captures
// the wall-clock delta so we have a baseline before removing the
// legacy path entirely (Phase 5f-2).

import { test, expect, type Page } from '@playwright/test'

async function measureColdStart(page: Page, query: string): Promise<{ readyMs: number; firstPaintMs: number }> {
  const sep = query.length > 0 ? '&' : ''
  const start = Date.now()
  await page.goto(`/demo.html?id=styled_world${sep}${query.replace(/^\?/, '')}#3/30/120`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  const readyMs = Date.now() - start

  // First-paint heuristic: poll the canvas until non-bg pixel ratio
  // exceeds 5 %. This catches the moment the first batch of GeoJSON
  // tiles have decoded + uploaded.
  const firstPaintStart = Date.now()
  await page.waitForFunction(async () => {
    const c = document.querySelector('canvas') as HTMLCanvasElement | null
    if (!c) return false
    const blob = await new Promise<Blob | null>((res) => c.toBlob(b => res(b)))
    if (!blob) return false
    const buf = await blob.arrayBuffer()
    const img = new Image()
    img.src = URL.createObjectURL(new Blob([buf], { type: 'image/png' }))
    await new Promise<void>((res) => { img.onload = () => res() })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const data = ctx.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i], g = data[i + 1], b = data[i + 2]
      if (r > 50 || g > 50 || b > 50) lit++
    }
    return (lit / (data.length / 4)) > 0.05
  }, null, { timeout: 30_000, polling: 200 })
  const firstPaintMs = Date.now() - firstPaintStart + readyMs

  return { readyMs, firstPaintMs }
}

test('phase5f — cold-start perf: legacy vs default (VirtualPMTilesBackend)', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1000, height: 800 })

  // Three runs each, take the median to absorb warmup noise.
  const legacyRuns: { readyMs: number; firstPaintMs: number }[] = []
  const defaultRuns: { readyMs: number; firstPaintMs: number }[] = []

  for (let i = 0; i < 3; i++) {
    legacyRuns.push(await measureColdStart(page, '?legacy=1'))
    defaultRuns.push(await measureColdStart(page, ''))
  }

  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }

  const legacyMed = {
    readyMs: median(legacyRuns.map(r => r.readyMs)),
    firstPaintMs: median(legacyRuns.map(r => r.firstPaintMs)),
  }
  const defaultMed = {
    readyMs: median(defaultRuns.map(r => r.readyMs)),
    firstPaintMs: median(defaultRuns.map(r => r.firstPaintMs)),
  }

  // eslint-disable-next-line no-console
  console.log('[phase5f perf legacy]', legacyMed, legacyRuns)
  // eslint-disable-next-line no-console
  console.log('[phase5f perf default]', defaultMed, defaultRuns)
  // eslint-disable-next-line no-console
  console.log('[phase5f perf delta]', {
    readyDelta: defaultMed.readyMs - legacyMed.readyMs,
    firstPaintDelta: defaultMed.firstPaintMs - legacyMed.firstPaintMs,
  })

  // No hard threshold yet — just record the baseline. Future runs
  // can tighten when we have variance data.
  expect(defaultMed.firstPaintMs).toBeLessThan(15_000)
  expect(legacyMed.firstPaintMs).toBeLessThan(15_000)
})
