// #723 — categorical() palette id must be a STABLE, tile-independent
// function of the value. The prior implementation ranked the values
// alphabetically within each tile, so the same value (e.g. a country)
// mapped to a different palette slot depending on which other values
// shared the tile — a categorical fill therefore changed colour across
// zoom/pan. These tests pin the property that fixes it.
import { describe, it, expect } from 'vitest'
import { stableCategoryId, buildCategoryMap } from '@xgis/map'

describe('stableCategoryId (#723)', () => {
  it('is deterministic — same value → same id', () => {
    expect(stableCategoryId('China')).toBe(stableCategoryId('China'))
    expect(stableCategoryId('')).toBe(stableCategoryId(''))
  })

  it('round-trips exactly through an f32 feat_data slot (< 2^24)', () => {
    for (const v of ['China', 'Japan', 'Brazil', 'a', 'residential', 'landuse__merged_4']) {
      const id = stableCategoryId(v)
      expect(id).toBeGreaterThanOrEqual(0)
      expect(id).toBeLessThan(0x800000) // 23-bit → exact in f32 (24-bit mantissa)
      expect(Math.fround(id)).toBe(id)
    }
  })

  it('distinguishes distinct values', () => {
    expect(stableCategoryId('school')).not.toBe(stableCategoryId('cemetery'))
  })
})

describe('buildCategoryMap (#723) — subset independence', () => {
  // THE fail-before property: the same value must get the same id
  // regardless of which OTHER values are present. Under the old
  // alphabetical-rank code, 'China' ranked 1 in {Brazil,China} but 0 in
  // {China,Denmark} — this assertion fails-before, passes-after.
  it('assigns a value the same id in two different value-subsets', () => {
    const a = buildCategoryMap(['Brazil', 'China'])
    const b = buildCategoryMap(['China', 'Denmark'])
    expect(a.get('China')).toBe(b.get('China'))
  })

  it('is order-independent within a subset', () => {
    const a = buildCategoryMap(['a', 'b', 'c'])
    const b = buildCategoryMap(['c', 'b', 'a'])
    expect(a.get('b')).toBe(b.get('b'))
  })

  it('dedupes repeated values', () => {
    const m = buildCategoryMap(['x', 'x', 'y', 'x'])
    expect(m.size).toBe(2)
    expect(m.get('x')).toBe(stableCategoryId('x'))
  })
})
