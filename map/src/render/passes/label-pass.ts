// ═══ Bucket 4: text-overlay + per-feature label pass ═══
//
// Relocated VERBATIM from RenderLoop.render. Resolves per-feature label
// + icon work (map.addOverlay overlays and ShowCommand .label defs),
// emits glyph/icon quads into the lazily-built TextStage / IconStage,
// then flushes them to the swapchain in the text-overlay sub-pass. This
// is the largest pass: it owns the world-copy iteration, the four label
// anchor projectors, point/line label placement, icon dispatch, and the
// screen-space collision + atlas plumbing.
//
// Mechanical changes only: `this.host.X` -> `host.X`; the render-local
// scalars the block read (dpr / sampleCount / w / h) are re-bound from ctx
// at the top, and projType / centerLon / centerLat are decoded from the
// opaque ctx.projection token (projection-token.ts) — this pass owns that
// unwrap. `visibleWorldCopies` is produced + consumed entirely here
// (label-node-local state, no longer a FrameContext field). The text-overlay
// sub-pass originates through the RHI frame shell (#1046 F3b).

import { evaluate, groundAlignsAtRuntime, makeEvalProps, resolveColor } from '@xgis/compiler'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../../__profile__/perf-marks'
import { WORLD_MERC } from '@xgis/geo'
import { activeBody } from '@xgis/shared'
import { mercatorYToLat } from '@xgis/geo'
import { isGlobeProj } from '@xgis/geo'
import { projMercatorCpu } from '../../shaders/dsl/cpu-projections'
import { resolveLabelEffectiveDef, makeLabelProjectors } from '../../render-loop-helpers'
import {
  sampleReplayRefs,
  solveReplayTransform,
  REPLAY_REFS_LEN,
  type LabelReplayTransform,
} from './label-replay-transform'
import { computeSliceKey } from '@xgis/data'
import {
  LineLabelDropStats,
  countedCull,
  countedEmit,
  latticeMissesRun,
  type LineLabelDropCounts,
} from './line-label-drop-stats'
import { TIEBREAK_GROUP_SEP } from '../../text/text-collision'
import type { MotionHoldoverCtx } from '../../text/holdover-reproject'
import { TextStage } from '../../text/text-stage'
import type { TextStageOptions } from '../../text/text-stage-types'
import { IconStage } from '../../sprite/icon-stage'
import { spriteAtlasNeeded } from './sprite-atlas-need'
import { resolveText } from '../../text/text-resolver'
import { hexToRgba, featureAnchor } from '../../feature-helpers'
import { resolveIconRotateRad } from './icon-keep-upright-rotate'
import {
  dispatchCoverageSoundings,
  soundingStrideInvalidates,
  soundingUnprojector,
} from './dispatch-coverage-soundings'
import { ensureBackgroundPatternAtlas } from './background-pattern-atlas'
import { type ShowCommand } from '../renderer-types'
import type { FrameContext } from '../frame-context'
import { unwrapProjection } from '../projection-token'
import { Pitch0Unprojector, makeGroundMercProjector } from '../../camera/pitch0-unproject'
import { dispatchPointLabel, makeGroundBasisFor } from './dispatch-point-labels'
import {
  curvedRunIdentity,
  emitCurvedLineLabels,
  measureRunCadence,
  projectRunToLabelPlane,
  type CurvedLineLabelDeps,
} from './dispatch-curved-line-labels'
import type { SceneView } from '../scene-view'
import { requireRhiFrame, type RenderPass, type LabelPassHost } from './pass'
import {
  LINE_LABEL_EDGE_INSET_CSS_PX,
  lineLabelEdgeInsetPx,
  lineLabelSpacingPx,
  placeLabelsAlongLine,
  lineLabelFirstStopPx,
  makeEmitLabelAlongSegment,
  placeInlineLineLabels,
  withinViewportInset,
} from './place-labels-along-line'
// Extracted helpers (re-exported: existing importers, tests included, are unaffected).
export {
  lineLabelDeduped,
  lineIconIsIconOnly,
  lineLabelDedupeKey,
  pointLabelPairKey,
  shouldEmitPointDedup,
} from './line-label-dedupe'
import {
  lineLabelDeduped,
  lineIconIsIconOnly,
  pointLabelPairKey,
  shouldEmitPointDedup,
} from './line-label-dedupe'

/** #728 — STABLE per-feature collision identity, fed to the greedy collision
 *  pass as its `tieBreak` (addLabel/addCurvedLineLabel → PendingLabel.collisionId
 *  → CollisionItem.tieBreak). Two overlapping labels then resolve to the SAME
 *  winner regardless of tile-dispatch order, removing the pan-swap where the
 *  survivor flipped with which tiles happened to be loaded.
 *
 *  Encoded as `<layerPrecedence>TIEBREAK_GROUP_SEP<featureIdentity>` (the
 *  separator const is owned by text-collision.ts, whose greedy pass splits
 *  the GROUP segment back out: group → nearY (near-first) → identity):
 *   - layerPrecedence preserves MapLibre's "later layer wins" rule — a later
 *     show (higher layer) must sort FIRST (ascending tieBreak) to win the
 *     collision, so it is `showCount - showIdx` zero-padded to a constant
 *     width, making the lexicographic string compare match the numeric order.
 *   - featureIdentity is the caller's pan-invariant key (points: resolved text
 *     + quantized world position; lines: the tile-stable layer+route lineId),
 *     which deterministically disambiguates same-layer overlappers.
 *  Exported for unit coverage — the dispatch sites are anon callbacks. */
export function labelCollisionId(
  showIdx: number,
  showCount: number,
  featureIdentity: string,
): string {
  const width = String(Math.max(1, showCount)).length
  const invLayer = String(showCount - showIdx).padStart(width, '0')
  return `${invLayer}${TIEBREAK_GROUP_SEP}${featureIdentity}`
}

/** Per-segment sample count for line-label placement, computed from the
 *  segment's SCREEN length (metres × on-screen px-per-metre), not raw metres.
 *  A segment that crosses the viewport but whose endpoints fall outside the
 *  NDC window must be subdivided so an interior sample lands on-screen —
 *  otherwise the projected polyline is degenerate and the label silently
 *  drops (the deep-zoom road-label vanish bug: a ~360 m road segment at z19
 *  spans ~2500 px yet is far below any metre threshold). Genuinely short
 *  on-screen segments resolve to 1 (low-zoom perf preserved). Clamped to
 *  [1, maxSteps]; `pxPerMeter <= 0` (camera centre unprojectable) falls back
 *  to 1. Exported for unit coverage — the placement walk is an anon callback. */
export function lineLabelSubdivSteps(
  segLenM: number,
  pxPerMeter: number,
  gapPx: number,
  maxSteps: number,
): number {
  if (!(pxPerMeter > 0) || !(gapPx > 0)) return 1
  const segScreenPx = segLenM * pxPerMeter
  return Math.max(1, Math.min(maxSteps, Math.ceil(segScreenPx / gapPx)))
}

/** Camera-centre key for the label-rebake dispatch signature, quantized to ~1
 *  CSS px — NOT 1 Mercator metre. The rebake-skip replays the prior frame's
 *  baked screen-px icons while this key is unchanged. centerX/centerY are
 *  Mercator metres; `centerX|0` ticks only every 1 m, which at deep zoom is tens
 *  of px (z22: mpp ≈ 0.0186 m/px → 1 m ≈ 54 px), so a sub-metre drag froze the
 *  icons/shields for tens of px while the GPU road kept moving (#402-C jitter).
 *  Dividing by `mpp` yields the centre's pixel coordinate, so the key ticks per
 *  ~1 px of pan at every zoom (and stops the wasteful per-metre rebakes at low
 *  zoom where 1 m ≪ 1 px).
 *
 *  `mpp` MUST be the single effective-mpp authority (camera.effectiveMpp — the
 *  capped scale the frozen low-zoom view actually renders at), NOT the uncapped
 *  WORLD_MERC/TILE_PX/2^zoom: in the sub-cap band the on-screen pan is governed by
 *  the frozen (capped) scale, so the key must quantize by it to keep ticking per
 *  TRUE on-screen px (#964). Above z* effective === raw, so this is inert there.
 *  Exported for coverage; the live path (execute) inlines the same quantization. */
export function dispatchCenterKey(centerX: number, centerY: number, mpp: number): string {
  return `${(centerX / mpp) | 0},${(centerY / mpp) | 0}`
}

/** #778 P3 — the numeric fields of the former label-dispatch signature STRING, held per host for
 *  the S16 skip pre-check. Every field is the exact integer the old sig embedded (`(x*100)|0`,
 *  the dispatchCenterKey pixel ints, the canvas ints, labelShows.length); `vtrSig` is the one
 *  variable-length sub-signature (per-source name + getCacheSize) that stays a string. Field-wise
 *  equality is byte-identical to the old full-string equality: no field's decimal form contains
 *  the `|` / `x` / `,` delimiters, so a per-field diff can never alias the concatenated form. */
interface LabelDispatchSkipState {
  zoomKey: number
  /** Un-quantised zoom at the last actual PREPARE (#1177 Option B) — the
   *  reference the active-zoom tolerance measures drift against. */
  preparedZoom: number
  /** Exact zoom key of the PREVIOUS FRAME (updated every frame, hit or
   *  miss) — `prevFrameZoomKey !== current` detects an ACTIVE zoom. */
  prevFrameZoomKey: number
  /** Raw mercator-metre centre at the last PREPARE — the active-zoom centre tolerance divides its
   *  drift by the CURRENT mpp (screen px), because the quantised ckx/cky churn under pure zoom
   *  (mpp shrinks ⇒ centre/mpp grows) even when the geographic centre never moved. */
  preparedCenterX: number
  preparedCenterY: number
  /** TRUE centre latitude at the last PREPARE — compared EXACTLY in the settled branch. Beyond
   *  the Mercator clamp (sphere-family polar orbit) centerY saturates while centerLatDeg keeps
   *  moving, so ckx/cky alone would replay stale labels across a polar setCenter/drag. */
  centerLatDeg: number
  ckx: number
  cky: number
  bearingKey: number
  pitchKey: number
  canvasW: number
  canvasH: number
  showsLen: number
  vtrSig: string
  /** #1434 — raw stride-want ratio (`spacingPx/pxPerCell`) at the last PREPARE (NaN = none);
   *  soundingStrideInvalidates predicts today's ratio from this + dzoom to catch a boundary. */
  preparedStrideWant: number
  /** #1177 replay correction — [mercX,mercY,px,py] × 3 reference samples from the last PREPARE
   *  frame's projectors (label-replay-transform.ts). Hit (replay) frames solve prepared→current
   *  against these so the baked screen-px quads track the camera instead of freezing mid-zoom. */
  replayRefs: Float64Array
  replayRefsValid: boolean
  /** Caller-owned solve output — reused across frames, no per-frame alloc. */
  replayOut: LabelReplayTransform
}

class LabelPass implements RenderPass {
  readonly label = 'labels'

