import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { lower } from '../ir/lower'
import { emitCommands } from '../ir/emit-commands'

function compile(source: string) {
  const tokens = new Lexer(source).tokenize()
  const ast = new Parser(tokens).parse()
  return lower(ast)
}

describe('IR Lower', () => {
  describe('new syntax (source/layer)', () => {
    it('lowers source to SourceDef', () => {
      const scene = compile(`
        source world {
          type: geojson
          url: "countries.geojson"
        }
      `)
      expect(scene.sources).toHaveLength(1)
      expect(scene.sources[0].name).toBe('world')
      expect(scene.sources[0].type).toBe('geojson')
      expect(scene.sources[0].url).toBe('countries.geojson')
    })

    it('lowers layer with utilities to RenderNode', () => {
      const scene = compile(`
        source world {
          type: geojson
          url: "countries.geojson"
        }
        layer countries {
          source: world
          | fill-blue-400 stroke-white stroke-2 opacity-80
        }
      `)
      expect(scene.renderNodes).toHaveLength(1)
      const node = scene.renderNodes[0]
      expect(node.sourceRef).toBe('world')
      expect(node.fill.kind).toBe('constant')
      if (node.fill.kind === 'constant') {
        // blue-400 = #60a5fa
        expect(node.fill.rgba[0]).toBeCloseTo(0.376, 2)
        expect(node.fill.rgba[1]).toBeCloseTo(0.647, 2)
        expect(node.fill.rgba[2]).toBeCloseTo(0.98, 2)
      }
      expect(node.stroke.color.kind).toBe('constant')
      expect(node.stroke.width).toBe(2)
      expect(node.opacity).toEqual({ kind: 'constant', value: 0.8 })
    })
  })

  describe('legacy syntax (let/show)', () => {
    it('lowers let+show to same IR', () => {
      const scene = compile(`
        let world = load("countries.geojson")
        show world {
          fill: #ff0000
          stroke: #000000, 2px
          opacity: 0.5
        }
      `)
      expect(scene.sources).toHaveLength(1)
      expect(scene.sources[0].url).toBe('countries.geojson')

      expect(scene.renderNodes).toHaveLength(1)
      const node = scene.renderNodes[0]
      expect(node.fill.kind).toBe('constant')
      if (node.fill.kind === 'constant') {
        expect(node.fill.rgba[0]).toBeCloseTo(1.0)
        expect(node.fill.rgba[1]).toBeCloseTo(0.0)
        expect(node.fill.rgba[2]).toBeCloseTo(0.0)
      }
      expect(node.stroke.width).toBe(2)
      expect(node.opacity).toEqual({ kind: 'constant', value: 0.5 })
    })
  })
})

describe('IR EmitCommands', () => {
  it('converts IR to SceneCommands', () => {
    const scene = compile(`
      source world {
        type: geojson
        url: "countries.geojson"
      }
      layer countries {
        source: world
        | fill-red-500 stroke-black stroke-1 opacity-90
      }
    `)
    const commands = emitCommands(scene)
    expect(commands.loads).toHaveLength(1)
    expect(commands.loads[0].name).toBe('world')
    expect(commands.loads[0].url).toBe('countries.geojson')

    expect(commands.shows).toHaveLength(1)
    const show = commands.shows[0]
    expect(show.targetName).toBe('world')
    expect(show.fill).toBe('#ef4444')  // red-500
    expect(show.stroke).toBe('#000000') // black
    expect(show.strokeWidth).toBe(1)
    expect(show.opacity).toBe(0.9)
  })
})
