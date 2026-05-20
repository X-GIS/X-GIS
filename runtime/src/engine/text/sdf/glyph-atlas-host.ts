// ═══════════════════════════════════════════════════════════════════
// Glyph Atlas Host (Batch 1c-6d)
// ═══════════════════════════════════════════════════════════════════
//
// The orchestration layer: wires `AtlasState` (where does each glyph
// live?) + `GlyphRasterizer` (what does each glyph look like?) + a
// dirty-queue protocol the GPU wrapper drains to upload new SDF
// bytes to the texture. No GPU dependencies — fully testable.
//
// Per-glyph layout metrics live alongside the slot so the text
// shaper (1c-7) gets everything it needs from one lookup. We CACHE
// the rasterized metrics rather than re-rasterising on every shape
// pass: glyph metrics are stable within a (font, size) so this is
// cheap and avoids running the rasterizer on every frame for the
// same string.

import {
  AtlasState, type AtlasConfig, type AtlasSlot, type GlyphKey,
} from './atlas-state'
import type {
  GlyphRasterizer, GlyphRasterResult,
} from './glyph-rasterizer'

export interface GlyphInfo {
  codepoint: number
  slot: AtlasSlot
  /** Pen advance after drawing (px). */
  advanceWidth: number
  /** Pen → glyph-bbox left edge (px). */
  bearingX: number
  /** Baseline → glyph-bbox top edge (px, positive up). */
  bearingY: number
  width: number
  height: number
  /** SDF source — see GlyphRasterResult.pbf. Threaded through so the
   *  renderer can pick the matching halo-width normalisation. */
  pbf: boolean
  /** Pixel size this glyph's SDF + metrics were baked at (see
   *  GlyphRasterResult.rasterFontSize). Per-glyph so a label mixing
   *  24-px PBF Latin and DPR-scaled local Hangul scales each run
   *  correctly. Optional only to keep external test fixtures terse;
   *  the host always populates it — consumers fall back to the
   *  draw-level rasterFontSize when absent. */
  rasterFontSize?: number
}

export interface DirtyGlyph {
  key: GlyphKey
  slot: AtlasSlot
  /** SDF bitmap. slotSize × slotSize, tiny-sdf packing. */
  sdf: Uint8Array
}

export interface GlyphAtlasHostOptions {
  /** Pixel size to rasterise at. One size per atlas keeps the slot
   *  count manageable; the shader scales for display. */
  fontSize: number
  /** SDF falloff radius in pixels. Determines the aliasing budget. */
  sdfRadius: number
}

interface CachedMetrics {
  advanceWidth: number
  bearingX: number
  bearingY: number
  width: number
  height: number
  pbf: boolean
  rasterFontSize: number
}

