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

/** Cross a microtask boundary — the window `linkBudgetClassMemoised` is valid
 *  for. Tests that switch link CLASS mid-body need this because the two shaping
 *  helpers memoise; the classifier itself does not (see the split below). */
const nextMicrotask = (): Promise<void> => Promise.resolve()

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
    // The CLASSIFIER is live. Its cost is memoised one level up, at the two
    // shaping helpers (`linkBudgetClassMemoised`), so this stays a pure
    // question about semantics and the `change` event still lands within a
    // frame. The memo's own window is pinned in the describe block below.
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

  it('scales rather than tabulating, so a retuned device cap carries through', async () => {
    // The `await` is not incidental: this helper memoises per microtask, so a
    // class switch mid-body is not observable. Nothing is lost — the mapping
    // this test exists for is asserted identically either side of the boundary,
    // and a link class CANNOT change within one call stack in production (it
    // changes on the API's `change` event, which is its own task).
    stubConnection({ saveData: true })
    expect(linkScaledConcurrency(32)).toBe(4)
    expect(linkScaledConcurrency(16)).toBe(2)
    await nextMicrotask()
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
  it('off only in saver; reduced still speculates because the link is usable', async () => {
    // The two speculative sites (skeleton prewarm budget, pan-ahead prefetch)
    // must agree by construction. Asserting the mapping HERE is what makes
    // widening it to 'reduced' a one-line change rather than a hunt. The
    // `await`s cross this helper's memo window — see the note on
    // linkScaledConcurrency's scaling test; the mapping coverage is unchanged.
    stubConnection({ saveData: true })
    expect(speculativeFetchAllowed()).toBe(false)
    await nextMicrotask()
    stubConnection({ effectiveType: '2g' })
    expect(speculativeFetchAllowed()).toBe(false)
    await nextMicrotask()
    stubConnection({ effectiveType: '3g' })
    expect(speculativeFetchAllowed()).toBe(true)
    await nextMicrotask()
    stubConnection(undefined)
    expect(speculativeFetchAllowed()).toBe(true)
  })
})

// ── The memo the two shaping helpers sit behind (#2560). An owner CPU profile
// of the deployed build put 96.2 ms — 1.4 % of a 6.7 s vector session — inside
// `linkBudgetClass`, refuting the docblock's claim that `effectiveType` /
// `saveData` are free field loads needing no memo. These rows pin the window,
// and the split: memo at the HELPERS, live at the CLASSIFIER. ──
describe('linkBudgetClassMemoised — one read per microtask, not per call (#2560)', () => {
  it('a mid-call-stack link change is NOT observed by the helpers', async () => {
    // The property being bought. Production cannot hit this case — the class
    // changes on the Network Information API's `change` event, which is its own
    // task — so collapsing these reads costs no liveness a caller can observe.
    const conn = { saveData: false, effectiveType: '4g' }
    stubConnection(conn)
    expect(speculativeFetchAllowed()).toBe(true)
    expect(linkScaledConcurrency(32)).toBe(32)
    conn.saveData = true
    expect(speculativeFetchAllowed(), 'memo holds within the call stack').toBe(true)
    expect(linkScaledConcurrency(32), 'and across both helpers — one shared memo').toBe(32)
    await nextMicrotask()
    expect(speculativeFetchAllowed(), 'and drops at the boundary').toBe(false)
    expect(linkScaledConcurrency(32)).toBe(4)
  })

  it('the CLASSIFIER stays live inside that same window', () => {
    // The discriminating row: it fails if the memo is put on `linkBudgetClass`
    // instead of above it. Both placements make the helpers cheap; only this
    // one keeps the 14 semantic rows above testing a pure function, and keeps
    // a direct caller reading truth rather than a snapshot.
    const conn = { saveData: false, effectiveType: '4g' }
    stubConnection(conn)
    expect(speculativeFetchAllowed()).toBe(true) // arms the memo
    conn.saveData = true
    expect(linkBudgetClass(), 'classifier is not behind the memo').toBe('saver')
    expect(speculativeFetchAllowed(), 'helper still is').toBe(true)
  })

  it('the memo is dropped even when the class did not change', async () => {
    // Guards the invalidation itself rather than its effect: a memo that only
    // cleared on a differing read would pass the row above by luck.
    stubConnection({ effectiveType: '4g' })
    expect(speculativeFetchAllowed()).toBe(true)
    await nextMicrotask()
    stubConnection({ saveData: true })
    expect(speculativeFetchAllowed()).toBe(false)
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
