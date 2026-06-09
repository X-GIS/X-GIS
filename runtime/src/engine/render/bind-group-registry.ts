// ═══ BindGroupRegistry — base bind-group + fill-pipeline resource
//     registry (Cluster C; the "thin-C" final VTR-decomposition unit) ═══
//
// Extracted from VectorTileRenderer (Cluster C per
// .omc/plans/vtr-decomposition-2026-06-09.md §1 + the U2/U3/U4
// re-sequencing decision .omc/plans/vtr-u2-u4-resequence-2026-06-09.md,
// where this lands LAST as "U4-prime"). After Cluster D
// (FeatureDataBinder) and Cluster A (GpuTileStore) own their halves of
// the bind-group rebuild, what remains is a pure resource registry:
//   • the two SOURCE-level bind groups `tileBgDefault` / `tileBgFeature`
//     (base layout + palette/sprite + uniform-ring),
//   • the base bind-group LAYOUT,
//   • the palette + sprite atlas views/sampler (Cluster C resources),
//   • the bind-group rebuild epoch (RenderBundle cache invalidation),
//   • ALL fill-PIPELINE field pairs + their setters (same cohesion
//     class — GPU resources resolved for a draw).
//
// VTR injects it as `private readonly _bindGroups = new
// BindGroupRegistry(device)` and keeps THIN FORWARDERS for the external
// setter surface (`setExtrudedPipelines` / `setGroundPipelines` /
// `setPatternPipelines` / `setPatternExtrudedPipelines` / `setOITPipeline`
// / `setBindGroupLayout` / `setPaletteResources` / `setSpriteAtlasView`
// — called from renderer.ts / map.ts / source-manager.ts / render-loop.ts)
// so their signatures are unchanged.
//
// THE TWO INVARIANTS this registry must NOT violate:
//   1. uniformRing STAYS on VTR (read at 14 hot-loop byte-pack sites; plan
//      §5 DO-NOT-SPLIT #1). The registry receives the ring BUFFER as a
//      `rebuildBase` argument — it never owns the ring.
//   2. The onGrow SINGLE-TRIGGER fan-out (base → per-tile; the iter-348/349
//      stale-colour fix, plan §5 DO-NOT-SPLIT #3) is COORDINATED BY VTR.
//      The registry owns only the BASE half (`rebuildBase`); VTR calls it
//      then the FeatureDataBinder per-tile rebuild, in that order, from the
//      single `UniformRing.onGrow` wire. The registry holds NO reference to
//      the binder or the store — `rebuildBase` takes the feature layout +
//      feature data buffer as call arguments.
//
// The base `tileBgFeature` group reads the Cluster-D feature data buffer
// (a forward C→D edge); it arrives as a `rebuildBase` argument, so the
// registry never references FeatureDataBinder. Bindings are byte-identical
// to the old in-VTR `rebuildTileBindGroups` (0 ring, 1 feature-data,
// 2 palette atlas, 4 palette sampler, 5 sprite atlas, 6 sprite sampler).

import { Epoch } from '../_cache/versioned-state'

// Bind-group binding range size for binding 0 (the uniform ring). Mirrors
// the VTR module-local `UNIFORM_SIZE` (the WGSL `Uniforms` struct size) —
// the source-level bind groups bind the ring at this size, exactly as the
// in-VTR rebuild did. Kept in lockstep with VTR's constant by value (240,
// the camera-relative RTC layout).
const UNIFORM_SIZE = 240

export class BindGroupRegistry {
  private device: GPUDevice

  constructor(device: GPUDevice) {
    this.device = device
  }

  /** Uniform-only layout — stays pinned to the base `bindGroupLayout`
   *  even when `render()` swaps `lastBindGroupLayout` for a variant layout. */
  private baseBindGroupLayout: GPUBindGroupLayout | null = null
  /** Tile bind group referencing the ring with dynamic offset (uniform only). */
  private tileBgDefault: GPUBindGroup | null = null
  /** Tile bind group referencing the ring + feature storage (variant shaders). */
  private tileBgFeature: GPUBindGroup | null = null
  private paletteColorAtlasView: GPUTextureView | null = null
  private paletteSampler: GPUSampler | null = null
  private spriteAtlasView: GPUTextureView | null = null
  /** iter-226 — Bumped on every base rebuild. Rebuilds replace
   *  `tileBgDefault` / `tileBgFeature` (shared bind groups used by tiles
   *  whose per-tile `featureBindGroup` is null), so cached bundles holding
   *  refs to the prior generation must re-encode. Independent of per-tile
   *  uploads; fires on uniform-ring grow + sprite-atlas / palette rewire.
   *  iter-282 — Epoch instance instead of raw counter. */
  private readonly _bindGroupEpoch = new Epoch()

