// Unit + source-gate coverage for the link-cost authority (#1356). The library
// shaped every bandwidth decision off viewport width alone, so a metered or
// tethered DESKTOP received the full 32-concurrent budget plus speculative
// prefetch, while a phone on fast Wi-Fi was throttled because its screen is
// small. Width is a proxy for DEVICE CLASS and says nothing about LINK COST.
//
// The matrix below locks the classifier's semantics; the source gates pin the
// four shaping sites onto this authority so a second scattered
// `navigator.connection?.saveData` check cannot re-appear per site.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkBudgetClass, linkScaledConcurrency, speculativeFetchAllowed } from './network-class'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Stub `navigator.connection`. Passing `undefined` models Safari/Firefox,
 *  which do not implement the Network Information API at all. */
function stubConnection(connection: { saveData?: boolean; effectiveType?: string } | undefined) {
  vi.stubGlobal('navigator', { connection })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('linkBudgetClass — Save-Data and effectiveType, feature-detected', () => {
  it('no Network Information API → full (progressive enhancement, unchanged behaviour)', () => {
    // The whole point of the feature-detect: on a browser with no signal the
    // library must behave EXACTLY as it did before #1356. If this ever returned
    // anything else, two thirds of the web would silently lose throughput.
    stubConnection(undefined)
    expect(linkBudgetClass()).toBe('full')
  })

  it('no navigator at all (SSR / worker) → full', () => {
    vi.stubGlobal('navigator', undefined)
    expect(linkBudgetClass()).toBe('full')
  })

  it('saveData → saver', () => {
    stubConnection({ saveData: true })
    expect(linkBudgetClass()).toBe('saver')
  })

  it('saveData OUTRANKS a fast measured link', () => {
    // The user asked for less data. A fast link is not a reason to override an
    // explicit preference — this is the ordering that makes it a preference
    // rather than a hint.
    stubConnection({ saveData: true, effectiveType: '4g' })
    expect(linkBudgetClass()).toBe('saver')
  })

  it('2g-grade → saver, 3g → reduced, 4g → full', () => {
    for (const t of ['slow-2g', '2g']) {
      stubConnection({ effectiveType: t })
      expect(linkBudgetClass(), t).toBe('saver')
    }
    stubConnection({ effectiveType: '3g' })
    expect(linkBudgetClass()).toBe('reduced')
    stubConnection({ effectiveType: '4g' })
    expect(linkBudgetClass()).toBe('full')
  })

  it('saveData:false is not saver — an explicit opt-OUT must not throttle', () => {
    stubConnection({ saveData: false, effectiveType: '4g' })
    expect(linkBudgetClass()).toBe('full')
  })

  it('an unrecognised effectiveType falls through to full, not to saver', () => {
    // effectiveType is an evolving enum. A value this code has never seen must
    // fail OPEN — throttling on an unknown string would make a future '5g'
    // read as the slowest possible link.
    stubConnection({ effectiveType: '5g' })
    expect(linkBudgetClass()).toBe('full')
  })

  it('is read live, so a link that degrades mid-session is picked up', () => {
    // Deliberately NOT memoised (unlike the viewport reads it sits beside, which
    // are, because innerWidth forces layout). This is what makes the API's
    // `change` event work with no new plumbing.
    const conn = { saveData: false }
    stubConnection(conn)
    expect(linkBudgetClass()).toBe('full')
    conn.saveData = true
    expect(linkBudgetClass()).toBe('saver')
  })
})

describe('linkScaledConcurrency — composes with the device cap, never replaces it', () => {
  it('full link returns the device cap untouched', () => {
    stubConnection({ effectiveType: '4g' })
    expect(linkScaledConcurrency(32)).toBe(32)
    expect(linkScaledConcurrency(8)).toBe(8)
  })

  it('scales rather than tabulating, so a retuned device cap carries through', () => {
    stubConnection({ saveData: true })
    expect(linkScaledConcurrency(32)).toBe(4)
    expect(linkScaledConcurrency(16)).toBe(2)
    stubConnection({ effectiveType: '3g' })
    expect(linkScaledConcurrency(32)).toBe(8)
    expect(linkScaledConcurrency(16)).toBe(4)
  })

  it('floors at 2 — saving data must not mean making no progress', () => {
    // 1 serialises fetch behind decode, so the map appears HUNG on exactly the
    // links where it is already slowest. 2 keeps one fetch overlapping one
    // decode. This floor is the invariant, not an implementation detail.
    stubConnection({ saveData: true })
    for (const cap of [16, 8, 4, 2, 1]) {
      expect(linkScaledConcurrency(cap), `cap=${cap}`).toBeGreaterThanOrEqual(2)
    }
  })
})

describe('speculativeFetchAllowed — one predicate for "is speculation worth it"', () => {
  it('off only in saver; reduced still speculates because the link is usable', () => {
    // The two speculative sites (skeleton prewarm budget, pan-ahead prefetch)
    // must agree by construction. Asserting the mapping HERE is what makes
    // widening it to 'reduced' a one-line change rather than a hunt.
    stubConnection({ saveData: true })
    expect(speculativeFetchAllowed()).toBe(false)
    stubConnection({ effectiveType: '2g' })
    expect(speculativeFetchAllowed()).toBe(false)
    stubConnection({ effectiveType: '3g' })
    expect(speculativeFetchAllowed()).toBe(true)
    stubConnection(undefined)
    expect(speculativeFetchAllowed()).toBe(true)
  })
})

// ── Source gates: the four bandwidth-shaping sites #1356 names route through
// this authority. Mirrors the viewport-class single-authority gate above it —
// the failure mode is identical (a per-site check that drifts). ──
describe('linkBudgetClass — single authority (no per-site connection probing)', () => {
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')

  const SHAPING_SITES = [
    'data/src/tile-types.ts', // maxConcurrentLoads + defaultSkeletonByteBudget
    'data/src/sources/pmtiles-backend-helpers.ts', // maxInflight
    'map/src/render/prefetch-scheduler.ts', // speculative prefetch
  ]

  it('every shaping site imports the authority', () => {
    for (const f of SHAPING_SITES) {
      expect(read(f), `${f} must consult the link class`).toMatch(
        /linkBudgetClass|linkScaledConcurrency|speculativeFetchAllowed/,
      )
    }
  })

  it('no site reads navigator.connection directly', () => {
    // The issue called this out specifically: scattered `saveData` checks are
    // how the width-only heuristics diverged in the first place (#1088).
    for (const f of [...SHAPING_SITES, 'map/src/map.ts', 'data/src/vector-tile-loader.ts']) {
      expect(read(f), `${f} must not probe the connection itself`).not.toMatch(
        /navigator\s*(\.|\[)\s*['"]?connection/,
      )
    }
  })
})
