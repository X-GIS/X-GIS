// ═══ `anchor` moves the symbol's origin inside its own box (#1550) ═══
//
// The language has documented `anchor` since Major 1 and it was discarded in lowering; #1550 carries
// it through to here, which is the only place that parses a path and therefore the only place that
// knows the bounding box.
//
// APPLIED AS A TRANSLATION OF THE GEOMETRY, not as a field the shader reads. The SDF evaluates path
// coordinates directly against the incoming uv (`shaders/dsl/point.ts:257`), so moving the points IS
// moving the anchor — no shader, no GPU struct, no draw path changes, and every shape that does not
// ask for an anchor keeps byte-identical segments. That last property is what this file pins hardest:
// the feature has to be invisible to everything that predates it.

import { describe, it, expect } from 'vitest'
import { ShapeRegistry } from './sdf-shape'

/** A registry over a recording stub — nothing here reaches a GPU; the buffers are never uploaded. */
const registry = (): ShapeRegistry =>
  new ShapeRegistry({
    createBuffer: () => ({}) as never,
    writeBuffer: () => {},
    destroyBuffer: () => {},
  } as never)

/** The segments a shape registered under `name` holds, read back off the registry. */
function segsOf(r: ShapeRegistry, name: string): { x: number; y: number }[] {
  const shapes = (
    r as unknown as { shapes: Map<string, { segments: { p0x: number; p0y: number }[] }> }
  ).shapes
  const hit = shapes.get(`user:${name}`) ?? shapes.get(name)
  expect(hit, `${name} must be registered`).toBeDefined()
  return hit!.segments.map((s) => ({ x: s.p0x, y: s.p0y }))
}

/** Extent of a shape's start points, which is enough to see the shape MOVE. */
function span(pts: { x: number; y: number }[]): {
  minX: number
  maxX: number
  minY: number
  maxY: number
} {
  return {
    minX: Math.min(...pts.map((p) => p.x)),
    maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)),
    maxY: Math.max(...pts.map((p) => p.y)),
  }
}

// A unit square, so the arithmetic below is readable: normalized to max extent 1, its own box runs
// -1…1 on both axes and `pathToSegments` pads it by a 0.1 margin.
const SQUARE = 'M -1 -1 L 1 -1 L 1 1 L -1 1 Z'

describe('anchor translates the geometry (#1550)', () => {
  it('no anchor leaves it EXACTLY where it was — the fail-safe every old shape relies on', () => {
    const a = registry()
    const b = registry()
    a.addUserShape('plain', SQUARE)
    b.addUserShape('plain', SQUARE, 'center')
    // `center` is the historical behaviour, so it must be a no-op rather than "a shift that happens
    // to be zero for a symmetric path" — asserted on an ASYMMETRIC path where the two differ if the
    // centre is recomputed rather than left alone.
    const c = registry()
    const d = registry()
    const OFFSET = 'M 0 0 L 2 0 L 2 1 Z'
    c.addUserShape('off', OFFSET)
    d.addUserShape('off', OFFSET, 'center')
    expect(segsOf(a, 'plain')).toEqual(segsOf(b, 'plain'))
    expect(segsOf(c, 'off')).toEqual(segsOf(d, 'off'))
  })

  it('`top` puts the top edge on the origin — the glyph hangs BELOW its point', () => {
    // The convention a pin or a callout wants, and the reason `anchor` is in the grammar.
    const r = registry()
    r.addUserShape('pin', SQUARE, 'top')
    const s = span(segsOf(r, 'pin'))
    // The box (incl. the 0.1 margin) spans 2.2; `top` shifts it down by half of that from centred.
    expect(s.minY, 'the top edge sits at the origin, within the margin').toBeCloseTo(0.1, 6)
    expect(s.maxY).toBeGreaterThan(s.minY)
    // …and nothing moved horizontally.
    expect(s.minX).toBeCloseTo(-1, 6)
    expect(s.maxX).toBeCloseTo(1, 6)
  })

  it('`bottom` is the mirror of `top`, and `left` / `right` the mirror of each other', () => {
    const mk = (a: string): ReturnType<typeof span> => {
      const r = registry()
      r.addUserShape('s', SQUARE, a)
      return span(segsOf(r, 's'))
    }
    const top = mk('top')
    const bottom = mk('bottom')
    expect(bottom.maxY, 'bottom is top reflected through the origin').toBeCloseTo(-top.minY, 6)
    const left = mk('left')
    const right = mk('right')
    expect(right.maxX).toBeCloseTo(-left.minX, 6)
    // …and the two axes are independent, stated directly rather than as a derived offset: a
    // VERTICAL anchor must not move x at all, and a horizontal one must not move y.
    const centre = mk('center')
    expect(top.minX, 'a vertical anchor leaves x alone').toBeCloseTo(centre.minX, 6)
    expect(bottom.maxX).toBeCloseTo(centre.maxX, 6)
    expect(left.minY, 'a horizontal anchor leaves y alone').toBeCloseTo(centre.minY, 6)
    expect(right.maxY).toBeCloseTo(centre.maxY, 6)
  })

  it('an unknown anchor falls back to centred rather than to NaN', () => {
    // The compiler already diagnoses this (X-GIS0015); the renderer must still draw something, and
    // in particular must not emit NaN coordinates — some drivers rasterize a NaN vertex as a
    // full-screen triangle.
    const r = registry()
    const c = registry()
    r.addUserShape('weird', SQUARE, 'middleish')
    c.addUserShape('weird', SQUARE)
    expect(segsOf(r, 'weird')).toEqual(segsOf(c, 'weird'))
    for (const p of segsOf(r, 'weird')) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true)
    }
  })

  it('the FAIL-BEFORE: without the shift, every anchor is the same shape', () => {
    // What the code did until #1550 — the anchor never reached here, so all five produced identical
    // geometry. If the translation is ever severed, this is the assertion that names it.
    const geom = (a?: string): { x: number; y: number }[] => {
      const r = registry()
      r.addUserShape('s', SQUARE, a)
      return segsOf(r, 's')
    }
    const base = JSON.stringify(geom())
    const distinct = new Set(
      ['center', 'top', 'bottom', 'left', 'right'].map((a) => JSON.stringify(geom(a))),
    )
    expect(distinct.size, 'the five anchors are five different placements').toBe(5)
    expect(distinct.has(base), 'and `center` is the untouched one').toBe(true)
  })
})
