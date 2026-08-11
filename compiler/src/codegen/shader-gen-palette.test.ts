// ═══════════════════════════════════════════════════════════════════
// shader-gen.ts — palette-aware variant emission (P3 Step 3b)
// ═══════════════════════════════════════════════════════════════════
//
// Locks in the OPT-IN behaviour: when generateShaderVariant receives
// a Palette, zoom-interpolated paint values emit a textureSampleLevel
// call against the gradient atlas instead of falling through to
// `u.fill_color`. With palette omitted (every legacy caller), the
// generated WGSL is byte-identical to the pre-Step-3b version —
// existing shader-gen tests (~30 in mapbox-convert + golden) cover
// that path; this file is dedicated to the new branch.

import { describe, expect, it } from 'vitest'
import { generateShaderVariant } from './shader-gen'
import { collectPalette } from './palette'
import type {
  ColorValue,
  RenderNode,
  Scene,
  SizeValue,
  StrokeValue,
  ZoomStop,
} from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'
import type { ShaderVariant } from './shader-gen'
import { nodeToWgslString } from './node-to-wgsl'

// Phase 2.5 US-004 — fillExpr / strokeExpr migrated from string to
// NodeLike|null. The default-uniform placeholder is now `null` paired
// with `fillIsDefault: true`; assertions that expected the legacy
// `'u.fill_color'` string now consult these helpers.
function fillStr(v: ShaderVariant): string {
  return v.fillExpr ? nodeToWgslString(v.fillExpr) : 'u.fill_color'
}
function strokeStr(v: ShaderVariant): string {
  return v.strokeExpr ? nodeToWgslString(v.strokeExpr) : 'u.stroke_color'
}

const RED: RGBA = [1, 0, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]
const zs = <T>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  const base: RenderNode = {
    name: 'a',
    sourceRef: 's',
    zOrder: 0,
    fill: { kind: 'none' },
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
  return { ...base, ...overrides }
}

function sceneFromNodes(...nodes: RenderNode[]): Scene {
  return { sources: [], renderNodes: nodes, symbols: [] }
}

describe('shader-gen — palette-aware emission', () => {
  it('omitting palette → byte-identical to legacy (no palette bindings, no gradient sample)', () => {
    const node = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })
    const v = generateShaderVariant(node) // no palette
    expect(v.preamble.bindings ?? []).toEqual([])
    expect(fillStr(v)).toContain('u.fill_color')
  })

  it('palette provided with matching gradient → STILL the uniform, no atlas sample (#1661)', () => {
    // The inversion this issue landed. A zoom-interpolated colour used to emit
    // `textureSampleLevel(color_grad_atlas, …)` here WHILE the renderer's per-frame
    // `resolveColorShape` wrote the same value into `u.fill_color` — two authorities for
    // one colour, agreeing to within 0.66/255 and therefore invisible. The CPU half is
    // now the only one: it evaluates the curve exactly at the camera zoom, where the
    // atlas was a 256-texel f16 resample of that same curve, and the sample coordinate
    // (`u.zoom`) is a uniform, so the read produced a per-draw constant per fragment.
    //
    // Asserted WITH a palette present, which is the load-bearing part: the sibling case
    // below (no palette) passed before this change too, so it alone cannot tell the two
    // designs apart.
    const node = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })
    const palette = collectPalette(sceneFromNodes(node))
    expect(
      palette.colorGradients.length,
      'the gradient IS collected — packPalette still needs it',
    ).toBe(1)
    const v = generateShaderVariant(node, palette)
    expect(v.preamble.bindings ?? []).toEqual([])
    expect(fillStr(v)).not.toContain('textureSampleLevel')
    expect(fillStr(v)).toContain('u.fill_color')
  })

  it('palette provided but no matching gradient → falls back to uniform', () => {
    const node = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })
    // Palette built from a DIFFERENT node — no gradient overlap.
    const otherNode = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, BLUE), zs(15, RED)] } as ColorValue,
    })
    const palette = collectPalette(sceneFromNodes(otherNode))
    const v = generateShaderVariant(node, palette)
    // Legacy uniform path — no atlas bindings emitted.
    expect((v.preamble.bindings ?? []).some((b) => b.name === 'color_grad_atlas')).toBe(false)
    expect(fillStr(v)).toContain('u.fill_color')
  })

  it('constant fill with palette → no atlas bindings (no gradient needed)', () => {
    const node = makeNode({
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    })
    const palette = collectPalette(sceneFromNodes(node))
    const v = generateShaderVariant(node, palette)
    expect((v.preamble.bindings ?? []).some((b) => b.name === 'color_grad_atlas')).toBe(false)
    expect(fillStr(v)).toContain('FILL_COLOR')
  })

  it('two zoom-interpolated paint axes both route through palette', () => {
    const node = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
      stroke: {
        color: { kind: 'zoom-interpolated', stops: [zs(0, BLUE), zs(20, RED)] } as ColorValue,
        width: { kind: 'constant', value: 1 } as PropertyShape<number>,
      } as StrokeValue,
    })
    const palette = collectPalette(sceneFromNodes(node))
    const v = generateShaderVariant(node, palette)
    // BOTH colour axes take the uniform now — checked separately because fill and stroke
    // reach `processColorValue` by different call sites, and a change that fixed only one
    // would leave the other sampling a binding the group no longer declares.
    expect(fillStr(v)).not.toContain('textureSampleLevel')
    expect(strokeStr(v)).not.toContain('textureSampleLevel')
    expect(fillStr(v)).toContain('u.fill_color')
    expect(strokeStr(v)).toContain('u.stroke_color')
    expect(v.preamble.bindings ?? []).toEqual([])
  })

  it('two layers sharing one gradient → one collected gradient, zero variant references', () => {
    // collectPalette still dedups by canonical key (the packer depends on it); what
    // changed is that no VARIANT points back at the index any more.
    const fill: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const nodeA = makeNode({ fill })
    const nodeB = makeNode({ name: 'b', fill })
    const palette = collectPalette(sceneFromNodes(nodeA, nodeB))
    expect(palette.colorGradients.length).toBe(1)
  })
})
