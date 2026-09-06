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
import { emitLineWgsl, type LineVariantSpec } from '../../shaders/dsl/line'
import { buildLineSplitModule, emitLineSplitWgsl } from '../../shaders/dsl/line-split'
import { fitsSplitLayout } from '../../shaders/dsl/polygon-split'
import { emitLineGlsl } from '../../shaders/dsl/line-glsl'
import { lineGlslId, lineWgslId, wgslOnlyId } from '../../shaders/baked/ids'
import { LIVE, glslFor, readsWgsl, wgslFor } from './wgsl-for'

/** The entry pair the SPLIT stroke Material is built with (`splitMat`). #2572's
 *  eligibility check asks what these two reach, so the pair is named once — the
 *  legacy / max / bake Materials below choose their own fragment entry and are not
 *  what the split layout has to fit. */
const LINE_SPLIT_ENTRY_POINTS = ['vs_line', 'fs_line'] as const

/** The translucent-line offscreen ACCUM format — ONE authority for the
 *  offscreen texture (line-renderer.ensureOffscreenRhi) and the max-blend
 *  pipeline's colour target (maxMat below). WebGPU validates the pair;
 *  splitting them is the Inc-2d review's F1 (translucent lines vanish on a
 *  bgra8 canvas). */
export const LINE_OFFSCREEN_FORMAT = 'rgba8unorm' as const

// WebGL2 by-name bind-layout entries (#834 M5 slice 1) — the RHI-native twin
// of the two raw GPUBindGroupLayouts. Names come from the DSL: a uniform
// block's tag = its struct name; texture/storage names = the binding names
// (storage lowers to R32F data textures named <buffer>_tex by default).
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
  /** #2042 INC-4c — the split-bind stroke draw: when present (and a split
   *  layout was provided), `tileBG` IS the three-range split bind group and
   *  the group-0 dynamic offsets are `[tileOff, showOff]` (bindings 7 < 10;
   *  `tileOffset` above is ignored). Pattern strokes never set this — the
   *  split layout carries no sprite bindings. */
  split?: { tileOff: number; showOff: number } | null
}

export class LineDraper {
  /** Release the GPU objects this draper owns (#1578). Called by `rebuildForQuality()`
   *  before the reference is dropped — a quality flip is live-session churn, not teardown,
   *  so nothing else would ever reclaim these. */
  destroy(): void {
    this.material.destroy()
    this._pickMaterial?.destroy()
    this._maxMaterial?.destroy()
    this._bakeMaterial?.destroy()
    this._splitMaterial?.destroy()
    this._splitPickMaterial?.destroy()
    this._pickMaterial = undefined
    this._maxMaterial = undefined
    this._bakeMaterial = undefined
    this._splitMaterial = undefined
    this._splitPickMaterial = undefined
  }

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
  // #2042 INC-4c — the split-bind (Frame/Show/Tile) stroke twins, built from
  // the derived line-split module against the factory's split layout. LAZY,
  // WebGPU-only (a split layout only exists there), solid strokes only (the
  // split layout has no sprite bindings — pattern stays legacy).
  private _splitMaterial?: Material
  private _splitPickMaterial?: Material
  private _splitLayout: GPUBindGroupLayout | null = null
  /** #2042 INC-4d — cached split-eligibility verdict for THIS draper's
   *  variant: the derived line-split module must bind exactly the three
   *  split ranges at group(0), and every lane it reads must be in the
   *  Frame/Show/Tile partition (the rewriter throws otherwise). Ineligible
   *  (or throwing) variants keep the legacy bind — and the walk-skip
   *  qualification consults this BEFORE skipping packs, so their legacy
   *  strokes always have a valid ring slot. Derivation only (no emit /
   *  optimize / Material build) — cheap, once per draper. */
  private _splitOk?: boolean

  /** Provide (or replace) the split group-0 layout. Replacing retires the
   *  lazily-built split materials so the next draw rebuilds against it. */
  setSplitLayout(layout: GPUBindGroupLayout): void {
    if (this._splitLayout === layout) return
    this._splitLayout = layout
    this._splitMaterial?.destroy()
    this._splitPickMaterial?.destroy()
    this._splitMaterial = undefined
    this._splitPickMaterial = undefined
  }

  /** #2042 INC-4d — can this draper's variant draw through the split bind?
   *  See `_splitOk`. Asked of the IR: do the stroke entry points REACH any
   *  group-0 binding beyond the three split blocks? A derivation that reads
   *  outside the Frame/Show/Tile partition throws in the rewriter, and a
   *  `needsFeatureBuffer` variant throws out of `buildLineModule` (line.ts,
   *  #1605 Phase 1b) — both are ineligible, so the build stays inside the try.
   *
   *  #2572 — this used to regex the emitted module's `@group(0)` set, which is
   *  the UNION of all four line entry points; `fs_line_pattern` samples the
   *  sprite atlas, so bindings 5/6 are in every line module's text and no
   *  variant draper could ever qualify. The null variant escaped only because
   *  it short-circuited to `true` ahead of the check — an assumption that the
   *  base module fits the layout rather than a measurement. It is measured now,
   *  on the same footing as every variant. */
  splitEligible(): boolean {
    if (this._splitOk === undefined) {
      try {
        this._splitOk = fitsSplitLayout(
          buildLineSplitModule(this.variant, false),
          LINE_SPLIT_ENTRY_POINTS,
        )
      } catch {
        this._splitOk = false
      }
    }
    return this._splitOk
  }

