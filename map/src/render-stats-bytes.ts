// ═══ Byte-level render telemetry gather (#1355) ═══
//
// Extracted from the render loop, which sits on a shrink-only LOC ceiling. The
// gather is one cohesive job — walk the vt sources, sum the byte accumulators
// the engine already maintains for its OWN eviction decisions, and hand the
// totals to the stats tracker. Nothing here decides anything; keeping it out of
// the loop keeps the loop about frames.

import type { TileCatalog } from '@xgis/data'

/** The per-source pair the loop iterates. Structural, so this module needs
 *  neither VectorTileRenderer nor the map. */
export interface ByteTelemetrySource {
  renderer: { arenaBytes(): { live: number; capacity: number } }
  source: Pick<TileCatalog, 'getStateBreakdown' | 'getPendingLoadCount'>
}

type ArenaWatermarks = { liveUsedBytes: number; capacityBytes: number }

/** The already-public arena probes `arenaByteTotals` reads. Structural for the
 *  same reason — GpuTileStore satisfies it without knowing this module exists. */
export interface ArenaProbes {
  polyVertexArenaOrNull(): ArenaWatermarks | null
  polyIndexArenaOrNull(): ArenaWatermarks | null
  zBufferArenaOrNull(): ArenaWatermarks | null
}

/** Live + capacity bytes of the arenas a tile store has actually CREATED.
 *
 *  A free function rather than a `GpuTileStore` method: the store has no reason
 *  of its own to sum these, its three probes are already public, and telemetry
 *  is the only reader — a new method there would be class surface serving one
 *  external caller.
 *
 *  All three arenas are lazily built, and an un-created one contributes 0 rather
 *  than its would-be capacity. Reporting reserved-but-never-allocated bytes
 *  would show 192 MB resident on a map that never drew a polygon, which is the
 *  opposite of what a memory readout is for. `live` is the number eviction
 *  measures against `capacity * ARENA_LOW_WATER`; the pair is what makes the
 *  ratio readable. */
export function arenaByteTotals(store: ArenaProbes): { live: number; capacity: number } {
  let live = 0
  let capacity = 0
  for (const a of [
    store.polyVertexArenaOrNull(),
    store.polyIndexArenaOrNull(),
    store.zBufferArenaOrNull(),
  ]) {
    if (!a) continue
    live += a.liveUsedBytes
    capacity += a.capacityBytes
  }
  return { live, capacity }
}

/** The fields this gather writes. A subset of StatsTracker, so a mistake here
 *  is a type error rather than a silently-missing number. */
export interface ByteTelemetrySink {
  cachedBytes: number
  arenaLiveBytes: number
  arenaCapacityBytes: number
  inflightRequests: number
}

/** Sum the byte telemetry across `sources` into `sink`.
 *
 *  Every term is a read of an accumulator that already exists — the CPU cache's
 *  enforced byte total, the arenas' live/capacity watermarks, the in-flight
 *  depth — so this adds no accounting and no hot-path cost. Assigns rather than
 *  accumulates: the loop calls it once per frame after `beginFrame` zeroed the
 *  tracker.
 *
 *  Walks EVERY source, including ones the draw loop skips on `!hasData()`. That
 *  is deliberate: a source still resolving its archive has no drawable tile yet
 *  and is exactly when in-flight depth is worth seeing. Applying the draw
 *  loop's guard here would zero the number precisely when it matters. */
export function collectByteTelemetry(
  sources: Iterable<ByteTelemetrySource>,
  sink: ByteTelemetrySink,
): void {
  let cached = 0
  let live = 0
  let capacity = 0
  let inflight = 0
  for (const { renderer, source } of sources) {
    const arena = renderer.arenaBytes()
    live += arena.live
    capacity += arena.capacity
    cached += source.getStateBreakdown().bytes
    inflight += source.getPendingLoadCount()
  }
  sink.cachedBytes = cached
  sink.arenaLiveBytes = live
  sink.arenaCapacityBytes = capacity
  sink.inflightRequests = inflight
}
