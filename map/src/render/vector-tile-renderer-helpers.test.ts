// Integration coverage for uploadBudgetFor's mobile gate — the GPU-upload
// per-frame budget that drops from MAX_UPLOADS_PER_FRAME (4) to 1 on phones.
// After #1088 the gate routes through the shared `isMobileClassViewport`
// authority, so a small DESKTOP window (fine PRIMARY pointer) keeps the desktop
// budget instead of being cliff-throttled to the phone floor. Real phones
// (coarse pointer + small canvas) are byte-identical to before.
//
// Runs in the default node env (no window). matchMedia is stubbed per-case;
// uploadBudgetFor keys off the canvas dimensions + the ambient pointer query.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { uploadBudgetFor } from './vector-tile-renderer-helpers'

/** Minimal matchMedia stub — only `.matches` is read. A `pointer: coarse`
 *  query matches iff we emulate a coarse PRIMARY pointer (phone/tablet). */
function stubPointer(kind: 'coarse' | 'fine'): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('coarse') ? kind === 'coarse' : kind === 'fine',
    media: query,
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('uploadBudgetFor — mobile gate routes through isMobileClassViewport (#1088)', () => {
  it('small DESKTOP window (fine pointer, 860px canvas) gets the full desktop budget (4), not the phone floor', () => {
    // THE FIX. Pre-#1088 the width-only `max/dpr <= 900` test returned 1 for
    // this 860px canvas, cliff-throttling a desktop window to phone grade.
    stubPointer('fine')
    expect(uploadBudgetFor(860, 720, 1)).toBe(4) // MAX_UPLOADS_PER_FRAME
  })

  it('real phone (coarse pointer, DPR=3 device-pixel canvas) still gets the phone floor (1) — byte-identical', () => {
    // 2532 device px / 3 = 844 CSS px ≤ 900, coarse primary pointer → phone.
    stubPointer('coarse')
    expect(uploadBudgetFor(1170, 2532, 3)).toBe(1)
  })
})

describe('uploadBudgetFor — #1155 F3 cold-start burst budget', () => {
  it('desktop burst raises the budget from 4 to 8; steady stays 4', () => {
    stubPointer('fine')
    expect(uploadBudgetFor(1600, 900, 1)).toBe(4) // steady desktop
    expect(uploadBudgetFor(1600, 900, 1, true)).toBe(8) // burst desktop
  })

  it('mobile burst raises the budget from 1 to 4; steady stays 1', () => {
    stubPointer('coarse')
    expect(uploadBudgetFor(1170, 2532, 3)).toBe(1) // steady mobile
    expect(uploadBudgetFor(1170, 2532, 3, true)).toBe(4) // burst mobile
  })

  it('the __XGIS_UPLOAD_BUDGET test hook still wins over burst (first-return precedence)', () => {
    stubPointer('fine')
    ;(globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET = 2
    try {
      // Burst is requested, but the forced hook must take precedence so the
      // queue-deferred fallback path stays deterministically exercisable.
      expect(uploadBudgetFor(1600, 900, 1, true)).toBe(2)
    } finally {
      delete (globalThis as { __XGIS_UPLOAD_BUDGET?: number }).__XGIS_UPLOAD_BUDGET
    }
  })
})
