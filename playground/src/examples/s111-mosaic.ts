// ═══ Viewport-driven S-111 mosaic (#1272 E-④) ═══
//
// Pan across the U.S. coast and the currents follow: on each move-end this loads EVERY NOAA
// regional model whose domain overlaps the viewport and pushes each into the `coverage`
// source under its own region key, so adjacent domains draw TOGETHER. A view straddling
// Chesapeake and Delaware shows CBOFS and DBOFS at once rather than whichever won a
// most-overlap contest.
//
// This used to pick the single best-covering model and REPLACE the resident cell on every
// move-end — the mosaic UX without a multi-coverage render. The renderer had grown keyed
// multi-region residency, but nothing above it ever passed a key, so the whole stack stayed
// single-region.
//
// Bounded by BYTES, not by a region count, because a count means different things at
// different zooms: `maxResidentBytes` caps what stays loaded and the least-recently-seen
// region is dropped first, which is also what the renderer's own GPU budget does one layer
// down. Fetches are concurrency-limited so a coast-wide zoom-out does not fire a dozen
// ~10 MB requests at once, and an LRU of downloaded bytes keeps panning back instant.
//
// Usage (the `currents` source is a declared `type: coverage` layer):
//   const mosaic = installS111Mosaic(map, { sourceId: 'currents', proxyBase: '' })
//   // …later: mosaic.regions() → ['cbofs', 'dbofs']; mosaic.remove() to detach.

import { readCoverage, type CoverageHandle } from '@xgis/data'
import { bestModelForBounds, modelsForBounds, type Bounds } from './s111-models'

/** The minimal map surface the mosaic needs — so it decouples from XGISMap and mocks
 *  trivially in tests. XGISMap satisfies it structurally. */
export interface MosaicMap {
  getBounds(): [[number, number], [number, number]]
  on(type: 'moveend', listener: () => void): void
  off(type: 'moveend', listener: () => void): void
  setCoverageData(
    sourceId: string,
    bytes: ArrayBuffer,
    opts?: { url?: string; group?: number; region?: string },
  ): Promise<void>
  removeCoverageRegion(sourceId: string, region: string): void
}

export interface S111MosaicOptions {
  /** The declared `coverage` source to swap (e.g. `"currents"`). */
  sourceId: string
  /** Proxy origin serving `/noaa-s111/latest/<model>.h5`. Default same-origin (''). */
  proxyBase?: string
  /** Max loaded cells kept in the byte LRU (default 3). Each is a full cell (~10 MB). */
  maxCached?: number
  /** Ceiling on the bytes of the cells kept RESIDENT (drawn) at once. Default 64 MB — the
   *  renderer's own GPU budget one layer down, so the two do not fight. The overlapping
   *  models are taken most-overlap first until the next one would not fit, which is why this
   *  is a byte cap and not a region count: how many domains a viewport touches depends
   *  entirely on the zoom, but the memory a device can spare does not. */
  maxResidentBytes?: number
  /** Max cells fetched at once (default 2). A coast-wide zoom-out overlaps many domains, and
   *  firing every ~10 MB request in parallel starves the ones actually on screen. */
  maxConcurrentFetches?: number
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
  /** The PRIMARY model key — the most-overlapping resident region (null before the first
   *  resolve / over open ocean). Kept because the forecast-time UI needs one axis to show. */
  current(): string | null
  /** Every resident model key, most-overlap first. */
  regions(): string[]
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
  const maxResidentBytes = Math.max(1, opts.maxResidentBytes ?? 64 * 1024 * 1024)
  const maxConcurrent = Math.max(1, opts.maxConcurrentFetches ?? 2)
  const cache = new Map<string, ArrayBuffer>() // insertion-ordered ⇒ front = least-recent
  /** Regions pushed into the map, most-overlap first for the current view. */
  let resident: string[] = []
  /** What the LATEST move-end decided should be on screen, most-overlap first. A fetch that
   *  lands after the view moved on checks this rather than an epoch counter: a slow neighbour
   *  that is STILL in frame should arrive, not be discarded for having been requested one pan
   *  ago. Ordered rather than a Set because the same list also defines draw/priority order. */
  let wanted: string[] = []
  let inFlight = 0
  const queue: string[] = []
  const pending = new Set<string>() // queued or fetching — never enqueue a key twice
  const urlFor = (key: string): string => `${base}/noaa-s111/latest/${key}.h5`

  /** A cell we have not downloaded yet has no known size; NOAA's regional cells run about
   *  this big, and the real byteLength replaces the guess the moment it lands. */
  const NOMINAL_CELL_BYTES = 10 * 1024 * 1024
  const sizeOf = (key: string): number => cache.get(key)?.byteLength ?? NOMINAL_CELL_BYTES

