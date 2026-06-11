// ═══ P0 quartet — four small latent-bug fixes a first-time user hits ═══
//
//  P0-1  picking default-OFF → feature listeners silently dead   (warn once)
//  P0-2  one frame exception permanently froze the render loop   (bounded backoff)
//  P0-3  no resize / DPR auto-tracking while idle                (observers → resize())
//  P0-4  unknown event types silently swallowed                  (warn once per type)
//
// All GPU-free: the warn funnel is ListenerRegistry.add (layer.ts), the
// loop recovery is renderLoop's catch (map.ts, renderFrame stubbed), and
// the observers are exercised through fake ResizeObserver / matchMedia
// globals (full visual behavior needs a browser — here we pin the wiring
// and the destroy() teardown mirror).

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { XGISMap } from './map'
import { ListenerRegistry, _resetListenerWarnings, type XGISFeatureEventType } from './layer'
import { QUALITY } from './gpu/quality'
import { attachAutoResize } from './auto-resize'

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: {} as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

// ── P0-1: picking-off warning at the listener-registration funnel ────

describe('P0-1: feature listener registered while QUALITY.picking is off', () => {
  let warnSpy: MockInstance
  const origPicking = QUALITY.picking
  const pickingWarns = () =>
    warnSpy.mock.calls.filter((c) => String(c[0]).includes('picking is disabled'))

  beforeEach(() => {
    _resetListenerWarnings()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    QUALITY.picking = false
  })
  afterEach(() => {
    QUALITY.picking = origPicking
    warnSpy.mockRestore()
  })

  it('warns exactly once, with the exact remedy (setQuality / ?picking=1 / MSAA note)', () => {
    const reg = new ListenerRegistry()
    reg.add('click', () => {})
    expect(pickingWarns()).toHaveLength(1)
    const msg = String(pickingWarns()[0]![0])
    expect(msg).toContain('map.setQuality({ picking: true })')
    expect(msg).toContain('?picking=1')
    expect(msg).toContain('MSAA')
    // More registrations — same or different pick-gated types — stay silent.
    reg.add('mousemove', () => {})
    reg.add('mouseenter', () => {})
    reg.add('click', () => {})
    expect(pickingWarns()).toHaveLength(1)
  })

  it('does not warn when picking is enabled', () => {
    QUALITY.picking = true
    const reg = new ListenerRegistry()
    reg.add('click', () => {})
    reg.add('mouseleave', () => {})
    expect(pickingWarns()).toHaveLength(0)
  })

  it('fires through the map.on feature-routing funnel too', () => {
    const map = new XGISMap(stubCanvas())
    map.on('click', () => {})
    expect(pickingWarns()).toHaveLength(1)
    map.destroy()
  })
})

// ── P0-4: unknown event types warn once per type ─────────────────────

describe('P0-4: unknown event type at registration', () => {
  let warnSpy: MockInstance
  const origPicking = QUALITY.picking
  const unknownWarns = (type: string) =>
    warnSpy.mock.calls.filter((c) => String(c[0]).includes(`Unknown event type '${type}'`))

  beforeEach(() => {
    _resetListenerWarnings()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    QUALITY.picking = origPicking
    warnSpy.mockRestore()
  })

  it("map.on('rotate') warns once, naming both supported lists", () => {
    const map = new XGISMap(stubCanvas())
    map.on('rotate' as XGISFeatureEventType, () => {})
    expect(unknownWarns('rotate')).toHaveLength(1)
    const msg = String(unknownWarns('rotate')[0]![0])
    expect(msg).toContain('movestart') // map-event list named
    expect(msg).toContain('mouseenter') // feature-event list named
    // Same type again → still once. A different unknown type → its own warn.
    map.on('rotate' as XGISFeatureEventType, () => {})
    expect(unknownWarns('rotate')).toHaveLength(1)
    map.on('pitch' as XGISFeatureEventType, () => {})
    expect(unknownWarns('pitch')).toHaveLength(1)
    map.destroy()
  })

  it('layer-funnel registrations of unsupported aliases warn too', () => {
    new ListenerRegistry().add('hover' as XGISFeatureEventType, () => {})
    expect(unknownWarns('hover')).toHaveLength(1)
  })

  it('a map lifecycle name in the feature funnel gets the routing remedy, once', () => {
    // map.addEventListener('move') is feature-surface only — 'move' never
    // fires there. The warn must say so (not a contradictory "unknown").
    const map = new XGISMap(stubCanvas())
    map.addEventListener('move' as XGISFeatureEventType, () => {})
    const routed = () => warnSpy.mock.calls.filter((c) => String(c[0]).includes("map.on('move'"))
    expect(routed()).toHaveLength(1)
    expect(unknownWarns('move')).toHaveLength(0)
    map.addEventListener('move' as XGISFeatureEventType, () => {})
    expect(routed()).toHaveLength(1)
    map.destroy()
  })

  it('known map + feature types do not produce the unknown-type warning', () => {
    QUALITY.picking = true // silence the P0-1 lane to isolate this one
    const map = new XGISMap(stubCanvas())
    map.on('move', () => {})
    map.on('load', () => {})
    map.on('click', () => {})
    expect(warnSpy.mock.calls.filter((c) => String(c[0]).includes('Unknown event type'))).toHaveLength(0)
    map.destroy()
  })
})

// ── P0-2: render loop bounded-backoff recovery ───────────────────────

