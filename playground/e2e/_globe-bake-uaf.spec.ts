// Globe vector-drape BAKE use-after-destroy gate (task #58 / PR #1147).
//
// Reproduces the USER's real scenario: OpenFreeMap Bright (multi-slice vector
// tiles) on the globe, low pitch, ZOOM IN so child tiles bake and the baked
// cache churns/evicts. Pre-fix this fired:
//   [X-GIS frame-validation] Destroyed texture [Texture "vtr-bake-<slice>::<tile>"]
//   used in a submit. While calling Queue.Submit(CommandBuffer).
// FIX (vector-drape-renderer.ts): retire bake-texture destroys into _retiredBakes,
// freed on the NEXT beginFrame — the post-submit safe window.
//
// Headed real GPU + network (OFM live import; bake is WebGPU-only).

import { test, expect } from '@playwright/test'

type Win = Window & {
  __xgisReady?: boolean
  __xgisActiveBackend?: string
  __xgisMap?: { invalidate?: () => void; ctx?: { rhi?: { backend?: string } } }
}

function isBakeUAF(text: string): boolean {
  const t = text.toLowerCase()
  return (
    t.includes('used in a submit') && (t.includes('vtr-bake') || t.includes('destroyed texture'))
  )
}

test('globe drape bake (OFM): no "Destroyed texture used in a submit" on zoom-in', async ({
  page,
}) => {
  test.setTimeout(180_000)

  const uaf: string[] = []
  page.on('pageerror', (e) => {
    if (isBakeUAF(e.message)) uaf.push('[pageerror] ' + e.message)
  })
  page.on('console', (m) => {
    if (m.type() === 'error' && isBakeUAF(m.text())) uaf.push(m.text())
  })

  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/demo.html?id=openfreemap_bright&proj=globe#5/37.5/127/55/0', {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(() => (window as unknown as Win).__xgisReady === true, {
    timeout: 40_000,
  })
  const backend = await page.evaluate(() => {
    const w = window as unknown as Win
    return w.__xgisMap?.ctx?.rhi?.backend ?? w.__xgisActiveBackend ?? 'unknown'
  })
  test.skip(backend !== 'webgpu', `bake UAF gate needs a headed WebGPU adapter (got ${backend})`)

  await page.waitForTimeout(3000) // warm the OFM tile stream

  // Zoom IN through levels at Seoul (low pitch): child tiles bake, the baked
  // cache churns + evicts off-screen parents — the reported destroy-while-in-
  // flight window. Out/in cycles re-exercise eviction of just-drawn tiles.
  const HASHES = [
    '#5/37.5/127/55/0',
    '#6/37.5/127/55/0',
    '#7/37.5/127/55/0',
    '#8/37.5/127/55/0',
    '#9/37.5/127/55/0',
    '#10/37.5/127/55/0',
    '#11/37.5/127/55/0',
    '#8/37.5/127/55/0',
    '#11/37.5/127/55/0',
    '#6/37.5/127/55/0',
  ] as const
  for (const h of HASHES) {
    await page.evaluate((x) => {
      window.location.hash = x
    }, h)
    await page.evaluate(() => (window as unknown as Win).__xgisMap?.invalidate?.())
    await page.waitForTimeout(1600)
  }

  if (uaf.length > 0) {
    console.log(`[ofm-bake-uaf] ${uaf.length} bake use-after-destroy error(s):`)
    for (const e of uaf.slice(0, 5)) console.log('  ' + e)
  }

  expect(
    uaf,
    'a baked drape texture was destroyed while still referenced by an in-flight submit ' +
      '(use-after-destroy) during OFM globe zoom-in',
  ).toEqual([])
})
