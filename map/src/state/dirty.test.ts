import { describe, it, expect } from 'vitest'
import { DirtyTracker, DirtyDomain, DIRTY_ALL } from './dirty'

describe('DirtyTracker', () => {
  it('starts fully dirty', () => {
    const t = new DirtyTracker()
    expect(t.any()).toBe(true)
    expect(t.peek(DIRTY_ALL)).toBe(true)
  })

  it('clear() leaves nothing dirty', () => {
    const t = new DirtyTracker()
    t.clear()
    expect(t.any()).toBe(false)
  })

  it('tag then consume is read-and-clear', () => {
    const t = new DirtyTracker()
    t.clear()
    t.tag(DirtyDomain.CAMERA)
    expect(t.consume(DirtyDomain.CAMERA)).toBe(true)
    expect(t.consume(DirtyDomain.CAMERA)).toBe(false)
  })

  it('consume of non-tagged domain returns false', () => {
    const t = new DirtyTracker()
    t.clear()
    expect(t.consume(DirtyDomain.STYLE)).toBe(false)
  })

  it('tag multiple domains — consume one leaves others dirty', () => {
    const t = new DirtyTracker()
    t.clear()
    t.tag(DirtyDomain.CAMERA | DirtyDomain.STYLE)
    expect(t.peek(DirtyDomain.CAMERA)).toBe(true)
    expect(t.consume(DirtyDomain.STYLE)).toBe(true)
    expect(t.peek(DirtyDomain.CAMERA)).toBe(true)
    expect(t.peek(DirtyDomain.STYLE)).toBe(false)
  })

  it('DIRTY_ALL consume after tag(LABEL) returns true and clears all', () => {
    const t = new DirtyTracker()
    t.clear()
    t.tag(DirtyDomain.LABEL)
    expect(t.consume(DIRTY_ALL)).toBe(true)
    expect(t.any()).toBe(false)
  })
})