  // #778 P2 — reused `labelShows` scratch. Building
  // `host.showCommands.filter(...)` (plus the `inZoomRange` closure) on EVERY
  // frame allocated a fresh array + a fresh closure — a real GC cost on
  // label-heavy styles (hundreds of shows). Refill ONE reused array in place
  // instead: the array OBJECT is stable across frames (so `labelShows.length`
  // — and thus the S16 dispatch signature — stays referentially stable, which
  // is what lets the skip stand) and the predicate is inlined (no per-frame
  // closure). We refill EVERY frame rather than memoizing on a key, ON PURPOSE:
  // the filter predicate reads `s.visible`, and `setPaintProperty(id,
  // 'visibility', …)` flips a ShowCommand's `.visible` IN PLACE (layer.ts →
  // `show.visible = v`) WITHOUT reassigning `host.showCommands` — a src-ref /
  // zoom / disableLabels memo key would serve a stale list after such a toggle
  // (the just-hidden layer's label would keep placing). Refilling is always
  // fresh by construction; the O(n) walk on a few hundred shows is negligible
  // next to the S16-gated O(N²) collision it feeds, and the alloc — the actual
  // finding — is gone. Shared singleton across maps: the array is cleared and
  // refilled from the caller's own `host.showCommands` each call, so there is
  // no cross-map bleed.
  private readonly _labelShowsScratch: ShowCommand[] = []

  // #778 P3 — per-host last-frame dispatch scalars, replacing the per-frame
  // `_dispatchSig` STRING allocation that fed the S16 skip check. `labelPass` is a
  // MODULE-LEVEL SINGLETON (`export const labelPass = new LabelPass()`, adapted
  // per-map in pass-chain.ts), so this skip state MUST be keyed per host — plain
  // instance fields would bleed one map's camera signature into another map's skip
  // check (the same cross-map hazard the `_labelShowsScratch` note guards against;
  // the old code stored the sig on the HOST, i.e. map.ts `_prevLabelDispatchSig`,
  // precisely because it is per-map). A WeakMap<host> keeps the state on the pass
  // instance while staying per-map correct; the record is created once per host and
  // mutated in place thereafter, so there is no per-frame allocation.
  private readonly _skipState = new WeakMap<LabelPassHost, LabelDispatchSkipState>()

  // Line-label drop attribution, keyed per host for the same reason as
  // `_skipState` above: `labelPass` is a module-level singleton adapted per map,
  // so a plain field would mix one map's counters into another's.
  private readonly _dropStatsByHost = new WeakMap<LabelPassHost, LineLabelDropStats>()
  // #777 IV3 — the pitch-0 unprojector the ground basis composes against. Per
  // HOST for the same reason as the maps above, and never per frame: it owns a
  // matrix/inverse pair behind a cache whose whole point is that a pure tilt is
  // a hit, which a fresh instance would throw away every frame.
  private readonly _pitch0ByHost = new WeakMap<LabelPassHost, Pitch0Unprojector>()
  // The host whose counters the CURRENT frame is filling, assigned at `execute`
  // entry. A plain field is safe here only because `execute` is synchronous and
  // non-reentrant; the per-host map above is what actually holds the state.
  private _dropStats = new LineLabelDropStats()

  /** Why `host`'s last rendered frame did not draw the line labels it walked —
   *  see line-label-drop-stats.ts. Null before the first frame. */
  lineLabelDropStats(host: LabelPassHost): LineLabelDropCounts | null {
    return this._dropStatsByHost.get(host)?.snapshot() ?? null
  }

  // Internal disableLabels / empty-overlays-and-shows checks short-circuit
  // the body, so this pass is always "run" from the chain.
  shouldRun(): boolean {
    return true
  }

