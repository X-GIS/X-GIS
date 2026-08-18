// #732 S5 — a data-driven POINT fill colour must surface as
// ShowCommand.fillColorExpr, the fill-axis mirror of strokeColorExpr
// (stroke-binding-routing.test.ts). Without it the GeoJSON point path in
// map.ts has no per-feature colour AST to evaluate and every point collapses
// to the layer-constant default arm — exactly the class of silent-default bug
// the stroke-colour routing test guards against.

import { describe, it, expect } from 'vitest'
import {
  convertMapboxStyle,
  Lexer,
  Parser,
  lower,
  emitCommands,
  evaluate,
  makeEvalProps,
} from '../index'
import type { Expr } from '../parser/ast'
import { callBuiltin } from '../eval/evaluator-helpers'
import { resolveColorFromAST } from '../codegen/shader-gen-helpers'
import { resolveColorTokenLiterals } from '../ir/lower-helpers'
import type { ShowCommand } from '../ir/emit-commands'

/** Compile an authored `.xgis` source and return its shows. */
function shows(src: string): ShowCommand[] {
  return emitCommands(lower(new Parser(new Lexer(src).tokenize()).parse())).shows
}

/** The fill AST a point/arrow layer hands the runtime's per-feature colour bake. */
function fillAst(src: string, layer: string): Expr {
  const show = shows(src).find((s) => s.layerName === layer)
  if (!show?.fillColorExpr) throw new Error(`no fillColorExpr on "${layer}"`)
  return show.fillColorExpr.ast as Expr
}

/** The stroke-axis mirror of {@link fillAst} — what the line worker's `color_packed`
 *  slot and the per-feature stroke bake evaluate. */
function strokeAst(src: string, layer: string): Expr {
  const show = shows(src).find((s) => s.layerName === layer)
  if (!show?.strokeColorExpr) throw new Error(`no strokeColorExpr on "${layer}"`)
  return show.strokeColorExpr.ast as Expr
}

/** What `map.ts` evalPerFeatureColor / `arrow-show.ts` get for one feature. */
function bake(ast: Expr, props: Record<string, unknown>): unknown {
  return evaluate(ast, makeEvalProps({ props }))
}

describe('#732 S5 — per-feature point fill colour AST', () => {
  it('circle-color match() lands on node.fill (data-driven) and ShowCommand.fillColorExpr', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'cities_by_class',
          type: 'circle',
          source: 'v',
          'source-layer': 'place',
          paint: {
            'circle-color': [
              'match',
              ['get', 'class'],
              'city',
              '#ff0000',
              'town',
              '#00ff00',
              '#888888',
            ],
            'circle-radius': 5,
          },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    expect(xgis, 'converter emits a data-driven fill utility for circle-color match').toMatch(
      /fill-\[/,
    )
    const scene = lower(new Parser(new Lexer(xgis).tokenize()).parse())
    const node = scene.renderNodes.find((n) => n.name === 'cities_by_class')
    expect(node, 'render node survives lower').toBeDefined()
    // The lowered ColorValue must carry the data-driven expr (not collapse to
    // a constant default arm), so emitFillFields can surface it.
    expect(node!.fill.kind, 'fill kind').toBe('data-driven')
    // And it must flow through emit-commands onto the ShowCommand.
    const cmds = emitCommands(scene)
    const show = cmds.shows.find((s) => s.layerName === 'cities_by_class')
    expect(show, 'ShowCommand must exist').toBeDefined()
    expect(
      show!.fillColorExpr,
      'ShowCommand.fillColorExpr (consumed by the GeoJSON point path)',
    ).toBeDefined()
  })

  it('constant circle-color ships NO fillColorExpr (constant path byte-identical)', () => {
    const style = {
      version: 8,
      sources: { v: { type: 'vector', url: 'x.pmtiles' } },
      layers: [
        {
          id: 'cities_const',
          type: 'circle',
          source: 'v',
          'source-layer': 'place',
          paint: { 'circle-color': '#ff0000', 'circle-radius': 5 },
        },
      ],
    }
    const xgis = convertMapboxStyle(style as never)
    const cmds = emitCommands(lower(new Parser(new Lexer(xgis).tokenize()).parse()))
    const show = cmds.shows.find((s) => s.layerName === 'cities_const')
    expect(show, 'ShowCommand must exist').toBeDefined()
    expect(show!.fillColorExpr, 'constant fill → no per-feature expr').toBeUndefined()
  })
})

