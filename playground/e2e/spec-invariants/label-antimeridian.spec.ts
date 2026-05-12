// ═══════════════════════════════════════════════════════════════════
// Spec invariants — label anchor positions across the antimeridian
// ═══════════════════════════════════════════════════════════════════
//
// Pins the fix from commit 7df23d0. Before the fix, OFM Bright at
// zoom=0.5 / lon=175 (camera near antimeridian) clustered every
// Western-Hemisphere country label onto a single column at the
// antimeridian seam — Canada, UK, Portugal, Mexico, Brazil etc. all
// shared the same anchorScreenX. Root cause was a feedback between
// the per-tile point dedup (forEachLabelFeature) emitting
// antimeridian-wrap copies as label anchors and the cross-tile name
// dedup in map.ts latching onto those wrap copies.
//
// Test strategy: load OFM Bright via the live converter (so the test
// also covers convertMapboxStyle), aim the camera at the antimeridian,
// and assert that no two distinct-feature labels share the same
// (rounded) screen X coordinate beyond a reasonable cluster
// threshold. The world is sparse enough at z=0.5 that genuine vertical
// alignment is unlikely; clustering > 3 features on one column is
// evidence of the regression.

import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { convertMapboxStyle } from '@xgis/compiler'

const HERE = dirname(fileURLToPath(import.meta.url))
const OFM_BRIGHT = JSON.parse(readFileSync(
  join(HERE, '..', '..', '..', 'compiler', 'src', '__tests__', 'fixtures', 'openfreemap-bright.json'),
  'utf8',
))

interface LabelTrace {
  layerName: string
  text: string
  anchorScreenX: number
  anchorScreenY: number
  placement: string
}

test('OFM Bright @ zoom=0.5/lon=175 — labels do not cluster at antimeridian', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 900, height: 1400 })

  // Convert + encode for the __import path (sessionStorage / hash channel).
  const xgisSource = convertMapboxStyle(OFM_BRIGHT, { warn: () => {} })
  const b64 = Buffer.from(xgisSource, 'utf8').toString('base64')

  await page.goto(`/demo.html?id=__import&label=OFM+Bright#src=${b64}`, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null, { timeout: 30_000 },
  )
  // Now position the camera at the antimeridian repro location.
  await page.evaluate(() => { location.hash = '#0.5/24.58/175.54' })
  await page.waitForTimeout(15_000)

  const trace = await page.evaluate(async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const map = (window as any).__xgisMap
    if (!map?.captureNextFrameTrace) return null
    const c = map.getCamera()
    c.zoom = c.zoom + 0.0001
    map.invalidate?.()
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    return await map.captureNextFrameTrace()
  })
  expect(trace, 'expected trace from __xgisMap.captureNextFrameTrace()').toBeTruthy()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tr = trace as any
  const labels = (tr.labels ?? []) as LabelTrace[]
  const viewportW = tr.viewportPx?.[0] ?? 900
  const viewportH = tr.viewportPx?.[1] ?? 1400
  expect(labels.length, 'OFM Bright at zoom=0.5 should submit labels').toBeGreaterThan(30)

  // Filter to on-screen labels. The trace records every addLabel
  // submission including off-canvas anchors (collision-checked later);
  // only ON-screen clusters are visible bugs.
  const onScreen = labels.filter(l =>
    l.anchorScreenX >= 0 && l.anchorScreenX <= viewportW
    && l.anchorScreenY >= 0 && l.anchorScreenY <= viewportH,
  )

  // Histogram labels by rounded x. A regression would pile dozens of
  // distinct labels into one 5-px column at the antimeridian seam.
  // Use a 5-px bucket — wide enough to absorb sub-pixel jitter from
  // glyph metric rounding, narrow enough that real placements at
  // different lons fall into separate buckets.
  const BUCKET_PX = 5
  const histogram = new Map<number, Set<string>>()
  for (const l of onScreen) {
    const bucket = Math.round(l.anchorScreenX / BUCKET_PX) * BUCKET_PX
    let set = histogram.get(bucket)
    if (!set) { set = new Set(); histogram.set(bucket, set) }
    set.add(l.text)
  }
  // Find the largest bucket and dump it for diagnosis.
  let worstBucket = -Infinity
  let worstSize = 0
  let worstSamples: string[] = []
  for (const [bucket, set] of histogram) {
    if (set.size > worstSize) {
      worstSize = set.size
      worstBucket = bucket
      worstSamples = [...set].slice(0, 10)
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[antimeridian-cluster] worst bucket x≈${worstBucket}px holds ${worstSize} distinct labels`)
  if (worstSize > 3) {
    // eslint-disable-next-line no-console
    console.log(`[antimeridian-cluster] sample: ${worstSamples.join(' / ')}`)
  }
  // 3 distinct labels in a single 5-px column is the soft ceiling. The
  // antimeridian regression piled 10+ on one column; under a healthy
  // pipeline you'd see at most 1-2 even for stacked ocean labels.
  expect(worstSize,
    `Too many distinct labels share screen x≈${worstBucket}px ` +
    `(>${worstSize}). Likely regression of the antimeridian wrap-copy ` +
    `fix in vector-tile-renderer.ts forEachLabelFeature (commit 7df23d0).`,
  ).toBeLessThanOrEqual(3)
})
