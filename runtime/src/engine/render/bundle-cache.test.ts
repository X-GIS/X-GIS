// Unit tests for BundleCache (Phase RB.B foundation, iter-212).
// Pins:
//   - First getOrEncode → miss → calls encodeFn → caches
//   - Second getOrEncode same key → hit → returns same bundle
//   - invalidate(key) → next call re-encodes
//   - invalidateAll → every key re-encodes
//   - Stats (hits / misses / size / hitRate)

import { describe, it, expect } from 'vitest'
import { BundleCache, type BundleEncodeDescriptor } from './bundle-cache'

interface MockBundle { __mock: true; label?: string; encodedSeq: number }

let bundleSeq = 0

function mockDevice(): GPUDevice {
  return {
    createRenderBundleEncoder(_desc: GPURenderBundleEncoderDescriptor): GPURenderBundleEncoder {
      const encoder: Partial<GPURenderBundleEncoder> = {
        finish(opts?: GPURenderBundleDescriptor): GPURenderBundle {
          bundleSeq++
          return { __mock: true, label: opts?.label, encodedSeq: bundleSeq } as unknown as GPURenderBundle
        },
      }
      return encoder as GPURenderBundleEncoder
    },
  } as unknown as GPUDevice
}

const DESC: BundleEncodeDescriptor = {
  colorFormats: ['rgba8unorm'],
  depthStencilFormat: 'depth24plus-stencil8',
  sampleCount: 1,
  label: 'test-bundle',
}

describe('BundleCache — getOrEncode', () => {
  it('first call encodes + caches', () => {
    bundleSeq = 0
    const cache = new BundleCache(mockDevice())
    let encodeCalled = 0
    const b = cache.getOrEncode('k', DESC, () => { encodeCalled++ })
    expect(encodeCalled).toBe(1)
    expect((b as unknown as MockBundle).__mock).toBe(true)
    expect(cache.getStats().misses).toBe(1)
    expect(cache.getStats().hits).toBe(0)
  })

  it('second call same key → cache hit, encodeFn NOT called again', () => {
    const cache = new BundleCache(mockDevice())
    let encodeCalled = 0
    const b1 = cache.getOrEncode('k', DESC, () => { encodeCalled++ })
    const b2 = cache.getOrEncode('k', DESC, () => { encodeCalled++ })
    expect(encodeCalled).toBe(1)        // encoded once
    expect(b2).toBe(b1)                 // same bundle ref
    expect(cache.getStats().hits).toBe(1)
    expect(cache.getStats().misses).toBe(1)
  })

  it('different keys → independent bundles', () => {
    const cache = new BundleCache(mockDevice())
    const b1 = cache.getOrEncode('a', DESC, () => {})
    const b2 = cache.getOrEncode('b', DESC, () => {})
    expect(b1).not.toBe(b2)
    expect(cache.getStats().size).toBe(2)
    expect(cache.getStats().misses).toBe(2)
  })
})

describe('BundleCache — invalidation', () => {
  it('invalidate(key) → next call re-encodes', () => {
    const cache = new BundleCache(mockDevice())
    let encodeCalled = 0
    const b1 = cache.getOrEncode('k', DESC, () => { encodeCalled++ })
    cache.invalidate('k')
    const b2 = cache.getOrEncode('k', DESC, () => { encodeCalled++ })
    expect(encodeCalled).toBe(2)
    expect(b2).not.toBe(b1)             // distinct bundle ref
    expect(cache.getStats().misses).toBe(2)
  })

  it('invalidate(unknownKey) → silent no-op', () => {
    const cache = new BundleCache(mockDevice())
    cache.invalidate('never-cached')
    expect(cache.getStats().size).toBe(0)
  })

  it('invalidateAll → every key re-encodes', () => {
    const cache = new BundleCache(mockDevice())
    let encodeCalled = 0
    cache.getOrEncode('a', DESC, () => { encodeCalled++ })
    cache.getOrEncode('b', DESC, () => { encodeCalled++ })
    cache.invalidateAll()
    cache.getOrEncode('a', DESC, () => { encodeCalled++ })
    cache.getOrEncode('b', DESC, () => { encodeCalled++ })
    expect(encodeCalled).toBe(4)        // 2 + 2
    expect(cache.getStats().size).toBe(2)
  })
})

