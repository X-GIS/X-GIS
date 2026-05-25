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

import { markStart as perfMarkStart, markEnd as perfMarkEnd, flushPerFrameMarks } from './__profile__/perf-marks'
import { resizeCanvas, getSampleCount, getMaxDpr, isPickEnabled } from './gpu/gpu'
import { DEBUG_OVERDRAW } from './debug-flags'
import { WORLD_MERC, TILE_PX } from './gpu/gpu-shared'
import { invalidateResolvedShowCache } from './render/resolved-show'
import { type FrameContext } from './render/frame-context'
import { buildSceneView } from './render/scene-view'
import { opaquePass } from './render/passes/opaque-pass'
import { oitPass } from './render/passes/oit-pass'
import { translucentPass } from './render/passes/translucent-pass'
import { pointsPass } from './render/passes/points-pass'
import { labelPass } from './render/passes/label-pass'
import { overdrawComposePass } from './render/passes/overdraw-compose-pass'
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

      // ── Bucket 4: text overlays + per-feature labels ── (LabelPass — render/passes/label-pass.ts)
      labelPass.execute(ctx, scene, this.host)

      // ── Debug overdraw compose ── (OverdrawComposePass — render/passes/overdraw-compose-pass.ts)
      // Runs as the LAST pass of the frame so it owns the swapchain attachment.
      if (overdrawComposePass.shouldRun(scene)) overdrawComposePass.execute(ctx, scene, this.host)
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
