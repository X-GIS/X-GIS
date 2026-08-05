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

/** The retry clock. Wall time, not rendered frames (#1575) — a function rather than a
 *  bare `Date.now()` at each call site so one import names the clock, and so a suite
 *  driving `vi.useFakeTimers()` moves every reader of it together. */
export function nowMs(): number {
  return Date.now()
}

/** Backoff state the renderer keeps per failed tile key. */
export interface FailedTile {
  /** How many times this tile's load has resolved null. */
  attempts: number
  /** WALL-CLOCK ms at the most recent failure (#1575).
   *
   *  This was a RENDERED-FRAME counter, and the counter only advances inside `render()`.
   *  A failed-and-awaiting-retry tile was invisible to every keep-warm predicate, so on a
   *  static camera the loop stopped, the counter froze, and `>= 30 frames` became
   *  unreachable — a transiently failed basemap tile was a permanent hole even after the
   *  server recovered. Wall time advances whether or not anything renders; the loop still
   *  has to be kept warm long enough to READ it, which is `hasPendingRetries` below. */
  lastFailedMs: number
}

/** Attempts after which a tile is abandoned until the source is re-armed. */
export const MAX_TILE_ATTEMPTS = 4

/** How long to wait before re-requesting a tile that has failed `attempts` times:
 *  0.5 s, 2 s, 8 s, then never. Exponential so a genuinely-missing tile costs a bounded,
 *  rapidly-shrinking share of the load budget while a transient blip still recovers
 *  quickly. These are the same durations the frame-counter version intended (30/120/480
 *  frames at 60 fps) — measured in the only clock that runs when the map is idle. */
export function retryDelayMs(attempts: number): number {
  return 500 * Math.pow(4, Math.max(0, attempts - 1))
}

/** May this tile be requested at `nowMs`? True when it has never failed, or its backoff
 *  has elapsed and it has attempts left. */
export function tileRequestable(failed: FailedTile | undefined, nowMs: number): boolean {
  if (!failed) return true
  if (failed.attempts >= MAX_TILE_ATTEMPTS) return false
  return nowMs - failed.lastFailedMs >= retryDelayMs(failed.attempts)
}

/** Is any tile waiting out a backoff it will come back from? The renderers OR this into
 *  the keep-warm gate, because the retry is only ever re-attempted from inside `render()`
 *  — a wall clock nothing reads is no better than a frozen one.
 *
 *  Bounded by construction, and that is the whole difference from the never-idling vector
 *  case: a tile gets `MAX_TILE_ATTEMPTS` tries over ~10.5 s and is then abandoned, so this
 *  goes false and the loop idles. It is true only while tiles are actually failing. */
export function hasPendingRetries(failed: ReadonlyMap<string, FailedTile>): boolean {
  for (const f of failed.values()) {
    if (f.attempts < MAX_TILE_ATTEMPTS) return true
  }
  return false
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

/** Hard cap on a renderer's failed-tile ledger (#1575).
 *
 *  Mirrors `vector-tile-loader`'s `NEGATIVE_CACHE_MAX_ENTRIES`, and for the same reason:
 *  panning across a broken region inserts one entry per tile that is never revisited.
 *  Unlike that one these entries have no TTL to bound them — the abandon-until-re-armed
 *  contract above is deliberate and gated (`tile-retry.test.ts`, `#1269` owns whether it
 *  should change) — so the cap is the only bound there is. Two of the three failed-tile
 *  ledgers in this repo were unbounded; this is the second one closed. */
export const MAX_FAILED_TILES = 4096

/** Fold one null load result into the backoff state for `key`, at wall-clock `nowMs`.
 *
 *  FIFO-evicts the oldest entries past the cap (Map preserves insertion order). An evicted
 *  key simply becomes requestable again, which is the safe direction to fail: the worst
 *  case is one extra request for a tile the user panned away from long ago. */
export function noteFailure(failed: Map<string, FailedTile>, key: string, nowMs: number): void {
  const prev = failed.get(key)
  failed.set(key, { attempts: (prev?.attempts ?? 0) + 1, lastFailedMs: nowMs })
  while (failed.size > MAX_FAILED_TILES) {
    const oldest = failed.keys().next().value
    if (oldest === undefined) break
    failed.delete(oldest)
  }
}

/** One renderer's failed-tile ledger: the backoff state, the cap, and the three questions
 *  the render loop asks of it. An owned type rather than a bare `Map` at each renderer
 *  (#1575) because the policy had drifted into three separate copies across this repo —
 *  the raster arm, the DEM arm and `pmtiles-backend` — of which only the vector one was
 *  bounded. Keeping the Map private is what stops a fourth interpretation appearing. */
export class FailedTileLedger {
  private readonly failed = new Map<string, FailedTile>()

  /** May this tile be requested right now? */
  requestable(key: string): boolean {
    return tileRequestable(this.failed.get(key), nowMs())
  }

  /** Fold a settled load into the ledger. `aborted` is the one case that must NOT count:
   *  a zoom change cancels every in-flight finer tile, and cancellation resolves `null`
   *  exactly like a 404, so four oscillations across an LOD boundary used to blocklist
   *  the very tiles the user was looking at. The header above names the set this ledger
   *  is for, and cancellation was never in it. */
  noteOutcome(key: string, aborted: boolean): void {
    if (!aborted) noteFailure(this.failed, key, nowMs())
  }

  /** A successful load clears the tile's history. */
  clear(key: string): void {
    this.failed.delete(key)
  }

  /** A new URL template is a different coverage and says nothing about what failed. */
  clearAll(): void {
    this.failed.clear()
  }

  /** Is any tile still inside a backoff it will come back from? */
  hasPendingRetries(): boolean {
    return hasPendingRetries(this.failed)
  }

  /** Entry count — for the bound's own gate. */
  get size(): number {
    return this.failed.size
  }
}