  private splitMat(pick: boolean): Material {
    const cached = pick ? this._splitPickMaterial : this._splitMaterial
    if (cached) return cached
    const m = new Material(this.rhi, {
      // #2499 — through the seam: the baked `wgsl/line-split/{pick,nopick}` for the null
      // variant (guarded in `bakedLineIds`), the runtime emit for a composer variant.
      shader: wgslFor(
        this.rhi,
        () => emitLineSplitWgsl(this.variant, pick),
        this.bakedLineIds(pick)?.split ?? LIVE,
      ),
      vsEntry: LINE_SPLIT_ENTRY_POINTS[0],
      fsEntry: LINE_SPLIT_ENTRY_POINTS[1],
      format: this.format as 'bgra8unorm',
      sampleCount: this.sampleCount,
      groups: [
        wrapWebGpuBindGroupLayout(this._splitLayout!),
        wrapWebGpuBindGroupLayout(this.layerLayout),
      ],
      colorTargets: pick
        ? [
            { format: this.format as 'bgra8unorm', blend: 'alpha' },
            { format: 'rg32uint', writeMask: 0 }, // #1215 — same masking as the legacy pick twin
          ]
        : [{ format: this.format as 'bgra8unorm', blend: 'alpha' }],
      variants: [
        {
          depthWrite: false,
          depthCompare: 'less-equal',
          label: pick ? 'line-pipeline-split-pick-rhi' : 'line-pipeline-split-rhi',
        },
      ],
    })
    if (pick) this._splitPickMaterial = m
    else this._splitMaterial = m
    return m
  }

  constructor(
    private readonly rhi: RhiDevice,
    private readonly format: string,
    private readonly sampleCount: number,
    private readonly tileLayout: GPUBindGroupLayout,
    private readonly layerLayout: GPUBindGroupLayout,
    /** A feature-free `@stroke` composer variant (#1605), or null for the
     *  default per-segment-override / layer-colour stroke. Threaded into
     *  ALL THREE materials below (main, maxMat, bakeMat) — missing any one
     *  would silently revert that draw mode's colour to the default for a
     *  variant-carrying layer (translucent-opacity strokes and globe-drape
     *  strokes both call compute_line_color same as the main material) —
     *  and, since #1605 Phase 3, into BOTH source languages of each: the
     *  WGSL and the GLSL twin compose the same variant. */
    private readonly variant: LineVariantSpec | null = null,
  ) {
    this.material = this.buildMaterial(false)
  }

  /** The baked ids of one line pipeline, or `undefined` while a composer variant is live.
   *
   *  #1679 inc 7 — the `line` keys carry pick and entry tokens but NO variant token, and
   *  `wgsl-for.ts` serves a hit WITHOUT running the thunk. Handing an id over for a
   *  variant-carrying layer would therefore paint the variant-free stroke: no crash, no
   *  failing pipeline, just the wrong colour — the failure the `variant` doc above records
   *  having shipped once, and the same guard `point-material.ts` carries. */
  private bakedLineIds(pick: boolean) {
    if (this.variant !== null) return undefined
    return {
      wgsl: lineWgslId(pick),
      vertex: lineGlslId(pick, 'vertex'),
      fragment: lineGlslId(pick, 'fragment'),
      pattern: lineGlslId(pick, 'fragment-pattern'),
      max: lineGlslId(pick, 'fragment-max'),
      // #2499 — the split-bind twin's key (`WgslOnlyFamily`), under the same null guard.
      split: wgslOnlyId('line-split', pick),
    }
  }

