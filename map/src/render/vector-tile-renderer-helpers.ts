// ═══ Vector Tile Renderer — Pure Helpers ═══
// Top-level pure free functions extracted verbatim from
// vector-tile-renderer.ts (no `this`, no module-mutable state, no side
// effects beyond reading the environment). The constants below are used
// only by these functions and travel with them. Behaviour-preserving
// structural split only; no logic or symbol renames.

import { isMobileClassViewport } from '@xgis/shared'

// Per-VTR GPU tile cache cap on UNIQUE tile keys. With sliced
// sources (PMTiles N-layer) one tile = N entries × ~7 buffers.
// Capping at 256 unique keys × 4 typical layers × 7 = ~7K live GPU
// buffers — well within Chrome's tolerance now that the previous
// STATUS_BREAKPOINT root causes are fixed (vertexKey int32 overflow
// inflating vertex counts, missing per-layer decoder filter
// loading 10+ unused slices per tile, duplicate LoadCommands
// spawning 4× orphan VTRs all hammering GPU).
const MAX_GPU_TILES_DESKTOP = 256
/** Mobile cap on UNIQUE tile keys held in gpuCache. Real-device
 *  iPhone inspector showed gpu cache at 733 entries (146 unique
 *  keys × 5 layers = 730 entries) for a 256-unique cap — plenty
 *  of GPU memory retained while only ~50 unique keys were on
 *  screen. 64 unique × 5 layers = 320 entries puts the resident
 *  GPU footprint at roughly 1/2.3 of the desktop ceiling without
 *  forcing visible-tile thrash (visible viewport on a mobile
 *  canvas is 10-20 unique keys at any settled zoom). */
const MAX_GPU_TILES_MOBILE = 64
export function getMaxGpuTiles(): number {
  const w = (typeof window !== 'undefined' ? window.innerWidth : 0) || 0
  return w > 0 && w <= 900 ? MAX_GPU_TILES_MOBILE : MAX_GPU_TILES_DESKTOP
}
/** Byte-pressure hysteresis band for the polygon arenas. Eviction is
 *  triggered on UNIQUE-TILE-COUNT (getMaxGpuTiles), but the arena hard
 *  limit is BYTES (64 MB). Large globe / extruded tiles can exhaust the
 *  arena before the count cap is reached, so beginFrame ALSO triggers
 *  eviction when an arena's bump high-water mark crosses HIGH_WATER, and
 *  evictGPUTiles drains LRU unprotected tiles until LIVE bytes fall below
 *  LOW_WATER. The gap (75 % trigger → 60 % drain) prevents per-frame
 *  thrash; under healthy small-tile Mercator load live bytes stay well
 *  under HIGH_WATER, so this path never fires and the count path is
 *  unchanged. Placed next to getMaxGpuTiles so a future mobile-specific
 *  band is easy. */
export const ARENA_HIGH_WATER = 0.75
export const ARENA_LOW_WATER = 0.6
/** Max tiles promoted from data cache to GPU per frame. Chosen empirically:
 *  crossing a z-boundary produces ~16 newly-visible tiles, and uploading
 *  them all in one frame caused ~250 ms stalls (perf-scenarios benchmark,
 *  wb_peak 552 calls / 8.4 MB in a single frame). 3 per frame spreads the
 *  work across ~5–6 frames → worst spike drops to <50 ms with the cache
 *  reaching full visibility in ~100 ms. Raise if you see noticeable
 *  "filling in" during pans on fast connections. */
