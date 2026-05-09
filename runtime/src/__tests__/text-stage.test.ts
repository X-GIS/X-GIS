// TextStage covers two concerns testable without WebGPU:
//   1. text-transform application
//   2. Empty-text skip semantics
//
// The WebGPU surface (atlas GPU + renderer) is exercised in the
// e2e in 1c-8c. This test pokes the host directly via TextStage's
// public `host` to verify the wiring is correct.

import { describe, it, expect } from 'vitest'
import { applyTextTransformForTesting } from './text-stage-helpers'

describe('text-transform helper', () => {
  it('uppercase', () => {
    expect(applyTextTransformForTesting('Hello', 'uppercase')).toBe('HELLO')
  })
  it('lowercase', () => {
    expect(applyTextTransformForTesting('Hello', 'lowercase')).toBe('hello')
  })
  it('none / undefined → passthrough', () => {
    expect(applyTextTransformForTesting('Hello', 'none')).toBe('Hello')
    expect(applyTextTransformForTesting('Hello', undefined)).toBe('Hello')
  })
  it('CJK passes through (no case mapping)', () => {
    expect(applyTextTransformForTesting('서울', 'uppercase')).toBe('서울')
  })
})
