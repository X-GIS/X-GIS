// ═══ X-GIS RenderLoop — the per-frame GPU render method ═══
//
// Extracted VERBATIM from `XGISMap.renderFrame` (map.ts). This is a
// RELOCATION, not a decoupling: `renderFrame` reads ~30 private XGISMap
// fields + a few render-only privates + the renderer / ctx / stages, so
// RenderLoop holds the owning map and reaches its members through a
// typed `host` view. Behaviour is byte-identical to the inline method —
// the ONLY mechanical change is `this.X` → `this.host.X` for every
// relocated map-member reference (verified: no nested `function`/`class`
// rebinds `this`, so every `this.` inside the moved body refers to the
// map). The render-only `_resolveFillPatterns` helper moved alongside
// (called solely by `render`); its self-call stays `this._resolveFillPatterns()`.
//
// `XGISMap.renderFrame` is now a one-line delegate to `RenderLoop.render`,
// keeping the public/internal call surface (render-loop tick, tests)
// unchanged.

import { evaluate, makeEvalProps, resolveColor } from '@xgis/compiler'
import { markStart as perfMarkStart, markEnd as perfMarkEnd, flushPerFrameMarks } from './__profile__/perf-marks'
import { resizeCanvas, getSampleCount, getMaxDpr, isPickEnabled } from './gpu/gpu'
import { DEBUG_OVERDRAW } from './debug-flags'
import { WORLD_MERC, TILE_PX } from './gpu/gpu-shared'
import { projectWgsl } from './projection/projection-wgsl-mirror'
import { globeForward } from './projection/globe'
import { resolveNumberShape } from './render/paint-shape-resolve'
import { resolveLabelEffectiveDef, makeLabelProjectors } from './render-loop-helpers'
import { invalidateResolvedShowCache } from './render/resolved-show'
import { computeSliceKey } from '../data/eval/filter-eval'
import { TextStage, type TextStageOptions } from './text/text-stage'
import { IconStage } from './sprite/icon-stage'
import { resolveText } from './text/text-resolver'
import { hexToRgba, featureAnchor } from './feature-helpers'
import { type ShowCommand } from './render/renderer'
import { type FrameContext } from './render/frame-context'
import { buildSceneView } from './render/scene-view'
import { opaquePass } from './render/passes/opaque-pass'
import { oitPass } from './render/passes/oit-pass'
import { translucentPass } from './render/passes/translucent-pass'
import { pointsPass } from './render/passes/points-pass'
import { XGISMap } from './map'

/** Typed view of the XGISMap members the relocated render path touches.
 *  Derived from XGISMap with `Pick` so the field/method types stay in
 *  exact lock-step with the class (zero drift, no hand-maintained type
 *  list). Every member listed here was relaxed from `private` to
 *  no-modifier (package-internal) in map.ts so this Pick can see it; the
 *  members stay OFF the public API surface (no `public` keyword). The
 *  render-only `_resolveFillPatterns` is NOT here — it moved into
 *  RenderLoop. `renderLoop`, `classifyVectorTileShows`, and
 *  `groupOpaqueBySource` remain on the map and are reached via this view. */
export type RenderLoopHost = Pick<XGISMap,
  | '_elapsedMs'
  | '_featureExprsCache'
  | '_flickerFirstFrame'
  | '_flickerLastFrame'
  | '_flickerLog'
  | '_frameCount'
  | '_labelDispatchHits'
  | '_labelDispatchMisses'
  | '_lastSigBearing'
  | '_lastSigCX'
  | '_lastSigCY'
  | '_lastSigH'
  | '_lastSigPitch'
  | '_lastSigW'
  | '_lastSigZoom'
  | '_needsRender'
  | '_pendingLabelDebugHook'
  | '_pendingTraceRecorder'
  | '_prevLabelDispatchSig'
  | '_rasterShow'
  | '_scratchEmittedPointNames'
  | '_scratchEmittedTextNames'
  | '_spriteAtlasViewPushed'
  | '_startTime'
  | '_stats'
  | '_statsPanel'
  | 'backgroundRenderer'
  | 'camera'
  | 'classifyVectorTileShows'
  | 'ctx'
  | 'fontTypography'
  | 'glyphProviders'
  | 'glyphsUrl'
  | 'gpuTimer'
  | 'groupOpaqueBySource'
  | 'iconStage'
  | 'inlineGlyphs'
  | 'lineRenderer'
  | 'overlays'
  | 'pointRenderer'
  | 'projectionName'
  | 'rasterRenderer'
  | 'rawDatasets'
  | 'renderLoop'
  | 'renderTargets'
  | 'renderer'
  | 'showCommands'
  | 'spriteUrl'
  | 'textStage'
  | 'vtSources'
>

export class RenderLoop {
  private readonly host: RenderLoopHost

  /** The single REUSED per-frame FrameContext. Lazily built on the first
   *  rendered frame, then mutated in place every subsequent frame — the
   *  60 Hz loop is allocation-paranoid (see the arena / scratch-reuse
   *  patterns in render()), so a fresh object per frame is forbidden. Its
   *  fields are repopulated at the SAME points the equivalent locals were
   *  computed before this struct existed, so behaviour is byte-identical. */
  private _ctx: FrameContext | null = null

  constructor(map: XGISMap) {
    // Hold the owning map through the typed host view. The Pick-based
    // RenderLoopHost gives compile-time field/method checking while
    // keeping these members internal (not public) on XGISMap.
    this.host = map
  }

  render(): void {
    perfMarkStart('frame.total')
    perfMarkStart('frame.prep')
    this.host._stats.beginFrame()
    // iter-241 (Plan AAA B.2) — TextStage FrameArena watermark
    // reset. Per-label scratch allocations during prepare() carve
    // from the arena; this call invalidates last frame's
    // sub-views. Safe — TextStage.prepare runs INSIDE this frame
    // and consumers of arena views don't outlive the prepare →
    // render → end sequence.
    this.host.textStage?.beginFrame()
    resizeCanvas(this.host.ctx)
    this._resolveFillPatterns()

    // Seed the animation clock on first rendered frame, then compute the
    // elapsed wall-clock milliseconds. Everything time-interpolated
    // (opacity today, color/width/etc. in later PRs) reads this value.
    if (this.host._startTime === null) this.host._startTime = performance.now()
    this.host._elapsedMs = performance.now() - this.host._startTime

    let projType = {
      mercator: 0, equirectangular: 1, natural_earth: 2,
      orthographic: 3, azimuthal_equidistant: 4, stereographic: 5,
      oblique_mercator: 6, globe: 7,
    }[this.host.projectionName] ?? 0
    // Azimuthal-when-tilted: ortho/azimuthal_eq/stereographic are exact
    // 2D discs at pitch=0 but promote to the true 3D sphere once the
    // user tilts. At pitch>0 we drive the globe vertex path (projType 7
    // → proj_globe) with the camera's ORTHOGRAPHIC orbit matrix
    // (globeOrtho was set in setProjection). At pitch=0 they stay on
    // their exact 2D projection so the CPU/GPU consistency contract and
    // each projection's identity (stereographic ≠ ortho) are preserved.
    const azimuthalTilted = (projType >= 3 && projType <= 5) && this.host.camera.pitch > 0
    if (azimuthalTilted) projType = 7
    this.host.camera.globeMode = (projType === 7)
    // Hand the resolved projection kind to the camera so zoomAt can pick
    // a projection-correct cursor anchor (orthographic needs the spherical
    // inverse, not the flat-Mercator-plane unproject).
    this.host.camera.projType = projType
    const { device, context, canvas } = this.host.ctx
    const w = canvas.width, h = canvas.height
    if (w === 0 || h === 0) { requestAnimationFrame(this.host.renderLoop); return }

    // DSFUN precision removes the old `maxSrcLevel + 6` clamp: tile vertices
    // are now stored as f64-equivalent (high/low) Mercator-meter pairs, so
    // a z=5 parent tile survives camera zoom 22 with sub-millimeter jitter.
    // Zoom 22 is a universal cap across every source.
    this.host.camera.maxZoom = 22

    // Clamp camera Y (latitude bounded), wrap X to a single world.
    // Defensive: a non-finite centerX/Y/zoom upstream (malformed hash,
    // buggy diagnostics replay, JS divide-by-zero in a host adapter)
    // would propagate NaN through Math.min/max — the clamp doesn't
    // self-correct since NaN compares false either way. Reset to a
    // sensible default before the clamp so one bad assignment doesn't
    // lock the camera into NaN matrices for every subsequent frame.
    if (!Number.isFinite(this.host.camera.centerX)) this.host.camera.centerX = 0
    if (!Number.isFinite(this.host.camera.centerY)) this.host.camera.centerY = 0
    if (!Number.isFinite(this.host.camera.zoom)) this.host.camera.zoom = 0
    if (!Number.isFinite(this.host.camera.bearing)) this.host.camera.bearing = 0
    // pitch goes through a setter (iter 368) so this is a defensive
    // mirror; the setter rejects non-finite, but a direct field
    // assignment from a host adapter could still slip past.
    if (!Number.isFinite(this.host.camera.pitch)) this.host.camera.pitch = 0
    if (!Number.isFinite(this.host.camera.minZoom)) this.host.camera.minZoom = 0
    if (!Number.isFinite(this.host.camera.maxZoom)) this.host.camera.maxZoom = 22
    const MAX_MERC = 20037508.34
    const WORLD_MERC_FULL = MAX_MERC * 2 // full circumference
    const dpr = typeof window !== 'undefined' ? Math.min(window.devicePixelRatio || 1, getMaxDpr()) : 1
    const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, this.host.camera.zoom)
    const visHalfY = (h / dpr) * mpp / 2
    const maxY = Math.max(0, MAX_MERC - visHalfY)
    this.host.camera.centerY = Math.max(-maxY, Math.min(maxY, this.host.camera.centerY))

