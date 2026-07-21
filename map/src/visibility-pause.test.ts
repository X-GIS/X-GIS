// ═══ attachVisibilityPause routing + teardown (#1153 M5) ═══
//
// The module wires document 'visibilitychange' (routed by visibilityState),
// window 'pagehide' → onHidden, and window 'pageshow' → onVisible (bfcache
// restore may skip visibilitychange). detach() must remove ALL THREE.
//
// Fail-before (by construction): a library-wide grep for visibilitychange was 0
// — this module did not exist, so no hidden/visible routing occurred at all.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { attachVisibilityPause } from './visibility-pause'

function makeTarget() {
  const listeners: Record<string, Array<() => void>> = {}
  return {
    target: {
      addEventListener(type: string, cb: () => void) {
        ;(listeners[type] ??= []).push(cb)
      },
      removeEventListener(type: string, cb: () => void) {
        listeners[type] = (listeners[type] ?? []).filter((f) => f !== cb)
      },
    },
    fire(type: string) {
      for (const f of listeners[type] ?? []) f()
    },
    count(type: string) {
      return (listeners[type] ?? []).length
    },
  }
}

const g = globalThis as unknown as { document?: unknown; window?: unknown }
const HAD_DOC = 'document' in globalThis
const HAD_WIN = 'window' in globalThis
afterEach(() => {
  if (!HAD_DOC) delete g.document
  if (!HAD_WIN) delete g.window
})

function setup(visibility: 'visible' | 'hidden' = 'visible') {
  const doc = makeTarget()
  const win = makeTarget()
  let vis = visibility
  Object.defineProperty(doc.target, 'visibilityState', { get: () => vis, configurable: true })
  g.document = doc.target
  g.window = win.target
  return { doc, win, setVis: (v: 'visible' | 'hidden') => (vis = v) }
}

describe('attachVisibilityPause (#1153 M5)', () => {
  it('visibilitychange routes by visibilityState (hidden→onHidden, visible→onVisible)', () => {
    const { doc, setVis } = setup('visible')
    const onHidden = vi.fn()
    const onVisible = vi.fn()
    attachVisibilityPause({ onHidden, onVisible })
    setVis('hidden')
    doc.fire('visibilitychange')
    expect(onHidden).toHaveBeenCalledTimes(1)
    expect(onVisible).not.toHaveBeenCalled()
    setVis('visible')
    doc.fire('visibilitychange')
    expect(onVisible).toHaveBeenCalledTimes(1)
  })

  it('pagehide → onHidden (parks identically to visibilitychange-hidden)', () => {
    const { win } = setup('visible')
    const onHidden = vi.fn()
    attachVisibilityPause({ onHidden, onVisible: () => {} })
    win.fire('pagehide')
    expect(onHidden).toHaveBeenCalledTimes(1)
  })

  it('pageshow resumes ONLY when visible (bfcache restore that skips visibilitychange)', () => {
    const { win, setVis } = setup('hidden')
    const onVisible = vi.fn()
    attachVisibilityPause({ onHidden: () => {}, onVisible })
    win.fire('pageshow') // still hidden → no resume
    expect(onVisible).not.toHaveBeenCalled()
    setVis('visible')
    win.fire('pageshow')
    expect(onVisible).toHaveBeenCalledTimes(1)
  })

  it('detach removes visibilitychange, pagehide AND pageshow listeners', () => {
    const { doc, win } = setup('visible')
    const detach = attachVisibilityPause({ onHidden: () => {}, onVisible: () => {} })
    expect(doc.count('visibilitychange')).toBe(1)
    expect(win.count('pagehide')).toBe(1)
    expect(win.count('pageshow')).toBe(1)
    detach()
    expect(doc.count('visibilitychange')).toBe(0)
    expect(win.count('pagehide')).toBe(0)
    expect(win.count('pageshow')).toBe(0)
  })

  it('non-DOM env → no-op detach, no throw', () => {
    if (!HAD_DOC) delete g.document
    const detach = attachVisibilityPause({ onHidden: () => {}, onVisible: () => {} })
    expect(() => detach()).not.toThrow()
  })
})
