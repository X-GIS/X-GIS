import { describe, it, expect } from 'vitest'
import { labelCollisionId } from './label-pass'

// #728 — labelCollisionId encodes `<layerPrecedence><NUL><featureIdentity>` so
// the greedy collision pass's ascending `tieBreak` (1) keeps MapLibre's "later
// layer wins" rule and (2) resolves same-layer overlappers by a pan-invariant
// feature key. The zero-padded, fixed-width layer field is the load-bearing
// detail: without it lexicographic compare would invert the numeric order.
// The layer field and identity are joined by a NUL (mirrors the lineId
// convention) — a byte that never appears in layer names or resolved text.
const NUL = String.fromCharCode(0)

describe('labelCollisionId (#728 stable collision identity)', () => {
  it('a later show sorts BEFORE an earlier one (later layer wins the collision)', () => {
    const early = labelCollisionId(0, 5, 'X')
    const late = labelCollisionId(4, 5, 'X')
    expect(late < early).toBe(true)
  })

  it('layer precedence dominates the feature identity', () => {
    // A later-show label with a lexicographically LARGER identity still wins.
    const later = labelCollisionId(3, 5, 'zzz')
    const earlier = labelCollisionId(1, 5, 'aaa')
    expect(later < earlier).toBe(true)
  })

  it('zero-pads the layer field to a constant width so compare matches numeric order', () => {
    // 12 shows: show 11 -> inv 1 -> "01", show 2 -> inv 10 -> "10". Padding
    // keeps "01" < "10" so the later show (11) sorts first. Unpadded "1" > "10".
    const show11 = labelCollisionId(11, 12, 'X')
    const show2 = labelCollisionId(2, 12, 'X')
    expect(show11.startsWith('01' + NUL)).toBe(true)
    expect(show2.startsWith('10' + NUL)).toBe(true)
    expect(show11 < show2).toBe(true)
  })

  it('appends the feature identity after the layer field (NUL-separated)', () => {
    expect(labelCollisionId(0, 1, 'roads_shield 82')).toBe('1' + NUL + 'roads_shield 82')
  })

  it('same show + same identity -> identical id (stable across tiles/frames)', () => {
    expect(labelCollisionId(2, 9, 'Seoul|123,456')).toBe(labelCollisionId(2, 9, 'Seoul|123,456'))
  })

  it('distinct feature identities in the same show stay distinct', () => {
    expect(labelCollisionId(2, 9, 'Seoul|1,2')).not.toBe(labelCollisionId(2, 9, 'Busan|3,4'))
  })
})
