// ═══ Cursor feedback policy (#1263) — grab / grabbing / pointer ═══
//
// Fail-before (by construction): `map/src/cursor.ts` did not exist — no
// resolver, no controller — so every assertion below failed at import.
//
// resolveCursor pins the PRIORITY (a press outranks a hover); the controller
// pins the DOM contract: seed `grab`, react to the two boolean inputs, respect
// host intent, and restore on destroy with a no-clobber guard. No real canvas —
// a plain `{ style: { cursor } }` mock is the whole surface the controller
// touches, and `getComputedStyle` is stubbed per-test (vitest node env leaves
// it undefined by default).

import { describe, it, expect, afterEach } from 'vitest'
import { CanvasCursorController, resolveCursor } from './cursor'

function stubCanvas(inlineCursor = ''): HTMLCanvasElement {
  return { style: { cursor: inlineCursor } } as unknown as HTMLCanvasElement
}

const g = globalThis as unknown as { getComputedStyle?: unknown }
const HAD_GCS = 'getComputedStyle' in globalThis
afterEach(() => {
  if (!HAD_GCS) delete g.getComputedStyle
})

describe('resolveCursor — priority', () => {
  it('rest ⇒ grab', () => expect(resolveCursor(false, false)).toBe('grab'))
  it('press ⇒ grabbing', () => expect(resolveCursor(true, false)).toBe('grabbing'))
  it('hover ⇒ pointer', () => expect(resolveCursor(false, true)).toBe('pointer'))
  it('press outranks hover ⇒ grabbing', () => expect(resolveCursor(true, true)).toBe('grabbing'))
})

describe('CanvasCursorController — managed lifecycle', () => {
  it('seeds grab at rest when enabled and the host expressed no intent', () => {
    const canvas = stubCanvas('')
    new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('grab')
  })

  it('grab → grabbing → grab across a press (setInteracting)', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('grab')
    c.setInteracting(true)
    expect(canvas.style.cursor).toBe('grabbing')
    c.setInteracting(false)
    expect(canvas.style.cursor).toBe('grab')
  })

  it('grab → pointer over a feature, back to grab (setHovering)', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    c.setHovering(true)
    expect(canvas.style.cursor).toBe('pointer')
    c.setHovering(false)
    expect(canvas.style.cursor).toBe('grab')
  })

  it('a press begun over a feature shows grabbing, resolving to pointer on release', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    c.setHovering(true)
    expect(canvas.style.cursor).toBe('pointer')
    c.setInteracting(true)
    expect(canvas.style.cursor, 'press outranks hover').toBe('grabbing')
    c.setInteracting(false)
    expect(canvas.style.cursor, 'still over the feature on release').toBe('pointer')
    c.setHovering(false)
    expect(canvas.style.cursor).toBe('grab')
  })

  it('restores the prior inline cursor on destroy', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('grab')
    c.destroy()
    expect(canvas.style.cursor).toBe('')
  })

  it('no-clobber: a host mutation mid-session survives destroy', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('grab')
    canvas.style.cursor = 'wait' // host takes the cursor over
    c.destroy()
    expect(canvas.style.cursor).toBe('wait')
  })
})

describe('CanvasCursorController — host intent / opt-out', () => {
  it('opt-out (enabled=false) never touches the style', () => {
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, false)
    expect(canvas.style.cursor).toBe('')
    c.setInteracting(true)
    c.setHovering(true)
    expect(canvas.style.cursor).toBe('')
    c.destroy()
    expect(canvas.style.cursor).toBe('')
  })

  it('inline host cursor is preserved (never managed)', () => {
    const canvas = stubCanvas('crosshair')
    const c = new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('crosshair')
    c.setInteracting(true)
    expect(canvas.style.cursor).toBe('crosshair')
    c.destroy()
    expect(canvas.style.cursor).toBe('crosshair')
  })

  it('non-default computed cursor (stylesheet intent) is respected → not managed', () => {
    g.getComputedStyle = () => ({ cursor: 'crosshair' }) as CSSStyleDeclaration
    const canvas = stubCanvas('')
    const c = new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('') // intent detected → left untouched
    c.setInteracting(true)
    expect(canvas.style.cursor).toBe('')
  })

  it('computed "auto"/"default" is NOT intent → grab is seeded', () => {
    g.getComputedStyle = () => ({ cursor: 'auto' }) as CSSStyleDeclaration
    const canvas = stubCanvas('')
    new CanvasCursorController(canvas, true)
    expect(canvas.style.cursor).toBe('grab')
  })
})
