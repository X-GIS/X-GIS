// ═══════════════════════════════════════════════════════════════════
// Glyph Atlas State (Batch 1c-6b)
// ═══════════════════════════════════════════════════════════════════
//
// LRU slot manager for the GPU glyph atlas. Pure logic — no GPU,
// no Canvas, no async. The browser-bound wrapper (1c-6c) holds the
// GPUTexture and calls into this module to decide WHERE a glyph
// goes; this module never touches a pixel itself.
//
// Layout: one or more square ATLAS PAGES, each tiled into uniform
// SLOTS. Page size and slot size are both configurable but slots
// must divide pages evenly. A 2048-px page with 32-px slots gives
// 64×64 = 4096 slots — enough for the BMP even with multiple sizes.
//
// LRU order is maintained by Map insertion order (V8 / SpiderMonkey
// guarantee insertion-order iteration). On `touch`/`ensure` we
// delete + re-insert to move the entry to the back (= most recent);
// eviction pops from the front (= least recent).
//
// `ensure` is the only call sites need: returns a slot AND a
// `created` flag so the caller knows whether to dispatch a worker
// rasterisation request (created=true) or skip (false, cache hit).

export interface AtlasConfig {
  /** Each slot is a square of `slotSize × slotSize` pixels. */
  slotSize: number
  /** Each page is a square of `pageSize × pageSize` pixels. Must
   *  be a multiple of `slotSize`. */
  pageSize: number
}

export interface AtlasSlot {
  /** 0-based page index. Slot lives in `pages[page]`. */
  page: number
  /** Cell coords within the page, in slot units. */
  cellX: number
  cellY: number
  /** Top-left pixel coords of the slot in its page. */
  pxX: number
  pxY: number
  /** Slot side length in pixels (= config.slotSize). Repeated here
   *  so callers don't need to grab the config. */
  size: number
}

export interface GlyphKey {
  fontKey: string
  codepoint: number
  /** SDF radius the slot was rasterised at. Different radii =
   *  different cache entries — they encode different falloffs. */
  sdfRadius: number
}

interface SlotEntry {
  slot: AtlasSlot
  fontKey: string
  codepoint: number
  sdfRadius: number
}

export interface EnsureResult {
  slot: AtlasSlot
  /** True when the slot was just allocated (or evicted-and-reused).
   *  The caller MUST rasterise + upload. False = cache hit, slot
   *  already holds the glyph SDF. */
  created: boolean
  /** When `created` is true AND the slot was reclaimed from an
   *  evicted entry, this names the evicted glyph so the caller can
   *  invalidate any vertex data still referencing it. */
  evictedKey?: GlyphKey
}

export class AtlasState {
  private readonly cfg: AtlasConfig
  private readonly slotsPerRow: number
  private readonly slotsPerPage: number
  /** All free slots, newest-released last. Used as a stack. */
  private readonly freeSlots: AtlasSlot[] = []
  /** numeric-key → entry. Map iteration order = LRU order (oldest first).
   *  Iter 129 perf: replaced Map<string, SlotEntry> + template-literal
   *  `${fontKey}|${codepoint}|${sdfRadius}` per call with Map<number, ...>
   *  keyed by `fontId<<28 | codepoint<<7 | sdfRadius`. fontId comes from
   *  the lazy fontKey→fontId interning below. CPU profile on Seoul
   *  Liberty z16-p60 showed keyToString + ensure dominated the glyph
   *  atlas hot path (~10 % of frame at z=14, ~15 % at z=16-p60); the
   *  numeric encoding eliminates the per-call string allocation. */
  private readonly entries = new Map<number, SlotEntry>()
  // fontKey → small integer id assigned in order of first sighting.
  // Reverse map for parseKey eviction-path. Bounded by font diversity
  // (typically < 16 fonts per style — well under the 4-bit id we'd
  // theoretically need; allow up to 65536 for safety).
  private readonly fontKeyId = new Map<string, number>()
  private readonly fontIdKey: string[] = []
  private nextFontId = 0
  private pageCountInternal = 0
  private hitCount = 0
  private missCount = 0
  private evictionCount = 0

  constructor(cfg: AtlasConfig) {
    if (cfg.pageSize % cfg.slotSize !== 0) {
      throw new Error(
        `AtlasState: pageSize (${cfg.pageSize}) must be a multiple ` +
          `of slotSize (${cfg.slotSize})`,
      )
    }
    this.cfg = cfg
    this.slotsPerRow = cfg.pageSize / cfg.slotSize
    this.slotsPerPage = this.slotsPerRow * this.slotsPerRow
    // First page is allocated lazily on the first ensure() so a
    // long-idle map with no labels doesn't reserve any slots.
  }

