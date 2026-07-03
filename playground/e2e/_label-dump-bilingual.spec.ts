// iter-330 — LIVE GPU capture of the user-reported bilingual label bugs:
//   (1) OFM Bright z=6 "South Korea\n대한민국" — line-2 overlaps line-1.
//   (2) #10.87/37.54894/126.92138 — review all labels.
// Uses the iter-327/329 live dump (map.setLabelDumpFilter +
// getDumpedLabels) to read the ACTUAL per-glyph (x,y,bearingY,height,rfs)
// the renderer received. prepare() composition is proven correct in unit
// tests; this confirms whether the on-screen overlap is CPU (prepare with
// real PBF metrics) or GPU.

import { test, expect } from '@playwright/test'

interface DumpGlyph {
  cp: number
  x: number
  y: number
  bearingY: number
  height: number
  rfs: number
}
interface DumpLabel {
  text: string
  anchorX: number
  anchorY: number
  glyphs: DumpGlyph[]
}

async function loadAndDump(
  page: import('@playwright/test').Page,
  hash: string,
  filter: string,
): Promise<DumpLabel[]> {
  await page.setViewportSize({ width: 1280, height: 720 })
  // compare.html live-converts the network OFM Bright style → labels +
  // glyphsUrl (PBF). The pre-baked demo .xgis emits no labels.
  await page.goto(`/compare.html?style=openfreemap-bright${hash}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  // Poll until labels actually dispatch (tiles + glyph PBF must arrive).
  await page
    .waitForFunction(
      () => {
        const m = (
          window as unknown as {
            __xgisMap?: { getLastLabelCounts?: () => { drawn: number } | null }
          }
        ).__xgisMap
        const c = m?.getLastLabelCounts?.()
        return !!c && c.drawn > 0
      },
      null,
      { timeout: 40_000 },
    )
    .catch(() => {})
  await page.evaluate((f) => {
    const m = (
      window as unknown as {
        __xgisMap?: { setLabelDumpFilter?: (s: string) => void; invalidate?: () => void }
      }
    ).__xgisMap
    m?.setLabelDumpFilter?.(f)
    m?.invalidate?.()
  }, filter)
  await page.waitForTimeout(1_500)
  return (await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getDumpedLabels?: () => DumpLabel[] } })
      .__xgisMap
    return m?.getDumpedLabels?.() ?? []
  })) as DumpLabel[]
}

/** Load high, step-zoom OUT to target (exercises layout cache across
 *  sizes — the user's actual path), then dump. */
async function loadAndDumpZoomOut(
  page: import('@playwright/test').Page,
  lat: number,
  lon: number,
  fromZ: number,
  toZ: number,
  filter: string,
): Promise<DumpLabel[]> {
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto(`/compare.html?style=openfreemap-bright#${fromZ}/${lat}/${lon}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => !!(window as unknown as { __xgisMap?: unknown }).__xgisMap,
    null,
    { timeout: 30_000 },
  )
  await page.waitForTimeout(6_000)
  // Step zoom out, settling each step so prepare runs at every size.
  for (let z = fromZ - 0.5; z >= toZ; z -= 0.5) {
    await page.evaluate((zz) => {
      const m = (
        window as unknown as {
          __xgisMap?: {
            setZoom?: (z: number) => void
            camera?: { zoom: number }
            invalidate?: () => void
          }
        }
      ).__xgisMap
      if (m?.setZoom) m.setZoom(zz)
      else if (m?.camera) m.camera.zoom = zz
      m?.invalidate?.()
    }, z)
    await page.waitForTimeout(400)
  }
  await page.waitForTimeout(1_500)
  await page.evaluate((f) => {
    const m = (
      window as unknown as {
        __xgisMap?: { setLabelDumpFilter?: (s: string) => void; invalidate?: () => void }
      }
    ).__xgisMap
    m?.setLabelDumpFilter?.(f)
    m?.invalidate?.()
  }, filter)
  await page.waitForTimeout(1_200)
  return (await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: { getDumpedLabels?: () => DumpLabel[] } })
      .__xgisMap
    return m?.getDumpedLabels?.() ?? []
  })) as DumpLabel[]
}

