import { describe, it, expect, afterEach } from 'vitest'
import { setSourceTracing, isSourceTracing, captureLoc, recordLoc, getLoc } from './loc'
import { module, fn, f32T, f32 } from '../ir'

afterEach(() => setSourceTracing(false))

describe('source-location capture', () => {
  it('is off by default → captureLoc returns undefined (zero-cost)', () => {
    setSourceTracing(false)
    expect(isSourceTracing()).toBe(false)
    expect(captureLoc()).toBeUndefined()
  })

  it('toggles on/off', () => {
    setSourceTracing(true)
    expect(isSourceTracing()).toBe(true)
    setSourceTracing(false)
    expect(isSourceTracing()).toBe(false)
  })

  it('recordLoc is a no-op for an undefined loc', () => {
    const node = {}
    recordLoc(node, undefined)
    expect(getLoc(node)).toBeUndefined()
  })

  it('records and reads back an explicit loc by object identity', () => {
    const node = {}
    const loc = { file: '/x/a.ts', line: 5, col: 2 }
    recordLoc(node, loc)
    expect(getLoc(node)).toEqual(loc)
  })

  it('when ON, authored fn statements carry a loc; when OFF, none', () => {
    setSourceTracing(false)
    const off = fn('off_fn', { x: f32T }, f32T, ({ x }) => x.add(f32(1)))
    expect(getLoc(off.body[0])).toBeUndefined()

    setSourceTracing(true)
    const on = fn('on_fn', { x: f32T }, f32T, ({ x }) => x.add(f32(1)))
    const loc = getLoc(on.body[0])
    expect(loc).toBeDefined()
    expect(loc!.file).toContain('loc.test.ts')
    expect(loc!.line).toBeGreaterThan(0)
    // The fn handle itself is loc-stamped too (Func-level diagnostics).
    expect(getLoc(on)).toBeDefined()

    void module({ funcs: [on] })
  })
})
