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
  '_backgroundColor' | '_backgroundColorShape' | '_backgroundOpacityShape'
>

/** Opaque bucket: raster + coverage + opaque vector sub-passes. */
export type OpaquePassHost = Pick<
  XGISMap,
  | '_elapsedMs'
  | '_rasterShow'
  | 'camera'
  | 'coverageRenderer'
  | 'gpuTimer'
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
 *  camera it projects through + the frame clock for zoom/time shape resolution. */
export type HillshadePassHost = Pick<
  XGISMap,
  'camera' | 'hillshadeRenderer' | '_hillshadeShow' | '_elapsedMs'
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
  | '_featureExprsCache'
  | '_labelsHaveTimeAnimation'
  | '_labelDispatchHits'
  | '_labelDispatchMisses'
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

/** Heatmap pass (Phase R) — the 3-pass accum/blur/compose pipeline. */
export type HeatmapPassHost = Pick<
  XGISMap,
  'camera' | 'ctx' | 'heatmapRenderer' | 'heatmapTargets' | 'renderer'
>

/** Graphics pass (#797 P1) — the retained host-drawing icon batches. Reaches
 *  the map.graphics façade + the camera/ctx it projects + draws through. */
export type GraphicsPassHost = Pick<XGISMap, 'graphics' | 'camera' | 'ctx'>

/** Per-frame scene classification (consumed by `buildSceneView`). */
export type SceneClassifyHost = Pick<
  XGISMap,
  'classifyVectorTileShows' | 'groupOpaqueBySource' | 'heatmapRenderer' | 'hillshadeRenderer'
>

/** Members only the RenderLoop body itself touches — the frame clock,
 *  stats, flicker-watchdog, sprite-atlas push, redraw gate, render-target
 *  bookkeeping — that no single pass reaches through its host param. */
export type FrameLoopHost = Pick<
  XGISMap,
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
  | '_needsRender'
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
  OpaquePassHost &
  OitPassHost &
  TranslucentPassHost &
  PointsPassHost &
  HillshadePassHost &
  LabelPassHost &
  OverdrawComposePassHost &
  HeatmapPassHost &
  GraphicsPassHost &
  SceneClassifyHost &
  FrameLoopHost
