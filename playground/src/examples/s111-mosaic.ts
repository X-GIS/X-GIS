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

import { readCoverage, type CoverageHandle } from '@xgis/data'
import { bestModelForBounds, type Bounds } from './s111-models'

/** The minimal map surface the mosaic needs — so it decouples from XGISMap and mocks
 *  trivially in tests. XGISMap satisfies it structurally. */
export interface MosaicMap {
  getBounds(): [[number, number], [number, number]]
  on(type: 'moveend', listener: () => void): void
  off(type: 'moveend', listener: () => void): void
  setCoverageData(
    sourceId: string,
    bytes: ArrayBuffer,
    opts?: { url?: string; group?: number },
  ): Promise<void>
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
  /** Called after a successful swap to the model `key` — the demo re-snapshots its
   *  particle/arrow overlay here (those read the coverage once, so a swap needs a re-arm). */
  onSwap?: (modelKey: string) => void
  /** Called right before a NETWORK fetch starts for `modelKey` — NOT fired on a cache hit
   *  (the LRU reuse is instant, nothing to show a loading state for). Pair with `onSwap`
   *  (success) / `onLoadError` (failure) to drive a loading indicator. */
  onLoadStart?: (modelKey: string) => void
  /** Called when a fetch/decode for `modelKey` fails — the mosaic itself recovers silently
   *  (keeps the current cell, a later pan retries), so this is ONLY for surfacing the
   *  failure in the UI; nothing to act on. */
  onLoadError?: (modelKey: string, err: unknown) => void
}

export interface S111MosaicHandle {
  /** The model key currently displayed (null before the first resolve / over open ocean). */
  current(): string | null
  /** Show forecast HOUR (0-based) of the current region by re-decoding its already-downloaded
   *  cell — no network (#1272 E-③). No-op before a region has loaded. Resolves once the swap
   *  has LANDED (or failed), so a playback loop can await it before clocking the next hour —
   *  a fire-and-forget step would let the loop read a stale time axis and repeat the same
   *  hour forever (#1362). */
  setTime(hour: number): Promise<void>
  /** Decode forecast HOUR (0-based) of the current region's ALREADY-DOWNLOADED cell WITHOUT
   *  displaying it — a pure, zero-network peek (#1333), for a caller blending two hours
   *  (`interpolateVectorCoverage`) before pushing the result itself (`setCoverageFrame`).
   *  `null` before a region has loaded, or if decoding fails. */
  peekTime(hour: number): Promise<CoverageHandle | null>
  /** Detach the move-end listener. Idempotent. */
  remove(): void
}

/** Install a viewport-driven S-111 mosaic on `map`. Returns a handle to read the current
 *  model + detach. Resolves once immediately for the initial view. */
export function installS111Mosaic(map: MosaicMap, opts: S111MosaicOptions): S111MosaicHandle {
  // `.bind(globalThis)`: a bare `globalThis.fetch` reference invoked off this local const
  // loses its receiver — in a real browser that throws "Illegal invocation" (a WebIDL
  // branded-`this` check Node/Bun's fetch doesn't enforce, invisible to every Node-run test).
  const doFetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
  const base = opts.proxyBase ?? ''
  const maxCached = Math.max(1, opts.maxCached ?? 3)
  const cache = new Map<string, ArrayBuffer>() // insertion-ordered ⇒ front = least-recent
  let current: string | null = null
  let epoch = 0
  const urlFor = (key: string): string => `${base}/noaa-s111/latest/${key}.h5`

  const onMoveEnd = (): void => {
    const [[w, s], [e, n]] = map.getBounds()
    // Pass `current` so a boundary-adjacent zoom is hysteresis-damped (s111-models.ts) instead
    // of hard-swapping the resident region for a marginal overlap difference (#1333).
    const model = bestModelForBounds([w, s, e, n] as Bounds, current)
    if (!model || model.key === current) return // no covering model, or already shown
    const prev = current
    current = model.key // optimistic — blocks a duplicate in-flight fetch for the same model
    const token = ++epoch
    const url = urlFor(model.key)
    void (async () => {
      try {
        let bytes = cache.get(model.key)
        if (bytes) {
          cache.delete(model.key) // re-insert below to refresh LRU recency
        } else {
          opts.onLoadStart?.(model.key) // a real fetch is starting — the demo can show "loading"
          const res = await doFetch(url)
          if (!res.ok) throw new Error(`fetch ${model.key}: ${res.status}`)
          if (token !== epoch) return
          bytes = await res.arrayBuffer()
        }
        cache.set(model.key, bytes)
        while (cache.size > maxCached) cache.delete(cache.keys().next().value as string)
        if (token !== epoch) return // a newer pan superseded this one — drop it
        // Pass the region URL so setCoverageTime can range-read a different forecast hour of
        // this region after the swap (#1272 E-③) — otherwise a host push drops the time axis.
        await map.setCoverageData(opts.sourceId, bytes, { url })
        opts.onSwap?.(model.key) // notify the demo (reset the time cursor to the new region)
      } catch (err) {
        // A transient fetch/decode failure must never break the demo — keep the current
        // cell shown and revert so a later pan retries this model.
        if (token === epoch && current === model.key) current = prev
        if (token === epoch) opts.onLoadError?.(model.key, err)
      }
    })()
  }

  const setTime = async (hour: number): Promise<void> => {
    if (current == null) return
    const bytes = cache.get(current)
    if (!bytes) return // region not loaded yet
    // Re-decode the region cell ALREADY in memory at a different forecast hour — no network,
    // so time stepping can't fail on a range re-fetch (readCoverage groups are 1-based). A
    // decode error must never crash the demo, so swallow a rejected push.
    await map
      .setCoverageData(opts.sourceId, bytes, { url: urlFor(current), group: hour + 1 })
      .catch(() => {})
  }

  const peekTime = async (hour: number): Promise<CoverageHandle | null> => {
    if (current == null) return null
    const bytes = cache.get(current)
    if (!bytes) return null
    try {
      return await readCoverage(bytes, undefined, { group: hour + 1 })
    } catch {
      return null
    }
  }

  map.on('moveend', onMoveEnd)
  onMoveEnd() // resolve for the initial view
  return {
    current: () => current,
    setTime,
    peekTime,
    remove: () => map.off('moveend', onMoveEnd),
  }
}
