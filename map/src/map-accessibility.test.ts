import { describe, expect, it, vi } from 'vitest'
import {
  resolveReducedMotion,
  reducedMotionMediaMatches,
  watchReducedMotion,
} from './map-accessibility'

// #1260 — prefers-reduced-motion precedence + the DOM-guarded helpers. The
// precedence is a PURE function so it pins without a DOM (mirrors how #1256
// unit-tests the camera reduced-motion via injected deps, not matchMedia).

describe('resolveReducedMotion (#1260 precedence: host override wins)', () => {
  it('undefined override consults the media query', () => {
    expect(resolveReducedMotion(undefined, true)).toBe(true)
    expect(resolveReducedMotion(undefined, false)).toBe(false)
  })

  it('respectReducedMotion:false (override false) forces motion ON — media query ignored', () => {
    // The kiosk/demo escape hatch: even with the OS asking for reduced motion,
    // an explicit opt-out keeps every animation running.
    expect(resolveReducedMotion(false, true)).toBe(false)
    expect(resolveReducedMotion(false, false)).toBe(false)
  })

  it('override true forces reduced motion regardless of the media query', () => {
    expect(resolveReducedMotion(true, false)).toBe(true)
    expect(resolveReducedMotion(true, true)).toBe(true)
  })
})

describe('reducedMotionMediaMatches (DOM guard)', () => {
  it('is false when matchMedia is absent (non-DOM / SSR / tests)', () => {
    // Default node env: no window.matchMedia → animates exactly as before.
    expect(reducedMotionMediaMatches()).toBe(false)
  })

  it('reads .matches when matchMedia is present', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }))
    expect(reducedMotionMediaMatches()).toBe(true)
    vi.unstubAllGlobals()
  })

  it('swallows a throwing matchMedia (defensive) → false', () => {
    vi.stubGlobal('matchMedia', () => {
      throw new Error('boom')
    })
    expect(reducedMotionMediaMatches()).toBe(false)
    vi.unstubAllGlobals()
  })
})

describe('watchReducedMotion (live listener)', () => {
  it('returns a no-op teardown when matchMedia is absent', () => {
    const teardown = watchReducedMotion(() => {})
    expect(() => teardown()).not.toThrow()
  })

  it('subscribes to the change event and the teardown unsubscribes', () => {
    let listener: (() => void) | null = null
    const removed: string[] = []
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: false,
      media: query,
      addEventListener: (_e: string, h: () => void) => {
        listener = h
      },
      removeEventListener: (e: string) => {
        removed.push(e)
      },
    }))
    let fired = 0
    const teardown = watchReducedMotion(() => fired++)
    expect(listener).not.toBeNull()
    listener!() // OS flipped the setting
    expect(fired).toBe(1)
    teardown()
    expect(removed).toContain('change')
    vi.unstubAllGlobals()
  })
})
