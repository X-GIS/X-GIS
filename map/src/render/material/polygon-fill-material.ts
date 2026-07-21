// ═══ Polygon fill — RHI Material twins + the routed fill draw (P1.6) ═══
//
// The VTR fill draw lives here (not in vector-tile-renderer.ts, which is at its size ratchet) so the
// renderer stays a thin caller. buildFlatFillMaterials() builds the RHI Material twins of the native
// flat-fill pipelines (flat = cull-none/depth-on, ground = cull-back/depth-off; variant 0 =
// STENCIL_WRITE, 1 = STENCIL_TEST). recordFillDraw() is the single per-tile fill draw: EVERY fill draw
// routes through the Material seam (executeItems, arena vertex/index sub-ranges, pick MRT); §4 is closed,
// so a pipeline with no built Material twin throws (the raw fallback draw + kill-switch were deleted).

import type {
  RhiBindLayoutEntry,
  RhiBuffer,
  RhiDevice,
  RhiPipelineHandle,
  VertexFormat,
} from '@xgis/engine'
import {
  wrapWebGpuBindGroupLayout,
  wrapWebGpuBindGroup,
  wrapWebGpuPass,
  toVertexBufferLayout,
} from '@xgis/rhi-webgpu'
import { Material, executeItems } from '@xgis/engine'

/** The per-tile GPUArena fill buffers recordFillDraw reads (structural — a VTR
 *  GPUTile satisfies it). RHI handles (#832): the arena is backend-neutral and
 *  the draw flows through executeItems, so no native buffer appears here. */
export interface FillTileBuffers {
  vertexBuffer: RhiBuffer
  polyVertexOffset: number
  polyVertexByteLength: number
  zBuffer: RhiBuffer | null
  zBufferOffset: number
  zBufferByteLength: number
  indexBuffer: RhiBuffer
  polyIndexOffset: number
  polyIndexByteLength: number
  indexCount: number
}

/** The native fill pipelines that map to the Material variants (set once from PipelineFactory). */
export interface FillRhiState {
  flat: Material | null
  ground: Material | null
  pipes: {
    write: RhiPipelineHandle
    test: RhiPipelineHandle
    groundWrite: RhiPipelineHandle
    groundTest: RhiPipelineHandle
  } | null
  /** Per-STYLE (data-driven) fills compile their own shader → their own pipeline; this LIVE map
   *  (grown by PipelineFactory as layers are added) routes each per-style fill pipeline to its
   *  Material twin + variant. Checked before the default `pipes` above. */
  perStyle: Map<RhiPipelineHandle, { mat: Material; variant: number }> | null
  /** #1252 — per-STYLE EXTRUDED fills: a data-driven fill that also extrudes compiles its own
   *  feature-layout extrude Material (buildExtrudeMaterial over the variant WGSL). Routes each
   *  variant extruded pipeline (fillPipelineExtruded / …Fallback + nopick) to that twin so
   *  fs_fill_extrude samples feat_data[fid]. Checked on the bindZBuffer path BEFORE `extrude`
   *  (the shared base twin). null / miss → the base extrude twin (constant-fill path). */
  perStyleExtrude: Map<RhiPipelineHandle, { mat: Material; variant: number }> | null
  /** Opaque 3D-extruded fill (default shader): the extrude Material + the two native pipelines it
   *  twins. Routed on the bindZBuffer path. The *NoPick fields twin the pointer-events:none extrude
   *  pipelines (only built when picking is on; null otherwise). null = extrude stays raw. */
  extrude: {
    mat: Material
    write: RhiPipelineHandle
    test: RhiPipelineHandle
    matNoPick?: Material
    writeNoPick?: RhiPipelineHandle
    testNoPick?: RhiPipelineHandle
  } | null
  /** Fill-pattern (fs_fill_pattern) twins of the native fillPipelinePattern{Ground,Extruded}* pipelines.
   *  ground = cull-none / depth-off stencil (twins fillPipelinePatternGround + fallback); extruded =
   *  per-feature height / depth-write stencil (twins fillPipelinePatternExtruded + fallback). Routed
   *  before the raw else when a show resolves fillPatternUV. null = pattern stays raw. */
  pattern: {
    ground: Material
    groundWrite: RhiPipelineHandle
    groundTest: RhiPipelineHandle
    extruded: Material
    extrudedWrite: RhiPipelineHandle
    extrudedTest: RhiPipelineHandle
  } | null
}