/** Per-frame tile upload cap (steady state) — 4 desktop / 1 mobile via
 *  uploadBudgetFor.
 *
 *  #1155 F3 burst-safety (the burst path raises this to 8 desktop / 4 mobile via
 *  the single-authority `burstUploadBudget` below). The failure mode this cap
 *  guards is a PER-FRAME spike, not a sustained per-second rate: the historic
 *  incident was 552 buffer writes / 8.4 MB in ONE frame → a ~250 ms stall
 *  (perf-scenarios wb_peak). At COLD START — the exact window burst runs in —
 *  the reuse pools are still cold, so per-slice buffer creation is HIGHER than
 *  steady state, not "almost all reuse": polygon vertex/index write into the
 *  shared GPUArenas (ZERO creates), but the thin line/outline vertex+index
 *  buffers (GpuTileStore.acquireBuffer, gpu-tile-store.ts:307-313) all MISS
 *  until the first tile evictions feed the pool, the per-slice feat_data buffer
 *  is an unconditional create (feature-data-binder.ts), the SDF segments add ≤2,
 *  and the staging pool creates one buffer per tier until warm (7 tiers, then
 *  reuse) — realistically ~5-6 creates/slice during the first cascade. 8 slices/
 *  frame ⇒ ~40-48 creates/frame, ~11× UNDER the 552-in-one-frame spike. Crucially
 *  burst does NOT raise the cold-start TOTAL (bounded by viewport tiles × layers);
 *  it compresses that fixed one-time cascade into ~half the frames, at most
 *  doubling the per-frame density vs the steady 4/frame cascade that already runs
 *  cold today — so a burst frame self-throttles to ~20-25 ms (below 60 fps, not a
 *  stall), the cascade drains in ~15 frames, and the window is bounded by the
 *  map's exit predicate + the 10 s hard cap. If a future cold-start profile shows
 *  the per-frame spike climbing toward 552, drop the desktop burst to 6 in
 *  `burstUploadBudget` — the enqueue cap follows it through the shared authority. */
const MAX_UPLOADS_PER_FRAME = 4

/** #1155 F3 — cold-start burst upload budget: 8 desktop / 4 mobile. SINGLE
 *  AUTHORITY for the burst pair, read by BOTH `uploadBudgetFor` (concurrent
 *  upload maxJobs) and UploadCoordinator's per-frame slice-enqueue cap — the two
 *  MUST stay in lockstep or over-cap slices churn through `_heldUploads` (a
 *  maxJobs < cap split re-defers work every frame). See the burst-safety note on
 *  MAX_UPLOADS_PER_FRAME above for why 8 is safe and how to retune it. */
export function burstUploadBudget(mobile: boolean): number {
  return mobile ? 4 : 8
}
/** Mobile-specific upload budget — main-thread `buildLineSegments`
 *  runs synchronously on every doUploadTile for the XGVT-binary path
 *  (PMTiles' worker decode bypasses it). Capping mobile uploads to
 *  1/frame stretches the CPU work over more frames so a flurry of
 *  zoom-out fetches can't stall the render loop. Tile catch-up takes
 *  ~4× the wall time, but visible during gestures (settled state
 *  is identical). User-reported heat + forced refresh on mobile
 *  during fast pinch zoom motivated this; addresses the synchronous
 *  CPU spike that the GPU buffer pool change alone could not. */
export function uploadBudgetFor(
  canvasW: number,
  canvasH: number,
  dpr: number = 1,
  /** #1155 F3 — cold-start burst: raise the concurrent-upload cap to 8 desktop
   *  / 4 mobile so the first-viewport cascade drains fast. Off by default so
   *  the steady-state budget (and every existing caller) is unchanged. */
  burst: boolean = false,
): number {
  // Test hook: spec sets `globalThis.__XGIS_UPLOAD_BUDGET` to force
  // queue-deferred uploads on every render call so the parent-walk
  // fallback path is exercised deterministically. Production paths
  // never set this, so the constant lookup is a single property read.
  // Kept FIRST — the forced value must win even under burst so the fallback
  // path stays deterministically exercisable (#1155 F3).
  const o = (globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET
  if (typeof o === 'number') return o
  // Mobile classification is a perceptual concept — must use CSS
  // pixels. A DPR=3 phone's device-pixel canvas is 1290×2235, which
  // would (incorrectly) read as "desktop" and bump the budget from 1
  // to 4 uploads/frame — exactly the spike the function exists to
  // prevent. `isMobileClassViewport` (the shared authority) also gates
  // on a coarse PRIMARY pointer, so a small DESKTOP window keeps 4.
  const mobile = isMobileClassViewport(Math.max(canvasW, canvasH) / dpr)
  if (burst) return burstUploadBudget(mobile)
  return mobile ? 1 : MAX_UPLOADS_PER_FRAME
}
