// ═══ Point adapter over the generic Material ═══
//
// Builds the generic Material from the point descriptor (1 group with 3 storage
// buffers, vertex+index geometry, 2 depth variants with polygon-offset bias) and
// wraps the point renderer's native buffers into one generic DrawItem. The
// pipeline/layout build + draw loop are the shared generic core (material.ts).

import type { MaterialDesc, RhiBuffer, RhiDevice, RhiRenderPass } from '@xgis/engine'
import { Material, executeItems } from '@xgis/engine'
import { emitPointWgsl, emitPointGlslStages, type PointVariantSpec } from '../../shaders/dsl/point'
import { simpleGlslId, simpleWgslId } from '../../shaders/baked/ids'
import { wgslFor, glslStagesFor } from './wgsl-for'

type VertexBuffers = ReadonlyArray<{
  stride: number
  attributes: ReadonlyArray<{ location: number; offset: number; format: string }>
}>

/** The buffers + draw params for one tile-point batch. All handles are RHI
 *  buffers (§4 batch-seam migration): the renderer builds its own uniform/feat/
 *  vertex/index via the RHI seam, and the shared ShapeRegistry shape/seg buffers
 *  are RhiBuffer too (step 3c migrated them) so they arrive here directly. Passed
 *  straight through — NO re-wrapping (a wrap of an already-RHI handle would
 *  double-wrap → unwrap yields a Native wrapper, not a GPUBuffer → empty draw). */
export interface PointBatch {
  uniform: RhiBuffer
  feat: RhiBuffer
  shape: RhiBuffer
  seg: RhiBuffer
  vertex: RhiBuffer
  index: RhiBuffer
  indexCount: number
  /** Pipeline variant: 0 = opaque (depth write + bias), 1 = translucent (no write + bias),
   *  2 = flat (no write, NO bias — flat ground-plane circles). */
  variant: number
}

export class PointDraper {
  /** Release the GPU objects this draper owns (#1578). Called by `rebuildForQuality()`
   *  before the reference is dropped — a quality flip is live-session churn, not teardown,
   *  so nothing else would ever reclaim these. */
  destroy(): void {
    this.material.destroy()
    this._pickMaterial?.destroy()
    this._pickMaterial = undefined
  }

  private readonly material: Material
  /** The descriptor `material` was built from — kept so the pick twin below is the SAME
   *  material with different colour targets, rather than a hand-copied second descriptor
   *  that can drift from this one (three depth variants to keep in step). */
  private readonly desc: MaterialDesc
  // Tile points draw INSIDE the opaque sub-pass, which carries a SECOND (rg32uint) colour
  // attachment while picking is on (#2319): WebGPU rejects `setPipeline` when the pipeline's
  // fragment-target count differs from the pass's attachment count, dropping the whole
  // sub-pass — basemap included — every frame. LAZY, so the non-pick path (the dedicated
  // points pass, and WebGL2, which fail-closes on an rg32uint MRT) never builds it.
  private _pickMaterial?: Material

