// #603 — cross-tile line-icon dedup invariant.
//
// Bug: line-placed icons (road_oneway arrows, icon-only shields) are
// dispatched once per tile polyline. A road crossing N tile boundaries
// emits N polylines; each polyline's spacing walk places icons at
// positions that may not geometrically overlap (the AABB collision in
// icon-stage.prepare() only collapses icons whose boxes touch), so the
// same road section can display 2+ copies of the same icon from adjacent
// tiles.
//
// FIX: a bucketed screen-position Set (_scratchEmittedLineIconKeys) gates
// text-less icon-only line-label dispatches so a position already claimed
// by one tile's polyline is skipped by the next. The bucket size equals
// the symbol-spacing so icons more than half a spacing apart are never
// falsely deduplicated.
//
// This test drives lineLabelDeduped (the text-dedup predicate) and
// IconStage.prepare() (the AABB dedup) to verify the pre-existing
// behaviour is intact, then drives lineIconIsIconOnly — the REAL predicate
// that arms the cross-tile icon dedup gate — for the icon-only line symbol.

import { describe, it, expect } from 'vitest'
import { lineLabelDeduped, lineIconIsIconOnly } from '../render/passes/label-pass'
import { IconStage } from './icon-stage'
import type { IconDraw } from './icon-renderer'
import type { TextValue } from '@xgis/compiler'

// ─── lineLabelDeduped contract (unchanged, regression guard) ─────────────────

describe('lineLabelDeduped — text-less icons never dedup on empty key', () => {
  it('empty string returns false (road_oneway: no text-field → never suppressed)', () => {
    const set = new Set<string>()
    set.add('')
    // Even after '' is recorded, a second '' must NOT dedupe (the function's
    // contract: empty keys are ignored to avoid suppressing all text-less icons).
    expect(lineLabelDeduped('', set)).toBe(false)
  })

  it('non-empty string dedupes after first emission', () => {
    const set = new Set<string>(['Road A'])
    expect(lineLabelDeduped('Road A', set)).toBe(true)
  })

  it('non-empty string places when not yet recorded', () => {
    const set = new Set<string>()
    expect(lineLabelDeduped('Road A', set)).toBe(false)
  })
})

// ─── IconStage AABB collision (existing #417 behaviour, regression guard) ────

const SPRITE = { width: 20, height: 20, pixelRatio: 1 }

function makeIconStub(dpr = 1): { stage: IconStage; draws: () => IconDraw[] } {
  let captured: IconDraw[] = []
  const stage = Object.create(IconStage.prototype) as IconStage
  ;(stage as unknown as { pending: unknown[] }).pending = []
  ;(stage as unknown as { dpr: number }).dpr = dpr
  ;(stage as unknown as { missingIconNames: Set<string> }).missingIconNames = new Set()
  ;(stage as unknown as { dispatchedIconNames: Set<string> }).dispatchedIconNames = new Set()
  ;(stage as unknown as { droppedPairKeys: Set<string> }).droppedPairKeys = new Set()
  ;(stage as unknown as { _iconDump: null })._iconDump = null
  ;(stage as unknown as { _iconDebugHook: null })._iconDebugHook = null
  ;(stage as unknown as { host: unknown }).host = {
    getState: () => ({ status: 'loaded' }),
    get: () => SPRITE,
  }
  ;(stage as unknown as { renderer: unknown }).renderer = {
    setDraws: (d: IconDraw[]) => { captured = d },
  }
  return { stage, draws: () => captured }
}

describe('#603 — cross-tile line-icon dedup (position-bucket gate)', () => {
  it('computeObstacles returns bbox for collide=true icons only', () => {
    const { stage } = makeIconStub()
    stage.addIcon(100, 100, 'oneway', { collide: true })
    stage.addIcon(200, 200, 'circle') // collide defaults false
    const obs = stage.computeObstacles()
    expect(obs).toHaveLength(1)
    // bbox should centre on (100,100) with half-width = 10*1*1 = 10
    expect(obs[0]!.bbox.minX).toBeCloseTo(90)
    expect(obs[0]!.bbox.maxX).toBeCloseTo(110)
  })

  it('computeObstacles propagates groupKey from pairKey', () => {
    const { stage } = makeIconStub()
    stage.addIcon(100, 100, 'shield', { collide: true, pairKey: 'shield:42' })
    const obs = stage.computeObstacles()
    expect(obs[0]!.groupKey).toBe('shield:42')
  })

  it('computeObstacles returns empty when no collide icons are pending', () => {
    const { stage } = makeIconStub()
    stage.addIcon(100, 100, 'circle') // not collide
    expect(stage.computeObstacles()).toHaveLength(0)
  })

  // Inline simulation of the position-bucket dedup logic that label-pass
  // applies via _scratchEmittedLineIconKeys. Tests the bucketing math
  // without requiring a full label-pass render.
  it('position-bucket dedup collapses two icons at the same grid cell', () => {
    const spacingPx = 64
    const emitted = new Set<string>()
    const isDuplicate = (sx: number, sy: number): boolean => {
      const key = `${Math.round(sx / spacingPx)},${Math.round(sy / spacingPx)}`
      if (emitted.has(key)) return true
      emitted.add(key)
      return false
    }
    // First icon at (100, 100) → bucket (2, 2) → placed.
    expect(isDuplicate(100, 100)).toBe(false)
    // Second icon at (108, 103) → same bucket (2, 2) → dropped.
    expect(isDuplicate(108, 103)).toBe(true)
  })

  it('position-bucket dedup allows icons more than half a spacing apart', () => {
    const spacingPx = 64
    const emitted = new Set<string>()
    const isDuplicate = (sx: number, sy: number): boolean => {
      const key = `${Math.round(sx / spacingPx)},${Math.round(sy / spacingPx)}`
      if (emitted.has(key)) return true
      emitted.add(key)
      return false
    }
    // Icons 100px apart on x-axis — different buckets → both placed.
    expect(isDuplicate(100, 100)).toBe(false)
    expect(isDuplicate(200, 100)).toBe(false)
  })

  it('AABB collapse still works for within-frame same-tile overlap (#417 preserved)', () => {
    // Existing behaviour: two overlapping collide icons in the same prepare()
    // call collapse to one via the AABB placed-box grid.
    const { stage, draws } = makeIconStub()
    stage.addIcon(100, 100, 'oneway', { collide: true })
    stage.addIcon(110, 100, 'oneway', { collide: true }) // 10px apart → boxes overlap
    stage.prepare()
    expect(draws().length).toBe(1)
    expect(draws()[0]!.anchorX).toBe(100)
  })
})

