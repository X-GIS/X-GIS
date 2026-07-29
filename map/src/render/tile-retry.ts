// ═══ Tile REQUEST policy — failed-load backoff + cold-start budget ═══
//
// Shared by HillshadeRenderer (DEM tiles) and RasterRenderer (basemap tiles). Both
// halves answer the same question the renderer asks every frame: may this tile be
// requested now? They live together because they contend for the same scarce resource
// (the renderer's concurrency slots) and because a GPU-free unit test can settle either
// one, while the renderers themselves need a real device.
//
// A tile load that resolves null (404, network error, a decode/upload throw) leaves its
// key in NEITHER the tile cache NOR the in-flight set, so the very next frame
// re-requested it — forever, at ~60 fps.
//
// That is not a rare path. A DEM source has a real maximum zoom (the AWS terrarium
// bucket stops at z15) and `rasterCoverZoom` asks for zoom+1 on a 256-px source, so
// merely zooming past it makes EVERY visible tile a permanent 404; a raster source
// whose `maxzoom` sits below what the camera asks for reproduces the same shape. The
// retry storm then pins all of the renderer's concurrency slots with requests that can
// never succeed, starving the parent-fallback fetches that would still have had
// something to draw.
//
// `leafLoadBudget` / `COLD_START_PARENT_SLOTS` are consumed by the hillshade arm only —
// the raster arm's leaf and parent-fallback loops share one budget already. They stay
// here because they answer the same may-I-request question against the same slot pool.
//
// The policy lives here, apart from the renderers, for two reasons: both renderers are
// at their LOC ceilings, and a decision this load-bearing should be testable without a
// GPU context (the renderers need a real device; whether to re-request a tile does not).
//
// Not a permanent blocklist: state is per-source and the renderer drops it when the
// URL template changes, since a different template is a different coverage and says
// nothing about what failed before.

/** Backoff state the renderer keeps per failed tile key. */
export interface FailedTile {
  /** How many times this tile's load has resolved null. */
  attempts: number
  /** Frame counter value at the most recent failure. */
  lastFailedFrame: number
}

/** Attempts after which a tile is abandoned until the source is re-armed. */
export const MAX_TILE_ATTEMPTS = 4

/** Frames to wait before re-requesting a tile that has failed `attempts` times:
 *  30, 120, 480 (~0.5 s, 2 s, 8 s at 60 fps), then never. Exponential so a
 *  genuinely-missing tile costs a bounded, rapidly-shrinking share of the load
 *  budget while a transient blip still recovers quickly. */
export function retryDelayFrames(attempts: number): number {
  return 30 * Math.pow(4, Math.max(0, attempts - 1))
}

/** May this tile be requested on `frameCount`? True when it has never failed, or
 *  its backoff has elapsed and it has attempts left. */
export function tileRequestable(failed: FailedTile | undefined, frameCount: number): boolean {
  if (!failed) return true
  if (failed.attempts >= MAX_TILE_ATTEMPTS) return false
  return frameCount - failed.lastFailedFrame >= retryDelayFrames(failed.attempts)
}

/** Slots held back from the leaf loop on a cold start, for the parent-fallback
 *  prefetch that follows it. Two, because the fallback asks for 1 AND 2 levels up. */
export const COLD_START_PARENT_SLOTS = 2

/** How many of the `maxConcurrent` slots the LEAF (full-resolution) loop may take this
 *  frame.
 *
 *  The leaf loop runs first and breaks at the budget, so with the full budget it takes
 *  every slot and the parent-fallback prefetch below it gets NONE on the frame that
 *  matters — the first one. Nothing is then drawable until a full-resolution DEM tile
 *  lands, and DEM tiles are heavy: terrarium PNGs measure ~131–143 KB against ~19–28 KB
 *  for a satellite JPEG covering the same ground, because elevation cannot survive lossy
 *  compression. One COARSE tile covers 4x (one level up) or 16x (two) the area of a leaf
 *  for the same bytes, so spending two slots on ancestors is what puts relief on screen
 *  first, blurry, instead of leaving it empty.
 *
 *  Cold start ONLY (nothing cached). Once any tile is in hand there IS drawable
 *  coverage, and leaf-first priority resumes unchanged — it is load-bearing for pitched
 *  and mixed-LOD views, where requesting in draw order starved the actual visible leaves.
 *  A source swap that leaves the previous source's tiles cached does not re-trigger this;
 *  that case still has (stale) coverage to draw, which is the condition being protected. */
export function leafLoadBudget(maxConcurrent: number, cachedTiles: number): number {
  if (cachedTiles > 0) return maxConcurrent
  return Math.max(1, maxConcurrent - COLD_START_PARENT_SLOTS)
}

/** Fold one null load result into the backoff state for `key`. */
export function noteFailure(
  failed: Map<string, FailedTile>,
  key: string,
  frameCount: number,
): void {
  const prev = failed.get(key)
  failed.set(key, { attempts: (prev?.attempts ?? 0) + 1, lastFailedFrame: frameCount })
}
