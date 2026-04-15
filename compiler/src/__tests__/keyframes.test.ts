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

describe('Keyframes parser', () => {
  it('parses a basic keyframes block with percentage stops', () => {
    const source = `
      keyframes pulse {
        0%:   opacity-100
        50%:  opacity-30
        100%: opacity-100
      }
      source data { type: geojson, url: "x.geojson" }
      layer solo { source: data | fill-red-500 }
    `
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()
    const kf = ast.body.find(s => s.kind === 'KeyframesStatement')
    expect(kf).toBeDefined()
    if (kf?.kind !== 'KeyframesStatement') throw new Error('unreachable')
    expect(kf.name).toBe('pulse')
    expect(kf.frames).toHaveLength(3)
    expect(kf.frames.map(f => f.percent)).toEqual([0, 50, 100])
    expect(kf.frames[1].utilities[0].name).toBe('opacity-30')
  })

  it('accepts from: / to: aliases for 0%/100%', () => {
    const source = `
      keyframes march {
        from: opacity-100
        to:   opacity-20
      }
      source data { type: geojson, url: "x.geojson" }
      layer solo { source: data | fill-red-500 }
    `
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()
    const kf = ast.body.find(s => s.kind === 'KeyframesStatement')
    if (kf?.kind !== 'KeyframesStatement') throw new Error('unreachable')
    expect(kf.frames.map(f => f.percent)).toEqual([0, 100])
  })

  it('sorts frames by percent after parsing', () => {
    const source = `
      keyframes out_of_order {
        100%: opacity-100
        50%:  opacity-30
        0%:   opacity-80
      }
      source data { type: geojson, url: "x.geojson" }
      layer solo { source: data | fill-red-500 }
    `
    const tokens = new Lexer(source).tokenize()
    const ast = new Parser(tokens).parse()
    const kf = ast.body.find(s => s.kind === 'KeyframesStatement')
    if (kf?.kind !== 'KeyframesStatement') throw new Error('unreachable')
    expect(kf.frames.map(f => f.percent)).toEqual([0, 50, 100])
  })
})

describe('Keyframes lowering', () => {
  it('expands animation-pulse into time-interpolated opacity stops', () => {
    const scene = compile(`
      keyframes pulse {
        0%:   opacity-100
        50%:  opacity-30
        100%: opacity-100
      }
      source data { type: geojson, url: "x.geojson" }
      layer pulsing {
        source: data
        | stroke-red-500 stroke-2
        | animation-pulse animation-duration-1500 animation-ease-in-out animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('time-interpolated')
    if (node.opacity.kind !== 'time-interpolated') throw new Error('wrong kind')
    expect(node.opacity.stops).toEqual([
      { timeMs: 0, value: 1.0 },
      { timeMs: 750, value: 0.3 },
      { timeMs: 1500, value: 1.0 },
    ])
    expect(node.opacity.loop).toBe(true)
    expect(node.opacity.easing).toBe('ease-in-out')
    expect(node.opacity.delayMs).toBe(0)
  })

  it('defaults duration to 1000ms and easing to linear and loop to false', () => {
    const scene = compile(`
      keyframes fade {
        0%:   opacity-100
        100%: opacity-0
      }
      source data { type: geojson, url: "x.geojson" }
      layer fading {
        source: data
        | fill-blue-500
        | animation-fade
      }
    `)
    const node = scene.renderNodes[0]
    if (node.opacity.kind !== 'time-interpolated') throw new Error('wrong kind')
    expect(node.opacity.stops).toEqual([
      { timeMs: 0, value: 1.0 },
      { timeMs: 1000, value: 0.0 },
    ])
    expect(node.opacity.loop).toBe(false)
    expect(node.opacity.easing).toBe('linear')
  })

  it('forward reference: animation declared AFTER the layer that uses it', () => {
    const scene = compile(`
      source data { type: geojson, url: "x.geojson" }
      layer early {
        source: data
        | fill-blue-500
        | animation-later animation-duration-500
      }
      keyframes later {
        0%:   opacity-100
        100%: opacity-20
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('time-interpolated')
  })

  it('upgrades to zoom-time hybrid when both z-modifier and animation apply', () => {
    const scene = compile(`
      keyframes pulse {
        0%:   opacity-100
        50%:  opacity-30
        100%: opacity-100
      }
      source data { type: geojson, url: "x.geojson" }
      layer both {
        source: data
        | fill-emerald-500
        | z6:opacity-40 z14:opacity-100
        | animation-pulse animation-duration-2000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('zoom-time')
    if (node.opacity.kind !== 'zoom-time') throw new Error('wrong kind')
    expect(node.opacity.zoomStops).toEqual([
      { zoom: 6, value: 0.4 },
      { zoom: 14, value: 1.0 },
    ])
    expect(node.opacity.timeStops).toHaveLength(3)
    expect(node.opacity.timeStops[1].timeMs).toBe(1000)
    expect(node.opacity.loop).toBe(true)
  })

  it('throws on unknown animation reference', () => {
    expect(() => compile(`
      source data { type: geojson, url: "x.geojson" }
      layer broken {
        source: data
        | fill-red-500
        | animation-nonexistent animation-duration-500
      }
    `)).toThrow(/Unknown keyframes reference/)
  })

  it('emits ShowCommand.timeOpacityStops / Loop / Easing / DelayMs', () => {
    const scene = compile(`
      keyframes pulse {
        0%:   opacity-100
        100%: opacity-10
      }
      source data { type: geojson, url: "x.geojson" }
      layer pulsing {
        source: data
        | fill-red-500
        | animation-pulse animation-duration-800 animation-ease-out animation-delay-200 animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    expect(show.timeOpacityStops).toEqual([
      { timeMs: 0, value: 1.0 },
      { timeMs: 800, value: 0.1 },
    ])
    expect(show.timeOpacityLoop).toBe(true)
    expect(show.timeOpacityEasing).toBe('ease-out')
    expect(show.timeOpacityDelayMs).toBe(200)
  })
})
