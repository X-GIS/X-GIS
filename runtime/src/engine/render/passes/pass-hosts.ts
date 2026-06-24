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
export type BackgroundPassHost = Pick<XGISMap,
  | '_backgroundColor'
  | '_backgroundColorShape'
  | '_backgroundOpacityShape'
>

/** Opaque bucket: raster + opaque vector sub-passes. */
export type OpaquePassHost = Pick<XGISMap,
  | '_elapsedMs'
  | '_rasterShow'
  // EXPERIMENTAL approach-B globe vector drape opt-in (non-Mercator only).
  | '_experimentalGlobeDrape'
  | 'camera'
  | 'gpuTimer'
  | 'pointRenderer'
  | 'rasterRenderer'
  | 'renderer'
  // PoC US-S3 (bake-drape debug hook) — read a VectorTileRenderer to bake a
  // cached tile. Only touched behind `globalThis.__xgisDebugBakeDrape`.
  | 'vtSources'
>

/** Order-independent-transparency composite pass. */
export type OitPassHost = Pick<XGISMap,
  | 'camera'
  | 'ctx'
  | 'renderer'
>

/** Translucent-stroke offscreen + composite pass. */
export type TranslucentPassHost = Pick<XGISMap,
  | 'camera'
  | 'lineRenderer'
  | 'renderer'
>

/** Direct-layer points pass. */
export type PointsPassHost = Pick<XGISMap,
  | 'camera'
  | 'pointRenderer'
>

/** Label + icon dispatch pass (text/icon stages, glyph/sprite sources,
 *  the label-dispatch memo counters, label-dirty bookkeeping). */
export type LabelPassHost = Pick<XGISMap,
  | '_featureExprsCache'
  | '_labelsHaveTimeAnimation'
  | '_labelDispatchHits'
  | '_labelDispatchMisses'
  | '_pendingLabelDebugHook'
  | '_pendingTraceRecorder'
  | '_prevLabelDispatchSig'
  | '_scratchEmittedPointNames'
  | '_scratchEmittedTextNames'
  | 'camera'
  | 'consumeLabelDirty'
  | 'markLabelDirty'
  | 'ctx'
  | 'fontTypography'
  | 'glyphProviders'
  | 'glyphsUrl'
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
export type OverdrawComposePassHost = Pick<XGISMap,
  | 'ctx'
  | 'renderer'
>

/** Heatmap pass (Phase R) — the 3-pass accum/blur/compose pipeline. */
export type HeatmapPassHost = Pick<XGISMap,
  | 'camera'
  | 'ctx'
  | 'heatmapRenderer'
  | 'renderer'
>

/** Per-frame scene classification (consumed by `buildSceneView`). */
export type SceneClassifyHost = Pick<XGISMap,
  | 'classifyVectorTileShows'
  | 'groupOpaqueBySource'
  | 'heatmapRenderer'
>

/** Members only the RenderLoop body itself touches — the frame clock,
 *  stats, flicker-watchdog, sprite-atlas push, redraw gate, render-target
 *  bookkeeping — that no single pass reaches through its host param. */
export type FrameLoopHost = Pick<XGISMap,
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
  | '_startTime'
  | '_stats'
  | '_statsPanel'
  | 'renderLoop'
  | 'renderTargets'
>

/** The full owning-map view the render loop reaches its members through —
 *  the INTERSECTION of every per-concern role. Identical member set to the
 *  flat Pick it replaces; `this.host` resolves exactly the same fields. */
export type RenderLoopHost =
  & BackgroundPassHost
  & OpaquePassHost
  & OitPassHost
  & TranslucentPassHost
  & PointsPassHost
  & LabelPassHost
  & OverdrawComposePassHost
  & HeatmapPassHost
  & SceneClassifyHost
  & FrameLoopHost
