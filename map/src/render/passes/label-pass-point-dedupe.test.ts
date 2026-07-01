import { describe, it, expect } from 'vitest'
import { pointLabelPairKey, shouldEmitPointDedup } from './label-pass'

// #419 — a place-label dot (circle_11_black) blinks on/off during pan/zoom.
// ROOT: the point text+icon pairKey was the ROUNDED SCREEN position
// `${layer}:${round(px)},${round(py)}`. Sub-pixel camera drift flips the
// rounding, so a dot's key intermittently collides with a NEIGHBOUR label's
// dropped key → the dot is dropped for that frame ("text steady, dot blinks").
// The LINE path already keys on a stable monotonic seq (iter-176); the three
// POINT dispatch sites did not. Fix: point pairKey is a per-instance seq
// (pointLabelPairKey), POSITION-INDEPENDENT, so co-located labels can never
// share a key. text+dot of one dispatch still share the value (iter-119
// pairing). This pins that invariant.

describe('pointLabelPairKey — stable per-instance point pair key (#419)', () => {
  // The OLD (pre-#419) key, reconstructed to demonstrate the collision the fix removes.
  const oldRoundedKey = (layer: string, px: number, py: number) =>
    `${layer}:${Math.round(px)},${Math.round(py)}`

  it('FAIL-BEFORE: co-located labels COLLIDE under the old rounded-screen key (the #419 root)', () => {
    // Two DISTINCT labels whose screen positions round to the same cell → same
    // key → one label's collision-drop drops the other label's dot = the blink.
    expect(oldRoundedKey('place', 100.4, 50.4)).toBe(oldRoundedKey('place', 99.6, 50.3)) // both → place:100,50
  })

  it('the new per-instance key gives DISTINCT keys to co-located labels (fix)', () => {
    expect(pointLabelPairKey('place', 0)).not.toBe(pointLabelPairKey('place', 1))
  })

  it('text + dot of ONE dispatch share the key (iter-119 pairing preserved)', () => {
    const seq = 7 // addLabel + dispatchIcon are called with the SAME seq value
    expect(pointLabelPairKey('place', seq)).toBe(pointLabelPairKey('place', seq))
  })

  it('is position-independent — a pure fn of (layer, seq); cannot collide on position', () => {
    // Structural teeth: a revert to a position-derived key changes this
    // signature and breaks this import/assertion.
    expect(pointLabelPairKey('city', 3)).toBe('city:pt3')
    expect(pointLabelPairKey(undefined, 0)).toBe(':pt0')
  })
})

// #458 — a transit POI matched by two symbol layers (poi_transit blue ABOVE
// poi_r* grey) rendered the LOWER layer's grey text. ROOT: the point-label
// cross-show dedup was a layer-blind first-wins Set, so poi_r* (lower, emitted
// first) claimed the (text, anchor) key and poi_transit (higher) was dropped —
// inverting Mapbox layer-order precedence (top layer wins). Fix: the dedup is
// priority-aware — a strictly higher layer is let through so the collision pass
// drops the earlier lower-layer label at the same anchor.
describe('shouldEmitPointDedup — layer-order point-label precedence (#458)', () => {
  it('emits when the (text, anchor) key is unclaimed this frame', () => {
    expect(shouldEmitPointDedup(undefined, 0)).toBe(true)
    expect(shouldEmitPointDedup(undefined, 7)).toBe(true)
  })

  it('drops a SAME-layer duplicate (cross-tile centroid / bilingual collapse — iter-274/280 preserved)', () => {
    expect(shouldEmitPointDedup(3, 3)).toBe(false)
  })

  it('drops a LOWER-layer duplicate (an earlier-claimed higher layer keeps the screen)', () => {
    expect(shouldEmitPointDedup(5, 2)).toBe(false)
  })

  it('FAIL-BEFORE: a HIGHER-layer duplicate is EMITTED so the top layer wins (poi_transit blue over poi_r* grey)', () => {
    // Pre-#458 the dedup was a layer-blind first-wins Set: once the lower
    // poi_r* (priority 2) claimed the key, the higher poi_transit (priority
    // 5) was always dropped → this returned false → grey text on screen.
    expect(shouldEmitPointDedup(2, 5)).toBe(true)
  })
})
