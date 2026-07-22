// ═══ Built-in cursor feedback wiring (#1263) ═══
//
// The unit-level policy (grab/grabbing/pointer priority, host intent, no-clobber
// restore) is proven in cursor.test.ts against CanvasCursorController directly.
// This file proves the MAP-level plumbing that unit test can't reach: the
// `cursor` option reaches the controller, the canvas is seeded `grab` at
// construction, a host cursor is respected, and destroy() restores.
//
// Note: the dynamic grab→grabbing→pointer transitions run through the pointer
// controller + dispatcher, which only attach after run() (GPU). Those live in
// cursor.test.ts / event-dispatcher-hover-cursor.test.ts; here we pin the
// constructor-time contract, mirroring map-touch-action.test.ts.
//
// Fail-before (by construction): `_cursor` / the `cursor` option did not exist,
// so a fresh map left canvas.style.cursor untouched ('' not 'grab').

import { describe, it, expect, afterEach } from 'vitest'
import { XGISMap } from './map'

function stubCanvas(inlineCursor = ''): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: { cursor: inlineCursor, touchAction: '' } as CSSStyleDeclaration,
    addEventListener() {},
    removeEventListener() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, right: 256, bottom: 256, width: 256, height: 256 }
    },
    setPointerCapture() {},
    releasePointerCapture() {},
  } as unknown as HTMLCanvasElement
}

const g = globalThis as unknown as { getComputedStyle?: unknown }
const HAD_GCS = 'getComputedStyle' in globalThis
afterEach(() => {
  if (!HAD_GCS) delete g.getComputedStyle
})

describe('#1263 — built-in cursor feedback', () => {
  it('default: seeds inline cursor "grab", restores "" on destroy', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.cursor).toBe('grab')
    map.destroy()
    expect(canvas.style.cursor).toBe('')
  })

  it('host inline cursor is preserved (not overwritten) and left on destroy', () => {
    const canvas = stubCanvas('crosshair')
    const map = new XGISMap(canvas)
    expect(canvas.style.cursor).toBe('crosshair')
    map.destroy()
    expect(canvas.style.cursor).toBe('crosshair')
  })

  it('opt-out (cursor: false) never touches the style', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas, { cursor: false })
    expect(canvas.style.cursor).toBe('')
    map.destroy()
    expect(canvas.style.cursor).toBe('')
  })

  it('mid-session host mutation: destroy leaves the host value (no-clobber)', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.cursor).toBe('grab')
    canvas.style.cursor = 'wait' // host overrides mid-session
    map.destroy()
    expect(canvas.style.cursor).toBe('wait')
  })
})