  const onMoveEnd = (): void => {
    const [[w, s], [e, n]] = map.getBounds()
    // Every overlapping domain, most-relevant first — then the prefix that fits the byte
    // budget. Taking a PREFIX (not a filter) matters: the models are already ordered by
    // relevance, so what gets dropped is always the least useful.
    const view = [w, s, e, n] as Bounds
    const models = modelsForBounds(view)
    // The PRIMARY keeps its hysteresis (#1333): a boundary-adjacent zoom must not flip which
    // region the forecast-time UI reads its axis from. The resident SET no longer churns on
    // such a zoom — both neighbours are loaded either way — so this is now only about keeping
    // the primary label steady, which is exactly what the damping was for.
    const best = bestModelForBounds(view, resident[0] ?? null)
    const ordered = best ? [best, ...models.filter((m) => m.key !== best.key)] : models
    const next: string[] = []
    let bytes = 0
    for (const m of ordered) {
      const size = sizeOf(m.key)
      if (next.length > 0 && bytes + size > maxResidentBytes) break
      next.push(m.key)
      bytes += size
    }
    wanted = next

    // Drop what left the viewport (or fell past the budget) BEFORE loading what entered, so
    // the peak resident set never exceeds the cap mid-pan.
    for (const key of resident) {
      if (!wanted.includes(key)) map.removeCoverageRegion(opts.sourceId, key)
    }
    resident = resident.filter((key) => wanted.includes(key))

    for (const key of next) {
      if (resident.includes(key) || pending.has(key)) continue
      pending.add(key)
      queue.push(key)
    }
    pump()
  }

  /** Start fetches up to the concurrency cap. */
  const pump = (): void => {
    while (inFlight < maxConcurrent && queue.length > 0) {
      const key = queue.shift()!
      inFlight++
      void load(key).finally(() => {
        inFlight--
        pending.delete(key)
        pump()
      })
    }
  }

  const load = async (key: string): Promise<void> => {
    const url = urlFor(key)
    try {
      let bytes = cache.get(key)
      if (bytes) {
        cache.delete(key) // re-insert below to refresh LRU recency
      } else {
        opts.onLoadStart?.(key) // a real fetch is starting — the demo can show "loading"
        const res = await doFetch(url)
        if (!res.ok) throw new Error(`fetch ${key}: ${res.status}`)
        bytes = await res.arrayBuffer()
      }
      cache.set(key, bytes)
      while (cache.size > maxCached) cache.delete(cache.keys().next().value as string)
      if (!wanted.includes(key)) return // panned off screen while this was in flight
      // Pass the region URL so setCoverageTime can range-read a different forecast hour of
      // THIS region (#1272 E-③) — otherwise a host push drops the time axis. `region` is what
      // makes the push ACCUMULATE beside its neighbours instead of replacing them.
      await map.setCoverageData(opts.sourceId, bytes, { url, region: key })
      if (!wanted.includes(key)) {
        // The view moved during the decode and this region is no longer on screen; it just
        // became resident, so take it back out rather than leaking a domain nobody can see.
        map.removeCoverageRegion(opts.sourceId, key)
        return
      }
      if (!resident.includes(key)) resident.push(key)
      // Re-order to overlap priority so `current()` is the most-covering region regardless of
      // the order fetches happened to complete in.
      resident.sort((a, b) => wanted.indexOf(a) - wanted.indexOf(b))
      opts.onSwap?.(key)
    } catch (err) {
      // A transient fetch/decode failure must never break the demo — the other regions stay
      // up and a later pan retries this one.
      opts.onLoadError?.(key, err)
    }
  }

  const setTime = async (hour: number): Promise<void> => {
    // Step EVERY resident region to the same hour. Stepping only the primary would leave
    // neighbours frozen at a different forecast time, which draws as a current discontinuity
    // along the domain boundary — a plausible-looking lie about the data.
    await Promise.all(
      resident.map((key) => {
        const bytes = cache.get(key)
        if (!bytes) return Promise.resolve()
        // Re-decode the cell ALREADY in memory at a different forecast hour — no network, so
        // time stepping can't fail on a range re-fetch (readCoverage groups are 1-based). A
        // decode error must never crash the demo, so swallow a rejected push.
        return map
          .setCoverageData(opts.sourceId, bytes, {
            url: urlFor(key),
            group: hour + 1,
            region: key,
          })
          .catch(() => {})
      }),
    )
  }

  const peekTime = async (hour: number): Promise<CoverageHandle | null> => {
    // The PRIMARY region only: this feeds the demo's own hour-to-hour blend, which needs one
    // representative grid, not the whole mosaic.
    const key = resident[0]
    const bytes = key != null ? cache.get(key) : undefined
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
    current: () => resident[0] ?? null,
    regions: () => [...resident],
    setTime,
    peekTime,
    remove: () => map.off('moveend', onMoveEnd),
  }
}