/** Pretty-print a label's per-glyph placement grouped by line (y). */
function describe(label: DumpLabel): string {
  const lines = label.glyphs
    .filter((g) => g.cp !== 10)
    .map(
      (g) =>
        `${String.fromCodePoint(g.cp)} x=${g.x.toFixed(1)} y=${g.y.toFixed(1)} bY=${g.bearingY.toFixed(1)} h=${g.height} rfs=${g.rfs}`,
    )
  return (
    `"${label.text}" @(${label.anchorX.toFixed(0)},${label.anchorY.toFixed(0)})\n  ` +
    lines.join('\n  ')
  )
}

test.describe('iter-330 bilingual label live dump', () => {
  test('zoom-OUT to 6 (user path): South Korea 대한민국 after transition', async ({ page }) => {
    test.setTimeout(90_000)
    // User repro: load high, ZOOM OUT to 6 — the overlap appears after
    // the transition, not on fresh load. Load at 10, step zoom down so
    // the layout cache is exercised at each intermediate size.
    const labels = await loadAndDumpZoomOut(page, 36.5, 127.8, 10, 6, '대한민국')
    console.log(`\n=== z6 dump: ${labels.length} label(s) containing 대한민국 ===`)
    for (const l of labels) console.log(describe(l))
    // Pixel truth: crop around the label anchor so we can SEE whether the
    // rendered glyphs overlap despite correct glyphOffsets (= GPU bug) or
    // match the dump (= transient / env-specific).
    if (labels[0]) {
      const a = labels[0]
      const x = Math.max(0, Math.round(a.anchorX - 120))
      const y = Math.max(0, Math.round(a.anchorY - 80))
      await page.screenshot({
        path: 'e2e/__label-dump__/south-korea-z6.png',
        clip: { x, y, width: 280, height: 160 },
      })
      console.log(`SHOT south-korea-z6.png clip(${x},${y},280,160)`)
    }
    // Contract: every CJK (대한민국) glyph baseline strictly below every
    // Latin glyph. If violated → the on-screen overlap is in the data
    // the renderer received (CPU), not the GPU.
    for (const l of labels) {
      const cjk = l.glyphs.filter((g) => g.cp >= 0xac00 && g.cp <= 0xd7a3).map((g) => g.y)
      const lat = l.glyphs.filter((g) => g.cp > 32 && g.cp < 0x3000 && g.cp !== 10).map((g) => g.y)
      if (cjk.length && lat.length) {
        console.log(
          `  → maxLatinY=${Math.max(...lat).toFixed(1)} minCjkY=${Math.min(...cjk).toFixed(1)} overlap=${Math.min(...cjk) <= Math.max(...lat)}`,
        )
      }
    }
    expect(labels.length).toBeGreaterThanOrEqual(0) // diagnostic — never fails the run
  })

  test('z=10.87 Seoul — review all labels', async ({ page }) => {
    test.setTimeout(60_000)
    const labels = await loadAndDump(page, '#10.87/37.54894/126.92138', '')
    console.log(`\n=== z10.87 dump: ${labels.length} total label(s) ===`)
    // Flag any multi-line label whose lines vertically overlap or whose
    // glyphs aren't x-monotonic within a line.
    let flagged = 0
    for (const l of labels) {
      const ys = [...new Set(l.glyphs.filter((g) => g.cp !== 10).map((g) => Math.round(g.y)))].sort(
        (a, b) => a - b,
      )
      if (ys.length < 2) continue // single line
      // Group glyphs by line-y, check intra-line x monotonic.
      let bad = false
      for (const ly of ys) {
        const xs = l.glyphs.filter((g) => g.cp !== 10 && Math.round(g.y) === ly).map((g) => g.x)
        for (let i = 1; i < xs.length; i++) if (xs[i]! <= xs[i - 1]!) bad = true
      }
      if (bad) {
        flagged++
        console.log(`FLAG ${describe(l)}`)
      }
    }
    console.log(`\n=== ${flagged} multi-line label(s) with non-monotonic x ===`)
    expect(labels.length).toBeGreaterThanOrEqual(0)
  })
})
