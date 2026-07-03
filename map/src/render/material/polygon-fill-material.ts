// ═══ Polygon fill — RHI Material twins + the routed fill draw (P1.6) ═══
//
// The VTR fill draw lives here (not in vector-tile-renderer.ts, which is at its size ratchet) so the
// renderer stays a thin caller. buildFlatFillMaterials() builds the RHI Material twins of the native
// flat-fill pipelines (flat = cull-none/depth-on, ground = cull-back/depth-off; variant 0 =
// STENCIL_WRITE, 1 = STENCIL_TEST). recordFillDraw() is the single per-tile fill draw: EVERY fill draw
// routes through the Material seam (executeItems, arena vertex/index sub-ranges, pick MRT); §4 is closed,
// so a pipeline with no built Material twin throws (the raw fallback draw + kill-switch were deleted).

import type { RhiDevice } from '@xgis/engine'
import {
  wrapWebGpuBindGroupLayout,
  wrapWebGpuBuffer,
  wrapWebGpuBindGroup,
  wrapWebGpuPass,
} from '@xgis/engine'
import { Material, executeItems } from './material'

/** The per-tile GPUArena fill buffers recordFillDraw reads (structural — a VTR GPUTile satisfies it). */
export interface FillTileBuffers {
  vertexBuffer: GPUBuffer
  polyVertexOffset: number
  polyVertexByteLength: number
  zBuffer: GPUBuffer | null
  zBufferOffset: number
  zBufferByteLength: number
  indexBuffer: GPUBuffer
  polyIndexOffset: number
  polyIndexByteLength: number
  indexCount: number
}

/** The native fill pipelines that map to the Material variants (set once from PipelineFactory). */
export interface FillRhiState {
  flat: Material | null
  ground: Material | null
  pipes: {
    write: GPURenderPipeline
    test: GPURenderPipeline
    groundWrite: GPURenderPipeline
    groundTest: GPURenderPipeline
  } | null
  /** Per-STYLE (data-driven) fills compile their own shader → their own pipeline; this LIVE map
   *  (grown by PipelineFactory as layers are added) routes each per-style fill pipeline to its
   *  Material twin + variant. Checked before the default `pipes` above. */
  perStyle: Map<GPURenderPipeline, { mat: Material; variant: number }> | null
  /** Opaque 3D-extruded fill (default shader): the extrude Material + the two native pipelines it
   *  twins. Routed on the bindZBuffer path. The *NoPick fields twin the pointer-events:none extrude
   *  pipelines (only built when picking is on; null otherwise). null = extrude stays raw. */
  extrude: {
    mat: Material
    write: GPURenderPipeline
    test: GPURenderPipeline
    matNoPick?: Material
    writeNoPick?: GPURenderPipeline
    testNoPick?: GPURenderPipeline
  } | null
  /** Fill-pattern (fs_fill_pattern) twins of the native fillPipelinePattern{Ground,Extruded}* pipelines.
   *  ground = cull-none / depth-off stencil (twins fillPipelinePatternGround + fallback); extruded =
   *  per-feature height / depth-write stencil (twins fillPipelinePatternExtruded + fallback). Routed
   *  before the raw else when a show resolves fillPatternUV. null = pattern stays raw. */
  pattern: {
    ground: Material
    groundWrite: GPURenderPipeline
    groundTest: GPURenderPipeline
    extruded: Material
    extrudedWrite: GPURenderPipeline
    extrudedTest: GPURenderPipeline
  } | null
}