export class GlyphAtlasHost {
  readonly state: AtlasState
  private readonly rasterizer: GlyphRasterizer
  private readonly fontSize: number
  private readonly sdfRadius: number
  /** Per-glyph layout metrics, keyed by numeric encoding (iter 129 —
   *  was Map<string> with template-literal allocations dominating the
   *  glyph-atlas hot path at z=14 / z=16-p60). Uses the same
   *  fontKey→fontId interning as AtlasState below. */
  private readonly metrics = new Map<number, CachedMetrics>()
  /** iter-205 — cached GlyphInfo objects per metricsKey. Cache HIT in
   *  `ensure()` previously allocated a new GlyphInfo object every call;
   *  at ~3000 ensures/frame (300 labels × 10 chars at z=14 OFM Bright)
   *  that's ~3k obj allocs/frame just for the return wrapper, dominant
   *  contributor to the 4.5% GC samples in the iter-197 CPU profile.
   *  Cache is invalidated on slot eviction (same site that bumps
   *  _generation) AND on `invalidate()` (PBF upgrade path — fresh
   *  GlyphInfo built next ensure call after re-raster). */
  private readonly infoCache = new Map<number, GlyphInfo>()
  /** iter-233 — string-level GlyphInfo[] cache. ensureString allocates
   *  a fresh array per call + does N codepoint lookups; at 300 labels
   *  × 10 chars/frame on z=14 OFM Bright that's ~3k array allocs and
   *  ~3k codePointAt iterations per frame. Memory note
   *  project_merc_high_pitch_drag_2026_05_20 pins ~21.5 % of drag CPU
   *  on the ensureString / ensure path; same-text-second-frame call
   *  should short-circuit.
   *
   *  iter-167/168 attempted this and was reverted (iter-175) because
   *  the per-frame eviction drain corrupted cached arrays whose
   *  GlyphInfo entries referenced slots reclaimed mid-frame. iter-190
   *  added `_generation` (bumps on EVERY slot reuse, including
   *  mid-frame), so a `{ info, generation }` envelope makes any
   *  post-eviction read a clean miss — re-runs the full ensure loop
   *  and re-caches.
   *
   *  Cached array is shared by reference; callers must treat it
   *  read-only (matches the existing infoCache contract). */
  private readonly stringInfoCache = new Map<string, { info: GlyphInfo[]; generation: number }>()
  /** Newly rasterised glyphs awaiting GPU upload. Drained by
   *  the GPU wrapper via `consumeDirty()`. */
  private dirty: DirtyGlyph[] = []
  /** Newly evicted glyphs whose vertex data the renderer needs to
   *  invalidate. Drained by `consumeEvictions()`. */
  private evictions: GlyphKey[] = []
  /** iter-190 — monotonic generation counter bumped on every slot
   *  reuse. Cached `GlyphInfo[]` arrays reference live atlas slots
   *  whose pxX / pxY change when the slot is reassigned. Keying a
   *  cache by `(text, fontKey, generation)` makes any post-eviction
   *  read miss instead of returning glyphs with stale pixel coords.
   *  Read via `getGeneration()`. */
  private _generation = 0
  getGeneration(): number { return this._generation }
  /** Glyph keys marked stale via `invalidate()`. The next `ensure()`
   *  call for one of these re-rasterises in place — same slot stays
   *  bound, metrics overwrite, dirty queue gets a fresh upload. Used
   *  by the PBF rasterizer to upgrade a Canvas2D-fallback glyph after
   *  the async PBF fetch lands. */
  private readonly stale = new Set<number>()
  // fontKey → small integer id (iter 129 perf, mirrors AtlasState's
  // own interning so callers don't pay the string-allocation cost on
  // every metricsKey() call).
  private readonly fontKeyId = new Map<string, number>()
  private nextFontId = 0

  constructor(
    config: AtlasConfig,
    rasterizer: GlyphRasterizer,
    options: GlyphAtlasHostOptions,
  ) {
    this.state = new AtlasState(config)
    this.rasterizer = rasterizer
    this.fontSize = options.fontSize
    this.sdfRadius = options.sdfRadius
  }

