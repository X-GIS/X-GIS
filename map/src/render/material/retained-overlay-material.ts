// ═══ The one shape every retained geo-anchored overlay draper is built from (#2534) ═══
//
// Five drapers — arrow, circle, particle-flow, icon, advected arrow — were five copies of one
// `MaterialDesc`. Each said so in its own header ("Mirrors RetainedArrowDraper", "the sibling
// of RetainedCircleDraper"), and the duplication survey found them as its largest single
// cluster: `circle-retained-material.ts` and `particle-retained-material.ts` were each a
// whole-file structural copy of `arrow-retained-material.ts` below the header.
//
// WHAT THEY ACTUALLY SHARE, and it is everything but five fields: the pooled per-copy frame
// uniform at group 0, the alpha-blended colour target, NO depth-stencil (a pure overlay — the
// globe's far side is culled by the shader's `cos_c`, not by the depth buffer), one variant,
// and the WGSL/GLSL dual-source pair routed through `wgsl-for.ts` so a device emits only the
// language it reads. What differs is the family, its two emitters, its two entry points and
// its group-1 resources — which is exactly `RetainedOverlaySpec`.
//
// THE FAMILY IS THE SINGLE AUTHORITY FOR THE BAKED IDS. `spec.family` derives the WGSL id,
// both GLSL stage ids AND the pipeline label, so a draper cannot spell an id that disagrees
// with the family it belongs to — the property `wgsl-for.ts`'s header asks for ("an id naming
// one entry while the thunk emits another is unrepresentable rather than merely unlikely"),
// here made structural rather than per-file. `SimpleFamily` rather than `string` so a typo is
// a type error; `simple-family-rewiring.test.ts` is the gate that keeps this chain live.
//
// FUNCTIONS FIRST, ONE BASE CLASS WHERE FUNCTIONS COULD NOT FINISH THE JOB. The five keep
// their own classes because `retained-draper-set.ts` and the `install.test.ts` census name
// them individually. Plain functions over a `Material` the caller owns cover the icon and the
// advected arrow, whose `makeBatchBindGroup` (and, for the advected arrow, `draw`) are their
// own. They did NOT cover arrow / circle / particle: those three have the SAME group 1 and the
// same two methods, so composition left each holding an identical pair of one-line delegates —
// 18 lines the duplication ratchet flagged, measured, not predicted. `RetainedFeatTintDraper`
// is that pair, held once; the three subclasses are then nothing but their spec.
//
// NOT SHARED, DELIBERATELY: the icon's atlas-bound `makeBatchBindGroup`, and the advected
// arrow's single-draw `draw` (see `drawPerWorldCopy`'s note). Those are real differences.

import type {
  RhiBindEntry,
  RhiBindGroup,
  RhiBindLayoutEntry,
  RhiBuffer,
  RhiDevice,
  RhiRenderPass,
} from '@xgis/engine'
import { Material, executeItems, type DrawItem } from '@xgis/engine'
import { simpleGlslId, simpleWgslId, type SimpleFamily } from '../../shaders/baked/ids'
import { glslStagesFor, wgslFor } from './wgsl-for'

/** The per-family half of a retained overlay's `MaterialDesc` — every other field is the same
 *  for all five, and lives in `retainedOverlayMaterial`. */
export interface RetainedOverlaySpec {
  /** The baked family. Derives the WGSL id, both GLSL stage ids, and the pipeline label. */
  readonly family: SimpleFamily
  /** The family's WGSL emitter, passed as a THUNK: `wgslFor` runs it only on a device that
   *  reads WGSL and only when the baked store does not already answer for the id. */
  readonly wgsl: () => string
  /** The family's GLSL ES 3.00 pair, one lowering for both stages (see `glslStagesFor`). */
  readonly glslStages: () => { vertex: string; fragment: string }
  readonly vsEntry: string
  readonly fsEntry: string
  /** group 1 — the per-batch resources. group 0 is always the pooled frame uniform. */
  readonly group1: readonly RhiBindLayoutEntry[]
}

/** group 1 for the three drapers whose shader reads nothing but the per-instance record and
 *  its colour: two storage buffers, no atlas (arrow, circle and particle are all procedural
 *  SDFs in the fragment, not sprites). What each `feat_data` record CONTAINS is the family's
 *  own — `shaders/dsl/<family>-retained` is the authority, and each draper's header says it.
 *
 *  The `name`s are the DSL binding names: the WebGL2 backend reflects the linked program BY
 *  NAME with them, so a multi-resource group 1 binds correctly regardless of declaration
 *  order. WebGPU ignores them. */
export const FEAT_TINT_GROUP1: readonly RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'storage', name: 'feat_data' },
  { binding: 1, kind: 'storage', name: 'tint_data' },
]

/** Build a retained overlay draper's `Material`.
 *
 *  #823 — the GLSL ES 3.00 twins for the WebGL2 backend are emitted behind a LIVE capability
 *  guard so a WebGPU boot never pays the double emit (#778 P6): `WebGl2Device.createPipeline`
 *  requires the split sources, WebGPU ignores them, and `wgsl-for.ts` is the one place that
 *  asks which language the device consumes. */
