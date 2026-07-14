// ═══ Twin-parity pixel ratchet — chain (?rhichain=1) vs twin, WebGL2 (#1046 F3-F4) ═══
//
// Captures the unified WebGL2 chain (`?rhichain=1`) and the forced-WebGL2 twin at
// IDENTICAL cameras for the doc §3-F3 fixture matrix, then measures DC (differing-
// pixel count) between them. The high-water file (map/src/twin-parity-highwater.json)
// holds a SHRINK-ONLY per-fixture DC ceiling; this spec is the live half of the
// ratchet (doc §6.3) — it enforces `measured DC <= high-water` and drives DC toward
// zero (zero on every fixture is F4's flip precondition). Both PNGs + a dc.json are
// written to test-results so the orchestrator can run the mandatory directional
// pixel-diff (.claude/skills/compare-parity-pixeldiff/compare-diff.py) for the
// authoritative DC + the 16-split read (CLAUDE.md §5).
//
// SEEDING: every high-water entry starts `null` (NOT YET MEASURED). On a null entry
// this spec SKIPS the assertion and just logs the measured DC — the orchestrator
// seeds the real high-water from that first run. It does NOT run in the vitest batch
// (playground/e2e is excluded); the orchestrator owns the GPU/e2e leg.
//
// NOTE (F3-remaining): until the chain's pass bodies retype to the RHI encoder, the
// router holds `?rhichain=1` on the twin (render-loop.ts `_chainRunsOnWebgl2=false`),
// so chain and twin render identically → DC≈0. A DC≈0 here therefore means "routing
// not yet live", NOT "parity reached"; the entries stay null until real chain
// execution lands, at which point DC becomes the true chain-vs-twin distance.

import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const OUT = 'test-results/twin-parity-ratchet'
const HIGH_WATER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'map',
  'src',
  'twin-parity-highwater.json',
)

interface Fixture {
  /** Key into the high-water file. */
  key: string
  /** demo.html `id`. */
  id: string
  /** Extra query params (proj / sprite), without a leading `&`. */
  params?: string
  /** Camera hash (without `#`). */
  hash?: string
}

// The doc §3-F3 matrix. Cameras: ofm_bright_local at #14/35.68/139.76 (the F1 probe
// camera), flat + globe; the rest at their fixture default camera.
const FIXTURES: Fixture[] = [
  { key: 'minimal', id: 'minimal' },
  { key: 'ofm_bright_local_flat', id: 'ofm_bright_local', hash: '14/35.68/139.76' },
  {
    key: 'ofm_bright_local_globe',
    id: 'ofm_bright_local',
    params: 'proj=globe',
    hash: '14/35.68/139.76',
  },
  { key: 'dashed_lines', id: 'dashed_lines' },
  {
    key: 'fixture_line_image_pattern',
    id: 'fixture_line_image_pattern',
    params: 'sprite=/fixture-sprite',
  },
  { key: 'fixture_translucent_outline', id: 'fixture_translucent_outline' },
]

function readHighWater(): Record<string, number | null> {
  return (
    JSON.parse(readFileSync(HIGH_WATER_PATH, 'utf8')) as { fixtures: Record<string, number | null> }
  ).fixtures
}

async function shoot(
  page: import('@playwright/test').Page,
  fx: Fixture,
  rhiChain: boolean,
): Promise<Buffer> {
  await page.setViewportSize({ width: 900, height: 700 })
  const params = ['e2e=1', 'forcegl2=1']
  if (rhiChain) params.push('rhichain=1')
  if (fx.params) params.push(fx.params)
  const url = `/demo.html?id=${fx.id}&${params.join('&')}${fx.hash ? `#${fx.hash}` : ''}`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    {
      timeout: 35_000,
    },
  )
  await page.waitForTimeout(9000)
  await page.evaluate(() =>
    (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.(),
  )
  await page.waitForTimeout(1500)
  return page.locator('canvas').first().screenshot()
}

/** Differing-pixel count (any channel |Δ| > 8). Both frames are the SAME backend
 *  (WebGL2), so this is a within-backend chain-vs-twin distance, not a cross-backend
 *  diff — an exact-ish equality is the F4 target. */
function diffCount(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return a.width * a.height // dims differ → all-different
  let dc = 0
  for (let p = 0; p < a.width * a.height; p++) {
    const i = p * 4
    if (
      Math.abs(a.data[i] - b.data[i]) > 8 ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > 8 ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > 8
    )
      dc++
  }
  return dc
}

test.describe('twin-parity ratchet: chain vs twin on WebGL2 (#1046 F3)', () => {
  const highWater = readHighWater()
  mkdirSync(OUT, { recursive: true })
  const measured: Record<string, number> = {}

  for (const fx of FIXTURES) {
    test(`${fx.key}: chain (?rhichain=1) matches the twin`, async ({ page, context }) => {
      test.setTimeout(120_000)
      const twinBuf = await shoot(page, fx, false)
      const chainPage = await context.newPage()
      const chainBuf = await shoot(chainPage, fx, true)
      writeFileSync(`${OUT}/${fx.key}.twin.png`, twinBuf)
      writeFileSync(`${OUT}/${fx.key}.chain.png`, chainBuf)
      const dc = diffCount(PNG.sync.read(twinBuf), PNG.sync.read(chainBuf))
      measured[fx.key] = dc
      writeFileSync(`${OUT}/dc.json`, JSON.stringify(measured, null, 2))

      const ceil = highWater[fx.key]
      console.log(`[twin-parity] ${fx.key}: DC=${dc} high-water=${ceil ?? 'null (unmeasured)'}`)
      if (ceil === null || ceil === undefined) {
        // NOT YET MEASURED — the orchestrator seeds the high-water from this DC. Do NOT
        // assert (a null entry is the "chain not yet captured" state, F3-remaining).
        test.skip(
          true,
          `${fx.key}: high-water is null — orchestrator seeds it from this run (DC=${dc})`,
        )
        return
      }
      // SHRINK-ONLY: a regression (DC above the banked high-water) fails; the ceiling is
      // lowered by the orchestrator as the port closes the gap toward zero (F4).
      expect(
        dc,
        `${fx.key}: chain-vs-twin DC ${dc} exceeds high-water ${ceil} (shrink-only)`,
      ).toBeLessThanOrEqual(ceil)
    })
  }
})
