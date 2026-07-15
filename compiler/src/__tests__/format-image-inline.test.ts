// Inline images in formatted / bare-image label text (#777 I-G).
//
// Mapbox lets a `text-field` carry sprite images inside the glyph run —
// the bare `["image", name]` form and an `["image", …]` section inside
// `["format", …]`. Before I-G both DROPPED (the `image` op fell to the
// KNOWN_UNSUPPORTED table → null; a format section silently vanished). Now
// the converter lowers such an image to the xgis `image(name)` builtin,
// whose evaluator wraps the resolved name in the inline-image sentinels so
// the runtime label shaper can carve it out and render a sprite quad.
//
// Fail-before: with the imageHandler + `image` builtin reverted, every
// `expect(...).toContain('image(')` / marker assertion below fails (the
// converter returns null and the layer drops).

import { describe, expect, it } from 'vitest'
import { exprToXgis } from '../convert/expressions'
import { textFieldToXgisExpr } from '../convert/layers-helpers'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { evaluate } from '../eval/evaluator'
import {
  INLINE_IMAGE_START,
  INLINE_IMAGE_END,
  inlineImageMarker,
} from '../eval/inline-image-marker'
import { withPragma } from './_pragma'

describe('#777 I-G — inline images in label text: converter', () => {
  it('bare ["image", name] lowers to the image() builtin (not null)', () => {
    const warnings: string[] = []
    const result = exprToXgis(['image', 'pat'], warnings)
    expect(result).toBe('image("pat")')
  })

  it('bare ["image", name] as a text-field routes through the same builtin', () => {
    const warnings: string[] = []
    const result = textFieldToXgisExpr(['image', 'pat'], warnings)
    expect(result).toBe('image("pat")')
  })

  it('data-driven ["image", ["get", key]] carries the name expression', () => {
    const warnings: string[] = []
    const result = exprToXgis(['image', ['get', 'sprite']], warnings)
    expect(result).toBe('image(.sprite)')
  })

  it('["format", text, image, text] concatenates the image section (not dropped)', () => {
    const warnings: string[] = []
    const result = exprToXgis(['format', 'A ', {}, ['image', 'pat'], {}, ' B', {}], warnings)
    expect(result).not.toBeNull()
    expect(result).toBe('concat("A ", image("pat"), " B")')
    // The image section no longer trips the per-section partial-drop warning.
    expect(warnings.some((w) => w.includes('dropped from concat'))).toBe(false)
  })
})

describe('#777 I-G — inline images in label text: evaluator marker', () => {
  it('image(name) evaluates to the sprite name wrapped in the PUA sentinels', () => {
    const warnings: string[] = []
    const xgis = exprToXgis(['image', 'pat'], warnings)
    // Parse the emitted xgis expression through a label and evaluate it.
    const scene = lowerLabel(`label-[${xgis}]`)
    const text = scene.label.text
    if (text.kind !== 'expr') throw new Error('expected kind:expr')
    const result = evaluate(text.expr.ast, {})
    expect(result).toBe(inlineImageMarker('pat'))
    expect(result).toBe(`${INLINE_IMAGE_START}pat${INLINE_IMAGE_END}`)
  })

  it('a format run lowers + evaluates to text-with-marker-in-the-middle', () => {
    // concat("A ", image("pat"), " B") — the marker sits BETWEEN the two
    // text runs, exactly where the runtime shaper expects the image quad.
    const scene = lowerLabel('label-[concat("A ", image("pat"), " B")]')
    const text = scene.label.text
    if (text.kind !== 'expr') throw new Error('expected kind:expr')
    const result = evaluate(text.expr.ast, {})
    expect(result).toBe(`A ${inlineImageMarker('pat')} B`)
  })

  it('missing/empty image name yields no marker (MapLibre drop parity)', () => {
    const scene = lowerLabel('label-[image("")]')
    const text = scene.label.text
    if (text.kind !== 'expr') throw new Error('expected kind:expr')
    expect(evaluate(text.expr.ast, {})).toBe('')
  })
})

/** Lower an inline `label-[…]` utility on a throwaway symbol layer and
 *  return the layer's render node (with its LabelDef). */
function lowerLabel(labelUtility: string): { label: import('../ir/render-node').LabelDef } {
  const src = `
source x { type: pmtiles, url: "x.pmtiles" }
layer L {
  source: x
  sourceLayer: "place"
  | ${labelUtility} label-size-12
}
`
  const tokens = new Lexer(withPragma(src)).tokenize()
  const ast = new Parser(tokens).parse()
  const scene = lower(ast)
  const layer = scene.renderNodes.find((l: { name?: string }) => l.name === 'L') as {
    label: import('../ir/render-node').LabelDef
  }
  if (!layer || !layer.label) throw new Error('label layer did not lower')
  return layer
}
