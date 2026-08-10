// ═══ `u.zoom` is REACHABLE in every composer host (#1635) ═══
//
// The compiler lowers a stage block's `zoom` builtin to the plain TEXT `u.zoom`
// (compiler/src/__tests__/zoom-uniform.test.ts pins that half). Nothing in the
// compiler knows whether the shader that ends up hosting the spliced expression
// declares such a lane — the reference is a string, exactly like the `input` pool's
// `u.input_f32_N` (polygon-input-pool.test.ts, #1539). This is the other half:
// compile a REAL zoom-reading program end to end, push it through each host's own
// composer bridge, and assert the emitted shader both NAMES the lane and DECLARES
// it in the group(0) uniform struct.
//
// Two failure modes it exists to catch, both invisible to tsc and to every
// CPU-side unit test:
//
//  1. UNDECLARED LANE. Point had no `zoom` field at all before #1635 and line
//     padded over polygon's (`_pad_tail0`), so a composed `u.zoom` referenced an
//     identifier the module never declared — the whole program fails to compile on
//     a real device, and the layer draws nothing.
//  2. WRONG BLOCK INSTANCE. Line's group(0) block was `as: 'tile'`, so even after
//     the lane was named the spliced text `u.zoom` still resolved to nothing. The
//     instance name is part of the ABI, not cosmetics.
//
// GPU-free: emit + string assertions, so it rides the `test (map)` leg. The WGSL and
// the GLSL ES 3.00 twin are BOTH asserted — WebGL2 is the backend the render gates
// actually drive here (CLAUDE.md §5), and the twin re-assembles the module per stage.

import { describe, it, expect } from 'vitest'
import { Lexer, Parser, lower, emitCommands, ZOOM_UNIFORM_REF } from '@xgis/compiler'
import type { ShaderVariantInfo } from './renderer-types'
import { toComposerLineVariant } from './line-shader-cache'
import { toComposerPointVariant } from './point-shader-cache'
import { emitLineWgsl } from '../shaders/dsl/line'
import { emitLineGlsl } from '../shaders/dsl/line-glsl'
import { emitPointWgsl, emitPointGlsl } from '../shaders/dsl/point'
import { toComposerVariant } from './polygon-shader-cache'
import { emitPolygonWgsl } from '../shaders/dsl/polygon'

/** Compile one layer body through the PRODUCTION path (`emitCommands`, the same
 *  call the runtime makes) and hand back the show's shader variant. */
function variantFor(layerBody: string): ShaderVariantInfo {
  const src = `xgis 1
source w { type: geojson, data: { "type": "FeatureCollection", "features": [] } }
layer l {
  source: w
  ${layerBody}
}
`
  const scene = lower(new Parser(new Lexer(src).tokenize()).parse())
  expect(scene.diagnostics?.filter((d) => d.severity === 'error') ?? []).toEqual([])
  const variant = emitCommands(scene).shows[0]?.shaderVariant
  expect(variant, 'the layer produced no shader variant').toBeTruthy()
  return variant as unknown as ShaderVariantInfo
}

const ZOOM_BODY_COLOR = '@color { return vec4(zoom / 22, 0.2, 0.1, 1) }'
const ZOOM_BODY_STROKE = '@stroke { return vec4(0.1, 0.2, zoom / 22, 1) }'

/** The uniform struct body a shader declares, so "declares the lane" cannot be
 *  satisfied by the spliced READ itself appearing somewhere else in the file. */
function structBody(shader: string, structName: string): string {
  const wgsl = shader.match(new RegExp(`struct ${structName} \\{([\\s\\S]*?)\\n\\}`))
  if (wgsl) return wgsl[1]!
  // GLSL twin: a uniform struct binding lowers to a std140 UBO block tagged with
  // the struct name (`layout(std140) uniform TileUniforms { … } u;`).
  const glsl = shader.match(new RegExp(`uniform ${structName} \\{([\\s\\S]*?)\\n\\}`))
  if (glsl) return glsl[1]!
  throw new Error(`uniform struct ${structName} not found in the emitted shader`)
}

/** `u.zoom` → the lane name the host must declare (`zoom`). */
const ZOOM_LANE = ZOOM_UNIFORM_REF.split('.')[1]!
/** `u.zoom` → the block instance name the host must bind as (`u`). */
const ZOOM_INSTANCE = ZOOM_UNIFORM_REF.split('.')[0]!

