// ═══ §5 render gate for `input` (#1539): setInput actually changes pixels ═══
//
// The claim under test is the whole point of the feature: a host calls
// `map.setInput(name, value)` and the picture changes — WITHOUT recompiling a
// pipeline. Everything else about `input` is checked by construction (the
// emitted WGSL declares every lane, the pool sizes are pinned, the store
// contract is unit-tested); only a real render can say the value reaches the
// screen.
//
// Why this can run headlessly at all. `| opacity-[threshold]` and
// `| fill-[highlight]` are `input-dependent` PropertyShapes — they read no
// feature field, so `paint-shape-resolve.ts` evaluates them once per frame on
// the CPU into the existing `u.opacity` / `u.fill_color` uniforms. That path is
// backend-neutral, so it renders on the WebGL2 (SwiftShader) backend CI drives.
// An `input` MIXED with a feature read (`.score / threshold`) takes the shader
// pool instead and is WebGPU-only — deliberately NOT exercised here rather than
// faked, and recorded as such on #1539.
//
// Backend is PINNED to WebGL2 and asserted via the live #backend-tag, so a
// silent fallback cannot green this spec (CLAUDE.md §5). `&adaptive=0` pins the
// adaptive quality controller off — see _stage-block-parity.spec.ts's header for
// why the ladder's settle race would otherwise make captures nondeterministic.
//
// The verdict is DIRECTIONAL, not an absolute threshold: `changed > 0` between
// a before and after capture of the SAME scene, plus a same-input control
// capture that must be byte-identical. The control is what makes the gate
// non-vacuous — without it, any source of frame nondeterminism would "prove" a
// change the setInput never caused.

import { test, expect } from '@playwright/test'
import { PNG } from 'pngjs'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { captureCanvas } from './helpers/visual'

const ART = join(process.cwd(), 'test-results', 'input-live-set')

// Scene-region crop: matches the sibling #1538 gate, excluding the demo chrome
// (description strip, log panel, toolbar) which is not render output.
const X0 = 0
const X1 = 840
const Y0 = 50
const Y1 = 620

interface Frame {
  png: Buffer
  hash: string
  nonBg: number
}

function frameOf(png: Buffer): Frame {
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

/** Count pixels that differ between two captures of the same crop. The
 *  directional quantity this gate reads — DC in the repo's diff vocabulary. */
function changedPixels(a: Buffer, b: Buffer): number {
  const ia = PNG.sync.read(a)
  const ib = PNG.sync.read(b)
  const x1 = Math.min(ia.width, ib.width, X1)
  const y1 = Math.min(ia.height, ib.height, Y1)
  let n = 0
  for (let y = Y0; y < y1; y++) {
    for (let x = X0; x < x1; x++) {
      const i = (y * ia.width + x) * 4
      const j = (y * ib.width + x) * 4
      if (
        Math.abs(ia.data[i]! - ib.data[j]!) > 4 ||
        Math.abs(ia.data[i + 1]! - ib.data[j + 1]!) > 4 ||
        Math.abs(ia.data[i + 2]! - ib.data[j + 2]!) > 4
      ) {
        n++
      }
    }
  }
  return n
}

/** The polygon's centre pixel. The fixture draws one solid quad over the middle
 *  of the viewport, so this samples pure fill — no edge antialiasing. */
function centre(png: Buffer): [number, number, number] {
  const im = PNG.sync.read(png)
  const i = (Math.floor(im.height * 0.45) * im.width + Math.floor(im.width * 0.42)) * 4
  return [im.data[i]!, im.data[i + 1]!, im.data[i + 2]!]
}

/** Assert a sampled colour matches an expectation within a small tolerance —
 *  8-bit rounding and the software rasterizer's blend both cost a unit or two. */
function expectRgb(got: readonly number[], want: readonly number[], why: string): void {
  const near = got.every((c, i) => Math.abs(c - want[i]!) <= 2)
  expect(near, `${why}: got rgb(${got.join(',')}), expected ≈rgb(${want.join(',')})`).toBe(true)
}

/** Capture once the scene has settled — two consecutive frames 400ms apart
 *  hashing identically. Same idiom as the #1538 gate; the engine renders on
 *  demand, so a fixed wait is not a settle criterion. */
async function settled(page: import('@playwright/test').Page): Promise<Frame> {
  let f = frameOf(await captureCanvas(page, { readyTimeoutMs: 30_000 }))
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(400)
    const next = frameOf(await captureCanvas(page, { readyTimeoutMs: 30_000 }))
    if (next.hash === f.hash) return next
    f = next
  }
  return f
}

async function setInput(
  page: import('@playwright/test').Page,
  name: string,
  value: number | string,
): Promise<void> {
  await page.evaluate(
    ([n, v]) => {
      const m = (window as unknown as { __xgisMap?: { setInput(k: string, x: unknown): void } })
        .__xgisMap
      if (!m) throw new Error('__xgisMap not exposed — the demo shell did not publish the map')
      m.setInput(n as string, v)
    },
    [name, value] as const,
  )
}