export interface FillMaterialInputs {
  /** The injected backend RHI device (ctx.rhi) — the Material twins create their
   *  pipelines/bind-groups through it; not self-instantiated here. */
  rhi: RhiDevice
  shader: string
  format: string
  sampleCount: number
  bindGroupLayout: GPUBindGroupLayout
  vertexLayout: GPUVertexBufferLayout
  /** Extruded-fill vertex layout (POLYGON_EXTRUDED). Only buildPatternFillMaterials reads it — it twins
   *  BOTH the ground (flat `vertexLayout` above) + extruded pattern pipelines in a single call. */
  extrudedVertexLayout?: GPUVertexBufferLayout
  pickEnabled: boolean
  /** Pick-attachment writeMask (default 0xf). The `pointer-events:none` no-pick twins pass 0 so the
   *  layer's pick id never lands in the pick texture (picks fall through). */
  pickWriteMask?: number
  /** Split GLSL ES 3.00 sources for the WebGL2 fallback device (#746). Optional — a
   *  Material whose slice has no GLSL twin yet (extrude / pattern) stays WGSL-only and
   *  keeps WebGL2's explicit fail-closed error. */
  vsCode?: string
  fsCode?: string
}

const toMatVB = (l: GPUVertexBufferLayout) => ({
  stride: Number(l.arrayStride),
  attributes: Array.from(l.attributes).map((a) => ({
    location: a.shaderLocation,
    offset: a.offset,
    format: a.format as string,
  })),
})

/** Build the flat + ground fill Material twins for one shader (default or per-style). Pickable: the
 *  pick target writeMask is 0xf (the polygon fragment writes the feature id). */
export function buildFlatFillMaterials(inp: FillMaterialInputs): {
  flat: Material
  ground: Material
} {
  const rhi: RhiDevice = inp.rhi
  const fmt = inp.format as 'bgra8unorm'
  const groups = [wrapWebGpuBindGroupLayout(inp.bindGroupLayout)]
  const vertexBuffers = [toMatVB(inp.vertexLayout)]
  const colorTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const },
        { format: 'rg32uint' as const, writeMask: inp.pickWriteMask ?? 0xf },
      ]
    : [{ format: fmt, blend: 'alpha' as const }]
  const base = {
    shader: inp.shader,
    vsCode: inp.vsCode,
    fsCode: inp.fsCode,
    vsEntry: 'vs_main_ecef',
    fsEntry: 'fs_fill',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers,
    colorTargets,
  }
  const flat = new Material(rhi, {
    ...base,
    cullMode: 'none',
    variants: [
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'fill-flat-write-rhi',
      },
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-flat-test-rhi',
      },
    ],
  })
  const ground = new Material(rhi, {
    ...base,
    cullMode: 'back',
    variants: [
      {
        depthCompare: 'always',
        depthWrite: false,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'fill-ground-write-rhi',
      },
      {
        depthCompare: 'always',
        depthWrite: false,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-ground-test-rhi',
      },
    ],
  })
  return { flat, ground }
}

/** Build the 3D-extruded fill Material (vs_main_ecef_extruded / fs_fill_extrude, the POLYGON_EXTRUDED
 *  vertex layout). Variant 0 = STENCIL_WRITE (fillPipelineExtruded), 1 = STENCIL_TEST (fallback) —
 *  same depth/stencil as the flat fill (NOT ground). The per-tile z-buffer is bound at slot 1. */
export function buildExtrudeMaterial(inp: FillMaterialInputs): Material {
  const fmt = inp.format as 'bgra8unorm'
  return new Material(inp.rhi, {
    shader: inp.shader,
    vsEntry: 'vs_main_ecef_extruded',
    fsEntry: 'fs_fill_extrude',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups: [wrapWebGpuBindGroupLayout(inp.bindGroupLayout)],
    vertexBuffers: [toMatVB(inp.vertexLayout)],
    colorTargets: inp.pickEnabled
      ? [
          { format: fmt, blend: 'alpha' },
          { format: 'rg32uint', writeMask: inp.pickWriteMask ?? 0xf },
        ]
      : [{ format: fmt, blend: 'alpha' }],
    cullMode: 'none',
    variants: [
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'fill-extrude-write-rhi',
      },
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-extrude-test-rhi',
      },
    ],
  })
}

