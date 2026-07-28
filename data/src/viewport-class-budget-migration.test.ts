// ═══ Viewport-class budget migration (#1350) ═══
//
// The six budget sites below each re-derived "is this a phone?" from a raw
// `innerWidth <= 900` check instead of the shared authority
// `isMobileClassViewport` (@xgis/shared). Width alone is NECESSARY but not
// SUFFICIENT: a small DESKTOP window (the 860 px headless case the classifier's
// header documents) has a FINE primary pointer and must keep desktop-grade
// budgets. This matrix pins both directions — fine pointer @860 → desktop,
// coarse pointer @430 → phone — so no site can silently re-diverge.
//
// `getMaxGpuTiles` (@xgis/map) and the frustum selector's local
// `isMobileViewport` are asserted as SOURCE gates rather than behaviourally:
// @xgis/data must not import @xgis/map (dependency direction #929), and
// `isMobileViewport` is module-private. Same idiom as
// shared/src/viewport-class.test.ts, which reads its consumers' source.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultSkeletonByteBudget,
  defaultSkeletonDepth,
  maxCachedBytes,
  maxConcurrentLoads,
} from './tile-types'
import { maxInflight } from './sources/pmtiles-backend-helpers'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Minimal matchMedia stub — only `.matches` is consulted. */
function stubPointer(kind: 'coarse' | 'fine'): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse') ? kind === 'coarse' : false,
    media: query,
  }))
}

/** Install a viewport (width + primary pointer) for one test. `tile-types`
 *  memoises `window.innerWidth` for the lifespan of one microtask, so yield
 *  once here — a memo taken under the previous test's width must not leak. */
async function withViewport(cssWidth: number, pointer: 'coarse' | 'fine'): Promise<void> {
  vi.stubGlobal('window', { innerWidth: cssWidth })
  stubPointer(pointer)
  await Promise.resolve()
}

beforeEach(async () => {
  await Promise.resolve()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('#1350 — budget sites classify mobile via isMobileClassViewport', () => {
  it('FINE pointer at 860 (small desktop window) → every budget is the DESKTOP value', async () => {
    await withViewport(860, 'fine')
    expect(maxCachedBytes()).toBe(200 * 1024 * 1024)
    expect(maxConcurrentLoads()).toBe(32)
    expect(defaultSkeletonDepth()).toBe(3)
    expect(defaultSkeletonByteBudget()).toBe(4 * 1024 * 1024)
    expect(maxInflight()).toBe(16)
  })

  it('COARSE pointer at 430 (a real phone) → every budget stays the PHONE value', async () => {
    await withViewport(430, 'coarse')
    expect(maxCachedBytes()).toBe(100 * 1024 * 1024)
    expect(maxConcurrentLoads()).toBe(8)
    expect(defaultSkeletonDepth()).toBe(2)
    expect(defaultSkeletonByteBudget()).toBe(1.5 * 1024 * 1024)
    expect(maxInflight()).toBe(4)
  })

  it('COARSE pointer at 1440 (a tablet-sized desktop) → the size gate still wins', async () => {
    await withViewport(1440, 'coarse')
    expect(maxConcurrentLoads()).toBe(32)
    expect(maxInflight()).toBe(16)
  })
})

// ── Source gates: the two sites @xgis/data cannot call directly. ──
describe('#1350 — the cross-package / private sites route through the authority too', () => {
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  /** Slice one function's body out of comment-stripped source: from its
   *  signature to the first column-0 closing brace. */
  function bodyOf(relPath: string, signature: string): string {
    const src = stripComments(readFileSync(join(REPO_ROOT, relPath), 'utf8'))
    const start = src.indexOf(signature)
    expect(start, `${signature} not found in ${relPath}`).toBeGreaterThanOrEqual(0)
    return src.slice(start, src.indexOf('\n}', start))
  }

  it('getMaxGpuTiles (map) classifies via isMobileClassViewport, not an inline 900', () => {
    const body = bodyOf(
      'map/src/render/vector-tile-renderer-helpers.ts',
      'export function getMaxGpuTiles',
    )
    expect(body).toContain('isMobileClassViewport')
    expect(body).not.toMatch(/900/)
  })

  it('the frustum selector isMobileViewport delegates instead of re-deriving 900', () => {
    const body = bodyOf('data/src/tile-select.ts', 'function isMobileViewport')
    expect(body).toContain('isMobileClassViewport')
    expect(body).not.toMatch(/900/)
  })
})
