// #2501 — a label's screen box must be tested against the globe silhouette on
// EVERY side, not only by its half-height. Witnesses are the measured z0 boxes
// (860×720, globe #0/20/20/0/85): Montevideo 72 px wide, centre 13.4 px inside
// the limb, left edge 23 px OUTSIDE; Cape Town 72 px wide, every corner ≥ 18 px
// inside. The old half-height test kept both; the corner test culls exactly the
// first.
import { describe, it, expect } from 'vitest'
import { limbCullsBox, LIMB_CORNER_SLACK_PX } from './limb-cull'

// A circular silhouette of radius r about (cx, cy): signed inset = r − distance.
const disc = (cx: number, cy: number, r: number) => (x: number, y: number) =>
  r - Math.hypot(x - cx, y - cy)
// The measured z0 disc: centre (430, 441), radius 81 (limb polygon bbox x[349,511] y[360,522]).
const limb = disc(430, 441, 81)
const box = (cx: number, cy: number, w: number, h: number) => ({
  minX: cx - w / 2,
  maxX: cx + w / 2,
  minY: cy - h / 2,
  maxY: cy + h / 2,
})

describe('limbCullsBox — corner containment against the globe silhouette (#2501)', () => {
  it('culls a wide label whose centre passes the anchor gate but whose text crosses the limb (Montevideo)', () => {
    const b = box(362, 445, 72, 10) // centre 13.4 px inside; left edge 23 px outside
    expect(limb((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)).toBeGreaterThan(7) // the anchor gate keeps it
    expect(limb((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2)).toBeGreaterThan(10 / 2 + 2) // so did the half-height test
    expect(limbCullsBox(limb, b)).toBe(true)
  })

  it('keeps an equally wide label whose whole box is inside (Cape Town)', () => {
    const b = box(428, 396, 72, 11) // every corner ≥ 18 px inside
    expect(limbCullsBox(limb, b)).toBe(false)
  })

  it('still culls the #1042 R3 case — a tall (multi-line) box rising past the limb', () => {
    const b = box(430, 372, 20, 40) // top edge 8 px above the limb
    expect(limbCullsBox(limb, b)).toBe(true)
  })

  it('a corner exactly at the slack boundary is kept; one inside it is culled', () => {
    const r = 81
    const keep = {
      minX: 430 - 10,
      maxX: 430 + 10,
      minY: 441 - r + LIMB_CORNER_SLACK_PX + 0.7,
      maxY: 441,
    }
    const cull = { ...keep, minY: keep.minY - 1 }
    expect(limbCullsBox(limb, keep)).toBe(false)
    expect(limbCullsBox(limb, cull)).toBe(true)
  })

  it('never culls off the globe (no silhouette ⇒ +Infinity inset)', () => {
    expect(limbCullsBox(() => Infinity, box(0, 0, 500, 500))).toBe(false)
  })
})
