// #2144 (ADR-0012 D7 P2) — CJK VERTICAL WRITING, on a real GPU.
//
// The unit corpus (map/src/text/vertical-writing.test.ts) proves the column
// arithmetic and the cache key. This gate proves the same STRUCTURE survives
// the whole live pipeline — style → converter → IR → TextStage → collision →
// TextRenderer — on the SwiftShader GPU, for the three fixtures the design doc
// names: `서울특별시` (Hangul), `東京都` (Han), `Tokyo 東京` (mixed).
//
// IT ASSERTS STRUCTURE, NEVER A PIXEL COUNT. A nonBg-% gate passes on a broken
// image (CLAUDE.md §12, #1221): a column drawn in the wrong order, at the wrong
// pitch, or with every glyph lying on its side paints the same number of lit
// pixels as a correct one. So the assertions are: the column is y-monotonic in
// SOURCE order, its pitch is the em (not the per-glyph advance), every glyph is
// UPRIGHT (rotation 0), the cross-axis centres share one line, and the draw is
// tagged `vertical` rather than `curved` (§11.1). The frame is still captured,
// and drawn-label counts still asserted, so "structurally perfect but nothing
// reached the screen" cannot pass either.
//
// Fixture setup here is a full map boot plus async glyph rasterization, which
// is where a loaded SwiftShader runner actually times out — so the budget is
// declared at FILE scope (`test.describe.configure`), not in a test body, which
// would leave setup on the config default (CLAUDE.md §12).

import { test, expect } from '@playwright/test'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ART = join(HERE, '__vertical-writing__')
mkdirSync(ART, { recursive: true })

test.describe.configure({ timeout: 180_000 })

const HANGUL = '서울특별시'
const HAN = '東京都'
const MIXED = 'Tokyo 東京'

interface DumpGlyph {
  cp: number
  x: number
  y: number
  rot: number
  adv: number
  bearingY: number
  height: number
  rfs: number
}
interface DumpLabel {
  text: string
  anchorX: number
  anchorY: number
  fontSize: number
  slotSize: number
  curved: boolean
  vertical: boolean
  glyphs: DumpGlyph[]
}
interface Probe {
  backend: string | undefined
  marker: string | undefined
  drawn: number
  labels: DumpLabel[]
}

declare global {
  interface Window {
    __xgisActiveBackend?: string
  }
}