/** Build the fill-pattern Material twins (fs_fill_pattern). `patternGround` mirrors the flat fill's
 *  GROUND twin (depthCompare 'always', depthWrite false, write/test stencil) but cullMode 'none' — the
 *  native fillPipelinePatternGround is unculled, unlike the solid ground twin's 'back'. `patternExtruded`
 *  mirrors buildExtrudeMaterial (vs_main_ecef_extruded, the POLYGON_EXTRUDED vertex layout, STENCIL_WRITE
 *  / STENCIL_TEST). Both swap fsEntry to 'fs_fill_pattern' so the sprite atlas is sampled at the
 *  world-anchored UV. Variant 0 = STENCIL_WRITE(_NO_DEPTH) (main pipeline), 1 = the stencil-test fallback. */
export function buildPatternFillMaterials(inp: FillMaterialInputs): {
  patternGround: Material
  patternExtruded: Material
} {
  const rhi: RhiDevice = inp.rhi
  const fmt = inp.format as 'bgra8unorm'
  const groups = [wrapWebGpuBindGroupLayout(inp.bindGroupLayout)]
  const colorTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const },
        { format: 'rg32uint' as const, writeMask: inp.pickWriteMask ?? 0xf },
      ]
    : [{ format: fmt, blend: 'alpha' as const }]
  const patternGround = new Material(rhi, {
    shader: inp.shader,
    vsEntry: 'vs_main_ecef',
    fsEntry: 'fs_fill_pattern',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(inp.vertexLayout)],
    colorTargets,
    cullMode: 'none',
    variants: [
      {
        depthCompare: 'always',
        depthWrite: false,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'fill-pattern-ground-write-rhi',
      },
      {
        depthCompare: 'always',
        depthWrite: false,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-pattern-ground-test-rhi',
      },
    ],
  })
  const patternExtruded = new Material(rhi, {
    shader: inp.shader,
    vsEntry: 'vs_main_ecef_extruded',
    fsEntry: 'fs_fill_pattern',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(inp.extrudedVertexLayout ?? inp.vertexLayout)],
    colorTargets,
    cullMode: 'none',
    variants: [
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'fill-pattern-extrude-write-rhi',
      },
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-pattern-extrude-test-rhi',
      },
    ],
  })
  return { patternGround, patternExtruded }
}

/** The single per-tile fill draw. EVERY fill draw routes through the RHI Material seam: the pipeline
 *  is matched to its built Material twin (flat/ground/perStyle/extrude/pattern) and executed via
 *  executeItems. §4 is closed — a pipeline with no twin throws (fail-closed; the raw native draw was
 *  deleted). The per-draw stencil ref is set one level up by the caller. */