/** The three things that must ALL hold for a spliced `u.zoom` to resolve in one
 *  emitted shader — checked together so a severed half names its own host:
 *    · the composed body still carries the read,
 *    · the group(0) block is BOUND under the instance the read addresses, and
 *    · that block's struct DECLARES the lane.
 *  Nothing on the CPU side link-checks a varref (the IR treats `u.zoom` as opaque
 *  text — shader-dsl's `validate` has no scope pass), so these three strings are
 *  the strongest GPU-free proof; the real link is the WebGL2 render gate. */
function expectZoomResolves(label: string, shader: string, structName: string): void {
  expect(shader, `${label}: composed body lost the zoom read`).toContain(ZOOM_UNIFORM_REF)
  expect(shader, `${label}: group(0) block is not bound as \`${ZOOM_INSTANCE}\``).toMatch(
    new RegExp(
      // WGSL `var<uniform> u: TileUniforms;` | GLSL `layout(std140) uniform TileUniforms { … } u;`
      `var<uniform> ${ZOOM_INSTANCE}: ${structName};|uniform ${structName} \\{[\\s\\S]*?\\n\\} ${ZOOM_INSTANCE};`,
    ),
  )
  expect(structBody(shader, structName), `${label}: lane \`${ZOOM_LANE}\` undeclared`).toMatch(
    new RegExp(`\\b${ZOOM_LANE}\\b`),
  )
}

describe('the `zoom` builtin resolves in every composer host (#1635)', () => {
  it('line: a @stroke stage block emits a read the TileUniforms struct declares', () => {
    const spec = toComposerLineVariant(variantFor(ZOOM_BODY_STROKE))
    expect(spec, 'the compiler variant was rejected by the line bridge').not.toBeNull()
    for (const [label, shader] of [
      ['wgsl', emitLineWgsl(spec, false)],
      ['glsl:fragment', emitLineGlsl(spec, false, 'fragment')],
    ] as const) {
      expectZoomResolves(label, shader, 'TileUniforms')
    }
  })

  it('point: @color AND @stroke stage blocks both read a lane Uniforms declares', () => {
    const spec = toComposerPointVariant(variantFor(`${ZOOM_BODY_COLOR}\n  ${ZOOM_BODY_STROKE}`))
    expect(spec, 'the compiler variant was rejected by the point bridge').not.toBeNull()
    expect(spec!.fillExpr).not.toBeNull()
    expect(spec!.strokeExpr).not.toBeNull()
    for (const [label, shader] of [
      ['wgsl', emitPointWgsl(spec)],
      ['glsl:fragment', emitPointGlsl(spec, 'fragment')],
    ] as const) {
      expectZoomResolves(label, shader, 'Uniforms')
      // BOTH axes, not one: point's headline property is that `@color` and
      // `@stroke` compose independently, and a half-wired seam is silent (the
      // unwired axis falls back to the CPU-baked feat_data read). Counting
      // `u.zoom` occurrences would NOT prove it — the emitter CSEs the shared
      // `(u.zoom / 22.0)` into one temp both axes then reference. So follow the
      // temp: whichever name the zoom expression is bound to must appear in each
      // axis's assignment.
      const temp = shader.match(/(\w+) = \(u\.zoom \/ 22\.0\)/)?.[1]
      const assignment = (axis: string) =>
        shader.match(new RegExp(`\\n\\s*${axis} = ([^\\n]*)`))?.[1] ?? ''
      for (const axis of ['point_fill_color', 'point_stroke_color']) {
        const rhs = assignment(axis)
        expect(rhs, `${label}: ${axis} was never assigned by the composer`).not.toBe('')
        expect(
          rhs.includes(ZOOM_UNIFORM_REF) || (temp !== undefined && rhs.includes(temp)),
          `${label}: ${axis} does not carry the zoom read (got \`${rhs}\`)`,
        ).toBe(true)
      }
    }
  })

  it('polygon: a @color stage block reads the lane it has carried since the palette work', () => {
    // Polygon needed no source change — it already declares `zoom` and VTR already
    // writes it per frame. Asserted anyway: it is the host the other two were put
    // on parity WITH, so a polygon-side removal would break all three at once.
    const spec = toComposerVariant(variantFor(ZOOM_BODY_COLOR))
    expect(spec, 'the compiler variant was rejected by the polygon bridge').not.toBeNull()
    expectZoomResolves('wgsl', emitPolygonWgsl(spec, false), 'Uniforms')
  })
})
