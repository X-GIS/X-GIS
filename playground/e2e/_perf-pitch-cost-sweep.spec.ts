import { test, expect, type Page } from '@playwright/test'

// PITCH COST SWEEP — the reproduction harness for #1367 ("performance drops
// sharply when LOWERING pitch"). Reports the cost curve; gates only on
// invariants that must survive a fix.
//
// ── The mechanism, confirmed — and since ADDRESSED by #1346 ──────────────────
//
//   1. pitch < 60°  => the targetSSE ramp unwinds to baseTarget = 1
//                      (tiles-sse.ts; isolated by A/B in #1379)
//   2.              => the selector emits ~2 LOD levels finer
//   3.              => per-zoom simplification retains far more geometry
//   4.              => frame cost rises with it
//
// Step 4 holds only when the data is dense enough that step 3 outweighs the
// smaller ground area at low pitch. On this repo's sparse fixtures the sign is
// the OPPOSITE, which is why the report resisted reproduction for a long time —
// the sign flips on DENSITY ALONE, same camera, same code, same renderer:
//
//     sparse (stock physical_map)  82.5° -> 0°:  39.6 -> 35.8 ms,  186 ->     8 tris
//     dense  (seeded, see below)   82.5° -> 0°: 782.9 -> 1304.2 ms, 16380 -> 72464 tris
//
// #1346 then graded the far-field SSE ceiling by DISTANCE (in camera altitudes)
// instead of applying it frame-wide whenever the camera is pitched, so steps 1-2
// no longer happen: the foreground keeps native LOD at EVERY pitch. Re-measured
// on 5f77894e, same harness, same container:
//
//     dense, after   82.5° -> 0°: 2116.5 -> 1330.3 ms, 109586 -> 72464 tris
//                    (repeat run: 2218.0 -> 1347.8, tris/maxZ byte-identical)
//                    maxZ 10 at every stop (was 7 -> 10 escalating as pitch fell)
//
// RUN THIS SWEEP WITH `adaptive=0`. The adaptive quality ladder is ON by default
// (engine/src/gpu/adaptive-quality.ts) and at ~2 s/frame it engages every time. It
// moves BOTH render resolution and — since #1406 — the far-field LOD ceiling, so a
// default-flag run has neither a fixed ms column nor a fixed tris column, and
// nothing in it is comparable to anything. Every number above is
// `DEMO='physical_map&adaptive=0'`.
//
// So the reported sign is GONE (0.63x, i.e. lowering pitch is now cheaper) and
// the 58-65° spike flattened (3.2x the high-pitch cost -> a ~1.6-2.0x peak that
// has moved to high pitch). But read WHY: low pitch did not get cheaper — it is
// unchanged at 72464 tris — the cliff closed because HIGH pitch rose to meet it
// (16380 -> 109586 tris, ~2.7x the frame time). Those are the native-LOD
// foreground tiles a pitched view was missing entirely; whether that trade is
// right is a policy call, and the lever is `FAR_RAMP_NEAR` in tiles-sse.ts.
//
// ON THIS FIXTURE that new cost looks geometry-bound: quartering the pixels
// (`&dpr=0.5`; selection is DPR-invariant, so tris/maxZ barely move) takes 82.5°
// from 2116.5/2218.0 to 1708.2 ms — only ~-21% against a ~5% endpoint run-to-run
// floor — while within one run the cost tracks triangles almost linearly (1.51x
// tris -> 1.59x / 1.65x ms).
//
// DO NOT GENERALISE THAT. It is a property of THIS fixture, not of the renderer,
// and reading it as one sent #1393 down the wrong path for a while. The seeded
// grid is 8100 uniform many-vertex polygons over a fixed span — unusually heavy
// geometry per pixel — and a real basemap is the opposite: measured on dense
// OpenFreeMap Bright buildings (Paris z16, pitch 70, real GPU), quartering the
// pixels took the frame 3.84 s -> 1.61 s, i.e. ~75% pixel-proportional. Same
// question, opposite answer, because the DATA differs. Whenever this harness's
// ratios are used to argue about where cost lives, say "on this fixture".
//
// What both measurements agree on is the useful part: the DPR lever alone runs
// out — it has a 0.5 floor and a fraction of the frame is immune to it either
// way. That is what #1406 answered, by making the controller an ordered ladder
// (far-field LOD first, device pixels second) rather than a second budget in the
// selector. `MAX_EMITTED` still counts TILES, deliberately: see #1393 for why a
// hard geometry cap was NOT the fix.
//
// ── Why this can run without a dense fixture ─────────────────────────────────
//
// Every dense vector fixture in this repo needs network egress (`pmtiles_layered`
// -> api.protomaps.com; the OFM gates -> an uncommitted /ofm-mirror snapshot;
// `physical_map_50m` -> 50m Natural Earth, excluded by .gitignore:8) — the
// step-1 blocker in #1349. The blocker was never the renderer: WebGL2 software
// rendering works headlessly. It was the DATA, and density can be SYNTHESISED.
// `seedDense` builds a deterministic FeatureCollection in-page and pushes it
// with setSourceData(), so this spec is self-contained and offline.
//
// ── What is asserted, and what is only reported ──────────────────────────────
//
// Absolute milliseconds under SwiftShader are meaningless, and the cost curve is
// still a live policy question (see the header: #1346 closed the way-down half,
// #1406 answered the way-up half with an adaptive ladder rather than a fixed
// budget) — so a cost-ceiling assertion would have to be re-tuned by whoever
// moves that policy next. Instead the gate gates on
// invariants that hold on BOTH sides of any such change:
//
//   * liveness      — sources actually hold data (a dead source reports
//                     missedTiles=0 with loaded()=true, #1364 Path B; a cost
//                     curve over empty sources looks fine and means nothing)
//   * determinism   — the same camera must produce the same frame. Re-setting
//                     an identical pitch must reproduce identical geometry
//                     counts. This is the invariant #1379's churn threatens.
//   * cleanliness   — no page errors, no gl errors, no arena-oom
//
// The cost curve itself is REPORTED for humans. Do not convert it into a
// threshold without re-measuring the noise floor on the target machine.
//
//   DEMO='physical_map&adaptive=0' SEED=dense HEADED=0 XGIS_SOFTWARE_GPU=1 \
//     playwright test _perf-pitch-cost-sweep.spec.ts
//
//   ...&dpr=0.5   # fill-vs-geometry control: same selection, a quarter the pixels
//
//   SEED=off DEMO=pmtiles_layered CAM='#11.52/35.7553/139.6973/0/0'  # real source

