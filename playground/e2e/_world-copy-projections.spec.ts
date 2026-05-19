// Iter 122-123 world-copy verification for cylindrical + pseudocyl
// projections. User reports 2026-05-19:
//   - "어빌리큐 메르키토르 프로젝션에서 날짜변경선 부근 렌더 월드 카피 안됨"
//   - "네츄럴 어스도 월드 렌더 카피 안됨"
//
// Pre-iter-122 worldCopiesFor() returned SINGLE_WORLD for projTypes
// 1/2/6 (Equirect / NE / Oblique-Merc). Iter 122 enabled Oblique-Merc;
// iter 123 enabled Equirect + NE. This spec renders the minimal demo
// at z=0 + a wide viewport for each projection and asserts:
//   1. The rendered canvas has continuous content across the antimeridian
//      (no large dark margin on either side of the camera).
//   2. Two probe columns (left edge + right edge of canvas) both contain
//      non-background pixels — proving world-copies on both sides of
//      the centre world render.

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '__world-copy-projections__')
mkdirSync(OUT, { recursive: true })

const VIEW = { width: 1400, height: 800 }

// Demotiles `minimal` style has a solid-coloured land polygon on a
// blue-ocean background. Anything that is NOT the background colour
// counts as "land or feature drawn here". Background sampled from a
// known-empty corner pixel of each rendered frame at run time.
function isBackground(px: [number, number, number], bg: [number, number, number]): boolean {
  const TOL = 6
  return Math.abs(px[0] - bg[0]) <= TOL
    && Math.abs(px[1] - bg[1]) <= TOL
    && Math.abs(px[2] - bg[2]) <= TOL
}

function getPx(png: PNG, x: number, y: number): [number, number, number] {
  const i = (y * png.width + x) * 4
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!]
}

interface ColumnResult { nonBgCount: number; total: number }

function scanColumn(png: PNG, x: number, bg: [number, number, number]): ColumnResult {
  let nonBg = 0
  for (let y = 0; y < png.height; y++) {
    if (!isBackground(getPx(png, x, y), bg)) nonBg++
  }
  return { nonBgCount: nonBg, total: png.height }
}

const PROJECTIONS: { name: string; expectMultiCopy: boolean }[] = [
  { name: 'mercator', expectMultiCopy: true },          // baseline
  { name: 'equirectangular', expectMultiCopy: true },   // iter 123
  { name: 'natural_earth', expectMultiCopy: true },     // iter 123
  { name: 'oblique_mercator', expectMultiCopy: true },  // iter 122
  { name: 'orthographic', expectMultiCopy: false },     // single-world (disc)
]

for (const proj of PROJECTIONS) {
  // Iter 127: oblique-merc world-copy now enabled via globeVisibleTiles
  // WORLD_COPIES enumeration + project_geom wo-offset for oblique branch.
  test(`world-copy ${proj.name}`, async ({ page }) => {
    test.setTimeout(60_000)
    await page.setViewportSize(VIEW)
    const errors: string[] = []
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(`PAGE_ERROR: ${e.message}`))
    await page.goto(`/demo.html?id=minimal&e2e=1&proj=${proj.name}#0/0/0`, {
      waitUntil: 'domcontentloaded',
    })
    await page.waitForFunction(
      () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      null, { timeout: 20_000 },
    )
    await page.waitForTimeout(2_500)
    await page.evaluate(() => new Promise<void>(r =>
      requestAnimationFrame(() => requestAnimationFrame(() => r()))))

    // Diagnostic: count world-copy tiles that actually reached the renderer.
    const tileCounts = await page.evaluate(() => {
      const m = (window as unknown as { __xgisMap?: {
        tilesSnapshot?: () => Array<{ z: number; x: number; y: number; ox?: number }>
      } }).__xgisMap
      const tiles = m?.tilesSnapshot?.() ?? []
      const wcMap = new Map<number, number>()
      for (const t of tiles) {
        const wc = (t.ox ?? t.x) - t.x
        wcMap.set(wc, (wcMap.get(wc) ?? 0) + 1)
      }
      return {
        total: tiles.length,
        worldCopies: Array.from(wcMap.entries()).map(([wc, n]) => ({ wc, n })),
      }
    })
    // eslint-disable-next-line no-console
    console.log(`[world-copy ${proj.name}] tiles total=${tileCounts.total} `
      + `byWC=${JSON.stringify(tileCounts.worldCopies)}`)

    const buf = await page.locator('#map').screenshot()
    const png = PNG.sync.read(buf)
    writeFileSync(join(OUT, `${proj.name}.png`), buf)

    // Sample background from a corner pixel we expect to be background
    // regardless of projection. For multi-world projections at z=0
    // the corners might also have land — sample from the very top
    // (latitude > +85 = poles, always sky/background even at z=0 for
    // demotiles minimal).
    const bg = getPx(png, 5, 5)

    // Probe left + right edges of canvas. At z=0 with centerLon=0 and
    // a 1400-px viewport, the central world strip occupies the centre
    // ~700 px (one world ≈ 512×2^0 = 512 px at z=0 with TILE_PX=512,
    // but with our dpr-scaled physical canvas it varies). The OUTER
    // pixels on left + right edges should reach world-copies at
    // wo=-1 and wo=+1.
    const w = png.width
    const left = scanColumn(png, Math.floor(w * 0.05), bg)
    const right = scanColumn(png, Math.floor(w * 0.95), bg)
    const centre = scanColumn(png, Math.floor(w * 0.5), bg)

    // eslint-disable-next-line no-console
    console.log(
      `[world-copy ${proj.name}] bg=(${bg.join(',')}) `
      + `centre nonBg=${centre.nonBgCount}/${centre.total} `
      + `left nonBg=${left.nonBgCount}/${left.total} `
      + `right nonBg=${right.nonBgCount}/${right.total}`,
    )
    if (errors.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[world-copy ${proj.name}] ERRORS: ` + errors.slice(0, 5).join(' | '))
    }

    // Centre column must always have content (the primary world).
    expect(centre.nonBgCount).toBeGreaterThan(centre.total * 0.05)

    if (proj.expectMultiCopy) {
      // Multi-copy projections render world-copies into the canvas
      // margins. At z=0 with the camera at lon=0, the left + right
      // edges sit at logical lon ≈ -180..+180-ish but a 1400-px
      // viewport at z=0 (where one world strip ~512 px) leaves
      // ~444 px of "outside the primary world" room on each side
      // that the wo=±1 copies must paint.
      expect(left.nonBgCount).toBeGreaterThan(left.total * 0.02)
      expect(right.nonBgCount).toBeGreaterThan(right.total * 0.02)
    } else {
      // Disc projections — the orthographic globe-disc edges are
      // background. Skip the edge assertion.
    }
  })
}