    // X wrap — camera is allowed to pan infinitely in either direction, but
    // the renderer's world-copy enumeration (`WORLD_COPIES = [-2..+2]`) is
    // expressed as a STATIC offset from the camera's primary world. If
    // camera.centerX drifts outside `[-MAX_MERC, +MAX_MERC]` the outer
    // copies on one side fall off the quadtree's `ox` guard (tiles.ts)
    // while the other side is empty, producing a visible "window" of map
    // inside a black background when panning past ±360° lon. Wrap back
    // into one world so the WORLD_COPIES math is always correct.
    if (this.host.camera.centerX > MAX_MERC) {
      const over = this.host.camera.centerX + MAX_MERC
      this.host.camera.centerX = ((over % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    } else if (this.host.camera.centerX < -MAX_MERC) {
      const under = this.host.camera.centerX + MAX_MERC
      this.host.camera.centerX = ((under % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL - MAX_MERC
    }

    // RTC: Camera center IS projection center. Always.
    const R = 6378137
    const centerLon = (this.host.camera.centerX / R) * (180 / Math.PI)
    const centerLat = Math.max(-85, Math.min(85,
      (2 * Math.atan(Math.exp(this.host.camera.centerY / R)) - Math.PI / 2) * (180 / Math.PI)
    ))

    perfMarkEnd('frame.prep')
    perfMarkStart('frame.encode')
    const encoder = device.createCommandEncoder()
    const screenView = context.getCurrentTexture().createView()
    // Reset per-frame timer state BEFORE compute dispatch so the
    // first compute pass gets timestampWrites attached. `beginFrame()`
    // clears both the sub-pass counter AND the
    // `computeRanThisFrame` latch — moving it after compute dispatch
    // (the original order) left the latch stale → second-frame onward
    // would skip compute timestamps even though compute was running.
    this.host.gpuTimer?.beginFrame()
    // P4 compute pass: run every attached ComputeLayerHandle's
    // kernel(s) BEFORE any render pass begins so the fragment shader
    // can read populated output buffers. No-op when no compute layer
    // is attached (no variant carries `computeBindings` in production
    // today). Must run after encoder creation, before the first
    // beginRenderPass.
    this.host.renderer.dispatchComputePass(encoder, this.host.gpuTimer)
    // Every active VTR also runs its per-tile compute kernels here
    // — they need to fire BEFORE the first render pass for the same
    // reason as MapRenderer: fragment shaders read the kernel output
    // buffer at draw time. No-op when no VTR has a compute-bound
    // show attached. Timer is consulted by the FIRST kernel that
    // dispatches each frame — see GPUTimer.computeWrites().
    for (const vtSource of this.host.vtSources.values()) {
      vtSource.renderer.dispatchComputePass(encoder, this.host.gpuTimer)
    }
    // DIAG: when set to `true`, the next frame's VTR.render() calls
    // log into __xgisDrawOrderTrace; we capture + console.log the
    // sequence at the end of the frame and clear the flag so only
    // ONE frame is captured. Set externally by tests / inspector.
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __xgisCaptureDrawOrder?: boolean; __xgisDrawOrderTrace?: unknown[] }
      if (w.__xgisCaptureDrawOrder) {
        w.__xgisDrawOrderTrace = []
      }
    }
    // Wrap the entire frame in a validation scope so any pass-creation or
    // draw-call validation error gets a unique log entry pointing to the
    // submit. Each block below also pushes its own scope for finer locality.
    device.pushErrorScope('validation')

    // Per-pass scope helper: pushes an error scope, runs `fn`, then pops and
    // logs any validation error tagged with `label`. Nested inside the
    // frame-level scope so both levels fire independently — the inner scope
    // pinpoints which pass failed, the outer one catches encoder-wide state.
    const passScope = (label: string, fn: () => void): void => {
      // iter-257 (Plan AAA C.3) — wrap each passScope with a
      // perf-marks pair using the label as phase name. Lets the
      // iter-256 diagnostic decompose the encoder block's 13 ms
      // budget into bg / vtr / oit / text / overdraw shares.
      perfMarkStart(`encoder.pass.${label}`)
      device.pushErrorScope('validation')
      try { fn() }
      finally {
        device.popErrorScope().then((err) => {
          if (err) console.error(`[X-GIS pass:${label}]`, err.message)
        }).catch(() => { /* scope stack mismatch — swallow */ })
      }
      perfMarkEnd(`encoder.pass.${label}`)
    }

    // ── Build / repopulate the single reused FrameContext ──
    // Bundles the per-frame locals computed above (plus the few derived
    // deeper in the frame: colorView / sampleCount / useResolve set in the
    // MSAA block, mvp / visibleWorldCopies set in the label block). The
    // values are IDENTICAL to the locals and assigned at the same points;
    // this is a pure bundling. Lazily allocate once on the first frame,
    // then mutate in place — the 60 Hz loop is allocation-paranoid.
    if (this._ctx === null) {
      this._ctx = {
        device, encoder, screenView,
        colorView: screenView,            // set in the MSAA block below
        camera: this.host.camera,
        projType, centerLon, centerLat, w, h, dpr,
        elapsedMs: this.host._elapsedMs,
        frameCount: this.host._frameCount,
        sampleCount: 1,                   // set in the MSAA block below
        useResolve: false,                // set in the MSAA block below
        mvp: new Float32Array(0),         // set in the label block below
        visibleWorldCopies: [],           // set in the label block below
        passScope,
        rt: this.host.renderTargets,
      }
    } else {
      const c = this._ctx
      c.device = device
      c.encoder = encoder
      c.screenView = screenView
      c.camera = this.host.camera
      c.projType = projType
      c.centerLon = centerLon
      c.centerLat = centerLat
      c.w = w
      c.h = h
      c.dpr = dpr
      c.elapsedMs = this.host._elapsedMs
      c.frameCount = this.host._frameCount
      c.passScope = passScope
      c.rt = this.host.renderTargets
      // colorView / sampleCount / useResolve / mvp / visibleWorldCopies
      // are repopulated at their own (deeper) computation points below.
    }
    const ctx = this._ctx

    {
      // ═══ Direct rendering: vertex shader handles all projections ═══
      // MSAA + stencil + OIT + pick + overdraw render-target lifecycle
      // (recreate-on-resize) lives in RenderTargets (render/render-targets.ts).
      // `ensure` recreates exactly when the inline gate did (no stencil yet,
      // or w/h changed), in the same destroy → recreate order, then returns
      // the per-frame colorView decision. sample count tracks the
      // pipeline-time SAMPLE_COUNT (1 on mobile / ?safe / ?quality=performance
      // / ?msaa=1, 4 on desktop default).
      const sc = getSampleCount()
      ctx.sampleCount = sc
      const { useResolve, colorView } = ctx.rt.ensure(
        w, h, sc, isPickEnabled(), DEBUG_OVERDRAW, screenView,
      )
      ctx.useResolve = useResolve
      ctx.colorView = colorView

      // Reset per-frame uniform ring cursors (dynamic-offset slots).
      this.host.renderer.beginFrame()
      this.host.lineRenderer?.beginFrame()
      this.host.rasterRenderer.beginFrame()
      // PointRenderer drains its retired tile-point buffer queue here
      // — buffers retired during last frame's renderTilePoints can
      // safely be destroyed now that queue.submit() has returned for
      // that frame. Keeps the multi-VTR layered demo (4× tile-point
      // rebuilds per frame) from triggering "Buffer used in submit
      // while destroyed" validation errors.
      this.host.pointRenderer?.beginFrame()
      // iter-280 — frame-scoped point-label dedup. Pre-iter-280 the
      // _scratchEmittedPointNames Set was cleared per ShowCommand,
      // so cross-show duplicates of the same feature (different
      // place-layer rules matching the same vector tile feature, or
      // two features at near-identical anchors that resolve to the
      // same text-field output) leaked through. User-reported
      // post-iter-274: bilingual "Incheon/인천광역시" rendered
      // overlapping a Korean-only "인천광역시" — second dispatch
      // hides Latin under the first. Clear once at frame start so
      // every dispatched-this-frame text accumulates; per-feature
      // check below also keys on anchor coords (rounded) so two
      // distinct features sharing the same resolved string at
      // different locations both pass.
      this.host._scratchEmittedPointNames.clear()
      this.host._scratchEmittedTextNames.clear()
      // Thread the renderer's _frameCount into each VTR so its
      // per-frame catalog budget reset can short-circuit duplicate
      // calls from the same source feeding multiple layers.
      for (const [, { renderer: vtR }] of this.host.vtSources) vtR.beginFrame(this.host._frameCount)
      // Frame-scope prefetch pump — fires exactly once per wall-clock
      // frame for every attached vector source. Hosts the
      // Google-Earth-style pan-direction speculation + AMMOS
      // 3D-Tiles-Renderer-style loadSiblings. Critical that this
      // lives in renderFrame (not VTR.render, which the bucket
      // scheduler invokes per ShowCommand ~80× on dense styles) so
      // the prev-cam velocity vector and _evictShield population
      // stay frame-stable. See VTR.pumpPrefetch doc.
      for (const [, { renderer: vtR }] of this.host.vtSources) {
        vtR.pumpPrefetch(this.host.camera, ctx.projType, ctx.w, ctx.h, ctx.dpr)
      }

      // ══════ Bucket scheduler ══════
      //
      // Layers are classified into two buckets so alpha compositing is
      // always correct regardless of user declaration order:
      //
      //   1. OPAQUE bucket — every vector source's fills + opaque
      //      strokes + the fill half of translucent-stroke layers.
      //      Runs first so translucent content has a finished opaque
      //      backdrop to blend against. Sources that don't share
      //      stencil state get their own sub-pass (each sub-pass
      //      clears stencil), but consecutive same-source shows share
      //      one sub-pass.
      //
      //   2. TRANSLUCENT bucket — offscreen MAX-blend + composite for
      //      each translucent-stroke layer, in declaration order.
      //      Runs after the entire opaque bucket so translucent
      //      strokes always paint on top of opaque content.
      //
      //   3. POINTS bucket — a single pass (or inline in bucket 1)
      //      for SDF points. Always last so points draw over the map.
      //
      // The previous scheduler interleaved bucket 1 + 2 per source,
      // which broke the ordering when a translucent layer was
      // declared before an opaque layer: the translucent composite
      // would run BEFORE the later opaque fill, and the opaque fill
      // would cover the translucent strokes.
      // Push camera frame info to the trace recorder so invariant
      // tests can correlate layer/label records with the frame state
      // that produced them.
      if (this.host._pendingTraceRecorder !== null) {
        const camMx = this.host.camera.centerX
        const camMy = this.host.camera.centerY
        const R = 6378137
        const lon = (camMx / R) * (180 / Math.PI)
        const lat = (Math.atan(Math.exp(camMy / R)) * 2 - Math.PI / 2) * (180 / Math.PI)
        const canvas = this.host.ctx?.canvas
        const cw = canvas?.width ?? 0
        const ch = canvas?.height ?? 0
        this.host._pendingTraceRecorder.recordCamera({
          zoom: this.host.camera.zoom,
          centerLon: lon,
          centerLat: lat,
          bearing: this.host.camera.bearing,
          pitch: this.host.camera.pitch,
          projection: this.host.projectionName ?? 'mercator',
          viewportWidthPx: cw,
          viewportHeightPx: ch,
          dpr: ctx.dpr,
        })
      }
      // ── Bucket scheduler → SceneView ──
      // Classify shows into opaque / translucent / OIT buckets, group the
      // opaque ones by source, and derive the has*/resolveOwner flags the
      // passes below read. Bundled into a per-frame SceneView (scene-view.ts).
      //
      // hasPoints covers TWO independent point paths:
      //   1. TILE points (xgvt tiles, e.g. countries_xgvt) — drained per
      //      source via pointRenderer.addTilePoint/flushTilePoints inside
      //      each VTR's own render pass (the VTR tile loop is a no-op for
      //      sources without point vertices, so passing pointRenderer to
      //      every VTR.render below is safe and free).
      //   2. DIRECT-LAYER points (GeoJSON routed into pointRenderer.addLayer
      //      by rebuildLayers) — rendered by the dedicated bucket-3 pass and
      //      NEVER reachable from VTR.render. The old `inlinePoints` opt
      //      conflated the two and skipped bucket 3 when no translucent
      //      layer existed, hiding every direct-layer point demo; bucket 3
      //      now always runs when direct-layer points exist.
      const scene = buildSceneView(this.host, ctx)

      if (scene.hasTranslucent) this.host.lineRenderer!.ensureOffscreen(ctx.w, ctx.h)

      // ── Bucket 1: opaque ── (OpaquePass — render/passes/opaque-pass.ts)
      opaquePass.execute(ctx, scene, this.host)

      // ── Bucket 1.5: OIT translucent extrude ── (OitPass — render/passes/oit-pass.ts)
      if (oitPass.shouldRun(scene)) oitPass.execute(ctx, scene, this.host)

      // ── Bucket 2: translucent offscreen + composite ── (TranslucentPass — render/passes/translucent-pass.ts)
      if (translucentPass.shouldRun(scene)) translucentPass.execute(ctx, scene, this.host)

      // ── Bucket 3: direct-layer points ── (PointsPass — render/passes/points-pass.ts)
      if (pointsPass.shouldRun(scene)) pointsPass.execute(ctx, scene, this.host)

      // ── Bucket 4: text overlays + per-feature labels ──
      // Two sources of label work:
      //   (a) `map.addOverlay(...)` — explicit (lon, lat) overlays
      //       set imperatively from app code.
      //   (b) layers whose ShowCommand carries a `.label` LabelDef
      //       (Mapbox `text-field` / xgis `label-["{...}"]`). We
      //       walk the source's GeoJSON features, resolve the
      //       template against each feature's properties, and
      //       project the centroid.
      // Lazy-init the stage on first use so a label-free map
      // allocates no atlas pages.
      // Diagnostic kill switch — `window.__xgisDisableLabels = true`
      // before render() short-circuits ALL label work. Used to A/B
      // measure text subsystem cost vs the rest of the frame.
      const disableLabels = typeof window !== 'undefined'
        && (window as unknown as { __xgisDisableLabels?: boolean }).__xgisDisableLabels === true
      // Mapbox `layer.minzoom` / `layer.maxzoom`: hide the layer
      // outside its declared zoom range. Without this gate every
      // sub-layer of a multi-zoom Mapbox style renders at every
      // zoom level — at z=1.86 with OFM Bright that means city /
      // state / town / village / suburb / POI labels all piling
      // onto the antimeridian view, drowning out the few
      // country-level labels that should be visible there.
      const camZ = this.host.camera.zoom
      const inZoomRange = (s: ShowCommand): boolean =>
        (s.minzoom === undefined || camZ >= s.minzoom)
        && (s.maxzoom === undefined || camZ < s.maxzoom)
      const labelShows = disableLabels
        ? []
        : this.host.showCommands.filter(s => s.label !== undefined && s.visible !== false && inZoomRange(s))
      if (!disableLabels && (this.host.overlays.length > 0 || labelShows.length > 0)) {
        if (this.host.textStage === null) {
          // Assemble the TextStage's glyph-resource options from
          // everything the host has handed us via constructor /
          // setters / addGlyphProvider. Empty bag → byte-identical
          // pre-PBF behaviour.
          const tsOpts: TextStageOptions = {}
          if (this.host.glyphsUrl !== null) tsOpts.glyphsUrl = this.host.glyphsUrl
          if (this.host.inlineGlyphs !== null) tsOpts.inlineGlyphs = this.host.inlineGlyphs
          if (this.host.glyphProviders.length > 0) tsOpts.glyphProviders = this.host.glyphProviders
          if (this.host.fontTypography !== null) tsOpts.fontTypography = this.host.fontTypography
          // Bake locally-rasterised (non-PBF) glyphs at physical-pixel
          // resolution so Hangul/Han labels aren't GPU-upscaled ~dpr×
          // from a 24-px atlas raster (low-res CJK on hidpi screens).
          tsOpts.dpr = dpr
          this.host.textStage = new TextStage(device, this.host.ctx.format, tsOpts, sc)
          this.host.textStage.prewarmGISDefaults()
          // Attach any debug hook that was set before the stage existed.
          // The hook is null/undefined-safe on the stage side, so the
          // common no-debug path stays a single null-check inside
          // addLabel.
          if (this.host._pendingLabelDebugHook !== undefined) {
            this.host.textStage.setLabelDebugHook(this.host._pendingLabelDebugHook)
          }
          if (this.host._pendingTraceRecorder !== null) {
            this.host.textStage.setTraceRecorder(this.host._pendingTraceRecorder)
          }
        }
        const stage = this.host.textStage
        // Lazy IconStage — only built when the style has a `sprite`
        // URL AND at least one currently-active label show declares
        // an `iconImage` (const form) OR `iconImageExpr` (per-
        // feature, OFM POI layers). Both gates avoid the network
        // fetch on styles that don't need icons.
        if (this.host.iconStage === null && this.host.spriteUrl !== null
            && (labelShows.some(s =>
                 s.label?.iconImage !== undefined
                 || (s.label as { iconImageExpr?: unknown } | undefined)?.iconImageExpr !== undefined)
                // iter-177 / iter-178 — fill-pattern + line-pattern
                // Stage 1 also need the sprite atlas loaded, even
                // when no icon dispatch label show exists (Liberty
                // `landcover_wetland` + `road_area_pattern` only
                // declare `fill-pattern`, no icon layers).
                || this.host.showCommands.some(s => s.fillPattern || s.linePattern))) {
          this.host.iconStage = new IconStage(device, this.host.ctx.format, {
            spriteUrl: this.host.spriteUrl, dpr,
          }, sc)
        }
        const iStage = this.host.iconStage
        // Anchors are projected against canvas.width/height (physical
        // px); LabelDef.size etc. are CSS-px convention. Telling the
        // stage the current DPR keeps text the right visual size on
        // hidpi displays — without this, a `label-size-13` renders
        // at 6.5 CSS px on a 2x display.
        stage.setDpr(dpr)
        iStage?.setDpr(dpr)
        // Per-label icon dispatch helper. Captures dpr + iStage from
        // the render-frame scope so the call sites below stay one
        // line — every per-feature addLabel that follows gets a
        // matching maybeAddIcon. Line / curve placement intentionally
        // doesn't call this (icon-along-curve is a Phase B+ feature);
        // point-anchored POI symbols (the demotiles + OFM Bright bus-
        // stop / school / amenity layers) flow through here.
        const dispatchIcon = (def: { iconImage?: string; iconSize?: number; iconAnchor?: import('@xgis/compiler').LabelDef['iconAnchor']; iconOffset?: [number, number]; iconRotate?: number; iconOpacity?: number; iconColor?: [number, number, number, number]; iconRotationAlignment?: 'map' }, ax: number, ay: number, lineTangentDeg = 0, pairKey?: string): void => {
          if (!iStage || def.iconImage === undefined) return
          const offDx = (def.iconOffset?.[0] ?? 0) * dpr
          const offDy = (def.iconOffset?.[1] ?? 0) * dpr
          // icon-rotation-alignment=map under symbol-placement=line
          // adds the per-segment tangent to the icon's authored
          // rotation. OFM road_oneway: icon-rotate=90 + tangent of
          // an east-west road (0°) = 90° → arrow points up (the
          // arrow sprite's design orientation has the head pointing
          // right at 0°, so 90° clockwise = north). Caller passes 0
          // for point-placement and other "viewport" rotation cases.
          const tangent = def.iconRotationAlignment === 'map' ? lineTangentDeg : 0
          // icon-color → SDF tint (RGBA from resolver; renderer takes
          // rgb, ignores alpha — Mapbox icon-color has no alpha axis,
          // icon-opacity owns alpha). Undefined when unauthored so
          // the renderer keeps the raster/identity path.
          const ic = def.iconColor
          iStage.addIcon(ax + offDx, ay + offDy, def.iconImage, {
            sizeScale: def.iconSize ?? 1,
            rotateRad: ((def.iconRotate ?? 0) + tangent) * Math.PI / 180,
            anchor: def.iconAnchor ?? 'center',
            opacity: def.iconOpacity ?? 1,
            tint: ic ? [ic[0], ic[1], ic[2]] : undefined,
            pairKey,
          })
        }
        // Mapbox `text-field` expressions that depend on zoom (e.g.
        // demotiles `text-field: {stops:[[2,"{ABBREV}"],[4,"{NAME}"]]}`
        // → step(zoom, .ABBREV, 4, .NAME)) need the camera zoom in the
        // evaluator props bag. Without this, zoom = undefined → NaN
        // → step()'s default arm forever, so country labels never
        // switched from "S. Kor" to "S. Korea" past z=4.
        stage.setCameraZoom(this.host.camera.zoom)
        const frame = this.host.camera.getFrameView(w, h, dpr)
        const mvp = frame.matrix
        ctx.mvp = mvp
        const ccx = this.host.camera.centerX
        const ccy = this.host.camera.centerY

        // The four label-anchor projectors (projectMerc / projectLonLat
        // / projectMercAny / projectLonLatCopies) were inline closures
        // here. They are now lifted VERBATIM into makeLabelProjectors in
        // render-loop-helpers.ts — the bodies, scratch-reuse contract and
        // inter-projector delegation are byte-identical; only the per-
        // frame locals they captured (MVP, camera centre, projection
        // flags, projected focus, visible-world-copy list) are now passed
        // as explicit factory arguments. The per-frame derived values
        // below are computed in the SAME order as before so behaviour and
        // side-effect timing are unchanged.
        //
        // Non-Mercator label anchors mirror the GPU reproject_point
        // (point-renderer.ts): project(lon,lat) - project(center) in the
        // ACTIVE projection, then the shared MVP — NOT the Mercator
        // formula, which detached every label from its feature under
        // natural_earth / ortho / azimuthal / stereo / oblique. Hoist the
        // projected camera centre + flag once per frame (centerLon /
        // centerLat / projType are renderFrame constants) so the hot
        // per-label path stays allocation-free.
        const _lblIsMerc = this.host.projectionName === 'mercator'
        const _lblIsGlobe = this.host.projectionName === 'globe'
        // Globe label anchor = sphere RTC against the focus, then the
        // full 4×4 orbit MVP (camera emits it in globe mode). Hoisted
        // per frame like _lblCenter.
        const _lblGlobeCenter = _lblIsGlobe
          ? globeForward(centerLon, centerLat)
          : ([0, 0, 0] as [number, number, number])
        const _lblCenter: [number, number] = _lblIsMerc || _lblIsGlobe
          ? [0, 0]
          : projectWgsl(projType, centerLon, centerLat, centerLon, centerLat)

        // Mercator is periodic in lon, so PointRenderer / VTR emit
        // every polygon 5× across the -2..+2 world copies. Without
        // mirroring the same loop here, a country anchor at lon=-179
        // gets ONE label at its primary copy and nothing on the
        // adjacent +360° copy that's also visible at z≤2. Result: at
        // low zoom labels visibly cluster on one side of the world
        // map ("포인트가 한쪽에 몰림"). Non-Mercator projections
        // collapse to a single copy — see worldCopiesFor() in
        // gpu-shared for the rationale.
        // Label-specific world-copy iteration. Polygon / line draws
        // enumerate WORLD_COPIES = [-2..+2] so geometry wraps cleanly
        // at the antimeridian. MapLibre renders labels in EVERY
        // visible world copy too — at z=0 with pitch / bearing the
        // user sees multiple worlds and expects country names in
        // each. iter-188 fix: previous "first that projects" logic
        // (designed to suppress 2-3× duplicate clusters on un-
        // pitched z=0) wrongly capped labels at one world copy
        // even when 3-4 were on-screen, leaving the user's
        // pitched / bearing'd view with labels only in the central
        // copy. Now enumerate ALL copies that pass the projector's
        // NDC ±1.5 window — the screen-space collision pass dedupes
        // labels whose AABBes overlap, so the "one Belgium per
        // visible copy" output mirrors MapLibre without manual
        // priority arbitration.
        // iter-189 — single source of visible world copies. Camera
        // computes the list ONCE per frame from inverse-MVP corner
        // unprojections (z=0 plane lon range → integer offsets
        // clamped at ±2). Replaces the iter-188 hardcoded
        // `[0, -1, 1, -2, 2]` enum + per-callsite NDC cull.
        const visibleWorldCopies = this.host.camera.getVisibleWorldCopies(w, h, dpr)
        ctx.visibleWorldCopies = visibleWorldCopies
        const { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies } =
          makeLabelProjectors(
            mvp, w, h, ccx, ccy, projType, centerLon, centerLat,
            _lblIsMerc, _lblIsGlobe, _lblGlobeCenter, _lblCenter,
            this.host.projectionName, visibleWorldCopies,
          )

        // (a) Imperative overlays
        for (const ov of this.host.overlays) {
          const projected = projectLonLat(ov.lon, ov.lat)
          if (!projected) continue
          const tv = {
            kind: 'expr' as const,
            expr: { ast: { kind: 'StringLiteral' as const, value: ov.text } as never },
          }
          stage.addLabel(tv, {}, projected[0], projected[1], {
            text: tv,
            size: ov.size,
            color: ov.color,
            halo: ov.halo,
            transform: ov.transform,
          }, ov.font, '__overlay')
        }

        // (b) Per-feature labels from ShowCommand.label
        // iter-258 (Plan AAA C.3) — phase mark wrapping the entire
        // label dispatch loop. Picks up forEachLabelFeature +
        // forEachLineLabelPolyline + dispatchIcon + addLabel work.
        perfMarkStart('encoder.label-dispatch')
        // iter-261 (Plan L.1.1) — hit-rate diagnostic. Compute
        // signature: camera + canvas + each VTR's tile-set hash +
        // labelShows count + style version. If this sig matches
        // the prior frame, a future Phase L.1 implementation would
        // skip the entire dispatch loop and replay cached pending.
        const c = this.host.camera
        let _vtrSig = ''
        for (const [name, e] of this.host.vtSources) {
          _vtrSig += `${name}:${e.renderer.getCacheSize()};`
        }
        const _dispatchSig =
          `${(c.zoom * 100) | 0}|${c.centerX | 0},${c.centerY | 0}`
          + `|${(c.bearing * 100) | 0}|${(c.pitch * 100) | 0}`
          + `|${this.host.ctx.canvas.width}x${this.host.ctx.canvas.height}`
          + `|${labelShows.length}|${_vtrSig}`
        if (this.host._prevLabelDispatchSig === _dispatchSig) {
          this.host._labelDispatchHits++
        } else {
          this.host._labelDispatchMisses++
          this.host._prevLabelDispatchSig = _dispatchSig
        }
        for (const show of labelShows) {
          // iter-262 — per-show wrap to find what consumes the
          // 6+ ms gap not accounted for by line/point sub-marks.
          perfMarkStart('encoder.label-dispatch.show')
          // If LabelDef.color is unset, fall back to the layer's fill
          // (typical Mapbox-style symbol-on-poly pattern: the same
          // colour for the polygon AND its label). When THAT is also
          // unset, default to white so dark backgrounds stay readable.
          const def = show.label!
          // Stable per-show layer identifier for the trace recorder
          // (FrameTrace.labels[i].layerName). Prefer the DSL layer
          // name; fall back to the source layer for legacy syntax
          // and the source name for inline / unfiltered shows. Used
          // by parity diagnostics + invariants to group labels by
          // their origin layer (`label_country_2`, `poi_r1`, …).
          const labelLayerName = show.layerName ?? show.sourceLayer ?? show.targetName ?? ''
          const z = this.host.camera.zoom
          const elapsedMs = performance.now()
          // Per-frame label paint resolution flows through the unified
          // LabelShapes bundle (Plan Label L2). Same resolvers
          // (`resolveNumberShape` / `resolveColorShape`) the paint side
          // uses — keeps the value-derivation path consistent and lets
          // a new dependency form (e.g. time-interpolated text-size)
          // land in one place. Per-feature `sizeExpr` / `colorExpr` are
          // expressed as `kind: 'data-driven'` shapes (see
          // `applyFeatureExprs` below) — the resolver returns the
          // layer-level fallback (1 for numbers, null for colour),
          // which we override with the static defaults here.
          const shapes = def.shapes
          // Per-show label paint resolution (text-size / -color / -halo /
          // font / icon-size / -opacity / -color / opacity + map-aligned
          // point-label bearing) collapses to a single `effectiveDef`
          // snapshot. Moved verbatim to render-loop-helpers.ts; `show.fill`
          // and `this.host.camera.bearing` are the only inputs threaded as
          // explicit args. Data-driven shapes fall through to static
          // defaults here and are overridden per feature by
          // applyFeatureExprs below.
          const effectiveDef = resolveLabelEffectiveDef(
            def, shapes, z, elapsedMs, show.fill, this.host.camera.bearing,
          )

          // Per-feature evaluator for data-driven text-size /
          // text-color (Mapbox `["case", …]` / `["match", …]` /
          // arithmetic forms). Wraps a feature's def with overrides
          // resolved from the data-driven PropertyShapes against
          // that feature's properties. Pulls AST from
          // `def.shapes.size.expr` / `def.shapes.color.expr` — the
          // LabelShapes bundle is the single source of truth post-L2.
          const sizeExprAst = shapes && shapes.size.kind === 'data-driven'
            ? shapes.size.expr.ast : null
          const colorExprAst = shapes && shapes.color !== null && shapes.color.kind === 'data-driven'
            ? shapes.color.expr.ast : null
          // Per-feature icon-image expression. Compiler emits this
          // when Mapbox `icon-image: ["match", ["get", "subclass"], …]`
          // is present (OFM POI layers). Runtime evaluates the AST
          // per feature, resolves to a sprite atlas key, and feeds
          // dispatchIcon's existing const-path (which already gates
          // on def.iconImage !== undefined and calls IconStage.addIcon).
          const iconImageExprAst = (def as { iconImageExpr?: { ast?: unknown } }).iconImageExpr?.ast ?? null
          const cameraZoom = this.host.camera.zoom
          // iter-259 (Plan AAA B.7) — applyFeatureExprs cache. Key
          // on props ref + zoomBucket (0.25 zoom resolution). For
          // PMTiles MVT tiles, the per-tile featureProps Map
          // returns the SAME object ref across frames per featId,
          // so a WeakMap keyed on props ref gives stable cache
          // entries across frames. Zoom bucket lets the cache
          // survive small camera zooms (typical interactive zoom
          // sweeps ~0.1 per frame); larger zoom changes recompute.
          //
          // iter-258 profile: encoder.label-dispatch = 10.93 ms
          // = 73 % of frame. Per-feature applyFeatureExprs runs 3
          // evaluate() AST walks + 2 alloc (bag + spread). Cache
          // hit returns cached LabelDef directly, skips all that
          // work.
          const zoomBucket = Math.round(cameraZoom * 4)
          const applyFeatureExprs = (props: Record<string, unknown>) => {
            if (sizeExprAst === null && colorExprAst === null && iconImageExprAst === null) return effectiveDef
            const cached = this.host._featureExprsCache.get(props)
            if (cached !== undefined && cached.zoomBucket === zoomBucket && cached.effectiveDef === effectiveDef) {
              return cached.def
            }
            // makeEvalProps injects the reserved `$zoom` key so label
            // text-size / text-color expressions referencing
            // `interpolate(zoom, …)` resolve to the current camera
            // zoom rather than undefined (which evaluate() folds to
            // null → number coercion 0 → label size = 0 / label
            // colour collapses to default). Mirrors the
            // extractFeatureWidths reserved-key contract.
            const bag = makeEvalProps({ props, cameraZoom })
            const out = { ...effectiveDef }
            if (sizeExprAst !== null) {
              try {
                const v = evaluate(sizeExprAst as never, bag)
                if (typeof v === 'number' && isFinite(v)) out.size = v
              } catch { /* fall back to effectiveDef.size */ }
            }
            if (colorExprAst !== null) {
              try {
                const v = evaluate(colorExprAst as never, bag)
                if (typeof v === 'string') {
                  const hex = resolveColor(v)
                  const rgba = hexToRgba(hex ?? v)
                  if (rgba) out.color = rgba
                }
              } catch { /* fall back to effectiveDef.color */ }
            }
            if (iconImageExprAst !== null) {
              try {
                const v = evaluate(iconImageExprAst as never, bag)
                if (typeof v === 'string' && v.length > 0) {
                  (out as { iconImage?: string }).iconImage = v
                }
              } catch { /* fall back to effectiveDef.iconImage */ }
            }
            // iter-259 — cache the result. Stores the resolved
            // LabelDef + zoomBucket; future calls with same
            // (props, zoomBucket, effectiveDef) hit the cache and
            // skip the evaluate() AST walks.
            this.host._featureExprsCache.set(props, { zoomBucket, effectiveDef, def: out })
            return out
          }

          // Path 1: GeoJSON / inline-data sources whose features live
          // in `rawDatasets`. Iterates the FeatureCollection directly
          // and uses `featureAnchor` to pick a centroid per geometry.
          const data = this.host.rawDatasets.get(show.targetName)
          if (data && data.features && !(data as unknown as { _vectorTile?: boolean })._vectorTile) {
            for (const feat of data.features) {
              if (!feat.geometry) continue
              const anchor = featureAnchor(feat.geometry)
              if (!anchor) continue
              const featDef = applyFeatureExprs(feat.properties ?? {})
              // Pass the full LabelDef and let TextStage.composeFontKey
              // build the ctx.font shorthand (weight, italic, CJK
              // fallback chain). Passing `def.font?.[0]` as a 6th-arg
              // override here used to short-circuit that — every Mapbox
              // label rendered in Regular weight and lost Hangul / Han
              // fallback. Keep this comment on every call site so the
              // override doesn't quietly come back.
              for (const projected of projectLonLatCopies(anchor[0], anchor[1])) {
                // iter 119: point-label paired-symbol collision. OFM
                // Positron label_city/town/village pair the place name
                // with circle_11_black icon and rely on
                // icon-optional=false to drop the icon when text drops.
                const pairedWithIcon = featDef.iconImage !== undefined
                  && featDef.iconImage !== null && featDef.iconImage !== ''
                const pairKey = pairedWithIcon
                  ? `${labelLayerName ?? ''}:${Math.round(projected[0])},${Math.round(projected[1])}`
                  : undefined
                stage.addLabel(
                  featDef.text, feat.properties ?? {},
                  projected[0], projected[1], featDef,
                  undefined, labelLayerName, pairKey,
                )
                dispatchIcon(featDef, projected[0], projected[1], 0, pairKey)
              }
            }
            continue
          }

          // Path 2: vector-tile sources (PMTiles / .xgvt / Mapbox
          // converter output). Features live in the VTR tile cache.
          // We delegate iteration to VTR.forEachLabelFeature which
          // walks `stableKeys` × `pointVertices` and rebuilds the
          // property bag from the source's PropertyTable. Mercator
          // coords come out in absolute meters; we go through the
          // same projector by inverting back to lon/lat.
          const vtEntry = this.host.vtSources.get(show.targetName)
          if (vtEntry) {
            const DEG2RAD = Math.PI / 180
            const R = 6378137
            const mercToLonLat = (mx: number, my: number): [number, number] => [
              (mx / R) / DEG2RAD,
              (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / DEG2RAD,
            ]
            // The MVT worker buckets features per (sourceLayer, filter)
            // and stores each subset under its sliceKey — so a layer
            // with a `filter:` produces e.g. `place::abc123` instead of
            // bare `place`. Without using sliceKey here every filtered
            // label show (label_country_*, label_city, label_town, …
            // for the Bright basemap — every place / poi label that
            // isn't a single unfiltered show) silently iterated zero
            // tiles. Unfiltered shows still work because computeSliceKey
            // collapses the no-filter case to the bare sourceLayer.
            // Mirrors show-source-maps.ts `effectiveLayer`: fall back to
            // `targetName` when `sourceLayer` is empty (inline GeoJSON).
            // Worker emits slices keyed under the source name, so without
            // this fallback every label show on an inline GeoJSON source
            // looked up the wrong sliceKey and silently iterated zero
            // tiles (same class as filter_gdp emerald/yellow).
            const sliceKey = computeSliceKey(
              show.sourceLayer || show.targetName || '',
              show.filterExpr?.ast as Parameters<typeof computeSliceKey>[1],
            )
            // Along-path placement: walk lineVertices instead of
            // pointVertices, project both segment endpoints, anchor
            // at the screen-space midpoint, rotate by the screen-
            // space tangent. Computing the angle in screen space
            // (not mercator) keeps the label aligned with the visible
            // road through any pitch / bearing.
            const useLine = effectiveDef.placement === 'line' || effectiveDef.placement === 'line-center'
            // iter-262 (Plan L.1.2) — split label-dispatch into
            // line vs point sub-paths. Tells us which path
            // dominates the 9.5 ms encoder.label-dispatch budget.
            const _ldMark = useLine ? 'encoder.label-dispatch.line' : 'encoder.label-dispatch.point'
            perfMarkStart(_ldMark)
            if (useLine) {
              // Mapbox `symbol-spacing` (CSS px). When set on a line
              // placement layer (placement === 'line' only — line-
              // center always emits one label at the midpoint), walk
              // the screen-projected polyline and emit a label every
              // `spacing` pixels. Without this, long highways get a
              // single label which Mapbox would render as a repeating
              // chain. Spacing is in CSS px → multiply by DPR for
              // the physical-pixel polyline space.
              const spacingCssPx = effectiveDef.placement === 'line'
                ? (effectiveDef.spacing ?? 0) : 0
              const spacingPx = spacingCssPx > 0 ? spacingCssPx * dpr : 0
              // Mapbox `text-rotation-alignment: viewport` for line
              // placement keeps the label upright on screen instead of
              // following the road tangent. 'auto' on line resolves to
              // 'map' (= tangent), matching the historical behaviour.
              const lineRotAlign = effectiveDef.rotationAlignment ?? 'auto'
              const useTangentRotation = lineRotAlign !== 'viewport'
              // iter-176 pairKey-by-sequence: pre-iter-176 the pair key
              // was `${layer}:${Math.round(x)},${Math.round(y)}` —
              // unstable across frames (sub-pixel camera drift flips
              // the rounding) AND prone to STRING-collisions between
              // two near-anchored labels (both round to same coords).
              // Symptom: highway shield box appears/disappears as
              // user pans (user report 2026-05-20 OFM bright Seoul
              // Yangjaecheon). Replace with a monotonic per-line-walk
              // counter — text + icon at the SAME emitLabelAlongSegment
              // call share the same seq; different anchors get
              // different seqs; deterministic across frames as long as
              // the polyline walk is (iter-169 cache makes it so).
              let _lineLabelSeq = 0
              const emitLabelAlongSegment = (
                pax: number, pay: number, pbx: number, pby: number,
                t: number, props: Record<string, unknown>,
              ): void => {
                const x = pax + (pbx - pax) * t
                const y = pay + (pby - pay) * t
                // Raw segment tangent in degrees (CCW from +x). Icons
                // with icon-rotation-alignment=map use this directly
                // (no upright flip); text uses the flipped form so
                // glyphs stay readable from the natural reading
                // direction.
                const rawTangentDeg = Math.atan2(pby - pay, pbx - pax) * 180 / Math.PI
                const featDef = applyFeatureExprs(props)
                // Iter 111: text + icon pair on a line-placement symbol
                // layer (OFM highway-shield-* + road_shield_us at z>=11)
                // must place TOGETHER. Text collision could reject the
                // label while the icon (no collision gate) still emits
                // — visible bug: shield boxes render with no road
                // number inside ("도로 번호가 렌더링되지 않는 경우가
                // 있음 하지만 실제 흰색 배경 아이콘은 렌더링됨").
                // MapLibre treats text-allow-overlap=false + paired
                // icon-image as a single symbol — both placed or both
                // dropped. We don't have full paired-symbol collision
                // yet; the pragmatic match is to let paired text bypass
                // collision (allowOverlap), so it survives wherever the
                // icon survives. symbol-spacing on these layers (200 px
                // typical) keeps the visual spacing close enough to
                // MapLibre's collision-resolved cadence.
                // Iter 112 paired-symbol collision: when a text label
                // has a paired iconImage (OFM highway-shield-* /
                // road_shield_us at z>=11), tie them by a shared
                // per-anchor pairKey. TextStage.prepare runs collision
                // and stamps droppedPairKeys for any REJECTED text;
                // IconStage.prepare drops icons whose paired text was
                // rejected. Matches MapLibre's "text+icon as one
                // symbol" invariant. Replaces iter 111's allowOverlap
                // shortcut which kept every shield instance and
                // produced visible duplication along single routes.
                const pairedWithIcon = featDef.iconImage !== undefined
                  && featDef.iconImage !== null
                  && featDef.iconImage !== ''
                const pairKey = pairedWithIcon
                  ? `${labelLayerName ?? ''}:seq${_lineLabelSeq++}`
                  : undefined
                if (useTangentRotation) {
                  let angleDeg = rawTangentDeg
                  if (angleDeg > 90 || angleDeg < -90) angleDeg += 180
                  // No fontKey override — TextStage.composeFontKey
                  // builds the proper CSS shorthand with weight / italic
                  // / CJK fallback from featDef. See note at line ~2370.
                  stage.addLabel(
                    featDef.text, props,
                    x, y,
                    { ...featDef, rotate: angleDeg },
                    undefined, labelLayerName, pairKey,
                  )
                } else {
                  // Viewport-aligned: just place at the line position
                  // with the def's static rotate (typically 0).
                  stage.addLabel(
                    featDef.text, props,
                    x, y, featDef,
                    undefined, labelLayerName, pairKey,
                  )
                }
                // Icon-along-line: same anchor + same pairKey as the
                // label. OFM highway-shield-* wants the badge + text
                // to place/drop together. The unflipped tangent feeds
                // icon-rotation-alignment=map so road_oneway arrows
                // point along the road.
                dispatchIcon(featDef, x, y, rawTangentDeg, pairKey)
              }
              if (spacingPx > 0) {
                // Polyline path: project all vertices, walk in screen
                // space, drop labels at spacing/2, 3*spacing/2, …. For
                // tangent-rotation labels (the common case) we hand the
                // polyline + offset to TextStage.addCurvedLineLabel
                // which lays each glyph at its own sample point with
                // the local tangent rotation — this is the Mapbox
                // text-along-curve look. Viewport-aligned line labels
                // (text-rotation-alignment: viewport) keep the simple
                // single-rotation `emitLabelAlongSegment` path so the
                // glyphs stay in a horizontal row.
                //
                // Cross-tile dedupe: cap line labels at ONE emission
                // per unique road name per ShowCommand pass. PMTiles
                // slices a single road into separate featId per tile,
                // so the same road name emits as N independent
                // polylines across N visible tiles — at z=17 a
                // one-screen-wide road crossing 5 tile boundaries
                // would stamp its name 5× along itself. MapLibre's
                // collision system collapses these via bbox overlap,
                // but X-GIS's line-label bboxes are narrow strips
                // along the road tangent and adjacent tile segments
                // don't overlap enough to trigger the collision drop.
                // Hard-cap here matches the reference output.
                // iter-237 (Plan A.2) — scratch reuse; clear per show
                // entry. Pre-iter-237 was `new Set<string>()` per show.
                const emittedTextNames = this.host._scratchEmittedTextNames
                emittedTextNames.clear()
                const isTooCloseToSameText = (resolvedText: string, _sx: number, _sy: number): boolean => {
                  return emittedTextNames.has(resolvedText)
                }
                const recordTextPosition = (resolvedText: string, _sx: number, _sy: number): void => {
                  emittedTextNames.add(resolvedText)
                }
                const SUBDIVS_PER_SEG = 16
                // Polyline projection scratch — sized once per show, big
                // enough to hold the worst-case sample count across any
                // polyline encountered in this layer. Each callback
                // writes into the head and uses a per-call `count` so we
                // never have to clear. `new Float32Array(px)` inside the
                // callback was the dominant GC source on z=12 Korea
                // (`forEachLineLabelPolyline.prepare` ~30 ms with visible
                // GC sweeps in profile); reusing one buffer per layer
                // collapses that to near-zero.
                let _pxScratch = new Float32Array(0)
                let _pyScratch = new Float32Array(0)
                // Static return holder for samplePosAt — closure used to
                // return `{ x, y }` on every call, which fired in the
                // hot loop below per spacing point.
                // [x, y, tangentDeg] — tangent angle (degrees CCW from +x)
                // is the segment direction at the sample point. Used by
                // icon-rotation-alignment=map to rotate per-segment icons
                // with the line direction (OFM road_oneway arrows).
                const _samplePosOut: [number, number, number] = [0, 0, 0]
                vtEntry.renderer.forEachLineLabelPolyline(sliceKey, (mxs, mys, props) => {
                  perfMarkStart('encoder.label-dispatch.line.polyline')
                  if (mxs.length < 2) { perfMarkEnd('encoder.label-dispatch.line.polyline'); return }
                  // Project every vertex to physical-pixel screen
                  // space; pack into typed arrays for the curved-text
                  // sampler. Drop unprojectable vertices by trimming
                  // to the first contiguous projectable run.
                  //
                  // Subdivide each segment so a world-spanning line
                  // (e.g. demotiles geolines: Tropic of Cancer with 2
                  // vertices at lng=±180) gets enough sample points
                  // for the on-screen portion to project successfully.
                  // Without this, both raw endpoints land outside the
                  // NDC ±1.5 window and `projectLonLat` rejects them,
                  // leaving px.length === 0 and the label silently
                  // dropping. Sample density (16 cuts per segment) is
                  // sufficient for the labelling pass — the actual
                  // line geometry is rendered separately by the line
                  // renderer which handles its own viewport clipping.
                  const N = mxs.length
                  // Upper-bound sample count for this polyline. First
                  // segment emits SUBDIVS_PER_SEG+1 samples (including
                  // both endpoints), every later segment emits
                  // SUBDIVS_PER_SEG samples (start vertex skipped to
                  // avoid duplicating the previous segment's end).
                  // Total = SUBDIVS_PER_SEG * N - (N - 2). projectMerc
                  // rejections only shorten this — they never grow it.
                  const upper = SUBDIVS_PER_SEG * N + 1
                  if (_pxScratch.length < upper) {
                    _pxScratch = new Float32Array(upper * 2)  // 2× to amortise growth
                    _pyScratch = new Float32Array(upper * 2)
                  }
                  perfMarkStart('encoder.label-dispatch.line.project')
                  let pn = 0  // active sample count
                  // iter-264 — adaptive subdivision based on segment
                  // length. Subdivision exists to handle world-spanning
                  // lines (demotiles geolines: Tropic of Cancer with 2
                  // vertices at lng=±180) so the on-screen portion
                  // projects properly. PMTiles road segments are
                  // typically < 10 km in mercator-metre space —
                  // subdivision count of 16 is gross overkill.
                  //
                  // Threshold = 100 km (1e5 m). Anything below = no
                  // subdivision needed (just project endpoints). Above
                  // 100 km, proportional sampling up to SUBDIVS_PER_SEG.
                  //
                  // Trade-off: very short segments (< 100 km) get
                  // straight-line interpolation between endpoints,
                  // which is correct in mercator space anyway. Long
                  // segments still get dense sampling for projection
                  // correctness across viewport boundaries.
                  const SUBDIV_LEN_THRESHOLD_M = 1e5
                  for (let i = 0; i < N - 1; i++) {
                    const ax = mxs[i]!, ay = mys[i]!
                    const bx = mxs[i + 1]!, by = mys[i + 1]!
                    const segDx = bx - ax, segDy = by - ay
                    const segLenM = Math.sqrt(segDx * segDx + segDy * segDy)
                    // Adaptive subdivision count. Short segments get 1
                    // (endpoint only); long segments get full count
                    // proportional to length / threshold.
                    let dynSteps: number
                    if (segLenM < SUBDIV_LEN_THRESHOLD_M) {
                      dynSteps = 1
                    } else {
                      const k = Math.min(SUBDIVS_PER_SEG, Math.ceil(segLenM / SUBDIV_LEN_THRESHOLD_M))
                      dynSteps = i === 0 ? k : k - 1
                    }
                    const startT = (i === 0 || segLenM < SUBDIV_LEN_THRESHOLD_M) ? 0 : 1 / dynSteps
                    for (let s = 0; s <= dynSteps; s++) {
                      const t = dynSteps > 0 ? startT + s * (1 - startT) / dynSteps : 0
                      const sx = ax + (bx - ax) * t
                      const sy = ay + (by - ay) * t
                      // Direct merc → screen projection. Skips the
                      // mercToLonLat + lonLatToMercator round-trip that
                      // accounted for ~80 % of forEachLineLabelPolyline's
                      // frame time pre-optimisation (OFM Bright z=13).
                      const proj = projectMercAny(sx, sy)
                      if (proj) {
                        _pxScratch[pn] = proj[0]
                        _pyScratch[pn] = proj[1]
                        pn++
                      }
                    }
                  }
                  perfMarkEnd('encoder.label-dispatch.line.project')
                  if (pn < 2) { perfMarkEnd('encoder.label-dispatch.line.polyline'); return }
                  perfMarkStart('encoder.label-dispatch.line.emit')
                  let total = 0
                  for (let i = 0; i < pn - 1; i++) {
                    const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                    const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                    total += Math.sqrt(dx * dx + dy * dy)
                  }
                  const featDef = applyFeatureExprs(props)
                  // Cross-tile dedupe key. resolveText() varies across
                  // road segments when one segment carries
                  // `name:nonlatin` and the next doesn't — the concat
                  // expression returns different strings even though
                  // the road is the same. Prefer the most stable name
                  // field (`name` → `name_en` → resolved fallback) so
                  // the dedupe matches across heterogeneous segments.
                  const propsRec = props as Record<string, unknown>
                  const stableName = typeof propsRec.name === 'string' ? propsRec.name
                    : typeof propsRec.name_en === 'string' ? propsRec.name_en
                    : resolveText(featDef.text, props, this.host.camera.zoom)
                  const resolvedTextForDedupe = stableName
                  // Walk the polyline and compute the screen-pixel
                  // position for an offset s along it. Used by the
                  // cross-tile dedupe to evaluate "is this position
                  // too close to one already labelled with the same
                  // text?" without re-running the full glyph layout.
                  // Returns true into `_samplePosOut` (shared) or false.
                  const samplePosAt = (s: number): boolean => {
                    let acc = 0
                    for (let i = 0; i < pn - 1; i++) {
                      const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                      const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                      const segLen = Math.sqrt(dx * dx + dy * dy)
                      if (acc + segLen >= s) {
                        const t = segLen > 0 ? (s - acc) / segLen : 0
                        _samplePosOut[0] = _pxScratch[i]! + dx * t
                        _samplePosOut[1] = _pyScratch[i]! + dy * t
                        // Tangent angle in degrees (CCW from +x).
                        // icon-rotation-alignment=map uses this to
                        // rotate the icon along the line direction
                        // (OFM road_oneway arrow).
                        _samplePosOut[2] = Math.atan2(dy, dx) * 180 / Math.PI
                        return true
                      }
                      acc += segLen
                    }
                    return false
                  }
                  if (useTangentRotation) {
                    // Curved-text path: pack the projected polyline
                    // and ask TextStage to lay each glyph along it.
                    // Slice to the actual count — TextStage stores the
                    // view, so we have to hand it a fresh typed array
                    // that survives past the next callback iteration
                    // (the shared scratch gets overwritten).
                    const polyX = _pxScratch.slice(0, pn)
                    const polyY = _pyScratch.slice(0, pn)
                    // No fontKey override — see note at line ~2370.
                    if (total < spacingPx * 0.5) {
                      if (samplePosAt(total * 0.5)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        const tang = _samplePosOut[2]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)) {
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, total * 0.5,
                            featDef,
                            undefined, labelLayerName,
                          )
                          // OFM road shield + similar: icon-along-line
                          // approximation. Dispatch the icon at the
                          // line label's anchor so highway-shield-*
                          // layers (symbol-placement=line at z≥11)
                          // render road badges. Per-stop icon spacing
                          // matches the per-stop text spacing — better
                          // than no icons at all. User report 2026-05-18.
                          // tang carries the segment direction so
                          // icon-rotation-alignment=map (OFM road_oneway
                          // arrows) follows the road tangent.
                          dispatchIcon(featDef, sx, sy, tang)
                          recordTextPosition(resolvedTextForDedupe, sx, sy)
                        }
                      }
                      return
                    }
                    let nextStop = spacingPx * 0.5
                    while (nextStop <= total) {
                      if (samplePosAt(nextStop)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        const tang = _samplePosOut[2]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)) {
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, nextStop,
                            featDef,
                            undefined, labelLayerName,
                          )
                          dispatchIcon(featDef, sx, sy, tang)
                          recordTextPosition(resolvedTextForDedupe, sx, sy)
                        }
                      }
                      nextStop += spacingPx
                    }
                    perfMarkEnd('encoder.label-dispatch.line.emit')
                    perfMarkEnd('encoder.label-dispatch.line.polyline')
                    return
                  }
                  // Viewport-aligned path: keep the historical single-
                  // rotation emission per spacing point.
                  if (total < spacingPx * 0.5) {
                    let acc = 0
                    const target = total * 0.5
                    for (let i = 0; i < pn - 1; i++) {
                      const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                      const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                      const segLen = Math.sqrt(dx * dx + dy * dy)
                      if (acc + segLen >= target) {
                        const t = segLen > 0 ? (target - acc) / segLen : 0
                        emitLabelAlongSegment(_pxScratch[i]!, _pyScratch[i]!, _pxScratch[i + 1]!, _pyScratch[i + 1]!, t, props)
                        perfMarkEnd('encoder.label-dispatch.line.emit')
                        perfMarkEnd('encoder.label-dispatch.line.polyline')
                        return
                      }
                      acc += segLen
                    }
                    perfMarkEnd('encoder.label-dispatch.line.emit')
                    perfMarkEnd('encoder.label-dispatch.line.polyline')
                    return
                  }
                  let nextStop = spacingPx * 0.5
                  let acc = 0
                  for (let i = 0; i < pn - 1; i++) {
                    const dx = _pxScratch[i + 1]! - _pxScratch[i]!
                    const dy = _pyScratch[i + 1]! - _pyScratch[i]!
                    const segLen = Math.sqrt(dx * dx + dy * dy)
                    while (nextStop <= acc + segLen && nextStop <= total) {
                      const t = segLen > 0 ? (nextStop - acc) / segLen : 0
                      emitLabelAlongSegment(_pxScratch[i]!, _pyScratch[i]!, _pxScratch[i + 1]!, _pyScratch[i + 1]!, t, props)
                      nextStop += spacingPx
                    }
                    acc += segLen
                  }
                  perfMarkEnd('encoder.label-dispatch.line.emit')
                  perfMarkEnd('encoder.label-dispatch.line.polyline')
                })
              } else {
                // Single-label-per-feature fallback (line-center, or
                // line-placement with spacing=0). Uses the longest
                // segment chosen by forEachLineLabelFeature.
                vtEntry.renderer.forEachLineLabelFeature(sliceKey, (ax, ay, bx, by, props) => {
                  const [aLon, aLat] = mercToLonLat(ax, ay)
                  const [bLon, bLat] = mercToLonLat(bx, by)
                  const pa = projectLonLat(aLon, aLat)
                  const pb = projectLonLat(bLon, bLat)
                  if (!pa || !pb) return
                  emitLabelAlongSegment(pa[0], pa[1], pb[0], pb[1], 0.5, props)
                })
              }
            } else {
              // Cross-tile point-label dedupe: large named polygon
              // features (countries, oceans) cross tile boundaries
              // at low zoom and the worker emits a centroid PER tile
              // for the polygon's tile-clipped sub-shape. Without
              // dedupe the same name appears 2-3× across adjacent
              // tiles. Mirror the line-label dedupe (Set keyed by
              // stable name) to keep one emission per ShowCommand.
              // iter-280 — frame-scoped dedup (cleared at frame start
              // in renderFrame). Pre-iter-280 the Set was cleared per
              // ShowCommand entry, leaking cross-show duplicates.
              const emittedPointNames = this.host._scratchEmittedPointNames
              vtEntry.renderer.forEachLabelFeature(sliceKey, (mercX, mercY, props) => {
                // iter-274 — dedup by RESOLVED text-field output, not
                // raw `props.name`. OFM Bright bilingual text-field
                // (`["case", ["has", "name:nonlatin"], ["concat",
                // ["get", "name:latin"], "\n", ["get", "name:nonlatin"]],
                // ...]`) collapses two features with DIFFERENT raw
                // .name values to the SAME resolved string (e.g. one
                // feature .name="Seongnam", another .name="성남시" —
                // both resolve to "Seongnam\n성남시"). Pre-iter-274
                // dedup on raw .name treated these as distinct → both
                // dispatched → overlap at near-anchor positions →
                // visible "Se성남nam 시" / "Japan / 日本" → "J日a本"
                // collision-failure pattern user reported on live.
                //
                // iter-280 — include anchor proximity in the key. Two
                // distinct features sharing the same resolved string
                // at DIFFERENT world positions (rare but possible —
                // homonym place-names across the planet) should both
                // pass; only same-text-at-near-anchor is a duplicate
                // worth dropping. Bucket world-Mercator coords to
                // ~256 m grid (Math.round(merc / 256)) so anchors
                // within one OSM tile-cell collapse together.
                const featDef = applyFeatureExprs(props)
                const resolvedText = featDef.text
                  ? resolveText(featDef.text, props, this.host.camera.zoom, undefined)
                  : ''
                const dedupKey = resolvedText !== ''
                  ? `${resolvedText}|${Math.round(mercX / 256)},${Math.round(mercY / 256)}`
                  : ''
                if (dedupKey !== '' && emittedPointNames.has(dedupKey)) return
                if (dedupKey !== '') emittedPointNames.add(dedupKey)
                // No fontKey override — see note at line ~2370.
                // World-copy loop on MERCATOR coords directly — skips
                // the merc → lonLat → merc round-trip the previous
                // path did (one allocation + two trig stacks per call).
                // Mirror of `projectLonLatCopies` for non-mercator
                // projections is still needed because those reproject
                // through lonLat space; we handle that here inline.
                // iter 119: paired-symbol collision for point labels.
                const pairedWithIcon = featDef.iconImage !== undefined
                  && featDef.iconImage !== null && featDef.iconImage !== ''
                if (this.host.projectionName !== 'mercator') {
                  const [lon, lat] = mercToLonLat(mercX, mercY)
                  for (const projected of projectLonLatCopies(lon, lat)) {
                    const pairKey = pairedWithIcon
                      ? `${labelLayerName ?? ''}:${Math.round(projected[0])},${Math.round(projected[1])}`
                      : undefined
                    stage.addLabel(
                      featDef.text, props,
                      projected[0], projected[1], featDef,
                      undefined, labelLayerName, pairKey,
                    )
                    dispatchIcon(featDef, projected[0], projected[1], 0, pairKey)
                  }
                  return
                }
                // iter-189 — Mercator label world-copy iteration uses
                // camera-derived `visibleWorldCopies` (computed once
                // per frame from inverse-MVP corner unprojection).
                // No hardcoded [-2..+2] enum here. projectMerc still
                // returns null for any copy that lands outside the
                // projector's NDC ±1.5 window (rare overshoot at the
                // frustum edge) — defensive cull, not the primary
                // gate any more.
                for (const wo of visibleWorldCopies) {
                  const proj = projectMerc(mercX, mercY, wo * WORLD_MERC)
                  if (!proj) continue
                  const px = proj[0], py = proj[1]
                  const pairKey = pairedWithIcon
                    ? `${labelLayerName ?? ''}:${Math.round(px)},${Math.round(py)}`
                    : undefined
                  stage.addLabel(
                    featDef.text, props,
                    px, py, featDef,
                    undefined, labelLayerName, pairKey,
                  )
                  dispatchIcon(featDef, px, py, 0, pairKey)
                }
              })
            }
            // iter-262 — close the line/point sub-mark.
            perfMarkEnd(_ldMark)
          }
          perfMarkEnd('encoder.label-dispatch.show')
        }

        // iter-258 — label-dispatch loop ends here; mark close.
        perfMarkEnd('encoder.label-dispatch')
        perfMarkStart('encoder.stage-prepare')
        stage.prepare()
        if (iStage) iStage.setDroppedPairKeys(stage.getDroppedPairKeys())
        iStage?.prepare()
        perfMarkEnd('encoder.stage-prepare')
        // Text overlay v1: skipped in debug=overdraw — text pipeline
        // targets the swapchain format, not r16float. Phase 2 adds
        // a text debug pipeline so glyph + halo overdraw counts.
        if (!DEBUG_OVERDRAW) {
          ctx.passScope('text-overlay', () => {
            const tPass = encoder.beginRenderPass({
              colorAttachments: [{
                view: ctx.colorView,
                resolveTarget: ctx.useResolve ? ctx.screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              }],
            })
            // Icons render BEFORE text so labels read on top of their
            // POI badges — matches MapLibre's symbol-stage ordering.
            iStage?.render(tPass, { width: ctx.w, height: ctx.h })
            stage.render(tPass, { width: ctx.w, height: ctx.h })
            tPass.end()
          })
        }
        stage.reset()
      }
    }

    // ── Debug overdraw compose ──
    // Read the r16float accumulator and write a colormapped RGBA to
    // the swapchain. Runs as the LAST pass of the frame so it owns
    // the swapchain attachment.
    if (DEBUG_OVERDRAW && ctx.rt.overdrawAccumTexture) {
      ctx.passScope('overdraw-compose', () => {
        const pipeline = this.host.renderer.ensureOverdrawCompose()
        const compPass = encoder.beginRenderPass({
          colorAttachments: [{
            view: ctx.screenView,
            clearValue: { r: 0, g: 0, b: 0, a: 1 },
            loadOp: 'clear', storeOp: 'store',
          }],
        })
        const bg = this.host.ctx.device.createBindGroup({
          layout: this.host.renderer.overdrawComposeBindGroupLayout,
          entries: [{
            binding: 0,
            resource: ctx.rt.overdrawAccumTexture!.createView(),
          }],
        })
        compPass.setPipeline(pipeline)
        compPass.setBindGroup(0, bg)
        compPass.draw(3)
        compPass.end()
      })
    }

    // Flush CPU-side uniform-ring mirrors just before submit. WebGPU
    // orders writeBuffer-before-submit for us, so the encoded draws
    // still see fresh uniform data even though the writes happen
    // after encoder.finish(). Covers MapRenderer's `uniform-ring` and
    // LineRenderer's `line-layer-ring`; VTR's `vtr-uniform-ring`
    // already self-flushes at the end of each renderTileKeys.
    this.host.renderer.endFrame()
    this.host.lineRenderer?.endFrame()

    // GPU timing: resolve the queryset BEFORE finish so the same command
    // buffer carries the resolve+copy. Mapping happens after submit.
    this.host.gpuTimer?.resolveOnEncoder(encoder)

    // Outer scope catches the FRAME-level error (one entry per bad frame),
    // matching the inner scope opened right after createCommandEncoder().
    perfMarkEnd('frame.encode')
    perfMarkStart('frame.submit')
    device.queue.submit([encoder.finish()])
    perfMarkEnd('frame.submit')
    perfMarkEnd('frame.total')
    flushPerFrameMarks()

    // DIAG: dump per-frame draw order trace if armed. One-shot —
    // clears the flag so subsequent frames stay silent.
    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        __xgisCaptureDrawOrder?: boolean
        __xgisDrawOrderTrace?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
        __xgisDrawOrderResult?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
      }
      if (w.__xgisCaptureDrawOrder && w.__xgisDrawOrderTrace) {
        const trace = w.__xgisDrawOrderTrace
        // eslint-disable-next-line no-console
        console.log('[XGIS-DRAW-ORDER] frame trace (' + trace.length + ' calls):')
        for (const e of trace) {
          // eslint-disable-next-line no-console
          console.log(`  ${String(e.seq).padStart(2, ' ')}  extrude=${e.extrude.padEnd(10)}  phase=${e.phase.padEnd(8)}  slice="${e.slice}"`)
        }
        w.__xgisDrawOrderResult = trace.slice()
        w.__xgisCaptureDrawOrder = false
        w.__xgisDrawOrderTrace = undefined
      }
    }

    // Drain any readbacks that finished mapping last frame, kick mapAsync
    // on freshly-submitted ones. Cheap when disabled (no-op).
    this.host.gpuTimer?.pollReadbacks()
    device.popErrorScope().then((err) => {
      if (err) console.error('[X-GIS frame-validation]', err.message)
    }).catch(() => { /* scope mismatch — ignore */ })

    // Collect stats from renderers
    this.host._stats.zoom = this.host.camera.zoom
    const rs = this.host.renderer.getDrawStats()
    this.host._stats.drawCalls = rs.drawCalls
    this.host._stats.vertices = rs.vertices
    this.host._stats.triangles = rs.triangles
    this.host._stats.lines = rs.lines
    // iter-222 — bundle stats aggregation. Lifetime counters,
    // monotonic. Aggregate VTR per-source caches + BackgroundRenderer.
    // iter-228 — also aggregate LRU `evictions` so the panel shows
    // when the cap is firing.
    this.host._stats.bundleHits = 0
    this.host._stats.bundleMisses = 0
    this.host._stats.bundleEvictions = 0
    if (this.host.backgroundRenderer) {
      const bgs = this.host.backgroundRenderer.getBundleStats?.()
      if (bgs) {
        this.host._stats.bundleHits += bgs.hits
        this.host._stats.bundleMisses += bgs.misses
        this.host._stats.bundleEvictions += bgs.evictions
      }
    }
    let totalTilesVis = 0, totalTilesCached = 0, totalMissed = 0
    for (const [name, { renderer: vtR }] of this.host.vtSources) {
      if (!vtR.hasData()) continue
      const vts = vtR.getDrawStats()
      this.host._stats.drawCalls += vts.drawCalls
      this.host._stats.vertices += vts.vertices
      this.host._stats.triangles += vts.triangles
      this.host._stats.lines += vts.lines
      const vtbs = vtR.getBundleStats?.()
      if (vtbs) {
        this.host._stats.bundleHits += vtbs.hits
        this.host._stats.bundleMisses += vtbs.misses
        this.host._stats.bundleEvictions += vtbs.evictions
      }
      totalTilesVis += vts.tilesVisible
      totalTilesCached += vtR.getCacheSize()
      totalMissed += vts.missedTiles
      // Throttle [FLICKER] per-source to once per ~60 frames. On-demand
      // tile loading legitimately leaves some visible cells uncached for
      // a few frames; the warning is only informative for diagnosing
      // "missing fallback" regressions, not an error users need to see
      // at 60 Hz during normal pan/zoom.
      if (vts.missedTiles > 0) {
        // Grace period — ignore FLICKER for the first N frames after we
        // first observe missedTiles > 0 on this source. Initial-load
        // compile bursts routinely show 1–16 missed tiles for 2–8 frames
        // as on-demand compilation catches up; warning there is noise.
        // Only fire when missedTiles persist past the grace window, which
        // means an actual regression (GPU cache thrash, tile-drop bug).
        let firstSeen = this.host._flickerFirstFrame.get(name)
        if (firstSeen === undefined) {
          firstSeen = this.host._frameCount
          this.host._flickerFirstFrame.set(name, firstSeen)
        }
        const framesSinceFirst = this.host._frameCount - firstSeen
        if (framesSinceFirst >= XGISMap.FLICKER_GRACE_FRAMES) {
          const last = this.host._flickerLastFrame.get(name) ?? -Infinity
          if (this.host._frameCount - last >= 60) {
            this.host._flickerLastFrame.set(name, this.host._frameCount)
            const zRounded = Math.round(this.host.camera.zoom)
            const cacheSize = vtR.getCacheSize()
            console.warn(`[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${zRounded} gpuCache=${cacheSize})`)
            // Ring-buffer the event so inspectPipeline() can replay
            // the last few seconds without needing a live console capture.
            this.host._flickerLog.push({
              ts: typeof performance !== 'undefined' ? performance.now() : Date.now(),
              source: name, missed: vts.missedTiles, z: zRounded, cache: cacheSize,
            })
            if (this.host._flickerLog.length > XGISMap.FLICKER_LOG_CAP) {
              this.host._flickerLog.splice(0, this.host._flickerLog.length - XGISMap.FLICKER_LOG_CAP)
            }
          }
        }
      } else {
        // Clean frame clears the first-seen marker so a later burst (e.g.
        // after pan to a new region) gets its own grace window.
        this.host._flickerFirstFrame.delete(name)
      }
    }
    this.host._frameCount++
    this.host._stats.tilesVisible = totalTilesVis
    this.host._stats.tilesCached = totalTilesCached
    this.host._stats.endFrame()
    this.host._statsPanel?.update(this.host._stats.get())

    // Snapshot state for the idle-skip comparator in `shouldRenderThisFrame`.
    // Animation ticks + external invalidate() re-arm `_needsRender` on their
    // own path, so clearing it unconditionally here is safe.
    this.host._lastSigZoom = this.host.camera.zoom
    this.host._lastSigCX = this.host.camera.centerX
    this.host._lastSigCY = this.host.camera.centerY
    this.host._lastSigBearing = this.host.camera.bearing
    this.host._lastSigPitch = this.host.camera.pitch
    this.host._lastSigW = this.host.ctx.canvas.width
    this.host._lastSigH = this.host.ctx.canvas.height
    this.host._needsRender = false

    // Tile/texture loads still in flight keep the loop warm so the scene
    // converges. Covers three sources:
    //   - VT tiles with unresolved placeholders (missedTiles > 0)
    //   - VT tiles queued behind the per-frame upload budget
    //   - raster tiles mid-fetch
    if (totalMissed > 0 || this.host.rasterRenderer.hasPendingLoads()) {
      this.host._needsRender = true
    } else {
      for (const [, { renderer }] of this.host.vtSources) {
        if (renderer.hasPendingUploads()) { this.host._needsRender = true; break }
      }
    }

    requestAnimationFrame(this.host.renderLoop)
  }

  private _resolveFillPatterns(): void {
    const host = this.host.iconStage?.host
    if (!host) return
    if (host.getState().status !== 'loaded') return
    // iter-183 — push the real sprite atlas texture view into renderers
    // once (idempotent). Replaces the 1×1 white stub bound at binding
    // 5 since iter-181 so `fs_fill_pattern` (iter-182) actually samples
    // the loaded sprite atlas. Done lazily here (rather than at
    // iconStage creation) because the GPU buffer + bind groups are
    // wired by this point.
    if (!this.host._spriteAtlasViewPushed) {
      const view = this.host.iconStage?.gpu.getView()
      if (view) {
        this.host.renderer.setSpriteAtlas(view)
        for (const { renderer: vtRenderer } of this.host.vtSources.values()) {
          vtRenderer.setSpriteAtlasView(view)
        }
        this.host._spriteAtlasViewPushed = true
      }
    }
    // iter-183 — compute the sprite atlas UV bbox + the world-anchored
    // pattern repeat in absolute Mercator metres per show. The UV
    // bbox is constant (SpriteInfo doesn't change after atlas load),
    // but the repeat metres ARE camera-zoom-dependent: a sprite that
    // is 64 CSS px wide must repeat every 64 CSS px on screen, which
    // converts to `64 * WORLD_MERC / (256 * 2^cameraZoom)` Mercator
    // metres. Run once at load (UV bbox) + once per frame (repeat).
    const atlasSize = this.host.iconStage?.gpu.size() ?? { width: 0, height: 0 }
    const camZoom = this.host.camera.zoom
    const WORLD_MERC = 40075016.686
    const pxPerWorldAtZ = 256 * Math.pow(2, camZoom)
    const metersPerCssPx = WORLD_MERC / pxPerWorldAtZ
    for (const show of this.host.showCommands) {
      const name = show.fillPattern
      if (!name) continue
      if (show.resolvedFillRgba) {
        // Stage 1 colour already in place from a prior frame; still
        // populate Stage 2 fields if not yet resolved.
      } else {
        const px = host.getSpriteCenterColor(name)
        if (px) {
          show.resolvedFillRgba = [px[0] / 255, px[1] / 255, px[2] / 255, px[3] / 255]
          invalidateResolvedShowCache(show)
        }
      }
      // Stage 2 — UV bbox derived from SpriteInfo + atlas dims. The
      // SpriteInfo's x/y/width/height are atlas-pixel coords; divide
      // by atlas width/height to get the [0,1] UV bbox used by
      // textureSample in fs_fill_pattern. Cached once; the atlas
      // doesn't reshuffle after load.
      if (!show.fillPatternUV && atlasSize.width > 0) {
        const sprite = host.get(name)
        if (sprite) {
          const u0 = sprite.x / atlasSize.width
          const v0 = sprite.y / atlasSize.height
          const u1 = (sprite.x + sprite.width) / atlasSize.width
          const v1 = (sprite.y + sprite.height) / atlasSize.height
          show.fillPatternUV = [u0, v0, u1, v1]
        }
      }
      // Stage 2 — per-frame repeat metres. sprite.width is in atlas
      // PIXELS; divide by sprite.pixelRatio to get the design CSS
      // pixel width, then convert to Mercator metres at the current
      // camera zoom.
      const sprite = host.get(name)
      if (sprite) {
        const cssW = sprite.width / Math.max(sprite.pixelRatio, 1)
        const cssH = sprite.height / Math.max(sprite.pixelRatio, 1)
        show.fillPatternRepeatM = [cssW * metersPerCssPx, cssH * metersPerCssPx]
      }
    }
    // iter-178 — line-pattern Stage 1 mirror. Pulls the same sprite
    // centre pixel into `resolvedStrokeRgba` so polygon outlines and
    // line layers whose only stroke declaration was a `line-pattern`
    // get a visible colour instead of staying black/transparent.
    // iter-185 — adds Stage 2 line-pattern UV bbox + repeat metres
    // alongside the Stage 1 colour fallback. VTR routes pattern shows
    // to `linePipelinePattern` when both fields are set; otherwise
    // falls through to the Stage 1 solid stroke colour.
    for (const show of this.host.showCommands) {
      const name = show.linePattern
      if (!name) continue
      if (!show.resolvedStrokeRgba) {
        const px = host.getSpriteCenterColor(name)
        if (px) {
          show.resolvedStrokeRgba = [px[0] / 255, px[1] / 255, px[2] / 255, px[3] / 255]
          invalidateResolvedShowCache(show)
        }
      }
      // Stage 2 — UV bbox + repeat metres (same math as fill-pattern).
      if (!show.linePatternUV && atlasSize.width > 0) {
        const sprite = host.get(name)
        if (sprite) {
          const u0 = sprite.x / atlasSize.width
          const v0 = sprite.y / atlasSize.height
          const u1 = (sprite.x + sprite.width) / atlasSize.width
          const v1 = (sprite.y + sprite.height) / atlasSize.height
          show.linePatternUV = [u0, v0, u1, v1]
        }
      }
      const sprite = host.get(name)
      if (sprite) {
        const cssW = sprite.width / Math.max(sprite.pixelRatio, 1)
        const cssH = sprite.height / Math.max(sprite.pixelRatio, 1)
        show.linePatternRepeatM = [cssW * metersPerCssPx, cssH * metersPerCssPx]
      }
    }
  }

}
