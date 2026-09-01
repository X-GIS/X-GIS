// ═══ X-GIS RenderLoop — per-concern host ROLE views (Tier-B sub-bundle) ═══
//
// The render path used to reach the owning map through ONE flat ~57-key
// `Pick<XGISMap>` (`RenderLoopHost`). That made the host a serialization
// chokepoint: every render axis (a fill change, a line change, a label
// change) added a key to the SAME type, so unrelated edits collided on one
// declaration.
//
// The Pick is now SEGMENTED into per-pass / per-concern role views — each
// lists ONLY the members that role reads. Every role is still a
// `Pick<XGISMap>` so the field/method types stay in exact lock-step with
// the class (zero drift, no hand-maintained types), and the members stay
// package-internal on XGISMap (no `public` keyword) exactly as before.
// `RenderLoopHost` is now the INTERSECTION of every role, so the loop's
// `this.host` still sees the identical member set — this is a pure TYPE
// re-grouping with no change to the state (XGISMap still owns the fields)
// and no change to any value. The render-only `_resolveFillPatterns` is
// still NOT a host member — it lives in RenderLoop.

import type { XGISMap } from '../../map'

/** Background pass: the whole-viewport clear colour. */
export type BackgroundPassHost = Pick<
  XGISMap,
  // `inputs` for the same reason the opaque and hillshade hosts carry it
  // (#2218): resolveColorShape / resolveNumberShape only evaluate an
  // `input-dependent` shape when handed the store, and silently fall through
  // to the constant default without it. No style path builds such a shape for
  // the background today (style-top-level.ts only ever writes null or
  // 'zoom-interpolated'), so this moves no pixel — it removes the one call
  // site that would silently drop the value the day one does.
  '_backgroundColor' | '_backgroundColorShape' | '_backgroundOpacityShape' | 'inputs'
>

/** Atmosphere pass (#1258) — the globe limb-glow gradient. Reaches the style flag + the
 *  camera it both projects through and gates on (`camera.globeMode` — see atmosphere-pass.ts
 *  for why the projection-type check alone is not enough) + `ctx` for its lazily built
 *  Material and uniform buffer. */
export type AtmospherePassHost = Pick<XGISMap, '_atmosphere' | 'camera' | 'ctx'>

/** Opaque bucket: raster + coverage + opaque vector sub-passes. */
export type OpaquePassHost = Pick<
  XGISMap,
  | '_elapsedMs'
  | '_rasterShow'
  | 'camera'
  | 'coverageRenderer'
  // #1333 — the coverage drape samples the advected field this frame's flow pass produced.
  | 'flowRenderer'
  | 'gpuTimer'
  // #2166 — the live `input` values the per-frame raster-opacity resolve needs:
  // an `input-dependent` shape (`| opacity-[dim]`) is a per-frame CONSTANT, and
  // resolveNumberShape only evaluates it when it is handed this store.
  | 'inputs'
  | 'pointRenderer'
  | 'rasterRenderer'
  | 'renderer'
  | 'underOccluder'
>

/** Order-independent-transparency composite pass. */
export type OitPassHost = Pick<XGISMap, 'camera' | 'ctx' | 'renderer'>

/** Translucent-stroke offscreen + composite pass. */
export type TranslucentPassHost = Pick<XGISMap, 'camera' | 'lineRenderer' | 'renderer'>

/** Direct-layer points pass. */
export type PointsPassHost = Pick<XGISMap, 'camera' | 'pointRenderer'>

/** Hillshade pass (#777 Phase II) — the raster-dem DEM-relief overlay. Reaches
 *  the HillshadeRenderer + the active hillshade show (its resolved paint) + the
 *  camera it projects through + the frame clock for zoom/time shape resolution +
 *  the `input` store its layer-opacity resolve reads (#2166 — same reason as
 *  OpaquePassHost above). */
export type HillshadePassHost = Pick<
  XGISMap,
  'camera' | 'hillshadeRenderer' | '_hillshadeShow' | '_elapsedMs' | 'inputs'
>

/** Label + icon dispatch pass (text/icon stages, glyph/sprite sources,
 *  the label-dispatch memo counters, label-dirty bookkeeping). */
