// ═══ typed 'error' event + _loaded reset (#1153 C) ═══
//
// Latent faults used to die silently: the 3-strike render halt stopped the loop
// with no signal (iOS surfaces a rAF throw as an opaque "Script error."), and a
// failed re-init left loaded() === true on a blank corpse. The fix adds a typed
// map-level 'error' event ({phase, fatal, error}) fired at the halt (and boot /
// device-loss elsewhere) and resets _loaded in _teardownForReinit.
//
// Harness mirrors p0-quartet.test.ts (P0-2): drive renderLoop() directly with a
// throwing renderFrame under a stubbed rAF, no GPU. Fail-before: 'error' is not a
// map event type + the halt fires nothing → the listener never sees the event.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import { XGISMap } from './map'

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

type ErrEvent = { type: string; phase?: string; fatal?: boolean; error?: unknown }
type LoopInternals = { running: boolean; renderFrame(): void }

describe("map 'error' event — 3-strike render halt (#1153 C)", () => {
  let rafSpy: ReturnType<typeof vi.fn>
  let errSpy: MockInstance

  beforeEach(() => {
    rafSpy = vi.fn()
    vi.stubGlobal('requestAnimationFrame', rafSpy)
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    errSpy.mockRestore()
  })

  it('fires exactly one error event {phase:halt, fatal:true} carrying the frame error', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as LoopInternals
    m.running = true
    const fault = new Error('persistent fault')
    m.renderFrame = () => {
      throw fault
    }
    map.invalidate()
    const errs: ErrEvent[] = []
    map.on('error', (e) => errs.push(e))

    map.renderLoop()
    map.renderLoop()
    map.renderLoop() // third consecutive failure → halt

    expect(m.running).toBe(false)
    expect(errs).toHaveLength(1)
    expect(errs[0]!.type).toBe('error')
    expect(errs[0]!.phase).toBe('halt')
    expect(errs[0]!.fatal).toBe(true)
    expect(errs[0]!.error).toBe(fault)
    map.destroy()
  })

  it('does not fire on a transient (single) frame fault that recovers', () => {
    const map = new XGISMap(stubCanvas())
    const m = map as unknown as LoopInternals
    m.running = true
    let calls = 0
    m.renderFrame = () => {
      calls++
      if (calls === 1) throw new Error('transient')
    }
    map.invalidate()
    const errs: ErrEvent[] = []
    map.on('error', (e) => errs.push(e))

    map.renderLoop() // fault 1 → retry, no halt
    map.renderLoop() // succeeds → counter resets

    expect(m.running).toBe(true)
    expect(errs).toHaveLength(0)
    map.destroy()
  })
})

describe('_teardownForReinit resets loaded() (#1153 C)', () => {
  it('a torn-down-then-failed swap does not keep loaded() === true', () => {
    const map = new XGISMap(stubCanvas())
    ;(map as unknown as { _loaded: boolean })._loaded = true
    expect(map.loaded()).toBe(true)
    ;(map as unknown as { _teardownForReinit: () => void })._teardownForReinit()
    expect(map.loaded()).toBe(false)
    map.destroy()
  })
})
