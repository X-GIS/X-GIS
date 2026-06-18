// ═══ AST → IR Lowering Pass ═══
// Converts parsed AST into the intermediate representation (Scene).
// Handles both legacy (let/show) and new (source/layer) syntax.

import type * as AST from '../parser/ast'
import { resolveColor } from '../tokens/colors'
import type { LowerOptions } from './lower-types'
import {
  bindingAsConstantNumber,
  extractMatchDefaultColor,
  extractInterpolateZoomStops,
  extractInterpolateZoomColorStops,
} from './lower-helpers'
import { lowerLabelProps } from './lower-label'
import { expandKeyframeTimeStops } from './lower-animation'
// Re-export public types so importers of './lower' keep their surface.
export type { LowerOptions, ZoomStopsWithBase } from './lower-types'
import {
  type Scene,
  type SourceDef,
  type RenderNode,
  type ColorValue,
  type SizeValue,
  type OpacityValue,
  type ZoomStop,
  type Easing,
  type ConditionalBranch,
  colorNone,
  colorConstant,
  opacityConstant,
  sizeNone,
  sizeConstant,
  shapeNone,
  hexToRgba,
  type ShapeRef,
} from './render-node'

/**
 * Lower an AST Program into an IR Scene.
 */
export function lower(program: AST.Program, options: LowerOptions = {}): Scene {
  const sources: SourceDef[] = []
  const renderNodes: RenderNode[] = []
  const symbols: import('./render-node').SymbolDef[] = []
  const diagnostics: import('./render-node').Diagnostic[] = []
  const sourceMap = new Map<string, SourceDef>()
  const presetMap = new Map<string, AST.UtilityLine[]>()
  const styleMap = new Map<string, AST.StyleProperty[]>()
  const keyframesMap = new Map<string, AST.KeyframesStatement>()

  // First pass: collect presets, styles, symbols, and keyframes. Keyframes
  // must land in the symbol table before any layer is lowered so forward
  // references like `animation-pulse` resolve regardless of declaration
  // order in the source file.
  for (const stmt of program.body) {
    if (stmt.kind === 'PresetStatement') {
      presetMap.set(stmt.name, stmt.utilities)
    } else if (stmt.kind === 'StyleStatement') {
      styleMap.set(stmt.name, stmt.properties)
    } else if (stmt.kind === 'SymbolStatement') {
      const paths: string[] = []
      for (const el of stmt.elements) {
        if (el.kind === 'path') paths.push(el.data)
      }
      if (paths.length > 0) symbols.push({ name: stmt.name, paths })
    } else if (stmt.kind === 'KeyframesStatement') {
      keyframesMap.set(stmt.name, stmt)
    }
  }

  for (const stmt of program.body) {
    switch (stmt.kind) {
      case 'PresetStatement':
      case 'StyleStatement':
      case 'KeyframesStatement':
        break // already processed in first pass
      case 'SourceStatement': {
        const src = lowerSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'LayerStatement': {
        const node = lowerLayer(stmt, sourceMap, presetMap, styleMap, keyframesMap, diagnostics, options)
        if (node) {
          // If the source was referenced but not yet added, add it
          if (!sources.find(s => s.name === node.sourceRef)) {
            const src = sourceMap.get(node.sourceRef)
            if (src) sources.push(src)
          }
          renderNodes.push(node)
        }
        break
      }
      case 'LetStatement': {
        const src = lowerLetAsSource(stmt)
        if (src) {
          sources.push(src)
          sourceMap.set(src.name, src)
        }
        break
      }
      case 'ShowStatement': {
        const node = lowerShow(stmt)
        if (node) renderNodes.push(node)
        break
      }
    }
  }

  return { sources, renderNodes, symbols, diagnostics }
}

// ═══ New syntax lowering ═══

function lowerSource(stmt: AST.SourceStatement): SourceDef | null {
  let type = 'geojson'
  let url = ''
  let layers: string[] | undefined
  let crs: string | undefined

  for (const prop of stmt.properties) {
    if (prop.name === 'type' && prop.value.kind === 'Identifier') {
      type = prop.value.name
    } else if (prop.name === 'url' && prop.value.kind === 'StringLiteral') {
      url = prop.value.value
    } else if (prop.name === 'crs') {
      if (prop.value.kind === 'StringLiteral') {
        // Constant CRS is preserved in the AST by the generic
        // parseBlockProperty (parser.ts:626) — no parser change needed.
        crs = prop.value.value
      } else {
        // Per-feature / expression-form CRS (e.g. `crs: [.srid]`) is not
        // implemented — MVP supports constant EPSG strings only.
        throw new Error(
          `Source '${stmt.name}' (line ${stmt.line}): 'crs' must be a constant ` +
          `string (e.g. "EPSG:5179"). Per-feature/expression CRS is not ` +
          `implemented — constant EPSG only is supported in this version.`,
        )
      }
    } else if (prop.name === 'layers') {
      // Accept either `layers: "water"` (single MVT layer) or
      // `layers: ["water", "roads"]` (subset). PMTiles backend uses
      // this to filter MVT features before decompose+compile so each
      // xgis layer can paint its own slice with its own style.
      if (prop.value.kind === 'StringLiteral') {
        layers = [prop.value.value]
      } else if (prop.value.kind === 'ArrayLiteral') {
        const out: string[] = []
        for (const el of prop.value.elements) {
          if (el.kind === 'StringLiteral') out.push(el.value)
        }
        if (out.length > 0) layers = out
      }
    }
  }

  // Source-level input CRS. MVT/PMTiles reprojection is out of scope —
  // a `crs` on a `type:vector` source is a hard error so it surfaces at
  // compile time instead of silently rendering tiles in the wrong place.
  if (crs && type === 'vector') {
    throw new Error(
      `Source '${stmt.name}' (line ${stmt.line}): 'crs' is not supported on ` +
      `type:vector sources — input reprojection only applies to type:geojson. ` +
      `Remove the crs property or use a geojson source.`,
    )
  }
  // GeoJSON sources default to WGS84 (EPSG:4326), i.e. a no-op
  // reprojection. Non-geojson sources without a crs leave it unset.
  const resolvedCrs = crs ?? (type === 'geojson' ? 'EPSG:4326' : undefined)

  // Inline source (no url) — runtime seeds with an empty FeatureCollection
  // and the host fills it via setSourceData / setSourcePoints.
  return { name: stmt.name, type, url, layers, crs: resolvedCrs }
}

function lowerLayer(
  stmt: AST.LayerStatement,
  sourceMap: Map<string, SourceDef>,
  presetMap: Map<string, AST.UtilityLine[]>,
  styleMap: Map<string, AST.StyleProperty[]>,
  keyframesMap: Map<string, AST.KeyframesStatement>,
  diagnostics: import('./render-node').Diagnostic[],
  options: LowerOptions,
): RenderNode | null {
  // Extract block properties
  let sourceRef = ''
  let sourceLayer: string | undefined
  let zOrder = 0
  let minzoom: number | undefined
  let maxzoom: number | undefined
  let styleRef = ''
  let filterExpr: import('../parser/ast').Expr | null = null
  let geometryExpr: import('../parser/ast').Expr | null = null
  let extrude: import('./render-node').ExtrudeValue = { kind: 'none' }
  let extrudeBase: import('./render-node').ExtrudeValue = { kind: 'none' }
  // Per-feature text label + all `label-*` / `label-icon-*` visual
  // knobs are resolved by `lowerLabelProps` (lower-label.ts) in a
  // separate utility-loop pass; the label accumulators no longer live
  // here. See lower-label.ts header for the disjointness invariant.

  for (const prop of stmt.properties) {
    if (prop.name === 'source' && prop.value.kind === 'Identifier') {
      sourceRef = prop.value.name
    } else if (prop.name === 'sourceLayer' && prop.value.kind === 'StringLiteral') {
      // sourceLayer: pick one MVT layer from a multi-layer source.
      // Mapbox-style spec uses kebab-case `source-layer`; we use
      // camelCase since the lexer doesn't accept hyphens in
      // identifiers. Semantics are the same.
      sourceLayer = prop.value.value
    } else if (prop.name === 'z-order' && prop.value.kind === 'NumberLiteral') {
      zOrder = prop.value.value
    } else if (prop.name === 'minzoom' && prop.value.kind === 'NumberLiteral') {
      // Mapbox `layer.minzoom` — layer is invisible BELOW this zoom.
      // Critical for low-zoom views: without enforcement, place
      // sub-layers (label_city minz=3, label_state minz=5, label_town
      // minz=6, label_village minz=9, label_other minz=8, all POIs
      // minz=15+) all render at z=1 simultaneously, piling every
      // OMT feature on the screen and turning the antimeridian view
      // into a stack of all-world labels. The runtime gates per-frame
      // visibility on `(camera.zoom >= minzoom) && (camera.zoom <
      // maxzoom)` via the show command.
      minzoom = prop.value.value
    } else if (prop.name === 'maxzoom' && prop.value.kind === 'NumberLiteral') {
      maxzoom = prop.value.value
    } else if (prop.name === 'style' && prop.value.kind === 'Identifier') {
      styleRef = prop.value.name
    } else if (prop.name === 'filter') {
      filterExpr = prop.value
    } else if (prop.name === 'geometry') {
      geometryExpr = prop.value
    }
  }

  if (!sourceRef) {
    diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0002',
      line: stmt.line,
      message:
        `Layer "${stmt.name}" has no \`source:\` declaration — ` +
        `the layer is dropped from the scene. Add \`source: <name>\` ` +
        `to a top-level \`source\` block.`,
    })
    return null
  }
  if (!sourceMap.has(sourceRef)) {
    const known = [...sourceMap.keys()]
    diagnostics.push({
      severity: 'warn',
      code: 'X-GIS0003',
      line: stmt.line,
      message:
        `Layer "${stmt.name}" references unknown source "${sourceRef}". ` +
        (known.length > 0
          ? `Known sources: ${known.map(k => `"${k}"`).join(', ')}. `
          : 'No sources are declared in this program. ') +
        `The layer is dropped from the scene; check for a typo or ` +
        `re-order the file so the \`source\` block precedes the \`layer\`.`,
    })
    return null
  }

  // Expand presets: apply-name → inline preset's utility items
  const expandedUtilities = expandPresets(stmt.utilities, presetMap)

  // Process utility lines
  let fill: ColorValue = colorNone()
  /** iter-177 Mapbox `paint.fill-pattern` constant sprite name. The
   *  runtime resolves this against the sprite atlas at draw time and
   *  uses the sprite's centre pixel as fill colour (Stage 1 — full
   *  UV-tiling fragment shader is Stage 2). null = no pattern. */
  let fillPattern: string | null = null
  /** iter-178 Mapbox `paint.line-pattern` constant sprite name —
   *  stroke-side mirror of fillPattern. Stage 1 samples the sprite
   *  centre pixel as the line colour; Stage 2 (real repeating-sprite
   *  stroke renderer) deferred. null = no pattern. */
  let linePattern: string | null = null
  /** Mapbox `paint.fill-translate` x — viewport pixel offset, +right.
   *  Constant form only; zoom-interp on vec2 needs per-axis decomp
   *  (deferred). 0 / undefined → no offset. */
  let fillTranslateX: number | undefined
  /** Mapbox `paint.fill-translate` y — viewport pixel offset, +down
   *  (screen-space convention; runtime negates for NDC). */
  let fillTranslateY: number | undefined
  /** Mapbox `paint.fill-antialias` / `fill-extrusion-vertical-gradient`
   *  opt-out flags. Undefined = spec default (true) = unchanged render;
   *  only the explicit `false` utility sets these. */
  let fillAntialias: boolean | undefined
  let fillExtrusionVerticalGradient: boolean | undefined
  /** Mapbox `paint.circle-translate` x/y and `circle-blur`. */
  let circleTranslateX: number | undefined
  let circleTranslateY: number | undefined
  let circleBlur: number | undefined
  /** Mapbox `paint.line-translate` x — viewport pixel offset, +right.
   *  Mirror of fillTranslateX for line layers. */
  let strokeTranslateX: number | undefined
  /** Mapbox `paint.line-translate` y — viewport pixel offset, +down. */
  let strokeTranslateY: number | undefined
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  /** Per-feature / zoom-interpolated stroke-width AST. Populated from
   *  `stroke-[<expr>]` bracket bindings when the expression is numeric
   *  (Mapbox `paint.line-width: ["interpolate", …]` or per-feature
   *  case/match). Stroke colour zoom-interpolation takes a parallel
   *  path through `strokeColor` (kind: 'zoom-interpolated'). */
  let strokeWidthExpr: import('./render-node').DataExpr | undefined
  /** Per-feature stroke-colour AST. Populated from `stroke-[<expr>]`
   *  whose binding's `extractMatchDefaultColor` returns a hex —
   *  parallel to fill's data-driven kind. Mirror of the merge-pass
   *  synthesised strokeColorExpr; the runtime line-renderer's worker
   *  evaluates this against each feature and packs RGBA8 into the
   *  segment buffer's `color_packed` slot. */
  let strokeColorExpr: import('./render-node').DataExpr | undefined
  /** Pure zoom-only stroke-width stops — populated when the binding's
   *  expression is a `interpolate(zoom, …)` / `interpolate_exp(zoom,
   *  base, …)` with no feature-prop dependency. Routed through
   *  `stroke.widthZoomStops` so the renderer recomputes width per
   *  frame from camera zoom (avoids the tile-bake staleness). */
  let strokeWidthZoomStops: ZoomStop<number>[] | undefined
  let strokeWidthZoomStopsBase: number | undefined
  let linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  let linejoin: 'miter' | 'round' | 'bevel' | undefined
  let miterlimit: number | undefined
  let dashArray: number[] | undefined
  let dashOffset: number | undefined
  let strokeOffset: number | undefined
  let strokeAlign: 'center' | 'inset' | 'outset' | undefined
  let strokeBlur: number | undefined
  /** Mapbox `line-gap-width` — px gap between the two parallel
   *  strokes that make up a "double line" casing. Constant form
   *  only at the moment; zoom-interp lands later (the converter
   *  emits the bracket form for zoom-interp but lower.ts only
   *  consumes the constant here). */
  let strokeGapWidth: number | undefined
  // Phase 4: pattern stack — up to 3 slots. Slot 0 = `stroke-pattern-*`,
  // slots 1/2 = `stroke-pattern-1-*` / `stroke-pattern-2-*`.
  const patternSlots: import('./render-node').StrokePattern[] = [
    { shape: '', spacing: 0, size: 0 },
    { shape: '', spacing: 0, size: 0 },
    { shape: '', spacing: 0, size: 0 },
  ]
  const patternDirty = [false, false, false]

  const parsePatternAttr = (rest: string, slotIdx: number): void => {
    const p = patternSlots[slotIdx]
    const unitRe = /^(-?[\d.]+)(m|px|km|nm)?$/
    if (rest.startsWith('spacing-')) {
      const m = rest.slice('spacing-'.length).match(unitRe)
      if (m) { p.spacing = parseFloat(m[1]); p.spacingUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('size-')) {
      const m = rest.slice('size-'.length).match(unitRe)
      if (m) { p.size = parseFloat(m[1]); p.sizeUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('offset-')) {
      const m = rest.slice('offset-'.length).match(unitRe)
      if (m) { p.offset = parseFloat(m[1]); p.offsetUnit = (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm'; patternDirty[slotIdx] = true }
      return
    }
    if (rest.startsWith('anchor-')) {
      const v = rest.slice('anchor-'.length)
      if (v === 'repeat' || v === 'start' || v === 'end' || v === 'center') {
        p.anchor = v; patternDirty[slotIdx] = true
      }
      return
    }
    // Fallback: treat rest as shape name
    p.shape = rest
    patternDirty[slotIdx] = true
  }
  let opacity: OpacityValue = opacityConstant(1.0)
  let size: SizeValue = sizeNone()
  let projection = 'mercator'
  let visible = true
  let pointerEvents: 'auto' | 'none' = 'auto'
  let billboard = true
  let anchor: 'center' | 'bottom' | 'top' | undefined
  let shape: ShapeRef = shapeNone()

  // Cascade order: named style → inline CSS → utilities
  // 1. Apply named style (lowest priority)
  if (styleRef) {
    const namedProps = styleMap.get(styleRef)
    if (namedProps) {
      const result = applyStyleProperties(namedProps, fill, strokeColor, strokeWidth, opacity, projection, visible)
      fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
      opacity = result.opacity; projection = result.projection; visible = result.visible
      if (result.linecap) linecap = result.linecap
      if (result.linejoin) linejoin = result.linejoin
      if (result.miterlimit !== undefined) miterlimit = result.miterlimit
      if (result.dashArray) dashArray = result.dashArray
      if (result.dashOffset !== undefined) dashOffset = result.dashOffset
      if (result.strokeOffset !== undefined) strokeOffset = result.strokeOffset
      if (result.strokeAlign !== undefined) strokeAlign = result.strokeAlign
      if (result.pattern) {
        Object.assign(patternSlots[0], result.pattern)
        patternDirty[0] = true
      }
    }
  }

  // 2. Apply inline CSS-like properties (overrides named style)
  if (stmt.styleProperties.length > 0) {
    const result = applyStyleProperties(stmt.styleProperties, fill, strokeColor, strokeWidth, opacity, projection, visible)
    fill = result.fill; strokeColor = result.strokeColor; strokeWidth = result.strokeWidth
    opacity = result.opacity; projection = result.projection; visible = result.visible
    if (result.linecap) linecap = result.linecap
    if (result.linejoin) linejoin = result.linejoin
    if (result.miterlimit !== undefined) miterlimit = result.miterlimit
    if (result.dashArray) dashArray = result.dashArray
    if (result.dashOffset !== undefined) dashOffset = result.dashOffset
    if (result.strokeOffset !== undefined) strokeOffset = result.strokeOffset
    if (result.strokeAlign !== undefined) strokeAlign = result.strokeAlign
    if (result.pattern) {
      Object.assign(patternSlots[0], result.pattern)
      patternDirty[0] = true
    }
  }

  // Collectors for modifier-based values
  const fillBranches: ConditionalBranch<ColorValue>[] = []
  const opacityZoomStops: ZoomStop<number>[] = []
  const sizeZoomStops: ZoomStop<number>[] = []
  // Mapbox `["interpolate", ["exponential", N], …]` base — preserved
  // here so the runtime applies the same accelerated curve Mapbox
  // does. 1 (the default) is mathematically linear; OFM Bright's
  // 65 road-width interpolations sit between 1.3 and 1.5.
  let opacityZoomStopsBase: number | undefined
  let sizeZoomStopsBase: number | undefined

  // Animation metadata. Collected from top-level utilities like
  // `animation-pulse duration-1500 ease-in-out infinite delay-200` on the
  // layer's utility line. The actual keyframe expansion happens once after
  // the utility loop completes, so the order of `animation-*` vs
  // `duration-*` on the same line doesn't matter.
  let animationName: string | null = null
  let animationDurationMs = 1000
  let animationEasing: Easing = 'linear'
  let animationDelayMs = 0
  let animationLoop = false

  for (const line of expandedUtilities) {
    for (const item of line.items) {
      const name = item.name
      const mod = item.modifier

      // ── Modifier items ──
      if (mod) {
        // STRICT: detect the deprecated `z<N>:` zoom-modifier shape.
        // Until f2f8929 this meant "apply at zoom N"; afterwards `z8`
        // is just an identifier the lower pass treats as a feature-
        // property predicate, which silently always-fails on real
        // data. We fail loud here so the issue surfaces in CI / on
        // the /convert page instead of producing wrong output.
        if (/^z\d+$/.test(mod)) {
          const zoomLevel = mod.slice(1)
          diagnostics.push({
            severity: 'warn',
            code: 'X-GIS0001',
            line: stmt.line,
            message:
              `Deprecated zoom modifier "${mod}:" — replaced by ` +
              `\`<utility>-[interpolate(zoom, …)]\`. e.g. ` +
              `\`${mod}:opacity-40\` → ` +
              `\`opacity-[interpolate(zoom, ${zoomLevel}, 40)]\`. ` +
              `Without the migration, the modifier is treated as a ` +
              `feature-property predicate (\`feat.${mod}\`), is ` +
              `always falsy on real data, and the utility never applies.`,
          })
          continue
        }
        // Data modifier: friendly:fill-green-500
        // (Zoom-driven values used to live behind `zN:opacity-…`
        // modifiers; they're now expressed as `opacity-[interpolate(
        // zoom, …)]` and lowered below in the binding handler.)
        if (name.startsWith('fill-')) {
          const hex = resolveColor(name.slice(5))
          if (hex) {
            fillBranches.push({ field: mod, value: colorConstant(...hexToRgba(hex)) })
          }
        }
        continue
      }

      // ── Unmodified items ──

      // Data binding: fill-[expr], size-[expr], opacity-[expr],
      // fill-extrusion-height-[expr], fill-extrusion-base-[expr].
      // Zoom-driven path: an `interpolate(zoom, k1, v1, k2, v2, …)`
      // call with all-numeric stops lowers to the existing
      // ZoomStop<number>[] mechanism for opacity / size. Other
      // utilities and non-numeric stops fall through to the generic
      // data-driven branch (the runtime evaluator handles `zoom`
      // and `interpolate` as builtins).
      if (item.binding) {
        const zoomStops = extractInterpolateZoomStops(item.binding)
        if (zoomStops && name === 'opacity') {
          for (const s of zoomStops.stops) {
            opacityZoomStops.push({
              zoom: s.zoom,
              // opacity-<N> is the 0..100 scale; divide always (the old
              // `<=1?:/100` heuristic mis-read opacity-1 = Mapbox 0.01 as 1.0).
              value: s.value / 100,
            })
          }
          if (zoomStops.base !== 1) opacityZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'size') {
          for (const s of zoomStops.stops) sizeZoomStops.push({ zoom: s.zoom, value: s.value })
          if (zoomStops.base !== 1) sizeZoomStopsBase = zoomStops.base
          continue
        }
        if (zoomStops && name === 'stroke-gap') {
          // Mapbox `line-gap-width` zoom-interp. Full per-frame
          // resolve is the right path (needs StrokeValue.gapWidth →
          // PropertyShape<number>); not yet wired. Use last-stop
          // approximation — same pattern as iter 508's fill-translate
          // and iter 488's text-opacity zoom-interp drops. OFM Liberty
          // waterway_tunnel stops at z=12 (0) → z=20 (6); last stop
          // = 6 px so the runtime renders the double-line at full
          // intended gap at the highest zoom; lower zooms render
          // wider-than-spec but the visual is close.
          const last = zoomStops.stops[zoomStops.stops.length - 1]
          if (last && last.value > 0) strokeGapWidth = last.value
          continue
        }
        // ── label-* / label-icon-* binding arms moved to lowerLabelProps
        //    (lower-label.ts). The second pass there owns the label/icon
        //    zoom-stops, exprs, text, and negative-numeric label arms.
        if (name === 'fill') {
          // Mapbox `paint.fill-color: ["interpolate", curve, ["zoom"], …]`
          // converts to `fill-[interpolate(zoom, z1, #hex, …)]`. The
          // converter emits hex literals at each stop; we extract them
          // into the zoom-interpolated ColorValue here. The runtime
          // (renderer.ts:render-loop) reads `zoomFillStops` if present
          // and recomputes the fill RGBA per frame from the camera
          // zoom. PR #97's earlier "last-stop only" heuristic collapsed
          // landuse-suburb to alpha=0 (Mapbox intentionally fades it
          // out at z=10) — every suburb polygon rendered invisible
          // regardless of viewing zoom; full preservation prevents
          // that regression class.
          const colorInterp = extractInterpolateZoomColorStops(item.binding)
          if (colorInterp && colorInterp.stops.length > 0) {
            const rgbaStops: ZoomStop<[number, number, number, number]>[] = []
            for (const s of colorInterp.stops) {
              const hex = resolveColor(s.value)
              if (hex) rgbaStops.push({ zoom: s.zoom, value: hexToRgba(hex) })
            }
            if (rgbaStops.length > 0) {
              fill = colorInterp.base !== 1
                ? { kind: 'zoom-interpolated', stops: rgbaStops, base: colorInterp.base }
                : { kind: 'zoom-interpolated', stops: rgbaStops }
              continue
            }
          }
          // Per-feature `match(.field) { …, _ -> #color }` (Mapbox
          // `["match", ["get", "X"], …, default]`). Extract the
          // default arm as a constant fallback fill so the polygon
          // renders SOMETHING — without this, every country in the
          // MapLibre demo's `countries-fill` rendered as no-fill.
          // Per-feature distinct colours (the country-by-country
          // palette) await a `fillExpr` plumbing PR that threads the
          // full AST through ShowCommand for the worker to evaluate
          // per feature, mirroring the existing strokeColorExpr path.
          // The default-arm collapse is gated by
          // `LowerOptions.bypassExtractMatchDefaultColor` — when true
          // (P4 runtime opt-in), match() falls through to data-driven
          // even when an explicit `_` arm exists. The compute path
          // then evaluates every arm GPU-side.
          if (!options.bypassExtractMatchDefaultColor) {
            const defaultHex = extractMatchDefaultColor(item.binding)
            if (defaultHex) {
              const rgba = hexToRgba(defaultHex)
              fill = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
              continue
            }
          }
          fill = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'stroke') {
          // `stroke-[<expr>]` carries either a colour expression (Mapbox
          // `paint.line-color: ["interpolate", …]`) or a width
          // expression (`paint.line-width: ["interpolate", …]`). The
          // converter emits the same shape for both because the
          // utility-name grammar can't tell them apart at the lex
          // stage. Disambiguate by inspecting the lowered expression:
          //   - `interpolate(zoom, z, color, …)`  → colour stops
          //   - `interpolate_exp(zoom, base, z, n, …)` → numeric stops
          //   - everything else → per-feature `widthExpr` (numeric
          //     case/match dominate; per-feature colour-only goes
          //     through `colorExpr` once that path lands).
          // Pre-fix this whole branch was missing — every OFM Bright
          // road's `stroke-[interpolate_exp(…)]` width silently
          // collapsed to the default 1 px, so the entire highway
          // network rendered as hair-thin lines.
          const colorInterp = extractInterpolateZoomColorStops(item.binding)
          if (colorInterp && colorInterp.stops.length > 0) {
            // Last stop is the constant fallback. ColorValue doesn't
            // (yet) have a `zoom-interpolated` variant for stroke; a
            // proper per-frame stroke colour update path is parallel
            // to the fill follow-up (see `name === 'fill'` arm).
            // For now picking the highest-zoom colour gives the right
            // appearance at typical viewing zoom and prevents the
            // silent null-stroke drop. (base would land here once
            // stroke-color gets the per-frame interp path.)
            const last = colorInterp.stops[colorInterp.stops.length - 1]!
            const hex = resolveColor(last.value)
            if (hex) {
              const rgba = hexToRgba(hex)
              strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
            }
          } else {
            // Disambiguate WIDTH vs COLOUR expression. Numeric zoom
            // stops (`interpolate_exp(zoom, base, z, n, …)` or
            // `interpolate(zoom, z, n, …)`) take the width path. A
            // colour-valued `match(.field) { v -> #rrggbb, …, _ ->
            // #default }` (Mapbox `paint.line-color: ["match", …]`)
            // walks the default-arm color extractor — if it yields a
            // hex, the binding is colour-shaped → route through the
            // strokeColorExpr field (mirror of the fill data-driven
            // arm above) so the runtime can evaluate per feature via
            // the line segment buffer's color_packed slot. Without
            // this branch a standalone data-driven stroke colour fell
            // straight through to `strokeWidthExpr`, the layer gained
            // no resolved colour, and dead-layer-elim dropped it.
            const widthStops = extractInterpolateZoomStops(item.binding)
            if (widthStops) {
              // Pure zoom-only width — hoist as zoom stops on the
              // stroke value. The renderer recomputes `layer.width_px`
              // per frame from camera.zoom, so the line widens
              // continuously as the user zooms (vs. the widthExpr
              // path which bakes a single width per tile at decode
              // time and only updates on tile-zoom boundary crosses).
              strokeWidthZoomStops = widthStops.stops
              strokeWidthZoomStopsBase = widthStops.base
            } else {
              const defaultHex = extractMatchDefaultColor(item.binding)
              if (defaultHex) {
                // Colour-shaped per-feature expression. Bake the
                // default arm as a constant fallback (so the layer
                // renders SOMETHING even before the per-feature
                // packer runs) and stash the full AST in
                // strokeColorExpr. Mirror of merge-layers' synthetic
                // strokeColorExpr emission.
                const rgba = hexToRgba(defaultHex)
                strokeColor = colorConstant(rgba[0], rgba[1], rgba[2], rgba[3])
                strokeColorExpr = { ast: item.binding }
              } else {
                // Per-feature `case` / `match` expression on width.
                strokeWidthExpr = { ast: item.binding }
              }
            }
          }
        } else if (name === 'size') {
          size = { kind: 'data-driven', expr: { ast: item.binding }, unit: item.bindingUnit ?? null }
        } else if (name === 'opacity') {
          opacity = { kind: 'data-driven', expr: { ast: item.binding } }
        } else if (name === 'fill-extrusion-height') {
          extrude = { kind: 'feature', expr: { ast: item.binding }, fallback: 0 }
        } else if (name === 'fill-extrusion-base') {
          extrudeBase = { kind: 'feature', expr: { ast: item.binding }, fallback: 0 }
        } else if (name === 'label' || name === 'label-icon-image' || name.startsWith('label-')) {
          // All `label-*` / `label-icon-*` binding items (text, icon-image,
          // and the negative-numeric label arms) are owned by
          // lowerLabelProps (lower-label.ts) in its own pass. Skip them
          // here so they never reach the X-GIS0005 catch-all below.
        } else {
          // Numeric paint utilities that allow negative values use
          // bracket-binding form since the utility-name grammar treats
          // `-` as a segment separator. We only accept literal-number
          // (or unary-minus literal) bindings here.
          const n = bindingAsConstantNumber(item.binding)
          if (n !== null) {
            if (name === 'fill-translate-x') { fillTranslateX = n; continue }
            if (name === 'fill-translate-y') { fillTranslateY = n; continue }
            if (name === 'circle-translate-x') { circleTranslateX = n; continue }
            if (name === 'circle-translate-y') { circleTranslateY = n; continue }
            if (name === 'circle-blur') { circleBlur = n; continue }
            if (name === 'stroke-translate-x') { strokeTranslateX = n; continue }
            if (name === 'stroke-translate-y') { strokeTranslateY = n; continue }
          }
          // Bracket-binding form with a name that's not in any of the
          // handled arms above. Pre-fix this was the silent-drop hole that
          // hid the `stroke-[interpolate_exp(zoom, …)]` regression — a
          // `name: "stroke"` binding falls through every named handler
          // and gets dropped without a peep, so every Mapbox
          // `paint.line-width: ["interpolate", …]` reverted to a 1 px
          // hairline. Surface every unhandled binding as a warn-level
          // diagnostic so the next regression of this shape fails CI
          // instead of shipping silently.
          diagnostics.push({
            severity: 'warn',
            code: 'X-GIS0005',
            line: stmt.line,
            message:
              `Bracket-binding utility "${name}-[…]" has no handler in lower.ts — ` +
              `the expression is being dropped. Add a name==="${name}" arm in the ` +
              `binding-form handler to thread the value into the appropriate IR field.`,
          })
        }
        continue
      }

      // ── label-* / label-icon-* visual knob utilities ──
      // All resolved by lowerLabelProps (lower-label.ts) in its own
      // pass. The two PAINT `fill-translate-*` numeric arms that used to
      // sit interleaved with the label arms stay here.
      if (name.startsWith('fill-translate-x-')) {
        // Mapbox `paint.fill-translate` x component in CSS pixels.
        // Bracket-wrap form for negatives (`fill-translate-x-[-2]`)
        // is handled by the bracket binding parser above. Plain
        // numeric form lands here.
        const num = parseFloat(name.slice('fill-translate-x-'.length))
        if (!isNaN(num)) fillTranslateX = num
        continue
      }
      if (name.startsWith('fill-translate-y-')) {
        const num = parseFloat(name.slice('fill-translate-y-'.length))
        if (!isNaN(num)) fillTranslateY = num
        continue
      }
      // Mapbox `paint.fill-antialias: false` opt-out — single-token
      // utility (only the false case is emitted by the converter).
      if (name === 'fill-antialias-false') { fillAntialias = false; continue }
      // Mapbox `paint.fill-extrusion-vertical-gradient: false` opt-out.
      if (name === 'fill-extrusion-vertical-gradient-false') { fillExtrusionVerticalGradient = false; continue }
      if (name.startsWith('circle-translate-x-')) {
        const num = parseFloat(name.slice('circle-translate-x-'.length))
        if (!isNaN(num)) circleTranslateX = num
        continue
      }
      if (name.startsWith('circle-translate-y-')) {
        const num = parseFloat(name.slice('circle-translate-y-'.length))
        if (!isNaN(num)) circleTranslateY = num
        continue
      }
      if (name.startsWith('circle-blur-')) {
        const num = parseFloat(name.slice('circle-blur-'.length))
        if (!isNaN(num)) circleBlur = num
        continue
      }
      if (name.startsWith('stroke-translate-x-')) {
        const num = parseFloat(name.slice('stroke-translate-x-'.length))
        if (!isNaN(num)) strokeTranslateX = num
        continue
      }
      if (name.startsWith('stroke-translate-y-')) {
        const num = parseFloat(name.slice('stroke-translate-y-'.length))
        if (!isNaN(num)) strokeTranslateY = num
        continue
      }
      // ── label-* / label-icon-* constant + X-GIS0006 catch-all moved
      //    to lowerLabelProps (lower-label.ts). Any constant `label-*`
      //    utility is owned by that pass; skip it here so it never trips
      //    a paint arm or the X-GIS0005 net below.
      if (name.startsWith('label-')) continue

      if (name.startsWith('fill-extrusion-height-')) {
        // Mapbox `fill-extrusion-height` paint property as a tailwind-
        // shaped utility. Value is a static metres count; data-driven
        // form is handled higher up via the `-[expr]` binding branch.
        const num = parseFloat(name.slice('fill-extrusion-height-'.length))
        if (!isNaN(num)) extrude = { kind: 'constant', value: num }
      } else if (name.startsWith('fill-extrusion-base-')) {
        // Mapbox `fill-extrusion-base` paint property — z of the
        // wall BOTTOM (default 0). Combined with the height utility
        // it carves out a `min_height`-style podium for tall
        // buildings. Static-value form; data-driven goes through
        // the `-[expr]` branch above.
        const num = parseFloat(name.slice('fill-extrusion-base-'.length))
        if (!isNaN(num)) extrudeBase = { kind: 'constant', value: num }
      } else if (name.startsWith('fill-pattern-')) {
        // iter-177 Mapbox `fill-pattern` Stage 1. Sprite name segment
        // after `fill-pattern-`; the runtime samples that sprite's
        // centre pixel for the layer fill colour. Must precede the
        // generic `fill-<color>` branch below.
        const sprite = name.slice('fill-pattern-'.length)
        if (sprite.length > 0) fillPattern = sprite
      } else if (name.startsWith('fill-')) {
        const hex = resolveColor(name.slice(5))
        if (hex) fill = colorConstant(...hexToRgba(hex))
      } else if (name === 'stroke-butt-cap') {
        linecap = 'butt'
      } else if (name === 'stroke-round-cap') {
        linecap = 'round'
      } else if (name === 'stroke-square-cap') {
        linecap = 'square'
      } else if (name === 'stroke-arrow-cap') {
        linecap = 'arrow'
      } else if (name === 'stroke-miter-join') {
        linejoin = 'miter'
      } else if (name === 'stroke-round-join') {
        linejoin = 'round'
      } else if (name === 'stroke-bevel-join') {
        linejoin = 'bevel'
      } else if (name.startsWith('stroke-miterlimit-')) {
        const num = parseFloat(name.slice('stroke-miterlimit-'.length))
        if (!isNaN(num)) miterlimit = num
      } else if (name.startsWith('stroke-dasharray-')) {
        // e.g. stroke-dasharray-10-5 or stroke-dasharray-6-2-1-2.
        // The lexer splits `20_10` into Number + Identifier which breaks
        // the utility-name accumulator — hyphen is the only separator that
        // stays inside a single utility token via parseUtilityName.
        const parts = name.slice('stroke-dasharray-'.length).split('-')
        const nums = parts.map(parseFloat).filter(n => !isNaN(n))
        if (nums.length >= 2) dashArray = nums
      } else if (name.startsWith('stroke-dashoffset-')) {
        const num = parseFloat(name.slice('stroke-dashoffset-'.length))
        if (!isNaN(num)) dashOffset = num
      } else if (name === 'stroke-inset') {
        // GDI+-style alignment: shift the centerline inward by half the
        // stroke width so the stroke sits entirely on the left of travel.
        // Resolved at runtime against the current strokeWidth.
        strokeAlign = 'inset'
      } else if (name === 'stroke-outset') {
        strokeAlign = 'outset'
      } else if (name === 'stroke-center') {
        strokeAlign = 'center'
      } else if (name.startsWith('stroke-offset-right-')) {
        // Right-hand parallel offset: same magnitude, negative sign convention.
        const num = parseFloat(name.slice('stroke-offset-right-'.length))
        if (!isNaN(num)) strokeOffset = -num
      } else if (name.startsWith('stroke-offset-left-')) {
        const num = parseFloat(name.slice('stroke-offset-left-'.length))
        if (!isNaN(num)) strokeOffset = num
      } else if (name.startsWith('stroke-offset-')) {
        // Bare stroke-offset-N → positive (left of travel) by default.
        const num = parseFloat(name.slice('stroke-offset-'.length))
        if (!isNaN(num)) strokeOffset = num
      } else if (name.startsWith('stroke-pattern-1-')) {
        parsePatternAttr(name.slice('stroke-pattern-1-'.length), 1)
      } else if (name.startsWith('stroke-pattern-2-')) {
        parsePatternAttr(name.slice('stroke-pattern-2-'.length), 2)
      } else if (name.startsWith('stroke-pattern-')) {
        parsePatternAttr(name.slice('stroke-pattern-'.length), 0)
      } else if (name.startsWith('stroke-blur-')) {
        // Mapbox `paint.line-blur` — edge feathering in CSS px.
        const num = parseFloat(name.slice('stroke-blur-'.length))
        if (!isNaN(num)) strokeBlur = num
      } else if (name.startsWith('stroke-gap-')) {
        // Mapbox `paint.line-gap-width` — px gap between two parallel
        // strokes that make up a "double line" casing. Constant form
        // here; zoom-interp emits the bracket binding form which is
        // currently dropped (lower.ts has no binding-form arm for it).
        const num = parseFloat(name.slice('stroke-gap-'.length))
        if (!isNaN(num) && num > 0) strokeGapWidth = num
      } else if (name.startsWith('stroke-image-')) {
        // iter-178 Mapbox `line-pattern` Stage 1 → linePattern. Uses the
        // DISTINCT `stroke-image-` namespace (NOT `stroke-pattern-`, which the
        // native SDF dash arms above own, else the sprite is mis-routed into
        // the dash path). Must precede the generic `stroke-` branch below.
        const sprite = name.slice('stroke-image-'.length)
        if (sprite.length > 0) linePattern = sprite
      } else if (name.startsWith('stroke-')) {
        const rest = name.slice(7)
        const num = parseFloat(rest)
        if (!isNaN(num) && rest === String(num)) {
          strokeWidth = num
        } else {
          const hex = resolveColor(rest)
          if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        }
      } else if (name.startsWith('opacity-')) {
        const num = parseFloat(name.slice(8))
        if (!isNaN(num)) {
          const val = num / 100 // 0..100 scale (see opacity zoom-stop arm)
          opacity = opacityConstant(val)
        }
      } else if (name.startsWith('size-')) {
        const sizeStr = name.slice(5)
        const unitMatch = sizeStr.match(/^([\d.]+)(px|m|km|nm|deg)?$/)
        if (unitMatch) {
          const num = parseFloat(unitMatch[1])
          const unit = unitMatch[2] || null  // null = px default
          if (!isNaN(num)) size = sizeConstant(num, unit)
        }
      } else if (name.startsWith('projection-')) {
        projection = name.slice(11)
      } else if (name === 'hidden') {
        visible = false
      } else if (name === 'flat') {
        billboard = false
      } else if (name === 'billboard') {
        billboard = true
      } else if (name === 'anchor-center') {
        anchor = 'center'
      } else if (name === 'anchor-bottom') {
        anchor = 'bottom'
      } else if (name === 'anchor-top') {
        anchor = 'top'
      } else if (name.startsWith('shape-')) {
        const shapeName = name.slice(6)
        if (item.binding) {
          shape = { kind: 'data-driven', expr: { ast: item.binding } }
        } else {
          shape = { kind: 'named', name: shapeName }
        }
      } else if (name === 'visible') {
        visible = true
      } else if (name === 'pointer-events-none') {
        pointerEvents = 'none'
      } else if (name === 'pointer-events-auto') {
        pointerEvents = 'auto'
      } else if (name.startsWith('animation-')) {
        // All animation-related utilities carry the `animation-` prefix so
        // they're visually grouped and can't collide with non-animation
        // modifiers. The sub-prefix discriminator decides whether this is
        // a lifecycle setting or a keyframes reference:
        //
        //   animation-duration-<ms>   → duration in milliseconds
        //   animation-delay-<ms>      → delay in ms (negative allowed)
        //   animation-ease-{linear|in|out|in-out}
        //                             → easing function
        //   animation-infinite        → loop forever (PR 2 will add
        //                               animation-iteration-<N> for finite)
        //   animation-<anything else> → keyframes reference by name
        //
        // This means `duration`, `delay`, `ease-*`, and `infinite` are
        // reserved as keyframes names — using them in `keyframes <name>`
        // makes them unreachable here.
        const rest = name.slice('animation-'.length)
        if (rest.startsWith('duration-')) {
          const num = parseFloat(rest.slice('duration-'.length))
          if (!isNaN(num)) animationDurationMs = num
        } else if (rest.startsWith('delay-')) {
          const num = parseFloat(rest.slice('delay-'.length))
          if (!isNaN(num)) animationDelayMs = num
        } else if (rest === 'ease-linear') {
          animationEasing = 'linear'
        } else if (rest === 'ease-in') {
          animationEasing = 'ease-in'
        } else if (rest === 'ease-out') {
          animationEasing = 'ease-out'
        } else if (rest === 'ease-in-out') {
          animationEasing = 'ease-in-out'
        } else if (rest === 'infinite') {
          animationLoop = true
        } else {
          animationName = rest
        }
      }
    }
  }

  // Expand referenced keyframes into per-property time stops. Pure
  // sub-pass (lower-animation.ts): reads only the animation meta set in
  // the loop above + the keyframes table, returns the six time-stop
  // arrays consumed by the promotion block below. The call stays here —
  // AFTER the utility loop (so animationName/Duration are set) and
  // BEFORE the promotion (DO-NOT-SPLIT #2).
  const { opacityTimeStops, fillTimeStops, strokeColorTimeStops,
          strokeWidthTimeStops, sizeTimeStops, dashOffsetTimeStops }
    = expandKeyframeTimeStops(animationName, animationDurationMs, keyframesMap, stmt.name, stmt.line)

  // Build conditional fill if branches exist
  if (fillBranches.length > 0) {
    fill = { kind: 'conditional', branches: fillBranches, fallback: fill }
  }

  // Build opacity — may be zoom-interpolated, time-interpolated, or a
  // zoom-time hybrid when a layer carries BOTH `z<N>:opacity-*` and
  // `animation-*`. The runtime composes the two multiplicatively.
  if (opacityTimeStops.length > 0) {
    opacityTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    if (opacityZoomStops.length > 0) {
      opacityZoomStops.sort((a, b) => a.zoom - b.zoom)
      opacity = {
        kind: 'zoom-time',
        zoomStops: opacityZoomStops,
        timeStops: opacityTimeStops,
        loop: animationLoop,
        easing: animationEasing,
        delayMs: animationDelayMs,
      }
    } else {
      opacity = {
        kind: 'time-interpolated',
        stops: opacityTimeStops,
        loop: animationLoop,
        easing: animationEasing,
        delayMs: animationDelayMs,
      }
    }
  } else if (opacityZoomStops.length > 0) {
    opacityZoomStops.sort((a, b) => a.zoom - b.zoom)
    opacity = {
      kind: 'zoom-interpolated',
      stops: opacityZoomStops,
      ...(opacityZoomStopsBase !== undefined ? { base: opacityZoomStopsBase } : {}),
    }
  }

  // ── PR 3: build animated fill/stroke/width/size/dashOffset ──
  //
  // Each list is only promoted if the keyframe block actually set the
  // corresponding property at ≥2 frames. A single stop wouldn't animate
  // anything — we'd just hold that value forever — so that case
  // degenerates to a constant and we skip the promotion.

  if (fillTimeStops.length >= 2) {
    fillTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    // `base` is the fill color the layer had before keyframes touched
    // it, so pre-animation frames still look right. If the layer had no
    // explicit fill, fall back to the first stop's value.
    const baseRgba: import('./property-types').RGBA =
      fill.kind === 'constant' ? fill.rgba : fillTimeStops[0].value
    fill = {
      kind: 'time-interpolated',
      base: baseRgba,
      stops: fillTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
    }
  }

  if (strokeColorTimeStops.length >= 2) {
    strokeColorTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    const baseRgba: import('./property-types').RGBA =
      strokeColor.kind === 'constant' ? strokeColor.rgba : strokeColorTimeStops[0].value
    strokeColor = {
      kind: 'time-interpolated',
      base: baseRgba,
      stops: strokeColorTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
    }
  }

  // Width / dashOffset live as parallel time stop lists on StrokeValue,
  // stamped after the stroke object is built below. We hold them in
  // outer-scope let variables here and read them below.
  if (strokeWidthTimeStops.length >= 2) {
    strokeWidthTimeStops.sort((a, b) => a.timeMs - b.timeMs)
  }
  if (dashOffsetTimeStops.length >= 2) {
    dashOffsetTimeStops.sort((a, b) => a.timeMs - b.timeMs)
  }

  if (sizeTimeStops.length >= 2) {
    sizeTimeStops.sort((a, b) => a.timeMs - b.timeMs)
    const baseUnit =
      (size.kind === 'constant' || size.kind === 'data-driven') ? (size.unit ?? null) : null
    size = {
      kind: 'time-interpolated',
      stops: sizeTimeStops,
      loop: animationLoop,
      easing: animationEasing,
      delayMs: animationDelayMs,
      unit: baseUnit,
    }
  }

  // Build zoom-interpolated size if stops exist
  if (sizeZoomStops.length > 0) {
    sizeZoomStops.sort((a, b) => a.zoom - b.zoom)
    size = {
      kind: 'zoom-interpolated',
      stops: sizeZoomStops,
      ...(sizeZoomStopsBase !== undefined ? { base: sizeZoomStopsBase } : {}),
    }
  }

  return {
    name: stmt.name,
    sourceRef,
    sourceLayer,
    zOrder,
    minzoom,
    maxzoom,
    fill,
    stroke: (() => {
      const validPatterns = patternSlots.filter((p, i) =>
        patternDirty[i] && p.shape && p.size > 0 && (p.spacing > 0 || p.anchor !== 'repeat' && p.anchor !== undefined)
      )
      // Resolve the three local accumulators into a single
      // discriminated union. Priority — per-feature AST wins over
      // zoom stops, which win over the static constant — mirrors the
      // runtime resolution order (worker bake > per-frame stops >
      // layer uniform).
      let widthSource: import('./render-node').StrokeWidthValue
      if (strokeWidthExpr !== undefined) {
        widthSource = { kind: 'data-driven', expr: strokeWidthExpr }
      } else if (strokeWidthZoomStops !== undefined && strokeWidthZoomStops.length > 0) {
        widthSource = strokeWidthZoomStopsBase !== undefined
          ? { kind: 'zoom-interpolated', stops: strokeWidthZoomStops, base: strokeWidthZoomStopsBase }
          : { kind: 'zoom-interpolated', stops: strokeWidthZoomStops }
      } else {
        widthSource = { kind: 'constant', value: strokeWidth }
      }
      return {
        color: strokeColor,
        width: widthSource,
        ...(strokeColorExpr !== undefined ? { colorExpr: strokeColorExpr } : {}),
        linecap, linejoin, miterlimit,
        dashArray, dashOffset,
        patterns: validPatterns.length > 0 ? validPatterns : undefined,
        offset: strokeOffset,
        // Polygon fill-STROKE (layer has BOTH fill + stroke) defaults to INSET:
        // a thick outline sits inside the fill (CSS border-box), fill silhouette
        // unchanged — not CENTER straddling + eating ~half-width of the fill.
        // Explicit stroke-align wins; lines (no fill) keep runtime center.
        align: strokeAlign ?? (fill !== undefined && strokeColor !== undefined ? 'inset' : undefined),
        blur: strokeBlur,
        gapWidth: strokeGapWidth,
        timeWidthStops: strokeWidthTimeStops.length >= 2 ? strokeWidthTimeStops : undefined,
        timeDashOffsetStops: dashOffsetTimeStops.length >= 2 ? dashOffsetTimeStops : undefined,
      }
    })(),
    animationMeta: animationName
      ? { loop: animationLoop, easing: animationEasing, delayMs: animationDelayMs }
      : undefined,
    opacity,
    size,
    projection,
    visible,
    pointerEvents,
    filter: filterExpr ? { ast: filterExpr } : null,
    geometry: geometryExpr ? { ast: geometryExpr } : null,
    billboard,
    shape,
    anchor,
    extrude,
    extrudeBase,
    fillTranslateX,
    fillTranslateY,
    fillAntialias,
    fillExtrusionVerticalGradient,
    circleTranslateX,
    circleTranslateY,
    circleBlur,
    strokeTranslateX,
    strokeTranslateY,
    fillPattern: fillPattern ?? undefined,
    linePattern: linePattern ?? undefined,
    label: lowerLabelProps(expandedUtilities, diagnostics, stmt.line),
  }
}


/**
 * Apply CSS-like style properties to rendering values.
 * Resolves color names (via Tailwind palette), hex colors, and numbers.
 */
function applyStyleProperties(
  props: AST.StyleProperty[],
  fill: ColorValue,
  strokeColor: ColorValue,
  strokeWidth: number,
  opacity: OpacityValue,
  projection: string,
  visible: boolean,
): {
  fill: ColorValue
  strokeColor: ColorValue
  strokeWidth: number
  opacity: OpacityValue
  projection: string
  visible: boolean
  linecap?: 'butt' | 'round' | 'square' | 'arrow'
  linejoin?: 'miter' | 'round' | 'bevel'
  miterlimit?: number
  dashArray?: number[]
  dashOffset?: number
  strokeOffset?: number
  strokeAlign?: 'center' | 'inset' | 'outset'
  pattern?: import('./render-node').StrokePattern
} {
  let linecap: 'butt' | 'round' | 'square' | 'arrow' | undefined
  let linejoin: 'miter' | 'round' | 'bevel' | undefined
  let miterlimit: number | undefined
  let dashArray: number[] | undefined
  let dashOffset: number | undefined
  let strokeOffset: number | undefined
  let strokeAlign: 'center' | 'inset' | 'outset' | undefined
  const pattern: import('./render-node').StrokePattern = { shape: '', spacing: 0, size: 0 }
  let patternDirtyCss = false
  const parseCssUnitValue = (v: string): { num: number; unit: 'm' | 'px' | 'km' | 'nm' } | null => {
    const m = v.trim().match(/^(-?[\d.]+)\s*(m|px|km|nm)?$/)
    if (!m) return null
    return { num: parseFloat(m[1]), unit: (m[2] as 'm' | 'px' | 'km' | 'nm' | undefined) ?? 'm' }
  }
  for (const prop of props) {
    switch (prop.name) {
      case 'fill': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) fill = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke': {
        const hex = resolveColor(prop.value) ?? (prop.value.startsWith('#') ? prop.value : null)
        if (hex) strokeColor = colorConstant(...hexToRgba(hex))
        break
      }
      case 'stroke-width': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) strokeWidth = num
        break
      }
      case 'stroke-linecap': {
        const v = prop.value
        if (v === 'butt' || v === 'round' || v === 'square' || v === 'arrow') linecap = v
        break
      }
      case 'stroke-linejoin': {
        const v = prop.value
        if (v === 'miter' || v === 'round' || v === 'bevel') linejoin = v
        break
      }
      case 'stroke-miterlimit': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) miterlimit = num
        break
      }
      case 'stroke-dasharray': {
        // "10 5" or "6 2 1 2" — whitespace or comma separated
        const nums = prop.value.split(/[\s,]+/).map(parseFloat).filter(n => !isNaN(n))
        if (nums.length >= 2) dashArray = nums
        break
      }
      case 'stroke-dashoffset': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) dashOffset = num
        break
      }
      case 'stroke-offset': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) strokeOffset = num
        break
      }
      case 'stroke-align':
      case 'stroke-alignment': {
        const v = prop.value.trim()
        if (v === 'center' || v === 'inset' || v === 'outset') strokeAlign = v
        break
      }
      case 'stroke-pattern': {
        pattern.shape = prop.value.trim()
        patternDirtyCss = true
        break
      }
      case 'stroke-pattern-spacing': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.spacing = pv.num; pattern.spacingUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-size': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.size = pv.num; pattern.sizeUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-offset': {
        const pv = parseCssUnitValue(prop.value)
        if (pv) { pattern.offset = pv.num; pattern.offsetUnit = pv.unit; patternDirtyCss = true }
        break
      }
      case 'stroke-pattern-anchor': {
        const v = prop.value.trim()
        if (v === 'repeat' || v === 'start' || v === 'end' || v === 'center') {
          pattern.anchor = v; patternDirtyCss = true
        }
        break
      }
      case 'opacity': {
        const num = parseFloat(prop.value)
        if (!isNaN(num)) opacity = opacityConstant(num <= 1 ? num : num / 100)
        break
      }
      case 'size': {
        break
      }
      case 'projection': {
        projection = prop.value
        break
      }
      case 'visible': {
        visible = prop.value === 'true'
        break
      }
    }
  }
  return {
    fill, strokeColor, strokeWidth, opacity, projection, visible,
    linecap, linejoin, miterlimit, dashArray, dashOffset, strokeOffset, strokeAlign,
    pattern: patternDirtyCss && pattern.shape && pattern.size > 0 && (pattern.spacing > 0 || pattern.anchor) ? pattern : undefined,
  }
}

