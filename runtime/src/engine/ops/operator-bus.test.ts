import { describe, it, expect } from 'vitest'
import { DirtyTracker, DirtyDomain } from '../state/dirty'
import { OperatorBus } from './operator-bus'

describe('OperatorBus', () => {
  it('records op and tags dirty domain', () => {
    const dirty = new DirtyTracker()
    dirty.clear()
    const bus = new OperatorBus(dirty)
    bus.dispatch({ kind: 'SetProjection', name: 'globe' }, DirtyDomain.PROJECTION)
    expect(dirty.peek(DirtyDomain.PROJECTION)).toBe(true)
    expect(bus.lastOp()?.kind).toBe('SetProjection')
    expect(bus.depth).toBe(1)
  })

  it('keeps depth bounded at 256 (shift oldest) and lastOp is newest', () => {
    const dirty = new DirtyTracker()
    const bus = new OperatorBus(dirty)
    for (let i = 0; i < 300; i++) {
      bus.dispatch({ kind: 'SetGraticule', value: i % 2 === 0 }, DirtyDomain.STYLE)
    }
    expect(bus.depth).toBe(256)
    // lastOp should be the most recent dispatch (i=299 → value=false since 299%2!==0)
    expect((bus.lastOp() as { kind: string; value: unknown }).value).toBe(false)
  })

  it('tags multiple domains via OR', () => {
    const dirty = new DirtyTracker()
    dirty.clear()
    const bus = new OperatorBus(dirty)
    bus.dispatch(
      { kind: 'SetBackgroundFill', value: [1, 0, 0, 1] },
      DirtyDomain.STYLE | DirtyDomain.GEOMETRY,
    )
    expect(dirty.peek(DirtyDomain.STYLE)).toBe(true)
    expect(dirty.peek(DirtyDomain.GEOMETRY)).toBe(true)
    expect(dirty.peek(DirtyDomain.CAMERA)).toBe(false)
  })
})