const DEMO = process.env.DEMO ?? 'physical_map'
const CAM = process.env.CAM ?? '#10.35/30.94337/118.42256/356.5/82.5'
/** Mobile-class by default: it matches the original report AND puts the
 *  un-migrated budget sites into phone-grade caps (#1350). */
const VW = Number(process.env.VW ?? 430)
const VH = Number(process.env.VH ?? 715)
/** Spans the 58-65° peak band, both endpoints, and the 60° ramp threshold. */
const PITCHES = (process.env.PITCHES ?? '82.5,70,65,58,40,0')
  .split(',')
  .map(Number)
  .filter((n) => Number.isFinite(n))
/** Settle window per stop, ms. Raise on a slow link or a heavier source. */
const SETTLE_MS = Number(process.env.SETTLE_MS ?? 2600)
/** Frames timed per stop. Software rasterisation is slow; 6 is enough for a
 *  median when each frame costs ~1 s. */
const FRAMES = Number(process.env.FRAMES ?? 6)
/** `dense` seeds a synthetic dense source (default, self-contained);
 *  `off` measures the demo's own data. */
const SEED = process.env.SEED ?? 'dense'
/** Seeded grid is SEED_GRID² polygons of SEED_RING+1 vertices each. */
const SEED_GRID = Number(process.env.SEED_GRID ?? 90)
const SEED_RING = Number(process.env.SEED_RING ?? 24)
/** Source id the dense grid is pushed into. Must exist in the demo. */
const SEED_SOURCE = process.env.SEED_SOURCE ?? 'land'

interface Sample {
  drawCalls: number
  triangles: number
  lines: number
  tilesVisible: number
  cacheEntries: number
  liveSources: number
  deadSources: string[]
  maxZ: number
  byZoom: string
}