  /** Ensure one glyph is in the atlas. Cache hit → returns cached
   *  metrics; cache miss → rasterises, queues dirty, returns fresh
   *  metrics. A previously-invalidated glyph (see `invalidate`) is
   *  treated as a miss even when its slot still exists: same slot
   *  is kept, but the rasterizer runs again and the SDF re-uploads. */
  ensure(fontKey: string, codepoint: number): GlyphInfo {
    const key: GlyphKey = { fontKey, codepoint, sdfRadius: this.sdfRadius }
    const ensured = this.state.ensure(key)
    if (ensured.evictedKey !== undefined) {
      // The slot we got was reclaimed — the renderer needs to know
      // the previous tenant is gone.
      this.evictions.push(ensured.evictedKey)
      const evictedMk = this.metricsKey(ensured.evictedKey)
      this.metrics.delete(evictedMk)
      // iter-205 — drop the cached GlyphInfo for the evicted glyph.
      // Same slot will be reused for the NEW glyph; the cached info
      // would point at the wrong codepoint + stale metrics.
      this.infoCache.delete(evictedMk)
      // iter-190 — bump a monotonic generation counter on every slot
      // reuse. Across-frame caches that key by `(text, generation)`
      // miss after any eviction (mid-frame too — the iter-167 cache
      // only drained per-frame via consumeEvictions and corrupted
      // labels whenever one label's ensure() displaced a cached
      // glyph slot referenced by a later label in the same frame).
      this._generation++
    }
    const mk = this.metricsKey(key)
    const forceRasterize = ensured.created || this.stale.has(mk)
    if (forceRasterize) {
      const result = this.rasterizer.rasterize({
        fontKey, fontSize: this.fontSize, codepoint,
        sdfRadius: this.sdfRadius, slotSize: ensured.slot.size,
      })
      this.metrics.set(mk, {
        advanceWidth: result.advanceWidth,
        bearingX: result.bearingX,
        bearingY: result.bearingY,
        width: result.width,
        height: result.height,
        pbf: result.pbf === true,
        rasterFontSize: result.rasterFontSize,
      })
      this.dirty.push({ key, slot: ensured.slot, sdf: result.sdf })
      this.stale.delete(mk)
      // iter-205 — populate infoCache so the next cache-hit
      // ensure() for the same glyph returns the same reference
      // (the test pin asserts `b === a` after two ensure calls).
      // Without this populate, the FIRST call goes through this
      // forceRasterize branch + builds via assembleInfo, while the
      // SECOND call hits the cache-hit branch + builds a fresh
      // object — defeats the memoisation invariant.
      const info = this.assembleInfo(codepoint, ensured.slot, result)
      this.infoCache.set(mk, info)
      return info
    }
    // Cache hit: return memoised GlyphInfo when available (iter-205);
    // otherwise build + cache. Slot reference stays valid as long as
    // the slot isn't reclaimed — eviction handler above clears the
    // cache entry, so a hit here is always serving the current slot.
    const cached = this.infoCache.get(mk)
    if (cached !== undefined) return cached
    const m = this.metrics.get(mk)!
    const info: GlyphInfo = {
      codepoint, slot: ensured.slot,
      advanceWidth: m.advanceWidth,
      bearingX: m.bearingX,
      bearingY: m.bearingY,
      width: m.width,
      height: m.height,
      pbf: m.pbf,
      rasterFontSize: m.rasterFontSize,
    }
    this.infoCache.set(mk, info)
    return info
  }

  /** Mark one glyph as stale so its next `ensure()` call re-rasterises
   *  in place (slot kept, dirty queue re-fires). Used by the PBF
   *  rasterizer to swap in a freshly-fetched SDF without disturbing
   *  vertex buffers that already reference the slot.
   *
   *  No-op if the glyph isn't currently in the atlas (nothing to
   *  invalidate) — callers should not rely on invalidate() to populate. */
  invalidate(fontKey: string, codepoint: number): void {
    const key: GlyphKey = { fontKey, codepoint, sdfRadius: this.sdfRadius }
    const mk = this.metricsKey(key)
    if (this.metrics.has(mk)) {
      this.stale.add(mk)
      // iter-205 — also drop the cached GlyphInfo; the next ensure()
      // will re-raster + rebuild with the post-upgrade metrics. Skip
      // this and a stale GlyphInfo could survive until eviction.
      this.infoCache.delete(mk)
    }
  }

