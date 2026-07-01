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
// scalars the block read (device / dpr / sampleCount / w / h / encoder) are
// re-bound from ctx at the top, and projType / centerLon / centerLat are
// decoded from the opaque ctx.projection token (projection-token.ts) — this
// pass owns that unwrap. `visibleWorldCopies` is produced + consumed entirely
// here (label-node-local state, no longer a FrameContext field).

import { evaluate, makeEvalProps, resolveColor } from '@xgis/compiler'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '@xgis/map'
import { DEBUG_OVERDRAW } from '@xgis/map'
import { WORLD_MERC, TILE_PX } from '@xgis/engine'
import { mercatorYToLat } from '@xgis/engine'
import { isGlobeProj } from '@xgis/engine'
import { projMercatorCpu } from '@xgis/map'
import { resolveLabelEffectiveDef, makeLabelProjectors } from '@xgis/map'
import { computeSliceKey } from '@xgis/data'
import { TextStage, type TextStageOptions } from '@xgis/map'
import { IconStage } from '@xgis/map'
import { resolveText } from '@xgis/map'
import { hexToRgba, featureAnchor } from '@xgis/map'
import { type ShowCommand } from '@xgis/map'
import type { FrameContext } from '@xgis/engine'
import { unwrapProjection } from '@xgis/engine'
import type { SceneView } from '../scene-view'
import type { RenderPass, LabelPassHost } from './pass'

/** Cross-tile line-label dedupe predicate. A named road stamped across N
 *  tile boundaries collapses to a single label via its (unique) resolved
 *  text. But TEXT-LESS icon-only line layers — OFM `road_oneway` arrows
 *  have an `icon-image` and NO `text-field` — resolve to `''` for every
 *  along-line stop, so an empty key must NEVER dedupe: otherwise the first
 *  arrow records `''` and every later stop (this polyline + every other
 *  one-way segment in the show) sees `has('')` → suppressed, collapsing the
 *  whole layer to ~one arrow on screen. Only non-empty (named) keys collapse.
 *  Exported for unit coverage — the placement loop is an anon callback. */
export function lineLabelDeduped(resolvedText: string, emitted: ReadonlySet<string>): boolean {
  if (resolvedText === '') return false
  return emitted.has(resolvedText)
}

/** #603 — does a line-placed symbol render NO text (icon-only)? Gates the
 *  cross-tile icon dedup (isLineIconDuplicate): only TEXT-LESS line icons
 *  (OFM `road_oneway` arrows, icon-only shields) need it — a text+icon pair
 *  is already deduped by its text name and must not drop its icon out from
 *  under its number.
 *
 *  The predicate is the RESOLVED text being empty, NOT `text === undefined`:
 *  the compiler emits `text: '""'` for an icon-only symbol (symbol.ts
 *  `labelExpr = '""'`), so `LabelDef.text` is a non-null empty template and
 *  a `text !== undefined` test is ALWAYS true → the dedup never armed and
 *  road_oneway arrows duplicated at tile seams (#603). Resolve `text` here so
 *  an empty-rendering symbol is correctly detected. Exported for coverage —
 *  the placement walk is an anon callback. */
export function lineIconIsIconOnly(
  text: import('@xgis/compiler').TextValue | undefined,
  props: import('@xgis/map').FeatureProps,
  cameraZoom: number,
): boolean {
  if (text === undefined || text === null) return true
  return resolveText(text, props, cameraZoom) === ''
}

/** #605 — the cross-tile dedupe key for a tangent-rotated (curved) line label.
 *  Caps repeated along-line placements to one per route per ShowCommand pass
 *  (via isTooCloseToSameText / lineLabelDeduped), so the choice of key decides
 *  what counts as "the same route".
 *
 *  A route-number SHIELD (text+icon line symbol — OFM highway-shield-*, whose
 *  text-field is the route `ref`, e.g. "82") is identified by its REF, NOT the
 *  road `name`: a national route overlays many differently-named OSM road
 *  segments (some carry a street `name`, some only `ref`), so a `name`-keyed
 *  dedupe diverges per segment and stamps the same "82" shield once per distinct
 *  name across the tiles the route fills — ~6× at z19 vs MapLibre's ~1× (the ref
 *  is the same on every segment, so resolving the drawn text collapses the whole
 *  route to one shield). The ref is monolingual so the bilingual-divergence
 *  concern below does not apply to it.
 *
 *  A plain road-NAME label (no paired icon) keeps the `name` → `name_en` →
 *  resolved-text precedence: resolveText() varies across segments when one
 *  carries `name:nonlatin` and the next doesn't (the bilingual concat returns
 *  different strings for the same road), so the raw name field is the stabler
 *  cross-segment key there. Exported for coverage — the placement walk is an
 *  anon callback. */