async function sampleFrame(page: Page): Promise<Sample> {
  return await page.evaluate(() => {
    const w = window as unknown as {
      __xgisMap?: {
        vtSources?: Map<
          string,
          { renderer: { _drawStats?: { _frameDrawnByZoom?: Map<number, number> } } }
        >
        inspectPipeline(): unknown
      }
    }
    const pipe = w.__xgisMap?.inspectPipeline() as
      | {
          sources?: Array<{
            name: string
            cache: { size: number; hasData?: boolean }
            frame: { drawCalls: number; triangles: number; lines: number; tilesVisible: number }
          }>
        }
      | undefined
    const acc: Sample = {
      drawCalls: 0,
      triangles: 0,
      lines: 0,
      tilesVisible: 0,
      cacheEntries: 0,
      liveSources: 0,
      deadSources: [],
      maxZ: -1,
      byZoom: '',
    }
    for (const s of pipe?.sources ?? []) {
      acc.drawCalls += s.frame.drawCalls
      acc.triangles += s.frame.triangles
      acc.lines += s.frame.lines
      acc.tilesVisible += s.frame.tilesVisible
      acc.cacheEntries += s.cache.size
      // Liveness, not just counters: #1364 Path B showed a dead source
      // reporting missedTiles=0 while `loaded()` was true. A cost sweep over
      // sources with no data would be equally meaningless.
      //
      // `__`-prefixed sources (the synthetic earth surface) are engine-injected
      // background, not style data — they are always present and would mask a
      // fully dead style. Their draw cost still counts above; only the liveness
      // verdict excludes them.
      if (s.name.startsWith('__')) continue
      if (s.cache.hasData && s.cache.size > 0) acc.liveSources++
      else acc.deadSources.push(s.name)
    }
    const bz: Record<string, number> = {}
    for (const entry of w.__xgisMap?.vtSources?.values() ?? []) {
      const m = entry.renderer._drawStats?._frameDrawnByZoom
      if (m && typeof m.forEach === 'function') {
        m.forEach((n: number, z: number) => {
          bz[String(z)] = (bz[String(z)] ?? 0) + n
        })
      }
    }
    const zs = Object.keys(bz)
      .map(Number)
      .filter((z) => z > 0)
    acc.maxZ = zs.length ? Math.max(...zs) : -1
    acc.byZoom = Object.entries(bz)
      .sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([z, n]) => `z${z}:${n}`)
      .join(' ')
    return acc
  })
}

/** Drive N invalidate -> rAF -> rAF cycles and time each. */
async function frameCost(page: Page, frames: number): Promise<number[]> {
  return await page.evaluate(async (n) => {
    const m = (window as unknown as { __xgisMap?: { invalidate?: () => void } }).__xgisMap
    const out: number[] = []
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      m?.invalidate?.()
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
      out.push(performance.now() - t0)
    }
    return out
  }, frames)
}

/** Push a deterministic dense grid of many-vertex polygons, so that per-zoom
 *  simplification has something to remove and finer LOD genuinely costs more.
 *  Deterministic by construction (grid indices + sin) — no Math.random, so
 *  repeat runs and the determinism check below are comparable. */
async function seedDense(page: Page, grid: number, ring: number, sourceId: string, cam: string) {
  const m = cam.match(/#[\d.]+\/([-\d.]+)\/([-\d.]+)/)
  const lat = m ? Number(m[1]) : 0
  const lon = m ? Number(m[2]) : 0
  return await page.evaluate(
    ({ grid, ring, sourceId, lon, lat }) => {
      const span = 0.9 // degrees covered, centred on the camera
      const step = span / grid
      const r = step * 0.34
      const features: unknown[] = []
      for (let iy = 0; iy < grid; iy++) {
        for (let ix = 0; ix < grid; ix++) {
          const cx = lon - span / 2 + (ix + 0.5) * step
          const cy = lat - span / 2 + (iy + 0.5) * step
          const coords: [number, number][] = []
          for (let k = 0; k <= ring; k++) {
            const a = (k / ring) * Math.PI * 2
            // Radius wobble so simplification has detail to drop per zoom.
            const rr = r * (1 + 0.25 * Math.sin(a * 7))
            coords.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a) * 0.85])
          }
          features.push({
            type: 'Feature',
            properties: { id: iy * grid + ix },
            geometry: { type: 'Polygon', coordinates: [coords] },
          })
        }
      }
      ;(
        window as unknown as { __xgisMap?: { setSourceData(id: string, d: unknown): void } }
      ).__xgisMap?.setSourceData(sourceId, { type: 'FeatureCollection', features })
      return { features: features.length, vertsPerFeature: ring + 1 }
    },
    { grid, ring, sourceId, lon, lat },
  )
}

