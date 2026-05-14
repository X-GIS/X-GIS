// ═══════════════════════════════════════════════════════════════════
// palette-emit.ts — WGSL emission tests
// ═══════════════════════════════════════════════════════════════════
//
// Locks in the produced WGSL text. shader-gen.ts will splice this
// output into the variant fragment shader in Step 3b, so a typo or
// shape change here breaks every variant downstream — guard with
// strict-equal assertions on representative cases.

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PALETTE_SLOTS,
  emitColorGradientSample,
  emitPaletteBindings,
  emitScalarGradientSample,
} from './palette-emit'
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

describe('palette-emit — emitPaletteBindings', () => {
  it('empty palette → empty string (no bindings to declare)', () => {
    const palette = collectPalette(sceneFromNodes())
    expect(emitPaletteBindings(palette)).toBe('')
  })

  it('constants-only palette (no gradients) → empty string', () => {
    // Constant fill goes into the .colors pool but has no gradient.
    // The shader inlines constants directly — no atlas needed.
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'constant', rgba: RED } as ColorValue,
    })))
    expect(emitPaletteBindings(palette)).toBe('')
  })

  it('color gradient → emits color atlas binding + sampler, no scalar', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })))
    const out = emitPaletteBindings(palette)
    expect(out).toContain('@binding(2) var color_grad_atlas: texture_2d<f32>')
    expect(out).not.toContain('scalar_grad_atlas')
    expect(out).toContain('@binding(4) var palette_samp: sampler')
  })

  it('scalar gradient → emits scalar atlas binding + sampler, no color', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      size: { kind: 'zoom-interpolated', stops: [zs(0, 4), zs(20, 16)] } as SizeValue,
    })))
    const out = emitPaletteBindings(palette)
    expect(out).toContain('@binding(3) var scalar_grad_atlas: texture_2d<f32>')
    expect(out).not.toContain('color_grad_atlas')
    expect(out).toContain('palette_samp')
  })

  it('mixed gradients → emits both atlases + one shared sampler', () => {
    const palette = collectPalette(sceneFromNodes(
      makeNode({ fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue }),
      makeNode({ size: { kind: 'zoom-interpolated', stops: [zs(0, 4), zs(20, 16)] } as SizeValue }),
    ))
    const out = emitPaletteBindings(palette)
    expect(out).toContain('color_grad_atlas')
    expect(out).toContain('scalar_grad_atlas')
    expect((out.match(/palette_samp/g) ?? []).length).toBe(1)
  })

  it('honors custom binding slots', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })))
    const out = emitPaletteBindings(palette, {
      group: 2, colorGradientBinding: 7, scalarGradientBinding: 8, samplerBinding: 9,
    })
    expect(out).toContain('@group(2) @binding(7) var color_grad_atlas')
    expect(out).toContain('@group(2) @binding(9) var palette_samp')
  })

  it('default slots ship sensible numbers above 0..1', () => {
    // 0 + 1 are claimed by `u` (uniform) and `feat_data`. Palette
    // bindings must sit AFTER so adding them doesn't disturb the
    // existing two-tier layout.
    expect(DEFAULT_PALETTE_SLOTS.colorGradientBinding).toBeGreaterThan(1)
    expect(DEFAULT_PALETTE_SLOTS.scalarGradientBinding).toBeGreaterThan(1)
    expect(DEFAULT_PALETTE_SLOTS.samplerBinding).toBeGreaterThan(1)
  })
})

describe('palette-emit — emitColorGradientSample', () => {
  it('emits textureSampleLevel with bakedin (zMin, zMax, v)', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(2, RED), zs(10, BLUE)] } as ColorValue,
    })))
    const out = emitColorGradientSample(palette, 0)
    expect(out).toContain('textureSampleLevel(color_grad_atlas, palette_samp')
    expect(out).toContain('(u.zoom - 2.0)')
    expect(out).toContain('/ 8.0')  // zMax - zMin = 10 - 2
    // v = (0 + 0.5) / 1 = 0.5 since only one gradient
    expect(out).toContain('0.5')
    expect(out).toContain('clamp(')
    expect(out).toContain(', 0.0, 1.0)')
  })

  it('honors custom zoom expression', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(20, BLUE)] } as ColorValue,
    })))
    const out = emitColorGradientSample(palette, 0, 'camera.zoom')
    expect(out).toContain('camera.zoom - 0.0')
    expect(out).not.toContain('u.zoom')
  })

  it('two gradients → v coord matches row centre', () => {
    const palette = collectPalette(sceneFromNodes(
      makeNode({ fill: { kind: 'zoom-interpolated', stops: [zs(0, RED), zs(10, BLUE)] } as ColorValue }),
      makeNode({ fill: { kind: 'zoom-interpolated', stops: [zs(0, BLUE), zs(10, RED)] } as ColorValue }),
    ))
    // Grad index 0 → v = (0 + 0.5) / 2 = 0.25
    const row0 = emitColorGradientSample(palette, 0)
    expect(row0).toContain('0.25')
    // Grad index 1 → v = (1 + 0.5) / 2 = 0.75
    const row1 = emitColorGradientSample(palette, 1)
    expect(row1).toContain('0.75')
  })

  it('out-of-range index → defensive zero fallback', () => {
    const palette = collectPalette(sceneFromNodes())
    expect(emitColorGradientSample(palette, 0)).toBe('vec4f(0.0, 0.0, 0.0, 0.0)')
  })

  it('zero-span gradient (degenerate one-stop)  → guard divisor', () => {
    // Single-stop gradients are collapsed by foldTrivialStopsPass
    // before reaching here, but the helper is defensive: a zero
    // span (zMin == zMax) would produce division by zero in WGSL.
    // The implementation falls back to `/ 1.0` in that case so the
    // sampler always reads a valid texel.
    const palette = collectPalette(sceneFromNodes(makeNode({
      fill: { kind: 'zoom-interpolated', stops: [zs(5, RED), zs(5, BLUE)] } as ColorValue,
    })))
    const out = emitColorGradientSample(palette, 0)
    expect(out).toContain('/ 1.0')  // zMax-zMin = 0, divisor falls back to 1
  })
})

describe('palette-emit — emitScalarGradientSample', () => {
  it('emits .r-unpacked textureSampleLevel', () => {
    const palette = collectPalette(sceneFromNodes(makeNode({
      size: { kind: 'zoom-interpolated', stops: [zs(0, 4), zs(20, 16)] } as SizeValue,
    })))
    const out = emitScalarGradientSample(palette, 0)
    expect(out).toContain('textureSampleLevel(scalar_grad_atlas, palette_samp')
    expect(out.endsWith('.r')).toBe(true)
  })

  it('out-of-range → zero fallback', () => {
    const palette = collectPalette(sceneFromNodes())
    expect(emitScalarGradientSample(palette, 5)).toBe('0.0')
  })
})
