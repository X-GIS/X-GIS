// ═══ Canvas touch-action policy (#1153 M1) ═══
//
// On iOS/Android the browser hijacks pan/pinch on the canvas as page scroll,
// firing repeated pointercancel → the map's own gestures break for any
// third-party embed. Like MapLibre/Mapbox, the library sets the canvas's inline
// `touch-action: none` at construction — but ONLY when the host has not already
// expressed intent (an inline value OR a non-`auto` computed value), and it
// restores the prior inline value on destroy() unless the host mutated it since.
//
// Fail-before (by construction): a library-wide grep for touch-action was 0 —
// `_setupTouchAction` did not exist, so a fresh map left canvas.style.touchAction
// untouched (the 'sets none' assertions below would fail).

import { describe, it, expect, afterEach } from 'vitest'
import { XGISMap } from './map'

function stubCanvas(inlineTouchAction = ''): HTMLCanvasElement {
  return {
    width: 256,
    height: 256,
    clientWidth: 256,
    clientHeight: 256,
    style: { touchAction: inlineTouchAction } as CSSStyleDeclaration,
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
  if (HAD_GCS) return
  delete g.getComputedStyle
})

describe('#1153 M1 — canvas touch-action', () => {
  it('default: sets inline touch-action "none" (empty inline, no computed intent)', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.touchAction).toBe('none')
    // destroy restores the prior inline value ('').
    map.destroy()
    expect(canvas.style.touchAction).toBe('')
  })

  it('host inline touch-action is preserved (not overwritten), and left untouched on destroy', () => {
    const canvas = stubCanvas('pan-x')
    const map = new XGISMap(canvas)
    expect(canvas.style.touchAction).toBe('pan-x') // untouched
    map.destroy()
    expect(canvas.style.touchAction).toBe('pan-x') // still the host's
  })

  it('opt-out (touchAction: false) never touches the style', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas, { touchAction: false })
    expect(canvas.style.touchAction).toBe('') // untouched
    map.destroy()
    expect(canvas.style.touchAction).toBe('')
  })

  it('explicit string sets that value unconditionally and restores the prior inline on destroy', () => {
    const canvas = stubCanvas('pan-x') // a prior inline value
    const map = new XGISMap(canvas, { touchAction: 'manipulation' })
    expect(canvas.style.touchAction).toBe('manipulation')
    map.destroy()
    expect(canvas.style.touchAction).toBe('pan-x') // prior restored
  })

  it('mid-session host mutation: destroy leaves the host value (no-clobber restore guard)', () => {
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.touchAction).toBe('none') // library applied
    canvas.style.touchAction = 'pan-y' // host overrides mid-session
    map.destroy()
    expect(canvas.style.touchAction).toBe('pan-y') // NOT clobbered back to ''
  })

  it('stylesheet intent (non-auto computed, empty inline) is respected → inline left untouched', () => {
    g.getComputedStyle = () => ({ touchAction: 'pan-x' }) as CSSStyleDeclaration
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.touchAction).toBe('') // computed intent → not set
    map.destroy()
  })

  it('computed "auto" (the CSS default) is NOT intent → inline "none" is applied', () => {
    g.getComputedStyle = () => ({ touchAction: 'auto' }) as CSSStyleDeclaration
    const canvas = stubCanvas('')
    const map = new XGISMap(canvas)
    expect(canvas.style.touchAction).toBe('none')
    map.destroy()
  })
})