/** Minimum triangles the seeded grid must contribute before a measurement is allowed.
 *  The stock physical_map coastline is a few hundred at this camera and the grid is
 *  five orders of magnitude denser, so any threshold in between separates them; this
 *  one is deliberately far below what the grid actually produces so it tests
 *  "the push landed", not "the push produced exactly N". */
const SEED_LANDED_MIN_TRIS = 5000

/** Block until the seeded geometry is actually ON SCREEN, or fail loudly.
 *
 *  A fixed sleep is not enough and quietly produced WRONG measurements: runs that
 *  sampled too early reported the stock sparse coastline (178 triangles) as though it
 *  were the dense fixture, and the harness's own liveness check passed the whole time
 *  because the sources genuinely did hold data — just not the pushed data. That is
 *  #1402's lesson repeating one layer up: assert the thing you actually need, not a
 *  proxy that is true either way.
 *
 *  This is a WAIT, not a diagnosis. A push is frame-paced (the catalog re-tiles in
 *  rounds bounded by the load-concurrency cap, and each round's replacement is swapped
 *  onto the GPU inside a frame), so under a software rasteriser it legitimately needs
 *  far longer than the old `SETTLE_MS * 3` — but a run observed here never landed at
 *  all within 120 s of pumped frames, which no amount of settling explains. When this
 *  throws, treat it as a REPORT, not a flake: the fixture is deterministic and the
 *  push either reaches the frame or does not.
 *
 *  Frames are pumped rather than waited for, because an idle map draws nothing and the
 *  swap only happens in a frame. */
async function awaitSeedLanded(page: Page, features: number): Promise<void> {
  const deadline = Date.now() + 120_000
  let best = 0
  while (Date.now() < deadline) {
    const { triangles } = await sampleFrame(page)
    best = Math.max(best, triangles)
    if (triangles >= SEED_LANDED_MIN_TRIS) {
      console.log(`  seed landed: ${triangles} triangles on screen`)
      return
    }
    await frameCost(page, 2)
    await page.waitForTimeout(500)
  }
  throw new Error(
    `Seeded ${features} polygons but only ${best} triangles ever reached the frame ` +
      `(need ≥ ${SEED_LANDED_MIN_TRIS}). The push did not land — measuring now would ` +
      `report the demo's own sparse data as the dense fixture. See #1402.`,
  )
}

async function setPitch(page: Page, pitch: number, settleMs: number) {
  await page.evaluate((p) => {
    ;(window as unknown as { __xgisMap?: { setPitch(p: number): void } }).__xgisMap?.setPitch(p)
  }, pitch)
  await page.waitForTimeout(settleMs)
}

function pct(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor(s.length * p))]
}

async function waitReady(page: Page, timeoutMs: number): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (
      await page.evaluate(
        () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
      )
    )
      return true
    await page.waitForTimeout(200)
  }
  return false
}

