// End-to-end: xgis source → IR LabelDef.text shape.
//
// Verifies the lower pass routes label-["..."] through the
// template parser when the binding is a string literal, and falls
// back to bare-expression form for everything else (preserving
// the legacy IR shape expected by Mapbox-import paths).

import { describe, it, expect } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import type { RenderNode } from '../ir/render-node'

function compileToScene(source: string): RenderNode[] {
  const tokens = new Lexer(source).tokenize()
  const program = new Parser(tokens).parse()
  const scene = lower(program)
  return scene.renderNodes
}

function getLabel(source: string) {
  const nodes = compileToScene(source)
  expect(nodes.length).toBeGreaterThan(0)
  const label = nodes[0]!.label
  expect(label).toBeDefined()
  return label!
}

describe('label utility → IR TextValue', () => {
  describe('bare expression binding', () => {
    it('label-[.name] → kind:"expr"', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer cities {
          source: vt
          | label-[.name]
        }
      `)
      expect(label.text.kind).toBe('expr')
      if (label.text.kind === 'expr') {
        expect(label.text.expr.ast.kind).toBe('FieldAccess')
      }
    })

    it('label-[.a + .b] → kind:"expr" (BinOp)', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-[.a + .b]
        }
      `)
      expect(label.text.kind).toBe('expr')
    })
  })

  describe('string literal binding (template)', () => {
    it('label-["{name}"] collapses to kind:"expr"', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-["{name}"]
        }
      `)
      // Bare interp template short-circuits to kind:'expr' so
      // downstream consumers don't pay template-walk cost for
      // the most common case.
      expect(label.text.kind).toBe('expr')
    })

    it('label-["Lat: {.lat:.4f}°N"] becomes a 3-part template', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer coords {
          source: vt
          | label-["Lat: {.lat:.4f}°N"]
        }
      `)
      expect(label.text.kind).toBe('template')
      if (label.text.kind === 'template') {
        expect(label.text.parts).toHaveLength(3)
        expect(label.text.parts[0]).toEqual({ kind: 'literal', value: 'Lat: ' })
        const interp = label.text.parts[1]!
        expect(interp.kind).toBe('interp')
        if (interp.kind === 'interp') {
          expect(interp.spec).toEqual({ precision: 4, type: 'f' })
          // `.lat` parses as FieldAccess; bare `lat` would be an Identifier
          // (looking up a let-binding or builtin). Both shapes are valid
          // bindings — the renderer's text resolver evaluates whatever AST
          // the wiring layer produced.
          expect(interp.expr.ast.kind).toBe('FieldAccess')
        }
        expect(label.text.parts[2]).toEqual({ kind: 'literal', value: '°N' })
      }
    })

    it('label-["{name} ({country})"] — multi-interp template', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-["{name} ({country})"]
        }
      `)
      expect(label.text.kind).toBe('template')
      if (label.text.kind === 'template') {
        expect(label.text.parts.map(p => p.kind))
          .toEqual(['interp', 'literal', 'interp', 'literal'])
      }
    })

    it('label-["{coord:dms}"] — GIS spec preserved', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-["{coord:dms}"]
        }
      `)
      expect(label.text.kind).toBe('template')
      if (label.text.kind === 'template') {
        const interp = label.text.parts[0]!
        if (interp.kind === 'interp') {
          expect(interp.spec).toEqual({ type: 'dms' })
        }
      }
    })

    it('label-["plain"] — pure literal template (no interps)', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-["plain"]
        }
      `)
      expect(label.text.kind).toBe('template')
      if (label.text.kind === 'template') {
        expect(label.text.parts).toEqual([{ kind: 'literal', value: 'plain' }])
      }
    })

    it('label-[".dot"] — bare-expr field access (string literal but starts with dot is still string here)', () => {
      // ". dot" is just a string literal — no interp because there's
      // no `{...}`. The result is a literal-only template.
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-[".dot"]
        }
      `)
      expect(label.text.kind).toBe('template')
    })
  })

  describe('size default', () => {
    it('label without explicit size defaults to 12', () => {
      const label = getLabel(`
        source vt { type: vector, url: "x.pmtiles" }
        layer x {
          source: vt
          | label-[.name]
        }
      `)
      expect(label.size).toBe(12)
    })
  })
})
