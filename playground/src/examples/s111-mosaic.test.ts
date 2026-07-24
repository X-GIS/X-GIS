import { describe, expect, it } from 'vitest'
import { installS111Mosaic, type MosaicMap } from './s111-mosaic'

type LngLatBounds = [[number, number], [number, number]]

// Viewport envelopes [[W,S],[E,N]] over regions with a known covering model.
const CHESAPEAKE: LngLatBounds = [
  [-77, 37],
  [-76, 38],
]
const SF_BAY: LngLatBounds = [
  [-122.6, 37.5],
  [-122.1, 38.0],
]
const MID_PACIFIC: LngLatBounds = [
  [-160, 10],
  [-150, 20],
]

function makeMap(initial: LngLatBounds) {
  let bounds = initial
  let listener: (() => void) | null = null
  const armed: string[] = [] // model key of each setCoverageData call, in order
  const armedOpts: ({ url?: string; group?: number } | undefined)[] = []
  const map: MosaicMap = {
    getBounds: () => bounds,
    on: (_t, l) => {
      listener = l
    },
    off: (_t, l) => {
      if (listener === l) listener = null
    },
    setCoverageData: async (_id, bytes, opts) => {
      armed.push(new TextDecoder().decode(bytes))
      armedOpts.push(opts)
    },
  }
  return {
    map,
    pan: (b: LngLatBounds) => {
      bounds = b
      listener?.()
    },
    armed,
    armedOpts,
    hasListener: () => listener !== null,
  }
}

function countingFetch() {
  const fetched: string[] = []
  const fetch = (async (url: string) => {
    const key = /latest\/(\w+)\.h5/.exec(url)![1]!
    fetched.push(key)
    return new Response(new TextEncoder().encode(key), { status: 200 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, fetched }
}

// Drain the async IIFE (fetch → arrayBuffer → setCoverageData) each move-end fires.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('installS111Mosaic (#1272 E-④)', () => {
  it('loads the covering model for the initial view, then swaps on a pan', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')
    expect(f.fetched).toEqual(['cbofs'])
    expect(m.armed).toEqual(['cbofs'])

    m.pan(SF_BAY)
    await flush()
    expect(h.current()).toBe('sfbofs')
    expect(f.fetched).toEqual(['cbofs', 'sfbofs'])
    expect(m.armed).toEqual(['cbofs', 'sfbofs'])
  })

  it('serves a pan-back from the LRU — no re-fetch', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    m.pan(SF_BAY)
    await flush()
    m.pan(CHESAPEAKE) // back
    await flush()
    // cbofs was cached → NOT fetched again, but IS re-armed
    expect(f.fetched).toEqual(['cbofs', 'sfbofs'])
    expect(m.armed).toEqual(['cbofs', 'sfbofs', 'cbofs'])
  })

  it('does nothing over open ocean (no covering model)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    m.pan(MID_PACIFIC)
    await flush()
    expect(h.current()).toBe('cbofs') // last covering model stays shown
    expect(f.fetched).toEqual(['cbofs']) // no fetch over open ocean
    expect(m.armed).toEqual(['cbofs'])
  })

  it('evicts the least-recently-used cell past maxCached', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, maxCached: 1 })
    await flush()
    m.pan(SF_BAY) // evicts cbofs (maxCached 1)
    await flush()
    m.pan(CHESAPEAKE) // cbofs evicted → must re-fetch
    await flush()
    expect(f.fetched).toEqual(['cbofs', 'sfbofs', 'cbofs'])
  })

  it('fires onSwap with the model key after each successful swap (overlay re-arm hook)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const swaps: string[] = []
    installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch, onSwap: (k) => swaps.push(k) })
    await flush()
    m.pan(SF_BAY)
    await flush()
    expect(swaps).toEqual(['cbofs', 'sfbofs'])
  })

  it('survives a failed fetch — keeps the current cell, retries on the next pan', async () => {
    let failNext = true
    const failing = (async (url: string) => {
      const key = /latest\/(\w+)\.h5/.exec(url)![1]!
      if (key === 'sfbofs' && failNext) {
        failNext = false
        return new Response('', { status: 502 })
      }
      return new Response(new TextEncoder().encode(key), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: failing })
    await flush()
    m.pan(SF_BAY) // sfbofs fetch 502s → revert, no swap, no throw
    await flush()
    expect(h.current()).toBe('cbofs')
    expect(m.armed).toEqual(['cbofs'])
    m.pan(SF_BAY) // retry — succeeds this time
    await flush()
    expect(h.current()).toBe('sfbofs')
    expect(m.armed).toEqual(['cbofs', 'sfbofs'])
  })

  it('remove() detaches the move-end listener', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    h.remove()
    expect(m.hasListener()).toBe(false)
    m.pan(SF_BAY) // listener gone → no effect
    await flush()
    expect(f.fetched).toEqual(['cbofs'])
  })

  it('setTime re-decodes the current region cell at a group — no re-fetch (#1272 E-③)', async () => {
    const f = countingFetch()
    const m = makeMap(CHESAPEAKE)
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBe('cbofs')

    h.setTime(3) // forecast hour 3 → 1-based group 4
    await flush()
    expect(f.fetched).toEqual(['cbofs']) // NO extra fetch — cached bytes reused
    expect(m.armed).toEqual(['cbofs', 'cbofs']) // re-decoded the same region cell
    const last = m.armedOpts[m.armedOpts.length - 1]
    expect(last?.group).toBe(4)
    expect(last?.url).toMatch(/latest\/cbofs\.h5$/)
  })

  it('setTime is a no-op before a region has loaded', async () => {
    const f = countingFetch()
    const m = makeMap(MID_PACIFIC) // open ocean → no covering model loads
    const h = installS111Mosaic(m.map, { sourceId: 'currents', fetch: f.fetch })
    await flush()
    expect(h.current()).toBeNull()
    h.setTime(2)
    await flush()
    expect(m.armed).toEqual([]) // nothing loaded → nothing to re-decode
  })
})