/**
 * Expand apply-presetName items by inlining the preset's utility lines.
 * Preset items come first (lower priority), layer items come after (override).
 */
function expandPresets(
  utilities: AST.UtilityLine[],
  presetMap: Map<string, AST.UtilityLine[]>,
): AST.UtilityLine[] {
  const result: AST.UtilityLine[] = []

  for (const line of utilities) {
    const expandedItems: AST.UtilityItem[] = []

    for (const item of line.items) {
      if (item.name.startsWith('apply-') && !item.modifier) {
        const presetName = item.name.slice(6)
        const preset = presetMap.get(presetName)
        if (preset) {
          // Inline preset lines before current line's remaining items
          result.push(...preset)
        }
      } else {
        expandedItems.push(item)
      }
    }

    if (expandedItems.length > 0) {
      result.push({ kind: 'UtilityLine', items: expandedItems, line: line.line })
    }
  }

  return result
}

// ═══ Legacy syntax lowering ═══

function lowerLetAsSource(stmt: AST.LetStatement): SourceDef | null {
  if (stmt.value.kind !== 'FnCall') return null
  const callee = stmt.value.callee
  if (callee.kind !== 'Identifier' || callee.name !== 'load') return null
  const arg = stmt.value.args[0]
  if (!arg || arg.kind !== 'StringLiteral') return null

  // Detect type from URL pattern
  const url = arg.value
  const type = url.includes('{z}') ? 'raster' : 'geojson'

  return { name: stmt.name, type, url }
}

