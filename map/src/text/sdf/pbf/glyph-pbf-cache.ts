// Range-keyed fetcher + cache for MapLibre glyph PBFs.
//
// MapLibre serves glyphs in 256-codepoint ranges (`0-255`, `256-511`,
// …) under a URL template like
//   https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf
// We fetch lazily on first request, cache decoded glyphs by codepoint,
// dedupe in-flight requests, and silently mark ranges as `failed` so
// the caller's offline fallback path stays in charge after one miss.

import { decodeGlyphsPbf, type PbfGlyph } from './glyphs-proto'
import type { GlyphProvider } from './glyph-provider'
import { assertSafeRemoteUrl, readBodyCapped, safeFetch, xlog } from '@xgis/shared'

/** DoS ceiling for a glyph PBF range. A 256-codepoint range is ~tens of
 *  KB; 8 MB is far above any legitimate range yet bounds a size-bomb. */
const MAX_GLYPH_BYTES = 8 * 1024 * 1024

/** Byte ceiling for RESIDENT decoded glyph bitmaps (#1580 leg A). A range's
 *  decoded bitmaps run ~0.15-0.25 MB (up to `MAX_GLYPHS_PER_STACK = 1024`
 *  glyphs of `(w+6)*(h+6)` bytes each, copied out of the PBF response by
 *  `glyphs-proto.ts`), and this cache had no cap at all — every range a
 *  session ever touched was retained until `map.destroy()`. `loading` /
 *  `failed` entries are single-word state and stay uncapped; only `loaded`
 *  entries carry the bitmaps this bounds. ~150 ranges' worth — generous for
 *  a real bilingual session, bounded against an unbounded pan. */
const MAX_RETAINED_BYTES = 32 * 1024 * 1024

/** How long one outstanding range request holds the render loop awake (#2116).
 *
 *  The loop must stay warm while a glyph range is in flight — otherwise `idle` fires on a
 *  frame whose labels are still metrics-only (all-zero SDF) and a settle-on-idle harness
 *  samples inkless text. But it must stop, unconditionally: `safeFetch` has no timeout, so
 *  a glyph host that accepts the connection and never answers would otherwise pin the loop
 *  for the session — the exact never-idle wedge #2091 was, one resource class over. Past
 *  this deadline the range is simply no longer counted; nothing else about it changes (a
 *  late arrival still fires `onLanded` and still upgrades the atlas slot).
 *
 *  Sized off the sibling safety nets rather than invented: the LOD readiness gate holds for
 *  5 s and the raster ledger abandons a tile after ~10.5 s of retries. */
const GLYPH_INFLIGHT_KEEP_WARM_MS = 10_000

type RangeState =
  | { status: 'loading' }
  | { status: 'loaded'; glyphs: Map<number, PbfGlyph>; bytes: number }
  | { status: 'failed' }

function bytesOf(glyphs: Map<number, PbfGlyph>): number {
  let bytes = 0
  for (const g of glyphs.values()) bytes += g.bitmap.byteLength
  return bytes
}

export interface GlyphPbfCacheOptions {
  glyphsUrl: string
  fetch?: typeof globalThis.fetch
}

const RANGE_SIZE = 256

function rangeStartOf(codepoint: number): number {
  return Math.floor(codepoint / RANGE_SIZE) * RANGE_SIZE
}

/** Cache key for a (fontstack, range) pair. The separator is an escaped NUL:
 *  a fontstack name may legally contain spaces and commas ("Noto Sans CJK KR
 *  Regular"), so no printable delimiter is collision-free. Written as the
 *  `\u0000` ESCAPE, never a raw byte — a raw NUL makes this file binary to
 *  git/grep/diff. This key is INTERNAL: never interpolate it into a log line
 *  (#1848 — a console truncates the message at the NUL). */
function rangeKey(fontstack: string, rangeStart: number): string {
  return `${fontstack}\u0000${rangeStart}`
}

/** The range as MapLibre names it in a URL and as a human reads it: `0-255`.
 *  One authority so a warning names exactly the range that was requested. */
function rangeLabel(rangeStart: number): string {
  return `${rangeStart}-${rangeStart + RANGE_SIZE - 1}`
}

function buildUrl(template: string, fontstack: string, rangeStart: number): string {
  return template
    .replace('{fontstack}', encodeURIComponent(fontstack))
    .replace('{range}', rangeLabel(rangeStart))
}