export interface FillMaterialInputs {
  /** The injected backend RHI device (ctx.rhi) — the Material twins create their
   *  pipelines/bind-groups through it; not self-instantiated here. */
  rhi: RhiDevice
  shader: string
  format: string
  sampleCount: number
  /** Native WebGPU layout (wrapped) — required unless `rhiGroups` is given. */
  bindGroupLayout?: GPUBindGroupLayout
  /** Optional — every builder but buildGraticuleLineMaterial requires it (asserted there).
   *  buildGraticuleLineMaterial instead derives its layout from the neutral `vertexFormat`
   *  param it takes (#991 ratchet: the builder owns the backend-specific conversion). */
  vertexLayout?: GPUVertexBufferLayout
  /** Extruded-fill vertex layout (POLYGON_EXTRUDED). Only buildPatternFillMaterials reads it — it twins
   *  BOTH the ground (flat `vertexLayout` above) + extruded pattern pipelines in a single call. */
  extrudedVertexLayout?: GPUVertexBufferLayout
  pickEnabled: boolean
  /** Pick-attachment writeMask (default 0xf). The `pointer-events:none` no-pick twins pass 0 so the
   *  layer's pick id never lands in the pick texture (picks fall through). */
  pickWriteMask?: number
  /** Split GLSL ES 3.00 sources for the WebGL2 fallback device (#746). Optional — a
   *  Material whose slice has no GLSL twin yet stays WGSL-only and keeps WebGL2's
   *  explicit fail-closed error. As of #1059 the GROUND fill-pattern carries a GLSL
   *  twin too (fs_fill_pattern); only the EXTRUDED pattern + solid extrude stay
   *  WGSL-only. */
  vsCode?: string
  fsCode?: string
  /** RHI-native bind-group layout entries (#832 M2). When present they REPLACE the
   *  wrapped native `bindGroupLayout` — the WebGL2 fill Material builds its layout
   *  through rhi.createBindGroupLayout with by-name reflection entries (the block
   *  tag is the struct name 'Uniforms'). WebGPU callers omit this (byte-identical). */
  rhiGroups?: RhiBindLayoutEntry[][]
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
  const groups = inp.rhiGroups ?? [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)]
  const vertexBuffers = [toMatVB(inp.vertexLayout!)]
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

/** Build the single-colour-target flat-fill Material for the offscreen tile bake (#599 I1 —
 *  globe vector drape approach B). Same shader / vertex layout / uniform group as the screen
 *  fill (`vs_main_ecef` / `fs_fill`), and ONE variant. It carries an INERT depth-stencil
 *  (`depthCompare: 'always'`, `depthWrite: false`, no stencil) — NOT because the bake tests
 *  depth, but because `fs_fill` writes `@builtin(frag_depth)` (log-depth), and WebGPU rejects a
 *  pipeline whose fragment writes frag_depth while its `depthStencil` state is absent. So the
 *  bake pass must supply a matching depth-stencil attachment; the always/no-write config makes
 *  it a no-op (every fragment passes, nothing is written). Single colour target (no pick MRT).
 *  `cullMode: 'none'` (a baked tile is a flat patch). The flat-Mercator VS arm already consumes
 *  the tile-local `local_merc` coord unchanged, so the caller only injects `proj_params.x = 0`,
 *  `cam_h = cam_l = 0`, and an ortho `mvp`; no shader edit. */
