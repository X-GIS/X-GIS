// ═══ #2266 — DEV owner-leak detector bookkeeping ═══
//
// Real FinalizationRegistry behavior depends on GC timing, which no unit test
// may depend on — so the detector exposes an injectable registry seam and the
// tests assert the REGISTER/UNREGISTER bookkeeping (the part this repo owns).
// The finalize→warn hop is a 3-line callback pinned by reading, not by GC.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  trackOwner,
  untrackOwner,
  _setLeakRegistryForTest,
  type LeakRegistryLike,
} from './leak-detector'

function fakeRegistry() {
  const registered = new Map<object, string>()
  const reg: LeakRegistryLike = {
    register(target, held, token) {
      expect(token, 'the object itself is the unregister token').toBe(target)
      registered.set(target, held)
    },
    unregister(token) {
      registered.delete(token)
    },
  }
  return { reg, registered }
}

const g = globalThis as { __XGIS_INVARIANTS?: boolean }
let priorFlag: boolean | undefined

beforeEach(() => {
  priorFlag = g.__XGIS_INVARIANTS
})
afterEach(() => {
  g.__XGIS_INVARIANTS = priorFlag
  _setLeakRegistryForTest(undefined) // restore lazy auto-detection
})

describe('#2266 — leak-detector bookkeeping', () => {
  it('track registers with the label; untrack (destroy ran) unregisters', () => {
    g.__XGIS_INVARIANTS = true
    const { reg, registered } = fakeRegistry()
    _setLeakRegistryForTest(reg)
    const owner = {}
    trackOwner(owner, 'Material')
    expect(registered.get(owner)).toBe('Material')
    untrackOwner(owner)
    expect(registered.has(owner), 'destroyed owner must not warn on collection').toBe(false)
  })

  it('inactive without __XGIS_INVARIANTS — every call is a no-op', () => {
    g.__XGIS_INVARIANTS = false
    const { reg, registered } = fakeRegistry()
    _setLeakRegistryForTest(reg)
    const owner = {}
    trackOwner(owner, 'GPUArena')
    untrackOwner(owner)
    expect(registered.size).toBe(0)
  })

  it('untrack of a never-tracked owner is safe (guards may run before wiring)', () => {
    g.__XGIS_INVARIANTS = true
    const { reg } = fakeRegistry()
    _setLeakRegistryForTest(reg)
    expect(() => untrackOwner({})).not.toThrow()
  })
})