export function lineLabelDedupeKey(
  pairedWithIcon: boolean,
  text: import('@xgis/compiler').TextValue,
  props: import('@xgis/map').FeatureProps,
  cameraZoom: number,
): string {
  if (pairedWithIcon) return resolveText(text, props, cameraZoom)
  const p = props as Record<string, unknown>
  if (typeof p.name === 'string') return p.name
  if (typeof p.name_en === 'string') return p.name_en
  return resolveText(text, props, cameraZoom)
}

/** Stable per-instance pair key for a POINT label's text+icon (the place-name
 *  dot). Keyed on a monotonic per-show sequence index — NOT the rounded screen
 *  position the pre-#419 code used, whose sub-pixel-drift rounding flipped so a
 *  dot's key collided with a NEIGHBOUR label's dropped key and the dot blinked
 *  on pan/zoom. The text and its dot share one dispatch's key (pairing intact,
 *  iter-119); each instance / world-copy gets a distinct index. No position arg
 *  ⇒ two co-located labels can NEVER collide by construction (the #419 root).
 *  Mirrors the line path's `_lineLabelSeq` (iter-176). Exported for coverage. */
export function pointLabelPairKey(layerName: string | undefined, seq: number): string {
  return `${layerName ?? ''}:pt${seq}`
}

// #458: emit a point-label dedup key when unclaimed or from a strictly HIGHER layer (top-wins); same/lower → drop.
export const shouldEmitPointDedup = (prev: number | undefined, showIdx: number): boolean => prev === undefined || showIdx > prev

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
  segLenM: number, pxPerMeter: number, gapPx: number, maxSteps: number,
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
 *  Dividing by mpp = WORLD_MERC/TILE_PX/2^zoom yields the centre's pixel
 *  coordinate, so the key ticks per ~1 px of pan at every zoom (and stops the
 *  wasteful per-metre rebakes at low zoom where 1 m ≪ 1 px). Exported for
 *  coverage. */
export function dispatchCenterKey(centerX: number, centerY: number, zoom: number): string {
  const mpp = (WORLD_MERC / TILE_PX) / Math.pow(2, zoom)
  return `${(centerX / mpp) | 0},${(centerY / mpp) | 0}`
}

class LabelPass implements RenderPass {
  readonly label = 'labels'

  // Internal disableLabels / empty-overlays-and-shows checks short-circuit
  // the body, so this pass is always "run" from the chain.
  shouldRun(): boolean { return true }

