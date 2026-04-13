import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import type * as AST from '../parser/ast'

function parse(source: string): AST.Program {
  const tokens = new Lexer(source).tokenize()
  return new Parser(tokens).parse()
}

describe('Parser', () => {
  describe('let statement', () => {
    it('parses simple let with function call', () => {
      const ast = parse('let world = load("countries.geojson")')
      expect(ast.body).toHaveLength(1)

      const stmt = ast.body[0] as AST.LetStatement
      expect(stmt.kind).toBe('LetStatement')
      expect(stmt.name).toBe('world')

      const call = stmt.value as AST.FnCall
      expect(call.kind).toBe('FnCall')
      expect((call.callee as AST.Identifier).name).toBe('load')
      expect(call.args).toHaveLength(1)
      expect((call.args[0] as AST.StringLiteral).value).toBe('countries.geojson')
    })

    it('parses let with arithmetic', () => {
      const ast = parse('let x = a + b * 2')
      const stmt = ast.body[0] as AST.LetStatement
      const expr = stmt.value as AST.BinaryExpr
      expect(expr.op).toBe('+')
      // b * 2 should be grouped first (higher precedence)
      expect((expr.right as AST.BinaryExpr).op).toBe('*')
    })
  })

  describe('show statement', () => {
    it('parses show with block', () => {
      const ast = parse(`
        show world {
          fill: #f2efe9
          stroke: #ccc, 1px
        }
      `)
      expect(ast.body).toHaveLength(1)

      const stmt = ast.body[0] as AST.ShowStatement
      expect(stmt.kind).toBe('ShowStatement')
      expect((stmt.target as AST.Identifier).name).toBe('world')
      expect(stmt.block.properties).toHaveLength(2)

      // fill: #f2efe9
      const fill = stmt.block.properties[0]
      expect(fill.name).toBe('fill')
      expect(fill.values).toHaveLength(1)
      expect((fill.values[0] as AST.ColorLiteral).value).toBe('#f2efe9')

      // stroke: #ccc, 1px
      const stroke = stmt.block.properties[1]
      expect(stroke.name).toBe('stroke')
      expect(stroke.values).toHaveLength(2)
      expect((stroke.values[0] as AST.ColorLiteral).value).toBe('#ccc')
      expect((stroke.values[1] as AST.NumberLiteral).value).toBe(1)
      expect((stroke.values[1] as AST.NumberLiteral).unit).toBe('px')
    })
  })

  describe('hello map program', () => {
    it('parses the first X-GIS program', () => {
      const ast = parse(`
        let world = load("countries.geojson")

        show world {
          fill: #f2efe9
          stroke: #ccc, 1px
        }
      `)

      expect(ast.body).toHaveLength(2)
      expect(ast.body[0].kind).toBe('LetStatement')
      expect(ast.body[1].kind).toBe('ShowStatement')
    })
  })

  describe('expressions', () => {
    it('parses field access (.field)', () => {
      const ast = parse('let x = .speed')
      const stmt = ast.body[0] as AST.LetStatement
      const field = stmt.value as AST.FieldAccess
      expect(field.kind).toBe('FieldAccess')
      expect(field.object).toBeNull() // implicit
      expect(field.field).toBe('speed')
    })

    it('parses chained field access (a.b.c)', () => {
      const ast = parse('let x = ship.position.lat')
      const stmt = ast.body[0] as AST.LetStatement
      const outer = stmt.value as AST.FieldAccess
      expect(outer.field).toBe('lat')
      const inner = outer.object as AST.FieldAccess
      expect(inner.field).toBe('position')
      expect((inner.object as AST.Identifier).name).toBe('ship')
    })

    it('parses pipe expressions', () => {
      const ast = parse('let x = .speed | clamp(4, 24)')
      const stmt = ast.body[0] as AST.LetStatement
      const pipe = stmt.value as AST.PipeExpr
      expect(pipe.kind).toBe('PipeExpr')

      const input = pipe.input as AST.FieldAccess
      expect(input.field).toBe('speed')

      expect(pipe.transforms).toHaveLength(1)
      expect((pipe.transforms[0].callee as AST.Identifier).name).toBe('clamp')
      expect(pipe.transforms[0].args).toHaveLength(2)
    })

    it('parses number with unit', () => {
      const ast = parse('let r = 5km')
      const stmt = ast.body[0] as AST.LetStatement
      const num = stmt.value as AST.NumberLiteral
      expect(num.value).toBe(5)
      expect(num.unit).toBe('km')
    })

    it('parses comparison expressions', () => {
      const ast = parse('let x = zoom >= 10')
      const stmt = ast.body[0] as AST.LetStatement
      const cmp = stmt.value as AST.BinaryExpr
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

  describe('style statement', () => {
    it('parses named style block', () => {
      const ast = parse(`
        style dark_land {
          fill: stone-800
          stroke: slate-600
          stroke-width: 1
          opacity: 0.8
        }
      `)
      expect(ast.body).toHaveLength(1)

      const stmt = ast.body[0] as AST.StyleStatement
      expect(stmt.kind).toBe('StyleStatement')
      expect(stmt.name).toBe('dark_land')
      expect(stmt.properties).toHaveLength(4)

      expect(stmt.properties[0]).toMatchObject({ name: 'fill', value: 'stone-800' })
      expect(stmt.properties[1]).toMatchObject({ name: 'stroke', value: 'slate-600' })
      expect(stmt.properties[2]).toMatchObject({ name: 'stroke-width', value: '1' })
      expect(stmt.properties[3]).toMatchObject({ name: 'opacity', value: '0.8' })
    })

    it('parses style with hex colors', () => {
      const ast = parse(`
        style custom {
          fill: #ff0000
          stroke: #ccc
        }
      `)
      const stmt = ast.body[0] as AST.StyleStatement
      expect(stmt.properties[0]).toMatchObject({ name: 'fill', value: '#ff0000' })
      expect(stmt.properties[1]).toMatchObject({ name: 'stroke', value: '#ccc' })
    })

    it('parses style with comma-separated properties', () => {
      const ast = parse(`style s { fill: red-500, stroke: white, stroke-width: 2 }`)
      const stmt = ast.body[0] as AST.StyleStatement
      expect(stmt.properties).toHaveLength(3)
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
      const filterProp = stmt.properties.find(p => p.name === 'filter')!
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
      const filterProp = stmt.properties.find(p => p.name === 'filter')!
      expect(filterProp.value.kind).toBe('BinaryExpr')
      const and = filterProp.value as AST.BinaryExpr
      expect(and.op).toBe('&&')
    })
  })

  describe('show with data binding', () => {
    it('parses show with field access and expressions', () => {
      const ast = parse(`
        show ais {
          shape: arrow
          color: .type
          size: .speed / 50 | clamp(4, 24)
          rotate: .heading
        }
      `)

      const stmt = ast.body[0] as AST.ShowStatement
      expect(stmt.block.properties).toHaveLength(4)

      // shape: arrow
      expect(stmt.block.properties[0].name).toBe('shape')
      expect((stmt.block.properties[0].values[0] as AST.Identifier).name).toBe('arrow')

      // size: .speed / 50 | clamp(4, 24) — pipe expression
      const sizeExpr = stmt.block.properties[2].values[0]
      expect(sizeExpr.kind).toBe('PipeExpr')
    })
  })

  describe('ternary conditional', () => {
    it('parses expr ? expr : expr', () => {
      const ast = parse('let x = a > 5 ? 1 : 0')
      const expr = (ast.body[0] as AST.LetStatement).value
      expect(expr.kind).toBe('ConditionalExpr')
      const cond = expr as AST.ConditionalExpr
      expect(cond.condition.kind).toBe('BinaryExpr')
      expect(cond.thenExpr.kind).toBe('NumberLiteral')
      expect(cond.elseExpr.kind).toBe('NumberLiteral')
    })

    it('parses nested ternary', () => {
      const ast = parse('let x = a > 10 ? 2 : a > 5 ? 1 : 0')
      const expr = (ast.body[0] as AST.LetStatement).value as AST.ConditionalExpr
      expect(expr.kind).toBe('ConditionalExpr')
      expect(expr.elseExpr.kind).toBe('ConditionalExpr')
    })
  })

  describe('if/else statement', () => {
    it('parses if/else in function', () => {
      const ast = parse(`
        fn classify(x: f32) -> f32 {
          if x > 10 { return 1.0 }
          else { return 0.0 }
        }
      `)
      const fn = ast.body[0] as AST.FnStatement
      expect(fn.body).toHaveLength(1)
      const ifStmt = fn.body[0] as AST.IfStatement
      expect(ifStmt.kind).toBe('IfStatement')
      expect(ifStmt.thenBranch).toHaveLength(1)
      expect(ifStmt.elseBranch).toHaveLength(1)
      expect((ifStmt.thenBranch[0] as AST.ReturnStatement).kind).toBe('ReturnStatement')
    })

    it('parses else if chain', () => {
      const ast = parse(`
        fn grade(x: f32) -> string {
          if x > 90 { return "A" }
          else if x > 80 { return "B" }
          else { return "C" }
        }
      `)
      const fn = ast.body[0] as AST.FnStatement
      const ifStmt = fn.body[0] as AST.IfStatement
      expect(ifStmt.elseBranch).toHaveLength(1)
      expect((ifStmt.elseBranch![0] as AST.IfStatement).kind).toBe('IfStatement')
    })
  })

  describe('for loop', () => {
    it('parses for..in range', () => {
      const ast = parse(`
        fn make(n: f32) -> array {
          for i in 0..10 {
            let x = i * 2
          }
        }
      `)
      const fn = ast.body[0] as AST.FnStatement
      const forStmt = fn.body[0] as AST.ForStatement
      expect(forStmt.kind).toBe('ForStatement')
      expect(forStmt.variable).toBe('i')
      expect((forStmt.start as AST.NumberLiteral).value).toBe(0)
      expect((forStmt.end as AST.NumberLiteral).value).toBe(10)
      expect(forStmt.body).toHaveLength(1)
    })
  })

  describe('array literal', () => {
    it('parses empty array', () => {
      const ast = parse('let x = []')
      const expr = (ast.body[0] as AST.LetStatement).value as AST.ArrayLiteral
      expect(expr.kind).toBe('ArrayLiteral')
      expect(expr.elements).toHaveLength(0)
    })

    it('parses array with elements', () => {
      const ast = parse('let x = [1, 2, 3]')
      const expr = (ast.body[0] as AST.LetStatement).value as AST.ArrayLiteral
      expect(expr.kind).toBe('ArrayLiteral')
      expect(expr.elements).toHaveLength(3)
    })

    it('parses nested array', () => {
      const ast = parse('let x = [[1, 2], [3, 4]]')
      const expr = (ast.body[0] as AST.LetStatement).value as AST.ArrayLiteral
      expect(expr.elements).toHaveLength(2)
      expect((expr.elements[0] as AST.ArrayLiteral).kind).toBe('ArrayLiteral')
    })
  })
})
