// ═══ #2024 — globe drape virtual-overzoom sharpness gate ═══
//
// Past the source maxLevel the tile selection re-renders maxLevel tiles
// camera-magnified. The DIRECT vector path magnifies geometry (sharp at any
// depth — why mercator never blurs); the drape used to magnify a fixed 512px
// BAKE, going soft by 2^(zoom − maxLevel) — the "globe goes low-res past the
// source max" report. The fix drapes VIRTUAL sub-tiles, each a 512px windowed
// bake of its maxLevel ancestor, restoring native texel density.
//
// This gate drives a fill-only countries.geojson layer (source maxLevel 14)
// on the globe at z15.3 — PAST the source max — over the Benghazi coast (an
// east-west land-south coastline, so the coast edge stays in frame under the
// per-GPU vs_tile transcendental displacement, #2025: ~0.5 km north on
// SwiftShader, metres on hardware) and asserts STRUCTURE, not a pixel count
// (§12: counts pass on broken images):
//
//   (a) the fill PAINTS at overzoom (was fully blank at z16+ pre-fix), with
//       the coast edge in frame (green fraction strictly inside (0.02, 0.98));
//   (b) the MECHANISM is wired: virtual-coord bake keys exist in the drape
//       cache (cut the dispatch and this reddens on any GPU — §12 cause-first);
//   (c) the coast edge is NATIVE-SHARP: ≤20% of edge rows carry a ≥2px soft
//       band. Dense 202-row profile measures 0.119 (windowed) vs 0.312
//       (parent-magnified, Δz=1.3; the gap widens as 2^Δz at deeper zooms).
//
// The window math itself is pinned exactly in vector-drape-overzoom.test.ts;
// this spec proves the wiring end-to-end on the real GPU path.

import { test, expect } from '@playwright/test'

const STYLE = [
  'xgis 1',
  '',
  'source world {',
  '  type: geojson',
  '  url: "countries.geojson"',
  '}',
  '',
  'layer land {',
  '  source: world',
  '  | fill-emerald-400',
  '}',
].join('\n')

test('#2024 — globe fill drape stays native-sharp past the source maxLevel', async ({ page }) => {
  test.setTimeout(120_000)
  await page.setViewportSize({ width: 1024, height: 720 })

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 200)))

  await page.goto('/demo.html?id=dark&proj=globe', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 30_000 },
  )
  await page.evaluate(async (style) => {
    const w = window as unknown as {
      __xgisRunSource?: (s: string) => Promise<unknown>
      __xgisMap?: { setCenter: (lon: number, lat: number) => void; setZoom: (z: number) => void }
    }
    await w.__xgisRunSource!(style)
    w.__xgisMap!.setCenter(20.07, 32.17)
    w.__xgisMap!.setZoom(15.3)
  }, STYLE)
  // Settle: virtual bakes appear once every maxLevel ancestor is resident
  // (the atomic parent→virtual switch), a few frames after the fetches land.
  await page.waitForTimeout(6000)

  const png = await page.locator('#map').screenshot({ type: 'png' })
  const m = await page.evaluate(async (bytes) => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    await new Promise<void>((res, rej) => {
      img.onload = () => res()
      img.onerror = () => rej(new Error('img'))
      img.src = url
    })
    const off = new OffscreenCanvas(img.width, img.height)
    const ctx = off.getContext('2d')!
    ctx.drawImage(img, 0, 0)
    const w = img.width,
      h = img.height
    const d = ctx.getImageData(0, 0, w, h).data
    const isGreen = (x: number, y: number): boolean => {
      const i = (y * w + x) * 4
      return d[i + 1]! > 120 && d[i + 1]! > d[i]! + 30 && d[i + 1]! > d[i + 2]! + 10
    }
    let green = 0
    let n = 0
    for (let y = 40; y < h - 40; y++) {
      for (let x = 0; x < w; x++) {
        n++
        if (isGreen(x, y)) green++
      }
    }
    // Per-row soft-band width across the black→green coast transition: the
    // count of intermediate-green pixels (20 < G < 120) hugging the first
    // green pixel. A native-density bake gives ≈1 px; the parent-magnified
    // bake gives ≈2^(zoom − maxLevel) px.
    const widths: number[] = []
    for (let y = 120; y < h - 120; y += 2) {
      let firstGreen = -1
      for (let x = 2; x < w - 2; x++) {
        if (isGreen(x, y)) {
          firstGreen = x
          break
        }
      }
      if (firstGreen < 4) continue
      let soft = 0
      for (let x = firstGreen - 1; x >= 0; x--) {
        const i = (y * w + x) * 4
        const g = d[i + 1]!
        if (g > 20 && g < 120) soft++
        else break
      }
      widths.push(soft)
    }
    // Robust discriminator: on a diagonal edge the per-row soft band alternates
    // with the stair phase, so a bare median rides the 1↔2 boundary. The
    // FRACTION of rows whose band is ≥ 2 px separates cleanly: ≈0.1 for the
    // native-density windowed bake, ≈0.9 for the parent-magnified bake at this
    // Δz (and → 1.0 at deeper Δz).
    const wide = widths.filter((v) => v >= 2).length
    const fracWide = widths.length > 0 ? wide / widths.length : 1
    URL.revokeObjectURL(url)
    return { greenFrac: green / n, fracWide, rows: widths.length }
  }, Array.from(png))

  // CAUSE assertion (§12 — assert the mechanism before its visual effect): the
  // windowed path is ACTIVE iff the drape's bake cache holds virtual-coord keys
  // (`slice:parentKey:z/x/y`). With the dispatch cut, only plain parent keys
  // exist and this reddens unambiguously on any GPU.
  const virtualBakes = await page.evaluate(() => {
    const m = (window as unknown as { __xgisMap?: Record<string, unknown> }).__xgisMap
    const vt = m?.['vtSources'] as Map<string, { renderer: Record<string, unknown> }> | undefined
    let count = 0
    if (vt) {
      for (const [, v] of vt) {
        const drape = v.renderer['_drape'] as { baked?: Map<string, unknown> } | undefined
        const baked = drape?.baked
        if (!baked) continue
        for (const k of baked.keys()) if (/:\d+\/\d+\/\d+$/.test(k)) count++
      }
    }
    return count
  })

  expect(errors, `pageerrors: ${errors.join(' | ')}`).toHaveLength(0)
  expect(
    virtualBakes,
    'no virtual windowed bakes in the drape cache — the #2024 overzoom dispatch did not engage',
  ).toBeGreaterThan(0)
  // (a) paints at overzoom, coast in frame. Pre-fix the drape drew NOTHING
  // past the source max (greenFrac 0 at z16+) or, at this shallower Δz, only
  // the magnified parent bake.
  expect(m.greenFrac, 'coast edge must be in frame with land painted').toBeGreaterThan(0.02)
  expect(m.greenFrac, 'coast edge must be in frame (not all-land)').toBeLessThan(0.98)
  expect(m.rows, 'edge profile must sample enough rows').toBeGreaterThan(50)
  // (b) native sharpness — the pre-fix parent-magnified path measures ≈0.9 here.
  expect(
    m.fracWide,
    `fraction of coast rows with a ≥2px soft band = ${m.fracWide.toFixed(3)} — the parent-magnified bake (pre-#2024) measures 0.31 here (dense 202-row profile), the windowed bake 0.12`,
  ).toBeLessThanOrEqual(0.2)
})
