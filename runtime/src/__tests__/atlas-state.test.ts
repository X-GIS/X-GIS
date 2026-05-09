import { describe, it, expect } from 'vitest'
import { AtlasState, type GlyphKey } from '../engine/sdf/atlas-state'

const k = (codepoint: number, fontKey = 'noto-sans', sdfRadius = 8): GlyphKey =>
  ({ fontKey, codepoint, sdfRadius })

describe('AtlasState', () => {
  describe('config validation', () => {
    it('throws if pageSize not a multiple of slotSize', () => {
      expect(() => new AtlasState({ slotSize: 32, pageSize: 100 })).toThrow(/multiple/)
    })
  })

  describe('lazy page allocation', () => {
    it('starts with zero pages', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      expect(a.pageCount).toBe(0)
      expect(a.capacity).toBe(0)
      expect(a.size).toBe(0)
    })

    it('allocates first page on first ensure()', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      a.ensure(k(65))
      expect(a.pageCount).toBe(1)
      expect(a.capacity).toBe(4)  // 2x2 slots
    })
  })

  describe('basic ensure', () => {
    it('first call → created:true', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      const r = a.ensure(k(65))
      expect(r.created).toBe(true)
      expect(r.evictedKey).toBeUndefined()
      expect(r.slot.page).toBe(0)
      expect(r.slot.size).toBe(32)
    })

    it('repeat call → created:false (cache hit)', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      const r1 = a.ensure(k(65))
      const r2 = a.ensure(k(65))
      expect(r2.created).toBe(false)
      expect(r2.slot).toEqual(r1.slot)
    })

    it('different codepoints get different slots', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 128 })
      const r1 = a.ensure(k(65))
      const r2 = a.ensure(k(66))
      expect(r1.slot).not.toEqual(r2.slot)
    })

    it('different fontKey or sdfRadius are different cache entries', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 128 })
      const r1 = a.ensure(k(65, 'noto', 8))
      const r2 = a.ensure(k(65, 'noto-bold', 8))
      const r3 = a.ensure(k(65, 'noto', 16))
      expect(r1.slot).not.toEqual(r2.slot)
      expect(r1.slot).not.toEqual(r3.slot)
      expect(r2.slot).not.toEqual(r3.slot)
    })
  })

  describe('peek', () => {
    it('returns slot for existing key without bumping LRU', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      // Fill: 4 slots, last-inserted is most recent.
      a.ensure(k(1))
      a.ensure(k(2))
      a.ensure(k(3))
      a.ensure(k(4))
      // peek(1) — does NOT bump it; LRU eviction should still take 1
      expect(a.peek(k(1))).toBeDefined()
      a.ensure(k(5))  // evicts the LRU — should be k(1)
      expect(a.peek(k(1))).toBeUndefined()
      expect(a.peek(k(2))).toBeDefined()
    })

    it('returns undefined for missing key', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      expect(a.peek(k(99))).toBeUndefined()
    })
  })

  describe('LRU eviction', () => {
    it('evicts oldest when full', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      // 4-slot capacity
      a.ensure(k(1))
      a.ensure(k(2))
      a.ensure(k(3))
      a.ensure(k(4))
      expect(a.size).toBe(4)
      // Add a 5th → must evict the oldest (k(1))
      const r = a.ensure(k(5))
      expect(r.created).toBe(true)
      expect(r.evictedKey).toEqual(k(1))
      expect(a.peek(k(1))).toBeUndefined()
      expect(a.peek(k(5))).toBeDefined()
    })

    it('ensure() bumps LRU so recent keys survive', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      a.ensure(k(1))
      a.ensure(k(2))
      a.ensure(k(3))
      a.ensure(k(4))
      // Touch k(1) — moves it to the back of LRU
      a.ensure(k(1))
      // Add k(5) → evicts the new oldest, which is k(2)
      const r = a.ensure(k(5))
      expect(r.evictedKey).toEqual(k(2))
      expect(a.peek(k(1))).toBeDefined()  // saved by the touch
      expect(a.peek(k(2))).toBeUndefined()
    })

    it('explicit touch() bumps LRU', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      a.ensure(k(1))
      a.ensure(k(2))
      a.ensure(k(3))
      a.ensure(k(4))
      a.touch(k(1))
      a.ensure(k(5))
      // k(1) survived because touch moved it to back; k(2) is now oldest.
      expect(a.peek(k(1))).toBeDefined()
      expect(a.peek(k(2))).toBeUndefined()
    })

    it('reuses evicted slot (does not allocate new page)', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      for (let i = 1; i <= 4; i++) a.ensure(k(i))
      expect(a.pageCount).toBe(1)
      // Add 100 more — should keep evicting + reusing the same 4 slots.
      for (let i = 5; i < 100; i++) a.ensure(k(i))
      expect(a.pageCount).toBe(1)
      expect(a.size).toBe(4)  // Always full, never grew
    })
  })

  describe('stats', () => {
    it('tracks hits / misses / evictions / hitRate', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 64 })
      a.ensure(k(1))   // miss
      a.ensure(k(2))   // miss
      a.ensure(k(1))   // hit
      a.ensure(k(1))   // hit
      a.ensure(k(3))   // miss
      a.ensure(k(4))   // miss
      a.ensure(k(5))   // miss + eviction
      const s = a.stats
      expect(s.hits).toBe(2)
      expect(s.misses).toBe(5)
      expect(s.evictions).toBe(1)
      expect(s.hitRate).toBeCloseTo(2 / 7, 5)
    })
  })

  describe('slot geometry', () => {
    it('slot pxX/pxY map correctly to cell coords', () => {
      const a = new AtlasState({ slotSize: 32, pageSize: 96 })  // 3x3 = 9 slots
      const slots: Array<{ cellX: number; cellY: number; pxX: number; pxY: number }> = []
      for (let i = 0; i < 9; i++) {
        const r = a.ensure(k(i))
        slots.push(r.slot)
      }
      // All slots are within the page bounds and consistent
      for (const s of slots) {
        expect(s.pxX).toBe(s.cellX * 32)
        expect(s.pxY).toBe(s.cellY * 32)
        expect(s.pxX).toBeLessThan(96)
        expect(s.pxY).toBeLessThan(96)
      }
      // 9 unique slot coords
      const ids = new Set(slots.map(s => `${s.cellX},${s.cellY}`))
      expect(ids.size).toBe(9)
    })
  })
})