test.describe.configure({ timeout: 180_000 })

test('setInput changes the rendered picture, with no pipeline rebuild (webgl2)', async ({
  page,
}) => {
  await page.goto(
    '/demo.html?id=fixture_input_live&backend=webgl2&e2e=1&ptdur=0&fade=0&adaptive=0',
    {
      waitUntil: 'domcontentloaded',
    },
  )
  await expect(page.locator('#backend-tag')).toHaveText('WebGL2', { timeout: 30_000 })

  const before = await settled(page)
  mkdirSync(ART, { recursive: true })
  writeFileSync(join(ART, 'before.png'), before.png)

  // Non-vacuous floor: the polygon spans 80° × 50° at the default camera, so a
  // blank scene can never satisfy this. Without it, blank-vs-blank would read
  // as "no change" and a broken fixture would look like a passing control.
  expect(before.nonBg, 'scene rendered blank before setInput').toBeGreaterThan(500)

  // The DECLARED DEFAULTS must be what renders before any host call:
  // `input highlight: color = #f59e0b` at `input threshold: f32 = 1.0`.
  // Checking the actual colour — not merely "something drew" — is what
  // distinguishes "the compile-time default reached the uniform" from "some
  // fallback colour happens to be on screen".
  expectRgb(centre(before.png), [245, 158, 11], 'the declared #f59e0b default did not render')

  // ── CONTROL: no setInput between two captures ⇒ byte-identical ──
  // This is what stops any frame nondeterminism from masquerading as the
  // change setInput is supposed to cause.
  const control = await settled(page)
  writeFileSync(join(ART, 'control.png'), control.png)
  expect(
    changedPixels(before.png, control.png),
    'two captures with NO setInput between them differ — this harness is ' +
      'nondeterministic, so a positive result below would prove nothing',
  ).toBe(0)

  // ── The opacity axis ──
  // Capture the pipeline identity across the set: `setInput` must be a uniform
  // write only. Comparing the object identity of the fill pipeline before and
  // after is the runtime half of #1539's "no recompile" contract.
  const pipeBefore = await page.evaluate(
    () =>
      (window as unknown as { __xgisMap?: { renderer?: { fillPipeline?: unknown } } }).__xgisMap
        ?.renderer?.fillPipeline ?? null,
  )
  await setInput(page, 'threshold', 0.3)
  const afterOpacity = await settled(page)
  writeFileSync(join(ART, 'after-opacity.png'), afterOpacity.png)

  const dcOpacity = changedPixels(before.png, afterOpacity.png)
  expect(
    dcOpacity,
    `setInput('threshold', 0.3) changed NO pixels (nonBg=${afterOpacity.nonBg}). ` +
      'Either the input never reached the paint resolve, or the per-frame ' +
      'resolve memo served a stale snapshot (InputStore.revision).',
  ).toBeGreaterThan(0)

  // The VALUE, not just "it changed": #f59e0b over a near-black background at
  // opacity 0.3 is a straight multiply, so each channel must land on 30% of its
  // pre-set value. A gate that only checked DC>0 would pass on ANY change —
  // including the input landing in the wrong lane.
  expectRgb(
    centre(afterOpacity.png),
    [Math.round(245 * 0.3), Math.round(158 * 0.3), Math.round(11 * 0.3)],
    "setInput('threshold', 0.3) did not scale the fill to 30%",
  )

  const pipeAfter = await page.evaluate(
    () =>
      (window as unknown as { __xgisMap?: { renderer?: { fillPipeline?: unknown } } }).__xgisMap
        ?.renderer?.fillPipeline ?? null,
  )
  expect(
    pipeAfter === pipeBefore,
    'the fill pipeline object changed across setInput — the contract is a ' +
      'uniform write with NO pipeline rebuild (#1539 verification item 1)',
  ).toBe(true)

  // ── The colour axis ──
  await setInput(page, 'highlight', '#22c55e')
  const afterColor = await settled(page)
  writeFileSync(join(ART, 'after-color.png'), afterColor.png)
  expect(
    changedPixels(afterOpacity.png, afterColor.png),
    `setInput('highlight', '#22c55e') changed NO pixels (nonBg=${afterColor.nonBg})`,
  ).toBeGreaterThan(0)

  // #22c55e = rgb(34,197,94), still at the 0.3 opacity set above — so this also
  // proves the two inputs COMPOSE: changing the colour did not reset the
  // opacity the previous call established.
  expectRgb(
    centre(afterColor.png),
    [Math.round(34 * 0.3), Math.round(197 * 0.3), Math.round(94 * 0.3)],
    "setInput('highlight', '#22c55e') did not land, or reset the live threshold",
  )

  console.log(
    `[input-live-set] nonBg=${before.nonBg} DC(opacity)=${dcOpacity} ` +
      `DC(colour)=${changedPixels(afterOpacity.png, afterColor.png)} control=0`,
  )
})
