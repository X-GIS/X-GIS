// ═══ The `zoom` builtin on the GPU expression path (#1635) ═══
//
// A bare `zoom` used to compile to the LITERAL 0.0 on every backend. `astToNode`'s
// Identifier arm is `featDataField(name, fieldMap) ?? f32Lit(0)`, and `zoom` is
// deliberately excluded from the collected field set (it is the camera builtin, not
// a feature property), so the lookup could never hit and the fallback always fired.
// Nothing was diagnosed: `@color { return vec4(zoom / 22, 0.2, 0.1, 1) }` compiled,
// linked, drew — with a red channel pinned at 0 at every camera zoom.
//
// The fix gives `zoom` a REAL per-frame uniform read, `u.zoom` — the SAME spelling
// the zoom-interpolated palette path has emitted since #929, single-sourced as
// ZOOM_UNIFORM_REF. These tests pin the two halves that must stay true together:
//
//   1. the bare builtin LOWERS to that uniform read (never a literal), and
//   2. it still claims NO feature-buffer slot — `zoom` must not push a field into
//      the storage layout, or every `.field` offset in the same expression shifts.
//
// The host-shader half — that `u.zoom` names a lane polygon/line/point actually
// DECLARE and WRITE — is map/src/render/stage-zoom-uniform.test.ts. The reference
// is plain TEXT, so neither side alone is sufficient.

import { describe, expect, it } from 'vitest'
import { Lexer } from '../lexer/lexer'
import { Parser } from '../parser/parser'
import { withPragma } from './_pragma'
import { lower } from '../ir/lower'
import { generateShaderVariant } from '../codegen/shader-gen'
import { nodeToWgslString } from '../codegen/node-to-wgsl'
import { collectFields } from '../codegen/wgsl-expr'
import { ZOOM_UNIFORM_REF } from '../codegen/_util/node-builders'

const parse = (source: string) => new Parser(new Lexer(withPragma(source)).tokenize()).parse()

const scene = (layerBody: string) =>
  lower(
    parse(`
source w { type: geojson, url: "w.geojson" }
layer l {
  source: w
  ${layerBody}
}
`),
  )

/** The lowered fill expression as WGSL text. */
const fillWgsl = (layerBody: string): string => {
  const s = scene(layerBody)
  expect(s.diagnostics?.filter((d) => d.severity === 'error') ?? []).toEqual([])
  const v = generateShaderVariant(s.renderNodes[0]!)
  expect(v.fillExpr).not.toBeNull()
  return nodeToWgslString(v.fillExpr!)
}

describe('`zoom` lowers to a uniform read, not a literal (#1635)', () => {
  it('the ABI is `u.zoom` — the group(0) block lane every host declares', () => {
    // Spelled out rather than inferred: this string is the whole contract between
    // the compiler and the three host shaders, and it is emitted as plain text.
    expect(ZOOM_UNIFORM_REF).toBe('u.zoom')
  })

  it('a bare `zoom` in a @color stage block reads the uniform', () => {
    const wgsl = fillWgsl('@color { return vec4(zoom / 22, 0.2, 0.1, 1) }')
    expect(wgsl).toBe('vec4<f32>((u.zoom / 22.0), 0.2, 0.1, 1.0)')
  })

  it('THE REGRESSION: the zoom channel is not the literal 0.0', () => {
    // The fail-before witness, stated as its own assertion so a future refactor
    // that reinstates the `?? f32Lit(0)` fallback names itself here rather than
    // only in a render gate. `(0.0 / 22.0)` is EXACTLY what the pre-fix compiler
    // emitted for this channel — verified by cutting the Identifier arm and
    // reading the message back.
    const wgsl = fillWgsl('@color { return vec4(zoom / 22, 0.2, 0.1, 1) }')
    expect(wgsl, 'the `zoom` builtin folded to a literal again').not.toContain('(0.0 / 22.0)')
  })

  it('a bare `zoom` in a @stroke stage block reads the same uniform', () => {
    const s = scene('@stroke { return vec4(0.1, 0.2, zoom / 22, 1) }')
    const v = generateShaderVariant(s.renderNodes[0]!)
    expect(nodeToWgslString(v.strokeExpr!)).toBe('vec4<f32>(0.1, 0.2, (u.zoom / 22.0), 1.0)')
  })

  it('reaches through arithmetic, comparisons and builtin calls', () => {
    // `zoom` is an ordinary f32 leaf once lowered — nothing about the uniform read
    // is stage-block-specific, so every enclosing form must carry it.
    expect(fillWgsl('@color { return vec4(clamp(zoom, 0, 1), 0, 0, 1) }')).toContain(
      'clamp(u.zoom, 0.0, 1.0)',
    )
    expect(fillWgsl('@color { return vec4(zoom > 10 ? 1 : 0, 0, 0, 1) }')).toContain('u.zoom')
    expect(fillWgsl('@color { return vec4(-zoom, 0, 0, 1) }')).toContain('u.zoom')
  })

  it('a data-driven (non-stage) paint binding reads it too', () => {
    // The Identifier arm is shared by every GPU expression path, so the fix is not
    // scoped to stage blocks — an ordinary data-driven opacity, composed into the
    // fill's alpha, gets the real read as well.
    expect(fillWgsl('| fill-red-500 opacity-[zoom / 22]')).toBe(
      'vec4<f32>(FILL_COLOR.rgb, (FILL_COLOR.a * (u.zoom / 22.0)))',
    )
  })
})

describe('`zoom` claims no feature-buffer slot (#1635)', () => {
  it('a zoom-only body needs no feature buffer and collects no field', () => {
    const s = scene('@color { return vec4(zoom / 22, 0.2, 0.1, 1) }')
    const v = generateShaderVariant(s.renderNodes[0]!)
    expect(v.needsFeatureBuffer).toBe(false)
    expect(v.featureFields).toEqual([])
  })

  it('collectFields skips the builtin but keeps a real `.zoom` PROPERTY', () => {
    // The two are different things and both must keep working: bare `zoom` is the
    // camera, `.zoom` is a feature property that merely shares the name. Only the
    // FieldAccess form may take a storage slot.
    const s = scene('@color { return vec4(.zoom / 22, zoom / 10, .r, 1) }')
    const v = generateShaderVariant(s.renderNodes[0]!)
    // `.zoom` and `.r` are fields; the bare builtin is not.
    expect(v.featureFields).toEqual(['r', 'zoom'])
    const wgsl = nodeToWgslString(v.fillExpr!)
    expect(wgsl).toContain('u.zoom')
    expect(wgsl).toContain('feat_data[')
  })

  it('collectFields is the direct authority for that split', () => {
    const s = scene('@color { return vec4(zoom, .zoom, .r, 1) }')
    const ast = s.renderNodes[0]!.fill
    expect(ast.kind).toBe('stage')
    if (ast.kind !== 'stage') return
    expect([...collectFields(ast.expr.ast)].sort()).toEqual(['r', 'zoom'])
  })

  it('the builtin does not shift a sibling field’s storage offset', () => {
    // The failure this guards: if `zoom` ever entered the field set it would take a
    // stride slot, and every `.field` offset baked into the SAME expression would
    // move — a silent colour/opacity swap, not a compile error.
    const withZoom = fillWgsl('@color { return vec4(.r, zoom / 22, .g, 1) }')
    const withoutZoom = fillWgsl('@color { return vec4(.r, 0.5, .g, 1) }')
    const addrs = (w: string) => w.match(/feat_data\[[^\]]+\]/g) ?? []
    expect(addrs(withZoom)).toEqual(addrs(withoutZoom))
    expect(addrs(withZoom)).toHaveLength(2)
  })
})
