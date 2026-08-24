// ═══ #1190 — bundle replay parity gate (the interactive §5 gate) ═══
//
// The render-bundle path was disabled for months because an earlier
// enable — validated against a SINGLE STATIC SCREENSHOT — shipped a
// mostly-empty canvas during interactive navigation. Root cause (now
// pinned in BundleKeyState.ringCursor): recorded bundles bake
// UniformRing dynamic offsets, and the ring cursor base (allocations by
// EARLIER shows + fallback walks in the same frame) was not in the
// cache key, so an upstream alloc-count change replayed stale offsets
// under a key hit.
//
// This gate is the validation class that enable lacked: an INTERACTIVE
// camera script (bearing / fractional zoom / pitch — each step a
// navigating frame shape), run twice on the same offline synthetic
// style — bundles OFF (__XGIS_BUNDLE_OFF) vs bundles ON (default) —
// with per-step settle-until-stable-hash screenshots. Every step's
// frame must be BYTE-IDENTICAL between the arms (same code, same
// SwiftShader rasterizer → hash equality is the correct rung, per the
// render-gate ladder).
//
// Vacuity guards (a diff of 0 between two arms proves nothing if
// bundling never engaged):
//   - the ON arm must record bundle HITS > 0 across the script,
//   - the ON arm runs with __XGIS_INVARIANTS so the hit-path
//     alloc-count invariant (vector-tile-renderer.ts) executes live —
//     a re-walk that no longer lands on the baked offsets throws and
//     fails this gate with the mechanism named.
//
// Offline by construction: the COMMITTED demotiles mirror
// (`import_maplibre_mirror`, playground/public/vendor/demotiles-mirror,
// z0-2 real MVT tiles + local glyphs) — the same fixture
// _demotiles-mirror-gate renders in CI. Real decoded tiles have
// TERMINAL per-tile content (no virtual-tiling refinement), which is
// what makes per-step hashes history-independent; the first probe scene
// (runtime GeoJSON) refined tiles progressively and settled to
// history-dependent states (4 distinct stable hashes for one camera,
// measured). Small viewport + msaa=1 keeps SwiftShader raster bounded.

import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'

// z4 band: world-copy enumeration is OFF here (low-zoom only), which keeps
// SwiftShader raster within budget — at z3+pitch the ×5 world-copy fan wedged
// the GPU process so hard the compositor stopped producing frames and
// page.screenshot blocked for the whole test budget (measured, run 3).
// The mirror's z2 ring exists only AROUND #1.5/20/140, so the script
// stays in the cz=1 band (zoom < 2): a step outside the mirrored set would
// pend forever and idle would never fire (measured at zoom 2.2 — the
// bearing-55 viewport demanded unmirrored z2 tiles, 220 s idle timeout).
// Fractional zoom + bearing + pitch still churn selection and offsets.
const SCRIPT: ReadonlyArray<{ bearing: number; zoom: number; pitch: number }> = [
  { bearing: 0, zoom: 1.5, pitch: 0 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
  { bearing: 55, zoom: 1.8, pitch: 15 },
  { bearing: 55, zoom: 1.6, pitch: 15 },
  { bearing: 25, zoom: 1.5, pitch: 0 },
]

async function bootArm(page: Page, bundleOff: boolean): Promise<void> {
  _clip = null
  await page.goto(`/demo.html?id=import_maplibre_mirror&e2e=1&msaa=1#1.5/20/140`, {
    waitUntil: 'domcontentloaded',
  })
  console.log(`[bundle-parity] boot(off=${bundleOff}): navigated, waiting ready`)
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 240_000 },
  )
  console.log(`[bundle-parity] boot(off=${bundleOff}): ready`)
  // Both flags are read LIVE at render time (per-frame `=== true` checks),
  // so a post-ready evaluate is sufficient AND reliable — per-arm
  // addInitScript stacking was NOT: on the second navigation the same-source
  // scripts did not apply in registration order and the ON arm booted with
  // the OFF arm's flag still set (measured: both arms read off=true).
  await page.evaluate((off: boolean) => {
    ;(globalThis as { __XGIS_BUNDLE_OFF?: boolean }).__XGIS_BUNDLE_OFF = off
    // Live correctness net in BOTH arms (equal conditions): the ON arm
    // exercises the bundle hit-path alloc invariant.
    ;(globalThis as { __XGIS_INVARIANTS?: boolean }).__XGIS_INVARIANTS = true
  }, bundleOff)
  const flags = await page.evaluate(() => ({
    off: (globalThis as { __XGIS_BUNDLE_OFF?: unknown }).__XGIS_BUNDLE_OFF,
    inv: (globalThis as { __XGIS_INVARIANTS?: unknown }).__XGIS_INVARIANTS,
  }))
  console.log(`[bundle-parity] page flags: ${JSON.stringify(flags)}`)
  await page.waitForTimeout(8_000) // cold-start tile + glyph cascade
  // Warm-up: run the full script once WITHOUT hashing, so every pose's
  // tiles AND glyph ranges are loaded before the measured pass. The idle
  // event does not cover late glyph arrivals — un-warmed first-visit
  // frames settled to poorer-content states than any revisit (measured:
  // steps 0-1 DIFF'd while every revisited pose hashed EQUAL).
  for (const step of SCRIPT) await stepAndSettle(page, step, /* warmup */ true)
}