  /** Ensure every glyph in `text` is in the atlas. Returns one
   *  GlyphInfo per codepoint (Unicode-aware: surrogate pairs counted
   *  once). Iter 133 perf: indexed codePointAt iteration instead of
   *  `for...of`; the iterator-protocol path allocates a ~50-byte
   *  StringIterator + per-step result `{value, done}` object on
   *  every char, dominant GC contributor at z=14 OFM Liberty Seoul
   *  with ~300 labels × ~10 chars/frame = ~3 k iterator allocs/frame.
   *
   *  iter-233 — string-level memo (see stringInfoCache). Cache key
   *  is `fontKey|text`; cache value is the GlyphInfo[] tagged with
   *  `_generation` at build time. A subsequent call with the same
   *  text + same generation returns the cached array directly,
   *  skipping the codepoint loop + per-glyph `ensure()` calls + the
   *  array allocation. A slot eviction anywhere bumps `_generation`
   *  so the stale array is dropped on next access.
   *
   *  Contract: returned array is SHARED with the cache. Callers must
   *  not mutate (matches the existing GlyphInfo / infoCache contract;
   *  text-stage `wrapWithKnuthPlass` + line-label paths read-only). */
  ensureString(fontKey: string, text: string): GlyphInfo[] {
    const cacheKey = fontKey + '|' + text
    const cached = this.stringInfoCache.get(cacheKey)
    if (cached !== undefined && cached.generation === this._generation) {
      return cached.info
    }
    const out: GlyphInfo[] = []
    const len = text.length
    let i = 0
    while (i < len) {
      const cp = text.codePointAt(i)!
      out.push(this.ensure(fontKey, cp))
      // Surrogate pair (BMP supplement) spans 2 UTF-16 code units.
      i += cp > 0xFFFF ? 2 : 1
    }
    // CRITICAL: read `_generation` AFTER the ensure loop. Any
    // ensure() call inside the loop may bump it (slot reuse); the
    // cached array's tag must reflect the FINAL state so the next
    // matching call validates cleanly. iter-167/168 corruption came
    // from caching with the START-of-frame generation while later
    // labels in the same frame evicted referenced slots — iter-190's
    // monotonic counter + post-loop read prevents that.
    this.stringInfoCache.set(cacheKey, { info: out, generation: this._generation })
    return out
  }

  /** Drain newly-rasterised glyphs awaiting GPU upload. The GPU
   *  wrapper calls this once per frame (or before its next draw)
   *  and writes each entry's `sdf` into the texture at `slot.pxX,
   *  slot.pxY`. Returned array is empty when nothing changed. */
  consumeDirty(): DirtyGlyph[] {
    if (this.dirty.length === 0) return []
    const out = this.dirty
    this.dirty = []
    return out
  }

  /** Drain evicted glyph keys. The renderer's text shaper uses
   *  this to invalidate any cached vertex buffers that referenced
   *  the now-missing slot. */
  consumeEvictions(): GlyphKey[] {
    if (this.evictions.length === 0) return []
    const out = this.evictions
    this.evictions = []
    return out
  }

  /** Pre-rasterise a set of glyphs without consulting their LRU
   *  position later — used by the engine init to bake digits +
   *  punctuation + the latin alphabet so first-frame readouts
   *  hit the cache. Idempotent. */
  prewarm(fontKey: string, codepoints: Iterable<number>): void {
    for (const cp of codepoints) this.ensure(fontKey, cp)
  }

  // ─── internals ────────────────────────────────────────────────

  private metricsKey(k: GlyphKey): number {
    // Same encoding shape as AtlasState.keyToNum — sdfRadius 7b |
    // codepoint 21b | fontId 25b. Lazy fontKey → fontId interning.
    let id = this.fontKeyId.get(k.fontKey)
    if (id === undefined) {
      id = this.nextFontId++
      this.fontKeyId.set(k.fontKey, id)
    }
    return id * 0x10000000 + k.codepoint * 0x80 + (k.sdfRadius & 0x7F)
  }

  private assembleInfo(
    codepoint: number, slot: AtlasSlot, r: GlyphRasterResult,
  ): GlyphInfo {
    return {
      codepoint, slot,
      advanceWidth: r.advanceWidth,
      bearingX: r.bearingX,
      bearingY: r.bearingY,
      width: r.width,
      height: r.height,
      pbf: r.pbf === true,
      rasterFontSize: r.rasterFontSize,
    }
  }
}
