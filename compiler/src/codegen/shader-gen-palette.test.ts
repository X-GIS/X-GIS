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
import type { ColorValue, RenderNode, Scene, SizeValue, StrokeValue, ZoomStop } from '../ir/render-node'
import type { PropertyShape, RGBA } from '../ir/property-types'

const RED: RGBA = [1, 0, 0, 1]
const BLUE: RGBA = [0, 0, 1, 1]
const zs = <T,>(zoom: number, value: T): ZoomStop<T> => ({ zoom, value })

function makeNode(overrides: Partial<RenderNode> = {}): RenderNode {
  const base: RenderNode = {
    name: 'a', sourceRef: 's', zOrder: 0,
    fill: { kind: 'none' },
    stroke: {
      color: { kind: 'none' },
      width: { kind: 'constant', value: 0 } as PropertyShape<number>,
    } as StrokeValue,
    opacity: { kind: 'constant', value: 1 },
    size: { kind: 'none' } as SizeValue,
    extrude: { kind: 'none' } as never,
    extrudeBase: { kind: 'none' } as never,
    projection: 'mercator', visible: true, pointerEvents: 'auto',
    filter: null, geometry: null, billboard: true,
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
    const v = generateShaderVariant(node)  // no palette
    expect(v.preamble).not.toContain('color_grad_atlas')
    expect(v.preamble).not.toContain('palette_samp')
    expect(v.fillExpr).toContain('u.fill_color')
    expect(v.paletteColorGradients).toEqual([])
  })

  it('palette provided with matching gradient → emits textureSampleLevel', () => {
    const node = makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })
    const palette = collectPalette(sceneFromNodes(node))
    const v = generateShaderVariant(node, undefined, palette)
    expect(v.preamble).toContain('@binding(2) var color_grad_atlas')
    expect(v.preamble).toContain('palette_samp')
    expect(v.fillExpr).toContain('textureSampleLevel(color_grad_atlas, palette_samp')
    expect(v.fillExpr).not.toContain('u.fill_color')
    expect(v.paletteColorGradients).toEqual([0])
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
    const v = generateShaderVariant(node, undefined, palette)
    // Legacy uniform path — no atlas bindings emitted.
    expect(v.preamble).not.toContain('color_grad_atlas')
    expect(v.fillExpr).toContain('u.fill_color')
    expect(v.paletteColorGradients).toEqual([])
  })

  it('constant fill with palette → no atlas bindings (no gradient needed)', () => {
    const node = makeNode({
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    })
    const palette = collectPalette(sceneFromNodes(node))
    const v = generateShaderVariant(node, undefined, palette)
    expect(v.preamble).not.toContain('color_grad_atlas')
    expect(v.fillExpr).toContain('FILL_COLOR')
    expect(v.paletteColorGradients).toEqual([])
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
    const v = generateShaderVariant(node, undefined, palette)
    expect(v.fillExpr).toContain('textureSampleLevel(color_grad_atlas')
    expect(v.strokeExpr).toContain('textureSampleLevel(color_grad_atlas')
    // Both gradients collected; deduped by collectPalette so two
    // distinct gradients show two indices.
    expect(v.paletteColorGradients.length).toBe(2)
    expect(v.paletteColorGradients).toContain(0)
    expect(v.paletteColorGradients).toContain(1)
    // Bindings emit ONCE even with multiple gradient samples.
    expect((v.preamble.match(/@binding\(2\) var color_grad_atlas/g) ?? []).length).toBe(1)
  })

  it('two layers sharing the same gradient → both reference index 0', () => {
    const fill: ColorValue = { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] }
    const nodeA = makeNode({ fill })
    const nodeB = makeNode({ name: 'b', fill })
    // collectPalette dedups by canonical key.
    const palette = collectPalette(sceneFromNodes(nodeA, nodeB))
    const varA = generateShaderVariant(nodeA, undefined, palette)
    const varB = generateShaderVariant(nodeB, undefined, palette)
    expect(varA.paletteColorGradients).toEqual([0])
    expect(varB.paletteColorGradients).toEqual([0])
  })
})
