// ═══ Tile pipeline simulator — CPU model of cache + upload throughput ═══
//
// Extends tile-pipeline-predictor.ts from "one frame's frustum demand" to
// "a sequence of frames' actual tile availability" by simulating three
// runtime-side constraints that shape the visible result:
//
//   1. GPU cache (bounded LRU) — MAX_GPU_TILES=512 in vector-tile-renderer.ts
//   2. Per-frame upload budget — MAX_UPLOADS_PER_FRAME=4
//   3. FIFO upload queue (`_pendingUploads`) that persists across frames
//
// The simulator answers the FLICKER-style question: "given this camera
// trajectory, how many tiles does each frame need but not have?" The
// predictor alone can't see this because it treats each frame
// independently — it doesn't model how a new tile gets promoted to the
// cache over multiple frames or how cache eviction interacts with the
// next frustum.
//
// This is a first-approximation model. The real runtime has additional
// state the simulator doesn't see (parent-tile fallback via
// firstIndexedAncestor, compile-budget gating in xgvt-source, per-source
// caches) — so simulated miss counts are a LOWER BOUND. A frame the
// simulator reports as healthy may still FLICKER in reality. A frame
// the simulator reports as missing N tiles DEFINITELY has at least N
// missing tiles.

import type { CameraStateInput, SourceMetaInput } from './tile-pipeline-predictor'
import { predictTilePipeline } from './tile-pipeline-predictor'

export interface SimulationOptions {
  /** GPU cache capacity in tiles. Default 512 (matches
   *  MAX_GPU_TILES in vector-tile-renderer.ts:51). */
  cacheSize?: number
  /** Max tile uploads per frame. Default 4 (matches
   *  MAX_UPLOADS_PER_FRAME in vector-tile-renderer.ts:67). */
  uploadBudgetPerFrame?: number
  /** Canvas dimensions for the frustum calculation. Default 1200×800. */
  canvasW?: number
  canvasH?: number
}

export interface FrameReport {
  /** 0-indexed frame number in the simulation. */
  frame: number
  /** Tiles the frustum wants this frame. Same number as
   *  `predictTilePipeline(...).cacheCapacityCheck.requestedCount` — a
   *  LOWER bound on true demand (may be clipped to MAX_FRUSTUM_TILES). */
  neededCount: number
  /** Current GPU cache occupancy at the END of this frame. */
  cacheSize: number
  /** Upload queue depth at the END of this frame. A monotone-growing
   *  backlog across frames means the upload budget can't keep up with
   *  the frustum demand. */
  backlogSize: number
  /** Tiles uploaded into the cache DURING this frame (≤ upload budget). */
  uploadedThisFrame: number
  /** Tiles the frustum wants but the cache doesn't have at end-of-frame.
   *  FLICKER warnings in the runtime correspond to a positive value
   *  here, modulo parent-fallback availability. */
  missedCount: number
}

export interface SimulationResult {
  perFrame: FrameReport[]
  /** Max misses seen in any frame. Peak pressure indicator. */
  peakMissed: number
  /** Final backlog size — if > 0 after the trajectory ends, the upload
   *  queue never drained and the simulation is still in transient
   *  state. Typical cause: sustained high-pitch frustum demand. */
  finalBacklog: number
  /** Final cache occupancy. */
  finalCacheSize: number
}

function tileKey(t: { z: number; x: number; y: number }): string {
  return `${t.z}/${t.x}/${t.y}`
}

/** Simulate the tile-pipeline over a sequence of camera states.
 *
 *  The model: each frame, the frustum requests a set of tiles. Tiles
 *  already in cache are marked "used" (lastUsed=frame). Missing tiles
 *  enter a FIFO upload queue (deduped against current queue + cache).
 *  Up to `uploadBudgetPerFrame` tiles drain from the queue into the
 *  cache; when the cache is full, LRU eviction runs — the oldest
 *  `lastUsed` entry that is NOT needed this frame gets evicted.
 *  Tiles needed but still absent at end-of-frame count as misses. */
