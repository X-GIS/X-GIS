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
        | opacity-[interpolate(zoom, 6, 40, 14, 100)]
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

  it('emits paintShapes.opacity time-interpolated + animationMeta Loop / Easing / DelayMs', () => {
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
    expect(show.paintShapes.opacity).toMatchObject({
      kind: 'time-interpolated',
      loop: true,
      easing: 'ease-out',
      delayMs: 200,
    })
    expect((show.paintShapes.opacity as { stops: { timeMs: number; value: number }[] }).stops).toEqual([
      { timeMs: 0, value: 1.0 },
      { timeMs: 800, value: 0.1 },
    ])
  })
})

describe('Keyframes — multi-property (PR 3)', () => {
  it('expands fill keyframes into time-interpolated ColorValue', () => {
    const scene = compile(`
      keyframes heat {
        0%:   fill-blue-500
        100%: fill-red-500
      }
      source data { type: geojson, url: "x.geojson" }
      layer hot {
        source: data
        | fill-blue-500
        | animation-heat animation-duration-2000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.fill.kind).toBe('time-interpolated')
    if (node.fill.kind !== 'time-interpolated') throw new Error('wrong kind')
    expect(node.fill.stops).toHaveLength(2)
    expect(node.fill.stops[0].timeMs).toBe(0)
    expect(node.fill.stops[1].timeMs).toBe(2000)
    // blue-500 = #3b82f6 → approx [0.231, 0.51, 0.965, 1]
    expect(node.fill.stops[0].value[2]).toBeGreaterThan(0.9)
    // red-500 = #ef4444 → approx [0.937, 0.267, 0.267, 1]
    expect(node.fill.stops[1].value[0]).toBeGreaterThan(0.9)
    expect(node.fill.loop).toBe(true)
  })

  it('expands stroke-<number> keyframes into timeWidthStops on StrokeValue', () => {
    const scene = compile(`
      keyframes grow {
        0%:   stroke-2
        100%: stroke-8
      }
      source data { type: geojson, url: "x.geojson" }
      layer growing {
        source: data
        | stroke-red-500 stroke-2
        | animation-grow animation-duration-1000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.stroke.timeWidthStops).toBeDefined()
    expect(node.stroke.timeWidthStops).toEqual([
      { timeMs: 0, value: 2 },
      { timeMs: 1000, value: 8 },
    ])
  })

  it('expands stroke-<colorname> keyframes into time-interpolated stroke color', () => {
    const scene = compile(`
      keyframes fire {
        0%:   stroke-amber-300
        100%: stroke-red-500
      }
      source data { type: geojson, url: "x.geojson" }
      layer blaze {
        source: data
        | stroke-amber-300 stroke-2
        | animation-fire animation-duration-1200 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.stroke.color.kind).toBe('time-interpolated')
    if (node.stroke.color.kind !== 'time-interpolated') throw new Error('wrong kind')
    expect(node.stroke.color.stops).toHaveLength(2)
  })

  it('expands stroke-dashoffset keyframes into timeDashOffsetStops', () => {
    const scene = compile(`
      keyframes march {
        from: stroke-dashoffset-0
        to:   stroke-dashoffset-60
      }
      source data { type: geojson, url: "x.geojson" }
      layer marching {
        source: data
        | stroke-amber-300 stroke-2 stroke-dasharray-16-8
        | animation-march animation-duration-1200 animation-ease-linear animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.stroke.timeDashOffsetStops).toEqual([
      { timeMs: 0, value: 0 },
      { timeMs: 1200, value: 60 },
    ])
  })

  it('expands size keyframes into time-interpolated SizeValue for points', () => {
    const scene = compile(`
      keyframes ping {
        0%:   size-8
        50%:  size-20
        100%: size-8
      }
      source data { type: geojson, url: "x.geojson" }
      layer pings {
        source: data
        | fill-red-500 size-8
        | animation-ping animation-duration-1500 animation-ease-in-out animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.size.kind).toBe('time-interpolated')
    if (node.size.kind !== 'time-interpolated') throw new Error('wrong kind')
    expect(node.size.stops).toEqual([
      { timeMs: 0, value: 8 },
      { timeMs: 750, value: 20 },
      { timeMs: 1500, value: 8 },
    ])
  })

  it('cross-property keyframes expand into parallel stop lists', () => {
    const scene = compile(`
      keyframes combo {
        0%:   opacity-100 fill-blue-500 stroke-2
        100%: opacity-40  fill-red-500  stroke-8
      }
      source data { type: geojson, url: "x.geojson" }
      layer combined {
        source: data
        | fill-blue-500 stroke-blue-500 stroke-2
        | animation-combo animation-duration-2000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    expect(node.opacity.kind).toBe('time-interpolated')
    expect(node.fill.kind).toBe('time-interpolated')
    expect(node.stroke.timeWidthStops).toBeDefined()
    expect(node.stroke.timeWidthStops).toHaveLength(2)
  })

  it('emits paintShapes.{fill,stroke,strokeWidth,size} time-interpolated + dashOffset stops', () => {
    const scene = compile(`
      keyframes combo {
        0%:   fill-blue-500 stroke-amber-300 stroke-2 stroke-dashoffset-0  size-10
        100%: fill-red-500  stroke-red-500   stroke-6 stroke-dashoffset-40 size-20
      }
      source data { type: geojson, url: "x.geojson" }
      layer combo {
        source: data
        | fill-blue-500 stroke-amber-300 stroke-2 size-10 stroke-dasharray-16-8
        | animation-combo animation-duration-1500 animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    const ps = show.paintShapes
    expect((ps.fill as { stops: unknown[] }).stops).toHaveLength(2)
    expect((ps.stroke as { stops: unknown[] }).stops).toHaveLength(2)
    expect((ps.strokeWidth as { stops: { timeMs: number; value: number }[] }).stops).toEqual([
      { timeMs: 0, value: 2 },
      { timeMs: 1500, value: 6 },
    ])
    // Dash offset is structural — its own PropertyShape outside paintShapes
    expect(show.dashOffsetShape?.kind).toBe('time-interpolated')
    expect((show.dashOffsetShape as { stops: unknown[] }).stops).toEqual([
      { timeMs: 0, value: 0 },
      { timeMs: 1500, value: 40 },
    ])
    expect((ps.size as { stops: { timeMs: number; value: number }[] }).stops).toEqual([
      { timeMs: 0, value: 10 },
      { timeMs: 1500, value: 20 },
    ])
  })

  it('color-only animation inherits loop=true from the fill IR (regression)', () => {
    // Regression: previously emit-commands read loop / easing / delayMs
    // ONLY from the opacity union. A layer that animated fill but kept
    // opacity constant got loop=false silently → ran one cycle then
    // froze at the last stop. Fix: emit lifecycle metadata from
    // whichever property actually has time stops.
    const scene = compile(`
      keyframes heat {
        0%:   fill-slate-700
        50%:  fill-rose-600
        100%: fill-slate-700
      }
      source d { type: geojson, url: "x.geojson" }
      layer hot {
        source: d
        | fill-slate-700
        | animation-heat animation-duration-2000 animation-ease-in-out animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    expect((show.paintShapes.fill as { stops: unknown[] }).stops).toHaveLength(3)
    expect((show.paintShapes.fill as { loop: boolean }).loop).toBe(true)
    expect((show.paintShapes.fill as { easing: string }).easing).toBe('ease-in-out')
  })

  it('stroke-width-only animation inherits loop=true from the stroke IR (regression)', () => {
    const scene = compile(`
      keyframes grow {
        0%:   stroke-2
        100%: stroke-8
      }
      source d { type: geojson, url: "x.geojson" }
      layer growing {
        source: d
        | stroke-red-500 stroke-2
        | animation-grow animation-duration-1000 animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    expect((show.paintShapes.strokeWidth as { stops: unknown[] }).stops).toHaveLength(2)
    expect((show.paintShapes.strokeWidth as { loop: boolean }).loop).toBe(true)
  })

  it('single-stop property does not promote to time-interpolated', () => {
    // Need ≥2 stops to interpolate; a single stop would just hold
    // forever and degenerates to a constant.
    const scene = compile(`
      keyframes half_only {
        50%: fill-red-500
      }
      source data { type: geojson, url: "x.geojson" }
      layer half {
        source: data
        | fill-blue-500
        | animation-half_only animation-duration-1000 animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    // Fill stays constant (blue-500) because only one stop — not enough
    // to interpolate.
    expect(node.fill.kind).toBe('constant')
  })
})

// ═══ Bug 1 structural regression — all-property cross combinations ═══
//
// Bug 1 (commit 1317263): emit-commands read animation lifecycle
// metadata (loop / easing / delayMs) from `node.opacity` only. Any
// layer that animated fill / stroke / width / size / dashOffset
// without ALSO animating opacity got `loop=false` silently, freezing
// the animation after one cycle.
//
// The fix moved metadata to a single layer-wide `node.animationMeta`
// field that emit-commands reads regardless of which property is
// animated. These tests pin that contract by exercising EVERY
// animatable property in a single keyframes block and asserting the
// emitted metadata is consistent across all of them.

describe('Keyframes — all-property metadata propagation (Bug 1 structural)', () => {
  it('one keyframes block driving all 6 properties: every emitted stop list shares the same lifecycle', () => {
    const scene = compile(`
      keyframes everything {
        0%:   opacity-100 fill-blue-500  stroke-amber-300 stroke-2 size-8  stroke-dashoffset-0
        50%:  opacity-30  fill-rose-600  stroke-sky-300   stroke-6 size-20 stroke-dashoffset-30
        100%: opacity-100 fill-blue-500  stroke-amber-300 stroke-2 size-8  stroke-dashoffset-0
      }
      source data { type: geojson, url: "x.geojson" }
      layer multi {
        source: data
        | fill-blue-500 stroke-amber-300 stroke-2 size-8 stroke-dasharray-16-8
        | animation-everything animation-duration-2500 animation-ease-in-out animation-delay-100 animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    const ps = show.paintShapes

    // Every property got its own time stop list:
    expect((ps.opacity as { stops: unknown[] }).stops).toHaveLength(3)
    expect((ps.fill as { stops: unknown[] }).stops).toHaveLength(3)
    expect((ps.stroke as { stops: unknown[] }).stops).toHaveLength(3)
    expect((ps.strokeWidth as { stops: unknown[] }).stops).toHaveLength(3)
    expect((ps.size as { stops: unknown[] }).stops).toHaveLength(3)
    // Dash offset is structural — its own PropertyShape outside paintShapes
    expect((show.dashOffsetShape as { stops: unknown[] }).stops).toHaveLength(3)

    // And the SHARED lifecycle metadata applies to every one of
    // them. Bug 1: only opacity got the right loop value. Every
    // animated paintShape carries the same loop/easing/delayMs.
    for (const shape of [ps.opacity, ps.fill, ps.stroke, ps.strokeWidth, ps.size]) {
      expect((shape as { loop: boolean }).loop).toBe(true)
      expect((shape as { easing: string }).easing).toBe('ease-in-out')
      expect((shape as { delayMs: number }).delayMs).toBe(100)
    }
  })

  it('Bug 1 mirror: drop opacity from the keyframes — the other 5 still inherit lifecycle', () => {
    // The exact bug shape: a keyframes block touches everything
    // EXCEPT opacity. Under the bug, emit-commands read metadata
    // from `node.opacity.kind === 'time-interpolated'` which was
    // false (opacity stayed constant), so loop fell through to
    // false silently. The fix reads from `node.animationMeta`
    // which is set whenever ANY property is animated.
    const scene = compile(`
      keyframes no_opacity {
        0%:   fill-blue-500  stroke-amber-300 stroke-2 size-8  stroke-dashoffset-0
        50%:  fill-rose-600  stroke-sky-300   stroke-6 size-20 stroke-dashoffset-30
        100%: fill-blue-500  stroke-amber-300 stroke-2 size-8  stroke-dashoffset-0
      }
      source data { type: geojson, url: "x.geojson" }
      layer multi {
        source: data
        | fill-blue-500 stroke-amber-300 stroke-2 size-8 stroke-dasharray-16-8
        | animation-no_opacity animation-duration-1500 animation-ease-out animation-infinite
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    const ps = show.paintShapes

    // Opacity stays constant (not animated):
    expect(ps.opacity.kind).toBe('constant')
    // But every OTHER property IS animated:
    expect(ps.fill?.kind).toBe('time-interpolated')
    expect(ps.stroke?.kind).toBe('time-interpolated')
    expect(ps.strokeWidth.kind).toBe('time-interpolated')
    expect(ps.size?.kind).toBe('time-interpolated')
    expect((show.dashOffsetShape as { stops: unknown[] }).stops).toHaveLength(3)

    // And — critically — every animated shape inherits the lifecycle
    // from animationMeta even though opacity isn't time-interp:
    for (const shape of [ps.fill!, ps.stroke!, ps.strokeWidth, ps.size!]) {
      expect((shape as { loop: boolean }).loop).toBe(true)
      expect((shape as { easing: string }).easing).toBe('ease-out')
      expect((shape as { delayMs: number }).delayMs).toBe(0)
    }
  })

  it('IR has node.animationMeta populated whenever any keyframes is referenced', () => {
    const scene = compile(`
      keyframes march {
        0%:   stroke-dashoffset-0
        100%: stroke-dashoffset-60
      }
      source data { type: geojson, url: "x.geojson" }
      layer marching {
        source: data
        | stroke-amber-300 stroke-2 stroke-dasharray-16-8
        | animation-march animation-duration-1200 animation-ease-linear animation-infinite
      }
    `)
    const node = scene.renderNodes[0]
    // The single source of truth — must be set even when only a
    // stroke property is animated. Without this, emit-commands has
    // no way to recover the lifecycle for non-color, non-opacity
    // properties whose IR shape doesn't carry per-property metadata.
    expect(node.animationMeta).toBeDefined()
    expect(node.animationMeta?.loop).toBe(true)
    expect(node.animationMeta?.easing).toBe('linear')
    expect(node.animationMeta?.delayMs).toBe(0)
  })

  it('non-loop animation: lifecycle propagates the false value to every property', () => {
    // Negative case: animations without `animation-infinite`
    // should propagate loop=false uniformly across all properties.
    // If a future refactor breaks the propagation in the other
    // direction (always loop=true), this test catches it.
    const scene = compile(`
      keyframes one_shot {
        0%:   fill-blue-500 size-8
        100%: fill-rose-600 size-20
      }
      source data { type: geojson, url: "x.geojson" }
      layer once {
        source: data
        | fill-blue-500 size-8
        | animation-one_shot animation-duration-800
      }
    `)
    const commands = emitCommands(scene)
    const show = commands.shows[0]
    expect((show.paintShapes.fill as { loop: boolean }).loop).toBe(false)
    expect((show.paintShapes.fill as { stops: unknown[] }).stops).toHaveLength(2)
    expect((show.paintShapes.size as { stops: unknown[] }).stops).toHaveLength(2)
  })
})
