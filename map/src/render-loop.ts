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

import { EARTH, xlog } from '@xgis/shared'
import {
  markStart as perfMarkStart,
  markEnd as perfMarkEnd,
  flushPerFrameMarks,
} from './__profile__/perf-marks'
import { mercatorYToLat } from '@xgis/geo'
import {
  PROJECTION_NAME_TO_TYPE,
  isGlobeProj,
  promotesToGlobeWhenTilted,
  poleLimit,
} from '@xgis/geo'
import { adaptiveDprScale, effectiveDpr } from '@xgis/engine'
import { resizeCanvas, pushValidationError } from '@xgis/rhi-webgpu'
import { isOverdrawActive, sceneScalePinned } from './debug-flags'
import { WORLD_MERC, TILE_PX } from '@xgis/geo'
import { invalidateResolvedShowCache } from './render/resolved-show'
import { reportErrorScope } from './render-loop-helpers'
import { GpuFaultDrain } from './render-loop-gpu-fault'
import { keepLoopWarm } from './render-loop-keep-warm'
import { pumpFramePrefetch } from './render-loop-prefetch'
import {
  makeFrameContext,
  setFrameTargets,
  wireFrameColour,
  type FrameContext,
} from './render/frame-context'
import { makeProjectionToken, setProjectionToken } from './render/projection-token'
import type { RhiTexture, RhiTextureView } from '@xgis/engine'
import { asScreenPassDevice } from '@xgis/engine'
import { buildSceneView } from './render/scene-view'
import type { RenderNode } from './render/render-node'
import type { XGISMap } from './map'
// Host ROLE views (Tier-B sub-bundle): the flat ~57-key `Pick<XGISMap>` is
// now segmented into per-pass role views in render/passes/pass-hosts.ts;
// `RenderLoopHost` is their intersection. Re-exported here so the existing
// `import { RenderLoopHost } from '../render-loop'` consumers keep resolving.
import type { RenderLoopHost } from './render/passes/pass-hosts'
export type { RenderLoopHost } from './render/passes/pass-hosts'

// Flicker-detection tuning, render-loop-only. Relocated from XGISMap statics
// so this module imports XGISMap as a TYPE only — breaking the map<->render-loop
// runtime value-import cycle (the only value use of XGISMap here was these two
// constants). _flickerLog stays on XGISMap (per-map instance state).
/** Frames of grace before a missing-tile FLICKER warning fires. 240 = 4 s
 *  @60fps — PMTiles world-scale z0/z1 archives trigger multi-second worker
 *  compiles that legitimately delay the first slice; a shorter grace fired
 *  stale warnings for the entire load even though all was working as designed. */
const FLICKER_GRACE_FRAMES = 240
/** Cap on XGISMap._flickerLog — 32 entries ~= 30 s of the worst sustained
 *  case at the 60-frame throttle. */
const FLICKER_LOG_CAP = 32

export class RenderLoop {
  private readonly host: RenderLoopHost

  /** The single REUSED per-frame FrameContext. Lazily built on the first
   *  rendered frame, then mutated in place every subsequent frame — the
   *  60 Hz loop is allocation-paranoid (see the arena / scratch-reuse
   *  patterns in render()), so a fresh object per frame is forbidden. Its
   *  fields are repopulated at the SAME points the equivalent locals were
   *  computed before this struct existed, so behaviour is byte-identical. */
  private _ctx: FrameContext | null = null

  /** The content-registered render-pass chain (P2-carve Step 4). The engine
   *  iterates this frozen-order list each frame, running every node whose
   *  `shouldRun` gate passes — it no longer names a concrete pass or reaches
   *  the owning map through a `PassHost`. Registered once by content
   *  (map.ts → render/passes/pass-chain.ts) right after construction. */
  private readonly _nodes: RenderNode[] = []

  /** #1599 — per-frame drain of `ctx._validationErrors` onto the typed map
   *  `'error'` channel. Holds the last-surfaced entry + the rate-limit counter
   *  for this loop's lifetime. */
  private readonly _gpuFaults = new GpuFaultDrain()

  /** Content (map.ts) hands the engine its ordered RenderNode chain. */
  registerNodes(nodes: readonly RenderNode[]): void {
    this._nodes.length = 0
    for (const n of nodes) this._nodes.push(n)
  }