const bundleStats = async (page: Page): Promise<{ hits: number; misses: number }> =>
  page.evaluate(() => {
    const m = (
      window as unknown as {
        __xgisMap?: {
          vtSources?: Map<
            string,
            { renderer?: { getBundleStats?: () => { hits: number; misses: number } } }
          >
        }
      }
    ).__xgisMap
    let hits = 0
    let misses = 0
    for (const e of m?.vtSources?.values() ?? []) {
      const st = e.renderer?.getBundleStats?.()
      if (st) {
        hits += st.hits
        misses += st.misses
      }
    }
    return { hits, misses }
  })

// Viewport-clipped PAGE screenshot, not an element screenshot: the
// element path waits for the node to be "stable", and the demo canvas
// never satisfies it here (measured: the wait spun for the whole 600 s
// budget at 'attempting scroll into view — waiting for element to be
// stable'). A clip has no actionability wait. The clip is the canvas's
// box measured ONCE per arm (identical camera → identical box across
// arms); DOM overlays sit outside it.
let _clip: { x: number; y: number; width: number; height: number } | null = null
const canvasHash = async (page: Page): Promise<string> => {
  if (!_clip) {
    const box = await page.locator('#xg-canv, canvas').first().boundingBox()
    if (!box) throw new Error('canvas has no bounding box')
    _clip = {
      x: Math.max(0, Math.floor(box.x)),
      y: Math.max(0, Math.floor(box.y)),
      width: Math.floor(box.width),
      height: Math.floor(box.height),
    }
    console.log(`[bundle-parity] clip=${JSON.stringify(_clip)}`)
  }
  // Own timeout: a SwiftShader GPU-process wedge stops compositor frames and
  // page.screenshot never resolves — fail THIS call loudly instead of
  // silently eating the whole test budget.
  const png = await page.screenshot({ clip: _clip, animations: 'disabled', timeout: 120_000 })
  return createHash('sha256').update(png).digest('hex')
}

/** Apply one script step, then pump until the frame is stable (two
 *  consecutive identical hashes) — the settle-until-identical-hashes
 *  pattern. Returns the settled hash. */
