// ═══ Line adapter over the generic Material ═══
//
// The main (non-translucent) line draw through the generic core. Line is the most
// structurally distinct primitive so far: 2 bind groups BOTH with per-draw dynamic
// offsets (tile + layer ring), an INSTANCED draw (6 verts × segmentCount), 2
// fragment variants (fs_line / fs_line_pattern), and it REUSES the VTR tile bind-
// group layout (so its pipeline is layout-compatible with VTR-built tile groups).
// The translucent MAX-blend / composite pass is a render-graph concern, separate.

import type {
  RhiBindGroup,
  RhiBindGroupLayout,
  RhiBindLayoutEntry,
  RhiDevice,
  RhiRenderPass,
} from '@xgis/engine'
import { wrapWebGpuBindGroupLayout } from '@xgis/rhi-webgpu'
import { Material, executeItems } from '@xgis/engine'
import { emitLineWgsl } from '@xgis/map'
import { emitLineGlsl } from '../../shaders/dsl/line-glsl'

// WebGL2 by-name bind-layout entries (#834 M5 slice 1) — the RHI-native twin
// of the two raw GPUBindGroupLayouts. Names come from the DSL: a uniform
// block's tag = its struct name; texture/storage names = the binding names
// (storage lowers to R32F data textures named <buffer>_tex by emulateStorage).
const LINE_TILE_ENTRIES: RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'uniform', dynamic: true, name: 'TileUniforms' },
  // sprite_atlas/sprite_samp — the fs_line_pattern variant samples the sprite
  // atlas (Mapbox line-pattern, #834 M5 slice 5). The solid fs_line program
  // has no such uniform: the by-name reflection resolves a null location and
  // skips the wiring, so the extra entries are inert on variant 0. Every tile
  // bind group supplies a view/sampler (the real atlas or VTR's white stub).
  { binding: 5, kind: 'texture', name: 'sprite_atlas' },
  { binding: 6, kind: 'sampler', name: 'sprite_samp' },
]
const LINE_LAYER_ENTRIES: RhiBindLayoutEntry[] = [
  { binding: 0, kind: 'uniform', dynamic: true, name: 'LineLayer' },
  { binding: 1, kind: 'storage', name: 'segments' },
  { binding: 2, kind: 'storage', name: 'shapes' },
  { binding: 3, kind: 'storage', name: 'shape_segments' },
]

/** One line-segment batch (§4 batch-seam). Both bind groups arrive as RhiBindGroup:
 *  the layer group is built via `rhi.createBindGroup` (LineRenderer.createLayer-
 *  BindGroup); the VTR tile group is still raw + wrapped at the renderer call site.
 *  Passed straight through — NO re-wrapping (a wrap of an already-RHI handle would
 *  double-wrap → unwrap yields a Native wrapper, not a GPUBindGroup → empty draw). */
export interface LineBatch {
  tileBG: RhiBindGroup
  layerBG: RhiBindGroup
  tileOffset: number
  layerOffset: number
  pattern: boolean
  segmentCount: number
}