  /** Look up an existing slot WITHOUT touching LRU order. Returns
   *  undefined if not present. Use `ensure` for the normal path. */
  peek(key: GlyphKey): AtlasSlot | undefined {
    return this.entries.get(this.keyToNum(key))?.slot
  }

  /** Ensure a slot is allocated for `key`. On hit: bumps LRU,
   *  returns existing slot with `created: false`. On miss: allocates
   *  (or evicts the LRU), returns slot with `created: true`. */
  ensure(key: GlyphKey): EnsureResult {
    const kn = this.keyToNum(key)
    const existing = this.entries.get(kn)
    if (existing !== undefined) {
      // Hit — bump LRU by re-insert.
      this.entries.delete(kn)
      this.entries.set(kn, existing)
      this.hitCount += 1
      return { slot: existing.slot, created: false }
    }

    this.missCount += 1

    // Miss: take a free slot or evict the LRU.
    let slot = this.freeSlots.pop()
    let evictedKey: GlyphKey | undefined
    if (slot === undefined) {
      // No free slot: evict LRU.
      const oldestKn = this.entries.keys().next().value as number | undefined
      if (oldestKn !== undefined) {
        const evicted = this.entries.get(oldestKn)!
        this.entries.delete(oldestKn)
        slot = evicted.slot
        evictedKey = {
          fontKey: evicted.fontKey,
          codepoint: evicted.codepoint,
          sdfRadius: evicted.sdfRadius,
        }
        this.evictionCount += 1
      } else {
        // Nothing to evict — grow.
        this.allocatePage()
        slot = this.freeSlots.pop()!
      }
    }
    this.entries.set(kn, {
      slot,
      fontKey: key.fontKey,
      codepoint: key.codepoint,
      sdfRadius: key.sdfRadius,
    })
    return { slot, created: true, evictedKey }
  }

  /** Bump an entry's LRU position without changing its slot. */
  touch(key: GlyphKey): void {
    const kn = this.keyToNum(key)
    const e = this.entries.get(kn)
    if (e === undefined) return
    this.entries.delete(kn)
    this.entries.set(kn, e)
  }

  /** Total slots currently holding a glyph. */
  get size(): number {
    return this.entries.size
  }
  /** Slots available for immediate allocation without eviction. */
  get freeCount(): number {
    return this.freeSlots.length
  }
  get pageCount(): number {
    return this.pageCountInternal
  }
  get capacity(): number {
    return this.pageCountInternal * this.slotsPerPage
  }
  get stats() {
    return {
      hits: this.hitCount,
      misses: this.missCount,
      evictions: this.evictionCount,
      hitRate:
        this.hitCount + this.missCount === 0 ? 0 : this.hitCount / (this.hitCount + this.missCount),
    }
  }

  // ─── internals ────────────────────────────────────────────────

  private allocatePage(): void {
    const page = this.pageCountInternal
    for (let cy = 0; cy < this.slotsPerRow; cy++) {
      for (let cx = 0; cx < this.slotsPerRow; cx++) {
        this.freeSlots.push({
          page,
          cellX: cx,
          cellY: cy,
          pxX: cx * this.cfg.slotSize,
          pxY: cy * this.cfg.slotSize,
          size: this.cfg.slotSize,
        })
      }
    }
    this.pageCountInternal += 1
    // Push order: rows × cols. Pop returns last pushed first =
    // bottom-right of the new page. That's fine — we just need the
    // free list to drain deterministically; visual locality on
    // adjacent glyphs isn't a goal because the texture sampler
    // handles non-contiguous lookups.
  }

  /** Encode (fontKey, codepoint, sdfRadius) into a JS number.
   *  Layout (low → high): sdfRadius 7 bits | codepoint 21 bits |
   *  fontId 25 bits. Stays within 53-bit safe-integer range. The
   *  fontKey → fontId interning is lazy; collisions are impossible
   *  because each new fontKey gets a fresh id. Iter 129 perf fix:
   *  replaced template-literal string keys (10-15 % of frame time
   *  on Seoul Liberty) with numeric keys to eliminate per-call
   *  string allocation in the glyph-atlas hot path. */
  private keyToNum(k: GlyphKey): number {
    let id = this.fontKeyId.get(k.fontKey)
    if (id === undefined) {
      id = this.nextFontId++
      this.fontKeyId.set(k.fontKey, id)
      this.fontIdKey.push(k.fontKey)
    }
    return id * 0x10000000 + k.codepoint * 0x80 + (k.sdfRadius & 0x7f)
  }
}
