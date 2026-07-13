// ═══ Skeleton prewarm pump — level-staged, byte-budgeted (#1045) ═══
//
// Extracted from TileCatalog.prewarmSkeleton, which used to enqueue EVERY
// tile of EVERY level z ∈ [start..depth] up front and re-issue the whole
// remaining set on a fixed 250 ms tick until all arrived. On real planet
// tilesets that is catastrophic: the depth heuristic assumed ~50 KB/tile
// (~4 MB for depth 3), but OpenFreeMap z2-z3 tiles average ~400 KB —
// measured 2026-07-13: one static z4 view fetched 85 skeleton tiles /
// 33 MB (92 % of all traffic), and the no-backoff pump kept mobile radios
// hot on lossy links.
//
// This pump keeps the skeleton's PURPOSE — Cesium-style permanent root
// retention so classifyFallback's ancestor walk always finds a cached
// tile — and bounds its COST:
//
//   • LEVEL-STAGED: level z+1 is not touched until level z is complete,
//     so the fallback chain fills top-down and a budget stop never leaves
//     a shallower level half-fetched while a deeper one streamed.
//   • FLOOR: the leading levels whose cumulative tile count fits
//     FLOOR_MAX_TILES (z0+z1 for a z0-rooted source — 5 tiles) always
//     complete regardless of budget. They are the ancestor-walk backbone.
//   • BYTE-BUDGETED: past the floor, once the ARRIVED skeleton bytes
//     reach the budget, deeper enqueueing stops and every not-yet-arrived
//     key is UNPINNED so ordinary LRU eviction can reclaim strays.
//     Requests go out in CHUNK-sized waves, so overshoot is bounded by
//     one chunk (≤ 2 tiles ≈ ~2 MB on the heaviest planet levels).
//   • BACKOFF: the tick doubles 250 ms → 8 s while no new tile arrives;
//     after MAX_STALLED_TICKS zero-progress ticks it gives up and unpins
//     the stragglers (a dead source must not keep the radio warm).

export interface SkeletonPrewarmHost {
  /** True when the catalog already holds data for this key. */
  hasTileData(key: number): boolean
  /** Fire-and-forget fetch dispatch (catalog prefetch path). */
  prefetchTiles(keys: number[]): void
  /** Pin keys against eviction (idempotent). */
  markSkeleton(keys: number[]): void
  /** Release pins for keys that will not be fetched (idempotent). */
  unmarkSkeleton(keys: number[]): void
  /** Cached byte size for one key (0 when absent). */
  bytesFor(key: number): number
}

export interface SkeletonPrewarmOpts {
  /** First (shallowest) pyramid level, inclusive. */
  start: number
  /** Last (deepest) pyramid level, inclusive. */
  cap: number
  /** Level/x/y → catalog tile key. */
  keyOf(z: number, x: number, y: number): number
  /** The leading levels whose CUMULATIVE tile count fits this allowance
   *  are budget-exempt (the ancestor-walk backbone — z0+z1 for a
   *  z0-rooted source). Counted in tiles, not levels, so a minzoom>0
   *  source doesn't get a whole wide level exempted. */
  floorMaxTiles: number
  /** Arrived-bytes ceiling for the non-floor levels. */
  byteBudget: number
}

export interface SkeletonPrewarmHandle {
  /** Cancel the pump (idempotent). Pins already granted stay granted. */
  stop(): void
}

/** Tiles fetched per tick wave — bounds budget overshoot to one chunk. */
const CHUNK = 2
const BASE_TICK_MS = 250
const MAX_TICK_MS = 8_000
/** Consecutive zero-progress ticks before the pump gives up. */
const MAX_STALLED_TICKS = 6

export function runSkeletonPrewarm(
  host: SkeletonPrewarmHost,
  opts: SkeletonPrewarmOpts,
): SkeletonPrewarmHandle {
  const { start, cap, keyOf, floorMaxTiles, byteBudget } = opts
  const levels: number[][] = []
  for (let z = start; z <= cap; z++) {
    const n = 1 << z
    const level: number[] = []
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) level.push(keyOf(z, x, y))
    }
    levels.push(level)
  }
  let floorLevels = 0
  let cum = 0
  for (const level of levels) {
    cum += level.length
    if (cum > floorMaxTiles) break
    floorLevels++
  }
  const allKeys = levels.flat()
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let delay = BASE_TICK_MS
  let lastArrived = -1
  let stalled = 0

  const arrivedStats = (): { count: number; bytes: number } => {
    let count = 0
    let bytes = 0
    for (const k of allKeys) {
      if (host.hasTileData(k)) {
        count++
        bytes += host.bytesFor(k)
      }
    }
    return { count, bytes }
  }

  const unpinMissingFrom = (levelIdx: number): void => {
    const missing: number[] = []
    for (let i = levelIdx; i < levels.length; i++) {
      for (const k of levels[i]) if (!host.hasTileData(k)) missing.push(k)
    }
    if (missing.length) host.unmarkSkeleton(missing)
  }

  const tick = (): void => {
    if (stopped) return
    // Advance past complete levels — level order IS the fallback chain order.
    let levelIdx = 0
    while (levelIdx < levels.length && levels[levelIdx].every((k) => host.hasTileData(k))) {
      levelIdx++
    }
    if (levelIdx >= levels.length) return // skeleton complete

    const { count, bytes } = arrivedStats()

    if (levelIdx >= floorLevels && bytes >= byteBudget) {
      // Budget reached past the floor: stop deepening, release the pins of
      // everything that will now never arrive.
      unpinMissingFrom(levelIdx)
      return
    }

    const missing = levels[levelIdx].filter((k) => !host.hasTileData(k))
    const wave = missing.slice(0, CHUNK)
    if (wave.length) {
      // Pin lazily, per wave — an up-front mark of every level would pin
      // keys the budget stop later has to walk back.
      host.markSkeleton(wave)
      host.prefetchTiles(wave)
    }

    if (count === lastArrived) {
      stalled++
      delay = Math.min(delay * 2, MAX_TICK_MS)
      if (stalled >= MAX_STALLED_TICKS) {
        // Dead/unreachable source: give up and release the stragglers.
        unpinMissingFrom(levelIdx)
        return
      }
    } else {
      stalled = 0
      delay = BASE_TICK_MS
    }
    lastArrived = count

    timer = setTimeout(tick, delay)
  }

  tick()

  return {
    stop(): void {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
