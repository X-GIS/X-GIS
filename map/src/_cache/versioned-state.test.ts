// iter-282 — VersionedState + Epoch unit tests
import { describe, it, expect } from 'vitest'
import { VersionedState, Epoch } from './versioned-state'

describe('VersionedState', () => {
  it('starts at version 0', () => {
    const s = new VersionedState(42)
    expect(s.version()).toBe(0)
    expect(s.value).toBe(42)
  })

  it('set bumps version', () => {
    const s = new VersionedState(1)
    s.set(2)
    expect(s.value).toBe(2)
    expect(s.version()).toBe(1)
    s.set(3)
    expect(s.version()).toBe(2)
  })

  it('bump advances version without changing value', () => {
    const s = new VersionedState({ x: 1 })
    const ref = s.value
    s.bump()
    expect(s.value).toBe(ref) // same reference
    expect(s.version()).toBe(1)
  })

  it('set with same reference still bumps', () => {
    const s = new VersionedState(1)
    s.set(1)
    expect(s.version()).toBe(1)
  })

  it('handles object references', () => {
    const a = { z: 0 }
    const b = { z: 1 }
    const s = new VersionedState(a)
    expect(s.value).toBe(a)
    s.set(b)
    expect(s.value).toBe(b)
    expect(s.version()).toBe(1)
  })
})

describe('Epoch', () => {
  it('starts at 0', () => {
    const e = new Epoch()
    expect(e.value()).toBe(0)
  })

  it('bump advances', () => {
    const e = new Epoch()
    e.bump()
    expect(e.value()).toBe(1)
    e.bump()
    expect(e.value()).toBe(2)
  })

  it('two Epoch instances independent', () => {
    const a = new Epoch()
    const b = new Epoch()
    a.bump()
    expect(a.value()).toBe(1)
    expect(b.value()).toBe(0)
  })
})

describe('cache-key composition', () => {
  it('cache key over versions is integer-stable', () => {
    const camera = new VersionedState({ zoom: 0 })
    const tiles = new VersionedState<number[]>([1, 2, 3])
    const k1 = `${camera.version()}|${tiles.version()}`
    // No mutation → same key.
    const k2 = `${camera.version()}|${tiles.version()}`
    expect(k1).toBe(k2)
    // Mutate tiles → key changes.
    tiles.bump()
    const k3 = `${camera.version()}|${tiles.version()}`
    expect(k3).not.toBe(k1)
    // Mutate camera → key changes again.
    camera.set({ zoom: 1 })
    const k4 = `${camera.version()}|${tiles.version()}`
    expect(k4).not.toBe(k3)
  })

  it('value-noise insensitive — only explicit bumps move version', () => {
    // The iter-282 point: float-matrix-style state can be assigned
    // re-equal references every frame. As long as .set is called
    // only on semantic change, cache hits are stable.
    const mvp = new VersionedState<Float32Array>(new Float32Array(16))
    const v0 = mvp.version()
    // Frame passes without semantic change — no .set call.
    expect(mvp.version()).toBe(v0)
    // Semantic change (camera moved) — set new MVP.
    mvp.set(new Float32Array(16))
    expect(mvp.version()).toBeGreaterThan(v0)
  })
})
