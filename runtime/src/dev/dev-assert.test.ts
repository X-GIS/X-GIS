import { describe, it, expect, vi } from 'vitest'
import { devAssert, devAssertClose, devWatch, devWatchReset, DEV } from './dev-assert'

// vitest runs under Vite → import.meta.env.DEV is true, so the checks are
// LIVE here. These pin the primitive's behaviour (the engine relies on it
// firing in dev / passing in prod-stripped builds).
describe('dev-assert', () => {
  it('DEV is true under vitest', () => {
    expect(DEV).toBe(true)
  })

  it('devAssert throws on false, passes on true', () => {
    expect(() => devAssert(false, 'boom')).toThrow(/boom/)
    expect(() => devAssert(true, 'ok')).not.toThrow()
  })

  it('devAssert message thunk only evaluates on failure', () => {
    const built = vi.fn(() => 'lazy')
    devAssert(true, built)
    expect(built).not.toHaveBeenCalled()
    expect(() => devAssert(false, built)).toThrow(/lazy/)
    expect(built).toHaveBeenCalledOnce()
  })

  it('devAssertClose: drift beyond eps throws and reports the delta', () => {
    // fail-before witness: the H2 archetype — two paths 0.5 apart, eps 0.1.
    expect(() => devAssertClose(1.0, 1.5, 0.1, 'fill/outline drift')).toThrow(/fill\/outline drift/)
    expect(() => devAssertClose(1.0, 1.5, 0.1, 'd')).toThrow(/= 0\.5 > 0\.1/)
  })

  it('devAssertClose: within eps passes', () => {
    expect(() => devAssertClose(1.0, 1.05, 0.1, 'ok')).not.toThrow()
  })

  it('devAssertClose: NaN on either side fires', () => {
    expect(() => devAssertClose(NaN, 1, 0.1, 'nan')).toThrow()
    expect(() => devAssertClose(1, NaN, 0.1, 'nan')).toThrow()
  })

  it('devWatch fires onChange the tick a value moves beyond eps', () => {
    devWatchReset('t')
    const onChange = vi.fn()
    devWatch('t', 10, 0, onChange)   // first reading — no prior, no fire
    expect(onChange).not.toHaveBeenCalled()
    devWatch('t', 10, 0, onChange)   // unchanged — no fire
    expect(onChange).not.toHaveBeenCalled()
    devWatch('t', 12, 0, onChange)   // moved — fire with (prev,next)
    expect(onChange).toHaveBeenCalledWith(10, 12)
  })

  it('devWatch respects eps (ignores sub-threshold jitter)', () => {
    devWatchReset('j')
    const onChange = vi.fn()
    devWatch('j', 100, 1, onChange)
    devWatch('j', 100.4, 1, onChange) // within eps — no fire
    expect(onChange).not.toHaveBeenCalled()
    devWatch('j', 102, 1, onChange)   // beyond eps — fire
    expect(onChange).toHaveBeenCalledOnce()
  })
})
