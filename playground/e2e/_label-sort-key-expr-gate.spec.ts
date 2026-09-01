import { test, expect } from '@playwright/test'
import { captureMapFrame } from './helpers/visual'
import { createHash } from 'node:crypto'

// #2166 ACCEPTANCE GATE — a PER-FEATURE `symbol-sort-key` decides which of two
// colliding labels survives.
//
// WHY THIS READS THE SURVIVING TEXT AND NOT A COUNT. Two labels at one anchor
// collide and exactly one is dropped, in EVERY state of the feature — before the
// per-feature channel existed, with it working, and with it wired backwards. A
// `drawn` count is therefore identical in all three and carries no information
// (CLAUDE.md §12: an assertion that does not distinguish the states of the thing
// it tests is worthless however loud it is). What distinguishes them is WHICH
// text survived, which the post-collision draw list already exposes:
// `setLabelDumpFilter('Z')` + `getDumpedLabels()` (text-stage-diagnostics.ts
// captureDump runs on the draws, after collision).
//
// Three arms, and the third is what makes the first two mean anything:
//
//   ranks (ZALPHA 1, ZBRAVO 9)  ⇒ ZALPHA survives   (lower key wins)
//   ranks (ZALPHA 9, ZBRAVO 1)  ⇒ ZBRAVO survives   (the SAME geometry, swapped)
//   frame hashes of the two     ⇒ MUST DIFFER       (pixels really moved)
//
// The swap arm is the non-vacuity rung: a runtime that ignored `rank` entirely
// would produce the same survivor and the same frame in both, which is exactly
// what the pre-#2166 tree does (MEASURED — the converter emitted no
// `label-sort-key` utility at all for an expression, so `sortKey` was undefined
// and the collision pass read `?? 0` for both).
//
// Headless SwiftShader (HEADED=0 XGIS_SOFTWARE_GPU=1), `?forcegl2=1`, backend
// asserted so a silent fallback cannot green it. `?adaptive=0` pins the
// wall-clock-driven quality controller (#2120).

const URL_BASE = '/demo.html?id=fixture_label_sort_key_expr&forcegl2=1&e2e=1&adaptive=0'

interface Arm {
  survivors: string[]
  drawn: number
  submitted: number
  backend: string
  hash: string
}

/** Seed the two colliding labels with the given ranks, settle, and read back
 *  which text survived collision plus a chrome-free frame hash. */
async function arm(
  page: import('@playwright/test').Page,
  alphaRank: number,
  bravoRank: number,
): Promise<Arm> {
  const seeded = await page.evaluate(
    (ranks) => {
      const R = 6378137
      const RAD = Math.PI / 180
      const lon = 2.34
      const lat = 48.85
      const w = window as unknown as {
        __xgisMap: {
          setSourceData(id: string, d: unknown): void
          setLabelDumpFilter(s: string | null): void
          getCamera(): {
            zoom: number
            centerX: number
            centerY: number
            bearing: number
            pitch: number
          }
          markCameraPositioned(): void
          invalidate?(): void
        }
      }
      const m = w.__xgisMap
      // The SAME anchor for both, so they always collide and the survivor is
      // decided by the key and by nothing positional.
      m.setSourceData('pins', {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: { name: 'ZALPHA', rank: ranks.a },
            geometry: { type: 'Point', coordinates: [lon, lat] },
          },
          {
            type: 'Feature',
            properties: { name: 'ZBRAVO', rank: ranks.b },
            geometry: { type: 'Point', coordinates: [lon, lat] },
          },
        ],
      })
      m.setLabelDumpFilter('Z')
      const c = m.getCamera()
      c.zoom = 13
      c.centerX = lon * RAD * R
      c.centerY = Math.log(Math.tan(Math.PI / 4 + (lat * RAD) / 2)) * R
      c.bearing = 0
      c.pitch = 0
      m.markCameraPositioned()
      m.invalidate?.()
      return 2
    },
    { a: alphaRank, b: bravoRank },
  )
  expect(seeded).toBe(2)
  await page.waitForTimeout(6000)
  const png = await captureMapFrame(page)
  const read = await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap: {
        getDumpedLabels(): ReadonlyArray<{ text: string }> | null
        inspectPipeline(): { labels: { drawn: number; submitted: number } }
        ctx?: { rhi?: { backend?: string } }
      }
    }
    const p = w.__xgisMap.inspectPipeline().labels
    return {
      survivors: (w.__xgisMap.getDumpedLabels() ?? []).map((d) => d.text),
      drawn: p.drawn,
      submitted: p.submitted,
      backend: w.__xgisMap.ctx?.rhi?.backend ?? 'unknown',
    }
  })
  return { ...read, hash: createHash('md5').update(png).digest('hex') }
}

test.describe.configure({ mode: 'serial', timeout: 300_000 })

test('#2166 — the per-feature sort key picks the collision survivor, and swapping it swaps them', async ({
  page,
}) => {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))

  await page.setViewportSize({ width: 700, height: 600 })
  await page.goto(URL_BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    { timeout: 30_000 },
  )

  const low = await arm(page, 1, 9)
  const swapped = await arm(page, 9, 1)

  console.log(
    `\n  ranks A=1 B=9: survivors=${JSON.stringify(low.survivors)} drawn=${low.drawn} md5=${low.hash}` +
      `\n  ranks A=9 B=1: survivors=${JSON.stringify(swapped.survivors)} drawn=${swapped.drawn} md5=${swapped.hash}` +
      `\n  backend=${low.backend}\n`,
  )

  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([])
  expect(low.backend).toBe('webgl2')

  // Non-vacuity: both labels were submitted and the collision really did drop
  // one, in BOTH arms. Without this a "survivor" list of length 1 could just be
  // one label never having been dispatched.
  for (const a of [low, swapped]) {
    expect(a.submitted, 'both labels must reach the stage').toBeGreaterThanOrEqual(2)
    expect(a.survivors.length, `expected exactly one survivor, got ${a.survivors.join(',')}`).toBe(
      1,
    )
  }

  // THE CLAIM — asserted on the CAUSE (which text the collision kept) before the
  // EFFECT (the frame), so a red run names the sort key rather than the pixels.
  expect(
    low.survivors[0],
    `rank 1 was on ZALPHA and rank 9 on ZBRAVO, so the ascending sort must keep ZALPHA; ` +
      `kept ${low.survivors[0]} instead — the per-feature key never reached the collision input`,
  ).toBe('ZALPHA')
  expect(
    swapped.survivors[0],
    `the ranks were swapped and the SAME two labels sit at the SAME anchor, so the survivor ` +
      `must swap to ZBRAVO; kept ${swapped.survivors[0]} — the key is being ignored, or ` +
      `flattened to one constant for the whole layer`,
  ).toBe('ZBRAVO')

  // THE EFFECT — pixels genuinely move. On the pre-#2166 tree these two frames
  // are the same bytes, because `rank` reaches nothing.
  expect(
    swapped.hash,
    `the two arms rendered byte-identical frames (${low.hash}) — a per-feature key that ` +
      `changes the survivor must change the frame`,
  ).not.toBe(low.hash)
})
