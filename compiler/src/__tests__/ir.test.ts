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

describe('IR Modifiers', () => {
  it('lowers zoom modifier to zoom-interpolated opacity', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | z8:opacity-40 z16:opacity-100
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('zoom-interpolated')
    if (node.opacity.kind === 'zoom-interpolated') {
      expect(node.opacity.stops).toHaveLength(2)
      expect(node.opacity.stops[0]).toEqual({ zoom: 8, value: 0.4 })
      expect(node.opacity.stops[1]).toEqual({ zoom: 16, value: 1.0 })
    }
  })

  it('lowers zoom modifier to zoom-interpolated size', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | z8:size-4 z14:size-12
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.size.kind).toBe('zoom-interpolated')
    if (node.size.kind === 'zoom-interpolated') {
      expect(node.size.stops).toEqual([
        { zoom: 8, value: 4 },
        { zoom: 14, value: 12 },
      ])
    }
  })

  it('lowers data modifier to conditional fill', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | friendly:fill-green-500 hostile:fill-red-500 fill-gray-400
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.fill.kind).toBe('conditional')
    if (node.fill.kind === 'conditional') {
      expect(node.fill.branches).toHaveLength(2)
      expect(node.fill.branches[0].field).toBe('friendly')
      expect(node.fill.branches[0].value.kind).toBe('constant')
      expect(node.fill.branches[1].field).toBe('hostile')
      // Fallback is the unmodified fill-gray-400
      expect(node.fill.fallback.kind).toBe('constant')
    }
  })

  it('sorts zoom stops by zoom level', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | z16:opacity-100 z8:opacity-40 z12:opacity-70
      }
    `)
    const node = scene.renderNodes[0]
    if (node.opacity.kind === 'zoom-interpolated') {
      expect(node.opacity.stops[0].zoom).toBe(8)
      expect(node.opacity.stops[1].zoom).toBe(12)
      expect(node.opacity.stops[2].zoom).toBe(16)
    }
  })
})

describe('IR Presets', () => {
  it('expands apply-presetName', () => {
    const scene = compile(`
      preset alert {
        | fill-red-500 stroke-black stroke-2
      }

      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | apply-alert opacity-80
      }
    `)
    const node = scene.renderNodes[0]
    // Preset fill-red-500 should be applied
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      expect(node.fill.rgba[0]).toBeCloseTo(0.937, 2) // red-500
    }
    // Stroke from preset
    expect(node.stroke.width).toBe(2)
    // opacity-80 from layer overrides
    expect(node.opacity).toEqual({ kind: 'constant', value: 0.8 })
  })

  it('layer utilities override preset values', () => {
    const scene = compile(`
      preset base {
        | fill-blue-500 stroke-1
      }

      source data { type: geojson, url: "x.geojson" }
      layer tracks {
        source: data
        | apply-base fill-green-500
      }
    `)
    const node = scene.renderNodes[0]
    // fill-green-500 should override preset's fill-blue-500
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      expect(node.fill.rgba[1]).toBeGreaterThan(0.7) // green dominant
    }
  })
})

describe('IR Styles (CSS-like)', () => {
  it('lowers inline CSS-like properties to RenderNode', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer countries {
        source: world
        fill: sky-700
        stroke: slate-400
        stroke-width: 2
        opacity: 0.8
      }
    `)
    expect(scene.renderNodes).toHaveLength(1)
    const node = scene.renderNodes[0]
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      // sky-700 = #0369a1
      expect(node.fill.rgba[0]).toBeCloseTo(0.012, 2)
      expect(node.fill.rgba[1]).toBeCloseTo(0.412, 2)
      expect(node.fill.rgba[2]).toBeCloseTo(0.631, 2)
    }
    expect(node.stroke.color.kind).toBe('constant')
    expect(node.stroke.width).toBe(2)
    expect(node.opacity).toEqual({ kind: 'constant', value: 0.8 })
  })

  it('lowers named style referenced by layer', () => {
    const scene = compile(`
      style dark_land {
        fill: stone-800
        stroke: slate-600
        stroke-width: 1
      }

      source world { type: geojson, url: "countries.geojson" }
      layer land {
        source: world
        style: dark_land
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      // stone-800 = #292524
      expect(node.fill.rgba[0]).toBeCloseTo(0.161, 2)
      expect(node.fill.rgba[1]).toBeCloseTo(0.145, 2)
      expect(node.fill.rgba[2]).toBeCloseTo(0.141, 2)
    }
    expect(node.stroke.color.kind).toBe('constant')
    expect(node.stroke.width).toBe(1)
  })

  it('inline CSS overrides named style', () => {
    const scene = compile(`
      style base {
        fill: blue-500
        stroke: white
        stroke-width: 1
      }

      source world { type: geojson, url: "countries.geojson" }
      layer land {
        source: world
        style: base
        fill: red-500
      }
    `)
    const node = scene.renderNodes[0]
    // fill should be red-500 (overrides base blue-500)
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      expect(node.fill.rgba[0]).toBeCloseTo(0.937, 2) // red-500
    }
    // stroke should still be from base style
    expect(node.stroke.color.kind).toBe('constant')
    expect(node.stroke.width).toBe(1)
  })

  it('utilities override both named style and inline CSS', () => {
    const scene = compile(`
      style base {
        fill: blue-500
        opacity: 0.5
      }

      source world { type: geojson, url: "countries.geojson" }
      layer land {
        source: world
        style: base
        fill: red-500
        | fill-green-500 opacity-80
      }
    `)
    const node = scene.renderNodes[0]
    // fill should be green-500 (utility overrides inline CSS and named style)
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      expect(node.fill.rgba[1]).toBeGreaterThan(0.7) // green dominant
    }
    // opacity should be from utility (0.8), not base (0.5)
    expect(node.opacity).toEqual({ kind: 'constant', value: 0.8 })
  })

  it('supports hex color values in style properties', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer land {
        source: world
        fill: #ff0000
        stroke: #00ff00
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.fill.kind).toBe('constant')
    if (node.fill.kind === 'constant') {
      expect(node.fill.rgba[0]).toBeCloseTo(1.0)
      expect(node.fill.rgba[1]).toBeCloseTo(0.0)
      expect(node.fill.rgba[2]).toBeCloseTo(0.0)
    }
    expect(node.stroke.color.kind).toBe('constant')
    if (node.stroke.color.kind === 'constant') {
      expect(node.stroke.color.rgba[1]).toBeCloseTo(1.0)
    }
  })
})

describe('IR Filter', () => {
  it('preserves filter expression in RenderNode', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer big_countries {
        source: world
        filter: .pop > 1000000
        fill: red-500
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.filter).not.toBeNull()
    expect(node.filter!.ast.kind).toBe('BinaryExpr')
  })

  it('has null filter when not specified', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer countries {
        source: world
        fill: blue-500
      }
    `)
    expect(scene.renderNodes[0].filter).toBeNull()
  })

  it('passes filter through to emitted ShowCommand', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer big {
        source: world
        filter: .pop > 500000
        fill: red-500
      }
    `)
    const commands = emitCommands(scene)
    expect(commands.shows[0].filterExpr).not.toBeNull()
    expect(commands.shows[0].filterExpr!.ast.kind).toBe('BinaryExpr')
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

describe('IR Lower — extrude keyword', () => {
  it('defaults to extrude { kind: none } when keyword absent', () => {
    const scene = compile(`
      source world { type: geojson, url: "countries.geojson" }
      layer countries {
        source: world
        | fill-red-500
      }
    `)
    expect(scene.renderNodes[0].extrude).toEqual({ kind: 'none' })
  })

  it('lowers `extrude: 50` to constant', () => {
    const scene = compile(`
      source pm { type: pmtiles, url: "/world.pmtiles" }
      layer buildings {
        source: pm
        sourceLayer: "buildings"
        extrude: 50
        | fill-stone-300
      }
    `)
    expect(scene.renderNodes[0].extrude).toEqual({ kind: 'constant', value: 50 })
  })

  it('lowers `extrude: .height` to feature lookup with default fallback', () => {
    const scene = compile(`
      source pm { type: pmtiles, url: "/world.pmtiles" }
      layer buildings {
        source: pm
        sourceLayer: "buildings"
        extrude: .render_height
        | fill-stone-300
      }
    `)
    expect(scene.renderNodes[0].extrude).toEqual({
      kind: 'feature', field: 'render_height', fallback: 50,
    })
  })

  it('emit-commands forwards extrude onto the ShowCommand', () => {
    const scene = compile(`
      source pm { type: pmtiles, url: "/world.pmtiles" }
      layer b { source: pm, sourceLayer: "buildings", extrude: 30, | fill-red }
    `)
    const cmds = emitCommands(scene)
    expect(cmds.shows[0].extrude).toEqual({ kind: 'constant', value: 30 })
  })
})
