// The deprecation flag is module-scoped (one-shot per process lifetime).
// Vitest isolates each file in its own worker, so this file gets a fresh
// flag — the single `it` block is what makes the one-shot behavior
// observable across repeated calls.

import { describe, it, expect } from 'vitest'
import { setLogSink } from './log'
import { XGISMap } from './map'

describe('XGISMap.setPolarCapsEnabled deprecation', () => {
  // setPolarCapsEnabled does not touch `this`, so bypassing the GPU
  // constructor with a bare prototype object is sufficient.
  const makeStub = (): XGISMap => Object.create(XGISMap.prototype) as XGISMap

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