async function boot(page: import('@playwright/test').Page, forceGl2: boolean): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`/demo.html?id=vertical_labels${forceGl2 ? '&forcegl2=1' : ''}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )
}

/** Read the live per-glyph dump plus the backend identity in one round trip. */
function readProbe(page: import('@playwright/test').Page): Promise<Probe> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __xgisActiveBackend?: string
      __xgisMap?: {
        ctx?: { rhi?: { backend?: string } }
        setLabelDumpFilter?: (s: string | null) => void
        getDumpedLabels?: () => unknown[] | null
        getLastLabelCounts?: () => { submitted: number; drawn: number } | null
        invalidate?: () => void
      }
    }
    const m = w.__xgisMap
    return {
      backend: m?.ctx?.rhi?.backend,
      marker: w.__xgisActiveBackend,
      drawn: m?.getLastLabelCounts?.()?.drawn ?? 0,
      labels: (m?.getDumpedLabels?.() ?? []) as never,
    }
  }) as Promise<Probe>
}

/** Boot, turn the dump on (empty filter = every label), and poll until the
 *  three columns have actually been rasterized, placed and drawn. */
async function columns(
  page: import('@playwright/test').Page,
  forceGl2: boolean,
): Promise<{ probe: Probe; png: Buffer }> {
  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
  await boot(page, forceGl2)
  await page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: { setLabelDumpFilter?: (s: string | null) => void; invalidate?: () => void }
      }
    ).__xgisMap
    m?.setLabelDumpFilter?.('')
    m?.invalidate?.()
  })
  let probe = await readProbe(page)
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline && probe.labels.length < 3) {
    await page.evaluate(() => {
      ;(window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap?.invalidate?.()
    })
    await page.waitForTimeout(1_500)
    probe = await readProbe(page)
  }
  const png = await page.locator('#map').screenshot()
  writeFileSync(join(ART, forceGl2 ? 'columns-webgl2.png' : 'columns-webgpu.png'), png)
  expect(errors, 'no page errors').toEqual([])
  return { probe, png }
}

function labelFor(probe: Probe, text: string): DumpLabel {
  const found = probe.labels.find((l) => l.text === text)
  expect(
    found,
    `no label "${text}" in the live dump — got [${probe.labels.map((l) => l.text).join(' | ')}] ` +
      `(drawn=${probe.drawn}). The column cannot be checked if the label never reached the ` +
      `renderer.`,
  ).toBeDefined()
  return found!
}

/** Every structural assertion for one fixture. Split by FAMILY so a red run
 *  names the severed half: the ORIENTATION checks read only `rot`, the COLUMN
 *  checks read only `y`, the CROSS-AXIS check reads only `x`. */
function assertColumn(l: DumpLabel, text: string): void {
  const glyphs = l.glyphs.filter((g) => g.cp !== 10)
  expect(glyphs.length, `"${text}" lost glyphs`).toBe([...text].length)

  // ── ORIENTATION (rot only) ────────────────────────────────────────────
  const upright = [...text].map((ch) => !/\s/u.test(ch))
  glyphs.forEach((g, i) => {
    const want = upright[i] ? 0 : Math.PI / 2
    expect(
      g.rot,
      `ORIENTATION wrong in "${text}" glyph ${i} ('${String.fromCodePoint(g.cp)}'): ${g.rot} rad, ` +
        `expected ${want}. A verticalized glyph draws UPRIGHT in its em cell; only whitespace ` +
        `and complex-shaping scripts carry the +π/2 the label turn would have applied ` +
        `(design §1.2a). Full rotations: [${glyphs.map((q) => q.rot.toFixed(4)).join(', ')}]`,
    ).toBeCloseTo(want, 5)
  })
  expect(
    l.vertical,
    `"${text}" reached diagnostics untagged as vertical (curved=${l.curved}) — before the ` +
      `explicit glyphLayout discriminator every CJK column reported as a curved road name ` +
      `(design §11.1).`,
  ).toBe(true)
  expect(l.curved, `"${text}" must not report as a curved line label`).toBe(false)

  // ── COLUMN (y only) ───────────────────────────────────────────────────
  const ys = glyphs.map((g) => g.y)
  for (let i = 1; i < ys.length; i++) {
    expect(
      ys[i]! - ys[i - 1]!,
      `COLUMN order broken in "${text}": glyph ${i} sits at y=${ys[i]} but glyph ${i - 1} at ` +
        `y=${ys[i - 1]} — a vertical label must advance DOWNWARD in SOURCE order. ` +
        `y=[${ys.map((v) => v.toFixed(2)).join(', ')}]`,
    ).toBeGreaterThan(0)
  }
  // Pitch: exactly the em between two upright cells. A whitespace cell takes
  // its own advance (MapLibre shaping.ts:379-387), so only compare pairs where
  // both sides verticalize.
  for (let i = 1; i < ys.length; i++) {
    if (!upright[i - 1] || !upright[i]) continue
    expect(
      ys[i]! - ys[i - 1]!,
      `COLUMN pitch is not the em in "${text}": step ${i - 1}→${i} is ` +
        `${(ys[i]! - ys[i - 1]!).toFixed(3)} px, expected ${l.fontSize}. The pitch must come ` +
        `from the EM BOX, never from metrics.advance (design §5) — a Latin glyph's advance is ` +
        `visibly narrower than a Han one at the same size.`,
    ).toBeCloseTo(l.fontSize, 2)
  }

  // ── CROSS AXIS (x only) ───────────────────────────────────────────────
  // Every glyph's ADVANCE BOX is centred on ONE line — MapLibre's
  // `xHalfWidthOffsetCorrection = ONE_EM/2 − halfAdvance` (quads.ts:316), which
  // is what stops a narrow Latin letter hanging off the left of its em cell in a
  // mixed column. `x` is the pen origin, so the centre is `x + adv/2`; the
  // advances DIFFER by a factor of ~2 between the Latin and Han glyphs here, so
  // a constant-x column fails this by that whole amount.
  const centres = glyphs.filter((_, i) => upright[i]).map((g) => g.x + g.adv / 2)
  const spread = Math.max(...centres) - Math.min(...centres)
  expect(
    spread,
    `CROSS-AXIS zig-zag in "${text}": upright glyph centres at ` +
      `[${centres.map((c) => c.toFixed(3)).join(', ')}], spread ${spread.toFixed(3)} px. A ` +
      `bilingual column must share ONE centreline; per-glyph INK metrics leaking into the ` +
      `cross axis is the design §5 trap.`,
  ).toBeLessThan(0.01)
}

for (const forceGl2 of [false, true]) {
  const backend = forceGl2 ? 'webgl2' : 'webgpu'
  test(`vertical columns render structurally correct on ${backend}`, async ({ page }) => {
    const { probe } = await columns(page, forceGl2)

    // Assert the BACKEND first: a silent fallback would otherwise green the
    // WebGL2 arm against a WebGPU frame (CLAUDE.md §5).
    expect(probe.marker, 'window.__xgisActiveBackend').toBe(backend)
    expect(probe.backend, 'host.ctx.rhi.backend').toBe(backend)
    // And that the columns actually reached the screen — structure alone
    // cannot distinguish "correct" from "correct and invisible".
    expect(probe.drawn, `labels drawn on ${backend}`).toBeGreaterThanOrEqual(3)

    for (const text of [HANGUL, HAN, MIXED]) assertColumn(labelFor(probe, text), text)

    // The mixed fixture is the one that matters most: it verticalizes because a
    // SINGLE upright codepoint is present, and its Latin letters stack UPRIGHT
    // one per em cell rather than rotating sideways — MapLibre's behaviour, and
    // the visible parity decision of design §6.
    const mixed = labelFor(probe, MIXED)
    const latin = mixed.glyphs.filter((g) => g.cp < 0x2e80 && g.cp !== 32)
    expect(latin.length, 'the mixed fixture must actually carry Latin glyphs').toBeGreaterThan(4)
    expect(
      latin.every((g) => Math.abs(g.rot) < 1e-5),
      `Latin in "${MIXED}" is not upright: [${latin.map((g) => g.rot.toFixed(4)).join(', ')}]`,
    ).toBe(true)
  })
}
