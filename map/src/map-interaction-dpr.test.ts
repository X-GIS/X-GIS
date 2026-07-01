import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XGISMap } from './map'
import { QUALITY } from '@xgis/engine'

// 0.5 adaptive-DPR: the render loop reads map._interacting to decide
// whether to pass `interacting` into resizeCanvas (which only matters when
// the host opted into a reduced QUALITY.interactionDpr). The flag is set on
// gesture input and cleared after a debounced idle. Verify the debounce
// contract with fake timers — no GPU needed.

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

describe('adaptive-DPR interaction flag', () => {
  let priorDpr: number | null
  beforeEach(() => {
    vi.useFakeTimers()
    // markInteracting is inert unless the host opted into a reduced
    // interactionDpr — enable it so the debounce path is exercised.
    priorDpr = QUALITY.interactionDpr
    QUALITY.interactionDpr = 1
  })
  afterEach(() => {
    vi.useRealTimers()
    QUALITY.interactionDpr = priorDpr
  })

  it('is inert in the default config (interactionDpr === null)', () => {
    QUALITY.interactionDpr = null
    const map = new XGISMap(stubCanvas())
    map.markInteracting()
    expect(map._interacting).toBe(false)
  })

  it('markInteracting sets the flag, idle debounce clears it', () => {
    const map = new XGISMap(stubCanvas())
    expect(map._interacting).toBe(false)
    map.markInteracting()
    expect(map._interacting).toBe(true)
    vi.advanceTimersByTime(499)
    expect(map._interacting).toBe(true)
    vi.advanceTimersByTime(2)
    expect(map._interacting).toBe(false)
  })

  it('repeated marks reset the debounce (flag stays set through a sustained gesture)', () => {
    const map = new XGISMap(stubCanvas())
    map.markInteracting()
    vi.advanceTimersByTime(400)
    map.markInteracting() // reset the 500ms window
    vi.advanceTimersByTime(400)
    expect(map._interacting).toBe(true) // still within the 2nd mark's window
    vi.advanceTimersByTime(200)
    expect(map._interacting).toBe(false)
  })

  it('destroy() clears a pending idle timer and markInteracting no-ops after', () => {
    const map = new XGISMap(stubCanvas())
    map.markInteracting()
    map.destroy()
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    map.markInteracting()
    expect(map._interacting).toBe(false)
  })
})
