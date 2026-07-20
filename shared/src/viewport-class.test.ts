// Unit + source-gate coverage for isMobileClassViewport — the single "is this a
// phone?" authority the data pipeline throttles route through (#1088). The
// matrix locks the coarse-PRIMARY-pointer semantics (the fix: a fine-pointer
// small window is DESKTOP, not phone); the source gates pin all three throttle
// sites onto this authority so the width-only heuristics cannot re-diverge.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMobileClassViewport } from './viewport-class'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Minimal matchMedia stub — only `.matches` is consulted. A `pointer: coarse`
 *  query reports `kind === 'coarse'`; any other query reports false. */
function stubPointer(kind: 'coarse' | 'fine'): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse') ? kind === 'coarse' : false,
    media: query,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isMobileClassViewport — coarse PRIMARY pointer AND small dimension', () => {
  it('coarse pointer + small dimension (800) → true (phone-class)', () => {
    stubPointer('coarse')
    expect(isMobileClassViewport(800)).toBe(true)
  })

  it('FINE pointer + small dimension (800) → FALSE — the #1088 fix (width-only said true)', () => {
    stubPointer('fine')
    expect(isMobileClassViewport(800)).toBe(false)
  })

  it('coarse pointer + large dimension (1200) → false (necessary size gate fails)', () => {
    stubPointer('coarse')
    expect(isMobileClassViewport(1200)).toBe(false)
  })

  it('matchMedia unavailable (SSR / worker / node) + 800 → true — conservative width-only fallback', () => {
    vi.stubGlobal('matchMedia', undefined)
    expect(isMobileClassViewport(800)).toBe(true)
  })

  it('non-positive dimension → false even with a coarse pointer (0 / NaN / -1 = missing measurement)', () => {
    stubPointer('coarse')
    expect(isMobileClassViewport(0)).toBe(false)
    expect(isMobileClassViewport(Number.NaN)).toBe(false)
    expect(isMobileClassViewport(-1)).toBe(false)
  })

  it('exactly 900 with a coarse pointer is still phone-class (boundary inclusive)', () => {
    stubPointer('coarse')
    expect(isMobileClassViewport(900)).toBe(true)
  })

  it('caches the MediaQueryList per matchMedia identity (#1177: one parse, live .matches)', () => {
    let calls = 0
    const mql = { matches: true, media: '(pointer: coarse)' }
    vi.stubGlobal('matchMedia', () => {
      calls++
      return mql
    })
    expect(isMobileClassViewport(800)).toBe(true)
    expect(isMobileClassViewport(800)).toBe(true)
    expect(calls).toBe(1) // MQL constructed once...
    mql.matches = false
    expect(isMobileClassViewport(800)).toBe(false) // ...but .matches stays LIVE
    expect(calls).toBe(1)
  })
})

// ── Source gates: the three data-pipeline throttles route through the shared
// authority and no longer classify mobile from raw width alone (#1088). Mirrors
// the earth-literal-ratchet pattern (a shared test reading consumer source). ──
describe('isMobileClassViewport — single authority (no width-only duplication)', () => {
  const read = (rel: string): string => readFileSync(join(REPO_ROOT, rel), 'utf8')
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  const HELPERS = 'map/src/render/vector-tile-renderer-helpers.ts'
  const COORDINATOR = 'map/src/render/upload-coordinator.ts'
  const WORKER_POOL = 'data/src/workers/mvt-worker-pool.ts'

  it('all three throttle sites reference isMobileClassViewport', () => {
    for (const f of [HELPERS, COORDINATOR, WORKER_POOL]) {
      expect(read(f), `${f} must route through the shared classifier`).toContain(
        'isMobileClassViewport',
      )
    }
  })

  it('uploadBudgetFor no longer compares width to 900 inline', () => {
    // Scope to uploadBudgetFor's body: getMaxGpuTiles legitimately keeps its own
    // `<= 900` GPU-cache-RETENTION gate — a separate concern from the upload /
    // worker THROUGHPUT throttle #1088 fixes, and out of its scope. uploadBudgetFor
    // is the last function in the file, so slice from its signature to EOF.
    const body = stripComments(
      read(HELPERS).slice(read(HELPERS).indexOf('export function uploadBudgetFor')),
    )
    expect(body).toContain('isMobileClassViewport')
    expect(body).not.toMatch(/900/)
  })

  it('the coordinator per-frame cap and the worker-pool ceiling no longer mention 900 at all', () => {
    expect(stripComments(read(COORDINATOR))).not.toMatch(/900/)
    expect(stripComments(read(WORKER_POOL))).not.toMatch(/900/)
  })
})
