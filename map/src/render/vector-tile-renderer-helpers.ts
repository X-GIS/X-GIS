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
/** Per-frame tile upload cap. Bumped to 4 after the over-zoom
 *  per-layer sub-tile fix made all 4 layers actually generate
 *  sub-tiles (previously only the first one did due to the
 *  hasTileData(key) skip bug). At 4 layers × ~30 visible sub-tiles
 *  = 120 slices to upload at over-zoom; 2/frame took ~1 s to fill
 *  ≈ visible flicker as fallback gets progressively replaced.
 *  4/frame halves convergence time to ~0.5 s while keeping GPU
 *  buffer creation rate (~1700/sec) below Chrome's STATUS_BREAKPOINT
 *  threshold even under 4-layer load. */
const MAX_UPLOADS_PER_FRAME = 4
/** Mobile-specific upload budget — main-thread `buildLineSegments`
 *  runs synchronously on every doUploadTile for the XGVT-binary path
 *  (PMTiles' worker decode bypasses it). Capping mobile uploads to
 *  1/frame stretches the CPU work over more frames so a flurry of
 *  zoom-out fetches can't stall the render loop. Tile catch-up takes
 *  ~4× the wall time, but visible during gestures (settled state
 *  is identical). User-reported heat + forced refresh on mobile
 *  during fast pinch zoom motivated this; addresses the synchronous
 *  CPU spike that the GPU buffer pool change alone could not. */
export function uploadBudgetFor(canvasW: number, canvasH: number, dpr: number = 1): number {
  // Test hook: spec sets `globalThis.__XGIS_UPLOAD_BUDGET` to force
  // queue-deferred uploads on every render call so the parent-walk
  // fallback path is exercised deterministically. Production paths
  // never set this, so the constant lookup is a single property read.
  const o = (globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET
  if (typeof o === 'number') return o
  // Mobile classification is a perceptual concept — must use CSS
  // pixels. A DPR=3 phone's device-pixel canvas is 1290×2235, which
  // would (incorrectly) read as "desktop" and bump the budget from 1
  // to 4 uploads/frame — exactly the spike the function exists to
  // prevent. `isMobileClassViewport` (the shared authority) also gates
  // on a coarse PRIMARY pointer, so a small DESKTOP window keeps 4.
  return isMobileClassViewport(Math.max(canvasW, canvasH) / dpr) ? 1 : MAX_UPLOADS_PER_FRAME
}
