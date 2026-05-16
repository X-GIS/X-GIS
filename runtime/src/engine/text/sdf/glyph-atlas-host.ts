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
  /** Per-glyph layout metrics, keyed identically to AtlasState. */
  private readonly metrics = new Map<string, CachedMetrics>()
  /** Newly rasterised glyphs awaiting GPU upload. Drained by
   *  the GPU wrapper via `consumeDirty()`. */
  private dirty: DirtyGlyph[] = []
  /** Newly evicted glyphs whose vertex data the renderer needs to
   *  invalidate. Drained by `consumeEvictions()`. */
  private evictions: GlyphKey[] = []
  /** Glyph keys marked stale via `invalidate()`. The next `ensure()`
   *  call for one of these re-rasterises in place — same slot stays
   *  bound, metrics overwrite, dirty queue gets a fresh upload. Used
   *  by the PBF rasterizer to upgrade a Canvas2D-fallback glyph after
   *  the async PBF fetch lands. */
  private readonly stale = new Set<string>()

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
      this.metrics.delete(this.metricsKey(ensured.evictedKey))
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
      return this.assembleInfo(codepoint, ensured.slot, result)
    }
    // Cache hit: pull metrics from the cache.
    const m = this.metrics.get(mk)!
    return {
      codepoint, slot: ensured.slot,
      advanceWidth: m.advanceWidth,
      bearingX: m.bearingX,
      bearingY: m.bearingY,
      width: m.width,
      height: m.height,
      pbf: m.pbf,
      rasterFontSize: m.rasterFontSize,
    }
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
    if (this.metrics.has(mk)) this.stale.add(mk)
  }

  /** Ensure every glyph in `text` is in the atlas. Returns one
   *  GlyphInfo per codepoint in iteration order (Unicode-aware
   *  via `for...of`, so surrogate pairs count once). */
  ensureString(fontKey: string, text: string): GlyphInfo[] {
    const out: GlyphInfo[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      out.push(this.ensure(fontKey, cp))
    }
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

  private metricsKey(k: GlyphKey): string {
    return `${k.fontKey}\x1f${k.codepoint}\x1f${k.sdfRadius}`
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
