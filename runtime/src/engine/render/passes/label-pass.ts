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
// scalars the block read (device / dpr / sampleCount / w / h / projType /
// centerLon / centerLat / encoder) are re-bound from ctx at the top so
// the body text is otherwise byte-identical. ctx.mvp / ctx.visibleWorldCopies
// are still populated here (the FrameContext fields the label block owns).

import { evaluate, makeEvalProps, resolveColor } from '@xgis/compiler'
import { markStart as perfMarkStart, markEnd as perfMarkEnd } from '../../__profile__/perf-marks'
import { DEBUG_OVERDRAW } from '../../debug-flags'
import { WORLD_MERC } from '../../gpu/gpu-shared'
import { projectWgsl } from '../../projection/projection-wgsl-mirror'
import { globeForward } from '../../projection/globe'
import { resolveNumberShape } from '../paint-shape-resolve'
import { resolveLabelEffectiveDef, makeLabelProjectors } from '../../render-loop-helpers'
import { computeSliceKey } from '../../../data/eval/filter-eval'
import { TextStage, type TextStageOptions } from '../../text/text-stage'
import { IconStage } from '../../sprite/icon-stage'
import { resolveText } from '../../text/text-resolver'
import { hexToRgba, featureAnchor } from '../../feature-helpers'
import { type ShowCommand } from '../renderer'
import type { FrameContext } from '../frame-context'
import type { SceneView } from '../scene-view'
import type { RenderPass, PassHost } from './pass'

class LabelPass implements RenderPass {
  readonly label = 'labels'

  // Internal disableLabels / empty-overlays-and-shows checks short-circuit
  // the body, so this pass is always "run" from the chain.
  shouldRun(): boolean { return true }

  execute(ctx: FrameContext, _scene: SceneView, host: PassHost): void {
    const { device, dpr, sampleCount: sc, w, h, projType, centerLon, centerLat, encoder } = ctx
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
          host.textStage = new TextStage(device, host.ctx.format, tsOpts, sc)
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
          host.iconStage = new IconStage(device, host.ctx.format, {
            spriteUrl: host.spriteUrl, dpr,
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
        stage.setCameraZoom(host.camera.zoom)
        const frame = host.camera.getFrameView(w, h, dpr)
        const mvp = frame.matrix
        ctx.mvp = mvp
        const ccx = host.camera.centerX
        const ccy = host.camera.centerY

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
        const _lblIsMerc = host.projectionName === 'mercator'
        const _lblIsGlobe = host.projectionName === 'globe'
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
        const visibleWorldCopies = host.camera.getVisibleWorldCopies(w, h, dpr)
        ctx.visibleWorldCopies = visibleWorldCopies
        const { projectMerc, projectLonLat, projectMercAny, projectLonLatCopies } =
          makeLabelProjectors(
            mvp, w, h, ccx, ccy, projType, centerLon, centerLat,
            _lblIsMerc, _lblIsGlobe, _lblGlobeCenter, _lblCenter,
            host.projectionName, visibleWorldCopies,
          )

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
          `${(c.zoom * 100) | 0}|${c.centerX | 0},${c.centerY | 0}`
          + `|${(c.bearing * 100) | 0}|${(c.pitch * 100) | 0}`
          + `|${host.ctx.canvas.width}x${host.ctx.canvas.height}`
          + `|${labelShows.length}|${_vtrSig}`
        if (host._prevLabelDispatchSig === _dispatchSig) {
          host._labelDispatchHits++
        } else {
          host._labelDispatchMisses++
          host._prevLabelDispatchSig = _dispatchSig
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
          const vtEntry = host.vtSources.get(show.targetName)
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
                const emittedTextNames = host._scratchEmittedTextNames
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
                    : resolveText(featDef.text, props, host.camera.zoom)
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
                if (host.projectionName !== 'mercator') {
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
}

/** Stateless singleton — the per-feature label + text-overlay pass. */
export const labelPass: RenderPass = new LabelPass()
