import { describe, it, expect } from 'vitest'
import {
  checkPatternParams,
  PATTERN_UNIT_M,
  PATTERN_UNIT_PX,
  type PatternSlot,
} from '../engine/line-renderer'

function makeSlot(overrides: Partial<PatternSlot> = {}): PatternSlot {
  return {
    shapeId: 1,
    spacing: 60,
    spacingUnit: PATTERN_UNIT_PX,
    size: 14,
    sizeUnit: PATTERN_UNIT_PX,
    offset: 0,
    offsetUnit: PATTERN_UNIT_M,
    startOffset: 0,
    anchor: 0,
    ...overrides,
  }
}

function collect(patterns: PatternSlot[], mpp: number) {
  const calls: { key: string; msg: string }[] = []
  checkPatternParams(patterns, mpp, (key, msg) => calls.push({ key, msg }))
  return calls
}

describe('checkPatternParams', () => {
  it('quiet for well-formed pattern (size < spacing, px units)', () => {
    const calls = collect([makeSlot()], 100)
    expect(calls).toEqual([])
  })

  it('quiet for size == spacing (boundary is OK)', () => {
    const calls = collect([makeSlot({ size: 60, spacing: 60 })], 100)
    expect(calls).toEqual([])
  })

  it('quiet for 1 < size/spacing <= 2 (covered by 3-neighbor sampling)', () => {
    const calls = collect([makeSlot({ size: 100, spacing: 60 })], 100)
    expect(calls).toEqual([])
  })

  it('warns when size > 2 × spacing', () => {
    const calls = collect([makeSlot({ size: 200, spacing: 60 })], 100)
    expect(calls).toHaveLength(1)
    expect(calls[0].key).toContain('size-gt-2x-spacing')
    expect(calls[0].msg).toContain('slot 0')
    expect(calls[0].msg).toContain('200px')
    expect(calls[0].msg).toContain('60px')
  })

  it('warns when meter-unit spacing collapses below 1 pixel', () => {
    // spacing = 60 m, mpp = 100 m/px → spacingPx = 0.6 → sub-pixel
    const pat = makeSlot({
      spacing: 60,
      spacingUnit: PATTERN_UNIT_M,
      size: 14,
      sizeUnit: PATTERN_UNIT_M,
    })
    const calls = collect([pat], 100)
    expect(calls).toHaveLength(1)
    expect(calls[0].key).toContain('subpixel')
    expect(calls[0].msg).toContain('0.600 px')
  })

  it('emits both warnings when both conditions fire on the same slot', () => {
    // size = 200 m, spacing = 60 m, mpp = 100 m/px → size > 2×spacing AND sub-pixel
    const pat = makeSlot({
      spacing: 60,
      spacingUnit: PATTERN_UNIT_M,
      size: 200,
      sizeUnit: PATTERN_UNIT_M,
    })
    const calls = collect([pat], 100)
    expect(calls).toHaveLength(2)
    const keys = calls.map(c => c.key).join(' ')
    expect(keys).toContain('size-gt-2x-spacing')
    expect(keys).toContain('subpixel')
  })

  it('skips inactive slots (shapeId = 0)', () => {
    const inactive = makeSlot({ shapeId: 0, size: 999, spacing: 1 })
    const calls = collect([inactive], 100)
    expect(calls).toEqual([])
  })

  it('includes slot index in warning key', () => {
    const calls = collect([
      makeSlot(),                                           // slot 0 clean
      makeSlot({ size: 300, spacing: 60 }),                 // slot 1 bad
    ], 100)
    expect(calls).toHaveLength(1)
    expect(calls[0].key).toMatch(/^p1:/)
  })
})

describe('checkPatternParams warn dedup (caller responsibility)', () => {
  it('emits one call per invocation — dedup is the caller`s job', () => {
    // The free function always emits. LineRenderer.warnOnce does the dedup.
    // This test documents the contract: same bad params called twice →
    // two callback calls. The instance-level dedup is tested via behavior
    // of the live renderer (out of scope for unit test without GPU).
    const bad = [makeSlot({ size: 200, spacing: 60 })]
    expect(collect(bad, 100)).toHaveLength(1)
    expect(collect(bad, 100)).toHaveLength(1) // same params, same result
  })
})
