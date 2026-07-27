// #1314's edge cull drops a line label whose anchor sits within an inset of a
// screen edge, so nothing renders glued half-off-screen. The inset was a flat
// 48 CSS px — a stand-in for a label width that is not known before shaping.
//
// For a PAIRED symbol it IS known: a route shield's extent is its badge sprite.
// The constant over-culled those roughly 4×. Witness: at
// #16.7/37.79172/126.79102 MapLibre draws a shield 22 px from the edge, fully
// legible, and the 48 px constant dropped it; its own half-extent (~12 px) keeps
// it and still clips nothing.
//
// Unpaired text keeps the constant — the conservative estimate is the point.

import { describe, it, expect } from 'vitest'
import {
  LINE_LABEL_EDGE_INSET_CSS_PX,
  lineLabelEdgeInsetPx,
  withinViewportInset,
} from './place-labels-along-line'

const ROAD_2 = { width: 24, height: 14, pixelRatio: 1 } // an OFM route-shield badge
const HIDPI = { width: 48, height: 28, pixelRatio: 2 } // same badge, @2x sprite sheet
const sprites: Record<string, { width: number; height: number; pixelRatio: number }> = {
  road_2: ROAD_2,
  road_2x: HIDPI,
}
const spriteOf = (n: string) => sprites[n]

describe('lineLabelEdgeInsetPx — the inset is the label’s own extent when known', () => {
  it('a paired shield insets by its badge half-extent, not the constant', () => {
    // max(24, 14) / 1 / 2 = 12 CSS px, against the 48 px constant.
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2' }, spriteOf, 1)).toBe(12)
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2' }, spriteOf, 3)).toBe(36)
  })

  it('honours the sprite pixelRatio so an @2x badge is not double-counted', () => {
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2x' }, spriteOf, 1)).toBe(12)
  })

  it('scales with icon-size', () => {
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2', iconSize: 2 }, spriteOf, 1)).toBe(24)
    // A non-positive / absent icon-size falls back to 1 rather than collapsing
    // the inset to 0, which would disable the cull entirely.
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2', iconSize: 0 }, spriteOf, 1)).toBe(12)
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2', iconSize: -3 }, spriteOf, 1)).toBe(12)
  })

  it('unpaired text, an unresolved sprite, and an empty icon-image keep the constant', () => {
    const K = LINE_LABEL_EDGE_INSET_CSS_PX
    expect(lineLabelEdgeInsetPx({}, spriteOf, 1)).toBe(K)
    expect(lineLabelEdgeInsetPx({ iconImage: 'no_such_sprite' }, spriteOf, 1)).toBe(K)
    expect(lineLabelEdgeInsetPx({ iconImage: '' }, spriteOf, 1)).toBe(K)
    expect(lineLabelEdgeInsetPx({ iconImage: null }, spriteOf, 1)).toBe(K)
    expect(lineLabelEdgeInsetPx({ iconImage: 'road_2' }, () => undefined, 1)).toBe(K)
  })

  it('the witness: a shield 22 px from the edge survives, and still clips nothing', () => {
    const W = 900
    const H = 804
    const shieldX = 22
    const badge = lineLabelEdgeInsetPx({ iconImage: 'road_2' }, spriteOf, 1)
    expect(withinViewportInset(shieldX, 400, W, H, badge)).toBe(true)
    // ...where the old constant dropped it.
    expect(withinViewportInset(shieldX, 400, W, H, LINE_LABEL_EDGE_INSET_CSS_PX)).toBe(false)
    // The badge still clears the edge: anchor − half ≥ 0.
    expect(shieldX - badge).toBeGreaterThanOrEqual(0)
  })

  it('a shield that WOULD clip is still culled — the cull is not just weakened', () => {
    const badge = lineLabelEdgeInsetPx({ iconImage: 'road_2' }, spriteOf, 1)
    expect(withinViewportInset(5, 400, 900, 804, badge)).toBe(false)
    expect(withinViewportInset(895, 400, 900, 804, badge)).toBe(false)
    expect(withinViewportInset(400, 6, 900, 804, badge)).toBe(false)
  })
})
