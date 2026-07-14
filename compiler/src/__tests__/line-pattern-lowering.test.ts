// Reproduce + regression guard for the line-pattern / stroke-pattern
// namespace collision (fix/line-pattern-dead-branch).
//
// Defect: convert/paint.ts emitted Mapbox `line-pattern: <sprite>` as the
// utility `stroke-pattern-<sprite>`. But `stroke-pattern-<bareshape>` is
// ALSO the native X-GIS SDF dash slot-0 shape syntax, and lower.ts had two
// if/else-if arms both matching `name.startsWith('stroke-pattern-')`. The
// SDF arm (parsePatternAttr slot 0) always won, routing the sprite into the
// dash path where it was dropped (size 0 → validPatterns filter), so the
// `linePattern` IR field was never set and line-pattern silently vanished.
//
// Fix: line-pattern now rides a DISTINCT `stroke-image-` utility so it no
// longer collides with the native SDF `stroke-pattern-` dash namespace.
//
// Oracle — asserted on the lowered render node (the IR seam where the bug
// lives). The show-command level is unsuitable because `optimize()` prunes a
// colourless line layer (line-pattern with no line-color) before emit, which
// is orthogonal to this defect.
//   1. Mapbox `line-pattern: 'rail'` → renderNode.linePattern === 'rail'
//      (before fix: undefined — lost).
//   2. Native `stroke-pattern-railroad` (+ spacing/size) still bakes a SDF
//      dash slot-0 shape 'railroad' AND does NOT leak into linePattern
//      (fix must not disturb the native namespace).

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { withPragma } from './_pragma'

function lowerMapbox(mapboxStyle: unknown): ReturnType<typeof lower> {
  const xgisSource = convertMapboxStyle(mapboxStyle as Parameters<typeof convertMapboxStyle>[0])
  const ast = new Parser(new Lexer(withPragma(xgisSource)).tokenize()).parse()
  return lower(ast)
}

function lowerXgis(source: string): ReturnType<typeof lower> {
  const ast = new Parser(new Lexer(withPragma(source)).tokenize()).parse()
  return lower(ast)
}

describe('line-pattern lowering — Mapbox line-pattern → IR linePattern', () => {
  it('Mapbox line-pattern: "rail" reaches renderNode.linePattern (end-to-end)', () => {
    // THE defect. A real line layer (line-width present) with a constant
    // line-pattern sprite must thread the sprite name all the way through
    // to the lowered render node's linePattern field. Before the fix this
    // was undefined because the sprite was mis-routed into the SDF dash path.
    const scene = lowerMapbox({
      version: 8,
      sources: { t: { type: 'vector', tiles: ['x'] } },
      layers: [
        {
          id: 'railway',
          type: 'line',
          source: 't',
          'source-layer': 'transportation',
          paint: { 'line-width': 2, 'line-pattern': 'rail' },
        },
      ],
    })
    const node = scene.renderNodes[0]!
    expect(node.linePattern).toBe('rail')
  })

  it('native SDF stroke-pattern-railroad still bakes a dash slot-0 shape (namespace intact)', () => {
    // The other half of the namespace: the native X-GIS SDF dash pattern
    // syntax `stroke-pattern-<bareshape>` (with spacing + size so it
    // survives the validPatterns filter) must STILL produce a slot-0
    // pattern shape, and must NOT leak into the line-pattern field. If the
    // fix had broken this arm, stroke.patterns would be undefined.
    const scene = lowerXgis(`
      source s { type: geojson url: "x.geojson" }
      layer rail {
        source: s
        | stroke-gray-500 stroke-2
        | stroke-pattern-railroad stroke-pattern-spacing-40px stroke-pattern-size-10px
      }
    `)
    const node = scene.renderNodes[0]!
    expect(node.stroke.patterns).toBeDefined()
    expect(node.stroke.patterns).toHaveLength(1)
    expect(node.stroke.patterns![0]!.shape).toBe('railroad')
    // The SDF dash path must NOT leak into the line-pattern field.
    expect(node.linePattern).toBeUndefined()
  })
})