describe('BundleCache — stats', () => {
  it('hitRate computed correctly', () => {
    const cache = new BundleCache(mockDevice())
    cache.getOrEncode('k', DESC, () => {})  // miss
    cache.getOrEncode('k', DESC, () => {})  // hit
    cache.getOrEncode('k', DESC, () => {})  // hit
    cache.getOrEncode('k', DESC, () => {})  // hit
    const s = cache.getStats()
    expect(s.hits).toBe(3)
    expect(s.misses).toBe(1)
    expect(s.hitRate).toBeCloseTo(0.75, 5)
  })

  it('initial hitRate is 0 (no calls)', () => {
    const cache = new BundleCache(mockDevice())
    expect(cache.getStats().hitRate).toBe(0)
  })
})

describe('BundleCache — iter-227 LRU cap', () => {
  it('default cap = 1024', () => {
    const cache = new BundleCache(mockDevice())
    expect(cache.getStats().maxEntries).toBe(1024)
  })

  it('custom cap honoured', () => {
    const cache = new BundleCache(mockDevice(), 3)
    expect(cache.getStats().maxEntries).toBe(3)
  })

  it('size never exceeds cap; eviction count bumps on overflow', () => {
    const cache = new BundleCache(mockDevice(), 3)
    cache.getOrEncode('a', DESC, () => {})
    cache.getOrEncode('b', DESC, () => {})
    cache.getOrEncode('c', DESC, () => {})
    expect(cache.getStats().size).toBe(3)
    expect(cache.getStats().evictions).toBe(0)
    cache.getOrEncode('d', DESC, () => {})  // overflow → evict 1
    expect(cache.getStats().size).toBe(3)
    expect(cache.getStats().evictions).toBe(1)
    cache.getOrEncode('e', DESC, () => {})  // overflow → evict 2
    expect(cache.getStats().size).toBe(3)
    expect(cache.getStats().evictions).toBe(2)
  })

  it('LRU policy: hit bumps recency, oldest-by-lastUsed evicted', () => {
    const cache = new BundleCache(mockDevice(), 3)
    cache.getOrEncode('a', DESC, () => {})   // call 1, 'a'.lastUsed=1
    cache.getOrEncode('b', DESC, () => {})   // call 2, 'b'.lastUsed=2
    cache.getOrEncode('c', DESC, () => {})   // call 3, 'c'.lastUsed=3
    cache.getOrEncode('a', DESC, () => {})   // call 4 (hit), 'a'.lastUsed=4
    // 'b' is now oldest (lastUsed=2). Inserting 'd' should evict 'b'.
    cache.getOrEncode('d', DESC, () => {})   // call 5 (miss + evict)
    expect(cache.getStats().size).toBe(3)
    // Confirm: 'b' gone (next call re-encodes), 'a' / 'c' / 'd' present.
    let bReEncoded = false
    cache.getOrEncode('b', DESC, () => { bReEncoded = true })
    expect(bReEncoded).toBe(true)
    // 'a' still cached (no re-encode).
    let aReEncoded = false
    cache.getOrEncode('a', DESC, () => { aReEncoded = true })
    expect(aReEncoded).toBe(false)
  })

  it('invalidateAll → cache cleared but cap retained', () => {
    const cache = new BundleCache(mockDevice(), 2)
    cache.getOrEncode('a', DESC, () => {})
    cache.getOrEncode('b', DESC, () => {})
    cache.invalidateAll()
    expect(cache.getStats().size).toBe(0)
    expect(cache.getStats().maxEntries).toBe(2)
    // New fills still bounded.
    cache.getOrEncode('a', DESC, () => {})
    cache.getOrEncode('b', DESC, () => {})
    cache.getOrEncode('c', DESC, () => {})
    expect(cache.getStats().size).toBe(2)
  })
})