export class GlyphPbfCache implements GlyphProvider {
  private readonly glyphsUrl: string
  private readonly fetchFn: typeof globalThis.fetch
  /** Map insertion order = LRU order for `loaded` entries (oldest first) —
   *  the same convention `AtlasState` uses. `get()` bumps a hit to the back
   *  by delete+reinsert; `loading`/`failed` entries are never bumped or
   *  evicted, so their relative order is irrelevant to eviction. */
  private readonly ranges = new Map<string, RangeState>()
  private retainedBytes = 0

  constructor(opts: GlyphPbfCacheOptions) {
    this.glyphsUrl = opts.glyphsUrl
    this.fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis)
  }

  /** Sync lookup. Returns the glyph iff its range is loaded AND the
   *  glyph is present in that range. Misses (range not loaded yet,
   *  range failed, or glyph not in the PBF) all return undefined. */
  get(fontstack: string, codepoint: number): PbfGlyph | undefined {
    const key = rangeKey(fontstack, rangeStartOf(codepoint))
    const state = this.ranges.get(key)
    if (!state || state.status !== 'loaded') return undefined
    // Bump LRU on a hit — delete+reinsert moves it to the back (most recent).
    this.ranges.delete(key)
    this.ranges.set(key, state)
    return state.glyphs.get(codepoint)
  }

  /** True iff the (fontstack, range) has reached a terminal state
   *  (loaded or failed) — i.e. callers should NOT call ensureRange
   *  again for this codepoint. */
  isResolved(fontstack: string, codepoint: number): boolean {
    const state = this.ranges.get(rangeKey(fontstack, rangeStartOf(codepoint)))
    return state !== undefined && state.status !== 'loading'
  }

  /** GlyphProvider.ensure — trigger a fetch for the range containing
   *  `codepoint` if it hasn't been started yet. Idempotent: subsequent
   *  calls for the same (fontstack, range) attach more `onReady`
   *  callbacks rather than firing a duplicate request. Fires the
   *  callback synchronously if the range is already loaded.
   *
   *  A range that RESOLVES fires its queued callbacks either way (#1574) — the caller has
   *  to learn that no glyph is coming, or it draws a placeholder forever. A range that has
   *  ALREADY failed does not: it returns without queueing, so a re-raster prompted by that
   *  very notification cannot loop. */
  ensure(fontstack: string, codepoint: number, onReady: () => void): void {
    const start = rangeStartOf(codepoint)
    const key = rangeKey(fontstack, start)
    const state = this.ranges.get(key)

    if (state?.status === 'loaded') {
      // Bump LRU on a hit — see `get()`.
      this.ranges.delete(key)
      this.ranges.set(key, state)
      onReady()
      return
    }
    if (state?.status === 'failed') return // session-permanent silent fallback
    if (state?.status === 'loading') {
      const pending = this.pendingCallbacks.get(key)
      if (pending) pending.push(onReady)
      else this.pendingCallbacks.set(key, [onReady])
      return
    }

    // Fresh fetch.
    this.ranges.set(key, { status: 'loading' })
    this.pendingCallbacks.set(key, [onReady])
    this.loadingSince.set(key, performance.now())
    const url = buildUrl(this.glyphsUrl, fontstack, start)

    // SSRF guard: a private/loopback or non-http(s) glyph URL degrades to
    // the silent 'failed' fallback (no fetch issued) — never crashes the
    // caller, never probes an internal host.
    try {
      assertSafeRemoteUrl(url, 'glyph URL')
    } catch {
      this.ranges.set(key, { status: 'failed' })
      this.pendingCallbacks.delete(key)
      this.loadingSince.delete(key)
      return
    }

    // safeFetch re-validates every redirect hop (following manually) so an
    // allowlisted glyph host can't 302 to a private/loopback address; the
    // injected fetch is threaded through for test parity.
    // #1574 — three concerns one `.catch` used to merge, now separated:
    //
    //  • the FETCH/DECODE chain is what `.catch` may judge, and only that. The callback
    //    loop used to sit inside the `.then`, so a throwing callback rejected the
    //    then-promise and the catch overwrote an ALREADY-LOADED range with `failed`,
    //    discarding decoded glyphs and skipping the remaining callbacks.
    //  • the CALLBACKS run in `.finally`, after the state is written, so nothing they do
    //    can rewrite it — and each is wrapped individually, mirroring
    //    `ListenerRegistry.dispatch`.
    //  • a FAILED range still fires them. Deleting `pendingCallbacks` without firing meant
    //    `onLanded` never ran, so `host.invalidate` / `markLabelDirty` never ran and the
    //    frame kept believing glyphs were still coming — with the cached metrics-only slot
    //    (all-zero SDF) on screen for the session. Firing is what lets the rasterizer
    //    re-answer through its full Canvas2D path.
    safeFetch(url, undefined, 'glyph URL', this.fetchFn)
      .then(async (r) => {
        if (!r.ok) throw new Error(`status ${r.status}`)
        const stacks = decodeGlyphsPbf(await readBodyCapped(r, MAX_GLYPH_BYTES, 'glyph'))
        const stack = stacks.find((s) => s.name === fontstack) ?? stacks[0]
        if (!stack) throw new Error('no fontstack in PBF')
        const bytes = bytesOf(stack.glyphs)
        this.ranges.set(key, { status: 'loaded', glyphs: stack.glyphs, bytes })
        this.retainedBytes += bytes
        this.evictOverBudget()
      })
      .catch((err) => {
        this.ranges.set(key, { status: 'failed' })
        // No retries this session — but no longer silent either. One range is 256
        // codepoints (0-255 is all of Latin), so this is never a small loss.
        xlog.warn(
          `[X-GIS] glyph range "${fontstack}" ${rangeLabel(start)} failed to load — ` +
            'falling back to system fonts',
          err,
        )
      })
      .finally(() => this.fireCallbacks(key))
  }

  /** Run and clear the callbacks waiting on `key`, whatever the range's outcome. Each is
   *  isolated: one throwing host `onReady` must not cost its siblings their notification,
   *  and it must not reach the load state at all. */
  private fireCallbacks(key: string): void {
    // Terminal state reached (loaded or failed) — stop holding the loop awake for it. This
    // is the single funnel every settled range passes through, which is why the stamp is
    // cleared HERE and not in the `.then`/`.catch` arms that would each need their own.
    this.loadingSince.delete(key)
    const cbs = this.pendingCallbacks.get(key)
    this.pendingCallbacks.delete(key)
    if (!cbs) return
    for (const cb of cbs) {
      try {
        cb()
      } catch (err) {
        xlog.error('[X-GIS] glyph onReady callback threw', err)
      }
    }
  }

  /** Evict the least-recently-used `loaded` ranges until back under budget.
   *  A miss on an evicted range's next `ensure()` just refetches — the same
   *  contract the raster/hillshade tile caches make (raster-cache-budget.ts).
   *  `loading`/`failed` entries are skipped: they carry no bitmaps, so
   *  evicting them would only turn a resolved miss back into a re-fetch for
   *  no memory gained. */
  private evictOverBudget(): void {
    if (this.retainedBytes <= MAX_RETAINED_BYTES) return
    for (const [key, state] of this.ranges) {
      if (this.retainedBytes <= MAX_RETAINED_BYTES) break
      if (state.status !== 'loaded') continue
      this.ranges.delete(key)
      this.retainedBytes -= state.bytes
    }
  }

  /** GlyphProvider.hasPendingLoads — is a range request outstanding AND still inside its
   *  keep-warm deadline? Iterates only the in-flight set (normally empty, a handful during
   *  a cold label frame), never the resident cache, so the per-frame cost is O(in-flight).
   *
   *  Ranges past `GLYPH_INFLIGHT_KEEP_WARM_MS` are dropped from the set as they are
   *  observed, so a hung host costs one deadline's worth of warm frames once — not a
   *  permanently re-rendering map, and not a growing map of dead keys. */
  hasPendingLoads(): boolean {
    if (this.loadingSince.size === 0) return false
    const now = performance.now()
    let warm = false
    for (const [key, since] of this.loadingSince) {
      if (now - since <= GLYPH_INFLIGHT_KEEP_WARM_MS) warm = true
      else this.loadingSince.delete(key)
    }
    return warm
  }

  private readonly pendingCallbacks = new Map<string, Array<() => void>>()
  /** Start time of every range whose request has not reached a terminal state. Kept
   *  separate from `ranges` so the resident cache's LRU/eviction machinery stays a pure
   *  content store — the in-flight set has a different lifetime and a different reader. */
  private readonly loadingSince = new Map<string, number>()
}