test.describe('pitch cost sweep (#1367)', () => {
  test.use({ viewport: { width: VW, height: VH } })

  test(`cost vs pitch on ${DEMO}${SEED === 'dense' ? ' + dense seed' : ''}`, async ({ page }) => {
    test.setTimeout(90_000 + PITCHES.length * (SETTLE_MS + 60_000))

    const problems: string[] = []
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message.slice(0, 200)}`))
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('arena-oom')) problems.push(`arena-oom: ${t.slice(0, 160)}`)
      if (m.type() === 'error' && !/Failed to load resource/.test(t))
        problems.push(`console: ${t.slice(0, 160)}`)
    })

    // Forced WebGL2: the software path renders correctly headlessly, unlike
    // WebGPU+SwiftShader for the full raster pipeline.
    await page.goto(`/demo.html?id=${DEMO}&forcegl2=1&e2e=1${CAM}`, {
      waitUntil: 'domcontentloaded',
    })
    expect(await waitReady(page, 60_000), '__xgisReady never became true').toBe(true)
    await page.waitForTimeout(SETTLE_MS)

    if (SEED === 'dense') {
      const seeded = await seedDense(page, SEED_GRID, SEED_RING, SEED_SOURCE, CAM)
      console.log(
        `\n  seeded ${seeded.features} polygons x ${seeded.vertsPerFeature} verts into source "${SEED_SOURCE}"`,
      )
      await awaitSeedLanded(page, seeded.features)
    }

    const probe = await sampleFrame(page)
    if (probe.liveSources === 0) {
      // Never report a cost curve measured over sources holding no data — that
      // is the #1364 Path B trap: it looks healthy and means nothing.
      throw new Error(
        `No source has data (dead: ${probe.deadSources.join(', ') || 'none named'}).\n` +
          `"${DEMO}" resolved to nothing — with SEED=off this usually means no network ` +
          `egress to its tile/manifest host. See #1367 and #1349 (fixture provenance).`,
      )
    }

    console.log(`\n  demo=${DEMO} viewport=${VW}x${VH} seed=${SEED} cam=${CAM}`)
    console.log(`  live sources=${probe.liveSources} dead=[${probe.deadSources.join(',')}]\n`)
    console.log('  pitch |  med ms   p90 ms |  draws      tris   lines  vis | maxZ | drawn-by-zoom')
    console.log('  ------+------------------+-------------------------------+------+--------------')

    const seen: { pitch: number; s: Sample; med: number }[] = []
    for (const pitch of PITCHES) {
      await setPitch(page, pitch, SETTLE_MS)
      const times = await frameCost(page, FRAMES)
      const s = await sampleFrame(page)
      seen.push({ pitch, s, med: pct(times, 0.5) })
      console.log(
        `  ${String(pitch).padStart(5)} | ${pct(times, 0.5).toFixed(1).padStart(7)} ` +
          `${pct(times, 0.9).toFixed(1).padStart(8)} | ${String(s.drawCalls).padStart(6)} ` +
          `${String(s.triangles).padStart(9)} ${String(s.lines).padStart(7)} ` +
          `${String(s.tilesVisible).padStart(4)} | ${String(s.maxZ).padStart(4)} | ${s.byZoom}`,
      )
    }

    // ── Determinism: the same camera must produce the same frame ──
    // Re-visit the first pitch and require identical geometry. This is the
    // invariant #1379's high-pitch selector churn threatens, and it holds
    // regardless of how #1367 is eventually fixed.
    const first = seen[0]
    await setPitch(page, first.pitch, SETTLE_MS)
    const again = await sampleFrame(page)

    const hi = seen[0]
    const lo = seen[seen.length - 1]
    const ratio = hi.s.triangles > 0 ? lo.s.triangles / hi.s.triangles : 0
    console.log(
      `\n  pitch ${hi.pitch} → ${lo.pitch}:  med ${hi.med.toFixed(1)} → ${lo.med.toFixed(1)} ms` +
        `   tris ${hi.s.triangles} → ${lo.s.triangles} (${ratio.toFixed(2)}x)` +
        `   maxZ ${hi.s.maxZ} → ${lo.s.maxZ}`,
    )
    const peak = seen.reduce((a, b) => (b.med > a.med ? b : a))
    console.log(
      `  peak cost at pitch ${peak.pitch}: ${peak.med.toFixed(1)} ms` +
        ` (${(peak.med / Math.min(...seen.map((x) => x.med))).toFixed(2)}x the cheapest stop)`,
    )
    console.log(
      `\n  Reading it: #1367's signature is maxZ RISING as pitch falls, with tris\n` +
        `  rising alongside. On sparse data the sign inverts — that is expected and\n` +
        `  is why SEED=dense is the default. Absolute ms is rasteriser noise; the\n` +
        `  ratios and the tris/maxZ columns are the signal.\n`,
    )
    if (problems.length) {
      console.log(`  problems (${problems.length}):`)
      for (const p of problems.slice(0, 10)) console.log(`   ! ${p}`)
    }

    // ── Gates: invariants only. The cost curve above is reported, not gated —
    //    the cost policy is still live (#1346 closed the way-down half), so any
    //    ceiling would need re-tuning by whoever moves it next. See the header.
    expect(
      problems,
      `page/gl errors or arena-oom during the sweep:\n${problems.join('\n')}`,
    ).toEqual([])
    expect(
      again.triangles,
      `non-deterministic frame: pitch ${first.pitch} produced ${first.s.triangles} triangles, ` +
        `then ${again.triangles} on revisit (same camera). See #1379.`,
    ).toBe(first.s.triangles)
    expect(
      again.maxZ,
      `non-deterministic LOD: pitch ${first.pitch} drew maxZ ${first.s.maxZ}, then ${again.maxZ} on revisit.`,
    ).toBe(first.s.maxZ)
  })
})