let _stepIdx = 0
async function stepAndSettle(
  page: Page,
  step: { bearing: number; zoom: number; pitch: number },
  warmup = false,
): Promise<string> {
  const stepIdx = _stepIdx++
  console.log(
    `[bundle-parity] step ${stepIdx}${warmup ? ' (warmup)' : ''} apply ${JSON.stringify(step)}`,
  )
  // Completion-driven settle (#1372 startSettledLoop pattern): register the
  // idle listener FIRST, then move the camera in the same evaluate — the map
  // renders on demand until nothing is left (fetch/upload/refine drained,
  // camera at rest) and fires 'idle'. No external pumping: an invalidate()
  // pump would hold _needsRender and idle would never fire. Hash-polling was
  // tried first and rejected: the virtual-tiling refinement pipeline keeps
  // landing content for tens of SwiftShader-seconds, so "N identical hashes"
  // repeatedly certified half-refined frames (4 distinct stable states for
  // one camera, measured run 8).
  await page.evaluate(
    async ({ s, timeoutMs }) => {
      const m = (
        window as unknown as {
          __xgisMap: {
            getCamera: () => { bearing: number; pitch: number }
            setZoom: (z: number) => void
            invalidate: () => void
            on: (t: string, cb: () => void) => unknown
          }
        }
      ).__xgisMap
      await new Promise<void>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`idle timeout after ${timeoutMs}ms`)), timeoutMs)
        m.on('idle', () => {
          clearTimeout(t)
          res()
        })
        const cam = m.getCamera()
        cam.bearing = s.bearing
        cam.pitch = s.pitch
        m.setZoom(s.zoom)
        m.invalidate()
      })
    },
    { s: step, timeoutMs: 220_000 },
  )
  if (warmup) return ''
  // Loaded-set MOTION frames — the frames the bundle path actually serves.
  // During the step transition every frame has tiles in flight
  // (allTilesLoaded=false → no bundling), and the converged frame is
  // immediately followed by idle — so a script of pure step-and-settle
  // never engages bundles at all (measured: misses=0 across 12 steps).
  // The realistic jank regime (#1190 S1) is navigation over an ALREADY
  // LOADED set: wiggle bearing ±2° around the pose for 6 frames, each
  // double-rAF paced. On the ON arm these frames encode + replay
  // bundles; on the OFF arm they re-encode directly. The wiggle ends
  // back at the exact pose and settles to idle, so the hashed frame
  // stays deterministic.
  await page.evaluate(async (baseBearing: number) => {
    const m = (
      window as unknown as {
        __xgisMap: { getCamera: () => { bearing: number }; invalidate: () => void }
      }
    ).__xgisMap
    const cam = m.getCamera()
    for (let i = 0; i < 6; i++) {
      cam.bearing = baseBearing + (i % 2 === 0 ? 2 : -2)
      m.invalidate()
      await Promise.race([
        new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
        new Promise<void>((r) => setTimeout(r, 20_000)),
      ])
    }
    cam.bearing = baseBearing
    m.invalidate()
  }, step.bearing)
  // Re-settle to idle at the exact pose, then hash. Twice: sanity net.
  await page.evaluate(async (timeoutMs: number) => {
    const m = (
      window as unknown as {
        __xgisMap: { on: (t: string, cb: () => void) => unknown; invalidate: () => void }
      }
    ).__xgisMap
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`re-idle timeout after ${timeoutMs}ms`)), timeoutMs)
      m.on('idle', () => {
        clearTimeout(t)
        res()
      })
      m.invalidate()
    })
  }, 220_000)
  const h1 = await canvasHash(page)
  const h2 = await canvasHash(page)
  if (h1 !== h2) throw new Error(`post-idle frame not stable at step ${stepIdx}`)
  return h1
}

async function runScript(page: Page): Promise<string[]> {
  const hashes: string[] = []
  for (const step of SCRIPT) {
    hashes.push(await stepAndSettle(page, step))
    const st = await bundleStats(page)
    console.log(`[bundle-parity] cumulative bundle stats: hits=${st.hits} misses=${st.misses}`)
  }
  return hashes
}

test('#1190 — bundled frames are byte-identical to direct frames across an interactive script', async ({
  page,
}) => {
  test.setTimeout(1_500_000)
  const pageErrors: string[] = []
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)))
  await page.setViewportSize({ width: 288, height: 160 })

  // Arm 1 — bundles OFF (reference).
  await bootArm(page, true)
  const offHashes = await runScript(page)

  // Arm 2 — bundles ON (default path under test). Fresh navigation; the
  // init script re-registers with off=false.
  await bootArm(page, false)
  const onHashes = await runScript(page)
  const stats = await page.evaluate(() => {
    // Lifetime, straight from each VTR's BundleCache — the map.stats
    // snapshot is a per-frame aggregation and reads 0 on an idle frame.
    const m = (
      window as unknown as {
        __xgisMap?: {
          vtSources?: Map<
            string,
            { renderer?: { getBundleStats?: () => { hits: number; misses: number } } }
          >
        }
      }
    ).__xgisMap
    let hits = 0
    let misses = 0
    for (const e of m?.vtSources?.values() ?? []) {
      const s = e.renderer?.getBundleStats?.()
      if (s) {
        hits += s.hits
        misses += s.misses
      }
    }
    return { hits, misses }
  })

  console.log(`[bundle-parity] on-arm bundle hits=${stats.hits} misses=${stats.misses}`)
  for (let i = 0; i < SCRIPT.length; i++) {
    console.log(
      `[bundle-parity] step ${i} ${JSON.stringify(SCRIPT[i])} off=${offHashes[i]?.slice(0, 12)} on=${onHashes[i]?.slice(0, 12)} ${offHashes[i] === onHashes[i] ? 'EQUAL' : 'DIFF'}`,
    )
  }

  // The invariant net: a hit re-walk that no longer matches the baked
  // offsets throws in-page — surface it as this gate's failure.
  expect(pageErrors, `page errors during parity run:\n${pageErrors.join('\n')}`).toEqual([])
  // Vacuity guard — bundling must actually engage on the ON arm.
  expect(stats.hits, 'bundle path never HIT on the ON arm — gate is vacuous').toBeGreaterThan(0)
  // The §5 verdict: every step byte-identical between arms.
  expect(onHashes).toEqual(offHashes)
})
