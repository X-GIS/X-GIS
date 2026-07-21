import { describe, expect, it, vi, afterEach } from 'vitest'
import { XGISMap } from './map'
import { parseHash } from './map-hash'

// #1268 — map-level URL hash sync wiring: boot-seed (fragment wins over the
// camera options), the debounced move-end replaceState write, namespace merge,
// and the default-off no-op. The fragment format/parse math is proved in
// map-hash.test.ts; this pins the map integration (setters + event + history).

function mockCanvas(): HTMLCanvasElement {
  return { width: 1200, height: 800 } as unknown as HTMLCanvasElement
}

interface HashMap {
  getCenter(): [number, number]
  getZoom(): number
  setCenter(lon: number, lat: number): void
  setZoom(z: number): void
  _processCameraEvents(): void
  destroy(): void
}

function stubUrl(hash: string): { replaceState: ReturnType<typeof vi.fn> } {
  const replaceState = vi.fn()
  vi.stubGlobal('location', { hash, pathname: '/app', search: '?x=1', href: `/app?x=1${hash}` })
  vi.stubGlobal('history', { replaceState, state: null })
  return { replaceState }
}

/** Drive one full move cycle so `moveend` fires (seed tick, then move, then
 *  two ticks: movestart/move, then moveend). */
function settleMove(map: HashMap, lon: number, lat: number, zoom: number): void {
  map._processCameraEvents() // seed the event signature (first tick never fires)
  map.setCenter(lon, lat)
  map.setZoom(zoom)
  map._processCameraEvents() // movestart + move
  map._processCameraEvents() // moveend
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('XGISMap URL hash sync (#1268)', () => {
  it('boots seeded from the fragment — hash WINS over center/zoom options', () => {
    stubUrl('#5/37.5/127')
    const map = new XGISMap(mockCanvas(), {
      hash: true,
      center: [0, 0], // overridden by the fragment
      zoom: 2,
    }) as unknown as HashMap
    const [lon, lat] = map.getCenter()
    expect(lon).toBeCloseTo(127, 3)
    expect(lat).toBeCloseTo(37.5, 3)
    expect(map.getZoom()).toBe(5)
    map.destroy()
  })

  it('off (default) ignores the fragment and never writes history', () => {
    const { replaceState } = stubUrl('#5/37.5/127')
    const map = new XGISMap(mockCanvas(), { center: [10, 20], zoom: 3 }) as unknown as HashMap
    const [lon, lat] = map.getCenter()
    expect(lon).toBeCloseTo(10, 3) // options stand — fragment untouched
    expect(lat).toBeCloseTo(20, 3)
    settleMove(map, 30, 40, 6)
    vi.useFakeTimers()
    vi.advanceTimersByTime(200)
    expect(replaceState).not.toHaveBeenCalled()
    map.destroy()
  })

  it('writes the fragment (debounced replaceState) after a move settles', () => {
    const { replaceState } = stubUrl('')
    const map = new XGISMap(mockCanvas(), { hash: true }) as unknown as HashMap
    vi.useFakeTimers()
    settleMove(map, 126.98, 37.57, 14)
    expect(replaceState).not.toHaveBeenCalled() // debounced, not yet
    vi.advanceTimersByTime(150)
    expect(replaceState).toHaveBeenCalled()
    const url = replaceState.mock.calls.at(-1)![2] as string
    expect(url.startsWith('/app?x=1#')).toBe(true) // pathname + search preserved
    const back = parseHash(url.slice(url.indexOf('#')), '')!
    expect(back.zoom).toBe(14)
    expect(back.lon).toBeCloseTo(126.98, 3)
    expect(back.lat).toBeCloseTo(37.57, 3)
    map.destroy()
  })

  it('a namespaced write preserves a sibling fragment param (maps do not fight)', () => {
    const { replaceState } = stubUrl('#other=1/2/3')
    const map = new XGISMap(mockCanvas(), { hash: 'map' }) as unknown as HashMap
    vi.useFakeTimers()
    settleMove(map, 0, 0, 5)
    vi.advanceTimersByTime(150)
    const url = replaceState.mock.calls.at(-1)![2] as string
    const frag = url.slice(url.indexOf('#'))
    expect(frag).toContain('other=1/2/3') // sibling survived
    expect(parseHash(frag, 'map')).toMatchObject({ zoom: 5 })
    map.destroy()
  })
})
