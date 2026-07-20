// ═══ Compute-variant layout authority (#1189) ═══
//
// A compute-paint variant's fill Material twin MUST be built against the SAME
// bind-group layout object its render pipeline uses — the compute-EXTENDED
// layout from the injected `_layoutFor` resolver, never the factory's base
// layouts (`baseVariantLayout`; named `getOrBuildVariantLayout` when the bug
// shipped). The two-authority trap is real: the factory owned an attractively-
// named base resolver, and `registerFillMaterials` picked the base one —
// the twin's pipeline then referenced `compute_out`'s binding, absent from its
// layout ("Invalid RenderPipeline fill-ground-write-rhi" + per-tile "Binding
// doesn't exist in mr-featureBindGroupLayout", near-blank compute render).
// Compute is default-off with 0 entries on Mapbox styles, so no render test
// covered the path; this gate pins the invariant with no GPU by driving the
// REAL `getOrCreateVariantPipelines` → `registerFillMaterials` → `Material`
// seam over a stub device/rhi and asserting layout-object identity end-to-end.

import { describe, it, expect, vi } from 'vitest'
import { PipelineFactory } from './pipeline-factory'
import type { ShaderVariantInfo } from './renderer-types'

// Distinct layout sentinels — identity (===) is the assertion, not shape.
const EXTENDED = { label: 'compute-extended-sentinel' } as unknown as GPUBindGroupLayout
const BASE_FEATURE = { label: 'base-feature-sentinel' } as unknown as GPUBindGroupLayout
const BASE = { label: 'base-sentinel' } as unknown as GPUBindGroupLayout

interface CapturedPipeline {
  label?: string
  bindGroupLayouts: { native?: unknown }[]
}

/** Factory instance WITHOUT running the ctor (build() needs a real device);
 *  only the state `getOrCreateVariantPipelines` + `registerFillMaterials`
 *  touch. The stub device records the variant pipeline layouts; the stub rhi
 *  records every Material `createPipeline` (the twins), so the test can compare
 *  the two sides' layout objects. `wrapWebGpuBindGroupLayout` boxes the GPU
 *  layout as `{ native }`, so the Material side unwraps via `.native`. */
function makeFactory() {
  const variantPipelineLayouts: GPUPipelineLayoutDescriptor[] = []
  const materialPipelines: CapturedPipeline[] = []
  const device = {
    createShaderModule: (d: { label?: string }) => ({ label: d.label }),
    createPipelineLayout: (d: GPUPipelineLayoutDescriptor) => {
      variantPipelineLayouts.push(d)
      return { __layouts: d.bindGroupLayouts }
    },
    createRenderPipeline: (d: { label?: string }) => ({ label: d.label }),
  }
  const rhi = {
    backend: 'webgpu' as const,
    createPipeline: vi.fn((d: CapturedPipeline) => {
      materialPipelines.push(d)
      return { __label: d.label }
    }),
    createBindGroupLayout: vi.fn((x: unknown) => x),
    createBuffer: vi.fn(() => ({})),
  }
  const f = Object.create(PipelineFactory.prototype) as PipelineFactory
  const anyF = f as unknown as Record<string, unknown>
  anyF.ctx = { device, format: 'bgra8unorm', rhi }
  anyF.shaderCache = new Map()
  anyF._fillPerStyle = new Map()
  anyF.featureBindGroupLayout = BASE_FEATURE
  anyF.bindGroupLayout = BASE
  // The FrameRenderer-injected compute-aware resolver (the single authority).
  f.setLayoutResolver((v) => ((v.computeBindings?.length ?? 0) > 0 ? EXTENDED : BASE_FEATURE))
  return { f, variantPipelineLayouts, materialPipelines }
}

const computeVariant = {
  key: 'authority-test-compute',
  needsFeatureBuffer: true,
  featureFields: ['kind'],
  computeBindings: [{ binding: 16, bufferName: 'compute_out_fill', paintAxis: 'fill' }],
} as unknown as ShaderVariantInfo

const plainVariant = {
  key: 'authority-test-plain',
  needsFeatureBuffer: true,
  featureFields: ['kind'],
} as unknown as ShaderVariantInfo

const materialLayoutsOf = (captured: CapturedPipeline[]): unknown[] =>
  captured.map((d) => d.bindGroupLayouts[0]?.native)

describe('compute-variant layout authority (#1189)', () => {
  it("compute variant: fill Material twins get the SAME extended layout as the variant pipeline's", () => {
    const { f, variantPipelineLayouts, materialPipelines } = makeFactory()
    f.getOrCreateVariantPipelines(computeVariant)

    // The variant pipelines were laid out against the resolver's EXTENDED layout…
    expect(variantPipelineLayouts.length).toBeGreaterThan(0)
    for (const d of variantPipelineLayouts) expect([...d.bindGroupLayouts][0]).toBe(EXTENDED)

    // …and every fill Material twin pipeline (flat/ground × write/test — incl.
    // the exact "fill-ground-write-rhi" that went invalid pre-fix) received the
    // IDENTICAL underlying layout, not the base feature layout.
    expect(materialPipelines.length).toBeGreaterThan(0)
    expect(materialPipelines.map((d) => d.label)).toContain('fill-ground-write-rhi')
    for (const native of materialLayoutsOf(materialPipelines)) {
      expect(native).toBe(EXTENDED)
      expect(native).not.toBe(BASE_FEATURE)
    }
  })

  it('non-compute variant: twins and pipeline agree on the base feature layout (unchanged)', () => {
    const { f, variantPipelineLayouts, materialPipelines } = makeFactory()
    f.getOrCreateVariantPipelines(plainVariant)

    for (const d of variantPipelineLayouts) expect([...d.bindGroupLayouts][0]).toBe(BASE_FEATURE)
    expect(materialPipelines.length).toBeGreaterThan(0)
    for (const native of materialLayoutsOf(materialPipelines)) expect(native).toBe(BASE_FEATURE)
  })
})
