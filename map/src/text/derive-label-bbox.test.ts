// #777 IV3-2c — the single label-box authority, and the perspectiveScale exclusion.
//
// `deriveLabelBbox` replaced two identical copies of the box arithmetic in
// prepare() (the layout-cache-hit path and the shaping path). Two copies of a
// formula are two chances to apply a ground basis to only one of them, which is
// exactly the box/quad desynchronization #777 IV3 exists to avoid.
//
// The basis→box→quad agreement itself is pinned in text-ground-basis-wiring
// .test.ts against the REAL renderer's emitted vertices. This file pins the
// helper's own contract and the mutual exclusion with perspectiveScale.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { deriveLabelBbox } from './text-stage-helpers'

const METRICS = { totalAdvance: 80, blockTop: -12, blockBottom: 4, padding: 2 }

describe('#777 IV3-2c — deriveLabelBbox', () => {
  it('without a basis reproduces the arithmetic it replaced, exactly', () => {
    // The literal both call sites used, spelled out here so a change to the
    // helper cannot quietly redefine what a label's box is.
    const drawX = 100
    const drawY = 200
    expect(deriveLabelBbox(drawX, drawY, METRICS)).toEqual({
      minX: drawX - METRICS.padding,
      minY: drawY + METRICS.blockTop - METRICS.padding,
      maxX: drawX + METRICS.totalAdvance + METRICS.padding,
      maxY: drawY + METRICS.blockBottom + METRICS.padding,
    })
  })

  it('an identity basis is a no-op — so an unpitched label keeps its box', () => {
    const plain = deriveLabelBbox(100, 200, METRICS)
    const identity = deriveLabelBbox(100, 200, METRICS, [1, 0, 0, 1])
    expect(identity.minX).toBeCloseTo(plain.minX, 9)
    expect(identity.minY).toBeCloseTo(plain.minY, 9)
    expect(identity.maxX).toBeCloseTo(plain.maxX, 9)
    expect(identity.maxY).toBeCloseTo(plain.maxY, 9)
  })

  it('a foreshortening basis SHRINKS the box (the whole point)', () => {
    const plain = deriveLabelBbox(100, 200, METRICS)
    const tilted = deriveLabelBbox(100, 200, METRICS, [1, 0, 0, 0.5])
    // Height halves; width is untouched at this basis.
    expect(tilted.maxY - tilted.minY).toBeCloseTo((plain.maxY - plain.minY) * 0.5, 9)
    expect(tilted.maxX - tilted.minX).toBeCloseTo(plain.maxX - plain.minX, 9)
    // Non-vacuity: it must actually differ, or a pass-through would satisfy this.
    expect(tilted.maxY - tilted.minY).toBeLessThan(plain.maxY - plain.minY)
  })

  it('an off-diagonal basis takes extremes from ALL FOUR corners', () => {
    // A two-corner (diagonal-only) implementation is correct at bearing 0 and
    // wrong under bearing+pitch. Rotating 90° maps the box's width onto screen
    // y and its height onto screen x — a diagonal-pair implementation would
    // report the untransformed extents instead.
    const rot90 = deriveLabelBbox(0, 0, METRICS, [0, 1, -1, 0])
    const plain = deriveLabelBbox(0, 0, METRICS)
    expect(rot90.maxX - rot90.minX).toBeCloseTo(plain.maxY - plain.minY, 9)
    expect(rot90.maxY - rot90.minY).toBeCloseTo(plain.maxX - plain.minX, 9)
  })

  it('the box pivots on the draw anchor, which is what keeps it with the quad', () => {
    // TextDraw.anchorX IS this drawX, and the renderer pivots the quad there.
    // A basis that translated instead of transforming about the anchor would
    // move a zero-extent box off the anchor.
    const zero = { totalAdvance: 0, blockTop: 0, blockBottom: 0, padding: 0 }
    const b = deriveLabelBbox(37, -11, zero, [0.3, 0.9, -0.8, 0.4])
    expect(b.minX).toBeCloseTo(37, 9)
    expect(b.maxX).toBeCloseTo(37, 9)
    expect(b.minY).toBeCloseTo(-11, 9)
    expect(b.maxY).toBeCloseTo(-11, 9)
  })
})

// The exclusion lives on one line of prepare(). Driving it behaviourally needs
// the whole atlas / device / collision surface — the constraint this directory
// already documents (label-pass-vt-perspective-wiring.test.ts states the same),
// so it is pinned structurally, in that established style.
const STAGE_SRC = readFileSync(resolve(__dirname, 'text-stage.ts'), 'utf8').replace(/\r\n/g, '\n')
const TYPES_SRC = readFileSync(resolve(__dirname, 'text-stage-types.ts'), 'utf8').replace(
  /\r\n/g,
  '\n',
)

describe('#777 IV3-2c — a ground basis suppresses perspectiveScale', () => {
  it('prepare() resolves perspScale to 1 when a basis is present', () => {
    // Both express the same distance attenuation: perspectiveScale isotropically
    // (right for a billboard), the basis anisotropically via its det (right for a
    // quad lying on the ground). Composing them shrinks a far label TWICE.
    const idx = STAGE_SRC.indexOf('const perspScale =')
    expect(idx, 'perspScale assignment must exist — fail loudly if renamed').toBeGreaterThan(-1)
    const line = STAGE_SRC.slice(idx, STAGE_SRC.indexOf('\n', idx))
    expect(line).toContain('p.groundBasis !== undefined ? 1')
    expect(line).toContain('p.perspectiveScale ?? 1')
  })

  it('the exclusion is documented where the fields are declared, not only at the use', () => {
    // #9.5: the reason has to survive next to the data, or it gets re-composed.
    const idx = TYPES_SRC.indexOf('groundBasis?: ArrayLike<number>')
    expect(idx, 'PendingLabel.groundBasis must exist').toBeGreaterThan(-1)
    const doc = TYPES_SRC.slice(Math.max(0, idx - 1200), idx)
    expect(doc).toContain('MUTUALLY EXCLUSIVE')
    expect(doc).toContain('perspectiveScale')
  })

  it('both TextDraw construction paths forward the basis (cache-hit AND shaping)', () => {
    // A label that hits the layout cache must lie in the ground plane too; the
    // cached record is basis-independent by design, so the forward has to happen
    // at BOTH sites or a steady scene (~all cache hits) stays upright.
    const forwards = STAGE_SRC.match(/groundBasis: p\.groundBasis/g) ?? []
    expect(forwards.length).toBe(2)
  })
})
