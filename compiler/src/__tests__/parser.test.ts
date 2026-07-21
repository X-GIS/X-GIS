import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser, parseExpressionString } from '../parser/parser'
import type * as AST from '../parser/ast'
import { withPragma } from './_pragma'

function parse(source: string): AST.Program {
  const tokens = new Lexer(withPragma(source)).tokenize()
  return new Parser(tokens).parse()
}

describe('Parser', () => {
  describe('pruned keywords parse as plain identifiers (#1072)', () => {
    // place/view/on/struct/enum/simulate/analyze/export were tokenized but
    // never implemented; let/fn/show/style (and if/else/for/in/return, which
    // only existed for fn bodies) were removed. They all lex as ordinary
    // identifiers now.
    const pruned = [
      'place',
      'view',
      'on',
      'struct',
      'enum',
      'simulate',
      'analyze',
      'export',
      'show',
      'let',
      'fn',
      'style',
      'if',
      'else',
      'for',
      'in',
      'return',
    ]
    for (const kw of pruned) {
      it(`\`${kw}\` is an ordinary identifier in expression position`, () => {
        const expr = parseExpressionString(kw) as AST.Identifier
        expect(expr.kind).toBe('Identifier')
        expect(expr.name).toBe(kw)
      })
    }

    it('a pruned keyword is usable as a source name', () => {
      const ast = parse('source view { type: geojson }')
      const stmt = ast.body[0] as AST.SourceStatement
      expect(stmt.kind).toBe('SourceStatement')
      expect(stmt.name).toBe('view')
    })

    it('a bare pruned keyword at top level errors like any identifier there', () => {
      // Top-level expression statements were also pruned (#1072), so a
      // stray identifier at statement position is a normal parse error.
      expect(() => parse('show')).toThrow(/\[Parser\] Expected a top-level statement/)
    })

    it('the legacy `show` program errors with a normal parse diagnostic', () => {
      expect(() =>
        parse(`
        show world {
          fill: #f2efe9
          stroke: #ccc, 1px
        }
      `),
      ).toThrow(/\[Parser\]/)
    })

    it('the legacy `let` binding errors with a normal parse diagnostic', () => {
      expect(() => parse('let world = load("countries.geojson")')).toThrow(/\[Parser\]/)
    })

    it('the legacy `fn` declaration errors with a normal parse diagnostic', () => {
      expect(() => parse('fn f(x: f32) -> f32 { return x }')).toThrow(/\[Parser\]/)
    })
  })

  describe('no top-level expression statements (#1072)', () => {
    // Bare expressions at file scope were accidental surface — parsed,
    // then silently ignored by lowering. They are normal parse errors now.
    for (const src of ['42', '[1, 2]', '.speed', 'zoom >= 10']) {
      it(`\`${src}\` at top level is a parse error`, () => {
        expect(() => parse(src)).toThrow(/\[Parser\] Expected a top-level statement/)
      })
    }
  })

  describe('expressions (via parseExpressionString)', () => {
    it('parses field access (.field)', () => {
      const field = parseExpressionString('.speed') as AST.FieldAccess
      expect(field.kind).toBe('FieldAccess')
      expect(field.object).toBeNull() // implicit
      expect(field.field).toBe('speed')
    })

    it('parses chained field access (a.b.c)', () => {
      const outer = parseExpressionString('ship.position.lat') as AST.FieldAccess
      expect(outer.field).toBe('lat')
      const inner = outer.object as AST.FieldAccess
      expect(inner.field).toBe('position')
      expect((inner.object as AST.Identifier).name).toBe('ship')
    })

    it('parses number with unit', () => {
      const num = parseExpressionString('5km') as AST.NumberLiteral
      expect(num.value).toBe(5)
      expect(num.unit).toBe('km')
    })

    it('parses comparison expressions', () => {
      const cmp = parseExpressionString('zoom >= 10') as AST.BinaryExpr
      expect(cmp.op).toBe('>=')
    })
  })

  describe('source statement', () => {
    it('parses source with properties', () => {
      const ast = parse(`
        source neighborhoods {
          type: geojson
          url: "./data/seoul_gu.geojson"
        }
      `)
      expect(ast.body).toHaveLength(1)

      const stmt = ast.body[0] as AST.SourceStatement
      expect(stmt.kind).toBe('SourceStatement')
      expect(stmt.name).toBe('neighborhoods')
      expect(stmt.properties).toHaveLength(2)

      expect(stmt.properties[0].name).toBe('type')
      expect((stmt.properties[0].value as AST.Identifier).name).toBe('geojson')

      expect(stmt.properties[1].name).toBe('url')
      expect((stmt.properties[1].value as AST.StringLiteral).value).toBe('./data/seoul_gu.geojson')
    })

    it('parses source with comma-separated properties', () => {
      const ast = parse(`source world { type: geojson, url: "countries.geojson" }`)
      const stmt = ast.body[0] as AST.SourceStatement
      expect(stmt.properties).toHaveLength(2)
    })
  })

  describe('layer statement', () => {
    it('parses layer with properties and utilities', () => {
      const ast = parse(`
        layer districts {
          source: neighborhoods
          | fill-blue-400 stroke-white stroke-2 opacity-80
        }
      `)
      expect(ast.body).toHaveLength(1)

      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.kind).toBe('LayerStatement')
      expect(stmt.name).toBe('districts')

      // source property
      expect(stmt.properties).toHaveLength(1)
      expect(stmt.properties[0].name).toBe('source')
      expect((stmt.properties[0].value as AST.Identifier).name).toBe('neighborhoods')

      // utility line
      expect(stmt.utilities).toHaveLength(1)
      expect(stmt.utilities[0].items).toHaveLength(4)
      expect(stmt.utilities[0].items[0].name).toBe('fill-blue-400')
      expect(stmt.utilities[0].items[1].name).toBe('stroke-white')
      expect(stmt.utilities[0].items[2].name).toBe('stroke-2')
      expect(stmt.utilities[0].items[3].name).toBe('opacity-80')
    })

    it('parses multiple utility lines', () => {
      const ast = parse(`
        layer tracks {
          source: military_tracks
          | symbol-arrow size-8 rotate-45
          | fill-green-500 stroke-black stroke-1
          | opacity-80
        }
      `)

      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.utilities).toHaveLength(3)
      expect(stmt.utilities[0].items).toHaveLength(3)
      expect(stmt.utilities[1].items).toHaveLength(3)
      expect(stmt.utilities[2].items).toHaveLength(1)
    })

    it('parses utility with modifier', () => {
      const ast = parse(`
        layer tracks {
          source: data
          | friendly:fill-green-500 hostile:fill-red-500 fill-gray-400
        }
      `)

      const stmt = ast.body[0] as AST.LayerStatement
      const items = stmt.utilities[0].items

      expect(items[0].modifier).toBe('friendly')
      expect(items[0].name).toBe('fill-green-500')

      expect(items[1].modifier).toBe('hostile')
      expect(items[1].name).toBe('fill-red-500')

      expect(items[2].modifier).toBeNull()
      expect(items[2].name).toBe('fill-gray-400')
    })

    it('parses utility with data binding [expr]', () => {
      const ast = parse(`
        layer tracks {
          source: data
          | size-[speed]
        }
      `)

      const stmt = ast.body[0] as AST.LayerStatement
      const item = stmt.utilities[0].items[0]
      expect(item.name).toBe('size')
      expect(item.binding).not.toBeNull()
      expect((item.binding as AST.Identifier).name).toBe('speed')
    })
  })

  describe('DESIGN.md MVP example', () => {
    it('parses the complete MVP scene', () => {
      const ast = parse(`
        source neighborhoods {
          type: geojson
          url: "./data/seoul_gu.geojson"
        }

        layer districts {
          source: neighborhoods
          | fill-blue-400 stroke-white stroke-2 opacity-80
        }
      `)

      expect(ast.body).toHaveLength(2)
      expect(ast.body[0].kind).toBe('SourceStatement')
      expect(ast.body[1].kind).toBe('LayerStatement')
    })
  })

  describe('symbol statement', () => {
    it('parses symbol with path and anchor', () => {
      const ast = parse(`
        symbol arrow {
          path "M 0 -1 L -0.4 0.3 L 0.4 0.3 Z"
          anchor: center
        }
      `)
      const stmt = ast.body[0] as AST.SymbolStatement
      expect(stmt.kind).toBe('SymbolStatement')
      expect(stmt.name).toBe('arrow')
      expect(stmt.elements).toHaveLength(2)
      expect(stmt.elements[0]).toEqual({ kind: 'path', data: 'M 0 -1 L -0.4 0.3 L 0.4 0.3 Z' })
      expect(stmt.elements[1]).toEqual({ kind: 'anchor', value: 'center' })
    })

    it('parses symbol with rect and circle', () => {
      const ast = parse(`
        symbol nato_friendly {
          rect x: -1 y: -0.7 w: 2 h: 1.4
          circle cx: 0 cy: 0 r: 0.3
          anchor: center
        }
      `)
      const stmt = ast.body[0] as AST.SymbolStatement
      expect(stmt.elements).toHaveLength(3)

      const rect = stmt.elements[0]
      expect(rect.kind).toBe('rect')
      if (rect.kind === 'rect') {
        expect(rect.props.x).toBe(-1)
        expect(rect.props.w).toBe(2)
        expect(rect.props.h).toBe(1.4)
      }

      const circle = stmt.elements[1]
      expect(circle.kind).toBe('circle')
      if (circle.kind === 'circle') {
        expect(circle.props.r).toBe(0.3)
      }
    })
  })

  describe('preset statement (merged style+preset construct)', () => {
    it('parses a preset block of utility lines', () => {
      const ast = parse(`
        preset dark_land {
          | fill-stone-800 stroke-slate-600 stroke-1
        }
      `)
      expect(ast.body).toHaveLength(1)
      const stmt = ast.body[0] as AST.PresetStatement
      expect(stmt.kind).toBe('PresetStatement')
      expect(stmt.name).toBe('dark_land')
      expect(stmt.utilities).toHaveLength(1)
      expect(stmt.utilities[0].items.map((i) => i.name)).toEqual([
        'fill-stone-800',
        'stroke-slate-600',
        'stroke-1',
      ])
    })
  })

  describe('layer with CSS-like properties', () => {
    it('parses inline CSS properties in layer', () => {
      const ast = parse(`
        layer lakes {
          source: world
          fill: sky-700
          stroke: slate-400
          stroke-width: 0.5
          opacity: 0.9
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.properties).toHaveLength(1) // only source
      expect(stmt.properties[0].name).toBe('source')
      expect(stmt.styleProperties).toHaveLength(4)
      expect(stmt.styleProperties[0]).toMatchObject({ name: 'fill', value: 'sky-700' })
      expect(stmt.styleProperties[1]).toMatchObject({ name: 'stroke', value: 'slate-400' })
      expect(stmt.styleProperties[2]).toMatchObject({ name: 'stroke-width', value: '0.5' })
      expect(stmt.styleProperties[3]).toMatchObject({ name: 'opacity', value: '0.9' })
    })

    it('parses layer with style ref and inline CSS', () => {
      const ast = parse(`
        layer land {
          source: world
          style: dark_land
          fill: green-800
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.properties).toHaveLength(2) // source + style
      expect(stmt.properties[1].name).toBe('style')
      expect((stmt.properties[1].value as AST.Identifier).name).toBe('dark_land')
      expect(stmt.styleProperties).toHaveLength(1)
      expect(stmt.styleProperties[0]).toMatchObject({ name: 'fill', value: 'green-800' })
    })

    it('parses layer with CSS and utilities coexisting', () => {
      const ast = parse(`
        layer countries {
          source: world
          fill: emerald-600
          | stroke-white stroke-1 opacity-80
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.styleProperties).toHaveLength(1)
      expect(stmt.styleProperties[0]).toMatchObject({ name: 'fill', value: 'emerald-600' })
      expect(stmt.utilities).toHaveLength(1)
      expect(stmt.utilities[0].items).toHaveLength(3)
    })
  })

  describe('layer with filter', () => {
    it('parses filter expression in layer block', () => {
      const ast = parse(`
        layer cities {
          source: world
          filter: .pop > 1000000
          fill: red-500
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      expect(stmt.properties).toHaveLength(2) // source + filter
      const filterProp = stmt.properties[1]
      expect(filterProp.name).toBe('filter')
      expect(filterProp.value.kind).toBe('BinaryExpr')
      const bin = filterProp.value as AST.BinaryExpr
      expect(bin.op).toBe('>')
      expect((bin.left as AST.FieldAccess).field).toBe('pop')
      expect((bin.right as AST.NumberLiteral).value).toBe(1000000)
    })

    it('parses filter with string comparison', () => {
      const ast = parse(`
        layer rivers {
          source: water
          filter: .type == "river"
          stroke: blue-500
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      const filterProp = stmt.properties.find((p) => p.name === 'filter')!
      const bin = filterProp.value as AST.BinaryExpr
      expect(bin.op).toBe('==')
      expect((bin.left as AST.FieldAccess).field).toBe('type')
      expect((bin.right as AST.StringLiteral).value).toBe('river')
    })

    it('parses filter with logical operators', () => {
      const ast = parse(`
        layer big_cities {
          source: world
          filter: .pop > 500000 && .type == "city"
          fill: amber-500
        }
      `)
      const stmt = ast.body[0] as AST.LayerStatement
      const filterProp = stmt.properties.find((p) => p.name === 'filter')!
      expect(filterProp.value.kind).toBe('BinaryExpr')
      const and = filterProp.value as AST.BinaryExpr
      expect(and.op).toBe('&&')
    })
  })

  describe('ternary conditional', () => {
    it('parses expr ? expr : expr', () => {
      const expr = parseExpressionString('a > 5 ? 1 : 0')
      expect(expr.kind).toBe('ConditionalExpr')
      const cond = expr as AST.ConditionalExpr
      expect(cond.condition.kind).toBe('BinaryExpr')
      expect(cond.thenExpr.kind).toBe('NumberLiteral')
      expect(cond.elseExpr.kind).toBe('NumberLiteral')
    })

    it('parses nested ternary', () => {
      const expr = parseExpressionString('a > 10 ? 2 : a > 5 ? 1 : 0') as AST.ConditionalExpr
      expect(expr.kind).toBe('ConditionalExpr')
      expect(expr.elseExpr.kind).toBe('ConditionalExpr')
    })
  })

  describe('pruned control-flow statements (#1072)', () => {
    // if/else, for..in, and return only ever made sense inside `fn`
    // bodies; with `fn` deleted they are top-level parse errors, and
    // their words are ordinary identifiers.
    it('a top-level if/else block is a parse error', () => {
      expect(() =>
        parse(`
        if x > 10 { return 1.0 }
        else { return 0.0 }
      `),
      ).toThrow(/\[Parser\]/)
    })

    it('a top-level for loop is a parse error', () => {
      expect(() =>
        parse(`
        for i in 0..10 {
          i * 2
        }
      `),
      ).toThrow(/\[Parser\]/)
    })
  })

  describe('match block in expression position', () => {
    // The match-block form `match(x) { k -> v, _ -> d }` was originally
    // only consumed inside utility-item position (fill/stroke/opacity).
    // It now works in any expression context, including filter:.
    it('parses match() block as a layer filter value', () => {
      const ast = parse(
        'layer r {\n  filter: match(.kind) { "highway" -> true, "rail" -> true, _ -> false }\n}',
      )
      const layer = ast.body[0] as AST.LayerStatement
      const filter = layer.properties.find((p) => p.name === 'filter') as AST.BlockProperty
      const call = filter.value as AST.FnCall
      expect(call.kind).toBe('FnCall')
      expect((call.callee as AST.Identifier).name).toBe('match')
      expect(call.matchBlock).toBeDefined()
      expect(call.matchBlock?.arms).toHaveLength(3)
      expect(call.matchBlock?.arms[0].pattern).toBe('highway')
      expect((call.matchBlock?.arms[0].value as AST.BoolLiteral).value).toBe(true)
      expect(call.matchBlock?.arms[2].pattern).toBe('_')
    })

    it('accepts numeric and string arm values (not just utility names)', () => {
      const ast = parse(
        'layer r {\n  filter: match(.zoom) { "low" -> 1, "high" -> 100, _ -> 0 }\n}',
      )
      const layer = ast.body[0] as AST.LayerStatement
      const filter = layer.properties.find((p) => p.name === 'filter') as AST.BlockProperty
      const arms = (filter.value as AST.FnCall).matchBlock?.arms ?? []
      expect((arms[0].value as AST.NumberLiteral).value).toBe(1)
      expect((arms[1].value as AST.NumberLiteral).value).toBe(100)
    })
  })

  describe('array literal', () => {
    it('parses empty array', () => {
      const expr = parseExpressionString('[]') as AST.ArrayLiteral
      expect(expr.kind).toBe('ArrayLiteral')
      expect(expr.elements).toHaveLength(0)
    })

    it('parses array with elements', () => {
      const expr = parseExpressionString('[1, 2, 3]') as AST.ArrayLiteral
      expect(expr.kind).toBe('ArrayLiteral')
      expect(expr.elements).toHaveLength(3)
    })

    it('parses nested array', () => {
      const expr = parseExpressionString('[[1, 2], [3, 4]]') as AST.ArrayLiteral
      expect(expr.elements).toHaveLength(2)
      expect((expr.elements[0] as AST.ArrayLiteral).kind).toBe('ArrayLiteral')
    })
  })
})
