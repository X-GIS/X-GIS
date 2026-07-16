// #1155 F3 — XGISMap cold-start burst INTEGRATION: how the map wires the
// ColdStartBurstController into its lifecycle. Device-free proofs over the
// private seam (same single-cast pattern as
// map-render-frame.characterization.test.ts): run()/renderFrame() need a live
// WebGPU device, so we drive `_burst`, `_registerVtSource`, and the real
// `renderLoop` catch/halt + device-loss branch directly. The state-machine
// itself (enter/exit/hysteresis/10 s cap) is unit-tested in
// map-cold-start-burst.test.ts.
//
// The MVT worker pool is a module-level singleton, so its burst refcount is
// asserted RELATIVE to a per-test baseline; every test balances its own enter.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { XGISMap } from './map'
import { getSharedMvtPool } from '@xgis/data'

function mockCanvas(width = 1200, height = 800): HTMLCanvasElement {
  return { width, height } as unknown as HTMLCanvasElement
}

/** Stub (catalog, renderer) pair recording the burst flag it received, plus the
 *  destroy() teardownSource calls. */
function stubEntry() {
  const sourceFlags: boolean[] = []
  const rendererFlags: boolean[] = []
  const source = {
    setColdStartBurst: (on: boolean) => sourceFlags.push(on),
    hasPendingLoads: () => false,
    destroy: () => {},
  }
  const renderer = {
    setColdStartBurst: (on: boolean) => rendererFlags.push(on),
    hasPendingUploads: () => false,
    getDrawStats: () => ({ missedTiles: 0 }),
    destroy: () => {},
  }
  return { source, renderer, sourceFlags, rendererFlags }
}

interface BurstSeam {
  _burst: { readonly isOn: boolean; enter(): void; exit(): void }
  _registerVtSource(key: string, source: unknown, renderer: unknown): void
  hasPendingSourceWork(): boolean
  renderLoop: () => void
  renderFrame: () => void
  _processCameraEvents: () => void
  running: boolean
  ctx?: { deviceLost: boolean; canvas?: { width: number; height: number } }
  vtSources: Map<string, { source: unknown; renderer: unknown }>
}
function seam(map: XGISMap): BurstSeam {
  return map as unknown as BurstSeam
}

const pool = getSharedMvtPool()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('XGISMap cold-start burst — enter wiring + destroy (#1155 F3)', () => {
  it('entering burst flags every registered source via the map wiring; destroy() ends it and the refcount returns to 0', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    const a = stubEntry()
    const b = stubEntry()
    s.vtSources.set('a', a as unknown as { source: unknown; renderer: unknown })
    s.vtSources.set('b', b as unknown as { source: unknown; renderer: unknown })

    s._burst.enter()
    expect(s._burst.isOn).toBe(true)
    expect(pool.coldStartBurstRefcount).toBe(base + 1)
    expect(a.sourceFlags.at(-1)).toBe(true)
    expect(a.rendererFlags.at(-1)).toBe(true)
    expect(b.sourceFlags.at(-1)).toBe(true)
    expect(b.rendererFlags.at(-1)).toBe(true)

    map.destroy()
    expect(s._burst.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
    expect(a.sourceFlags.at(-1)).toBe(false) // cleared BEFORE teardown
  })
})

describe('XGISMap cold-start burst — public stop() (#1155 F3)', () => {
  it('stop() releases the burst refcount (renderLoop early-returns on !running before tickExit, so the 10 s cap can never fire and the shared pool would otherwise leak)', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s._burst.enter()
    expect(pool.coldStartBurstRefcount).toBe(base + 1)

    map.stop()
    expect(s.running).toBe(false)
    expect(s._burst.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})

describe('XGISMap cold-start burst — permanent render-loop halt (#1155 F3)', () => {
  it('the 3-consecutive-failure halt ends burst and the refcount returns to 0', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    // Device-free: shadow the GPU-bound frame + camera-event hooks, and capture
    // rAF so the catch's re-arm can't recurse.
    s.renderFrame = () => {
      throw new Error('boom')
    }
    s._processCameraEvents = () => {}
    vi.stubGlobal('requestAnimationFrame', () => 1)

    s.running = true // run() normally arms this before the loop
    s._burst.enter()
    expect(pool.coldStartBurstRefcount).toBe(base + 1)

    // _needsRender is true on a fresh map → shouldRenderThisFrame() forces the
    // frame, which throws; three consecutive throws trip the halt.
    s.renderLoop()
    expect(s.running).toBe(true) // 1 failure
    s.renderLoop()
    expect(s.running).toBe(true) // 2 failures
    s.renderLoop()
    expect(s.running).toBe(false) // 3 → halted

    expect(s._burst.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})

describe('XGISMap cold-start burst — device-loss exit (#1155 F3)', () => {
  it('a device loss during a frame ends burst (loop dies without re-arming rAF)', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s.renderFrame = () => {} // RenderLoop.render() early-returns on loss
    s._processCameraEvents = () => {}
    s.ctx = { deviceLost: true }

    s.running = true
    s._burst.enter()
    expect(pool.coldStartBurstRefcount).toBe(base + 1)

    s.renderLoop() // renderFrame "succeeds" but ctx.deviceLost is set
    expect(s._burst.isOn).toBe(false)
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})

describe('XGISMap cold-start burst — 0×0-canvas frames are not "rendered" (#1155 F3)', () => {
  it('a map booted in a hidden/zero-size container keeps burst — a 0×0 early-return frame does not satisfy the ≥1-render exit gate', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    // RenderLoop.render() 0×0 early-returns before requestTiles; stub the
    // "success" and expose a 0×0 canvas so the burst block sees no real render.
    s.renderFrame = () => {}
    s._processCameraEvents = () => {}
    s.ctx = { deviceLost: false, canvas: { width: 0, height: 0 } }
    vi.stubGlobal('requestAnimationFrame', () => 1)

    s.running = true
    s._burst.enter()
    // No sources ⇒ hasPendingSourceWork() is false. Pre-fix these ticks would
    // each count a "rendered" frame and the 3-frame idle hysteresis would drop
    // burst; post-fix _renderedFrames stays 0 so tickExit never advances.
    s.renderLoop()
    s.renderLoop()
    s.renderLoop()
    s.renderLoop()
    expect(s._burst.isOn).toBe(true) // still armed for the real first cascade

    s._burst.exit() // balance the singleton refcount
    expect(pool.coldStartBurstRefcount).toBe(base)
  })
})

describe('XGISMap cold-start burst — registration while burst is on (#1155 F3)', () => {
  it('a source registered via _registerVtSource mid-burst receives both burst flags', () => {
    const base = pool.coldStartBurstRefcount
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    s._burst.enter() // burst on, no sources yet

    // The rebuildLayers seam (map.ts :932 / :3432) routes through _registerVtSource.
    const late = stubEntry()
    s._registerVtSource('late', late.source, late.renderer)

    expect(s.vtSources.has('late')).toBe(true)
    expect(late.sourceFlags.at(-1)).toBe(true)
    expect(late.rendererFlags.at(-1)).toBe(true)

    s._burst.exit() // balance
    expect(pool.coldStartBurstRefcount).toBe(base)
  })

  it('registration while burst is OFF applies no flag (steady-state unchanged)', () => {
    const map = new XGISMap(mockCanvas())
    const s = seam(map)
    const entry = stubEntry()
    s._registerVtSource('x', entry.source, entry.renderer)
    expect(s.vtSources.has('x')).toBe(true)
    expect(entry.sourceFlags.length).toBe(0)
    expect(entry.rendererFlags.length).toBe(0)
  })
})
