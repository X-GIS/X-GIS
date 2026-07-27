// ═══ Material for the IBFV advection step (#1333) ═══
//
// The pipeline the advection draw runs through. Mirrors CoverageDraper one-for-one — same
// Material seam, same dual-source shader (WGSL + the GLSL twin), same named-entry discipline —
// because the flow layer is a coverage concern and should not invent a second way to do this.
//
// THE NAMES ARE LOAD-BEARING. WebGL2 binds by NAME, not by slot (rhi.ts #783), so a group-0
// entry whose `name` does not match the shader's resource identifier binds nothing there — and
// it fails on WebGL2 ONLY, which is the backend this environment cannot run. So the names below
// are asserted against the emitted shader by flow-advect-material.test.ts rather than trusted.
//
// NO BLENDING. The advect step REPLACES the target: the history/noise mix is computed in the
// shader, not accumulated by the blender. That is also why the flow layer needs only
// EXT_color_buffer_float and not EXT_float_blend on WebGL2 (see flow-targets.ts).

import { Material, executeItems, type DrawItem } from '@xgis/engine'
import type {
  RhiDevice,
  RhiBindGroup,
  RhiTextureView,
  RhiSampler,
  RhiRenderPass,
} from '@xgis/engine'
import { emitFlowAdvectWgsl, emitFlowAdvectGlsl } from '../../shaders/dsl/flow-advect'

/** Floats in AdvectParams: step(4) + phase(4). */
export const FLOW_ADVECT_UNIFORM_FLOATS = 8

/** The fullscreen triangle the advect VS builds procedurally — no vertex buffer. */
const FULLSCREEN_TRIANGLE_VERTS = 3

/** Group-0 entry names. Exported so the test can assert them against the EMITTED shader
 *  instead of against a second copy of the same list. */
export const FLOW_ADVECT_BINDINGS = [
  { binding: 0, kind: 'texture', name: 'prev_tex' },
  { binding: 1, kind: 'texture', name: 'u_tex' },
  { binding: 2, kind: 'texture', name: 'v_tex' },
  { binding: 3, kind: 'sampler', name: 'samp' },
  { binding: 4, kind: 'uniform', name: 'AdvectParams' },
] as const

export class FlowAdvectDraper {
  private readonly material: Material

  constructor(
    private readonly rhi: RhiDevice,
    format: string,
    sampleCount = 1,
  ) {
    this.material = new Material(rhi, {
      shader: emitFlowAdvectWgsl(),
      vsEntry: 'vs_flow_advect',
      fsEntry: 'fs_flow_advect',
      vsCode: emitFlowAdvectGlsl('vertex'),
      fsCode: emitFlowAdvectGlsl('fragment'),
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [[...FLOW_ADVECT_BINDINGS]],
      // No blend: the step REPLACES the target (see the header).
      colorTargets: [{ format: format as 'bgra8unorm' }],
      // NO DEPTH STATE — and that is load-bearing, not an omission. `Material` builds a
      // depthStencil whenever `depthCompare` is truthy (material.ts:150), and WebGPU requires
      // a pipeline's attachment state to MATCH the pass it is set on. This pass is
      // colour-only (flow-renderer.ts begins it with one colour attachment and no
      // depthStencilAttachment), so declaring `depthCompare: 'always'` here — copied from
      // CoverageDraper, where it is correct because the OPAQUE pass does carry depth — makes
      // every SetPipeline a validation error and the advection never runs at all.
      variants: [{ label: 'flow-advect-pipeline' }],
      globalUniformSize: FLOW_ADVECT_UNIFORM_FLOATS * 4,
    })
  }

  /** Bind the history side + the velocity pair for one step. `prev` MUST be the read side and
   *  the pass MUST be rendering into the write side — sampling the attachment being written is
   *  undefined behaviour on both backends (FlowStepper guarantees they differ). */
  bindGroup(
    prev: RhiTextureView,
    u: RhiTextureView,
    v: RhiTextureView,
    sampler: RhiSampler,
  ): RhiBindGroup {
    return this.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { view: prev } },
      { binding: 1, resource: { view: u } },
      { binding: 2, resource: { view: v } },
      { binding: 3, resource: { sampler } },
      { binding: 4, resource: { buffer: this.material.globalUniform! } },
    ])
  }

  /** Issue the fullscreen advection draw. `globalBytes` is the packed AdvectParams. */
  draw(pass: RhiRenderPass, globalBytes: BufferSource, bindGroup: RhiBindGroup): void {
    this.material.writeGlobal(globalBytes)
    const items: DrawItem[] = [
      { variant: 0, bindGroups: [bindGroup], count: FULLSCREEN_TRIANGLE_VERTS, indexed: false },
    ]
    executeItems(this.material, pass, items, 0)
  }
}

/** Pack AdvectParams into the uniform's own layout: step = (x, y, decay, inject), then phase. */
export function packFlowAdvectUniform(
  stepX: number,
  stepY: number,
  decay: number,
  inject: number,
  phase: number,
): Float32Array {
  const out = new Float32Array(FLOW_ADVECT_UNIFORM_FLOATS)
  out[0] = stepX
  out[1] = stepY
  out[2] = decay
  out[3] = inject
  out[4] = phase
  return out
}