describe('P0-2: renderFrame exception recovery', () => {
  let rafSpy: ReturnType<typeof vi.fn>
  let errSpy: MockInstance

  type LoopInternals = { running: boolean; _frameFailures: number; renderFrame(): void }

  beforeEach(() => {
    rafSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    errSpy.mockRestore()
  })

  function armedMap(renderFrame: () => void): { map: XGISMap; m: LoopInternals } {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as LoopInternals
    m.running = true
    m.renderFrame = renderFrame // shadow the prototype method — loop calls this
    map.invalidate() // _needsRender → shouldRenderThisFrame() true
    return { map, m }
  }

  it('a transient failure recovers: loop stays alive, counter resets on success', () => {
    let calls = 0
    const { map, m } = armedMap(() => {
      calls++
      if (calls === 1) throw new Error('transient frame fault')
    })
    map.renderLoop() // frame 1: throws
    expect(m.running).toBe(true) // NOT halted (pre-fix: frozen here)
    expect(m._frameFailures).toBe(1)
    expect(rafSpy).toHaveBeenCalledTimes(1) // retry scheduled
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[X-GIS frame]'))).toHaveLength(1)
    map.renderLoop() // frame 2: succeeds
    expect(m._frameFailures).toBe(0) // success resets the counter
    expect(m.running).toBe(true)
    map.destroy()
  })

  it('halts after 3 consecutive failures with a final halt error', () => {
    const { map, m } = armedMap(() => { throw new Error('persistent fault') })
    map.renderLoop()
    map.renderLoop()
    map.renderLoop()
    expect(m.running).toBe(false) // true persistent fault → stop as before
    expect(rafSpy).toHaveBeenCalledTimes(2) // retries after failures 1+2 only
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('[X-GIS frame]'))).toHaveLength(3)
    expect(errSpy.mock.calls.filter((c) => String(c[0]).includes('halted after 3 consecutive'))).toHaveLength(1)
    map.renderLoop() // running=false → inert, no further scheduling
    expect(rafSpy).toHaveBeenCalledTimes(2)
    map.destroy()
  })
})

// ── P0-3: auto resize / DPR tracking wiring + teardown mirror ────────

class FakeRO {
  static instances: FakeRO[] = []
  observed: unknown[] = []
  disconnected = false
  constructor(public cb: () => void) { FakeRO.instances.push(this) }
  observe(el: unknown): void { this.observed.push(el) }
  unobserve(): void {}
  disconnect(): void { this.disconnected = true }
}

class FakeMQL {
  listeners: Array<{ fn: () => void; once: boolean }> = []
  constructor(public query: string) {}
  addEventListener(_t: string, fn: () => void, opts?: { once?: boolean }): void {
    this.listeners.push({ fn, once: opts?.once === true })
  }
  removeEventListener(_t: string, fn: () => void): void {
    this.listeners = this.listeners.filter((l) => l.fn !== fn)
  }
  fire(): void {
    const snapshot = [...this.listeners]
    this.listeners = this.listeners.filter((l) => !l.once)
    for (const l of snapshot) l.fn()
  }
}

describe('P0-3: auto resize / DPR tracking', () => {
  let mqls: FakeMQL[]

  beforeEach(() => {
    FakeRO.instances = []
    mqls = []
    vi.stubGlobal('ResizeObserver', FakeRO)
    vi.stubGlobal('window', {
      devicePixelRatio: 2,
      matchMedia: (q: string) => { const m = new FakeMQL(q); mqls.push(m); return m },
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('observes the canvas itself when unparented; both observers funnel into onResize', () => {
    const onResize = vi.fn()
    const canvas = stubCanvas()
    const detach = attachAutoResize(canvas, onResize)
    // (a) container resize → onResize
    expect(FakeRO.instances).toHaveLength(1)
    expect(FakeRO.instances[0]!.observed).toEqual([canvas])
    FakeRO.instances[0]!.cb()
    expect(onResize).toHaveBeenCalledTimes(1)
    // (b) DPR chain armed on the CURRENT dpr; change → onResize + re-arm
    expect(mqls).toHaveLength(1)
    expect(mqls[0]!.query).toBe('(resolution: 2dppx)')
    mqls[0]!.fire()
    expect(onResize).toHaveBeenCalledTimes(2)
    expect(mqls).toHaveLength(2) // fresh MediaQueryList re-armed
    // detach mirrors both attaches
    detach()
    expect(FakeRO.instances[0]!.disconnected).toBe(true)
    expect(mqls[1]!.listeners).toHaveLength(0)
  })

  it('observes the parent container when the canvas has one', () => {
    const canvas = stubCanvas()
    const parent = { __container: true }
    ;(canvas as unknown as { parentElement: unknown }).parentElement = parent
    attachAutoResize(canvas, () => {})
    expect(FakeRO.instances[0]!.observed).toEqual([parent])
  })

  it('XGISMap attaches at ctor (funnels into resize()) and detaches in destroy()', () => {
    const map = new XGISMap(stubCanvas())
    expect(FakeRO.instances).toHaveLength(1)
    const resizeSpy = vi.spyOn(map, 'resize')
    FakeRO.instances[0]!.cb()
    expect(resizeSpy).toHaveBeenCalledTimes(1)
    const live = mqls[mqls.length - 1]!
    expect(live.listeners).toHaveLength(1)
    map.destroy() // teardown mirror
    expect(FakeRO.instances[0]!.disconnected).toBe(true)
    expect(live.listeners).toHaveLength(0)
  })

  it('no-ops safely when ResizeObserver / matchMedia are unavailable (test envs)', () => {
    vi.unstubAllGlobals()
    const map = new XGISMap(stubCanvas())
    expect(() => map.destroy()).not.toThrow()
    expect(() => attachAutoResize(stubCanvas(), () => {})()).not.toThrow()
  })
})