  constructor(
    rhi: RhiDevice,
    private readonly format: string,
    sampleCount: number,
    vertexBuffers: VertexBuffers,
    /** A feature-free @color/@stroke composer variant (#1605 Phase 2), or null
     *  for the default feat_data-read path. Named `shaderVariant`, NOT `variant`
     *  — `PointBatch.variant` below is an unrelated depth-bias pipeline index
     *  (0=opaque/1=translucent/2=flat); reusing the name would shadow/confuse
     *  the two inside draw(). Since #1605 Phase 3 it feeds BOTH source
     *  languages below — the WGSL and the GLSL twin compose the same variant,
     *  so a variant-carrying layer paints its authored colour on either
     *  backend. (Passing null to the GLSL half, as this did before Phase 3,
     *  rendered the default silently on WebGL2: no crash, no failing
     *  pipeline, just the wrong colour.) */
    private readonly shaderVariant: PointVariantSpec | null = null,
  ) {
    const bias = { constant: -10, slopeScale: -1, clamp: 0 }
    // #1679 inc 6 — the bake is read ONLY for the default (variant-free) program. The
    // baked key `wgsl/point` carries no variant token, so handing it to a
    // variant-carrying draper would serve the DEFAULT bytes while this thunk asked for
    // the composed ones — `wgsl-for.ts` returns a hit WITHOUT running the thunk. That is
    // not a slow frame, it is the wrong colour, and it is the exact failure the
    // `shaderVariant` doc above records having shipped once already. `undefined` here is
    // the pre-bake path, pinned in `wgsl-for-baked.test.ts`.
    const bakedPointIds =
      this.shaderVariant === null
        ? {
            wgsl: simpleWgslId('point'),
            glsl: {
              vertex: simpleGlslId('point', 'vertex'),
              fragment: simpleGlslId('point', 'fragment'),
            },
          }
        : undefined
    // #1057 — GLSL ES 3.00 twins for the WebGL2 backend, emitted behind a LIVE backend
    // guard so the WebGPU boot never pays the double emit (mirrors RetainedCircleDraper).
    // The point storage buffers (feat_data / shapes / segments) lower to data-texture
    // samplers via the default storage lowering; on WebGPU these are ignored.
    this.desc = {
      shader: wgslFor(rhi, () => emitPointWgsl(this.shaderVariant), bakedPointIds?.wgsl),
      ...glslStagesFor(rhi, () => emitPointGlslStages(this.shaderVariant), bakedPointIds?.glsl),
      vsEntry: 'vs_point',
      fsEntry: 'fs_point',
      format: format as 'bgra8unorm',
      sampleCount,
      groups: [
        [
          { binding: 0, kind: 'uniform' },
          // Reflection names pinned by point-dsl.test.ts — three same-kind
          // storage entries MUST be named or WebGL2's by-order pairing would
          // silently mis-bind them (plan-time guarded since #783).
          { binding: 1, kind: 'storage', name: 'feat_data' },
          { binding: 2, kind: 'storage', name: 'shapes' },
          { binding: 3, kind: 'storage', name: 'segments' },
        ],
      ],
      colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
      vertexBuffers,
      variants: [
        {
          depthWrite: true,
          depthCompare: 'less-equal',
          depthBias: bias,
          label: 'sdf-point-pipeline-rhi',
        },
        {
          depthWrite: false,
          depthCompare: 'less-equal',
          depthBias: bias,
          label: 'sdf-point-pipeline-translucent-rhi',
        },
        // flat: depth-read, NO write, NO bias — flat ground-plane circles (painter's order).
        { depthWrite: false, depthCompare: 'less-equal', label: 'sdf-point-pipeline-flat-rhi' },
      ],
    }
    this.material = new Material(rhi, this.desc)
  }

  /** The pick-pass twin: same shader, same group-0 layout, same three depth variants (a
   *  `PointBatch.variant` indexes both materials identically), one extra rg32uint target so
   *  the pipeline is layout-compatible with the opaque sub-pass's pick MRT (#2319).
   *  `writeMask: 0` because a tile point carries no feature id and must not clobber the id
   *  the fill under it already wrote (#1215). Reusing `material`'s layout keeps the bind
   *  group `draw` builds valid for either pipeline. */
  private pickMat(): Material {
    return (this._pickMaterial ??= new Material(this.material.rhi, {
      ...this.desc,
      groups: [this.material.layout(0)],
      colorTargets: [
        { format: this.format as 'bgra8unorm', blend: 'alpha' },
        { format: 'rg32uint', writeMask: 0 },
      ],
      variants: this.desc.variants.map((v) => ({ ...v, label: `${v.label}-pick` })),
    }))
  }

  draw(
    pass: RhiRenderPass,
    b: PointBatch,
    /** Draw through the pick twin — the caller reads `pickTargetsEnabled(rhi.caps)`, the
     *  single authority the opaque pass attaches its pick MRT from (#2319). */
    pick = false,
  ): void {
    const bg = this.material.rhi.createBindGroup(this.material.layout(0), [
      { binding: 0, resource: { buffer: b.uniform } },
      { binding: 1, resource: { buffer: b.feat } },
      { binding: 2, resource: { buffer: b.shape } },
      { binding: 3, resource: { buffer: b.seg } },
    ])
    executeItems(pick ? this.pickMat() : this.material, pass, [
      {
        variant: b.variant,
        bindGroups: [bg],
        vertex: b.vertex,
        index: { buffer: b.index, format: 'uint32' },
        count: b.indexCount,
        indexed: true,
      },
    ])
  }
}
