// `fill-antialias` gates the fill-OUTLINE draw, not an MSAA setting (#2166).
//
// The property has never meant "turn MSAA off". MapLibre creates its WebGL
// context with `antialias: false` (maplibre-gl/src/ui/map.ts:457), so it has
// no MSAA at all; its ONLY fill-edge AA is the 1 px feathered fill-OUTLINE
// pass, and draw_fill.ts:44 draws that pass only when the property is true:
//
//   if (painter.renderPass === 'translucent' && layer.paint.get('fill-antialias')) {
//
// The style spec encodes exactly that dependency —
//   fill-outline-color.requires = [{"!": "fill-pattern"}, {"fill-antialias": true}]
// — and nothing in compiler/src models a `requires` clause (grep returns only
// prose inside warning strings).
//
// Fail-before: `emitFillPaint` called addFillOutline at the TOP of the
// function, ~46 lines before it read fill-antialias, so the stroke was emitted
// unconditionally. On OFM Bright that painted a 1 px #cfcdca border around
// every `highway-area` service-road polygon where MapLibre paints none.
//
// Scope: the CONSTANT `false` case only. The zoom-step form
// (`["step", ["zoom"], …]`, OFM Bright landcover-wood) needs a zoom-gated
// stroke, which is not a convert-time decision, and the reverse half
// (synthesising a fill-color outline when antialias is true and
// fill-outline-color is unset) is a separate item — both are asserted
// UNCHANGED below so this increment cannot quietly grow into them.

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'

const HERE = dirname(fileURLToPath(import.meta.url))

type FixtureLayer = { id: string; type: string; paint?: Record<string, unknown> }

/** The REAL authored witness, read from the corpus fixture rather than
 *  transcribed, so this test cannot drift from the style it exists to cover. */
function ofmBrightLayer(id: string): FixtureLayer {
  const style = JSON.parse(
    readFileSync(join(HERE, 'fixtures', 'openfreemap-bright.json'), 'utf8'),
  ) as { layers: FixtureLayer[] }
  const layer = style.layers.find((l) => l.id === id)
  if (!layer) throw new Error(`OFM Bright fixture has no layer "${id}"`)
  return layer
}

/** Convert ONE fill layer's authored paint bag on a minimal vector source.
 *  Single-layer on purpose: the assertions below are "no stroke utility in the
 *  output at all", which a whole-style conversion could not make. */
function convertPaint(paint: Record<string, unknown>): { out: string; warnings: string[] } {
  const warnings: string[] = []
  const out = convertMapboxStyle(
    {
      version: 8,
      sources: { v: { type: 'vector', tiles: ['https://example.com/{z}/{x}/{y}.pbf'] } },
      layers: [
        { id: 'subject', type: 'fill', source: 'v', 'source-layer': 'transportation', paint },
      ],
    } as never,
    { coverage: { sources: [], layers: [], warnings } },
  )
  return { out, warnings }
}

describe('fill-antialias: false suppresses the fill-outline draw — corpus witness', () => {
  it('OFM Bright still authors highway-area as antialias:false + outline #cfcdca', () => {
    // Guards the witness below: if the corpus changes shape this fails loudly
    // instead of the real assertion going vacuously green.
    const paint = ofmBrightLayer('highway-area').paint!
    expect(paint['fill-antialias']).toBe(false)
    expect(paint['fill-outline-color']).toBe('#cfcdca')
  })

  it('highway-area emits NO stroke utility (fail-before: stroke-#cfcdca stroke-1)', () => {
    const { out } = convertPaint(ofmBrightLayer('highway-area').paint!)
    expect(out).not.toContain('stroke-#cfcdca')
    expect(out).not.toContain('stroke-1')
    // …and the layer is still converted, so the assertions above cannot be
    // satisfied by the layer disappearing.
    expect(out).toContain('fill-antialias-false')
    expect(out).toContain('fill-#')
  })

  it('the same paint WITHOUT fill-antialias still emits the outline (spec default true)', () => {
    const paint = { ...ofmBrightLayer('highway-area').paint! }
    delete paint['fill-antialias']
    const { out } = convertPaint(paint)
    expect(out).toContain('stroke-#cfcdca')
    expect(out).toContain('stroke-1')
  })

  it('fill-antialias: true still emits the outline', () => {
    const paint = { ...ofmBrightLayer('highway-area').paint!, 'fill-antialias': true }
    const { out } = convertPaint(paint)
    expect(out).toContain('stroke-#cfcdca')
    expect(out).toContain('stroke-1')
  })

  it('["literal", false] is the same constant and suppresses it too', () => {
    const paint = {
      ...ofmBrightLayer('highway-area').paint!,
      'fill-antialias': ['literal', false],
    }
    const { out } = convertPaint(paint)
    expect(out).not.toContain('stroke-#cfcdca')
    expect(out).not.toContain('stroke-1')
  })
})

describe('fill-antialias — forms this increment deliberately leaves alone', () => {
  it('the zoom-step form keeps its outline (a zoom-gated stroke is not a convert-time call)', () => {
    // OFM Bright landcover-wood: ["step", ["zoom"], false, 9, true] + an
    // hsla(0,0%,0%,0.03) outline. Out of scope — asserted so a later widening
    // of the gate to non-constant forms shows up here first.
    const wood = ofmBrightLayer('landcover-wood').paint!
    expect(Array.isArray(wood['fill-antialias'])).toBe(true)
    const { out } = convertPaint(wood)
    expect(out).toContain('fill-antialias-[step(zoom, 0, 9, 1)]')
    expect(out).toContain('stroke-1')
  })

  it('a data-driven fill-antialias warns and drops, and the outline stays (default true)', () => {
    // The spec types fill-antialias `parameters: ["zoom"]` / data-constant, so
    // the per-feature form is OUT OF SPEC and warn-and-drop is correct.
    const { out, warnings } = convertPaint({
      'fill-color': '#eeeeee',
      'fill-outline-color': '#cfcdca',
      'fill-antialias': ['step', ['get', 'kind'], false, 1, true],
    })
    expect(warnings.some((w) => /fill-antialias/i.test(w))).toBe(true)
    expect(out).toContain('stroke-#cfcdca')
  })

  it('an antialias-true fill with NO fill-outline-color still synthesises nothing', () => {
    // The reverse half of the spec dependency (MapLibre falls the outline back
    // to fill-color) is a separate, pixel-judged item — 41 of 47 corpus fill
    // layers would gain a draw. Pinned here so it is a deliberate change.
    const { out } = convertPaint({ 'fill-color': '#eeeeee', 'fill-antialias': true })
    expect(out).not.toContain('stroke-')
  })
})
