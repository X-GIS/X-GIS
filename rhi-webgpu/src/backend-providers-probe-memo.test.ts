// R5 (#1153 P2) — the webgl2 capability probe leaked one LIVE gl context per boot
// attempt (never released), and re-probed on every SPA remount because providers
// are re-created per boot. On iOS the per-page context cap then evicts the ACTIVE
// map's context (permanent blank after ~8-16 remounts). The fix memoizes the probe
// at MODULE scope (survives provider re-creation) and releases the scratch context
// via WEBGL_lose_context.
//
// Fail-before: the inline probe calls getContext on EVERY probe (no memo) and never
// calls loseContext, so the remount test sees 2 contexts + 0 releases.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  backendProviderChain,
  makeWebGl2BackendProvider,
  _resetWebgl2ProbeMemoForTests,
  type WebGl2DeviceFactory,
} from './backend-providers'

let getContextCalls = 0
let loseContextCalls = 0

function installFakeDocument(): void {
  ;(globalThis as unknown as { document?: unknown }).document = {
    createElement: (tag: string): unknown => {
      if (tag !== 'canvas') return {}
      return {
        getContext: (type: string): unknown => {
          if (type !== 'webgl2') return null
          getContextCalls++
          return {
            getExtension: (name: string): unknown =>
              name === 'WEBGL_lose_context'
                ? {
                    loseContext: () => {
                      loseContextCalls++
                    },
                  }
                : null,
          }
        },
      }
    },
  }
}

// The probe never constructs the device — a dummy factory is enough.
const dummyFactory = vi.fn() as unknown as WebGl2DeviceFactory
const BOOT = { sampleCount: 4 }

beforeEach(() => {
  getContextCalls = 0
  loseContextCalls = 0
  _resetWebgl2ProbeMemoForTests()
  installFakeDocument()
})
afterEach(() => {
  delete (globalThis as unknown as { document?: unknown }).document
  _resetWebgl2ProbeMemoForTests()
})

describe('webgl2 probe memoization + scratch-context release (#1153 P2 R5)', () => {
  it('probes at most one scratch context across SPA remounts and releases it once', async () => {
    // Two chains simulate an SPA remount — providers are freshly built each time,
    // so only a MODULE-level memo can prevent a second scratch context.
    const chain1 = backendProviderChain('webgl2', BOOT, dummyFactory)
    const chain2 = backendProviderChain('webgl2', BOOT, dummyFactory)

    const p1 = await chain1[0]!.probe()
    const p2 = await chain2[0]!.probe()

    expect(p1).toBe(true)
    expect(p2).toBe(true)
    expect(getContextCalls).toBe(1) // memo survived provider re-creation
    expect(loseContextCalls).toBe(1) // scratch context released, exactly once
  })

  it('re-probes after _resetWebgl2ProbeMemoForTests() (test-isolation seam)', async () => {
    const provider = makeWebGl2BackendProvider(dummyFactory)
    await provider.probe()
    expect(getContextCalls).toBe(1)

    _resetWebgl2ProbeMemoForTests()
    await provider.probe()
    expect(getContextCalls).toBe(2) // memo cleared → probes again
  })

  it('does NOT memoize a transient null probe — re-probes on the next boot', async () => {
    // getContext('webgl2') returning null can be TRANSIENT (GPU-process restart, or
    // the iOS per-page live-context cap momentarily exhausted — the very eviction R5
    // defends against). Caching `false` would strand the page in a false-negative
    // until reload; a null probe leaks nothing, so it must re-probe. Fail-before
    // (`_webgl2ProbeMemo = !!gl`): the second probe returns the memoized false and
    // getContextCalls stays 1.
    ;(globalThis as unknown as { document?: unknown }).document = {
      createElement: (tag: string): unknown =>
        tag === 'canvas'
          ? {
              getContext: (): unknown => {
                getContextCalls++
                return null
              },
            }
          : {},
    }
    const provider = makeWebGl2BackendProvider(dummyFactory)
    expect(await provider.probe()).toBe(false)
    expect(await provider.probe()).toBe(false)
    expect(getContextCalls).toBe(2) // re-probed — a null result is never memoized
  })

  it('preserves the no-DOM pass-through (returns true without creating a context)', async () => {
    delete (globalThis as unknown as { document?: unknown }).document
    _resetWebgl2ProbeMemoForTests()
    const provider = makeWebGl2BackendProvider(dummyFactory)
    const ok = await provider.probe()
    expect(ok).toBe(true)
    expect(getContextCalls).toBe(0) // short-circuited, same as the pre-memo `||`
  })
})
