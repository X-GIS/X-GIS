// #1515 release-side hitch — the MEASUREMENT the issue asks for, on the fix's own terms.
//
// A PROBE, not a gate. It asserts nothing about timing (SwiftShader's frame deltas are its
// own, per CLAUDE.md §5 — timing gates stay off the headless path); it PRINTS one summary line
// that is directly comparable across two checkouts, which is what "did the release hitch go
// away" actually needs. The name deliberately ends `-probe`, not `-gate`, so
// `playground/src/e2e-specs-load.test.ts` does not require a CI leg for it.
//
// WHAT IT MEASURES, and why these two numbers together. #1515's own measurement plan:
//
//   > Release half — count `compact()` calls and log the `targetCapacity` allocated. If the
//   > hitch coincides with a compaction rather than with tile count, it is the arena.
//
// So the probe samples per-frame deltas AND `GPUArena.compactionCount` for both poly arenas
// over the same window. Either number alone is the composite-metric trap §12 warns about: a
// worst-frame figure cannot say what caused it, and a compaction count cannot say whether it
// cost anything. The pair can — and the specific claim the fix makes is falsifiable here,
// because the pre-fix failure is a compaction EVERY frame under sustained pressure
// (`_compactPolyArenas` had no gate, and `forceEvictBytes` re-raised the flag each frame), so
// `compactions ≈ frames` before and a small constant after.
//
// THE SCENE. #1515 was reported against a GeoJSON source — "one big tile with more detailed
// ones inside it at 3×3" — i.e. over-zoom, where every visible tile is clipped out of its
// ancestor. The fixture is generated here (in-repo, no network): a 3×3 block of dense polygon
// cells inside a single parent footprint, pushed through `setSourceData`, then a zoom triangle
// wave that repeatedly crosses the source's max level so tiles are uploaded AND released.

import { test, type Page } from '@playwright/test'

test.describe.configure({ timeout: 300_000 })

const SRC = `xgis 1

source hitch_probe {
  type: geojson
  data: { "type": "FeatureCollection", "features": [] }
}

layer hitch_fill {
  source: hitch_probe
  | fill-sky-500
}
`

/** Dense synthetic over-zoom fixture: a 3×3 block of cells inside one parent footprint, each
 *  cell a jagged ring so the polygon tessellation produces real arena volume rather than nine
 *  quads. `cells`/`ringPoints` are the two knobs that decide how hard the arenas are pushed. */
function makeFixture(cells: number, ringPoints: number): unknown {
  const lon0 = 126.9
  const lat0 = 37.5
  const span = 0.09 // ≈ one z=12 tile across, so the 3×3 sits inside one parent
  const step = span / cells
  const features: unknown[] = []
  for (let gy = 0; gy < cells; gy++) {
    for (let gx = 0; gx < cells; gx++) {
      const x0 = lon0 + gx * step
      const y0 = lat0 + gy * step
      const ring: [number, number][] = []
      // A star-shaped ring: alternating radii keep the polygon simple (non-self-intersecting)
      // while giving the tessellator ringPoints real vertices to work with.
      for (let k = 0; k < ringPoints; k++) {
        const t = (k / ringPoints) * Math.PI * 2
        const r = (k % 2 === 0 ? 0.44 : 0.24) * step
        ring.push([x0 + step / 2 + Math.cos(t) * r, y0 + step / 2 + Math.sin(t) * r])
      }
      ring.push(ring[0]!)
      features.push({
        type: 'Feature',
        id: gy * cells + gx,
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
      })
    }
  }
  return { type: 'FeatureCollection', features }
}

interface ArenaCounters {
  vertexCompactions: number
  indexCompactions: number
  vertexLiveBytes: number
  indexLiveBytes: number
  vertexCapacityBytes: number
  reachable: boolean
}

/** Read both poly arenas' counters out of the live map.
 *
 *  Best-effort by design: `GpuTileStore` is renderer-internal and there is no public accessor
 *  for it, and a probe is not a reason to add production surface. So this walks the map's own
 *  object graph for the store's already-public arena probes (`polyVertexArenaOrNull`) and
 *  reports `reachable: false` rather than guessing — an unreachable counter is stated, never
 *  silently reported as zero (CLAUDE.md §12: a diagnostic nothing can reach is not one). */