export function buildBakeFillMaterial(inp: FillMaterialInputs): Material {
  const fmt = inp.format as 'bgra8unorm'
  const groups = inp.rhiGroups ?? [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)]
  return new Material(inp.rhi, {
    shader: inp.shader,
    vsCode: inp.vsCode,
    fsCode: inp.fsCode,
    vsEntry: 'vs_main_ecef',
    fsEntry: 'fs_fill',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(inp.vertexLayout!)],
    colorTargets: [{ format: fmt, blend: 'alpha' }],
    cullMode: 'none',
    variants: [{ depthCompare: 'always', depthWrite: false, label: 'fill-bake-rhi' }],
  })
}

/** Build the graticule lat/lon-grid line Material (#1062) — the RHI twin of the WebGPU
 *  `linePipeline` the overlay borrows there. Same polygon module, its `vs_main` / `fs_stroke`
 *  entries, and the LINE_FORMAT (stride-9 ECEF-DSFUN) vertex layout; `topology: 'line-list'`
 *  draws the graticule's segment-pair vertices as independent lines. One variant mirrors the
 *  native line-pipeline's STENCIL_WRITE depth-stencil (depth `less-equal` + write, so far-
 *  hemisphere grid lines are occluded on the globe) with alpha blend. Single colour target
 *  (the overlay never writes the pick MRT). Takes the neutral `vertexFormat` (not a prebuilt
 *  GPUVertexBufferLayout) — this builder is the designated #991 adapter seam, so it owns the
 *  backend-specific layout conversion (toVertexBufferLayout) instead of the caller (renderers
 *  stay backend-neutral). */
export function buildGraticuleLineMaterial(
  inp: FillMaterialInputs,
  vertexFormat: VertexFormat,
): Material {
  const rhi: RhiDevice = inp.rhi
  const fmt = inp.format as 'bgra8unorm'
  const groups = inp.rhiGroups ?? [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)]
  return new Material(rhi, {
    shader: inp.shader,
    vsCode: inp.vsCode,
    fsCode: inp.fsCode,
    vsEntry: 'vs_main',
    fsEntry: 'fs_stroke',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(toVertexBufferLayout(vertexFormat))],
    colorTargets: [{ format: fmt, blend: 'alpha' }],
    cullMode: 'none',
    topology: 'line-list',
    variants: [
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        label: 'graticule-line-rhi',
      },
    ],
  })
}

/** Build the 3D-extruded fill Material (vs_main_ecef_extruded / fs_fill_extrude, the POLYGON_EXTRUDED
 *  vertex layout). Variant 0 = STENCIL_WRITE (fillPipelineExtruded), 1 = STENCIL_TEST (fallback) —
 *  same depth/stencil as the flat fill (NOT ground). The per-tile z-buffer is bound at slot 1. */