export type LabelPassHost = Pick<
  XGISMap,
  // #777 I-E — the lazy IconStage also loads the sprite atlas for a
  // background-pattern-only style (the pattern rides the synthetic
  // earth-surface show's fill-pattern path); `invalidate` re-arms the loop
  // when the async atlas lands on a label-less style.
  | '_backgroundPattern'
  | 'invalidate'
  | '_elapsedMs'
  | '_featureExprsCache'
  | '_labelsHaveTimeAnimation'
  | 'effectiveFadeDurationMs'
  | '_labelDispatchHits'
  | '_labelDispatchMisses'
  | '_labelDispatchLoopRuns'
  | '_pendingLabelDebugHook'
  | '_pendingTraceRecorder'
  | '_scratchEmittedLineIconKeys'
  | '_scratchEmittedPointNames'
  | '_scratchEmittedTextNames'
  | 'camera'
  | 'consumeLabelDirty'
  | 'markLabelDirty'
  | 'ctx'
  | 'fontTypography'
  | 'glyphProviders'
  | 'glyphsUrl'
  | 'graphics'
  | 'iconStage'
  | 'inlineGlyphs'
  | 'overlays'
  | 'projectionName'
  | 'rawDatasets'
  | 'showCommands'
  | 'spriteUrl'
  | 'textStage'
  | 'vtSources'
>

/** Overdraw debug-compose pass (?debug=overdraw). */
export type OverdrawComposePassHost = Pick<XGISMap, 'ctx' | 'renderer'>

/** Heatmap pass (Phase R) — the 3-pass accum/blur/compose pipeline, whole
 *  loop behind HeatmapRenderer.renderChainRhi (F3b Inc-2c); the camera comes
 *  off the FrameContext, so the host is just renderer + targets. */
export type HeatmapPassHost = Pick<XGISMap, 'heatmapRenderer' | 'heatmapTargets'>

/** Graphics pass (#797 P1) — the retained host-drawing icon batches. Reaches
 *  the map.graphics façade + the camera/ctx it projects + draws through. */
export type GraphicsPassHost = Pick<XGISMap, 'graphics' | 'camera' | 'ctx'>

/** Scene-upscale seam (#1429 INC-2) — samples the resolved scene colour into
 *  the screen attachment. Reaches only `ctx` (rhi + format for its lazily
 *  built Material); every view it touches rides the FrameContext bridges. */
export type SceneUpscalePassHost = Pick<XGISMap, 'ctx'>

/** Flow pass (#1333) — the IBFV advection step for an S-111-style velocity field. Reaches the
 *  FlowRenderer (targets + pipeline) and the CoverageRenderer the field lives on. No camera:
 *  the advection runs in the coverage's OWN grid raster, so it is camera-independent by
 *  construction — that is the property that makes panning and zooming leave the trail alone. */
export type FlowPassHost = Pick<XGISMap, 'flowRenderer' | 'coverageRenderer' | 'graphics'>

/** Per-frame scene classification (consumed by `buildSceneView`). */
export type SceneClassifyHost = Pick<
  XGISMap,
  | 'classifyVectorTileShows'
  | 'groupOpaqueBySource'
  | 'heatmapRenderer'
  | 'hillshadeRenderer'
  | 'coverageRenderer'
>

/** Members only the RenderLoop body itself touches — the frame clock,
 *  stats, flicker-watchdog, sprite-atlas push, redraw gate, render-target
 *  bookkeeping, GPU-fault event bus — that no single pass reaches through
 *  its host param. */
export type FrameLoopHost = Pick<
  XGISMap,
  // #1599 — the per-frame GPU-fault drain fires the typed map `'error'` event
  // ({ phase: 'gpufault' }) through the bus. Async validation faults never throw
  // out of renderFrame, so the 3-strike halt's try/catch cannot see them and this
  // is their only typed channel.
  | '_eventBus'
  | '_flickerFirstFrame'
  | '_flickerLastFrame'
  | '_flickerLog'
  | '_frameCount'
  | '_interacting'
  | '_lastSigBearing'
  | '_lastSigCX'
  | '_lastSigCY'
  | '_lastSigH'
  | '_lastSigPitch'
  | '_lastSigW'
  | '_lastSigZoom'
  | '_light'
  | '_missingTileCount'
  | '_needsRender'
  // #2149 — keepLoopWarm reads the raster/DEM kinds through the registry scope.
  | '_pendingWork'
  | '_spriteAtlasViewPushed'
  | '_scheduleFrame'
  | '_startTime'
  | '_stats'
  | '_statsPanel'
  | 'renderLoop'
  | 'renderTargets'
>

/** The full owning-map view the render loop reaches its members through —
 *  the INTERSECTION of every per-concern role. Identical member set to the
 *  flat Pick it replaces; `this.host` resolves exactly the same fields. */
export type RenderLoopHost = BackgroundPassHost &
  AtmospherePassHost &
  OpaquePassHost &
  OitPassHost &
  TranslucentPassHost &
  PointsPassHost &
  HillshadePassHost &
  LabelPassHost &
  OverdrawComposePassHost &
  HeatmapPassHost &
  GraphicsPassHost &
  FlowPassHost &
  SceneUpscalePassHost &
  SceneClassifyHost &
  FrameLoopHost