export function retainedOverlayMaterial(
  rhi: RhiDevice,
  format: string,
  sampleCount: number,
  uniformSlotSize: number,
  spec: RetainedOverlaySpec,
): Material {
  return new Material(rhi, {
    shader: wgslFor(rhi, spec.wgsl, simpleWgslId(spec.family)),
    ...glslStagesFor(rhi, spec.glslStages, {
      vertex: simpleGlslId(spec.family, 'vertex'),
      fragment: simpleGlslId(spec.family, 'fragment'),
    }),
    vsEntry: spec.vsEntry,
    fsEntry: spec.fsEntry,
    format: format as 'bgra8unorm',
    sampleCount,
    groups: [
      // group 0 — the per-copy frame uniform (pooled). The GLSL UBO tag = the struct name.
      [{ binding: 0, kind: 'uniform', name: 'Uniforms' }],
      [...spec.group1],
    ],
    colorTargets: [{ format: format as 'bgra8unorm', blend: 'alpha' }],
    // No depth-stencil — pure overlay (globe far-side handled by the shader's cos_c cull).
    variants: [{ label: `${spec.family}-pipeline-rhi` }],
    // Frame uniform per world copy (raster's per-tile pool pattern).
    pool: { group: 0, slotSize: uniformSlotSize },
  })
}

/** The group-1 bind group for a `FEAT_TINT_GROUP1` draper. Built ONCE and cached by the
 *  caller for the batch's life — feat/tint are packed once, so it never rebuilds on a
 *  camera-only frame. */
export function featTintBindGroup(
  material: Material,
  feat: RhiBuffer,
  tint: RhiBuffer,
): RhiBindGroup {
  return batchBindGroup(material, [
    { binding: 0, resource: { buffer: feat } },
    { binding: 1, resource: { buffer: tint } },
  ])
}

/** group 1 from entries the draper spells itself — the icon's atlas pair and the advected
 *  arrow's velocity textures have nothing in common but this call. */
export function batchBindGroup(material: Material, entries: RhiBindEntry[]): RhiBindGroup {
  return material.rhi.createBindGroup(material.layout(1), entries)
}

/** Draw one batch across its visible world copies. `perCopyUniformBytes` holds one
 *  frame-uniform snapshot per copy (each with its own `world_offset` in circle_params.x);
 *  `count` is the instance count. One instanced draw(6, count) per copy — the 6 vertices are
 *  a procedural bounding quad from `vertex_index`, so there are no vertex or index buffers
 *  and the per-instance record is read from the feat storage via `instance_index`.
 *
 *  Returns the draw calls issued (= COPIES, not the instance count) — the N-independence
 *  invariant the #797 gate pins.
 *
 *  The advected arrow does NOT use this: its instances are lattice nodes of the CURRENT
 *  viewport rather than absolute Mercator anchors, so it issues one draw and keeps its own
 *  `draw` (see `arrow-retained-advected-material.ts`). */
export function drawPerWorldCopy(
  material: Material,
  pass: RhiRenderPass,
  batchBindGroup: RhiBindGroup,
  perCopyUniformBytes: ReadonlyArray<BufferSource>,
  count: number,
): number {
  if (count === 0 || perCopyUniformBytes.length === 0) return 0
  const items: DrawItem[] = perCopyUniformBytes.map((bytes) => ({
    variant: 0,
    // group 0 (null) is filled from the pool via poolBytes; group 1 is the cached batch group.
    bindGroups: [null, batchBindGroup],
    poolBytes: bytes,
    count: 6,
    indexed: false,
    instanceCount: count,
  }))
  return executeItems(material, pass, items)
}

/** Arrow, circle and particle-flow: three primitives, one draper. Each is a procedural SDF in
 *  the fragment reading nothing but its per-instance record and its colour, so all three take
 *  `FEAT_TINT_GROUP1` and expose the identical two methods — which is why they are a base
 *  class rather than three copies of a delegate pair.
 *
 *  A subclass supplies ONLY its spec. It stays a named class of its own because
 *  `retained-draper-set.ts` constructs the five by name and `shaders/baked/install.test.ts`'s
 *  boot-group census reads those `new …Draper(` spellings out of that file.
 *
 *  `material` is PRIVATE, not protected: no subclass needs it, and the icon and advected
 *  drapers reach the same shape through the functions above rather than through this class. */
export abstract class RetainedFeatTintDraper {
  private readonly material: Material

  constructor(
    rhi: RhiDevice,
    format: string,
    sampleCount: number,
    uniformSlotSize: number,
    spec: Omit<RetainedOverlaySpec, 'group1'>,
  ) {
    this.material = retainedOverlayMaterial(rhi, format, sampleCount, uniformSlotSize, {
      ...spec,
      group1: FEAT_TINT_GROUP1,
    })
  }

  makeBatchBindGroup(feat: RhiBuffer, tint: RhiBuffer): RhiBindGroup {
    return featTintBindGroup(this.material, feat, tint)
  }

  draw(
    pass: RhiRenderPass,
    batchBindGroup: RhiBindGroup,
    perCopyUniformBytes: ReadonlyArray<BufferSource>,
    count: number,
  ): number {
    return drawPerWorldCopy(this.material, pass, batchBindGroup, perCopyUniformBytes, count)
  }
}