  private buildMaterial(pick: boolean): Material {
    // WebGL2: entry-array groups (by-name reflection) + the GLSL twins; the
    // raw GPUBindGroupLayouts are proxy no-ops under ?forcegl2 and never
    // wrapped. Pick stays WebGPU-only (fail-closed on WebGl2Device).
    // The capability seam, not the backend's identity (#1679 inc 7, following inc 0):
    // `groups` picks the entry-array layout for the same reason the source does — the
    // device reads GLSL — so both derive from one question.
    const gl2 = !readsWgsl(this.rhi)
    const baked = this.bakedLineIds(pick)
    return new Material(this.rhi, {
      shader: wgslFor(this.rhi, () => emitLineWgsl(this.variant, pick), baked?.wgsl ?? LIVE),
      vsEntry: 'vs_line',
      fsEntry: 'fs_line',
      // #1605 Phase 3 — the WebGL2 twin composes the SAME variant as the WGSL
      // above. Passing null here (as this did before Phase 3) would silently
      // render the default stroke on WebGL2 for a variant-carrying layer: no
      // crash, no failing pipeline, just the wrong colour — which is exactly
      // why the renderer-level gate alone was not the whole fix.
      vsCode: glslFor(
        this.rhi,
        () => emitLineGlsl(this.variant, pick, 'vertex'),
        baked?.vertex ?? LIVE,
      ),
      fsCode: glslFor(
        this.rhi,
        () => emitLineGlsl(this.variant, pick, 'fragment'),
        baked?.fragment ?? LIVE,
      ),
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
          fsCode: glslFor(
            this.rhi,
            () => emitLineGlsl(this.variant, pick, 'fragment-pattern'),
            baked?.pattern ?? LIVE,
          ),
          label: pick ? 'line-pipeline-pattern-pick-rhi' : 'line-pipeline-pattern-rhi',
        },
      ],
    })
  }

  /** Build the offscreen translucent MAX-blend Material — fs_line_max into the single-sample
   *  offscreen RT (BLEND_MAX, no depth). One fragment variant (no pattern). LAZY.
   *  On webgl2 the twin carries entry-array groups + the fs_line_max GLSL (#834 M5). */
  private maxMat(): Material {
    const gl2 = !readsWgsl(this.rhi)
    const baked = this.bakedLineIds(false)
    return (this._maxMaterial ??= new Material(this.rhi, {
      shader: wgslFor(this.rhi, () => emitLineWgsl(this.variant, false), baked?.wgsl ?? LIVE),
      vsEntry: 'vs_line',
      fsEntry: 'fs_line_max',
      vsCode: glslFor(
        this.rhi,
        () => emitLineGlsl(this.variant, false, 'vertex'),
        baked?.vertex ?? LIVE,
      ),
      fsCode: glslFor(
        this.rhi,
        () => emitLineGlsl(this.variant, false, 'fragment-max'),
        baked?.max ?? LIVE,
      ),
      // The offscreen ACCUM format, not the canvas format: this pipeline draws
      // ONLY into the translucent offscreen (LINE_OFFSCREEN_FORMAT is the one
      // authority both the texture and this target derive from — a canvas-
      // format target here validated fine against the OLD canvas-format
      // offscreen, then failed silently-invisibly on WebGPU when the RHI
      // offscreen became the one set; Inc-2d review F1).
      format: LINE_OFFSCREEN_FORMAT,
      sampleCount: 1,
      groups: gl2
        ? [LINE_TILE_ENTRIES, LINE_LAYER_ENTRIES]
        : [wrapWebGpuBindGroupLayout(this.tileLayout), wrapWebGpuBindGroupLayout(this.layerLayout)],
      colorTargets: [{ format: LINE_OFFSCREEN_FORMAT, blend: 'max' }],
      variants: [{ label: 'line-pipeline-max-rhi' }], // no depth-stencil (offscreen accum)
    }))
  }

  /** Build the SINGLE-sample opaque line Material for the offscreen tile bake (#599 line-drape).
   *  Reuses emitLineWgsl (fs_line / fs_line_pattern) unchanged — the caller injects proj_params.x=0,
   *  cam=0, an ortho mvp (tile group) and a bake-mpp layer slot with viewport_height=0 (skip the
   *  screen-space width clamp), so the flat-Mercator VS arm draws the stroke into tile-local NDC just
   *  like the fill bake. Alpha blend (composites over the baked fill), depthCompare 'always' /
   *  depthWrite false (inert, matches the fill bake). WebGPU-only (the bake is WebGPU-only).
   *
   *  #1473 residue — the WGSL went through `wgslFor` in the two materials above and RAW here,
   *  the one place the pre-seam spelling survived. The guard is inert on the path that runs
   *  (this material is only ever built on WebGPU, where `wgslFor` emits), so it buys
   *  consistency rather than milliseconds: no reader has to wonder whether this site is
   *  deliberately unguarded, and a WebGL2 device that ever reached here fails on a missing
   *  source instead of paying for one it cannot read. */
  private bakeMat(): Material {
    return (this._bakeMaterial ??= new Material(this.rhi, {
      shader: wgslFor(
        this.rhi,
        () => emitLineWgsl(this.variant, false),
        this.bakedLineIds(false)?.wgsl ?? LIVE,
      ),
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
    // #2042 INC-4c — the split-bind stroke: three-range group 0 with
    // [tileOff, showOff] dynamic offsets (bindings 7 < 10). Opaque/pick
    // solid strokes only; max/bake and pattern keep the legacy bind.
    if (
      b.split &&
      this._splitLayout &&
      !b.pattern &&
      (mode === 'opaque' || mode === 'pick') &&
      this.splitEligible()
    ) {
      const draws = executeItems(this.splitMat(mode === 'pick'), pass, [
        {
          variant: 0,
          bindGroups: [b.tileBG, b.layerBG],
          dynamicOffsets: [[b.split.tileOff, b.split.showOff], [b.layerOffset]],
          count: 6,
          indexed: false,
          instanceCount: b.segmentCount,
        },
      ])
      const g = globalThis as { __xgisVtrSplitStrokeDraws?: number }
      g.__xgisVtrSplitStrokeDraws = (g.__xgisVtrSplitStrokeDraws ?? 0) + draws
      return
    }
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
