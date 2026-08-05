// ═══ §5 render gate for the stdlib self-hosting proof (#1540) ═══
//
// The epic's acceptance test, rendered rather than asserted: a symbolizer
// authored entirely in `.xgis` must reach the same pixels as the engine's
// built-in, and a symbolizer with NO built-in twin must render at all.
//
// Three fixtures, one point each at (0,0), same colour and size:
//   fixture_stdlib_star   — `shapes.star` from /stdlib/shapes.xgis, imported
//                           over HTTP by the ordinary resolver
//   fixture_builtin_star  — the engine's `shape-star`
//   fixture_stdlib_star7  — 7-pointed, exists only in the imported module
//
// PARITY is the claim: stdlib ≡ built-in, hash-equal. The stdlib module
// reproduces `starPath(5, 1.0, 0.38)` coordinate-for-coordinate, and the two
// reach the rasterizer through DIFFERENT registration paths (user symbol vs
// built-in table), so equality is not a tautology.
//
// The star7 comparison is what keeps the gate non-vacuous. Hash equality alone
// would also pass in a world where the shape argument is ignored entirely and
// every fixture draws the same default glyph — the exact "assertion that fails
// either way" trap. Asserting star7 renders DIFFERENTLY severs that: it can
// only differ if the shape name actually selected geometry.
//
// Backend PINNED to WebGL2 and asserted via the live #backend-tag (a silent
// fallback cannot green this); `&adaptive=0` pins the adaptive quality ladder
// off — see _stage-block-parity.spec.ts's header for why its settle race would
// otherwise make captures nondeterministic. The point renderer is
// backend-neutral RHI, so this runs headlessly on SwiftShader.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

const ART = join(process.cwd(), 'test-results', 'stdlib-shape-parity')

// Scene-region crop — excludes the demo chrome (description strip, log panel,
// toolbar), which differs per fixture by design and is not render output.
const X0 = 0
const X1 = 840
const Y0 = 50
const Y1 = 620

interface Stats {
  png: Buffer
  hash: string
  nonBg: number
}

function statsOf(png: Buffer): Stats {
  const img = PNG.sync.read(png)
  const d = img.data
  const x1 = Math.min(img.width, X1)
  const y1 = Math.min(img.height, Y1)
  let h = 5381
  let nonBg = 0
  const i0 = (Y0 * img.width + X0) * 4
  const [r0, g0, b0] = [d[i0]!, d[i0 + 1]!, d[i0 + 2]!]
  for (let y = Y0; y < y1; y++) {
    for (let x = X0; x < x1; x++) {
      const i = (y * img.width + x) * 4
      h = ((h * 33) ^ d[i]!) | 0
      h = ((h * 33) ^ d[i + 1]!) | 0
      h = ((h * 33) ^ d[i + 2]!) | 0
      h = ((h * 33) ^ d[i + 3]!) | 0
      if (
        Math.abs(d[i]! - r0) > 8 ||
        Math.abs(d[i + 1]! - g0) > 8 ||
        Math.abs(d[i + 2]! - b0) > 8
      ) {
        nonBg++
      }
    }
  }
  return { png, hash: (h >>> 0).toString(36), nonBg }
}

/** Capture a demo once it has settled — two consecutive frames 400ms apart
 *  hashing identically. The engine renders on demand, so a fixed wait is not a
 *  settle criterion (diagnosed on the #1535 gate). */
async function captureScene(page: import('@playwright/test').Page, id: string): Promise<Stats> {
  await page.goto(`/demo.html?id=${id}&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0`, {
    waitUntil: 'domcontentloaded',
  })
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })
  let s = statsOf(await captureCanvas(page, { readyTimeoutMs: 30_000 }))
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400)
    const next = statsOf(await captureCanvas(page, { readyTimeoutMs: 30_000 }))
    if (next.hash === s.hash) {
      s = next
      break
    }
    s = next
  }
  mkdirSync(ART, { recursive: true })
  writeFileSync(join(ART, `${id}.png`), s.png)
  return s
}

test.describe.configure({ timeout: 180_000 })

test('a .xgis-authored symbolizer renders identically to the built-in (webgl2)', async ({
  page,
}) => {
  const stdlib = await captureScene(page, 'fixture_stdlib_star')
  const builtin = await captureScene(page, 'fixture_builtin_star')
  const star7 = await captureScene(page, 'fixture_stdlib_star7')

  // Non-vacuous floor: a blank canvas must not be able to satisfy parity. The
  // glyph is size-80 at canvas centre, far more than 500 non-background px.
  expect(stdlib.nonBg, 'the stdlib star rendered blank — did the import resolve?').toBeGreaterThan(
    500,
  )
  expect(builtin.nonBg, 'the built-in star rendered blank').toBeGreaterThan(500)
  expect(star7.nonBg, 'the no-twin star7 rendered blank').toBeGreaterThan(500)

  // The other half of non-vacuity: if the shape name were ignored and every
  // fixture drew one default glyph, the parity assertion below would ALSO pass.
  // star7 differing is what makes parity mean "the same shape" rather than
  // "shapes do not matter here".
  expect(
    star7.hash,
    'star7 hashed the same as the 5-pointed star — the shape name is not ' +
      'selecting geometry, so the parity assertion below proves nothing',
  ).not.toBe(stdlib.hash)

  // The verdict.
  expect(
    stdlib.hash,
    `stdlib star ≠ built-in star (nonBg stdlib=${stdlib.nonBg} builtin=${builtin.nonBg}). ` +
      'The stdlib module reproduces starPath(5, 1.0, 0.38) exactly, so a mismatch ' +
      'means the user-symbol path diverges from the built-in registration path.',
  ).toBe(builtin.hash)

  console.log(
    `[stdlib-shape-parity] stdlib=${stdlib.hash} builtin=${builtin.hash} ` +
      `star7=${star7.hash} nonBg=${stdlib.nonBg}/${builtin.nonBg}/${star7.nonBg}`,
  )
})
