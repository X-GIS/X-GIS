// The deprecation flag is module-scoped (one-shot per process lifetime).
// Vitest isolates each file in its own worker, so this file gets a fresh
// flag — the single `it` block is what makes the one-shot behavior
// observable across repeated calls.

import { describe, it, expect } from 'vitest'
import { setLogSink } from '@xgis/shared'
import { XGISMap } from './map'
import { ViewportModeController } from '@xgis/map'
import { Camera } from './camera'

describe('XGISMap.setPolarCapsEnabled deprecation', () => {
  // setPolarCapsEnabled forwards to the ViewportModeController collaborator
  // (it owns the deprecated stub). Bypass the GPU constructor with a bare
  // prototype object, but wire the one collaborator the forwarder reaches —
  // a real controller whose setPolarCapsEnabled is self-contained (only the
  // module-scoped one-shot warn guard, no camera/renderer use).
  const makeStub = (): XGISMap => {
    const map = Object.create(XGISMap.prototype) as XGISMap
    const viewport = new ViewportModeController(new Camera(0, 0, 0), {
      getRenderer: () => undefined,
      onWorldBandChange: () => {},
    })
    ;(map as unknown as { _viewport: ViewportModeController })._viewport = viewport
    return map
  }

  it('is a no-op that emits the deprecation warning at most once per session', () => {
    const warnings: string[] = []
    setLogSink((level, message) => {
      if (level === 'warn') warnings.push(message)
    })

    try {
      const map = makeStub()

      expect(() => map.setPolarCapsEnabled(true)).not.toThrow()

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/no longer renderer-driven/)
      expect(warnings[0]).toMatch(/injectPolarCaps/)
      expect(warnings[0]).toMatch(/synthesizePolarCaps/)

      expect(() => {
        map.setPolarCapsEnabled(false)
        map.setPolarCapsEnabled(true)
        map.setPolarCapsEnabled(true)
      }).not.toThrow()
      expect(warnings).toHaveLength(1)
    } finally {
      setLogSink(null)
    }
  })
})