export function simulateTilePipeline(
  trajectory: CameraStateInput[],
  source: SourceMetaInput,
  options: SimulationOptions = {},
): SimulationResult {
  const cacheSize = options.cacheSize ?? 512
  const uploadBudget = options.uploadBudgetPerFrame ?? 4
  const canvasW = options.canvasW ?? 1200
  const canvasH = options.canvasH ?? 800

  const cache = new Map<string, number>() // key → lastUsedFrame
  const uploadQueue: string[] = []
  const uploadQueueSet = new Set<string>() // dedup helper
  const perFrame: FrameReport[] = []
  let peakMissed = 0

  for (let f = 0; f < trajectory.length; f++) {
    const pred = predictTilePipeline(trajectory[f], source, canvasW, canvasH)
    const needed = pred.visibleTiles.map(tileKey)
    const neededSet = new Set(needed)

    // Mark already-cached tiles as used this frame.
    for (const k of needed) {
      if (cache.has(k)) cache.set(k, f)
    }

    // Enqueue missing tiles (skip if already queued or cached).
    for (const k of needed) {
      if (!cache.has(k) && !uploadQueueSet.has(k)) {
        uploadQueue.push(k)
        uploadQueueSet.add(k)
      }
    }

    // Process up to uploadBudget tiles from the queue.
    let uploadedThisFrame = 0
    while (uploadedThisFrame < uploadBudget && uploadQueue.length > 0) {
      const k = uploadQueue.shift()!
      uploadQueueSet.delete(k)

      // Skip if somehow already present (shouldn't happen with dedup).
      if (cache.has(k)) continue

      // Evict if cache is full.
      if (cache.size >= cacheSize) {
        // LRU: oldest lastUsed that isn't needed this frame.
        let oldestKey: string | null = null
        let oldestFrame = Infinity
        for (const [ck, cf] of cache) {
          if (neededSet.has(ck)) continue // protect in-frame tiles
          if (cf < oldestFrame) {
            oldestFrame = cf
            oldestKey = ck
          }
        }
        if (oldestKey !== null) cache.delete(oldestKey)
        // If every cached tile is needed this frame (cache thrashing),
        // skip this upload — we'd have to evict a needed tile.
        if (cache.size >= cacheSize) {
          uploadQueue.unshift(k)
          uploadQueueSet.add(k)
          break
        }
      }

      cache.set(k, f)
      uploadedThisFrame++
    }

    // Count tiles still missing at end-of-frame.
    let missedCount = 0
    for (const k of needed) {
      if (!cache.has(k)) missedCount++
    }
    if (missedCount > peakMissed) peakMissed = missedCount

    perFrame.push({
      frame: f,
      neededCount: needed.length,
      cacheSize: cache.size,
      backlogSize: uploadQueue.length,
      uploadedThisFrame,
      missedCount,
    })
  }

  return {
    perFrame,
    peakMissed,
    finalBacklog: uploadQueue.length,
    finalCacheSize: cache.size,
  }
}

/** Generate a simple pitch-sweep trajectory: `steps` frames ramping
 *  pitch from `pitchStart` to `pitchEnd`, plus `settleFrames` frames
 *  at the final pitch. Useful for reproducing FLICKER bugs that
 *  manifest during camera motion and persist afterward. */
export function makePitchSweep(
  base: Omit<CameraStateInput, 'pitch'>,
  pitchStart: number,
  pitchEnd: number,
  steps: number,
  settleFrames: number = 0,
): CameraStateInput[] {
  const trajectory: CameraStateInput[] = []
  for (let i = 0; i < steps; i++) {
    const t = steps <= 1 ? 1 : i / (steps - 1)
    trajectory.push({ ...base, pitch: pitchStart + (pitchEnd - pitchStart) * t })
  }
  for (let i = 0; i < settleFrames; i++) {
    trajectory.push({ ...base, pitch: pitchEnd })
  }
  return trajectory
}
