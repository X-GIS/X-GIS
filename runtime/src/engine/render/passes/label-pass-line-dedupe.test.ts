import { describe, it, expect } from 'vitest'
import { lineLabelDeduped } from './label-pass'

// Audit P — OFM one-way road ARROWS (`road_oneway`: icon-image, NO text-field)
// rendered far too infrequently vs MapLibre (~1 arrow for the whole layer on
// screen). ROOT: the along-line cross-tile dedupe keys on the RESOLVED TEXT;
// a text-less arrow resolves to '' for every spacing stop, so the first stop
// records '' and `isTooCloseToSameText('')` then suppresses every later
// dispatchIcon across the whole show. The dedupe is correct for NAMED roads
// (each name a distinct key) but must not collapse the shared '' key.
//
// `lineLabelDeduped` is the extracted predicate; the fix is `'' → never
// deduped`. fail-before: drop the `if (resolvedText === '') return false`
// guard and the empty-key cases below flip (has('') === true), collapsing
// the count test to 1.
describe('lineLabelDeduped — empty (icon-only) keys never dedupe', () => {
  it('empty text is NEVER a duplicate, even once recorded (one-way arrows)', () => {
    const emitted = new Set<string>([''])
    // fail-before: emitted.has('') === true → the second+ arrow is suppressed.
    expect(lineLabelDeduped('', emitted)).toBe(false)
  })

  it('a named road still collapses across tile boundaries (dedupe preserved)', () => {
    expect(lineLabelDeduped('Main St', new Set())).toBe(false) // first stamp places
    expect(lineLabelDeduped('Main St', new Set(['Main St']))).toBe(true) // later stamps drop
  })

  it('distinct names are independent (no cross-name suppression)', () => {
    expect(lineLabelDeduped('A Ave', new Set(['B Blvd']))).toBe(false)
  })

  // Structural teeth: mirror the along-line placement loop
  // (label-pass.ts:852-872) — record only on placement, exactly like
  // recordTextPosition inside the `!isTooClose` block.
  const countPlaced = (total: number, spacing: number, key: string): number => {
    const emitted = new Set<string>()
    let placed = 0
    let nextStop = spacing * 0.5
    while (nextStop <= total) {
      if (!lineLabelDeduped(key, emitted)) { placed++; emitted.add(key) }
      nextStop += spacing
    }
    return placed
  }

  it('places one arrow per spacing stop for a text-less line (was 1 for whole show)', () => {
    // L=1000px, S=75px → stops at 37.5,112.5,… ≤1000 = ⌊(1000−37.5)/75⌋+1 = 13.
    // fail-before (no empty bypass): the shared '' key collapses this to 1.
    expect(countPlaced(1000, 75, '')).toBe(13)
  })

  it('still collapses a NAMED line to a single label (dedupe intact)', () => {
    expect(countPlaced(1000, 75, 'Main St')).toBe(1)
  })
})