  /** Pipeline pair for tiles with per-feature extrude heights (i.e.
   *  `cached.extruded`). The orchestrator (renderer.ts) sets
   *  these once at init via `setExtrudedPipelines`; VTR swaps them in
   *  for the fill draw when the cached tile carries extruded geometry. Null
   *  before `setExtrudedPipelines` runs — flat-only render still works
   *  because the branch checks `cached.extruded` first. */
  private fillPipelineExtruded: GPURenderPipeline | null = null
  private fillPipelineExtrudedFallback: GPURenderPipeline | null = null
  /** Ground-layer fill pipelines — depth test/write disabled.
   *  Selected when `currentExtrudeMode === 'none'` so coplanar
   *  ground polygons (water, landuse, roads-as-fill, etc.) resolve
   *  via painter's order instead of the layer_depth_offset NDC
   *  bias hack. Null until setGroundPipelines runs. */
  private fillPipelineGround: GPURenderPipeline | null = null
  private fillPipelineGroundFallback: GPURenderPipeline | null = null
  /** OIT translucent extrude pipeline — Weighted-Blended OIT MRT
   *  output. Selected when render() runs with phase='oit-fill'
   *  (translucent extrude bucket). Null until setOITPipeline runs. */
  private fillPipelineExtrudedOIT: GPURenderPipeline | null = null
  private fillPipelinePatternGround: GPURenderPipeline | null = null
  private fillPipelinePatternGroundFallback: GPURenderPipeline | null = null
  private fillPipelinePatternExtruded: GPURenderPipeline | null = null
  private fillPipelinePatternExtrudedFallback: GPURenderPipeline | null = null

