// Unit tests for AllocCounter (Plan AAA Phase C.2, iter-240).
//
// Pins:
//   - disabled by default → bumpAlloc no-ops
//   - enabled flag → counts accumulate
//   - getAllocProfile returns lifetime totals
//   - snapshotAllocProfile returns per-call delta
//   - resetAllocProfile clears all counters

import { describe, it, expect, beforeEach } from 'vitest'
import {
  bumpAlloc, getAllocProfile, resetAllocProfile,
  snapshotAllocProfile, _setEnabled,
} from './alloc-counter'

beforeEach(() => {
  resetAllocProfile()
  _setEnabled(false)
})

describe('AllocCounter — gating', () => {
  it('disabled by default: bumpAlloc no-ops', () => {
    bumpAlloc('test.site')
    bumpAlloc('test.site')
    expect(getAllocProfile()).toEqual({})
  })

  it('enabled: bumps accumulate', () => {
    _setEnabled(true)
    bumpAlloc('a')
    bumpAlloc('a')
    bumpAlloc('b')
    const p = getAllocProfile()
    expect(p.a).toBe(2)
    expect(p.b).toBe(1)
  })
})

describe('AllocCounter — reset + snapshot', () => {
  it('resetAllocProfile clears state', () => {
    _setEnabled(true)
    bumpAlloc('x')
    bumpAlloc('x')
    resetAllocProfile()
    expect(getAllocProfile()).toEqual({})
  })

  it('snapshot returns delta since last call', () => {
    _setEnabled(true)
    bumpAlloc('a')
    bumpAlloc('a')
    bumpAlloc('a')
    expect(snapshotAllocProfile()).toEqual({ a: 3 })
    bumpAlloc('a')
    bumpAlloc('b')
    expect(snapshotAllocProfile()).toEqual({ a: 1, b: 1 })
    // No new bumps → empty delta
    expect(snapshotAllocProfile()).toEqual({})
  })

  it('lifetime getAllocProfile unaffected by snapshot calls', () => {
    _setEnabled(true)
    bumpAlloc('x')
    snapshotAllocProfile()
    bumpAlloc('x')
    expect(getAllocProfile()).toEqual({ x: 2 })
  })
})
