// ═══ Skeleton prewarm pump — budget / floor / staging / give-up gates (#1045) ═══
//
// FAIL-BEFORE provenance: the pre-#1045 pump enqueued EVERY key of EVERY
// level up front (85 tiles for z0-z3) and retried on a fixed 250 ms tick
// forever. Measured on OpenFreeMap: one static z4 view = 85 tiles / 33 MB,
// 92 % of all traffic. The "deep levels never requested past the budget"
// and "backoff/give-up" assertions below fail against that behavior by
// construction.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { runSkeletonPrewarm, type SkeletonPrewarmHost } from './tile-skeleton-prewarm'

/** z/x/y → unique synthetic key whose level is recoverable as k/100000. */
const keyOf = (z: number, x: number, y: number): number => z * 100_000 + y * (1 << z) + x
/** z0..z3 pyramid opts shared by every gate (1 / 4 / 16 / 64 keys). */
const PYRAMID = { start: 0, cap: 3, keyOf, floorMaxTiles: 8 } as const

/** Fake host: `requested` records every prefetch; `deliver` moves keys to
 *  arrived with a per-level byte size (defaults mirror OFM: heavy low-z). */
function makeHost(sizes: Record<number, number>) {
  const requested: number[] = []
  const arrived = new Map<number, number>()
  const pinned = new Set<number>()
  let autoDeliver = true
  const levelOf = (k: number) => Math.floor(k / 100_000)
  const host: SkeletonPrewarmHost = {
    hasTileData: (k) => arrived.has(k),
    prefetchTiles: (ks) => {
      requested.push(...ks)
      if (autoDeliver) for (const k of ks) arrived.set(k, sizes[levelOf(k)] ?? 0)
    },
    markSkeleton: (ks) => {
      for (const k of ks) pinned.add(k)
    },
    unmarkSkeleton: (ks) => {
      for (const k of ks) pinned.delete(k)
    },
    bytesFor: (k) => arrived.get(k) ?? 0,
  }
  return {
    host,
    requested,
    arrived,
    pinned,
    setAutoDeliver: (v: boolean) => {
      autoDeliver = v
    },
    levelOf,
  }
}

const KB = 1024
const MB = 1024 * KB

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('skeleton prewarm — level-staged, byte-budgeted pump (#1045)', () => {
  it('stops deepening at the byte budget: z3 is NEVER requested and its keys stay unpinned', () => {
    // OFM-like sizes: z0 80 KB, z1 200 KB, z2/z3 400 KB per tile.
    const f = makeHost({ 0: 80 * KB, 1: 200 * KB, 2: 400 * KB, 3: 400 * KB })
    runSkeletonPrewarm(f.host, { ...PYRAMID, byteBudget: 4 * MB })
    vi.runAllTimers()

    const byLevel = (z: number) => f.requested.filter((k) => f.levelOf(k) === z).length
    expect(byLevel(0)).toBe(1) // floor complete
    expect(byLevel(1)).toBe(4) // floor complete
    // z2 partially fetched: floor 0.88 MB + 2-tile waves of 0.8 MB cross
    // the 4 MB budget after 8 tiles (0.88 + 8×0.4 = 4.08 ≥ 4).
    expect(byLevel(2)).toBeGreaterThanOrEqual(2)
    expect(byLevel(2)).toBeLessThan(16)
    // The pre-#1045 pump requested all 64 z3 keys up front — this is the
    // fail-before assertion.
    expect(byLevel(3)).toBe(0)
    // Budget stop released every pin that never arrived; arrived keys stay.
    for (const k of f.pinned) expect(f.arrived.has(k)).toBe(true)
    expect([...f.pinned].filter((k) => f.levelOf(k) === 3)).toHaveLength(0)
  })

  it('floor levels always complete even with a zero budget', () => {
    const f = makeHost({ 0: 80 * KB, 1: 200 * KB, 2: 400 * KB, 3: 400 * KB })
    runSkeletonPrewarm(f.host, { ...PYRAMID, byteBudget: 0 })
    vi.runAllTimers()
    expect(f.requested.filter((k) => f.levelOf(k) === 0)).toHaveLength(1)
    expect(f.requested.filter((k) => f.levelOf(k) === 1)).toHaveLength(4)
    expect(f.requested.filter((k) => f.levelOf(k) >= 2)).toHaveLength(0)
  })

  it('level staging: z1 is not requested until z0 arrived', () => {
    const f = makeHost({ 0: 80 * KB, 1: 200 * KB, 2: 400 * KB, 3: 400 * KB })
    f.setAutoDeliver(false)
    runSkeletonPrewarm(f.host, { ...PYRAMID, byteBudget: 4 * MB })
    // First wave: only the z0 root, nothing deeper while it is in flight.
    expect(f.requested.every((k) => f.levelOf(k) === 0)).toBe(true)
    // Deliver z0, tick: now (and only now) z1 keys go out.
    f.arrived.set(f.requested[0], 80 * KB)
    vi.advanceTimersByTime(250)
    expect(f.requested.some((k) => f.levelOf(k) === 1)).toBe(true)
    expect(f.requested.some((k) => f.levelOf(k) >= 2)).toBe(false)
  })

  it('gives up after stalled ticks with exponential backoff and unpins the stragglers', () => {
    const f = makeHost({ 0: 80 * KB })
    f.setAutoDeliver(false) // source never delivers
    runSkeletonPrewarm(f.host, { ...PYRAMID, byteBudget: 4 * MB })
    const afterFirstWave = f.requested.length
    expect(afterFirstWave).toBeGreaterThan(0)
    // Backoff schedule 500/1000/2000/4000/8000… — run far past it.
    vi.advanceTimersByTime(60_000)
    const totalRequested = f.requested.length
    // Give-up released every never-arrived pin…
    expect(f.pinned.size).toBe(0)
    // …and the pump is dead: more time produces no more requests.
    vi.advanceTimersByTime(60_000)
    expect(f.requested.length).toBe(totalRequested)
  })

  it('stop() cancels the pump immediately', () => {
    const f = makeHost({ 0: 80 * KB, 1: 200 * KB })
    f.setAutoDeliver(false)
    const handle = runSkeletonPrewarm(f.host, { ...PYRAMID, byteBudget: 4 * MB })
    const n = f.requested.length
    handle.stop()
    vi.advanceTimersByTime(60_000)
    expect(f.requested.length).toBe(n)
  })
})
