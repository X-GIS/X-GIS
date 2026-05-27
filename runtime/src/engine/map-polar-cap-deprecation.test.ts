// Phase 1a / Tier 3 source-honest principle (PRD US-004): asserts
// XGISMap.setPolarCapsEnabled is now a no-op + one-shot xlog.warn deprecation.
// Replaces the prior renderer-driven auto-cap synthesis path.
//
// _polarCapsWarned is module-scoped (one-shot per process lifetime). Tests
// therefore live in a single `it` block so the flag's behavior across
// repeated calls is observable in one shared session — vitest runs each
// file in its own worker, so this file's process has a fresh flag at start.

import { describe, it, expect } from 'vitest'
import { setLogSink } from './log'
import { XGISMap } from './map'

describe('XGISMap.setPolarCapsEnabled deprecation (Phase 1a)', () => {
  // The method does not depend on `this` for its no-op + warn behavior — the
  // module-scoped `_polarCapsWarned` flag drives idempotency. Bypass the GPU
  // constructor by attaching the prototype to a bare object.
  const makeStub = (): XGISMap => Object.create(XGISMap.prototype) as XGISMap

  it('is a no-op that emits the deprecation warning at most once per session', () => {
    const warnings: string[] = []
    setLogSink((level, message) => {
      if (level === 'warn') warnings.push(message)
    })

    try {
      const map = makeStub()

      // (AC1) does not throw
      expect(() => map.setPolarCapsEnabled(true)).not.toThrow()

      // (AC2) emitted exactly one warning containing the source-honest text
      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toMatch(/no longer renderer-driven/)
      expect(warnings[0]).toMatch(/injectPolarCaps/)
      expect(warnings[0]).toMatch(/synthesizePolarCaps/)

      // (AC3) repeated calls neither throw nor re-warn
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
