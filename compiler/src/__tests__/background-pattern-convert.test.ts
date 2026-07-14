// background-pattern converter lowering + round-trip (#777 I-E).
//
// Mapbox `background-pattern` was DROPPED at convert-background-layer.ts:149-150
// (an ignored-properties warning). This cluster lowers the CONSTANT sprite-name
// form to a `pattern:` style property the runtime tiles over the background
// clear; the zoom-crossfade / expression form (which can't be a static name)
// warns once and drops.
//
// Fail-before:
//   • the emit tests — the constant form produced NO `pattern:` property (the
//     name was dropped), so the `background { … pattern: X }` assertions go red;
//   • the round-trip test — before the parser learned `pattern:`, the emitted
//     `background { pattern: X }` did not parse into a `pattern` styleProperty.

import { describe, it, expect } from 'vitest'
import { convertMapboxStyle } from '../convert/mapbox-to-xgis'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { withPragma } from './_pragma'

/** Extract the Conversion-notes warnings from a converted xgis source. */
function notesOf(style: unknown): string[] {
  const lines = convertMapboxStyle(style as never).split('\n')
  const out: string[] = []
  let inNotes = false
  for (const l of lines) {
    if (l.includes('Conversion notes')) {
      inNotes = true
      continue
    }
    if (l.trim() === '*/') inNotes = false
    else if (inNotes && l.includes('• ')) out.push(l.split('• ')[1] ?? '')
  }
  return out
}

const bgStyle = (paint: Record<string, unknown>) => ({
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint }],
})

describe('background-pattern converter lowering (#777 I-E)', () => {
  it('constant sprite name → background { … pattern: <name> } (fail-before: dropped at :149-150)', () => {
    const out = convertMapboxStyle(
      bgStyle({ 'background-color': '#101820', 'background-pattern': 'hatch' }) as never,
    )
    expect(out).toMatch(/background \{[^}]*pattern: hatch[^}]*\}/)
    // Lowered, not warned.
    expect(
      notesOf(bgStyle({ 'background-color': '#101820', 'background-pattern': 'hatch' })),
    ).not.toContain('background-pattern (zoom-crossfade)')
  })

  it('v8 ["literal", name] wrap unwraps to the same pattern: property', () => {
    const out = convertMapboxStyle(
      bgStyle({
        'background-color': '#101820',
        'background-pattern': ['literal', 'grid'],
      }) as never,
    )
    expect(out).toMatch(/pattern: grid/)
  })

  it('pattern-only background (no background-color) still emits the block', () => {
    // A pattern-only background must NOT be lost just because there's no fill.
    const out = convertMapboxStyle(bgStyle({ 'background-pattern': 'paper' }) as never)
    expect(out).toMatch(/background \{[^}]*pattern: paper[^}]*\}/)
  })

  it('zoom-crossfade / expression form warns once and drops', () => {
    // A step-by-zoom cross-fade can't be a static sprite name → warn, no emit.
    const notes = notesOf(
      bgStyle({
        'background-pattern': ['step', ['zoom'], 'a', 10, 'b'],
      }),
    )
    expect(notes.some((n) => n.includes('background-pattern (zoom-crossfade)'))).toBe(true)
    const out = convertMapboxStyle(
      bgStyle({ 'background-pattern': ['step', ['zoom'], 'a', 10, 'b'] }) as never,
    )
    expect(out).not.toMatch(/pattern:/)
  })

  it('an exotic name (spaces / slashes) is treated as non-lowerable and warns', () => {
    const notes = notesOf(bgStyle({ 'background-pattern': 'us/highway 2' }))
    expect(notes.some((n) => n.includes('background-pattern (zoom-crossfade)'))).toBe(true)
  })

  it('round-trips: the emitted background { pattern: X } parses into a pattern styleProperty', () => {
    // Proves the parser learned `pattern:` (parser.isStylePropertyStart) so the
    // converter's output reaches the runtime as a real style property.
    const src = withPragma('background { fill: #abcdef pattern: pat }')
    const ast = new Parser(new Lexer(src).tokenize()).parse() as {
      body: Array<{ kind: string; styleProperties?: Array<{ name: string; value: string }> }>
    }
    const bg = ast.body.find((s) => s.kind === 'BackgroundStatement')
    expect(bg, 'a BackgroundStatement must parse').toBeDefined()
    const pat = bg!.styleProperties?.find((p) => p.name === 'pattern')
    expect(
      pat,
      `expected a pattern styleProperty: ${JSON.stringify(bg!.styleProperties)}`,
    ).toBeDefined()
    expect(pat!.value).toBe('pat')
  })
})