export function buildExtrudeMaterial(inp: FillMaterialInputs): Material {
  const fmt = inp.format as 'bgra8unorm'
  const colorTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const },
        { format: 'rg32uint' as const, writeMask: inp.pickWriteMask ?? 0xf },
      ]
    : [{ format: fmt, blend: 'alpha' as const }]
  // #1080 — DEPTH-PREPASS colour targets: mask EVERY colour + pick write so the
  // prepass variant contributes DEPTH + STENCIL only. The fragment still runs
  // (same fs_fill_extrude entry) and writes the SAME @builtin(frag_depth) —
  // including its per-feat_id z-dither — that the depth-equal colour pass then
  // matches. A separate depth-only fragment would compute a different dither and
  // break the equal test, so the mask (not a cheaper shader) is the mechanism.
  const depthOnlyTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const, writeMask: 0 },
        { format: 'rg32uint' as const, writeMask: 0 },
      ]
    : [{ format: fmt, blend: 'alpha' as const, writeMask: 0 }]
  return new Material(inp.rhi, {
    shader: inp.shader,
    vsEntry: 'vs_main_ecef_extruded',
    fsEntry: 'fs_fill_extrude',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups: [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)],
    vertexBuffers: [toMatVB(inp.vertexLayout!)],
    colorTargets,
    cullMode: 'none',
    // Variants 0/1 = OPAQUE single-draw (STENCIL_WRITE / STENCIL_TEST) — the
    // byte-identical path opaque extrusions keep. Variants 2..5 = the #1080
    // translucent FRONT-SHELL two-draw (recordFillDraw runs prepass THEN colour
    // only when the resolved fill alpha < 1): 4/5 write DEPTH+STENCIL, then 2/3
    // blend COLOUR at depthCompare 'less-equal' with depth write OFF so only the
    // front-most surface per pixel composites once. cullMode stays 'none' (two-
    // sided) so concave interiors keep their NEAREST visible wall — the prepass
    // resolves it per pixel, unlike MapLibre's back-face cull (which drops every
    // interior-facing wall). base variant N (0/1) → prepass N+4, colour N+2.
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
      // 2 — front-shell COLOUR (write-stencil path): depth-equal (less-equal vs
      // the prepass per-pixel minimum), NO depth write; stencil already stamped
      // by variant 4, so this pass keeps it.
      {
        depthCompare: 'less-equal',
        depthWrite: false,
        stencil: { compare: 'always', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-extrude-frontshell-write-rhi',
      },
      // 3 — front-shell COLOUR (test-stencil path, fallback ancestors).
      {
        depthCompare: 'less-equal',
        depthWrite: false,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        label: 'fill-extrude-frontshell-test-rhi',
      },
      // 4 — DEPTH prepass (write-stencil path): colorWriteMask none, depth write ON.
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'always', passOp: 'replace', writeMask: 0xff, readMask: 0xff },
        colorTargets: depthOnlyTargets,
        label: 'fill-extrude-depthprepass-write-rhi',
      },
      // 5 — DEPTH prepass (test-stencil path, fallback ancestors).
      {
        depthCompare: 'less-equal',
        depthWrite: true,
        stencil: { compare: 'equal', passOp: 'keep', writeMask: 0x00, readMask: 0xff },
        colorTargets: depthOnlyTargets,
        label: 'fill-extrude-depthprepass-test-rhi',
      },
    ],
  })
}

/** Single authority for the GROUND fill-pattern Material (fs_fill_pattern). Mirrors the flat fill's
 *  GROUND twin (depthCompare 'always', depthWrite false, write/test stencil) but cullMode 'none' — the
 *  native fillPipelinePatternGround is unculled, unlike the solid ground twin's 'back'. Swaps fsEntry to
 *  'fs_fill_pattern' so the sprite atlas is sampled at the world-anchored UV. Variant 0 = STENCIL_WRITE
 *  (main pipeline), 1 = the stencil-test fallback. The WebGPU path (buildPatternFillMaterials) and the
 *  WebGL2 twin (VTR.ensureFillPatternMaterialRhi, #1059 — which passes vsCode/fsCode GLSL + the
 *  sprite_atlas/sprite_samp rhiGroups) both build the ground twin THROUGH here, so the pipeline
 *  descriptor stays byte-identical across backends. */
export function buildFillPatternGroundMaterial(inp: FillMaterialInputs): Material {
  const fmt = inp.format as 'bgra8unorm'
  const groups = inp.rhiGroups ?? [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)]
  const colorTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const },
        { format: 'rg32uint' as const, writeMask: inp.pickWriteMask ?? 0xf },
      ]
    : [{ format: fmt, blend: 'alpha' as const }]
  return new Material(inp.rhi, {
    shader: inp.shader,
    vsCode: inp.vsCode,
    fsCode: inp.fsCode,
    vsEntry: 'vs_main_ecef',
    fsEntry: 'fs_fill_pattern',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(inp.vertexLayout!)],
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
}

/** Resolve whether a fill show packs its sprite-pattern UV/repeat into the polygon Uniforms slots,
 *  and (when it does) the exact bytes to write. SINGLE AUTHORITY over the pattern-active DECISION +
 *  slot values so the WebGPU render() path and the WebGL2 twin (VTR.renderFillsRhi, #1059) can never
 *  drift: `fill_color` carries the atlas-UV bbox (u0,v0,u1,v1) and `fill_translate_x/y` carry the
 *  world repeat in Mercator metres, with `pattern_active=1`. `patternPipelineAvailable` is the
 *  backend's readiness gate (WebGPU: the pattern pipeline is built; twin: the sprite atlas is bound). */
