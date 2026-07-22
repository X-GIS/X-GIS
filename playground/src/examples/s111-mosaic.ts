// ═══ Viewport-driven S-111 mosaic (#1272 E-④) ═══
//
// Pan across the U.S. coast and the currents follow: on each move-end this picks the NOAA
// regional model that best covers the viewport (s111-models) and, when it changes, swaps the
// `coverage` source to that model's latest cell via the CORS proxy. An LRU keeps the last few
// loaded cells so panning back is instant, and an epoch guard drops a fetch that a newer pan
// superseded. This is DEMO-level orchestration over the public map API (getBounds / moveend /
// setCoverageData) — no engine change; the renderer still draws one coverage at a time (the
// covering region's), which is the mosaic UX without a multi-coverage render.
//
// Usage (the `currents` source is a declared `type: coverage` layer):
//   const mosaic = installS111Mosaic(map, { sourceId: 'currents', proxyBase: '' })
//   // …later: mosaic.current() → 'cbofs' | 'sfbofs' | …; mosaic.remove() to detach.
// A live demo that also draws the particle/arrow overlay must re-snapshot that overlay when
// `current()` changes (the overlay reads getCoverage('currents') once) — the same re-arm the
// forecast-time demo needs; that composition is the demo-runner's job, not this module's.

import { bestModelForBounds, type Bounds } from './s111-models'

/** The minimal map surface the mosaic needs — so it decouples from XGISMap and mocks
 *  trivially in tests. XGISMap satisfies it structurally. */
export interface MosaicMap {
  getBounds(): [[number, number], [number, number]]
  on(type: 'moveend', listener: () => void): void
  off(type: 'moveend', listener: () => void): void
  setCoverageData(sourceId: string, bytes: ArrayBuffer): Promise<void>
}

export interface S111MosaicOptions {
  /** The declared `coverage` source to swap (e.g. `"currents"`). */
  sourceId: string
  /** Proxy origin serving `/noaa-s111/latest/<model>.h5`. Default same-origin (''). */
  proxyBase?: string
  /** Max loaded cells kept in the LRU (default 3). Each is a full cell (~10 MB). */
  maxCached?: number
  /** Injectable fetch (tests). Default global `fetch`. */
  fetch?: typeof globalThis.fetch
}

export interface S111MosaicHandle {
  /** The model key currently displayed (null before the first resolve / over open ocean). */
  current(): string | null
  /** Detach the move-end listener. Idempotent. */
  remove(): void
}

/** Install a viewport-driven S-111 mosaic on `map`. Returns a handle to read the current
 *  model + detach. Resolves once immediately for the initial view. */
export function installS111Mosaic(map: MosaicMap, opts: S111MosaicOptions): S111MosaicHandle {
  const doFetch = opts.fetch ?? globalThis.fetch
  const base = opts.proxyBase ?? ''
  const maxCached = Math.max(1, opts.maxCached ?? 3)
  const cache = new Map<string, ArrayBuffer>() // insertion-ordered ⇒ front = least-recent
  let current: string | null = null
  let epoch = 0

  const onMoveEnd = (): void => {
    const [[w, s], [e, n]] = map.getBounds()
    const model = bestModelForBounds([w, s, e, n] as Bounds)
    if (!model || model.key === current) return // no covering model, or already shown
    current = model.key // optimistic — blocks a duplicate in-flight fetch for the same model
    const token = ++epoch
    void (async () => {
      let bytes = cache.get(model.key)
      if (bytes) {
        cache.delete(model.key) // re-insert below to refresh LRU recency
      } else {
        const res = await doFetch(`${base}/noaa-s111/latest/${model.key}.h5`)
        if (!res.ok || token !== epoch) return
        bytes = await res.arrayBuffer()
      }
      cache.set(model.key, bytes)
      while (cache.size > maxCached) cache.delete(cache.keys().next().value as string)
      if (token !== epoch) return // a newer pan superseded this one — drop it
      await map.setCoverageData(opts.sourceId, bytes)
    })()
  }

  map.on('moveend', onMoveEnd)
  onMoveEnd() // resolve for the initial view
  return { current: () => current, remove: () => map.off('moveend', onMoveEnd) }
}
