// ═══ Hillshade DEM tile failed-load backoff ═══
//
// A DEM tile load that resolves null (404, network error, a decode/upload throw)
// leaves its key in NEITHER the tile cache NOR the in-flight set, so the very next
// frame re-requested it — forever, at ~60 fps.
//
// That is not a rare path. A DEM source has a real maximum zoom (the AWS terrarium
// bucket stops at z15) and `rasterCoverZoom` asks for zoom+1 on a 256-px source, so
// merely zooming past it makes EVERY visible tile a permanent 404. The retry storm
// then pins all of the renderer's concurrency slots with requests that can never
// succeed, starving the parent-fallback fetches that would still have had something
// to draw.
//
// The policy lives here, apart from the renderer, for two reasons: the renderer is
// at its LOC ceiling, and a decision this load-bearing should be testable without a
// GPU context (HillshadeRenderer needs a real device; whether to re-request a tile
// does not).
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

/** Fold one null load result into the backoff state for `key`. */
export function noteFailure(
  failed: Map<string, FailedTile>,
  key: string,
  frameCount: number,
): void {
  const prev = failed.get(key)
  failed.set(key, { attempts: (prev?.attempts ?? 0) + 1, lastFailedFrame: frameCount })
}