  execute(ctx: FrameContext, _scene: SceneView, host: LabelPassHost): void {
    let dropStats = this._dropStatsByHost.get(host)
    if (dropStats === undefined) {
      dropStats = new LineLabelDropStats()
      this._dropStatsByHost.set(host, dropStats)
    }
    dropStats.reset()
    this._dropStats = dropStats
    // Phase 2 PR 2d.4: `projType`/`centerLon`/`centerLat` no longer
    // destructured — the projType-conditional label projector branches
    // collapsed to a single ECEF-based projector. Other passes still
    // consume them off FrameContext directly.
    const { sampleCount: sc } = ctx,
      { w, h, dpr } = ctx.screen // OVERLAY ⇒ screen
    // Symbol fade — advance every ramp once per RENDERED frame (S16 hit and
    // miss alike), OUTSIDE the labels-active gate below so in-flight ramps
    // still settle (and stop asking for frames via the map keep-alive) when
    // the last label show is toggled off mid-fade. A completed fade-OUT tags
    // LABEL dirty so THIS frame's prepare (consumeLabelDirty below runs
    // after this) drops the now-invisible holdover draws.
    if (host.textStage !== null) {
      const fades = host.textStage.getFadeLedger().advance(host._elapsedMs)
      if (fades.anyFadeOutCompleted) host.markLabelDirty()
    }
    const disableLabels =
      typeof window !== 'undefined' &&
      (window as unknown as { __xgisDisableLabels?: boolean }).__xgisDisableLabels === true
    // Mapbox `layer.minzoom` / `layer.maxzoom`: hide the layer
    // outside its declared zoom range. Without this gate every
    // sub-layer of a multi-zoom Mapbox style renders at every
    // zoom level — at z=1.86 with OFM Bright that means city /
    // state / town / village / suburb / POI labels all piling
    // onto the antimeridian view, drowning out the few
    // country-level labels that should be visible there.
    const camZ = host.camera.zoom
    // #778 P2 — refill the reused labelShows scratch in place (0 alloc, always
    // fresh). Predicate inlined (no closure); identical to the former
    // `host.showCommands.filter(s => s.label !== undefined && s.visible !== false
    // && inZoomRange(s))`. `length = 0` + push reuses the array object so the
    // ref (and .length-based S16 sig) stays stable when membership is unchanged.
    const labelShows = this._labelShowsScratch
    labelShows.length = 0
    if (!disableLabels) {
      const src = host.showCommands
      for (let i = 0; i < src.length; i++) {
        const s = src[i]!
        if (
          s.label !== undefined &&
          s.visible !== false &&
          (s.minzoom === undefined || camZ >= s.minzoom) &&
          (s.maxzoom === undefined || camZ < s.maxzoom)
        )
          labelShows.push(s)
      }
    }
    ensureBackgroundPatternAtlas(host, dpr, sc)
    if (!disableLabels && (host.overlays.length > 0 || labelShows.length > 0)) {
      if (host.textStage === null) {
        // Assemble the TextStage's glyph-resource options from
        // everything the host has handed us via constructor /
        // setters / addGlyphProvider. Empty bag → byte-identical
        // pre-PBF behaviour.
        const tsOpts: TextStageOptions = {}
        if (host.glyphsUrl !== null) tsOpts.glyphsUrl = host.glyphsUrl
        if (host.inlineGlyphs !== null) tsOpts.inlineGlyphs = host.inlineGlyphs
        if (host.glyphProviders.length > 0) tsOpts.glyphProviders = host.glyphProviders
        if (host.fontTypography !== null) tsOpts.fontTypography = host.fontTypography
        // Bake locally-rasterised (non-PBF) glyphs at physical-pixel
        // resolution so Hangul/Han labels aren't GPU-upscaled ~dpr×
        // from a 24-px atlas raster (low-res CJK on hidpi screens).
        tsOpts.dpr = dpr
        // Audit ① B1 — when an async PBF glyph range lands after the
        // frame that needed it drew, re-arm a frame + tag LABEL dirty so
        // the S16 skip re-prepares instead of replaying the stale glyph.
        tsOpts.onResourceLanded = () => host.markLabelDirty()
        // Symbol fade — the map-level fadeDuration (MapLibre default 300 ms;
        // 0 keeps the stage's inert byte-identical path). #1260: the effective
        // value folds in prefers-reduced-motion (→ 0), so a map that BOOTS
        // under reduced motion constructs a disabled ledger; a later OS flip is
        // pushed live via textStage.setFadeDurationMs (_onReducedMotionChange).
        tsOpts.fadeDurationMs = host.effectiveFadeDurationMs()
        host.textStage = new TextStage(host.ctx.device, host.ctx.rhi, host.ctx.format, tsOpts, sc)
        host.textStage.prewarmGISDefaults()
        // Attach any debug hook that was set before the stage existed.
        // The hook is null/undefined-safe on the stage side, so the
        // common no-debug path stays a single null-check inside
        // addLabel.
        if (host._pendingLabelDebugHook !== undefined) {
          host.textStage.setLabelDebugHook(host._pendingLabelDebugHook)
        }
        if (host._pendingTraceRecorder !== null) {
          host.textStage.setTraceRecorder(host._pendingTraceRecorder)
        }
      }
      const stage = host.textStage
      // Lazy IconStage — only built when the style has a `sprite`
      // URL AND the scene draws from it: an icon on an active label
      // show, a fill / line pattern, or an inline `image(...)` in a
      // label's text (#2517). The three reasons are one predicate in
      // sprite-atlas-need.ts; the gate avoids the network fetch on
      // styles that need none of them.
      if (
        host.iconStage === null &&
        host.spriteUrl !== null &&
        spriteAtlasNeeded(labelShows, host.showCommands)
      ) {
        host.iconStage = new IconStage(
          host.ctx.device,
          host.ctx.rhi,
          host.ctx.format,
          {
            spriteUrl: host.spriteUrl,
            dpr,
            onLanded: () => host.markLabelDirty(), // sprite-land re-arm (glyph parity)
          },
          sc,
        )
      }
      // #797 P0 — host DRAWING API icons. When the style has NO sprite URL but
      // host images were pushed via `map.graphics.addImage` AND a label show
      // references icons, build the IconStage over the host atlas instead of a
      // fetched URL sprite. Mutually exclusive with the URL branch above
      // (spriteUrl === null here); URL/host coexistence is Phase 1.
      if (
        host.iconStage === null &&
        host.spriteUrl === null &&
        host.graphics.hasAnyImage() &&
        labelShows.some(
          (s) =>
            s.label?.iconImage !== undefined ||
            (s.label as { iconImageExpr?: unknown } | undefined)?.iconImageExpr !== undefined,
        )
      ) {
        const hostAtlas = host.graphics.hostAtlas()
        if (hostAtlas !== null) {
          // #797 P0 render gate: the host-atlas region upload is byte-verified on
          // real GPU (playground/e2e/_host-sprite-atlas-parity.spec.ts) and this
          // IconStage path is byte-identical to the URL icon path (same
          // IconRenderer, covered by _icon-rhi-parity). A full-frame end-to-end
          // capture through this branch is a future belt-and-suspenders (it needs
          // a host-only .xgis with an icon-image layer — no raw .xgis authors one
          // today), compositionally covered by those two gates.
          host.iconStage = IconStage.forHostAtlas(
            host.ctx.device,
            host.ctx.rhi,
            host.ctx.format,
            hostAtlas,
            sc,
          )
        }
      }
      const iStage = host.iconStage
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
      const dispatchIcon = (
        def: {
          iconImage?: string
          iconSize?: number
          iconAnchor?: import('@xgis/compiler').LabelDef['iconAnchor']
          iconOffset?: [number, number]
          iconTranslateX?: number
          iconTranslateY?: number
          iconTranslateAnchorMap?: boolean
          iconRotate?: number
          iconOpacity?: number
          iconColor?: [number, number, number, number]
          iconRotationAlignment?: 'map'
          iconPadding?: number
          iconKeepUpright?: boolean
          iconTextFit?: import('@xgis/compiler').LabelDef['iconTextFit']
          iconTextFitPadding?: import('@xgis/compiler').LabelDef['iconTextFitPadding']
          text?: import('@xgis/compiler').LabelDef['text']
        },
        ax: number,
        ay: number,
        lineTangentDeg = 0,
        pairKey?: string,
        collide = false,
        props?: import('../../text/text-resolver').FeatureProps,
        perspScale = 1, // #1081 — distance attenuation (point icons; 1 elsewhere)
        // Symbol fade — the paired text's stable collisionId (pairKey is
        // per-frame `pt${seq}`, so it cannot key fade records across
        // prepares). Undefined on paths without a collisionId (raw
        // datasets, non-curved line labels) → icon never fades.
        fadeId?: string,
      ): void => {
        if (!iStage || def.iconImage === undefined) return
        // icon-offset (layout, em/px nudge baked before rotation) AND
        // icon-translate (paint, viewport screen shift) both land as a
        // CSS-px anchor offset here, scaled by dpr to physical px. Mapbox
        // applies icon-translate in screen space (positive y = down),
        // matching the +ay-down anchor convention, so a straight add.
        // icon-translate-anchor:map rotates ONLY the icon-translate
        // portion by the map bearing (world-anchored offset, mirror of
        // text-translate-anchor / fill/line Phase S Batch 2); icon-offset
        // is a layout nudge and stays screen-space. Default (viewport /
        // unset) = unrotated, byte-identical.
        let itx = def.iconTranslateX ?? 0
        let ity = def.iconTranslateY ?? 0
        if (def.iconTranslateAnchorMap && (itx !== 0 || ity !== 0)) {
          const r = (host.camera.bearing * Math.PI) / 180
          const c = Math.cos(r),
            s = Math.sin(r)
          ;[itx, ity] = [itx * c - ity * s, itx * s + ity * c]
        }
        const offDx = ((def.iconOffset?.[0] ?? 0) + itx) * dpr
        const offDy = ((def.iconOffset?.[1] ?? 0) + ity) * dpr
        // icon-rotation-alignment=map under symbol-placement=line
        // adds the per-segment tangent to the icon's authored
        // rotation. OFM road_oneway: icon-rotate=90 + tangent of
        // an east-west road (0°) = 90° → arrow points up (the
        // arrow sprite's design orientation has the head pointing
        // right at 0°, so 90° clockwise = north). Caller passes 0
        // for point-placement and other "viewport" rotation cases.
        // #777 I-B — resolve the icon rotation, folding a downward tangent into
        // the upright half-plane when def.iconKeepUpright is EXPLICITLY true
        // (absent/false keeps the raw-tangent rotation byte-identical).
        const rotateRad = resolveIconRotateRad(
          def.iconRotate ?? 0,
          lineTangentDeg,
          def.iconRotationAlignment === 'map',
          def.iconKeepUpright,
        )
        // icon-color → SDF tint (RGBA from resolver; renderer takes
        // rgb, ignores alpha — Mapbox icon-color has no alpha axis,
        // icon-opacity owns alpha). Undefined when unauthored so
        // the renderer keeps the raster/identity path.
        const ic = def.iconColor
        // #417 — only collision-dedup TEXT-LESS line icons (road_oneway
        // arrows). A text-paired line icon (highway shield) is left
        // uncollided so dropping its box can't orphan its number text;
        // shield text+icon already drop together via the pairKey path.
        // def.text is a TEXT-VALUE expression (template/concat), not a
        // string — road_oneway's resolves to "" — so resolve it against
        // the feature props before deciding (a bare `=== ''` never matched).
        const resolvedText =
          collide && def.text !== undefined && def.text !== null
            ? resolveText(def.text, props ?? {}, host.camera.zoom)
            : ''
        // Two independent collision triggers:
        //  (1) the #417 line-icon rule — a text-LESS line icon (road_oneway
        //      arrow) always collides so parallel chains dedupe.
        //  (2) the Mapbox icon-overlap policy — `iconCollide` (set by
        //      icon-overlap:'never' / icon-allow-overlap:false) opts this
        //      icon into the queue regardless of placement mode. The
        //      historical default (flag absent) leaves icons always-placed.
        //  `icon-ignore-placement: true` overrides BOTH back to always-
        //  place-and-don't-block (the icon never enters the collide queue).
        const di = def as { iconCollide?: boolean; iconIgnorePlacement?: boolean }
        const policyCollide = di.iconCollide === true && di.iconIgnorePlacement !== true
        const lineCollide = collide && resolvedText === '' && di.iconIgnorePlacement !== true
        const doCollide = lineCollide || policyCollide
        iStage.addIcon(ax + offDx, ay + offDy, def.iconImage, {
          sizeScale: def.iconSize ?? 1,
          rotateRad,
          anchor: def.iconAnchor ?? 'center',
          opacity: def.iconOpacity ?? 1,
          tint: ic ? [ic[0], ic[1], ic[2]] : undefined,
          pairKey,
          collide: doCollide,
          padding: def.iconPadding,
          perspScale,
          // #777 I-A — icon-text-fit: pass the fit mode + [t,r,b,l] padding so
          // IconStage.prepare stretches this quad to the paired text bbox (looked
          // up by pairKey). Absent = native sprite size (byte-identical).
          fit: def.iconTextFit
            ? { mode: def.iconTextFit, pad: def.iconTextFitPadding ?? [0, 0, 0, 0] }
            : undefined,
          fadeId,
        })
      }
      // Mapbox `text-field` expressions that depend on zoom (e.g.
      // demotiles `text-field: {stops:[[2,"{ABBREV}"],[4,"{NAME}"]]}`
      // → step(zoom, .ABBREV, 4, .NAME)) need the camera zoom in the
      // evaluator props bag. Without this, zoom = undefined → NaN
      // → step()'s default arm forever, so country labels never
      // switched from "S. Kor" to "S. Korea" past z=4.
      stage.setCameraZoom(host.camera.zoom)
      // text-translate-anchor:map — TextStage rotates a label's
      // text-translate by the map bearing when its translateAnchorMap
      // flag is set (mirror of the fill/line clip-space bake). Default
      // (viewport) labels ignore the bearing → byte-identical.
      stage.setBearing(host.camera.bearing)
      // Display-projection label anchors (projection-display-layer-restore).
      // The anchors must land on the SAME surface as their features:
      //  - Flat projTypes (0-6, untilted) reproject each anchor onto the 2D
      //    plane via the flat Mercator-metre MVP (getViewForProjection →
      //    getFrameView) + a CPU mirror of the per-vertex shader
      //    reprojection (polygon.ts vs_main flat branch). This is what keeps
      //    labels on the now-flat geometry — the ECEF-sphere projector
      //    (PR 2d.4) drifted labels off their features at wide / low-zoom
      //    flat views.
      //  - Globe (7) + tilted azimuthal (promoted to 7 + globeMode) keep the
      //    ECEF projector, matching their getECEFFrameView geometry.
      // getViewForProjection gates flat vs ECEF with the SAME
      // `!globeMode && !isGlobeProj` test the renderer uses for its MVP, so
      // the label MVP, the geometry MVP, and the shader's proj_params.x
      // branch stay in lockstep.
      //
      // World copies: flat Mercator has real ±360° copies, so the flat
      // projector iterates visibleWorldCopies (the screen-space collision
      // pass dedupes adjacency); ECEF/globe collapse to one (lon±360° is the
      // same 3D point). KNOWN GAP (TODO): the flat NON-Mercator periodic
      // projections (equirect/natural_earth/oblique_mercator) DO fan out
      // ±360° geometry copies at zoom≤4 (enumerateWorldCopies), but the label
      // projector still emits one — so the wrapped copy renders unlabeled
      // near the antimeridian at very low zoom. Deferred: needs periodic-copy
      // enumeration via enumerateWorldCopies (getVisibleWorldCopies returns
      // [0] for non-Mercator) + an antimeridian label test.
      // `visibleWorldCopies` is produced AND consumed entirely within this
      // pass (label-node-local) — no other pass reads it, so it left FrameContext.
      const visibleWorldCopies = host.camera.getVisibleWorldCopies(w, h, dpr)
      const { projType, centerLon, centerLat } = unwrapProjection(ctx.projection)
      const isFlatProj = !host.camera.globeMode && !isGlobeProj(projType)
      const labelView = host.camera.getViewForProjection(projType, w, h, dpr)
      // camera-merc reference MUST equal the geometry's camMerc, which the
      // renderer builds from the ±85-clamped projCenterLon/Lat (= the
      // projection token's centerLon/Lat), NOT raw camera.centerY. At the far-north pan
      // clamp the reachable centre lat is 85.0–85.051° (maxCameraY =
      // Y(85.051129°)); raw camera.centerY then exceeds Y(85°) by up to
      // ~64 km (~13k px @ z14), flinging every Mercator label past the
      // ±1.5 NDC gate while the (clamped) polygons stay put. For |lat|≤85
      // the two are identical, so this only repairs the polar band. Routed
      // through the shared clamped CPU Mercator mirror (projMercatorCpu);
      // its ±85.051129 clamp is inert here (centerLat is already
      // clamped to that bound upstream). projMercatorCpu returns a fresh
      // tuple per call (no shared scratch), so there is no aliasing hazard.
      const camMerc = projMercatorCpu(centerLon, centerLat)
      // Named rather than inlined so the ground basis composes against the SAME
      // projection constants the anchors were placed with — one object, two
      // projectors, no way for them to drift into different frames.
      const flatArgs = isFlatProj
        ? { projType, ccx: camMerc[0], ccy: camMerc[1], centerLon, centerLat, visibleWorldCopies }
        : undefined
      const {
        projectMerc,
        projectLonLat,
        projectMercAny,
        projectLonLatCopies,
        limbInsetPx,
        perspectiveScale,
      } = makeLabelProjectors(
        labelView.matrix,
        w,
        h,
        flatArgs,
        labelView.eye,
        // Globe RTC focus: the matrix is focus-relative, so the ECEF label
        // projector must anchor against the same camera focus the geometry
        // VS subtracts. Flat path ignores it.
        isFlatProj ? undefined : host.camera.getECEFCenter(),
        true, // #1042 — label pass: apply the horizon MARGIN cull (not map.project)
      )

      // #777 IV3 — the ground-basis producer for `text-pitch-alignment: map`.
      // Built here because it composes the SAME matrix and projection constants
      // the anchors were placed with; pairing it with any other frame would put
      // the quad in a different one from its own anchor. `pitch0` is per-HOST (it
      // owns a matrix/inverse pair whose cache exists so a pure tilt is a hit).
      let pitch0 = this._pitch0ByHost.get(host)
      if (pitch0 === undefined) {
        pitch0 = new Pitch0Unprojector()
        this._pitch0ByHost.set(host, pitch0)
      }
      // The pair the basis is a RATIO of: this frame's matrix and its pitch-0 twin.
      const liveMvp = labelView.matrix
      const p0Mvp = pitch0.matrix(host.camera, w, h, dpr)
      const groundBasisFor = makeGroundBasisFor(host.camera, liveMvp, p0Mvp, w, h, flatArgs)
      // #2012 INC-4 — the pitch-0 twin of the line pass's own merc projector, for
      // the LABEL PLANE the curved branch walks (dispatch-curved-line-labels.ts).
      // Built only when a frame can actually produce one, so an unpitched frame
      // and the globe pay nothing and the whole curved branch stays byte-identical.
      const groundMercPitch0 =
        host.camera.pitch > 0 && flatArgs !== undefined
          ? makeGroundMercProjector(p0Mvp, w, h, flatArgs)
          : undefined

      // (a) Imperative overlays
      for (const ov of host.overlays) {
        const projected = projectLonLat(ov.lon, ov.lat)
        if (!projected) continue
        const tv = {
          kind: 'expr' as const,
          expr: { ast: { kind: 'StringLiteral' as const, value: ov.text } },
        }
        stage.addLabel(
          tv,
          {},
          projected[0],
          projected[1],
          {
            text: tv,
            size: ov.size,
            color: ov.color,
            halo: ov.halo,
            transform: ov.transform,
          },
          ov.font,
          '__overlay',
        )
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
      const c = host.camera
      // #778 P3 — build the numeric dispatch fields directly instead of the
      // per-frame `_dispatchSig` STRING (and the `dispatchCenterKey` string it
      // embedded). Each field is the exact integer the old sig concatenated; they
      // are diffed against the per-host last-frame scalars below. `_mpp`/`_ckx`/
      // `_cky` mirror dispatchCenterKey(c.centerX, c.centerY, _mpp) verbatim so
      // the pixel-quantised centre key stays byte-identical. `_mpp` is the single
      // effective-mpp authority (camera.effectiveMpp — the capped scale the frozen
      // low-zoom view actually renders at), NOT the uncapped WORLD_MERC/TILE_PX/
      // 2^zoom, so the key ticks per TRUE on-screen px in the sub-cap band (#964);
      // above z* effective === raw so this stays byte-identical there.
      const _mpp = c.effectiveMpp(projType, h, dpr)
      const _zoomKey = (c.zoom * 100) | 0
      const _ckx = (c.centerX / _mpp) | 0
      const _cky = (c.centerY / _mpp) | 0
      const _bearingKey = (c.bearing * 100) | 0
      const _pitchKey = (c.pitch * 100) | 0
      const _canvasW = host.ctx.canvas.width
      const _canvasH = host.ctx.canvas.height
      const _showsLen = labelShows.length
      // The vtSources sub-signature is variable-length (per-source name +
      // getCacheSize), so it stays a small per-frame string — a full numeric
      // conversion is not tractable here (P3 half-done, per the note). This is the
      // same concat the old code built; only the fixed-field `_dispatchSig`
      // allocation is gone.
      let _vtrSig = ''
      for (const [name, e] of host.vtSources) {
        _vtrSig += `${name}:${e.renderer.getCacheSize()};`
      }
      // S16 — first consumer skip. Read-and-clear the LABEL dirty domain (overlay add/remove,
      // scene rebuild, any invalidate() all re-tag it), and combine it with the dispatch
      // signature: when neither the sig nor the LABEL domain changed, the prepared collision
      // result from the prior frame is still valid, so we skip stage.prepare() / iStage.prepare()
      // (the O(N²) greedy collision + shaping + GPU upload) and let stage.render() replay the
      // renderer's persistent draws unchanged. The dispatch loop still runs (kept simple +
      // leak-free; its `pending` is dropped via stage.reset()/iStage.reset()); a future increment
      // can skip it too. Correctness gate: any camera/canvas/tile change moves the sig; any
      // label-content change tags LABEL — so a needed re-collision is never skipped.
      // frame_stability (replay == original) + post_change (move ⇒ rebuild) on the label matrix
      // cell are the regression net.
      const labelDirty = host.consumeLabelDirty()
      // The skip is only safe when the dispatch signature captures EVERYTHING that can change the
      // labels. Two things it can't: (a) an async label resource (glyph range / sprite atlas)
      // landing after the sig settled — `wasLastPrepareFullyResolved()` is false while glyphs are
      // still in flight, and `isAtlasTerminal()` is false while the atlas is loading, so we keep
      // preparing until both resolve; (b) a time-driven label shape (the sig omits the animation
      // clock) — `_labelsHaveTimeAnimation`. While any of these hold, force a re-collation so a
      // late glyph/icon or an animated text-size isn't frozen until the camera moves.
      const labelResourcesPending =
        !stage.wasLastPrepareFullyResolved() || (iStage !== null && !iStage.isAtlasTerminal())
      // #778 P3 — numeric-field diff against the per-host last-frame scalars, byte-identical to
      // the old `host._prevLabelDispatchSig === _dispatchSig` string compare (an undefined prev
      // record ⇒ first frame ⇒ definite miss, matching the old `null` sentinel). Stored ONLY on a
      // miss, mirroring the old `_prevLabelDispatchSig = _dispatchSig`; since the hit
      // precondition already implies equality, that keeps stored == current after every frame.
      const _prevSkip = this._skipState.get(host)
      // #1177 Option B — zoom-tolerant skip, narrowed by #1434. The exact `(zoom*100)|0` key made
      // every continuous-zoom frame a miss, putting the whole prepare cost on the wheel-zoom hot
      // path. During an ACTIVE zoom (this frame's key differs from the previous FRAME's) the
      // camera is compared with tolerance instead: |zoom - preparedZoom| <= 0.15, centre drift <=
      // 48 px, and (#1434) the predicted coverage-sounding stride must still quantise to the
      // PREPARED one — never replaying across a stride-doubling boundary. Motion STOPPING
      // restores the exact comparison, forcing one final prepare so idle is snap-correct;
      // bearing/pitch/canvas/shows/tiles stay exact throughout.
      const zoomActive = _prevSkip !== undefined && _prevSkip.prevFrameZoomKey !== _zoomKey
      const _dzoom = _prevSkip !== undefined ? c.zoom - _prevSkip.preparedZoom : 0
      const _camSame =
        _prevSkip !== undefined &&
        (zoomActive
          ? Math.abs(_dzoom) <= 0.15 &&
            Math.abs(c.centerX - _prevSkip.preparedCenterX) / _mpp <= 48 &&
            Math.abs(c.centerY - _prevSkip.preparedCenterY) / _mpp <= 48 &&
            !soundingStrideInvalidates(_prevSkip.preparedStrideWant, _dzoom)
          : _prevSkip.zoomKey === _zoomKey &&
            _prevSkip.ckx === _ckx &&
            _prevSkip.cky === _cky &&
            _prevSkip.centerLatDeg === c.centerLatDeg)
      const _sigSame =
        _prevSkip !== undefined &&
        _camSame &&
        _prevSkip.bearingKey === _bearingKey &&
        _prevSkip.pitchKey === _pitchKey &&
        _prevSkip.canvasW === _canvasW &&
        _prevSkip.canvasH === _canvasH &&
        _prevSkip.showsLen === _showsLen &&
        _prevSkip.vtrSig === _vtrSig
      const canSkipLabelPrepare =
        _sigSame && !labelDirty && !labelResourcesPending && !host._labelsHaveTimeAnimation
      // Symbol fade — holdover admissibility for THIS frame's (potential) prepare, computed
      // BEFORE the skip-state mutation below overwrites the prepared-camera fields. The
      // camera/canvas cluster must match the previous PREPARED frame EXACTLY (the #1177
      // tolerant-zoom window is not enough — a held-over draw replays baked screen px). Tile-set
      // / show-set churn (vtrSig, showsLen) intentionally does NOT block holdover: tile loads are
      // exactly the placement changes fades smooth.
      const holdoverOk =
        _prevSkip !== undefined &&
        !zoomActive &&
        _prevSkip.zoomKey === _zoomKey &&
        _prevSkip.ckx === _ckx &&
        _prevSkip.cky === _cky &&
        _prevSkip.centerLatDeg === c.centerLatDeg &&
        _prevSkip.bearingKey === _bearingKey &&
        _prevSkip.pitchKey === _pitchKey &&
        _prevSkip.canvasW === _canvasW &&
        _prevSkip.canvasH === _canvasH
      if (canSkipLabelPrepare) {
        host._labelDispatchHits++
      } else {
        host._labelDispatchMisses++
        if (_prevSkip === undefined) {
          this._skipState.set(host, {
            zoomKey: _zoomKey,
            preparedZoom: c.zoom,
            prevFrameZoomKey: _zoomKey,
            preparedCenterX: c.centerX,
            preparedCenterY: c.centerY,
            centerLatDeg: c.centerLatDeg,
            ckx: _ckx,
            cky: _cky,
            bearingKey: _bearingKey,
            pitchKey: _pitchKey,
            canvasW: _canvasW,
            canvasH: _canvasH,
            showsLen: _showsLen,
            vtrSig: _vtrSig,
            // #1434 — the coverage dispatch loop below overwrites this on an actual sounding.
            preparedStrideWant: NaN,
            replayRefs: new Float64Array(REPLAY_REFS_LEN),
            replayRefsValid: false,
            replayOut: { scale: 1, dx: 0, dy: 0 },
          })
        } else {
          _prevSkip.zoomKey = _zoomKey
          _prevSkip.preparedZoom = c.zoom
          _prevSkip.preparedCenterX = c.centerX
          _prevSkip.preparedCenterY = c.centerY
          _prevSkip.centerLatDeg = c.centerLatDeg
          _prevSkip.ckx = _ckx
          _prevSkip.cky = _cky
          _prevSkip.bearingKey = _bearingKey
          _prevSkip.pitchKey = _pitchKey
          _prevSkip.canvasW = _canvasW
          _prevSkip.canvasH = _canvasH
          _prevSkip.showsLen = _showsLen
          _prevSkip.vtrSig = _vtrSig
          _prevSkip.preparedStrideWant = NaN
        }
        // #1177 — refresh the replay-correction refs from THIS (about-to-
        // prepare) frame's projector family, the same one placing the labels
        // below. Hit frames solve prepared→current against these.
        const _missState = this._skipState.get(host)!
        _missState.replayRefsValid = sampleReplayRefs(
          projectMercAny,
          c.centerX,
          c.centerY,
          _mpp,
          Math.min(_canvasW, _canvasH) / 4,
          _missState.replayRefs,
        )
      }
      // Every frame (hit AND miss): record this frame's exact key so the next
      // frame can classify itself active vs settled.
      const _postSkip = this._skipState.get(host)
      if (_postSkip) _postSkip.prevFrameZoomKey = _zoomKey
      // #1177 — replay correction: on a skip (replay) frame, derive the prepared→current
      // screen-space similarity and hand it to stage/iStage render as a shader uniform, so the
      // baked screen-px quads track the camera instead of freezing until the next re-prepare (the
      // reported wheel-zoom label lag). Any solve failure (culled ref, world-copy flip,
      // degenerate camera) ⇒ undefined ⇒ identity — the pre-fix behaviour for that frame only.
      // Exact at pitch 0 on flat projections; first-order at the view centre otherwise
      // (label-replay-transform.ts).
      let labelReplay: LabelReplayTransform | undefined
      if (
        canSkipLabelPrepare &&
        _postSkip !== undefined &&
        _postSkip.replayRefsValid &&
        solveReplayTransform(_postSkip.replayRefs, projectMercAny, _postSkip.replayOut)
      ) {
        labelReplay = _postSkip.replayOut
      }
      // #1177/#2013 — on an S16 HIT frame the dispatch loop is skipped via the
      // loop condition (not an `if` block, to avoid re-indenting the body):
      // prepare() is skipped at the stage-prepare guard below, so everything
      // the loop queues is dropped unconsumed by stage.reset()/iStage.reset()
      // — the loop's only hit-frame effect was wasted CPU (applyFeatureExprs +
      // per-anchor/per-vertex projectMercAny + addLabel). The visible frame
      // replays the stages' persistent draws through labelReplay. The only
      // skip-state write inside the loop (preparedStrideWant) is already
      // miss-gated. _labelDispatchLoopRuns counts INSIDE the body (first
      // iteration), not beside the predicate, so the zoom-skip gate's
      // loopRuns === misses assertion goes red if the guard is ever removed
      // while the counter survives — it measures the skip itself, not the
      // intent (frame time alone cannot).
      // _showIdx = draw order (later show = higher layer) — point-label dedup precedence (#458).
      for (let _showIdx = 0; !canSkipLabelPrepare && _showIdx < labelShows.length; _showIdx++) {
        const show = labelShows[_showIdx]!
        if (_showIdx === 0) host._labelDispatchLoopRuns++
        // Per-show monotonic key for POINT-label text+icon pairing — mirrors
        // _lineLabelSeq (iter-176). A STABLE per-instance key; replaces the
        // old rounded-screen-coords pairKey whose sub-pixel camera drift
        // flipped the rounding, so a city dot's key collided with a
        // neighbour's dropped key and the dot blinked on pan/zoom (#419).
        // text + dot share the same value (iter-119 pairing intact); each
        // world-copy dispatch increments (copies stay independent).
        let _pointLabelSeq = 0
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
        const z = host.camera.zoom
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
        // and `host.camera.bearing` are the only inputs threaded as
        // explicit args. Data-driven shapes fall through to static
        // defaults here and are overridden per feature by
        // applyFeatureExprs below.
        const effectiveDef = resolveLabelEffectiveDef(
          def,
          shapes,
          z,
          elapsedMs,
          show.fill,
          host.camera.bearing,
        )

        // Per-feature evaluator for data-driven text-size /
        // text-color (Mapbox `["case", …]` / `["match", …]` /
        // arithmetic forms). Wraps a feature's def with overrides
        // resolved from the data-driven PropertyShapes against
        // that feature's properties. Pulls AST from
        // `def.shapes.size.expr` / `def.shapes.color.expr` — the
        // LabelShapes bundle is the single source of truth post-L2.
        const sizeExprAst =
          shapes && shapes.textLayout.size.kind === 'data-driven'
            ? shapes.textLayout.size.expr.ast
            : null
        const colorExprAst =
          shapes && shapes.textPaint.color !== null && shapes.textPaint.color.kind === 'data-driven'
            ? shapes.textPaint.color.expr.ast
            : null
        // Per-feature icon-size / icon-opacity (#777 I-F). Data-driven
        // forms land as `data-driven` PropertyShapes; resolveLabelEffectiveDef
        // leaves them at the static def fallback, so we evaluate the AST
        // per feature here and override iconSize / iconOpacity — mirror of
        // the text-size / text-color paths above.
        const iconSizeExprAst =
          shapes && shapes.icon.iconSize !== null && shapes.icon.iconSize.kind === 'data-driven'
            ? shapes.icon.iconSize.expr.ast
            : null
        const iconOpacityExprAst =
          shapes &&
          shapes.icon.iconOpacity !== null &&
          shapes.icon.iconOpacity.kind === 'data-driven'
            ? shapes.icon.iconOpacity.expr.ast
            : null
        // Per-feature icon-image expression. Compiler emits this
        // when Mapbox `icon-image: ["match", ["get", "subclass"], …]`
        // is present (OFM POI layers). Runtime evaluates the AST
        // per feature, resolves to a sprite atlas key, and feeds
        // dispatchIcon's existing const-path (which already gates
        // on def.iconImage !== undefined and calls IconStage.addIcon).
        const iconImageExprAst = def.iconImageExpr?.ast ?? null
        // Per-feature icon-translate expression (#777 I-F) — evaluates to
        // a `[dx,dy]` pair overriding iconTranslateX/Y at dispatch.
        const iconTranslateExprAst = def.iconTranslateExpr?.ast ?? null
        // #2166 — per-feature `symbol-sort-key`. Resolved HERE, at dispatch,
        // which is early enough by construction: every dispatch path hands the
        // def this returns to addLabel, and TextStage.prepare() — which reads
        // `p.def.sortKey` into the collision input — runs after the frame's last
        // addLabel. Nothing in text-stage.ts or text-collision.ts changes.
        const sortKeyExprAst = def.sortKeyExpr?.ast ?? null
        const cameraZoom = host.camera.zoom
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
          if (
            sizeExprAst === null &&
            colorExprAst === null &&
            iconImageExprAst === null &&
            iconSizeExprAst === null &&
            iconOpacityExprAst === null &&
            iconTranslateExprAst === null &&
            sortKeyExprAst === null
          )
            return effectiveDef
          const cached = host._featureExprsCache.get(props)
          if (
            cached !== undefined &&
            cached.zoomBucket === zoomBucket &&
            cached.effectiveDef === effectiveDef
          ) {
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
              const v = evaluate(sizeExprAst, bag)
              if (typeof v === 'number' && isFinite(v)) out.size = v
            } catch {
              /* fall back to effectiveDef.size */
            }
          }
          if (colorExprAst !== null) {
            try {
              const v = evaluate(colorExprAst, bag)
              if (typeof v === 'string') {
                const hex = resolveColor(v)
                const rgba = hexToRgba(hex ?? v)
                if (rgba) out.color = rgba
              }
            } catch {
              /* fall back to effectiveDef.color */
            }
          }
          if (iconImageExprAst !== null) {
            try {
              // Single-hop from `unknown` (.ast is unknown through its whole producer chain).
              const v = evaluate(iconImageExprAst as import('@xgis/compiler').Expr, bag)
              if (typeof v === 'string' && v.length > 0) {
                ;(out as { iconImage?: string }).iconImage = v
              }
            } catch {
              /* fall back to effectiveDef.iconImage */
            }
          }
          if (iconSizeExprAst !== null) {
            try {
              const v = evaluate(iconSizeExprAst as import('@xgis/compiler').Expr, bag)
              // Clamp negatives to 0 (spec >= 0) — mirrors the constant
              // converter clamp so per-feature matches compile-time.
              if (typeof v === 'number' && isFinite(v)) out.iconSize = Math.max(0, v)
            } catch {
              /* fall back to effectiveDef.iconSize */
            }
          }
          if (iconOpacityExprAst !== null) {
            try {
              const v = evaluate(iconOpacityExprAst as import('@xgis/compiler').Expr, bag)
              if (typeof v === 'number' && isFinite(v))
                out.iconOpacity = Math.max(0, Math.min(1, v))
            } catch {
              /* fall back to effectiveDef.iconOpacity */
            }
          }
          if (iconTranslateExprAst !== null) {
            try {
              const v = evaluate(iconTranslateExprAst as import('@xgis/compiler').Expr, bag)
              // icon-translate resolves to a [dx,dy] pair; both finite.
              if (
                Array.isArray(v) &&
                v.length === 2 &&
                typeof v[0] === 'number' &&
                isFinite(v[0]) &&
                typeof v[1] === 'number' &&
                isFinite(v[1])
              ) {
                out.iconTranslateX = v[0]
                out.iconTranslateY = v[1]
              }
            } catch {
              /* fall back to effectiveDef.iconTranslateX/Y */
            }
          }
          if (sortKeyExprAst !== null) {
            try {
              const v = evaluate(sortKeyExprAst as import('@xgis/compiler').Expr, bag)
              // Non-numeric / non-finite keeps effectiveDef.sortKey (undefined
              // unless a constant was also authored), which the collision pass
              // reads as 0 — the same fallback the iconSize / iconOpacity arms
              // above take, and the same value the pre-#2166 drop produced.
              if (typeof v === 'number' && isFinite(v)) out.sortKey = v
            } catch {
              /* fall back to effectiveDef.sortKey */
            }
          }
          // iter-259 — cache the result. Stores the resolved
          // LabelDef + zoomBucket; future calls with same
          // (props, zoomBucket, effectiveDef) hit the cache and
          // skip the evaluate() AST walks.
          host._featureExprsCache.set(props, { zoomBucket, effectiveDef, def: out })
          return out
        }

        const data = host.rawDatasets.get(show.targetName)

        // Path 0: S-100 gridded coverage — sounding numerals (#1366 INC-5). A grid matches
        // neither Path 1 (`features`) nor Path 2 (`vtSources`), so `| label-[…]` on a
        // coverage layer used to compile cleanly and draw NOTHING. See the arm's own file.
        if (data && '_coverage' in data) {
          // EVERY resident region (#1272 E-④): a mosaic draws several domains at once, so it
          // prints numerals over all of them. `region` namespaces the CELL identity a label's
          // collision id is built from — two regions sharing a (col,row) must not fade each
          // other out — while the LAYER name stays the layer's, which is what the collision
          // pass buckets precedence by.
          for (const [region, entry] of data._coverage) {
            const _strideWant = dispatchCoverageSoundings(
              entry.handle,
              soundingUnprojector(host.camera, _canvasW, _canvasH, dpr),
              { width: _canvasW, height: _canvasH, dpr },
              applyFeatureExprs,
              projectLonLatCopies,
              (v, p, x, y, d, f, ln, pk, cid, ps) =>
                stage.addLabel(v, p, x, y, d, f, ln, pk, cid, ps),
              { layerName: labelLayerName, region, filter: show.filterExpr, cameraZoom },
            )
            // #1434 — only a real PREPARE updates the tolerant-zoom skip's reference.
            if (!canSkipLabelPrepare && _postSkip) _postSkip.preparedStrideWant = _strideWant
          }
          perfMarkEnd('encoder.label-dispatch.show')
          continue
        }

        // Path 1: GeoJSON / inline-data sources whose features live
        // in `rawDatasets`. Iterates the FeatureCollection directly
        // and uses `featureAnchor` to pick a centroid per geometry.
        if (data && 'features' in data && data.features) {
          for (const feat of data.features) {
            if (!feat.geometry) continue
            // #727 P1 — inline (raw-GeoJSON) line placement. A symbol layer
            // with symbol-placement: line / line-center over an inline
            // LineString used to collapse to ONE horizontal centroid label
            // (featureAnchor → lineMidpoint → a single addLabel). Delegate to
            // placeInlineLineLabels (place-labels-along-line.ts), which
            // projects the feature's OWN vertices and calls the SAME
            // along-line placement walk the vector-tile path uses, so it
            // renders the tangent-rotated chain instead. Non-line placements
            // take the centroid path (the `else` below) unchanged.
            const geomType = feat.geometry.type
            if (
              (effectiveDef.placement === 'line' || effectiveDef.placement === 'line-center') &&
              (geomType === 'LineString' || geomType === 'MultiLineString')
            ) {
              placeInlineLineLabels(
                feat,
                effectiveDef,
                applyFeatureExprs,
                projectLonLat,
                dpr,
                (value, props, x, y, def, fontKey, layerName) =>
                  stage.addLabel(value, props, x, y, def, fontKey, layerName),
                dispatchIcon,
                labelLayerName,
                // #1314 — same viewport edge-inset cull as the vector-tile line
                // path: an inline LineString label whose anchor hugs a screen edge
                // is dropped rather than rendered glued half-off-screen.
                (x, y) =>
                  withinViewportInset(x, y, _canvasW, _canvasH, LINE_LABEL_EDGE_INSET_CSS_PX * dpr),
                host.camera.zoom,
              )
            } else {
              const anchor = featureAnchor(feat.geometry)
              if (!anchor) continue
              dispatchPointLabel(feat.geometry, feat.properties ?? {}, anchor[0], anchor[1], {
                applyFeatureExprs,
                projectLonLatCopies,
                addLabel: (v, p, x, y, d, f, ln, pk, cid, ps, gb) =>
                  stage.addLabel(v, p, x, y, d, f, ln, pk, cid, ps, gb),
                dispatchIcon,
                layerName: labelLayerName,
                nextPairKey: () => pointLabelPairKey(labelLayerName, _pointLabelSeq++),
                groundBasisFor,
              })
            }
          }
          perfMarkEnd('encoder.label-dispatch.show')
          continue
        }

        // Path 2: vector-tile sources (PMTiles / .xgvt / Mapbox
        // converter output). Features live in the VTR tile cache.
        // We delegate iteration to VTR.forEachLabelFeature which
        // walks `stableKeys` × `pointVertices` and rebuilds the
        // property bag from the source's PropertyTable. Mercator
        // coords come out in absolute meters; we go through the
        // same projector by inverting back to lon/lat.
        const vtEntry = host.vtSources.get(show.targetName)
        if (vtEntry) {
          // MapLibre-parity (#613): drop this show's labels when its
          // source-layer is outside the tilejson vector_layers zoom band
          // for the current native tile zoom — the native tile omits the
          // layer there, so ML draws nothing (demotiles `geolines`
          // maxzoom 4 → the Tropic/Equator/Arctic labels vanish at z5
          // while `countries` maxzoom 6 persists). Culls the along-path
          // labels in lockstep with the line path's selectForFrame cull.
          if (
            show.sourceLayer &&
            vtEntry.renderer.sourceLayerOutsideDataZoom(show.sourceLayer, host.camera.zoom)
          ) {
            perfMarkEnd('encoder.label-dispatch.show')
            continue
          }
          const DEG2RAD = Math.PI / 180
          const R = activeBody().sphereR
          const mercToLonLat = (mx: number, my: number): [number, number] => [
            mx / R / DEG2RAD,
            mercatorYToLat(my),
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
          const useLine =
            effectiveDef.placement === 'line' || effectiveDef.placement === 'line-center'
          // iter-262 (Plan L.1.2) — split label-dispatch into
          // line vs point sub-paths. Tells us which path
          // dominates the 9.5 ms encoder.label-dispatch budget.
          const _ldMark = useLine ? 'encoder.label-dispatch.line' : 'encoder.label-dispatch.point'
          perfMarkStart(_ldMark)
          if (useLine) {
            // Mapbox `symbol-spacing` (CSS px, placement === 'line' only —
            // line-center always emits one label at the midpoint): walk the
            // screen-projected polyline and emit a label every step, so a long
            // highway renders the repeating chain Mapbox does instead of one
            // label. lineLabelSpacingPx owns the CSS px → physical px scaling AND
            // the zoom-dependent tile-unit bake — see its doc for the derivation.
            const spacingCssPx = effectiveDef.placement === 'line' ? (effectiveDef.spacing ?? 0) : 0
            const spacingPx = lineLabelSpacingPx(spacingCssPx, dpr, host.camera.zoom)
            // Mapbox `text-rotation-alignment: viewport` for line
            // placement keeps the label upright on screen instead of
            // following the road tangent. 'auto' on line resolves to
            // 'map' (= tangent), matching the historical behaviour.
            const lineRotAlign = effectiveDef.rotationAlignment ?? 'auto'
            const useTangentRotation = lineRotAlign !== 'viewport'
            // #2012 INC-4 — does this layer's curved branch lie in the ground
            // plane? ONE authority answers that now (#2166): groundAlignsAtRuntime
            // (compiler/src/ir/label-alignment.ts) carries the spec chain AND the
            // tangent-rotation gate this branch imposes, and the converter's
            // runtime-gap warning is derived from the same predicate, so the warning
            // cannot describe a runtime that no longer exists. Plus a frame that can
            // produce a pitch-0 twin at all: an unpitched frame and every
            // `text-rotation-alignment: viewport` layer pay literally nothing — the
            // extra projection per sample is what keeps the byte-identity rung
            // reachable, and it must not be spent where it cannot be used.
            const groundAlignedLine =
              groundMercPitch0 !== undefined &&
              groundAlignsAtRuntime(
                effectiveDef.placement,
                effectiveDef.rotationAlignment,
                effectiveDef.pitchAlignment,
              )
            // #1314 — viewport edge-inset cull for this layer's line labels, at every
            // along-line emit site below; re-set per polyline from the feature's own
            // extent (lineLabelEdgeInsetPx). Point labels are unaffected.
            const spriteOf = (n: string) => iStage?.getSprite(n)
            let _edgeInset = LINE_LABEL_EDGE_INSET_CSS_PX * dpr
            const anchorInView = (sx: number, sy: number): boolean =>
              withinViewportInset(sx, sy, _canvasW, _canvasH, _edgeInset)
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
            // #603 — cross-tile dedup for text-less line icons. Declared here
            // so emitLabelAlongSegment (defined below) can close over it.
            // Assigned inside the spacingPx > 0 block where the dedup Set is
            // set up; before that block it is a no-op (single-feature paths
            // have no cross-tile ambiguity). Never-duplicate by default.
            let isLineIconDuplicate: (sx: number, sy: number) => boolean = () => false
            const emitLabelAlongSegment = makeEmitLabelAlongSegment({
              applyFeatureExprs,
              addLabel: (v, p, x, y, def, fk, ln, pk) =>
                stage.addLabel(v, p, x, y, def, fk, ln, pk),
              dispatchIcon,
              isLineIconDuplicate,
              nextPairSeq: () => _lineLabelSeq++,
              labelLayerName,
              useTangentRotation,
              zoom: host.camera.zoom,
            })
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
              const emittedTextNames = host._scratchEmittedTextNames
              emittedTextNames.clear()
              const isTooCloseToSameText = (
                resolvedText: string,
                _sx: number,
                _sy: number,
              ): boolean => {
                return lineLabelDeduped(resolvedText, emittedTextNames)
              }
              const recordTextPosition = (resolvedText: string, _sx: number, _sy: number): void => {
                emittedTextNames.add(resolvedText)
              }
              // #603 — cross-tile dedup for text-less line-placed icons
              // (road_oneway arrows, shields with empty text). Two adjacent
              // tiles each emit a polyline for the same road; the icon-
              // spacing walk places icons at slightly different positions
              // along each segment, so the same screen position gets two
              // icons from two tiles — AABB collision in icon-stage collapses
              // touching pairs but misses non-overlapping near-duplicates at
              // tile seams. Mirror the text-name dedup with a bucketed screen-
              // position key: snap to the icon-spacing grid (~spacingPx) so
              // two placements within half a spacing step share the same key.
              // Assigned to the outer `let` so emitLabelAlongSegment can close
              // over the real function (it's defined before this block).
              const emittedLineIconKeys = host._scratchEmittedLineIconKeys
              emittedLineIconKeys.clear()
              const iconSpacingBucket = spacingPx
              isLineIconDuplicate = (sx: number, sy: number): boolean => {
                const key = `${Math.round(sx / iconSpacingBucket)},${Math.round(sy / iconSpacingBucket)}`
                if (emittedLineIconKeys.has(key)) return true
                emittedLineIconKeys.add(key)
                return false
              }
              // #2012 INC-4 — the curved emitter's frame/layer bindings, built
              // ONCE per layer rather than per polyline × world copy. The pair
              // sequence is a FUNCTION for the reason `EmitLabelAlongSegmentDeps`
              // gives: it is shared with the viewport branch's emitter, and
              // copying its value forks it into two counters minting the same keys.
              const curvedDeps: CurvedLineLabelDeps = {
                addCurvedLineLabel: stage.addCurvedLineLabel.bind(stage),
                dispatchIcon,
                bumpDrop: (k) => this._dropStats.bump(k),
                anchorInView,
                isTooCloseToSameText,
                recordTextPosition,
                // Read through the outer `let`: it is assigned just above, after
                // `emitLabelAlongSegment` already closed over the same binding.
                isLineIconDuplicate: (sx, sy) => isLineIconDuplicate(sx, sy),
                nextPairKey: () => `${labelLayerName ?? ''}:seq${_lineLabelSeq++}`,
                layerName: labelLayerName,
              }
              const SUBDIVS_PER_SEG = 32
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
              // INC-2 — mercator arc-length per retained sample, parallel to the two
              // above. f64: these are absolute mercator metres (~10^7), where f32
              // quantises to ~1 m and would jitter the world anchor by a pixel.
              let _pmScratch = new Float64Array(0)
              // #2012 INC-4 — the LABEL PLANE (pitch-0) twin of the two screen
              // arrays, and the merc coordinate of each retained sample (the
              // label's own ground point, where its basis is derived). All five
              // arrays are index-parallel; only these two f64 pairs are filled on a
              // ground-aligned layer, so a viewport layer's loop is unchanged.
              let _p0xScratch = new Float32Array(0)
              let _p0yScratch = new Float32Array(0)
              let _pmxScratch = new Float64Array(0)
              let _pmyScratch = new Float64Array(0)
              // Screen-space subdivision density (fixes the deep-zoom road-label
              // vanish). Project the camera centre and a +1 m east neighbour; the
              // px gap = on-screen pixels per mercator metre. Drives the per-
              // segment sample count below so a segment that is SHORT in metres
              // but spans the viewport in PIXELS at high zoom still gets interior
              // samples. Both points sit at the RTC origin so they always project.
              const _ppmA = projectMercAny(camMerc[0], camMerc[1])
              const _ppmAx = _ppmA ? _ppmA[0] : NaN
              const _ppmAy = _ppmA ? _ppmA[1] : NaN
              const _ppmB = projectMercAny(camMerc[0] + 1, camMerc[1])
              const pxPerMeter =
                _ppmA && _ppmB && Number.isFinite(_ppmAx)
                  ? Math.hypot(_ppmB[0] - _ppmAx, _ppmB[1] - _ppmAy)
                  : 0
              const LABEL_SAMPLE_GAP_PX = 96
              vtEntry.renderer.forEachLineLabelPolyline(sliceKey, (mxs, mys, props, tileEntryM) => {
                perfMarkStart('encoder.label-dispatch.line.polyline')
                if (mxs.length < 2) {
                  perfMarkEnd('encoder.label-dispatch.line.polyline')
                  return
                }
                // Project every vertex to physical-pixel screen space; pack into typed
                // arrays for the curved-text sampler, trimming to the first run (#1050).
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
                  _pxScratch = new Float32Array(upper * 2) // 2× to amortise growth
                  _pyScratch = new Float32Array(upper * 2)
                  _pmScratch = new Float64Array(upper * 2)
                  if (groundAlignedLine) {
                    _p0xScratch = new Float32Array(upper * 2)
                    _p0yScratch = new Float32Array(upper * 2)
                    _pmxScratch = new Float64Array(upper * 2)
                    _pmyScratch = new Float64Array(upper * 2)
                  }
                }
                // #727 (C) — tile LINE labels fan out per visible world copy
                // (points already do, ~#1700). The projector carries the copy
                // index; dedupe/lineId keys are copy-suffixed below. [0] frames
                // run the pre-#727(C) body byte-identically.
                for (const wo of visibleWorldCopies) {
                  perfMarkStart('encoder.label-dispatch.line.project')
                  let pn = 0 // active sample count
                  // INC-2 — mercator arc-length walked so far. Recorded PER RETAINED
                  // SAMPLE into _pmScratch so the world↔screen conversion can follow
                  // the run's actual, varying scale instead of one pxPerMeter fit.
                  let accM = 0
                  // Per-segment sample count from SCREEN length (segLenM ×
                  // pxPerMeter), NOT raw metres. Subdivision exists so a segment
                  // that spans the viewport but whose ENDPOINTS fall outside the
                  // NDC window still contributes an on-screen sample. The old gate
                  // (subdivide only if > 100 km in metres) handled world-spanning
                  // demotiles geolines but MISSED the deep-zoom case: a ~360 m road
                  // segment at z19 spans ~2500 px and crosses the viewport, yet is
                  // far below 100 km → sampled at endpoints only → both off-screen
                  // → degenerate polyline (length 0) → the label silently dropped
                  // (high-zoom road-label vanish bug). Gap-bounded screen sampling
                  // captures the crossing at any zoom; a genuinely short on-screen
                  // segment still resolves to dynSteps = 1 (low-zoom perf preserved,
                  // since pxPerMeter is small there). For i > 0 the shared start
                  // vertex is skipped (s starts at 1) so adjacent segments don't
                  // emit a duplicate zero-length point.
                  outer: for (let i = 0; i < N - 1; i++) {
                    const ax = mxs[i]!,
                      ay = mys[i]!
                    const bx = mxs[i + 1]!,
                      by = mys[i + 1]!
                    const segDx = bx - ax,
                      segDy = by - ay
                    const segLenM = Math.sqrt(segDx * segDx + segDy * segDy)
                    const dynSteps = lineLabelSubdivSteps(
                      segLenM,
                      pxPerMeter,
                      LABEL_SAMPLE_GAP_PX,
                      SUBDIVS_PER_SEG,
                    )
                    for (let s = i === 0 ? 0 : 1; s <= dynSteps; s++) {
                      const t = s / dynSteps
                      const sx = ax + (bx - ax) * t
                      const sy = ay + (by - ay) * t
                      // Direct merc → screen projection. Skips the
                      // mercToLonLat + lonLatToMercator round-trip that
                      // accounted for ~80 % of forEachLineLabelPolyline's
                      // frame time pre-optimisation (OFM Bright z=13).
                      const proj = projectMercAny(sx, sy, wo)
                      // #1050 — first null ends the run (no phantom-chord label).
                      if (!proj && pn > 0) break outer
                      if (!proj) continue
                      _pxScratch[pn] = proj[0]
                      _pyScratch[pn] = proj[1]
                      _pmScratch[pn] = accM + segLenM * t
                      // #2012 INC-4 — the retained sample's own merc coordinate,
                      // recorded HERE because nothing downstream can recover it:
                      // `_pmScratch` is an arc LENGTH, and the retained run can
                      // start mid-polyline. It is what lets a label's basis be
                      // derived at the label's own ground point.
                      if (groundAlignedLine) {
                        _pmxScratch[pn] = sx
                        _pmyScratch[pn] = sy
                      }
                      pn++
                    }
                    accM += segLenM
                  }
                  perfMarkEnd('encoder.label-dispatch.line.project')
                  if (pn < 2) {
                    this._dropStats.bump('runTooShort')
                    continue
                  }
                  perfMarkStart('encoder.label-dispatch.line.emit')
                  // #2012 INC-4 — the LABEL PLANE: the pitch-0 image of the SAME
                  // retained samples, index-parallel to the live run. All-or-
                  // nothing (see projectRunToLabelPlane): a run that cannot be
                  // fully imaged keeps its live walk, which is what it did before.
                  const planeOk =
                    groundAlignedLine &&
                    projectRunToLabelPlane(
                      _pmxScratch,
                      _pmyScratch,
                      pn,
                      wo,
                      groundMercPitch0!,
                      _p0xScratch,
                      _p0yScratch,
                    )
                  // The WALK arrays — the plane's when there is one. The curved
                  // branch derives its own cadence from them inside
                  // emitCurvedLineLabels, which is what makes design Q7's
                  // "phase and walk in the same space" unrepresentable here.
                  const walkX = planeOk ? _p0xScratch : _pxScratch
                  const walkY = planeOk ? _p0yScratch : _pyScratch
                  const featDef = applyFeatureExprs(props)
                  _edgeInset = lineLabelEdgeInsetPx(featDef, spriteOf, dpr)
                  if (useTangentRotation) {
                    // Curved-text path: pack the projected polyline
                    // and ask TextStage to lay each glyph along it.
                    // TextStage stores the view, so it must survive past
                    // the next callback iteration (the shared scratch
                    // gets overwritten). Intern the exact-count run into
                    // TextStage's per-frame FrameArena instead of a fresh
                    // `_pxScratch.slice(0, pn)` ×2 (#790 / #778 P4): the
                    // arena bump is zero-GC-alloc and resets at
                    // beginFrame(); stage.prepare() consumes it within
                    // this frame. All stops emitted below share the one
                    // interned pair (read both slots before the next
                    // polyline's intern overwrites the holder). #2012
                    // INC-4 interns the LIVE twin in the SAME call, so the
                    // two runs cannot be interned with different counts.
                    const _interned = planeOk
                      ? stage.internCurvedPolyline(walkX, walkY, pn, _pxScratch, _pyScratch)
                      : stage.internCurvedPolyline(walkX, walkY, pn)
                    const ident = curvedRunIdentity(
                      featDef,
                      props,
                      host.camera.zoom,
                      wo,
                      labelLayerName,
                      (lineId) => labelCollisionId(_showIdx, labelShows.length, lineId),
                    )
                    // The stop cadence + per-stop emit live in
                    // dispatch-curved-line-labels.ts (#2012 INC-4) — extracted
                    // to pay this file's LOC ceiling with a move that has its
                    // own reason, and so the label-plane walk it now performs
                    // gets a unit gate the inline loop could not have had.
                    // No fontKey override — see note at line ~2370.
                    emitCurvedLineLabels(
                      {
                        polyX: _interned[0],
                        polyY: _interned[1],
                        ...(planeOk
                          ? {
                              liveX: _interned[2],
                              liveY: _interned[3],
                              mercX: _pmxScratch,
                              mercY: _pmyScratch,
                              groundBasisFor,
                            }
                          : {}),
                        pn,
                        mercArc: _pmScratch,
                        tileEntryM,
                        spacingPx,
                        featDef,
                        props,
                        copyTextKey: ident.copyTextKey,
                        lineId: ident.lineId,
                        lineCollisionId: ident.lineCollisionId,
                        // #603 — text-less line icons (road_oneway, icon-only
                        // shields) render no text, so the resolved-text dedupe
                        // does not gate them; the position-bucket one does.
                        // Gate on the symbol's OWN resolved text-field being
                        // empty: an icon-only symbol emits text === '""', so
                        // featDef.text is never undefined and the old
                        // `!== undefined` test never fired (#603). The dedupe
                        // key cannot stand in for it — for a plain label it
                        // falls back to the feature's `name`, which a
                        // road_oneway arrow may carry from its source road
                        // even though it renders no text.
                        isIconOnly: lineIconIsIconOnly(featDef.text, props, host.camera.zoom),
                        pairedWithIcon: ident.pairedWithIcon,
                      },
                      curvedDeps,
                    )
                    perfMarkEnd('encoder.label-dispatch.line.emit')
                    continue
                  }
                  // Viewport-aligned path: single-rotation emission per spacing point,
                  // delegated to the shared placement walk (placeLabelsAlongLine) — the
                  // SAME authority the inline (raw-GeoJSON) line path uses (#727 P1).
                  // Pure extraction: the walk cadence + `emitLabelAlongSegment` emit
                  // byte-identical labels to the prior inline loop.
                  //
                  // INC-1/INC-2 — THIS branch's cadence, measured on the live arrays:
                  // the world anchor (where the run crosses into its own tile, which is
                  // where MapLibre starts its chain) as an along-screen offset from the
                  // run's first sample, plus the run length. Normally NEGATIVE — MVT
                  // geometry carries a buffer, so the crossing sits behind the start.
                  // #2309 moved it BELOW the curved `continue`: #2012 INC-4 gave that
                  // path its own re-measure from the WALK arrays (design Q7), so this
                  // was two O(pn) walks and an object discarded per polyline per world
                  // copy on every `text-rotation-alignment: map` layer — i.e. roads.
                  const { total, worldPhasePx } = measureRunCadence(
                    _pxScratch,
                    _pyScratch,
                    _pmScratch,
                    pn,
                    tileEntryM,
                  )
                  if (
                    latticeMissesRun(
                      lineLabelFirstStopPx(worldPhasePx, spacingPx),
                      spacingPx,
                      total,
                    )
                  )
                    this._dropStats.bump('noLatticeStop')
                  placeLabelsAlongLine(
                    _pxScratch,
                    _pyScratch,
                    pn,
                    spacingPx,
                    countedEmit(this._dropStats, (pax, pay, pbx, pby, t) =>
                      emitLabelAlongSegment(pax, pay, pbx, pby, t, props),
                    ),
                    countedCull(this._dropStats, anchorInView),
                    // INC-1 — MapLibre anchors this chain at `tileEntry + k · spacing`
                    // measured on the TILE-CLIPPED line, so the chain is a property of
                    // the world, not of where the run happens to start on screen.
                    worldPhasePx,
                  )
                  perfMarkEnd('encoder.label-dispatch.line.emit')
                }
                perfMarkEnd('encoder.label-dispatch.line.polyline')
              })
            } else {
              // Single-label-per-feature fallback (line-center, or
              // line-placement with spacing=0). Uses the longest
              // segment chosen by forEachLineLabelFeature.
              vtEntry.renderer.forEachLineLabelFeature(sliceKey, (ax, ay, bx, by, props) => {
                // #727 (C) — fan the single line-center label per world copy.
                // The merc arm now projects merc metres directly (the former
                // merc→lonlat→merc round-trip differed by sub-ULP at most).
                for (const wo of visibleWorldCopies) {
                  // projectMercAny returns the shared scratch tuple, so copy A
                  // out before projecting B — otherwise pa === pb (both hold
                  // endpoint B) and the midpoint collapses to B with 0 tangent.
                  const a = projectMercAny(ax, ay, wo)
                  if (!a) continue
                  const ax2 = a[0],
                    ay2 = a[1]
                  const pb = projectMercAny(bx, by, wo)
                  if (!pb) continue
                  // #1314 — cull a line-center label whose midpoint anchor hugs a
                  // screen edge (t=0.5 between the projected endpoints).
                  if (!anchorInView((ax2 + pb[0]) * 0.5, (ay2 + pb[1]) * 0.5)) continue
                  emitLabelAlongSegment(ax2, ay2, pb[0], pb[1], 0.5, props)
                }
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
            const emittedPointNames = host._scratchEmittedPointNames
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
                ? resolveText(featDef.text, props, host.camera.zoom, undefined)
                : ''
              const dedupKey =
                resolvedText !== ''
                  ? `${resolvedText}|${Math.round(mercX / 256)},${Math.round(mercY / 256)}`
                  : ''
              // Higher layer wins (#458); same/lower collapses (cross-tile / bilingual — iter-274/280).
              if (
                dedupKey !== '' &&
                !shouldEmitPointDedup(emittedPointNames.get(dedupKey), _showIdx)
              )
                return
              if (dedupKey !== '') emittedPointNames.set(dedupKey, _showIdx)
              // #728 — stable collision identity: layer precedence + the
              // pan-invariant feature key (resolved text + quantized world
              // position, mirroring the dedup lattice so cross-tile centroids
              // of one feature share an id). Fed to the greedy pass as its
              // tie-break so which of two overlapping point labels survives no
              // longer flips with tile-dispatch order on pan.
              const pointCollisionId = labelCollisionId(
                _showIdx,
                labelShows.length,
                `${resolvedText}|${Math.round(mercX / 256)},${Math.round(mercY / 256)}`,
              )
              // No fontKey override — see note at line ~2370.
              // World-copy loop on MERCATOR coords directly — skips
              // the merc → lonLat → merc round-trip the previous
              // path did (one allocation + two trig stacks per call).
              // Mirror of `projectLonLatCopies` for non-mercator
              // projections is still needed because those reproject
              // through lonLat space; we handle that here inline.
              // iter 119: paired-symbol collision for point labels.
              const pairedWithIcon =
                featDef.iconImage !== undefined &&
                featDef.iconImage !== null &&
                featDef.iconImage !== ''
              if (host.projectionName !== 'mercator') {
                const [lon, lat] = mercToLonLat(mercX, mercY)
                for (const projected of projectLonLatCopies(lon, lat)) {
                  const pairKey = pairedWithIcon
                    ? pointLabelPairKey(labelLayerName, _pointLabelSeq++)
                    : undefined
                  // #1081 — this copy's perspective attenuation (tuple slot 3), label + icon.
                  const ps = projected[2]
                  stage.addLabel(
                    featDef.text,
                    props,
                    projected[0],
                    projected[1],
                    featDef,
                    undefined,
                    labelLayerName,
                    pairKey,
                    pointCollisionId,
                    ps,
                  )
                  dispatchIcon(
                    featDef,
                    projected[0],
                    projected[1],
                    0,
                    pairKey,
                    false,
                    undefined,
                    ps,
                    pointCollisionId,
                  )
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
                const px = proj[0],
                  py = proj[1]
                // #1081 — this copy's attenuation (scratch getter, set by projectMerc above).
                const ps = perspectiveScale()
                const pairKey = pairedWithIcon
                  ? pointLabelPairKey(labelLayerName, _pointLabelSeq++)
                  : undefined
                stage.addLabel(
                  featDef.text,
                  props,
                  px,
                  py,
                  featDef,
                  undefined,
                  labelLayerName,
                  pairKey,
                  pointCollisionId,
                  ps,
                )
                dispatchIcon(featDef, px, py, 0, pairKey, false, undefined, ps, pointCollisionId)
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
      // S16 skip: on an unchanged frame, reuse the prior prepare's GPU draws
      // (stage.render below replays them); skipping the collision + upload is
      // the measurable payload (see getLabelDispatchStats hitRate).
      if (!canSkipLabelPrepare) {
        // #609 — seed text collision with icon boxes BEFORE TextStage.prepare so a
        // label can't draw over a collide-icon from a separate feature. MapLibre
        // puts placed icon boxes in the shared collision grid every label hit-tests
        // against; we replicate that by passing them as obstacles.
        // computeObstacles() reads the pending queue (pre-prepare) so it must run
        // BEFORE iStage.prepare() clears it; a paired icon's own text is exempted
        // via groupKey. #609 over-drop fix — pass the pairKeys whose text label has a live bbox
        // in THIS pass (getActiveTextPairKeys, valid here because stage.prepare
        // hasn't run / reset hasn't cleared the queues). A paired icon with live
        // text is skipped as an obstacle: that text bbox already blocks (widened to
        // the badge below, so a shield blocks and loses as ONE symbol, as MapLibre
        // does), and if the text loses collision the icon is dropped via
        // droppedPairKeys — so its own box must not phantom-block a different-group
        // label. Icon-only pairs are absent from the set and still seed obstacles.
        const activeTextPairKeys = iStage ? stage.getActiveTextPairKeys() : new Set<string>()
        const iconObstacles = iStage ? iStage.computeObstacles(activeTextPairKeys) : []
        if (iStage) stage.setPairIconHalfExtents(iStage.pairedIconHalfExtents())
        // #777 I-G — give TextStage the read-only sprite atlas so inline-image
        // markers in label text reserve the sprite advance during shaping.
        stage.setSpriteMetadata(iStage ? iStage.host : null)
        // Symbol fade — motion-holdover reprojection ctx (holdover-reproject.ts).
        // Provided ONLY where the #1177 replay similarity is EXACT: flat
        // Mercator + pitch 0 (fixed bearing/canvas is checked per-holdover in
        // the stage). There a fade-out label dropped mid-zoom is reprojected
        // onto THIS frame and fades in place instead of popping — the fix for
        // "labels blink on zoom". Under globe / pitch / rotate the ctx is
        // absent and the holdover stays suppressed (the pre-fix graceful pop).
        // refs are this prepare's replay refs (just sampled at the S16 miss
        // above); the solve maps a holdover's stamped bake refs onto this frame.
        const _hoSkip = this._skipState.get(host)
        let motionHoldover: MotionHoldoverCtx | undefined
        if (
          host.projectionName === 'mercator' &&
          c.pitch === 0 &&
          _hoSkip !== undefined &&
          _hoSkip.replayRefsValid &&
          stage.getFadeLedger().enabled
        ) {
          const solveOut: LabelReplayTransform = { scale: 1, dx: 0, dy: 0 }
          motionHoldover = {
            bearingKey: _bearingKey,
            canvasW: _canvasW,
            canvasH: _canvasH,
            refs: _hoSkip.replayRefs,
            solve: (bakeRefs) =>
              solveReplayTransform(bakeRefs, projectMercAny, solveOut) ? solveOut : null,
          }
        }
        stage.prepare(iconObstacles, limbInsetPx, holdoverOk, motionHoldover)
        if (iStage) iStage.setDroppedPairKeys(stage.getDroppedPairKeys())
        // #777 I-A — hand the paired text bboxes (laid out by stage.prepare just
        // now) to IconStage so its prepare() can stretch icon-text-fit quads.
        // Mirrors the droppedPairKeys handoff; order matters (text before icon).
        if (iStage) iStage.setPairFitBoxes(stage.getPairFitBoxes())
        // #777 I-G — hand the inline-image quads TextStage just placed to
        // IconStage so its prepare() draws them via the existing icon path.
        if (iStage) iStage.setInlineImagePlacements(stage.getInlineImagePlacements())
        // Symbol fade — hand TextStage's ledger over (mirror of the
        // droppedPairKeys handoff) so paired icons read their text's records.
        if (iStage) iStage.setFadeLedger(stage.getFadeLedger())
        iStage?.prepare(holdoverOk, motionHoldover)
      }
      perfMarkEnd('encoder.stage-prepare')
      // Text overlay v1: skipped in debug=overdraw — text targets the swapchain
      // format, not r16float. The FRAME's truth, never the URL flag: where the
      // mode cannot run the attachment IS the swapchain, so reading the flag
      // here drops the overlay for an r16float never allocated (Inc-F2d F1/F2).
      if (!ctx.overdraw) {
        // F3b: originate through the RHI frame encoder — on WebGPU this maps
        // to the identical native descriptor (rhiRenderPassToGpu parity), and
        // it is what lets this pass execute on WebGL2 (the only frame shape
        // since the twin's deletion, #1046 Inc-F3a/F3b). Last colour writer
        // of the frame ⇒ it claims the conditional MSAA resolve.
        const { enc, screenView, colorViewScreen } = requireRhiFrame(ctx, 'labels')
        ctx.passScope('text-overlay', () => {
          const tPass = enc.beginRenderPass({
            colorAttachments: [
              {
                view: colorViewScreen,
                resolveTarget: ctx.useResolve ? screenView : undefined,
                loadOp: 'load',
                storeOp: 'store',
              },
            ],
          })
          // Icons render BEFORE text so labels read on top of their
          // POI badges — matches MapLibre's symbol-stage ordering.
          iStage?.render(tPass, { width: ctx.screen.w, height: ctx.screen.h }, labelReplay)
          stage.render(tPass, { width: ctx.screen.w, height: ctx.screen.h }, labelReplay)
          tPass.end()
        })
      }
      // Drop both stages' per-frame dispatch queues. iStage.reset() mirrors
      // stage.reset() so a frame that skipped iStage.prepare() (S16) cannot
      // carry dispatched-but-unprepared icons into the next prepared set.
      stage.reset()
      iStage?.reset()
    }
  }
}

/** Stateless singleton — the per-feature label + text-overlay pass. */
export const labelPass: RenderPass = new LabelPass()
