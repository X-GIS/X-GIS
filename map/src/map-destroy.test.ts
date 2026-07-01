import { describe, it, expect } from 'vitest'
import { XGISMap } from './map'

// destroy() teardown is GPU-free in its guard/null-safety paths, so the
// idempotency + post-destroy-inert contract is unit-testable on a
// never-run map (ctx undefined, controller null, vtSources empty). The
// full heap/GPU unmount-leak assertion lives in the browser e2e gate.

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

describe('XGISMap.destroy()', () => {
  it('tears down a never-run map without throwing, and is idempotent', () => {
    const map = new XGISMap(stubCanvas())
    expect(() => map.destroy()).not.toThrow()
    expect(() => map.destroy()).not.toThrow()
  })

  it('leaves the map inert — post-destroy invalidate() no-ops safely', () => {
    const map = new XGISMap(stubCanvas())
    map.destroy()
    expect(() => map.invalidate()).not.toThrow()
  })
})
