// ═══ #2316 — a numeric match() label must select the arm the author wrote ═══
//
// The GPU colour of `match(.f) { 2 -> A, 4 -> B, _ -> C }` is decided in two
// places that have to agree: shader-gen picks the switch-case id for each arm,
// and `packPerTileFeatureData` writes the feature's value into the f32
// `feat_data` slot the shader switches on. For a STRING label the two agree
// through `categoryOrder` (the sorted index of the pattern), because a string
// cannot live in an f32. A NUMBER can — every packer writes a numeric value
// into that slot RAW and never looks one up by `String(value)` — so keying a
// numeric arm by its sorted index made every authored arm unreachable (2 and 4
// both painted the `_` arm) while a small integer landed in another value's arm
// (1 painted the arm authored for 4), and only the GPU disagreed: the CPU
// evaluator (hit-testing, label paths) returned the authored colour.
//
// The test walks the production path (emitCommands → ShaderVariant → packer)
// and asserts the colour a feature actually gets on the GPU is the colour the
// CPU evaluator returns for the same value. Arm patterns are `string | number`
// straight from the parser (#1068), so they are spelled here the way the parser
// and the Mapbox converter both emit them.

import { describe, expect, it } from 'vitest'
import {
  emitCommands,
  evaluate,
  type ColorValue,
  type DataExpr,
  type PropertyShape,
  type RenderNode,
  type Scene,
  type ShaderVariant,
  type SizeValue,
  type StrokeValue,
} from '@xgis/compiler'
import { packPerTileFeatureData } from './feature-data-pack'

const RED = [1, 0, 0, 1]
const BLUE = [0, 0, 1, 1]
const BLACK = [0, 0, 0, 1]

/** `match(.<field>) { <pattern> -> <hex>, …, _ -> <fallbackHex> }`. */
function matchExpr(
  field: string,
  arms: [string | number, string][],
  fallbackHex: string,
): DataExpr {
  return {
    ast: {
      kind: 'FnCall',
      callee: { kind: 'Identifier', name: 'match' },
      args: [{ kind: 'FieldAccess', object: null, field }],
      matchBlock: {
        kind: 'MatchBlock',
        arms: [
          ...arms.map(([pattern, hex]) => ({
            pattern,
            value: { kind: 'ColorLiteral' as const, value: hex },
          })),
          { pattern: '_', value: { kind: 'ColorLiteral' as const, value: fallbackHex } },
        ],
      },
    },
  } as DataExpr
}

function variantFor(expr: DataExpr): ShaderVariant {
  const fill: ColorValue = { kind: 'data-driven', expr }
  const node: RenderNode = {
    name: 'boundaries',
    sourceRef: 'b',
    zOrder: 0,
    fill,
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator',
    visible: true,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: { kind: 'named', name: 'circle' } as never,
  }
  const scene = { sources: [], symbols: [], renderNodes: [node] } as Scene
  return emitCommands(scene).shows[0]!.shaderVariant!
}

interface MatchIR {
  cases: ReadonlyArray<readonly [number, { args: { value: number }[] }]>
  default: { args: { value: number }[] }
}

/** The one `matchExpr` inside the variant's composed fill expression. */
function findMatch(expr: unknown): MatchIR | null {
  if (!expr || typeof expr !== 'object') return null
  const e = expr as Record<string, unknown>
  if (e.op === 'matchExpr') return e as unknown as MatchIR
  for (const v of Object.values(e)) {
    for (const child of Array.isArray(v) ? v : [v]) {
      const r = findMatch(child)
      if (r) return r
    }
  }
  return null
}

/** The colour the GPU paints for a packed `feat_data` slot: the case whose id
 *  the `i32` scrutinee equals, else the `_` arm. */
function gpuColor(m: MatchIR, packed: number): number[] {
  const hit = m.cases.find(([id]) => id === Math.trunc(packed))
  return (hit ? hit[1] : m.default).args.map((a) => a.value)
}

describe('#2316 numeric match() labels', () => {
  const expr = matchExpr(
    'admin_level',
    [
      [2, '#ff0000'],
      [4, '#0000ff'],
    ],
    '#000000',
  )
  const variant = variantFor(expr)

  it('publishes no category map for a numerically-keyed field', () => {
    expect(variant.featureFields).toEqual(['admin_level'])
    // A category map would make the packer's raw numeric write meaningless.
    expect(variant.categoryOrder['admin_level']).toBeUndefined()
  })

  it('keys the switch cases by the authored values', () => {
    const m = findMatch(variant.fillExpr)
    expect(m).not.toBeNull()
    expect(m!.cases.map((c) => c[0])).toEqual([2, 4])
  })

  it('paints the CPU evaluator colour for every value', () => {
    const m = findMatch(variant.fillExpr)!
    const packed = packPerTileFeatureData(
      new Map([
        [0, { admin_level: 2 }],
        [1, { admin_level: 4 }],
        [2, { admin_level: 1 }],
      ]),
      variant.featureFields,
      variant.categoryOrder,
    )!
    expect(packed).not.toBeNull()

    // CPU truth (hit-testing / label paths take this path).
    expect(evaluate(expr.ast, { admin_level: 2 })).toBe('#ff0000')
    expect(evaluate(expr.ast, { admin_level: 4 })).toBe('#0000ff')
    expect(evaluate(expr.ast, { admin_level: 1 })).toBe('#000000')

    expect(gpuColor(m, packed.data[0]!)).toEqual(RED)
    expect(gpuColor(m, packed.data[1]!)).toEqual(BLUE)
    expect(gpuColor(m, packed.data[2]!)).toEqual(BLACK)
  })

  it('keeps the category-id scheme for string labels', () => {
    const strVariant = variantFor(matchExpr('class', [['school', '#ff0000']], '#000000'))
    expect(strVariant.categoryOrder['class']).toEqual(['school'])
    const m = findMatch(strVariant.fillExpr)!
    expect(m.cases.map((c) => c[0])).toEqual([0])
    const packed = packPerTileFeatureData(
      new Map([
        [0, { class: 'school' }],
        [1, { class: 'other' }],
      ]),
      strVariant.featureFields,
      strVariant.categoryOrder,
    )!
    expect(gpuColor(m, packed.data[0]!)).toEqual(RED)
    expect(gpuColor(m, packed.data[1]!)).toEqual(BLACK)
  })
})