export class LineDraper {
  private readonly material: Material // non-pick: single colour target, fs_line / fs_line_pattern
  // pick pass: colour + rg32uint pick MRT. The line pick fragment writes vec2u(0,0) — lines are
  // not pickable; the target exists only for opaque-pass MRT compatibility when picking is on. The
  // pick target carries `writeMask: 0` (#1215): the fill drawn earlier in the same opaque pass wrote
  // its real feature id into this attachment, and an unmasked (0,0) from a stroke covering the fill
  // would CLOBBER it (interaction-controller decodes either channel = 0 as a miss), so a click on a
  // road over a country polygon would miss. Masking pick output keeps the fill's id. LAZY so the
  // non-pick path never builds the rg32uint MRT pipeline (which WebGl2Device fail-closes on).
  private _pickMaterial?: Material
  // offscreen translucent MAX-blend pass: fs_line_max, blend 'max', SINGLE-sample (the offscreen RT
  // is single-sample), no depth. LAZY (built on the first translucent draw).
  private _maxMaterial?: Material
  // #599 line-drape: opaque line material for the offscreen tile bake (globe vector great-circle
  // drape approach B). Same shader (fs_line / fs_line_pattern) as the screen line, but SINGLE-sample
  // (the bake RT is single-sample, like the fill bake) and depthCompare 'always' / depthWrite false —
  // fs_line writes @builtin(frag_depth), so WebGPU requires a depthStencil state + a matching depth
  // attachment (the bake pass supplies depth24plus-stencil8), and 'always' makes it an inert no-op
  // (never tested, never written) so overlapping segments composite by draw order. LAZY.
  private _bakeMaterial?: Material

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
    private readonly tileLayout: GPUBindGroupLayout,
    private readonly layerLayout: GPUBindGroupLayout,
  ) {
    this.material = this.buildMaterial(false)
  }

  private buildMaterial(pick: boolean): Material {
    // WebGL2: entry-array groups (by-name reflection) + the GLSL twins; the
    // raw GPUBindGroupLayouts are proxy no-ops under ?forcegl2 and never
    // wrapped. Pick stays WebGPU-only (fail-closed on WebGl2Device).
    const gl2 = this.rhi.backend === 'webgl2'
    return new Material(this.rhi, {
      shader: emitLineWgsl(pick),
      vsEntry: 'vs_line',
      fsEntry: 'fs_line',
      vsCode: gl2 ? emitLineGlsl(pick, 'vertex') : undefined,
      fsCode: gl2 ? emitLineGlsl(pick, 'fragment') : undefined,
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: gl2
        ? [LINE_TILE_ENTRIES, LINE_LAYER_ENTRIES]
        : [wrapWebGpuBindGroupLayout(this.tileLayout), wrapWebGpuBindGroupLayout(this.layerLayout)],
      colorTargets: pick
        ? [
            { format: this.format as 'bgra8unorm', blend: 'alpha' },
            { format: 'rg32uint', writeMask: 0 }, // #1215: strokes carry no id; masking stops (0,0) clobbering the fill's pick
          ]
        : [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        {
          depthWrite: false,
          depthCompare: 'less-equal',
          label: pick ? 'line-pipeline-pick-rhi' : 'line-pipeline-rhi',
        },
        {
          depthWrite: false,
          depthCompare: 'less-equal',
          fsEntry: 'fs_line_pattern',
          // GLSL has one main per stage — the pattern variant carries its own
          // emitted fragment twin (#834 M5 slice 5).
          fsCode: gl2 ? emitLineGlsl(pick, 'fragment-pattern') : undefined,
          label: pick ? 'line-pipeline-pattern-pick-rhi' : 'line-pipeline-pattern-rhi',
        },
      ],
    })
  }

  /** Build the offscreen translucent MAX-blend Material — fs_line_max into the single-sample
   *  offscreen RT (BLEND_MAX, no depth). One fragment variant (no pattern). LAZY.
   *  On webgl2 the twin carries entry-array groups + the fs_line_max GLSL (#834 M5). */
  private maxMat(): Material {
    const gl2 = this.rhi.backend === 'webgl2'
    return (this._maxMaterial ??= new Material(this.rhi, {
      shader: emitLineWgsl(false),
      vsEntry: 'vs_line',
      fsEntry: 'fs_line_max',
      vsCode: gl2 ? emitLineGlsl(false, 'vertex') : undefined,
      fsCode: gl2 ? emitLineGlsl(false, 'fragment-max') : undefined,
      format: this.format as 'bgra8unorm',
      sampleCount: 1,
      groups: gl2
        ? [LINE_TILE_ENTRIES, LINE_LAYER_ENTRIES]
        : [wrapWebGpuBindGroupLayout(this.tileLayout), wrapWebGpuBindGroupLayout(this.layerLayout)],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'max' }],
      variants: [{ label: 'line-pipeline-max-rhi' }], // no depth-stencil (offscreen accum)
    }))
  }

  /** Build the SINGLE-sample opaque line Material for the offscreen tile bake (#599 line-drape).
   *  Reuses emitLineWgsl (fs_line / fs_line_pattern) unchanged — the caller injects proj_params.x=0,
   *  cam=0, an ortho mvp (tile group) and a bake-mpp layer slot with viewport_height=0 (skip the
   *  screen-space width clamp), so the flat-Mercator VS arm draws the stroke into tile-local NDC just
   *  like the fill bake. Alpha blend (composites over the baked fill), depthCompare 'always' /
   *  depthWrite false (inert, matches the fill bake). WebGPU-only (the bake is WebGPU-only). */
  private bakeMat(): Material {
    return (this._bakeMaterial ??= new Material(this.rhi, {
      shader: emitLineWgsl(false),
      vsEntry: 'vs_line',
      fsEntry: 'fs_line',
      format: this.format as 'bgra8unorm',
      sampleCount: 1,
      groups: [
        wrapWebGpuBindGroupLayout(this.tileLayout),
        wrapWebGpuBindGroupLayout(this.layerLayout),
      ],
      colorTargets: [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        { depthWrite: false, depthCompare: 'always', label: 'line-bake-rhi' },
        {
          depthWrite: false,
          depthCompare: 'always',
          fsEntry: 'fs_line_pattern',
          label: 'line-bake-pattern-rhi',
        },
      ],
    }))
  }

  /** The layer (group 1) bind-group layout of the main material — the
   *  WebGL2 path builds per-tile layer bind groups against it (#834 M5). */
  layerLayoutRhi(): RhiBindGroupLayout {
    return this.material.layout(1)
  }

  /** The tile (group 0) layout — same consumer as `layerLayoutRhi`. */
  tileLayoutRhi(): RhiBindGroupLayout {
    return this.material.layout(0)
  }

  draw(
    pass: RhiRenderPass,
    b: LineBatch,
    mode: 'opaque' | 'pick' | 'max' | 'bake' = 'opaque',
  ): void {
    const material =
      mode === 'pick'
        ? (this._pickMaterial ??= this.buildMaterial(true))
        : mode === 'max'
          ? this.maxMat()
          : mode === 'bake'
            ? this.bakeMat()
            : this.material
    executeItems(material, pass, [
      {
        variant: mode === 'max' ? 0 : b.pattern ? 1 : 0, // the MAX material has a single variant
        bindGroups: [b.tileBG, b.layerBG],
        dynamicOffsets: [[b.tileOffset], [b.layerOffset]],
        count: 6,
        indexed: false,
        instanceCount: b.segmentCount,
      },
    ])
  }
}
