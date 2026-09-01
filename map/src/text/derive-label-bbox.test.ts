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

describe('#2012 INC-5 — a ground basis no longer suppresses the size correction', () => {
  // This block used to pin the OPPOSITE: `perspScale = groundBasis !== undefined ?
  // 1 : …`, on the reading that the basis already carried the distance
  // attenuation. It does not — the basis is a normalized RATIO and is the identity
  // at pitch 0 by construction, so it carries the tilt and no absolute distance
  // term at all. Forcing 1 is NEITHER of MapLibre's two branches (design §2(2) /
  // §3.3, rejected in §8 R6), and it left every ground-projected label smaller
  // than the reference by the whole perspective factor. The pins are inverted
  // rather than deleted so a re-introduction of the suppression fails here.

  it('the POINT loop applies perspectiveScale unconditionally — no basis branch', () => {
    const idx = STAGE_SRC.indexOf('const sizePx = labelSizePx(')
    expect(idx, 'the point loop`s sizePx site must exist — fail loudly if renamed').toBeGreaterThan(
      -1,
    )
    const line = STAGE_SRC.slice(idx, STAGE_SRC.indexOf('\n', idx))
    expect(line).toContain('p.perspectiveScale ?? 1')
    // The suppression, in either spelling it could come back as.
    expect(line).not.toContain('groundBasis')
    expect(STAGE_SRC).not.toContain('p.groundBasis !== undefined ? 1')
  })

  it('the CURVED loop applies the map-branch multiplier it is handed', () => {
    // The curved branch is where the Mapbox impact lives (design §1.2) and it had
    // no perspective term at all before INC-5.
    const idx = STAGE_SRC.indexOf('labelSizePx(p.def.size, dpr, p.groundSizeScale')
    expect(idx, 'the curved loop must size through the same authority').toBeGreaterThan(-1)
  })

  it('BOTH loops derive sizePx through the one authority, never open-coded', () => {
    // Two copies of `size * dpr * quantise(scale)` are two chances to quantise one
    // and not the other, which the layout cache (keyed on sizePx) would then thrash
    // on for one arm only.
    expect((STAGE_SRC.match(/labelSizePx\(/g) ?? []).length).toBe(2)
    expect(STAGE_SRC).not.toContain('Math.round(perspScale * 64)')
  })

  it('the two branches are documented where the fields are declared, not only at the use', () => {
    // #9.5: the reason has to survive next to the data, or it gets re-composed —
    // and this field's reason is now the opposite of what it was.
    const idx = TYPES_SRC.indexOf('perspectiveScale?: number')
    expect(idx, 'PendingLabel.perspectiveScale must exist').toBeGreaterThan(-1)
    const doc = TYPES_SRC.slice(Math.max(0, idx - 2400), idx)
    expect(doc).toContain('VIEWPORT branch')
    expect(doc).toContain('MAP branch')
    expect(doc, 'the retired suppression must not be re-documented').not.toContain(
      'MUTUALLY EXCLUSIVE',
    )
    // And the curved twin exists with its own contract.
    expect(TYPES_SRC).toContain('groundSizeScale?: number')
  })

  it('both TextDraw construction paths forward the basis (cache-hit AND shaping)', () => {
    // A label that hits the layout cache must lie in the ground plane too; the
    // cached record is basis-independent by design, so the forward has to happen
    // at BOTH sites or a steady scene (~all cache hits) stays upright.
    const forwards = STAGE_SRC.match(/groundBasis: p\.groundBasis/g) ?? []
    expect(forwards.length).toBe(2)
  })
})