  execute(ctx: FrameContext, _scene: SceneView, host: LabelPassHost): void {
    // Phase 2 PR 2d.4: `projType`/`centerLon`/`centerLat` no longer
    // destructured — the projType-conditional label projector branches
    // collapsed to a single ECEF-based projector. Other passes still
    // consume them off FrameContext directly.
    const { device, dpr, sampleCount: sc, w, h, encoder } = ctx
      const disableLabels = typeof window !== 'undefined'
        && (window as unknown as { __xgisDisableLabels?: boolean }).__xgisDisableLabels === true
      // Mapbox `layer.minzoom` / `layer.maxzoom`: hide the layer
      // outside its declared zoom range. Without this gate every
      // sub-layer of a multi-zoom Mapbox style renders at every
      // zoom level — at z=1.86 with OFM Bright that means city /
      // state / town / village / suburb / POI labels all piling
      // onto the antimeridian view, drowning out the few
      // country-level labels that should be visible there.
      const camZ = host.camera.zoom
      const inZoomRange = (s: ShowCommand): boolean =>
        (s.minzoom === undefined || camZ >= s.minzoom)
        && (s.maxzoom === undefined || camZ < s.maxzoom)
      const labelShows = disableLabels
        ? []
        : host.showCommands.filter(s => s.label !== undefined && s.visible !== false && inZoomRange(s))
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
          host.textStage = new TextStage(device, host.ctx.rhi, host.ctx.format, tsOpts, sc)
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
        // URL AND at least one currently-active label show declares
        // an `iconImage` (const form) OR `iconImageExpr` (per-
        // feature, OFM POI layers). Both gates avoid the network
        // fetch on styles that don't need icons.
        if (host.iconStage === null && host.spriteUrl !== null
            && (labelShows.some(s =>
                 s.label?.iconImage !== undefined
                 || (s.label as { iconImageExpr?: unknown } | undefined)?.iconImageExpr !== undefined)
                // iter-177 / iter-178 — fill-pattern + line-pattern
                // Stage 1 also need the sprite atlas loaded, even
                // when no icon dispatch label show exists (Liberty
                // `landcover_wetland` + `road_area_pattern` only
                // declare `fill-pattern`, no icon layers).
                || host.showCommands.some(s => s.fillPattern || s.linePattern))) {
          host.iconStage = new IconStage(device, host.ctx.rhi, host.ctx.format, {
            spriteUrl: host.spriteUrl, dpr,
            onLanded: () => host.markLabelDirty(), // sprite-land re-arm (glyph parity)
          }, sc)
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
        const dispatchIcon = (def: { iconImage?: string; iconSize?: number; iconAnchor?: import('@xgis/compiler').LabelDef['iconAnchor']; iconOffset?: [number, number]; iconTranslateX?: number; iconTranslateY?: number; iconTranslateAnchorMap?: boolean; iconRotate?: number; iconOpacity?: number; iconColor?: [number, number, number, number]; iconRotationAlignment?: 'map'; text?: import('@xgis/compiler').LabelDef['text'] }, ax: number, ay: number, lineTangentDeg = 0, pairKey?: string, collide = false, props?: import('@xgis/map').FeatureProps): void => {
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
            const c = Math.cos(r), s = Math.sin(r)
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
          const tangent = def.iconRotationAlignment === 'map' ? lineTangentDeg : 0
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
          const resolvedText = collide && def.text !== undefined && def.text !== null
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
            rotateRad: ((def.iconRotate ?? 0) + tangent) * Math.PI / 180,
            anchor: def.iconAnchor ?? 'center',
            opacity: def.iconOpacity ?? 1,
            tint: ic ? [ic[0], ic[1], ic[2]] : undefined,
            pairKey,
            collide: doCollide,
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
        const { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies } =
          makeLabelProjectors(labelView.matrix, w, h, isFlatProj ? {
            projType,
            ccx: camMerc[0],
            ccy: camMerc[1],
            centerLon,
            centerLat,
            visibleWorldCopies,
          } : undefined, labelView.eye,
          // Globe RTC focus: the matrix is focus-relative, so the ECEF label
          // projector must anchor against the same camera focus the geometry
          // VS subtracts. Flat path ignores it.
          isFlatProj ? undefined : host.camera.getECEFCenter())

        // (a) Imperative overlays
        for (const ov of host.overlays) {
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
        const c = host.camera
        let _vtrSig = ''
        for (const [name, e] of host.vtSources) {
          _vtrSig += `${name}:${e.renderer.getCacheSize()};`
        }
        const _dispatchSig =
          `${(c.zoom * 100) | 0}|${dispatchCenterKey(c.centerX, c.centerY, c.zoom)}`
          + `|${(c.bearing * 100) | 0}|${(c.pitch * 100) | 0}`
          + `|${host.ctx.canvas.width}x${host.ctx.canvas.height}`
          + `|${labelShows.length}|${_vtrSig}`
        // S16 — first consumer skip. Read-and-clear the LABEL dirty domain
        // (overlay add/remove, scene rebuild, any invalidate() all re-tag it),
        // and combine it with the dispatch signature: when neither the sig nor
        // the LABEL domain changed, the prepared collision result from the prior
        // frame is still valid, so we skip stage.prepare() / iStage.prepare()
        // (the O(N²) greedy collision + shaping + GPU upload) and let
        // stage.render() replay the renderer's persistent draws unchanged. The
        // dispatch loop still runs (kept simple + leak-free; its `pending` is
        // dropped via stage.reset()/iStage.reset()); a future increment can
        // skip it too. Correctness gate: any camera/canvas/tile change moves the
        // sig; any label-content change tags LABEL — so a needed re-collision is
        // never skipped. frame_stability (replay == original) + post_change
        // (move ⇒ rebuild) on the label matrix cell are the regression net.
        const labelDirty = host.consumeLabelDirty()
        // The skip is only safe when the dispatch signature captures EVERYTHING
        // that can change the labels. Two things it can't: (a) an async label
        // resource (glyph range / sprite atlas) landing after the sig settled —
        // `wasLastPrepareFullyResolved()` is false while glyphs are still in
        // flight, and `isAtlasTerminal()` is false while the atlas is loading,
        // so we keep preparing until both resolve; (b) a time-driven label shape
        // (the sig omits the animation clock) — `_labelsHaveTimeAnimation`. While
        // any of these hold, force a re-collation so a late glyph/icon or an
        // animated text-size isn't frozen until the camera moves.
        const labelResourcesPending =
          !stage.wasLastPrepareFullyResolved()
          || (iStage !== null && !iStage.isAtlasTerminal())
        const canSkipLabelPrepare =
          host._prevLabelDispatchSig === _dispatchSig
          && !labelDirty
          && !labelResourcesPending
          && !host._labelsHaveTimeAnimation
        if (canSkipLabelPrepare) {
          host._labelDispatchHits++
        } else {
          host._labelDispatchMisses++
          host._prevLabelDispatchSig = _dispatchSig
        }
        // _showIdx = draw order (later show = higher layer) — point-label dedup precedence (#458).
        for (let _showIdx = 0; _showIdx < labelShows.length; _showIdx++) {
          const show = labelShows[_showIdx]!
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
            def, shapes, z, elapsedMs, show.fill, host.camera.bearing,
          )

          // Per-feature evaluator for data-driven text-size /
          // text-color (Mapbox `["case", …]` / `["match", …]` /
          // arithmetic forms). Wraps a feature's def with overrides
          // resolved from the data-driven PropertyShapes against
          // that feature's properties. Pulls AST from
          // `def.shapes.size.expr` / `def.shapes.color.expr` — the
          // LabelShapes bundle is the single source of truth post-L2.
          const sizeExprAst = shapes && shapes.textLayout.size.kind === 'data-driven'
            ? shapes.textLayout.size.expr.ast : null
          const colorExprAst = shapes && shapes.textPaint.color !== null && shapes.textPaint.color.kind === 'data-driven'
            ? shapes.textPaint.color.expr.ast : null
          // Per-feature icon-image expression. Compiler emits this
          // when Mapbox `icon-image: ["match", ["get", "subclass"], …]`
          // is present (OFM POI layers). Runtime evaluates the AST
          // per feature, resolves to a sprite atlas key, and feeds
          // dispatchIcon's existing const-path (which already gates
          // on def.iconImage !== undefined and calls IconStage.addIcon).
          const iconImageExprAst = (def as { iconImageExpr?: { ast?: unknown } }).iconImageExpr?.ast ?? null
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
            if (sizeExprAst === null && colorExprAst === null && iconImageExprAst === null) return effectiveDef
            const cached = host._featureExprsCache.get(props)
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
            host._featureExprsCache.set(props, { zoomBucket, effectiveDef, def: out })
            return out
          }

          // Path 1: GeoJSON / inline-data sources whose features live
          // in `rawDatasets`. Iterates the FeatureCollection directly
          // and uses `featureAnchor` to pick a centroid per geometry.
          const data = host.rawDatasets.get(show.targetName)
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
                  ? pointLabelPairKey(labelLayerName, _pointLabelSeq++)
                  : undefined
                stage.addLabel(
                  featDef.text, feat.properties ?? {},
                  projected[0], projected[1], featDef,
                  undefined, labelLayerName, pairKey,
                )
                dispatchIcon(featDef, projected[0], projected[1], 0, pairKey)
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
            const DEG2RAD = Math.PI / 180
            const R = 6378137
            const mercToLonLat = (mx: number, my: number): [number, number] => [
              (mx / R) / DEG2RAD,
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
              // #603 — cross-tile dedup for text-less line icons. Declared here
              // so emitLabelAlongSegment (defined below) can close over it.
              // Assigned inside the spacingPx > 0 block where the dedup Set is
              // set up; before that block it is a no-op (single-feature paths
              // have no cross-tile ambiguity). Never-duplicate by default.
              let isLineIconDuplicate: (sx: number, sy: number) => boolean = () => false
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
                // #603 — cross-tile dedup for text-less line icons. When
                // there is no text (road_oneway arrows), the text-name
                // dedup doesn't gate the icon. Two tiles' polyline walks
                // can place icons at nearby but non-overlapping screen
                // positions at a tile seam. Gate via bucketed screen pos.
                // Predicate is the RESOLVED text being empty (lineIconIsIconOnly),
                // NOT featDef.text === undefined: an icon-only symbol emits
                // text === '""' (compiler symbol.ts labelExpr), so featDef.text
                // is a non-null empty template — the old `featDef.text !==
                // undefined` test was ALWAYS true and this dedup never fired for
                // road_oneway arrows (#603).
                if (lineIconIsIconOnly(featDef.text, props, host.camera.zoom)
                    && pairedWithIcon && isLineIconDuplicate(x, y)) return
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
                dispatchIcon(featDef, x, y, rawTangentDeg, pairKey, true, props)
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
                const emittedTextNames = host._scratchEmittedTextNames
                emittedTextNames.clear()
                const isTooCloseToSameText = (resolvedText: string, _sx: number, _sy: number): boolean => {
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
                // Static return holder for samplePosAt — closure used to
                // return `{ x, y }` on every call, which fired in the
                // hot loop below per spacing point.
                // [x, y, tangentDeg] — tangent angle (degrees CCW from +x)
                // is the segment direction at the sample point. Used by
                // icon-rotation-alignment=map to rotate per-segment icons
                // with the line direction (OFM road_oneway arrows).
                const _samplePosOut: [number, number, number] = [0, 0, 0]
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
                const pxPerMeter = (_ppmA && _ppmB && Number.isFinite(_ppmAx))
                  ? Math.hypot(_ppmB[0] - _ppmAx, _ppmB[1] - _ppmAy) : 0
                const LABEL_SAMPLE_GAP_PX = 96
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
                  for (let i = 0; i < N - 1; i++) {
                    const ax = mxs[i]!, ay = mys[i]!
                    const bx = mxs[i + 1]!, by = mys[i + 1]!
                    const segDx = bx - ax, segDy = by - ay
                    const segLenM = Math.sqrt(segDx * segDx + segDy * segDy)
                    const dynSteps = lineLabelSubdivSteps(segLenM, pxPerMeter, LABEL_SAMPLE_GAP_PX, SUBDIVS_PER_SEG)
                    for (let s = i === 0 ? 0 : 1; s <= dynSteps; s++) {
                      const t = s / dynSteps
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
                  // Iter 112 paired-symbol collision for CURVED shields.
                  // Mirror of emitLabelAlongSegment (~line 538): a
                  // tangent-rotated line label with a paired icon-image
                  // (OFM highway-shield-* / road_shield_us at z>=11) must
                  // place/drop with its badge. Each emitted stop below
                  // gets a fresh `${layer}:seq${_lineLabelSeq++}` shared
                  // by the curved label AND its dispatchIcon, so a
                  // collision-rejected number drops the orphaned box.
                  const curvePairedWithIcon = featDef.iconImage !== undefined
                    && featDef.iconImage !== null
                    && featDef.iconImage !== ''
                  // Cross-tile dedupe key.
                  //
                  // #605 — a route-number SHIELD (text+icon line symbol,
                  // OFM highway-shield-*: text-field = ["to-string",["get",
                  // "ref"]]) is identified by its REF ("82"), not the road
                  // `name`. A national route overlays many differently-named
                  // OSM road segments — some carry a street `name`, some only
                  // `ref` — so the `name`-preferring key below diverges per
                  // segment and the same "82" shield stamps once PER distinct
                  // name across the tiles a route fills at high zoom (~6× at
                  // z19 vs MapLibre ~1×). Key shields on the RESOLVED drawn
                  // text (the ref) instead, which is stable across every
                  // segment of one route, so the existing along-walk dedupe
                  // (isTooCloseToSameText, checked at each screen-space spacing
                  // stop) collapses the whole route to one shield — MapLibre's
                  // per-route cadence. The ref is monolingual, so the
                  // bilingual-divergence concern that motivates the `name`
                  // path does not apply to shields.
                  //
                  // For a plain road-NAME label (no paired icon) resolveText()
                  // DOES vary across segments when one carries `name:nonlatin`
                  // and the next doesn't — the concat expression returns
                  // different strings even though the road is the same. Prefer
                  // the most stable name field (`name` → `name_en` → resolved
                  // fallback) so the dedupe matches across heterogeneous
                  // segments. See lineLabelDedupeKey for the full rationale.
                  const resolvedTextForDedupe = lineLabelDedupeKey(
                    curvePairedWithIcon, featDef.text, props, host.camera.zoom,
                  )
                  // #605 — TILE-STABLE lineId for the screen-space along-line
                  // collision (greedyPlaceBboxes minLineSpacingPx). The
                  // dispatch-side `isTooCloseToSameText` cap (c5064d3a) collapses
                  // repeats WITHIN one ShowCommand's polyline walk, but PMTiles
                  // slices a long route into a SEPARATE per-tile featId/polyline,
                  // so at z19 each tile's dispatch re-emits the same "82" shield —
                  // ~one per tile survives on screen. The collision pass caps that
                  // in SCREEN space: same-lineId anchors within MIN_LINE_SPACING_PX
                  // collide/drop regardless of which tile dispatched them. The id
                  // must be stable ACROSS tiles, so it is the route identity
                  // (resolvedTextForDedupe — the ref for a shield, the name for a
                  // plain label), NOT the tile; qualified by layer (NUL-joined, a
                  // char no ref/name contains) so two layers' identical refs stay
                  // independent lines. Empty key (icon-only symbols render no text,
                  // so addCurvedLineLabel no-ops anyway) ⇒ undefined: not subject
                  // to same-line spacing, exactly like a point label.
                  const lineId = resolvedTextForDedupe !== ''
                    ? `${labelLayerName ?? ''}\u0000${resolvedTextForDedupe}`
                    : undefined
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
                    // #603 — text-less line icons (road_oneway, icon-only
                    // shields) render no text, so isTooCloseToSameText
                    // (keyed on resolvedTextForDedupe) doesn't gate them. Apply
                    // the position-bucket dedup so two adjacent tiles' polylines
                    // don't emit duplicate icons at the same screen spot.
                    // Gate on the symbol's OWN resolved text-field being
                    // empty (lineIconIsIconOnly): an icon-only symbol emits
                    // text === '""', so featDef.text is never undefined — the
                    // old `featDef.text !== undefined` test was always true and
                    // the dedup never fired (#603). NB resolvedTextForDedupe
                    // can't be reused for icon-only symbols: for a plain label
                    // it falls back to the feature's `name` prop, which a
                    // road_oneway arrow may carry from its source road even
                    // though it renders no text — that would make the icon-only
                    // test a false negative.
                    const curveIsIconOnly = lineIconIsIconOnly(featDef.text, props, host.camera.zoom)
                    if (total < spacingPx * 0.5) {
                      if (samplePosAt(total * 0.5)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        const tang = _samplePosOut[2]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)
                            && (!(curveIsIconOnly && curvePairedWithIcon) || !isLineIconDuplicate(sx, sy))) {
                          const pairKey = curvePairedWithIcon
                            ? `${labelLayerName ?? ''}:seq${_lineLabelSeq++}`
                            : undefined
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, total * 0.5,
                            featDef,
                            undefined, labelLayerName, pairKey,
                            // #605 — same-route screen-space cap: lineId is the
                            // tile-stable route identity; anchorDistancePx is the
                            // anchor's along-polyline screen offset.
                            lineId, total * 0.5,
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
                          // arrows) follows the road tangent. Same
                          // pairKey as the label so the badge drops when
                          // the road number loses collision.
                          dispatchIcon(featDef, sx, sy, tang, pairKey, true, props)
                          recordTextPosition(resolvedTextForDedupe, sx, sy)
                        }
                      }
                      perfMarkEnd('encoder.label-dispatch.line.emit')
                      perfMarkEnd('encoder.label-dispatch.line.polyline')
                      return
                    }
                    let nextStop = spacingPx * 0.5
                    while (nextStop <= total) {
                      if (samplePosAt(nextStop)) {
                        const sx = _samplePosOut[0], sy = _samplePosOut[1]
                        const tang = _samplePosOut[2]
                        if (!isTooCloseToSameText(resolvedTextForDedupe, sx, sy)
                            && (!(curveIsIconOnly && curvePairedWithIcon) || !isLineIconDuplicate(sx, sy))) {
                          const pairKey = curvePairedWithIcon
                            ? `${labelLayerName ?? ''}:seq${_lineLabelSeq++}`
                            : undefined
                          stage.addCurvedLineLabel(
                            featDef.text, props,
                            polyX, polyY, nextStop,
                            featDef,
                            undefined, labelLayerName, pairKey,
                            // #605 — see the short-line call above.
                            lineId, nextStop,
                          )
                          dispatchIcon(featDef, sx, sy, tang, pairKey, true, props)
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
                  // projectLonLat returns the shared scratch tuple, so copy A
                  // out before projecting B — otherwise pa === pb (both hold
                  // endpoint B) and the midpoint collapses to B with 0 tangent.
                  const a = projectLonLat(aLon, aLat)
                  if (!a) return
                  const ax2 = a[0], ay2 = a[1]
                  const pb = projectLonLat(bLon, bLat)
                  if (!pb) return
                  emitLabelAlongSegment(ax2, ay2, pb[0], pb[1], 0.5, props)
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
                const dedupKey = resolvedText !== ''
                  ? `${resolvedText}|${Math.round(mercX / 256)},${Math.round(mercY / 256)}`
                  : ''
                // Higher layer wins (#458); same/lower collapses (cross-tile / bilingual — iter-274/280).
                if (dedupKey !== '' && !shouldEmitPointDedup(emittedPointNames.get(dedupKey), _showIdx)) return
                if (dedupKey !== '') emittedPointNames.set(dedupKey, _showIdx)
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
                if (host.projectionName !== 'mercator') {
                  const [lon, lat] = mercToLonLat(mercX, mercY)
                  for (const projected of projectLonLatCopies(lon, lat)) {
                    const pairKey = pairedWithIcon
                      ? pointLabelPairKey(labelLayerName, _pointLabelSeq++)
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
                    ? pointLabelPairKey(labelLayerName, _pointLabelSeq++)
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
        // S16 skip: on an unchanged frame, reuse the prior prepare's GPU draws
        // (stage.render below replays them); skipping the collision + upload is
        // the measurable payload (see getLabelDispatchStats hitRate).
        if (!canSkipLabelPrepare) {
          // #609 — seed text collision with icon boxes BEFORE TextStage.prepare
          // so a label can't draw over a collide-icon from a separate feature.
          // MapLibre puts placed icon boxes in the shared collision grid every
          // label hit-tests against; we replicate that by passing them as
          // obstacles. computeObstacles() reads the pending queue (pre-prepare)
          // so it must run BEFORE iStage.prepare() clears it. A paired icon's
          // own text is exempted via matching groupKey.
          //
          // #609 over-drop fix — pass the pairKeys whose text label has a live
          // bbox in THIS pass (getActiveTextPairKeys, valid here because
          // stage.prepare hasn't run / reset hasn't cleared the queues). A
          // paired icon with live text is skipped as an obstacle: its text
          // bbox already blocks, and if the text loses collision the icon is
          // dropped (droppedPairKeys) — so its box must not phantom-block a
          // different-group label. Empty-text / icon-only paired symbols are
          // absent from the set and still seed obstacles.
          const activeTextPairKeys = iStage ? stage.getActiveTextPairKeys() : new Set<string>()
          const iconObstacles = iStage ? iStage.computeObstacles(activeTextPairKeys) : []
          stage.prepare(iconObstacles)
          if (iStage) iStage.setDroppedPairKeys(stage.getDroppedPairKeys())
          iStage?.prepare()
        }
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