async function readArenaCounters(page: Page): Promise<ArenaCounters> {
  return page.evaluate(() => {
    interface ArenaLike {
      compactionCount: number
      liveUsedBytes: number
      capacityBytes: number
    }
    interface StoreLike {
      polyVertexArenaOrNull(): ArenaLike | null
      polyIndexArenaOrNull(): ArenaLike | null
    }
    const isStore = (v: unknown): v is StoreLike =>
      typeof v === 'object' &&
      v !== null &&
      typeof (v as StoreLike).polyVertexArenaOrNull === 'function' &&
      typeof (v as StoreLike).polyIndexArenaOrNull === 'function'

    const root = (window as unknown as { __xgisMap?: unknown }).__xgisMap
    const seen = new Set<unknown>()
    const queue: { node: unknown; depth: number }[] = [{ node: root, depth: 0 }]
    const stores: StoreLike[] = []
    let visited = 0
    while (queue.length > 0 && visited < 4000) {
      const { node, depth } = queue.shift()!
      if (node === null || typeof node !== 'object' || seen.has(node) || depth > 6) continue
      seen.add(node)
      visited++
      if (isStore(node)) {
        stores.push(node)
        continue
      }
      const children: unknown[] =
        node instanceof Map
          ? [...node.values()]
          : Array.isArray(node)
            ? node
            : Object.values(node as Record<string, unknown>)
      for (const c of children) queue.push({ node: c, depth: depth + 1 })
    }

    const out = {
      vertexCompactions: 0,
      indexCompactions: 0,
      vertexLiveBytes: 0,
      indexLiveBytes: 0,
      vertexCapacityBytes: 0,
      reachable: stores.length > 0,
    }
    for (const s of stores) {
      const v = s.polyVertexArenaOrNull()
      const i = s.polyIndexArenaOrNull()
      if (v) {
        out.vertexCompactions += v.compactionCount
        out.vertexLiveBytes += v.liveUsedBytes
        out.vertexCapacityBytes += v.capacityBytes
      }
      if (i) {
        out.indexCompactions += i.compactionCount
        out.indexLiveBytes += i.liveUsedBytes
      }
    }
    return out
  })
}

/** Zoom triangle wave across the source's max level, sampling per-frame deltas. Crossing the
 *  level in BOTH directions is what exercises the release half: zooming out drops the fine
 *  sub-tiles, which is when eviction + the arena remedies run. */
async function runZoomCycle(page: Page, durationMs: number, cycles: number): Promise<number[]> {
  return page.evaluate(
    async ({ durationMs, cycles }) => {
      const map = (
        window as unknown as {
          __xgisMap?: { getCamera(): { zoom: number }; invalidate?: () => void }
        }
      ).__xgisMap
      if (!map) throw new Error('__xgisMap missing')
      const cam = map.getCamera()
      const deltas: number[] = []
      return await new Promise<number[]>((resolve) => {
        const t0 = performance.now()
        let last = t0
        const tick = () => {
          const now = performance.now()
          deltas.push(now - last)
          last = now
          const elapsed = now - t0
          if (elapsed >= durationMs) {
            resolve(deltas)
            return
          }
          const phase = ((elapsed / durationMs) * cycles) % 1
          const tri = phase < 0.5 ? phase * 2 : (1 - phase) * 2
          cam.zoom = 12 + tri * 6 // 12 → 18 → 12, straddling the geojson max level
          map.invalidate?.()
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
    },
    { durationMs, cycles },
  )
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!
}

test('#1515 release-hitch probe — frame deltas vs arena compactions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const b64 = Buffer.from(SRC, 'utf8').toString('base64')
  await page.goto(`/demo.html?id=__import&e2e=1&scene=hitch#src=${b64}`, {
    waitUntil: 'domcontentloaded',
  })
  await page.waitForFunction(
    () => (window as unknown as { __xgisReady?: boolean }).__xgisReady === true,
    null,
    { timeout: 60_000 },
  )

  const fixture = makeFixture(3, 512)
  await page.evaluate((fc) => {
    ;(
      window as unknown as { __xgisMap?: { setSourceData?: (id: string, fc: unknown) => void } }
    ).__xgisMap?.setSourceData?.('hitch_probe', fc)
  }, fixture)
  await page.waitForTimeout(4_000) // settle the cold-start upload cascade

  const before = await readArenaCounters(page)
  const deltas = (await runZoomCycle(page, 20_000, 4)).slice(2) // drop warm-up frames
  const after = await readArenaCounters(page)

  const sorted = [...deltas].sort((a, b) => a - b)
  const compactions =
    after.vertexCompactions -
    before.vertexCompactions +
    (after.indexCompactions - before.indexCompactions)
  const mib = (b: number) => (b / (1024 * 1024)).toFixed(1)

  // ONE line, deliberately: this is what gets diffed between a pre-fix and a post-fix run.
  // `compactions` is the claim under test (pre-fix it tracks `frames`; post-fix it is a small
  // constant); `worst`/`p99` are what the user actually feels; `live/cap` says whether the
  // arenas were under real pressure at all — a run with no pressure measured nothing, and
  // saying so beats reporting a flat frame graph as a success.
  console.log(
    `[#1515 compaction probe] frames=${deltas.length} ` +
      `median=${quantile(sorted, 0.5).toFixed(1)}ms p95=${quantile(sorted, 0.95).toFixed(1)}ms ` +
      `p99=${quantile(sorted, 0.99).toFixed(1)}ms worst=${Math.max(...sorted).toFixed(1)}ms ` +
      `compactions=${after.reachable ? compactions : 'n/a'} ` +
      `(v=${after.vertexCompactions} i=${after.indexCompactions}) ` +
      `live=${mib(after.vertexLiveBytes)}/${mib(after.vertexCapacityBytes)}MiB ` +
      `arenaReachable=${after.reachable}`,
  )
  if (!after.reachable) {
    console.log(
      '[#1515 compaction probe] NOTE: the tile store was not reachable from __xgisMap, so the ' +
        'compaction count above is not a measurement. The frame deltas still are.',
    )
  }
})