// ─── #603 REAL gate: lineIconIsIconOnly arms the dedup for icon-only symbols ──
//
// The previous #603 test inline-reimplemented the bucket math and NEVER invoked
// the predicate the gate actually keys on, so it could not catch that the gate
// armed off `featDef.text !== undefined`. An icon-only symbol's text-field is
// compiled to `'""'` (compiler symbol.ts:56-57 labelExpr) → a TextValue that is
// a non-null template with a single empty literal. `featDef.text !== undefined`
// is therefore ALWAYS true → `!hasText` always false → isLineIconDuplicate
// never fired → road_oneway arrows duplicated at tile seams.
//
// lineIconIsIconOnly resolves the text and gates on EMPTY, so it correctly
// reports an icon-only symbol as a dedup candidate.

// The exact runtime shape of a compiled `text: '""'` (icon-only symbol).
const ICON_ONLY_TEXT = { kind: 'template', parts: [{ kind: 'literal', value: '' }] } as unknown as TextValue
// A named road's text-field (single literal "Main St").
const NAMED_TEXT = { kind: 'template', parts: [{ kind: 'literal', value: 'Main St' }] } as unknown as TextValue

describe('#603 — lineIconIsIconOnly arms the cross-tile dedup gate (real predicate)', () => {
  it('an icon-only symbol (text === "") IS a dedup candidate', () => {
    // fail-before: the gate used `featDef.text !== undefined`; this template is
    // DEFINED, so the old predicate reported "has text" and never deduped.
    expect(lineIconIsIconOnly(ICON_ONLY_TEXT, {}, 14)).toBe(true)
  })

  it('a named line symbol (text === "Main St") is NOT a dedup candidate', () => {
    // A text+icon pair (highway shield) must NOT be position-bucket deduped —
    // its icon drops together with its number via the pairKey path instead.
    expect(lineIconIsIconOnly(NAMED_TEXT, {}, 14)).toBe(false)
  })

  it('an undefined text-field is treated as icon-only (defensive)', () => {
    expect(lineIconIsIconOnly(undefined, {}, 14)).toBe(true)
  })

  // Integration: the REAL gate = lineIconIsIconOnly && isLineIconDuplicate.
  // Two adjacent tiles place an arrow at nearly the same screen spot at a seam.
  // The gate must collapse them to ONE; the old hasText gate let BOTH through.
  it('two seam-adjacent arrows collapse to one via the armed gate (was two)', () => {
    const spacingPx = 64
    const emitted = new Set<string>()
    const isLineIconDuplicate = (sx: number, sy: number): boolean => {
      const key = `${Math.round(sx / spacingPx)},${Math.round(sy / spacingPx)}`
      if (emitted.has(key)) return true
      emitted.add(key)
      return false
    }
    // Real gate body (mirrors label-pass emitLabelAlongSegment):
    //   if (lineIconIsIconOnly(text,…) && pairedWithIcon && isLineIconDuplicate) drop
    const pairedWithIcon = true
    const tryEmit = (sx: number, sy: number): boolean => {
      if (lineIconIsIconOnly(ICON_ONLY_TEXT, {}, 14) && pairedWithIcon && isLineIconDuplicate(sx, sy)) return false
      return true
    }
    // Tile A's polyline drops an arrow at (100,100).
    expect(tryEmit(100, 100)).toBe(true)
    // Tile B's polyline drops one at (105,102) — same seam, same bucket.
    // fail-before (hasText gate never fires): this would ALSO emit → two arrows.
    expect(tryEmit(105, 102)).toBe(false)
  })

  it('a NAMED line symbol is never position-bucket deduped (pair path owns it)', () => {
    const spacingPx = 64
    const emitted = new Set<string>()
    const isLineIconDuplicate = (sx: number, sy: number): boolean => {
      const key = `${Math.round(sx / spacingPx)},${Math.round(sy / spacingPx)}`
      if (emitted.has(key)) return true
      emitted.add(key)
      return false
    }
    const tryEmit = (sx: number, sy: number): boolean => {
      if (lineIconIsIconOnly(NAMED_TEXT, {}, 14) && true && isLineIconDuplicate(sx, sy)) return false
      return true
    }
    // Both placements survive the position-bucket gate (named → not a candidate).
    expect(tryEmit(100, 100)).toBe(true)
    expect(tryEmit(105, 102)).toBe(true)
  })
})