export function recordFillDraw(
  fillRhi: FillRhiState | null,
  encoder: GPURenderPassEncoder | GPURenderBundleEncoder,
  pipeline: GPURenderPipeline,
  tileBg: GPUBindGroup,
  slotOffset: number,
  cached: FillTileBuffers,
  bindZBuffer: boolean,
): void {
  // #717 — the draw-side VTR instance can have _fillRhi still null (the site's Astro island splits
  // the VTR module: setFillRhi(present) lands on one instance, the draw runs on another). Recover
  // the last-good fill state from the globalThis slot setFillRhi mirrors it to. In the single-instance
  // playground fillRhi is always present, so this is a no-op there.
  const eff = fillRhi ?? (globalThis as { __xgisFillRhi?: FillRhiState }).__xgisFillRhi ?? null
  if (eff) {
    let mat: Material | null = null
    let variant = -1
    // Match the draw pipeline to its built Material twin. IDENTITY FIRST (the normal single-instance
    // case — object equality, zero-cost, unchanged behaviour). LABEL FALLBACK second: across the dual
    // instance the recovered `eff` registry holds the OTHER instance's pipeline objects, so identity
    // fails; the two objects carry the SAME stable factory label (fill-pipeline / -ground / -fallback
    // / …, all variant-distinct — pipeline-factory.ts). `pipeline` is used ONLY to pick the twin+variant;
    // executeItems runs the twin's OWN (descriptor-equivalent) pipeline, so a label match is exact.
    // Empty label → identity only (never label-matches, so distinct-label pipelines can't collide).
    const eq = (a: GPURenderPipeline | undefined | null): boolean =>
      pipeline === a || (!!pipeline.label && !!a && pipeline.label === a.label)
    if (!bindZBuffer) {
      // Flat fill. Per-style (data-driven) pipelines route via their own cached Material twin; the
      // rest match the default-shader flat/ground pipes.
      let ps = eff.perStyle?.get(pipeline)
      if (!ps && eff.perStyle && pipeline.label) {
        for (const [k, v] of eff.perStyle) {
          if (eq(k)) {
            ps = v
            break
          }
        }
      }
      const p = eff.pipes
      mat = ps
        ? ps.mat
        : p && (eq(p.write) || eq(p.test))
          ? eff.flat
          : p && (eq(p.groundWrite) || eq(p.groundTest))
            ? eff.ground
            : null
      variant = ps
        ? ps.variant
        : p && (eq(p.write) || eq(p.groundWrite))
          ? 0
          : p && (eq(p.test) || eq(p.groundTest))
            ? 1
            : -1
      // Fill-pattern ground twin (fs_fill_pattern) — checked after the solid flat/ground pipes.
      if (!mat && eff.pattern) {
        const pat = eff.pattern
        if (eq(pat.groundWrite)) {
          mat = pat.ground
          variant = 0
        } else if (eq(pat.groundTest)) {
          mat = pat.ground
          variant = 1
        }
      }
    } else {
      // Opaque 3D extrude: match the two extrude pipelines. The per-feature height rides in the
      // POLYGON_EXTRUDED vertex (slot 0) — the slot-1 z-buffer is unused here, so no vertex1. (OIT +
      // per-style extrude are not in `extrude` yet → would throw below; both are provably unreachable
      // here: OIT-extrude is never scheduled and there is no per-style-extrude pipeline.)
      const e = eff.extrude
      if (e) {
        if (eq(e.write)) {
          mat = e.mat
          variant = 0
        } else if (eq(e.test)) {
          mat = e.mat
          variant = 1
        } else if (e.matNoPick && eq(e.writeNoPick)) {
          mat = e.matNoPick
          variant = 0
        } else if (e.matNoPick && eq(e.testNoPick)) {
          mat = e.matNoPick
          variant = 1
        }
      }
      // Fill-pattern extruded twin (fs_fill_pattern) — checked after the solid extrude.
      if (!mat && eff.pattern) {
        const pat = eff.pattern
        if (eq(pat.extrudedWrite)) {
          mat = pat.extruded
          variant = 0
        } else if (eq(pat.extrudedTest)) {
          mat = pat.extruded
          variant = 1
        }
      }
    }
    if (mat && variant >= 0) {
      const g = globalThis as { __xgisVtrFillRhiDraws?: number }
      g.__xgisVtrFillRhiDraws = (g.__xgisVtrFillRhiDraws ?? 0) + 1
      executeItems(mat, wrapWebGpuPass(encoder), [
        {
          variant,
          bindGroups: [wrapWebGpuBindGroup(tileBg)],
          dynamicOffsets: [[slotOffset]],
          vertex: wrapWebGpuBuffer(cached.vertexBuffer),
          vertexOffset: cached.polyVertexOffset,
          vertexSize: cached.polyVertexByteLength,
          index: {
            buffer: wrapWebGpuBuffer(cached.indexBuffer),
            format: 'uint32',
            offset: cached.polyIndexOffset,
            size: cached.polyIndexByteLength,
          },
          count: cached.indexCount,
          indexed: true,
        },
      ])
      return
    }
  }
  throw new Error(
    `recordFillDraw: fill pipeline has no RHI Material twin — every fill draw must route through the RHI seam (§4 closed). label=${(pipeline as GPURenderPipeline).label ?? '?'} bindZBuffer=${bindZBuffer}`,
  )
}