export type FillPatternPack =
  | { active: false }
  | {
      active: true
      u0: number
      v0: number
      u1: number
      v1: number
      repeatMX: number
      repeatMY: number
    }

export function resolveFillPatternPack(
  patternUV: readonly number[] | null | undefined,
  patternRepeatM: readonly number[] | null | undefined,
  patternPipelineAvailable: boolean,
): FillPatternPack {
  if (patternUV == null || patternRepeatM == null || !patternPipelineAvailable)
    return { active: false }
  return {
    active: true,
    u0: patternUV[0]!,
    v0: patternUV[1]!,
    u1: patternUV[2]!,
    v1: patternUV[3]!,
    repeatMX: patternRepeatM[0]!,
    repeatMY: patternRepeatM[1]!,
  }
}

/** Build the fill-pattern Material twins (fs_fill_pattern). `patternGround` is built through the shared
 *  `buildFillPatternGroundMaterial` authority; `patternExtruded` mirrors buildExtrudeMaterial
 *  (vs_main_ecef_extruded, the POLYGON_EXTRUDED vertex layout, STENCIL_WRITE / STENCIL_TEST). Both swap
 *  fsEntry to 'fs_fill_pattern' so the sprite atlas is sampled at the world-anchored UV. */
export function buildPatternFillMaterials(inp: FillMaterialInputs): {
  patternGround: Material
  patternExtruded: Material
} {
  const rhi: RhiDevice = inp.rhi
  const fmt = inp.format as 'bgra8unorm'
  const groups = inp.rhiGroups ?? [wrapWebGpuBindGroupLayout(inp.bindGroupLayout!)]
  const colorTargets = inp.pickEnabled
    ? [
        { format: fmt, blend: 'alpha' as const },
        { format: 'rg32uint' as const, writeMask: inp.pickWriteMask ?? 0xf },
      ]
    : [{ format: fmt, blend: 'alpha' as const }]
  const patternGround = buildFillPatternGroundMaterial(inp)
  const patternExtruded = new Material(rhi, {
    shader: inp.shader,
    vsEntry: 'vs_main_ecef_extruded',
    fsEntry: 'fs_fill_pattern',
    format: fmt,
    sampleCount: inp.sampleCount,
    groups,
    vertexBuffers: [toMatVB(inp.extrudedVertexLayout ?? inp.vertexLayout!)],
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
  pipeline: RhiPipelineHandle,
  tileBg: GPUBindGroup,
  slotOffset: number,
  cached: FillTileBuffers,
  bindZBuffer: boolean,
  /** #1080 — when true AND this is the solid per-feature EXTRUDE draw, render the
   *  mesh TWICE: a DEPTH+STENCIL prepass (variant+4, colorWriteMask none) then a
   *  depth-`less-equal` COLOUR pass with depth write OFF (variant+2), so only the
   *  front-most surface per pixel is blended once (no back/interior show-through).
   *  Set by the caller only for a translucent extrusion (resolved fill alpha < 1);
   *  opaque extrusions and every non-extrude fill pass false → single-draw. */
  translucentFrontShell = false,
): void {
  // #717 — the draw-side VTR instance can have _fillRhi still null (the site's Astro island splits
  // the VTR module: setFillRhi(present) lands on one instance, the draw runs on another). Recover
  // the last-good fill state from the globalThis slot setFillRhi mirrors it to. In the single-instance
  // playground fillRhi is always present, so this is a no-op there.
  const eff = fillRhi ?? (globalThis as { __xgisFillRhi?: FillRhiState }).__xgisFillRhi ?? null
  if (eff) {
    let mat: Material | null = null
    let variant = -1
    // #1080 — true only when `mat` is the SOLID extrude twin (e.mat / e.matNoPick),
    // the one place the front-shell two-draw applies. Pattern-extrude + every flat
    // fill leave it false so they always take the single-draw path.
    let extrudeSolid = false
    // Match the draw pipeline to its built Material twin. IDENTITY FIRST (the normal single-instance
    // case — object equality, zero-cost, unchanged behaviour). LABEL FALLBACK second: across the dual
    // instance the recovered `eff` registry holds the OTHER instance's pipeline objects, so identity
    // fails; the two objects carry the SAME stable factory label (fill-pipeline / -ground / -fallback
    // / …, all variant-distinct — pipeline-factory.ts). `pipeline` is used ONLY to pick the twin+variant;
    // executeItems runs the twin's OWN (descriptor-equivalent) pipeline, so a label match is exact.
    // Empty label → identity only (never label-matches, so distinct-label pipelines can't collide).
    const eq = (a: RhiPipelineHandle | undefined | null): boolean =>
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
      // #1252 — per-STYLE extrude FIRST: a data-driven fill that extrudes has its own
      // feature-layout extrude twin (fs_fill_extrude samples feat_data[fid]). Identity
      // then label match, mirroring the flat perStyle lookup. extrudeSolid=true so the
      // #1080 translucent front-shell two-draw applies to data-driven extrusions too.
      let pse = eff.perStyleExtrude?.get(pipeline)
      if (!pse && eff.perStyleExtrude && pipeline.label) {
        for (const [k, v] of eff.perStyleExtrude) {
          if (eq(k)) {
            pse = v
            break
          }
        }
      }
      if (pse) {
        mat = pse.mat
        variant = pse.variant
        extrudeSolid = true
      }
      // Opaque 3D extrude: match the two extrude pipelines. The per-feature height rides in the
      // POLYGON_EXTRUDED vertex (slot 0) — the slot-1 z-buffer is unused here, so no vertex1.
      const e = eff.extrude
      if (!mat && e) {
        if (eq(e.write)) {
          mat = e.mat
          variant = 0
          extrudeSolid = true
        } else if (eq(e.test)) {
          mat = e.mat
          variant = 1
          extrudeSolid = true
        } else if (e.matNoPick && eq(e.writeNoPick)) {
          mat = e.matNoPick
          variant = 0
          extrudeSolid = true
        } else if (e.matNoPick && eq(e.testNoPick)) {
          mat = e.matNoPick
          variant = 1
          extrudeSolid = true
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
      const rhiPass = wrapWebGpuPass(encoder)
      const item = {
        variant,
        bindGroups: [wrapWebGpuBindGroup(tileBg)],
        dynamicOffsets: [[slotOffset]],
        vertex: cached.vertexBuffer,
        vertexOffset: cached.polyVertexOffset,
        vertexSize: cached.polyVertexByteLength,
        index: {
          buffer: cached.indexBuffer,
          format: 'uint32' as const,
          offset: cached.polyIndexOffset,
          size: cached.polyIndexByteLength,
        },
        count: cached.indexCount,
        indexed: true,
      }
      let draws: number
      if (translucentFrontShell && extrudeSolid) {
        // #1080 — translucent extrusion FRONT-SHELL. Same mesh, twice: variant+4
        // writes DEPTH + STENCIL only (colorWriteMask none) to fix the per-pixel
        // front-most depth; variant+2 then blends COLOUR at depthCompare
        // 'less-equal' with depth write OFF, so exactly the nearest surface per
        // pixel composites once — no back/interior wall show-through.
        draws = executeItems(mat, rhiPass, [{ ...item, variant: variant + 4 }])
        draws += executeItems(mat, rhiPass, [{ ...item, variant: variant + 2 }])
      } else {
        draws = executeItems(mat, rhiPass, [item])
      }
      g.__xgisVtrFillRhiDraws = (g.__xgisVtrFillRhiDraws ?? 0) + draws
      return
    }
  }
  throw new Error(
    `recordFillDraw: fill pipeline has no RHI Material twin — every fill draw must route through the RHI seam (§4 closed). label=${(pipeline as RhiPipelineHandle).label ?? '?'} bindZBuffer=${bindZBuffer}`,
  )
}