// ═══ #1664 — the AST must EVALUATE, not merely exist ═══════════════════════════
//
// The two tests above proved `fillColorExpr` is PRESENT, and stayed green for the
// whole life of the bug they were meant to guard: `coops-currents`' authored
// `fill gradient(.speed, 0, 120, sky-300, rose-600)` surfaced a perfectly good AST
// that `evaluate()` then threw on, so `map.ts` evalPerFeatureColor and
// `arrow-show.ts` both caught, fell back to the layer constant — null, for a
// data-driven fill — and painted transparent dots / white arrows. Presence is not
// the contract; the resolved COLOUR is. Everything below evaluates.

/** `coops-currents`' own fill clause, the shape the render gate drives. */
const RAMP = 'fill gradient(.speed, 0, 120, sky-300, rose-600)'

const dotsStyle = (fill: string): string => `xgis 1
source stations { type: geojson }
layer station_dots {
  source: stations
  | ${fill} stroke-white stroke-1
}
`

describe('#1664 — a data-driven point fill BAKES a colour per feature', () => {
  it('an authored `gradient()` ramp resolves five features to five hexes', () => {
    const ast = fillAst(dotsStyle(RAMP), 'station_dots')
    // Hand-derived from the GPU form (see the parity test below); the two ENDPOINT
    // stops must come back byte-exact, which is what makes the ramp readable as
    // "sky at the low end, rose at the high end" rather than a wash.
    expect(bake(ast, { speed: 0 })).toBe('#7dd3fc')
    expect(bake(ast, { speed: 30 })).toBe('#96a6cf')
    expect(bake(ast, { speed: 60 })).toBe('#af78a2')
    expect(bake(ast, { speed: 90 })).toBe('#c84a75')
    expect(bake(ast, { speed: 120 })).toBe('#e11d48')
    // Five DISTINCT colours — the failure this replaces produced one (or none).
    const hexes = [0, 30, 60, 90, 120].map((speed) => bake(ast, { speed }))
    expect(new Set(hexes).size).toBe(5)
  })

  it('clamps outside its range instead of extrapolating past the endpoints', () => {
    const ast = fillAst(dotsStyle(RAMP), 'station_dots')
    // `clamp(t, 0, 1)` in the GPU form — a negative or over-range field must pin to
    // an endpoint, never run off the ramp into a colour neither stop names.
    expect(bake(ast, { speed: -500 })).toBe('#7dd3fc')
    expect(bake(ast, { speed: 1e6 })).toBe('#e11d48')
    // A feature MISSING the field reads as 0 (toNumber's null coercion) → low stop.
    expect(bake(ast, {})).toBe('#7dd3fc')
  })

  it('authored PALETTE TOKENS in match arms resolve — the second half of the bug', () => {
    // `sky-300` has no colour terminal in the grammar: it lexes as
    // `Identifier("sky") - NumberLiteral(300)`. Pre-#1664 the evaluator dutifully
    // did the arithmetic — `props.sky ?? null` minus 300 → -300 — and the caller's
    // `typeof r === 'string'` check dropped it, so a token-armed match() failed
    // EXACTLY like the gradient did while its hex-armed twin worked.
    const ast = fillAst(
      `xgis 1
source stations { type: geojson }
layer banded {
  source: stations
  | fill match(.band) { "a" -> sky-300, "b" -> "rose-600", "c" -> white, _ -> emerald-500 }
}
`,
      'banded',
    )
    expect(bake(ast, { band: 'a' })).toBe('#7dd3fc') // hyphen-token arm
    expect(bake(ast, { band: 'b' })).toBe('#e11d48') // quoted-token arm
    expect(bake(ast, { band: 'c' })).toBe('#ffffff') // bare CSS-name arm
    expect(bake(ast, { band: 'zz' })).toBe('#10b981') // the `_` default arm
  })

  it('a token spelling and its hex spelling compile to the SAME shader variant', () => {
    // Where the token resolution LANDS is the load-bearing part: at lower time, into
    // the AST both back-ends read, so neither owns a palette table. The witness is
    // the GPU variant — `sky-300` and `"#7dd3fc"` must be indistinguishable by the
    // time codegen sees them, INCLUDING the feature-buffer layout. Pre-#1664 they
    // were not: `collectFields` counted the `sky` / `rose` halves of the tokens as
    // FEATURE FIELDS, so the token ramp compiled a 3-wide feat_data stride
    // (`ff:rose,sky,speed`) for a ramp that reads one field.
    const token = shows(dotsStyle(RAMP)).find((s) => s.layerName === 'station_dots')!
    const hex = shows(
      dotsStyle('fill gradient(.speed, 0, 120, "#7dd3fc", "#e11d48") stroke-white stroke-1'),
    ).find((s) => s.layerName === 'station_dots')!
    expect(token.shaderVariant?.featureFields).toEqual(['speed'])
    expect(token.shaderVariant?.key).toBe(hex.shaderVariant?.key)
    // …and the AST the CPU bake sees carries hex literals, not arithmetic.
    const args = (fillAst(dotsStyle(RAMP), 'station_dots') as { args: Expr[] }).args
    expect(args[3]).toEqual({ kind: 'StringLiteral', value: '#7dd3fc' })
    expect(args[4]).toEqual({ kind: 'StringLiteral', value: '#e11d48' })
  })

  it('the token rewrite is IDENTITY on a hex-only expression — same object, not a copy', () => {
    // The claim every unchanged golden, variant key and feature layout rests on: a
    // style whose colour positions are ALREADY literals (every Mapbox-converted one,
    // which emits `"#rrggbb"`) must come back untouched. Reference equality is the
    // strongest available statement of that — a structurally-equal rebuild would
    // still be a new object, and `toEqual` could not tell the two apart.
    const hexOnly = fillAst(
      dotsStyle('fill gradient(.speed, 0, 120, "#7dd3fc", "#e11d48") stroke-white stroke-1'),
      'station_dots',
    )
    expect(resolveColorTokenLiterals(hexOnly)).toBe(hexOnly)
  })

  it('a token-armed LABEL colour carries hex literals — the third producer boundary', () => {
    // `resolveColorTokenLiterals` is applied per PRODUCER, and the label/icon pair is a
    // producer the fill and stroke pins say nothing about (ir/lower-label.ts). Its
    // consumer is label-pass.ts, which reads the evaluated value as a colour string —
    // so an un-rewritten `sky-300` arm arrived there as the number -300 and the label
    // silently kept the layer default, the same failure mode as the point fill.
    const scene = lower(
      new Parser(
        new Lexer(`xgis 1
source stations { type: geojson }
layer banded_labels {
  source: stations
  | label-[.name] label-color-[match(.band) { "a" -> sky-300, _ -> "#10b981" }]
}
`).tokenize(),
      ).parse(),
    )
    // `shapes.textPaint.color` is exactly what label-pass.ts:936-939 reads.
    const color = scene.renderNodes[0]!.label!.shapes!.textPaint.color
    expect(color?.kind, 'label colour reaches the runtime as a per-feature expr').toBe(
      'data-driven',
    )
    const ast = (color as { expr: { ast: unknown } }).expr.ast as Expr
    const arms = (ast as unknown as { matchBlock: { arms: Array<{ value: Expr }> } }).matchBlock
      .arms
    expect(arms[0]!.value).toEqual({ kind: 'StringLiteral', value: '#7dd3fc' })
    expect(bake(ast, { band: 'a' })).toBe('#7dd3fc')
  })

  it('a token-armed STROKE carries hex literals too — the mirror of the fill rewrite', () => {
    // The stroke axis reaches a DIFFERENT producer (ir/lower-bindings-line.ts), so the
    // fill pin above says nothing about it. Its `_` arm stays hex because that is what
    // `extractMatchDefaultColor` routes a colour-shaped binding on — the token arm is
    // the half that used to evaluate to -300 and drop to the baked default.
    const ast = strokeAst(
      `xgis 1
source stations { type: geojson }
layer banded_stroke {
  source: stations
  | stroke match(.band) { "a" -> sky-300, _ -> "#10b981" }
}
`,
      'banded_stroke',
    )
    const arms = (ast as { matchBlock: { arms: Array<{ pattern: unknown; value: Expr }> } })
      .matchBlock.arms
    expect(arms[0]!.value).toEqual({ kind: 'StringLiteral', value: '#7dd3fc' })
    expect(bake(ast, { band: 'a' })).toBe('#7dd3fc')
  })
})