function lowerShow(stmt: AST.ShowStatement): RenderNode | null {
  let targetName = ''
  if (stmt.target.kind === 'Identifier') {
    targetName = stmt.target.name
  }
  if (!targetName) return null

  let fill: ColorValue = colorNone()
  let strokeColor: ColorValue = colorNone()
  let strokeWidth = 1
  let opacity = 1.0
  let projection = 'mercator'
  let visible = true

  for (const prop of stmt.block.properties) {
    if (prop.name === 'fill') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        fill = colorConstant(...hexToRgba(val.value))
      }
    } else if (prop.name === 'stroke') {
      const val = prop.values[0]
      if (val?.kind === 'ColorLiteral') {
        strokeColor = colorConstant(...hexToRgba(val.value))
      }
      const widthVal = prop.values[1]
      if (widthVal?.kind === 'NumberLiteral') {
        strokeWidth = widthVal.value
      }
    } else if (prop.name === 'opacity') {
      const val = prop.values[0]
      if (val?.kind === 'NumberLiteral') opacity = val.value
    } else if (prop.name === 'projection') {
      const val = prop.values[0]
      if (val?.kind === 'Identifier') projection = val.name
    } else if (prop.name === 'visible') {
      const val = prop.values[0]
      if (val?.kind === 'BoolLiteral') visible = val.value
    }
  }

  return {
    name: targetName,
    sourceRef: targetName,
    zOrder: 0,
    fill,
    stroke: { color: strokeColor, width: { kind: 'constant', value: strokeWidth } },
    opacity: opacityConstant(opacity),
    size: sizeNone(),
    projection,
    visible,
    pointerEvents: 'auto',
    filter: null,
    geometry: null,
    billboard: true,
    shape: shapeNone(),
    extrude: { kind: 'none' },
    extrudeBase: { kind: 'none' },
  }
}