  /** Provide the per-feature extrusion fill pipelines. Called once
   *  per frame from map.ts immediately before render() so VTR can
   *  pick between flat and extruded fill paths on a per-tile basis
   *  without threading another parameter through `render()`. */
  setExtrudedPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelineExtruded = main
    this.fillPipelineExtrudedFallback = fallback
  }

  /** Provide the depth-disabled ground-layer fill pipelines. Same
   *  shader as the regular fill, but the depth state is OFF so
   *  painter's order between ground polygons is decided by GPU
   *  command order — the way painter's order is supposed to work,
   *  without log-depth precision noise + layer_depth_offset
   *  arithmetic fighting at coplanar fragments. */
  setGroundPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelineGround = main
    this.fillPipelineGroundFallback = fallback
  }

  /** iter-183 — fill-pattern Stage 2 pattern ground pipelines. Caller
   *  hands the `fillPipelinePatternGround` + fallback pair built by
   *  MapRenderer. VTR selects them in place of the regular ground
   *  pipelines when `show.fillPatternUV` is populated (the iconStage
   *  has resolved the sprite atlas UV bbox via map.ts). */
  setPatternPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelinePatternGround = main
    this.fillPipelinePatternGroundFallback = fallback
  }

  /** iter-186 — fill-extrusion-pattern Stage 2 variants. Mirror of
   *  setPatternPipelines for the extruded (per-feature z attribute)
   *  vertex path. */
  setPatternExtrudedPipelines(main: GPURenderPipeline, fallback: GPURenderPipeline): void {
    this.fillPipelinePatternExtruded = main
    this.fillPipelinePatternExtrudedFallback = fallback
  }

  /** Provide the OIT translucent extrude pipeline. Used when
   *  render() runs with phase='oit-fill': translucent buildings
   *  draw their fills into the accum + revealage MRT pair so a
   *  later compose pass can blend them order-independently onto
   *  the opaque framebuffer. */
  setOITPipeline(p: GPURenderPipeline): void {
    this.fillPipelineExtrudedOIT = p
  }

  /** Set bind group layout (must be called before tiles arrive). The
   *  uniform-ring `ensureUniformRing` side effect stays on VTR (the ring
   *  is VTR-owned) — VTR's forwarder calls it. */
  setBindGroupLayout(layout: GPUBindGroupLayout): void {
    this.baseBindGroupLayout = layout
  }

  /** P3 Step 3c — set palette atlas resources used by binding 2 + 4
   *  on the polygon bind-group layout. Caller (MapRenderer) hands
   *  the 1×1 stub by default; once `uploadPalette` lands the real
   *  atlas, the base rebuild runs in place (VTR's forwarder fans out). */
  setPaletteResources(colorAtlasView: GPUTextureView, sampler: GPUSampler): void {
    this.paletteColorAtlasView = colorAtlasView
    this.paletteSampler = sampler
  }

  /** iter-181 — fill-pattern Stage 2 infra mirror of
   *  setPaletteResources. Sprite atlas texture at binding 5; sampler
   *  reuses `paletteSampler` at binding 4. Stub 1×1 white via the
   *  initial MapRenderer.setSpriteAtlas push; replaced when the
   *  IconStage finishes loading the real sprite atlas. */
  setSpriteAtlasView(view: GPUTextureView): void {
    this.spriteAtlasView = view
  }

  // ── Hot-loop getters (cheap monomorphic field derefs) ──
  /** The base bind-group layout, or null before `setBindGroupLayout`. */
  baseLayout(): GPUBindGroupLayout | null {
    return this.baseBindGroupLayout
  }
  /** The source-level uniform-only tile bind group (`tileBgDefault`). */
  baseGroup(): GPUBindGroup | null {
    return this.tileBgDefault
  }
  /** The source-level feature bind group (`tileBgFeature`); null on the
   *  MVT/PMTiles path (per-tile groups handle it). */
  featureGroup(): GPUBindGroup | null {
    return this.tileBgFeature
  }
  /** The bind-group rebuild epoch (RenderBundle cache key state). */
  epoch(): number {
    return this._bindGroupEpoch.value()
  }
  /** Snapshot of the palette/sprite atlas resources (Cluster C) the
   *  FeatureDataBinder needs to compose per-tile feature bind groups.
   *  Passed by value per call so the binder never holds a VTR reference. */
  paletteResources(): import('./feature-data-binder').PaletteResources {
    return {
      paletteColorAtlasView: this.paletteColorAtlasView,
      paletteSampler: this.paletteSampler,
      spriteAtlasView: this.spriteAtlasView,
    }
  }

  // ── Fill-pipeline getters (cheap monomorphic field derefs) ──
  extrudedPipeline(): GPURenderPipeline | null { return this.fillPipelineExtruded }
  extrudedPipelineFallback(): GPURenderPipeline | null { return this.fillPipelineExtrudedFallback }
  groundPipeline(): GPURenderPipeline | null { return this.fillPipelineGround }
  groundPipelineFallback(): GPURenderPipeline | null { return this.fillPipelineGroundFallback }
  extrudedOITPipeline(): GPURenderPipeline | null { return this.fillPipelineExtrudedOIT }
  patternGroundPipeline(): GPURenderPipeline | null { return this.fillPipelinePatternGround }
  patternGroundPipelineFallback(): GPURenderPipeline | null { return this.fillPipelinePatternGroundFallback }
  patternExtrudedPipeline(): GPURenderPipeline | null { return this.fillPipelinePatternExtruded }
  patternExtrudedPipelineFallback(): GPURenderPipeline | null { return this.fillPipelinePatternExtrudedFallback }

  /** Rebuild the two SOURCE-level bind groups (`tileBgDefault` +
   *  `tileBgFeature`) against the CURRENT uniform ring + feature data
   *  buffer. This is the BASE half of the iter-348/349 onGrow fan-out;
   *  VTR coordinates the trigger and calls the FeatureDataBinder per-tile
   *  rebuild AFTER this (base → per-tile order). The ring buffer + feature
   *  layout + feature data buffer arrive as ARGUMENTS — the registry reads
   *  its own palette/sprite fields and never references the ring, binder,
   *  or store. No-op until the ring + base layout + palette/sprite are all
   *  wired (setup-time calls short-circuit, matching the original guards).
   *  Bindings are byte-identical to the prior in-VTR rebuild. */
  rebuildBase(
    ringBuf: GPUBuffer | null | undefined,
    featureLayout: GPUBindGroupLayout | null,
    featureDataBuffer: GPUBuffer | null,
  ): void {
    if (!ringBuf || !this.baseBindGroupLayout) return
    // Palette bindings 2/4 are part of mr-baseBindGroupLayout /
    // mr-featureBindGroupLayout. Defer bind-group construction until
    // both palette resources are wired so we don't ever build a
    // group missing those entries.
    if (!this.paletteColorAtlasView || !this.paletteSampler || !this.spriteAtlasView) return
    this.tileBgDefault = this.device.createBindGroup({
      label: 'vtr-tileBg-default',
      layout: this.baseBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: ringBuf, offset: 0, size: UNIFORM_SIZE } },
        { binding: 2, resource: this.paletteColorAtlasView },
        { binding: 4, resource: this.paletteSampler },
        { binding: 5, resource: this.spriteAtlasView },
        { binding: 6, resource: this.paletteSampler },
      ],
    })
    if (featureLayout && featureDataBuffer) {
      this.tileBgFeature = this.device.createBindGroup({
        label: 'vtr-tileBg-feature',
        layout: featureLayout,
        entries: [
          { binding: 0, resource: { buffer: ringBuf, offset: 0, size: UNIFORM_SIZE } },
          { binding: 1, resource: { buffer: featureDataBuffer } },
          { binding: 2, resource: this.paletteColorAtlasView },
          { binding: 4, resource: this.paletteSampler },
          { binding: 5, resource: this.spriteAtlasView },
          { binding: 6, resource: this.paletteSampler },
        ],
      })
    } else {
      this.tileBgFeature = null
    }
    // iter-226 — tileBg{Default,Feature} are new refs after this
    // function. Any cached RenderBundle that held the prior refs is
    // now stale; bump the epoch so the next cache lookup misses.
    // iter-282 — Epoch.bump() supersedes the raw `++` (single
    // mutation point; consumers read via .value() in key literals).
    this._bindGroupEpoch.bump()
  }
}