describe('#1664 — CPU gradient() is the GPU ramp, term for term', () => {
  // THE GPU SOURCE: compiler/src/codegen/shader-gen.ts:380-388 emits
  //
  //   mix4(vec4fFromRgba(low), vec4fFromRgba(high),
  //        saturateF32(f32Div(f32Sub(val, min), f32Sub(max, min))))
  //
  // (saturate(t) ≡ clamp(t, 0.0, 1.0) by WGSL spec definition — #1828; the CPU twin
  // below keeps computing the [0,1] clamp, values bit-identical)
  //
  // with `low` / `high` decoded by `resolveColorFromAST` (shader-gen-helpers.ts) and
  // `mix(a, b, t)` defined by both WGSL and GLSL as `a * (1 - t) + b * t`, per
  // channel, ALPHA INCLUDED. That is the only place `gradient()` is lowered for the
  // GPU — the `scale()` arm at :417 emits the identical shape under a different
  // name, and compute-gen's ramp at :418 is the multi-stop `interpolate()` form, not
  // this one — so there is exactly one formula to match.
  //
  // This restates that formula from the GPU's OWN endpoint decoder and compares it
  // to what `callBuiltin` produces. It is not a restatement of the CPU
  // implementation: the two share no code below `resolveColorFromAST`.
  const gpuRamp = (v: number, min: number, max: number, lo: string, hi: string): number[] => {
    const a = resolveColorFromAST({ kind: 'StringLiteral', value: lo } as Expr)!
    const b = resolveColorFromAST({ kind: 'StringLiteral', value: hi } as Expr)!
    const t = Math.max(0, Math.min(1, (v - min) / (max - min)))
    return [0, 1, 2, 3].map((i) => a[i]! * (1 - t) + b[i]! * t)
  }
  const cpuChannels = (hex: unknown): number[] => {
    const s = String(hex)
    const n = (i: number): number => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16) / 255
    return [n(0), n(1), n(2), s.length === 9 ? n(3) : 1]
  }
  /** The sweep both parity pins drive: 24 points at `-20 + 7k`, spanning -20..141 so
   *  both clamped tails and the whole 0..120 interior are sampled. Written as a count
   *  rather than a `v <= bound` loop so the number in this comment cannot drift from
   *  the number of samples actually taken. */
  const SWEEP = Array.from({ length: 24 }, (_, k) => -20 + 7 * k)

  it('agrees with the GPU mix() to within the 8-bit hex it must encode into', () => {
    // The ONE unavoidable departure: a colour leaves this evaluator as a hex string
    // (so does `rgb`, so does `interpolate_lab`), which quantises to 8 bits. Bound
    // the divergence at half a code — below what any display resolves — and pin it,
    // so a future change to either side that drifts FURTHER is caught here rather
    // than as a subtle mismatch between a polygon and the point sitting on it.
    for (const v of SWEEP) {
      const want = gpuRamp(v, 0, 120, '#7dd3fc', '#e11d48')
      const got = cpuChannels(callBuiltin('gradient', [v, 0, 120, '#7dd3fc', '#e11d48']))
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(got[i]! - want[i]!), `v=${v} channel ${i}`).toBeLessThanOrEqual(0.5 / 255)
      }
    }
  })

  it('lerps ALPHA too — mix() is vec4-wide on the GPU', () => {
    // A half-transparent endpoint is the case a 3-channel CPU lerp would silently
    // get wrong: rgb would still look plausible while the polygon twin faded.
    expect(callBuiltin('gradient', [0, 0, 10, '#00000000', '#000000ff'])).toBe('#00000000')
    expect(callBuiltin('gradient', [5, 0, 10, '#00000000', '#000000ff'])).toBe('#00000080')
    expect(callBuiltin('gradient', [10, 0, 10, '#00000000', '#000000ff'])).toBe('#000000')
  })

  it('a DEGENERATE ramp (max === min) pins to the low stop, deterministically', () => {
    // WGSL leaves division by zero indeterminate, so there is no GPU behaviour to
    // copy here; the evaluator's own rule for `/` (a zero divisor yields 0) governs,
    // giving t = 0. What matters is that it is defined and never NaN — a NaN channel
    // reaches the colour buffer and the driver paints undefined behaviour.
    expect(callBuiltin('gradient', [7, 5, 5, '#7dd3fc', '#e11d48'])).toBe('#7dd3fc')
  })

  it('refuses a non-colour endpoint instead of inventing one', () => {
    // The caller reads `null` as "unresolved" and reports it (#1664's loud path).
    // Painting a plausible colour from a palette miss would misreport the data — the
    // same bargain rhi-fill-gap-warning.ts struck for the WebGL2 polygon gap.
    expect(callBuiltin('gradient', [5, 0, 10, 'not-a-colour', '#e11d48'])).toBeNull()
    expect(callBuiltin('gradient', [5, 0, 10, -300, -600])).toBeNull()
    expect(callBuiltin('gradient', [5, 0, 10])).toBeNull()
  })

  it('#1665 — 5-arg scale() is the SAME ramp, sweep for sweep', () => {
    // `scale(field, min, max, low, high)` is `gradient()` under an older name: the GPU
    // arm at shader-gen.ts:417-449 emits the identical mix4 shape. Before #1665 the CPU
    // had only the 2-arg numeric multiply under that name, so a `scale`-spelled ramp
    // returned `min * max` — a NUMBER — and the point / arrow bake rejected it exactly
    // the way it rejected the token endpoints. Same sweep as the gradient pin above,
    // against the same GPU-side decoder.
    for (const v of SWEEP) {
      const want = gpuRamp(v, 0, 120, '#7dd3fc', '#e11d48')
      const got = cpuChannels(callBuiltin('scale', [v, 0, 120, '#7dd3fc', '#e11d48']))
      for (let i = 0; i < 4; i++) {
        expect(Math.abs(got[i]! - want[i]!), `v=${v} channel ${i}`).toBeLessThanOrEqual(0.5 / 255)
      }
    }
  })

  it('#1665 — scale() and gradient() are ONE implementation, hex for hex', () => {
    // The evaluation pin: the exact strings the two names produce must be identical,
    // not merely close. They share `colorRamp`, so a divergence here means someone
    // grew a second copy of the arithmetic.
    for (const v of [0, 30, 60, 90, 120]) {
      expect(callBuiltin('scale', [v, 0, 120, '#7dd3fc', '#e11d48'])).toBe(
        callBuiltin('gradient', [v, 0, 120, '#7dd3fc', '#e11d48']),
      )
    }
    expect(callBuiltin('scale', [0, 0, 120, '#7dd3fc', '#e11d48'])).toBe('#7dd3fc')
    expect(callBuiltin('scale', [60, 0, 120, '#7dd3fc', '#e11d48'])).toBe('#af78a2')
    expect(callBuiltin('scale', [120, 0, 120, '#7dd3fc', '#e11d48'])).toBe('#e11d48')
    // Token endpoints resolve here too — `colorRamp` runs `resolveColor` per endpoint.
    expect(callBuiltin('scale', [0, 0, 120, 'sky-300', 'rose-600'])).toBe('#7dd3fc')
  })

  it('#1665 — 2-arg scale() is still the numeric multiply, byte for byte', () => {
    // The arity discriminator must not move the historical form. `scale` is a GPU-safe
    // numeric builtin in classify.ts and const-folds through this same switch, so a
    // regression here would silently rescale every authored `scale(.x, k)`.
    expect(callBuiltin('scale', [6, 7])).toBe(42)
    expect(callBuiltin('scale', [-2.5, 4])).toBe(-10)
    expect(callBuiltin('scale', ['3', 4])).toBe(12)
  })

  it('an expression the CPU still cannot bake THROWS — the loud path keeps a trigger', () => {
    // `categorical()` is auto-palette indexing that exists only in the shader, and
    // stays deliberately outside `callBuiltin`. It must keep throwing: that throw is
    // what the point / arrow catch turns into the named warning, and a silent `null`
    // here would put the silent drop straight back.
    expect(() => callBuiltin('categorical', [3])).toThrow(/unknown function/)
  })
})
