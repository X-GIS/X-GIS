import type { VectorTileRenderer } from '../vector-tile-renderer'
import type { RenderArgs, TileSelection, PaintSlots } from '../vector-tile-renderer-types'
import { hexToRgba } from '../../feature-helpers'
import { fillTranslateNdc, rotateTranslateForAnchor } from '../fill-translate-ndc'
import { globeEyeUniform } from '../globe-eye-uniform'
import { writeInputPool } from '../input-pool'
import { toComposerLineVariant } from '../line-shader-cache'
import { resolveFillPatternPack } from '../material/polygon-fill-material'
import { variantProducesFill } from '../renderer-helpers'
import { warnStageBlockUnsupported } from '../stage-block-warning'

/** #2508 phase 3 — resolve the paint into uniforms: every zoom × time
 *  resolved scalar / colour of the show is written to the layer slot(s) of
 *  the uniform ring, and the renderer's per-call paint fields
 *  (`current*`, `cached*`, `_skipFillDraw`, the pattern / dash / bake-stroke
 *  state) are set for the draw phases. Returns the layer-slot offsets. */
export function resolvePaintUniforms(
  vtr: VectorTileRenderer,
  args: RenderArgs,
  sel: TileSelection,
): PaintSlots {
  // Cache color parsing — only reparse if show properties changed.
  //
  // Animation override: if `resolvedFillRgba` / `resolvedStrokeRgba` is
  // set, the classifier has already interpolated this frame's value from
  // a keyframes block. Use it directly — skipping both the hex cache
  // check AND the hex parse. The cached base color stays intact so a
  // subsequent static frame can re-use it.
  // Opacity is already resolved (zoom × time) by the bucket
  // scheduler — ResolvedShow is the SOLE per-frame source.
  vtr.currentOpacity = args.resolvedShow.opacity
  vtr.currentPickId = args.show.pickId ?? 0
  // 3D extrusion: driven by the layer's `extrude:` style keyword. Both the
  //   * `extrude: 50`      constant form AND
  //   * `extrude: .height` per-feature form
  // now feed the SAME per-feature heights Map → wall mesh → extruded pipe
  // (#1084 synthesises a constant NumberLiteral for the `50` form at the
  // show-source-maps seam). currentExtrudeHeight / u.extrude_height_m is a
  // dead mirror no shader reads — kept only to avoid a uniform re-layout.
  //
  // #1252 — a data-driven fill (needsFeatureBuffer) now extrudes too: the
  // show routes through the feature layout AND the bucket scheduler hands
  // VTR the variant's own feature-layout extruded pipeline (drawFpE), which
  // fs_fill_extrude uses to sample feat_data[fid]. No more flat downgrade.
  if (args.show.extrude && args.show.extrude.kind === 'constant') {
    vtr.currentExtrudeHeight = args.show.extrude.value
    vtr.currentExtrudeMode = 'per-feature' // #1084: heights synthesised per-feature → extruded pipe
  } else if (args.show.extrude && args.show.extrude.kind === 'feature') {
    vtr.currentExtrudeHeight = args.show.extrude.fallback
    vtr.currentExtrudeMode = 'per-feature'
  } else {
    vtr.currentExtrudeHeight = 0
    vtr.currentExtrudeMode = 'none'
  }
  // Mapbox `fill-extrusion-base` — wall BOTTOM z. Constant form
  // packs into u.extrude_base_m; feature form falls back to the
  // declared fallback for the uniform mirror (per-feature base
  // needs its own attribute, deferred). Absent → 0 (flat ground).
  if (args.show.extrudeBase && args.show.extrudeBase.kind === 'constant') {
    vtr.currentExtrudeBase = args.show.extrudeBase.value
  } else if (args.show.extrudeBase && args.show.extrudeBase.kind === 'feature') {
    vtr.currentExtrudeBase = args.show.extrudeBase.fallback
  } else {
    vtr.currentExtrudeBase = 0
  }
  // Mapbox fill-/line-translate — bake CSS px → NDC-per-pixel (`2 /
  // canvasDim`); vertex shader multiplies by clip.w so the offset stays
  // pixel-constant after the perspective divide. Reads the PER-FRAME
  // resolved offset from ResolvedShow (zoom-interp shapes already collapsed
  // to a scalar; constant forms pass through). translate-anchor=map:
  // rotateTranslateForAnchor rotates (dx,dy) by the map bearing so the
  // offset tracks the MAP world axes (MapLibre map-anchor). Default
  // anchor=viewport returns (dx,dy) untouched → byte-identical historical
  // screen-space path. (Pitch foreshortening of a map-anchored offset is
  // not reproduced by this clip-space bake; bearing rotation is the flat
  // behaviour.)
  const bearingDeg = args.camera.bearing ?? 0
  const fillTr = fillTranslateNdc(
    args.resolvedShow,
    args.show,
    args.camera,
    args.canvasWidth,
    args.canvasHeight,
  )
  vtr.currentFillTranslateNdcX = fillTr[0]
  vtr.currentFillTranslateNdcY = fillTr[1]
  const [ltx, lty] = rotateTranslateForAnchor(
    args.resolvedShow.strokeTranslateX,
    args.resolvedShow.strokeTranslateY,
    args.show.strokeTranslateAnchorMap,
    bearingDeg,
  )
  vtr.currentStrokeTranslateNdcX = ltx !== 0 ? (ltx * 2) / args.canvasWidth : 0
  vtr.currentStrokeTranslateNdcY = lty !== 0 ? (lty * 2) / args.canvasHeight : 0
  // Mapbox fill-antialias / fill-extrusion-vertical-gradient opt-outs, packed
  // into cam_ecef_off_{h,l}.w below: 1 = current behavior (byte-identical
  // default), 0 = opt-out, and the WGSL gates on `!= 0`. Antialias reads the
  // per-frame RESOLVED flag so #1995's zoom form flips it at its authored zoom.
  vtr.currentFillAntialias = args.resolvedShow.fillAntialias ? 1 : 0
  vtr.currentFillVerticalGradient = args.show.fillExtrusionVerticalGradient === false ? 0 : 1
  vtr.currentBearingDeg = args.camera.bearing ?? 0
  // Per-frame resolved fill RGBA — animated stops were already
  // collapsed by the bucket scheduler. ResolvedShow is the SOLE
  // per-frame source; static hex still flows via show.fill below
  // when the ShowCommand declared a `kind: 'constant'` fill.
  const resolvedFill = args.resolvedShow.fill
  if (resolvedFill) {
    vtr.cachedFillColor[0] = resolvedFill[0]
    vtr.cachedFillColor[1] = resolvedFill[1]
    vtr.cachedFillColor[2] = resolvedFill[2]
    vtr.cachedFillColor[3] = resolvedFill[3]
    vtr.cachedShowFill = ''
  } else if (args.show.fill !== vtr.cachedShowFill) {
    vtr.cachedShowFill = args.show.fill ?? ''
    const raw = hexToRgba(args.show.fill)
    vtr.cachedFillColor[0] = raw ? raw[0] : 0
    vtr.cachedFillColor[1] = raw ? raw[1] : 0
    vtr.cachedFillColor[2] = raw ? raw[2] : 0
    vtr.cachedFillColor[3] = raw ? raw[3] : 0
  }
  const resolvedStroke = args.resolvedShow.stroke
  if (resolvedStroke) {
    vtr.cachedStrokeColor[0] = resolvedStroke[0]
    vtr.cachedStrokeColor[1] = resolvedStroke[1]
    vtr.cachedStrokeColor[2] = resolvedStroke[2]
    vtr.cachedStrokeColor[3] = resolvedStroke[3]
    vtr.cachedShowStroke = ''
  } else if (args.show.stroke !== vtr.cachedShowStroke) {
    vtr.cachedShowStroke = args.show.stroke ?? ''
    const raw = hexToRgba(args.show.stroke)
    vtr.cachedStrokeColor[0] = raw ? raw[0] : 0
    vtr.cachedStrokeColor[1] = raw ? raw[1] : 0
    vtr.cachedStrokeColor[2] = raw ? raw[2] : 0
    vtr.cachedStrokeColor[3] = raw ? raw[3] : 0
  }

  // Skip the fill drawIndexed entirely when we KNOW nothing visible will
  // be produced. Two cases qualify:
  //   1. show.fill is undefined AND no shader variant computes the fill
  //      from feature data (e.g. multi_layer's `borders | stroke-* opacity-80`
  //      gets routed through the opaque bucket as fillPhase='fills' but
  //      declared no fill at all).
  //   2. show.fill resolved to a color whose alpha is effectively 0.
  // BUT a data-driven `fill match(...)` produces colors entirely inside
  // the variant pipeline (fillIsDefault === false), so cachedFillColor
  // can be [0,0,0,0] yet the draw is still meaningful — must keep it.
  // The skip uses the typed `fillIsDefault` sentinel (variantProducesFill()
  // helper), not a default-uniform string compare on variantFillExpr.
  vtr._skipFillDraw =
    !variantProducesFill(args.show.shaderVariant) && vtr.cachedFillColor[3] <= 0.005
  // #1080 — translucent fill-extrusion front-shell gate (MapLibre draws a front
  // shell for opacity < 1). Data-driven fill → layer opacity; else fill.a×opacity.
  const extrudeFillAlpha = variantProducesFill(args.show.shaderVariant)
    ? vtr.currentOpacity
    : vtr.cachedFillColor[3] * vtr.currentOpacity
  vtr._extrudeTranslucentFrontShell = extrudeFillAlpha < 0.999
  // #599 line-drape — reset per render(); set at the drape seam / layer-slot block below.
  vtr._drapeStrokes = false
  vtr._bakeStrokeActive = false
  vtr._bakeStrokesGated = false

  // Write uniforms through the typed block's fixed-arity setters (zero
  // per-call allocation — the hot-loop surface; #733 P2d).
  const B = vtr.frameBlock
  B.set.mvp(sel.mvp) // ECEF-MVP
  // Fill-pattern packs the sprite atlas UV bbox into the fill_color slot
  // instead of the resolved RGBA. fs_fill_pattern reads (u0, v0, u1, v1)
  // from u.fill_color. The pattern repeat in metres is written to the
  // fill_translate slots below (overriding the fill-translate NDC values).
  // Both overrides apply ONLY when the show has a resolved pattern bbox +
  // the pattern pipeline path is wired by the caller (setPatternPipelines).
  // #1059 — the pattern-active DECISION + slot bytes come from the shared
  // resolveFillPatternPack authority (the WebGL2 twin renderFillsRhi packs the
  // SAME bytes through it, so the two backends cannot drift). Byte-identical to
  // the prior inline pack: fill_color = the atlas-UV bbox, repeat = fillPatternRepeatM.
  const pack = resolveFillPatternPack(
    args.show.fillPatternUV,
    args.show.fillPatternRepeatM,
    vtr._bindGroups.patternGroundPipeline() !== null,
  )
  if (pack.active) {
    B.set.fill_color(pack.u0, pack.v0, pack.u1, pack.v1)
    vtr._patternUniformActive = true
    vtr._patternRepeatMX = pack.repeatMX
    vtr._patternRepeatMY = pack.repeatMY
  } else {
    B.set.fill_color(
      vtr.cachedFillColor[0]!,
      vtr.cachedFillColor[1]!,
      vtr.cachedFillColor[2]!,
      vtr.cachedFillColor[3]! * vtr.currentOpacity,
    )
    vtr._patternUniformActive = false
  }
  // Line-pattern packs the sprite atlas UV bbox into the stroke_color
  // slot (20-23). fs_line_pattern reads (u0, v0, u1, v1) from
  // tile.stroke_color. Pattern shows trade their solid stroke colour for
  // the atlas sample.
  const linePatternSlotsActive =
    args.show.linePatternUV != null &&
    args.show.linePatternRepeatM != null &&
    vtr.lineRenderer != null
  vtr._linePatternActiveForShow = linePatternSlotsActive
  if (linePatternSlotsActive) {
    const lu = args.show.linePatternUV!
    B.set.stroke_color(lu[0]!, lu[1]!, lu[2]!, lu[3]!)
  } else {
    B.set.stroke_color(
      vtr.cachedStrokeColor[0]!,
      vtr.cachedStrokeColor[1]!,
      vtr.cachedStrokeColor[2]!,
      vtr.cachedStrokeColor[3]! * vtr.currentOpacity,
    )
  }
  // proj_params + globe_eye written TOGETHER (frame-invariant; kept colocated
  // so the #600 "projection set, eye forgotten" leak stays unrepresentable —
  // frame.eye is the globe/ECEF camera position, undefined off the globe →
  // globe_eye zero, ignored by the flat/disc cull arms).
  B.set.proj_params(args.projType, args.projCenterLon, args.projCenterLat, 0)
  vtr.currentProjType = args.projType
  const ge = globeEyeUniform(sel.frame.eye)
  B.set.globe_eye(ge[0], ge[1], ge[2], ge[3])
  writeInputPool(B, vtr.inputs)

  // Allocate + write SDF line layer slot for this render() call. All
  // drawSegments() calls below will use this same byte offset.
  // In 'fills' phase no drawSegments runs, so skip the allocation entirely
  // to avoid ring-slot churn, redundant pattern-param warnings, and any
  // incidental validation surface in the translucent fill pre-pass.
  let lineLayerOffset = 0
  // Mapbox `line-gap-width` double-draw second offset. When
  // show.strokeGapWidth > 0 the line renders as TWO parallel
  // strokes; this holds the second layer-slot uniform offset.
  // -1 sentinel = no second draw (single-line legacy path).
  let lineLayerOffsetGap = -1
  if (vtr.lineRenderer && args.phase !== 'fills') {
    // Pure-zoom stroke-width stops (Mapbox `paint.line-width:
    // ["interpolate", curve, ["zoom"], …]`) recompute per frame
    // against camera.zoom — so a line widens smoothly as the user
    // zooms inside one tile-zoom level. The static `show.strokeWidth`
    // is the lower.ts default (1); we override it here. Per-feature
    // widths (compound merge → `strokeWidthExpr`) still go through
    // the worker bake + segment slot.
    // Pre-resolved by bucket-scheduler (zoom × time → plain scalar).
    const strokeWidthPx = args.resolvedShow.strokeWidth
    // #739 — capped world scale the frozen low-zoom MVP renders at (see the
    // renderLinesRhi twin). Keeps dash + pattern metres and stroke width in
    // lockstep with the view instead of the uncapped 2^zoom mpp.
    const mpp = args.camera.effectiveMpp(args.projType, args.canvasHeight, args.dpr)
    const capMap = { butt: 0, round: 1, square: 2, arrow: 3 } as const
    const joinMap = { miter: 0, round: 1, bevel: 2 } as const
    // Mapbox GL spec defaults for OMITTED line-cap/join/miter-limit:
    // butt / miter / 2 (the converter emits a utility only when the layer
    // SETS them). Sharp miters bevel-fall-back in line-segment-build.ts.
    const cap = capMap[args.show.linecap ?? 'butt']
    const join = joinMap[args.show.linejoin ?? 'miter']
    const miterLimit = args.show.miterlimit ?? 2.0
    // Mapbox line-round-limit (default 1.05). Unset → 0, which the line
    // shader reads as "use the historical round-join fold threshold"
    // (byte-identical to pre-feature behaviour); a positive value scales
    // that threshold by round_limit / 1.05.
    const roundLimit = args.show.roundLimit ?? 0
    // Dash values are in LINE-WIDTH UNITS (Mapbox spec:
    // "The lengths are later multiplied by the line width").
    // A `[2, 3]` dash on a 4-px line is 8 px dash + 12 px gap;
    // the same dash on a 6-px line is 12 + 18. Earlier the code
    // treated dash values as raw pixels, which produced near-
    // invisible dashes on thin admin-boundary / bridge-casing
    // lines (boundary_3 has [1,1] dash + 1-2 px width — without
    // the multiply, 1-px dashes against a 1-px line gave near-
    // continuous coverage and looked solid).
    // jscpd:ignore-start — twins of `renderLinesRhi`'s dash + pattern-slot derivation,
    // which that method documents as mirroring this one verbatim (#834 M5 slice 5) so the
    // WebGL2 line path cannot drift from the WebGPU paint path. Both copies pre-exist on
    // main (VTR:1580/1599 and :3189/3208); #2508 only moved this one into the paint phase,
    // which re-fingerprints the pair for the dup ratchet. Extracting the two helpers is
    // #2577 — a WebGL2-path change this motion-only refactor must not smuggle in.
    const dashWidthScalePx = sel.strokeWidthPx_h
    // Prefer the PER-FRAME resolved dash array (zoom-interp STEP) over
    // the static one; constant dash falls through unchanged.
    const dashSrc = args.resolvedShow.dashArray ?? args.show.dashArray
    let dashArray: number[] | null = null
    if (dashSrc && dashSrc.length >= 2) {
      // #778 <P5>: reuse the cached scaled array when the source-array
      // identity AND both scale factors are bit-identical (unchanged
      // zoom + stroke-width → byte-identical map); else recompute + cache.
      // Factors compared separately, not as a product (float multiply is
      // non-associative → equal product would NOT guarantee equal values).
      const c = vtr._dashArrayCache
      if (c !== null && c.src === dashSrc && c.scalePx === dashWidthScalePx && c.mpp === mpp) {
        dashArray = c.result
      } else {
        dashArray = dashSrc.map((v) => v * dashWidthScalePx * mpp)
        vtr._dashArrayCache = { src: dashSrc, scalePx: dashWidthScalePx, mpp, result: dashArray }
      }
    }
    const dash =
      dashArray !== null
        ? {
            array: dashArray,
            offset: args.resolvedShow.dashOffset * dashWidthScalePx * mpp,
          }
        : null

    // Resolve patterns: shape name → registry ID; unit name → flag code.
    const unitMap = { m: 0, px: 1, km: 2, nm: 3 } as const
    const anchorMap = { repeat: 0, start: 1, end: 2, center: 3 } as const
    const patternSlots = (args.show.patterns ?? [])
      .slice(0, 3)
      .map((p) => ({
        shapeId: vtr.lineRenderer!.resolveShapeId(p.shape),
        spacing: p.spacing,
        spacingUnit: unitMap[p.spacingUnit ?? 'm'],
        size: p.size,
        sizeUnit: unitMap[p.sizeUnit ?? 'm'],
        offset: p.offset ?? 0,
        offsetUnit: unitMap[p.offsetUnit ?? 'm'],
        startOffset: p.startOffset ?? 0,
        anchor: anchorMap[p.anchor ?? 'repeat'],
      }))
      .filter((p) => p.shapeId > 0)
    // jscpd:ignore-end

    // In translucent mode ('strokes' phase) the offscreen RT must hold the FULL color + stroke
    // alpha (no opacity multiply); the composite step then blends with the layer opacity —
    // otherwise we'd double-apply it.
    const layerOpacity = args.phase === 'strokes' ? 1.0 : vtr.currentOpacity

    // Resolve stroke alignment to an effective offset. Inset/outset shift by ±half_width;
    // combines additively with explicit stroke-offset-N (fine-tune around the baseline).
    const explicitOffset = args.show.strokeOffset ?? 0
    const alignDelta =
      args.show.strokeAlign === 'inset'
        ? strokeWidthPx / 2
        : args.show.strokeAlign === 'outset'
          ? -strokeWidthPx / 2
          : 0
    const effectiveOffset = explicitOffset + alignDelta

    // Mapbox line-gap-width: render the line as TWO parallel strokes with perpendicular
    // offsets ±(gap + stroke) / 2. OFM Liberty waterway_tunnel is the only fixture hit. Zero
    // or absent gap stays on the legacy single-line path. The half-offset is added/subtracted
    // from `effectiveOffset` so existing alignment + explicit offset stack correctly (a line
    // authored with stroke-offset-right-2 + line-gap-width:6 + line-width:1 ends up with one
    // stroke at offset 2 + 3.5 = 5.5 and one at offset 2 − 3.5 = −1.5).
    const gapWidth = args.show.strokeGapWidth ?? 0
    const halfGap = gapWidth > 0 ? (gapWidth + strokeWidthPx) / 2 : 0

    // Line-pattern override. When the show has a resolved pattern repeat, replace
    // strokeColor.r / .a with the x / y repeat metres (fs_line_pattern reads layer.color.r/.a
    // as repeat axes). The solid stroke colour is lost on the pattern path, but the sprite
    // atlas sample provides the visual colour band (mirror of fill-pattern's fill_color reuse).
    const linePatternActive =
      args.show.linePatternUV != null && args.show.linePatternRepeatM != null
    // #2117 — a pattern layer trades layer.color for the atlas repeat/UV lanes and takes its
    // RGB from the sprite, so a ramp there could only bend the pattern's alpha. Mapbox treats
    // the two as mutually exclusive; the pattern wins.
    const lineGradient = linePatternActive ? null : (args.show.strokeGradientStops ?? null)
    const lineSlotColor: [number, number, number, number] = linePatternActive
      ? [args.show.linePatternRepeatM![0], 0, 0, args.show.linePatternRepeatM![1]]
      : [
          vtr.cachedStrokeColor[0],
          vtr.cachedStrokeColor[1],
          vtr.cachedStrokeColor[2],
          vtr.cachedStrokeColor[3],
        ]

    const lineVariant = toComposerLineVariant(args.show.shaderVariant)
    // #1605 Phase 1 — narrowed to a genuine @stroke stage block that
    // toComposerLineVariant rejected for another reason (needsFeatureBuffer
    // etc, Phase 1b+); an ordinary constant/zoom/time-only stroke is NOT a
    // stage block (strokeIsStage is false for it) and never warns.
    warnStageBlockUnsupported(
      args.show.targetName,
      'line',
      Boolean(args.show.shaderVariant?.strokeIsStage) && !lineVariant,
    )
    lineLayerOffset = vtr.lineRenderer.writeLayerSlot(
      lineSlotColor,
      strokeWidthPx,
      layerOpacity,
      mpp,
      cap,
      join,
      miterLimit,
      dash,
      patternSlots,
      effectiveOffset + halfGap,
      args.canvasHeight,
      args.show.strokeBlur ?? 0,
      args.dpr,
      vtr.currentStrokeTranslateNdcX,
      vtr.currentStrokeTranslateNdcY,
      roundLimit,
      lineGradient,
    )
    if (gapWidth > 0) {
      lineLayerOffsetGap = vtr.lineRenderer.writeLayerSlot(
        [
          vtr.cachedStrokeColor[0],
          vtr.cachedStrokeColor[1],
          vtr.cachedStrokeColor[2],
          vtr.cachedStrokeColor[3],
        ],
        strokeWidthPx,
        layerOpacity,
        mpp,
        cap,
        join,
        miterLimit,
        dash,
        patternSlots,
        effectiveOffset - halfGap,
        args.canvasHeight,
        args.show.strokeBlur ?? 0,
        args.dpr,
        vtr.currentStrokeTranslateNdcX,
        vtr.currentStrokeTranslateNdcY,
        roundLimit,
        lineGradient,
      )
    }

    // #599 line-drape — capture the resolved (mpp-INDEPENDENT) stroke style so the globe drape can
    // re-pack a layer slot per baked tile with that tile's bake mpp (E/BAKE_PX). Screen-space knobs
    // (viewport_height, dpr, line-translate) are dropped in the bake; `dashSrc` stays in width units
    // and is re-scaled to metres in bakeStrokeLayerSlot. gap-width's second stroke isn't draped
    // (a rare OFM tunnel case) — it keeps its direct chord draw off the sphere only.
    const bs = vtr._bakeStroke
    bs.color = lineSlotColor
    bs.widthPx = strokeWidthPx
    bs.cap = cap
    bs.join = join
    bs.miterLimit = miterLimit
    bs.roundLimit = roundLimit
    bs.blur = args.show.strokeBlur ?? 0
    bs.dashSrc = dashSrc && dashSrc.length >= 2 ? dashSrc : null
    bs.dashOffsetUnits = args.resolvedShow.dashOffset
    bs.patternSlots = patternSlots
    bs.offset = effectiveOffset
    bs.gradient = lineGradient
    // A stroke is drape-worthy when it draws something: a resolved colour+width, or a line pattern
    // (which carries its colour in the sprite atlas, not cachedStrokeColor).
    vtr._bakeStrokeActive =
      linePatternActive || (vtr.cachedStrokeColor[3] > 0.003 && strokeWidthPx > 0)
  }
  return { lineLayerOffset, lineLayerOffsetGap }
}