  constructor(map: XGISMap) {
    // Hold the owning map through the typed host view. The Pick-based
    // RenderLoopHost gives compile-time field/method checking while
    // keeping these members internal (not public) on XGISMap.
    this.host = map
  }

  render(): void {
    // Device-loss guard: once the GPU device is lost (driver reset, tab
    // backgrounding, OOM), every GPU call throws. Stop the loop entirely —
    // do NOT reschedule rAF — so we don't spew a cascade of "device is
    // lost" errors each frame. The host's onDeviceLost hook (if set) drives
    // recovery / re-init; a fresh map rebuilds the loop on a new device.
    if (this.host.ctx.deviceLost) return
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
    // ONE interaction-aware dpr per frame (#929 B): effectiveDpr() derives it
    // from the quality policy; resizeCanvas sizes the swapchain AND may reduce it
    // uniformly to fit maxTextureDimension2D (#1153 M3), RETURNING the value that
    // actually sized the buffer — adopt THAT for the camera/MVP math below so the
    // swapchain-vs-frame-math divergence stays structurally impossible. An opted-in
    // host renders at reduced QUALITY.interactionDpr during pan/zoom, full at rest.
    //
    // #1429 INC-2 — the adaptive ladder holds the SCENE target below native and the
    // seam reinflates it, so the CANVAS stays at the device's own dpr and the overlay
    // (labels, graphics) rasterises at native resolution. ?debug=overdraw pins 1 (that
    // mode writes the accumulator, not the scene colour the seam samples); ?scenescale
    // pins the ladder (the e2e seam gates).
    const sceneScale = isOverdrawActive(this.host.ctx.rhi.caps)
      ? 1
      : (sceneScalePinned() ?? adaptiveDprScale())
    const dpr = resizeCanvas(this.host.ctx, effectiveDpr(this.host._interacting))
    this._resolveFillPatterns()

    // Seed the animation clock on first rendered frame, then compute the
    // elapsed wall-clock milliseconds. Everything time-interpolated
    // (opacity today, color/width/etc. in later PRs) reads this value.
    if (this.host._startTime === null) this.host._startTime = performance.now()
    this.host._elapsedMs = performance.now() - this.host._startTime

    let projType = PROJECTION_NAME_TO_TYPE[this.host.projectionName] ?? 0
    // Azimuthal-when-tilted: ortho/azimuthal_eq/stereographic are exact
    // 2D discs at pitch=0 but promote to the true 3D sphere once the
    // user tilts. At pitch>0 we drive the globe vertex path (projType 7
    // → proj_globe) with the camera's ORTHOGRAPHIC orbit matrix
    // (globeOrtho was set in setProjection). At pitch=0 they stay on
    // their exact 2D projection so the CPU/GPU consistency contract and
    // each projection's identity (stereographic ≠ ortho) are preserved.
    const azimuthalTilted = promotesToGlobeWhenTilted(projType) && this.host.camera.pitch > 0
    // The SOURCE azimuthal projType (3/4/5) survives the promotion to 7 so
    // the globeOrtho framing path can apply that projType's flat view-height
    // cap (flatViewHeightCapM) — without this the promoted projType=7 would
    // feed the WORLD_MERC default into globeAltitude's ortho branch and the
    // ortho (3) disc, which needs the 2·EARTH_R cap, would jump scale the
    // instant the user tilts (project: azimuthal-disc-pitch-framing).
    this.host.camera.azimuthalProjType = projType
    if (azimuthalTilted) projType = 7
    this.host.camera.globeMode = isGlobeProj(projType)
    // Hand the resolved projection kind to the camera so zoomAt can pick
    // a projection-correct cursor anchor (orthographic needs the spherical
    // inverse, not the flat-Mercator-plane unproject).
    this.host.camera.projType = projType
    const { canvas } = this.host.ctx
    const w = canvas.width,
      h = canvas.height
    if (w === 0 || h === 0) {
      this.host._scheduleFrame()
      return
    }

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
    if (!Number.isFinite(this.host.camera.centerY)) {
      this.host.camera.centerY = 0
      this.host.camera.syncCenterLat()
    }
    if (!Number.isFinite(this.host.camera.zoom)) this.host.camera.zoom = 0
    if (!Number.isFinite(this.host.camera.bearing)) this.host.camera.bearing = 0
    // pitch goes through a setter (iter 368) so this is a defensive
    // mirror; the setter rejects non-finite, but a direct field
    // assignment from a host adapter could still slip past.
    if (!Number.isFinite(this.host.camera.pitch)) this.host.camera.pitch = 0
    if (!Number.isFinite(this.host.camera.minZoom)) this.host.camera.minZoom = 0
    if (!Number.isFinite(this.host.camera.maxZoom)) this.host.camera.maxZoom = 22
    const MAX_MERC = WORLD_MERC / 2
    const WORLD_MERC_FULL = MAX_MERC * 2 // full circumference
    // `dpr` was computed ONCE at the top of the frame and already sized the
    // swapchain via resizeCanvas — reusing it here keeps the MVP altitude
    // (canvasHeight/dpr) agreeing with the actual swapchain size under
    // presets that set interactionDpr (balanced/battery/?adaptiveDpr).
    const mpp = WORLD_MERC / TILE_PX / Math.pow(2, this.host.camera.zoom)
    const visHalfY = ((h / dpr) * mpp) / 2
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
      this.host.camera.centerX =
        (((over % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL) - MAX_MERC
    } else if (this.host.camera.centerX < -MAX_MERC) {
      const under = this.host.camera.centerX + MAX_MERC
      this.host.camera.centerX =
        (((under % WORLD_MERC_FULL) + WORLD_MERC_FULL) % WORLD_MERC_FULL) - MAX_MERC
    }

    // RTC: Camera center IS projection center. Always.
    const R = EARTH.sphereR
    const centerLon = (this.host.camera.centerX / R) * (180 / Math.PI)
    // Clamp the RTC-centre latitude to the projection's pole limit
    // (projections-table poleLimit SoT: ±85.051129° cylindrical, ±90° sphere —
    // replacing the scattered Mercator literal). The input is mercatorYToLat of
    // the Mercator-bounded centerY, so it never exceeds ±85.051129° today →
    // relaxing the sphere bound to 90 is a byte-identical no-op (roadmap S5
    // inert); the sphere allowance becomes live once centre storage holds true
    // latitude (S10).
    const rtcPoleLimit = poleLimit(this.host.camera.projType)
    const centerLat = Math.max(
      -rtcPoleLimit,
      Math.min(rtcPoleLimit, mercatorYToLat(this.host.camera.centerY)),
    )

    perfMarkEnd('frame.prep')

    // There is ONE frame shape now (#1046 Inc-F3a). This used to be
    // `twin ? 'twin' : 'chain'`, written from the branch the loop actually took —
    // the only honest discriminator while both existed, because the routing flag
    // and `caps.chainFrame` read true on the twin arm too. Kept as a literal
    // rather than deleted: the e2e gates that boot `?forcegl2=1` assert it, so it
    // is now a runtime pin that the deletion is COMPLETE — a frame reporting
    // anything else would mean a second shape survived.
    if (typeof window !== 'undefined')
      (window as { __xgisFrameArm?: string }).__xgisFrameArm = 'chain'
    // Pick params of the LAST PRESENTED frame — ONE authority, written before any
    // pass runs. It used to live inside the twin arm, which left every chain-arm
    // pickAt returning null, silently (#1046 Inc-F).
    this._lastFramePickParams = { projType, centerLon, centerLat, dpr, w, h }

    perfMarkStart('frame.encode')
    // Frame shell (#1046 F2/F3b, Inc-3 collapse; F4 Inc-D): the RHI is the ONE source
    // of the frame encoder + swapchain view, and with RenderTargets on RhiTexture no
    // native handle exists anywhere in the chain frame — the `__xgisRawFrameShell`
    // escape retired with the collapse, the loop-local unwraps with the Inc-A..D retypes.
    const rhiFrame = this.host.ctx.rhi
    const frameEnc = rhiFrame.acquireFrameEncoder()
    const rhiScreenView = rhiFrame.acquireScreenView()
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
    this.host.renderer.dispatchComputePass(frameEnc, this.host.gpuTimer)
    // Every active VTR also runs its per-tile compute kernels here
    // — they need to fire BEFORE the first render pass for the same
    // reason as MapRenderer: fragment shaders read the kernel output
    // buffer at draw time. No-op when no VTR has a compute-bound
    // show attached. Timer is consulted by the FIRST kernel that
    // dispatches each frame — see GPUTimer.computeWrites().
    for (const vtSource of this.host.vtSources.values()) {
      vtSource.renderer.dispatchComputePass(frameEnc, this.host.gpuTimer)
    }
    // DIAG: when set to `true`, the next frame's VTR.render() calls
    // log into __xgisDrawOrderTrace; we capture + console.log the
    // sequence at the end of the frame and clear the flag so only
    // ONE frame is captured. Set externally by tests / inspector.
    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        __xgisCaptureDrawOrder?: boolean
        __xgisDrawOrderTrace?: unknown[]
      }
      if (w.__xgisCaptureDrawOrder) {
        w.__xgisDrawOrderTrace = []
      }
    }
    // Wrap the entire frame in a validation scope so any pass-creation or
    // draw-call validation error gets a unique log entry pointing to the
    // submit. Each block below also pushes its own scope for finer locality.
    rhiFrame.pushValidationScope()

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
      rhiFrame.pushValidationScope()
      try {
        fn()
      } finally {
        // Report BOTH a resolved validation error AND a rejected pop —
        // the rejection was previously swallowed (Audit ⑧ B2).
        reportErrorScope(rhiFrame.popValidationScope(), `pass:${label}`, this.host.ctx)
      }
      perfMarkEnd(`encoder.pass.${label}`)
    }

    // ── Build / repopulate the single reused FrameContext ──
    // Bundles the per-frame locals computed above (plus the few derived deeper in the
    // frame: colorView / sampleCount / useResolve, set in the MSAA block). The values
    // are IDENTICAL to the locals and assigned at the same points; this is a pure
    // bundling. The projType / centerLon / centerLat triple is wrapped into the opaque
    // ProjectionToken (projection-token.ts) — the engine FrameContext is
    // projection-blind; only content unwraps it. The token is allocated once and
    // repopulated in place, like the context itself (allocation-paranoid).
    if (this._ctx === null) {
      this._ctx = makeFrameContext({
        rhi: this.host.ctx.rhi,
        rhiEncoder: frameEnc,
        rhiScreenView,
        camera: this.host.camera,
        projection: makeProjectionToken(projType, centerLon, centerLat),
        w,
        h,
        dpr,
        elapsedMs: this.host._elapsedMs,
        frameCount: this.host._frameCount,
        passScope,
        rt: this.host.renderTargets,
      })
    } else {
      const c = this._ctx
      // The DEVICE too: `map.run()` re-boots swap `host.ctx` wholesale (map.ts), and a
      // context pinned to the first frame's device answers its caps — which is fatal now
      // that pass wiring reads them (maxSampleCount, presentablePassMrt).
      c.rhi = this.host.ctx.rhi
      c.rhiEncoder = frameEnc
      c.rhiScreenView = rhiScreenView
      c.camera = this.host.camera
      setProjectionToken(c.projection, projType, centerLon, centerLat)
      c.elapsedMs = this.host._elapsedMs
      c.frameCount = this.host._frameCount
      c.passScope = passScope
      c.rt = this.host.renderTargets
      // colorView / sampleCount / useResolve: repopulated at their own (deeper)
      // computation points below. Field parity with the builder above is GATED —
      // frame-context-refresh-parity.test.ts (a forgotten field freezes at frame 1).
    }
    const ctx = this._ctx
    // BOTH population branches route through the one geometry site (its doc's
    // contract): screen = the native canvas, scene = screen × the ladder's
    // scale (the forced-WebGL2 twin, deleted #1046 Inc-F3a, scaled the canvas
    // instead of the scene target, #1429 INC-2).
    setFrameTargets(ctx, w, h, dpr, sceneScale)

    {
      // ═══ Direct rendering: vertex shader handles all projections ═══
      // MSAA + stencil + OIT + pick + overdraw render-target lifecycle
      // (recreate-on-resize) lives in RenderTargets (@xgis/rhi-webgpu):
      // `ensure` recreates exactly when the inline gate did, in the same
      // destroy → recreate order, then returns the per-frame colorView
      // decision. Sample count = QUALITY.msaa clamped to the device cap.
      // ensure() + colorView decision + the F3b / #1429 bridge population,
      // extracted VERBATIM to wireFrameColour (frame-context.ts, piece 6).
      wireFrameColour(ctx, rhiScreenView)

      // Reset per-frame uniform ring cursors (dynamic-offset slots).
      this.host.renderer.beginFrame()
      this.host.lineRenderer?.beginFrame()
      this.host.rasterRenderer.beginFrame()
      this.host.hillshadeRenderer.beginFrame()
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
      // WS-9 — push the top-level fill-extrusion light into every VTR. Cheap
      // (3 scalar stores); keeps each VTR's per-tile light pack current with
      // the latest setLight() without per-creation-site seeding.
      for (const [, { renderer: vtR }] of this.host.vtSources) vtR.setLight(this.host._light)
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
        const R = EARTH.sphereR
        const lon = (camMx / R) * (180 / Math.PI)
        const lat = mercatorYToLat(camMy)
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
          // SCREEN density, to match the SCREEN extent above (`canvas.width/height`). Equal to
          // the scene's today, so this is byte-identical — but pairing a screen extent with a
          // scene density would make the record internally mixed the moment INC-2 splits them,
          // and a replayed trace would be reconstructing a viewport that never existed.
          viewportWidthPx: cw,
          viewportHeightPx: ch,
          dpr: ctx.screen.dpr,
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

      // ── Render-pass chain ── (content-registered RenderNode[] — render/render-node.ts)
      // Iterate the frozen-order node list registered by content (map.ts →
      // render/passes/pass-chain.ts): background → opaque → oit → translucent →
      // points → label → heatmap → overdraw-compose. Each node's shouldRun
      // reproduces its former inline `if` gate (background / opaque / label are
      // unconditional → shouldRun()===true). The engine no longer names a pass
      // or hands it a PassHost — nodes capture their own map host. The OIT node
      // sits at its historical slot but is runtime-dead (shouldRun immutably
      // false), so it is never live — folded out of the live path here.
      for (const node of this._nodes) {
        if (node.shouldRun(scene)) node.execute(ctx, scene)
      }

      // Anticipatory prefetch, AFTER the passes that populate each source's frame tile
      // selection — it used to run before them, so it never ran at all (#1587). Still
      // once per wall-clock frame, which is what living in this function is for.
      pumpFramePrefetch(this.host, projType, ctx.scene)
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
    this.host.gpuTimer?.resolveOnRhi(frameEnc)

    // Outer scope catches the FRAME-level error (one entry per bad frame),
    // matching the inner scope opened right after createCommandEncoder().
    perfMarkEnd('frame.encode')
    perfMarkStart('frame.submit')
    // F2: the RHI frame encoder owns the single per-frame submit.
    frameEnc.finish()
    perfMarkEnd('frame.submit')
    // Inc-E1 (flip precondition MINOR-5): drain the WebGL2 frame-encoder GL-error
    // queue into the capped writer (#1153 P2 R6) — the twin's consumer mirrored.
    for (const message of rhiFrame.takeGlErrors?.() ?? []) {
      pushValidationError(this.host.ctx, message)
    }
    // #1599 — re-emit the queue's NEW entries (this frame's GL drain, the WebGPU
    // uncapturederror listener, last frame's popped scopes) on the typed map
    // 'error' channel. Async GPU faults never throw out of render(), so the
    // 3-strike halt cannot see them; this is their only typed channel.
    this._gpuFaults.drain(this.host.ctx, this.host._eventBus)
    perfMarkEnd('frame.total')
    flushPerFrameMarks()

    // DIAG: dump per-frame draw order trace if armed. One-shot —
    // clears the flag so subsequent frames stay silent.
    if (typeof window !== 'undefined') {
      const w = window as unknown as {
        __xgisCaptureDrawOrder?: boolean
        __xgisDrawOrderTrace?: Array<{ seq: number; slice: string; phase: string; extrude: string }>
        __xgisDrawOrderResult?: Array<{
          seq: number
          slice: string
          phase: string
          extrude: string
        }>
      }
      if (w.__xgisCaptureDrawOrder && w.__xgisDrawOrderTrace) {
        const trace = w.__xgisDrawOrderTrace

        console.log('[XGIS-DRAW-ORDER] frame trace (' + trace.length + ' calls):')
        for (const e of trace) {
          console.log(
            `  ${String(e.seq).padStart(2, ' ')}  extrude=${e.extrude.padEnd(10)}  phase=${e.phase.padEnd(8)}  slice="${e.slice}"`,
          )
        }
        w.__xgisDrawOrderResult = trace.slice()
        w.__xgisCaptureDrawOrder = false
        w.__xgisDrawOrderTrace = undefined
      }
    }

    // Drain any readbacks that finished mapping last frame, kick mapAsync
    // on freshly-submitted ones. Cheap when disabled (no-op).
    this.host.gpuTimer?.pollReadbacks()
    reportErrorScope(rhiFrame.popValidationScope(), 'frame-validation', this.host.ctx)

    // Collect stats from renderers
    this.host._stats.zoom = this.host.camera.zoom
    const rs = this.host.renderer.getDrawStats()
    this.host._stats.drawCalls = rs.drawCalls
    this.host._stats.vertices = rs.vertices
    this.host._stats.triangles = rs.triangles
    this.host._stats.lines = rs.lines
    // iter-222 — bundle stats aggregation. Lifetime counters,
    // monotonic. Aggregate VTR per-source caches.
    // iter-228 — also aggregate LRU `evictions` so the panel shows
    // when the cap is firing.
    // Phase 2 PR 2c.3 — BackgroundRenderer retired; bundle stats
    // contribution removed.
    this.host._stats.bundleHits = 0
    this.host._stats.bundleMisses = 0
    this.host._stats.bundleEvictions = 0
    let totalTilesVis = 0,
      totalTilesCached = 0,
      totalMissed = 0
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
        if (framesSinceFirst >= FLICKER_GRACE_FRAMES) {
          const last = this.host._flickerLastFrame.get(name) ?? -Infinity
          if (this.host._frameCount - last >= 60) {
            this.host._flickerLastFrame.set(name, this.host._frameCount)
            const zRounded = Math.round(this.host.camera.zoom)
            const cacheSize = vtR.getCacheSize()
            xlog.warn(
              `[FLICKER] ${name}: ${vts.missedTiles} tiles without fallback (z=${zRounded} gpuCache=${cacheSize})`,
            )
            // Ring-buffer the event so inspectPipeline() can replay
            // the last few seconds without needing a live console capture.
            this.host._flickerLog.push({
              ts: typeof performance !== 'undefined' ? performance.now() : Date.now(),
              source: name,
              missed: vts.missedTiles,
              z: zRounded,
              cache: cacheSize,
            })
            if (this.host._flickerLog.length > FLICKER_LOG_CAP) {
              this.host._flickerLog.splice(0, this.host._flickerLog.length - FLICKER_LOG_CAP)
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
    // Per-frame in-flight tile count for the public `getMissingTileCount()`
    // accessor (loading affordance). Same three signals the keep-warm gate
    // below ORs, summed: VT cells without a drawable tile + raster/hillshade
    // tiles mid-fetch. Settles to 0 exactly when that gate stops re-arming.
    this.host._missingTileCount =
      totalMissed +
      this.host.rasterRenderer.pendingLoadCount() +
      this.host.hillshadeRenderer.pendingLoadCount()
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

    this.host._needsRender = keepLoopWarm({
      totalMissed,
      raster: this.host.rasterRenderer,
      hillshade: this.host.hillshadeRenderer,
      vtRenderers: this.host.vtSources.values(),
    })

    this.host._scheduleFrame()
  }

  // ── #834 M5 s6 — on-demand WebGL2 PICK pass ─────────────────────────────────
  /** Frame params snapshotted at the top of every frame so a pick samples the
   *  LAST PRESENTED frame's camera/projection state (either frame shape). */
  private _lastFramePickParams: {
    projType: number
    centerLon: number
    centerLat: number
    dpr: number
    w: number
    h: number
  } | null = null
  /** The pick render targets: a scratch colour (MRT slot 0 nobody presents),
   *  the rg32uint pick attachment, and a depth-stencil (the fill pick variant
   *  depth-writes + stencils exactly like the colour pass). */
  private _pickRtRhi: {
    color: RhiTexture
    colorView: RhiTextureView
    pick: RhiTexture
    pickView: RhiTextureView
    depth: RhiTexture
    depthView: RhiTextureView
    w: number
    h: number
  } | null = null

  /** Render the pickable fills into the offscreen colour+rg32uint MRT and read
   *  the one texel under (px, py) — device pixels, top-left origin. Returns the
   *  raw [featureId, packed] pair (packed = (instanceId<<16)|layerId) or null
   *  when no frame has been presented yet. Synchronous by GL nature — the
   *  interaction-controller's WebGPU mapAsync pool is not involved. */
  pickViaRhi(px: number, py: number): [number, number] | null {
    const rhi = asScreenPassDevice(this.host.ctx.rhi)
    const f = this._lastFramePickParams
    if (!rhi || !f) return null
    if (px < 0 || py < 0 || px >= f.w || py >= f.h) return null
    let rt = this._pickRtRhi
    if (!rt || rt.w !== f.w || rt.h !== f.h) {
      if (rt) {
        rhi.destroyTexture(rt.color)
        rhi.destroyTexture(rt.pick)
        rhi.destroyTexture(rt.depth)
      }
      const color = rhi.createTexture({
        width: f.w,
        height: f.h,
        format: 'rgba8unorm',
        usage: ['render'],
        label: 'pick-scratch-color-rhi',
      })
      const pick = rhi.createTexture({
        width: f.w,
        height: f.h,
        format: 'rg32uint',
        usage: ['render', 'copy-src'],
        label: 'pick-rg32-rhi',
      })
      const depth = rhi.createTexture({
        width: f.w,
        height: f.h,
        format: 'depth24plus-stencil8',
        usage: ['render'],
        label: 'pick-depth-rhi',
      })
      rt = this._pickRtRhi = {
        color,
        colorView: rhi.createView(color),
        pick,
        pickView: rhi.createView(pick),
        depth,
        depthView: rhi.createView(depth),
        w: f.w,
        h: f.h,
      }
    }
    const pass = rhi.beginOffscreenPass({
      label: 'pick-pass-rhi',
      colorAttachments: [
        { view: rt.colorView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
        { view: rt.pickView, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
      ],
      depthStencilAttachment: {
        view: rt.depthView,
        depthLoadOp: 'clear',
        depthClearValue: 1,
        depthStoreOp: 'store',
        stencilLoadOp: 'clear',
        stencilClearValue: 0,
        stencilStoreOp: 'store',
      },
    })
    for (const [, { renderer: vtR }] of this.host.vtSources) {
      vtR.beginFrame(this.host._frameCount)
    }
    const classified = this.host.classifyVectorTileShows()
    for (const c of classified.opaque) {
      const vt = this.host.vtSources.get(c.sourceName)
      if (!vt) continue
      vt.renderer.renderFillsRhi(
        pass,
        this.host.camera,
        f.projType,
        f.centerLon,
        f.centerLat,
        f.w,
        f.h,
        f.dpr,
        c.show,
        c.resolvedShow,
        'pick',
      )
    }
    pass.end()
    // The FBO image is bottom-up (GL window coords) — flip from screen rows.
    return rhi.readPixelRg32ui(rt.pick, px, f.h - 1 - py)
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
      if (this.host.ctx.rhi.backend === 'webgl2') {
        // #834 M5 slice 5 — push the atlas's RHI handles so the VTR
        // line-pattern tile bind group samples the real sprite atlas (the
        // native GPUTextureView push below rebuilds WebGPU bind groups, which
        // are proxy no-ops on this backend).
        const gpu = this.host.iconStage?.gpu
        const rhiView = gpu?.rhiView?.()
        const rhiSampler = gpu?.rhiSampler?.()
        if (rhiView && rhiSampler) {
          for (const { renderer: vtRenderer } of this.host.vtSources.values()) {
            vtRenderer.setSpriteAtlasRhi(rhiView, rhiSampler)
          }
          this.host._spriteAtlasViewPushed = true
        }
      } else {
        // WebGPU sprite-atlas push (the WebGL2 rhiView/rhiSampler push is the
        // `if` above). getView is the now-optional WebGPU half (#1261); on
        // WebGPU the atlas carries it, on WebGL2 this branch never runs.
        const view = this.host.iconStage?.gpu.getView?.()
        if (view) {
          this.host.renderer.setSpriteAtlas(view)
          for (const { renderer: vtRenderer } of this.host.vtSources.values()) {
            vtRenderer.setSpriteAtlasView(view)
          }
          this.host._spriteAtlasViewPushed = true
        }
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
    const pxPerWorldAtZ = 256 * Math.pow(2, camZoom)
    const metersPerCssPx = WORLD_MERC / pxPerWorldAtZ
    for (const show of this.host.showCommands) {
      const name = show.fillPattern
      if (!name) continue
      if (show.resolvedFillRgba) {
        // Stage 1 colour already in place from a prior frame; still
        // populate Stage 2 fields if not yet resolved.
      } else {
        const px = host.getSpriteCenterColor?.(name)
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
        const px = host.getSpriteCenterColor?.(name)
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
