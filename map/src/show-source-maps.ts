// Per-source attach-time configuration derived from compiled show
// commands. Each `commands.shows[i]` may declare extrude / stroke /
// label / filter expressions that the per-source MVT decoder workers
// need (or DON'T need — passing pre-bucketed slice descriptors lets
// workers skip emitting featureProps / extrude data when no show on
// the slice consumes them, dropping postMessage clone cost from ~309
// ms to sub-ms on dense styles per the Bright DevTools profile).
//
// Pure function: input is `commands.shows`, output is five Maps keyed
// by sourceTargetName. Extracted from XGISMap.run's data-load step so
// the orchestration there reads as a flat sequence (preprocess →
// loadAll → cameraFit → rebuildLayers) instead of 100 lines of
// preamble.

import { collectFieldsStrict, type LabelDef } from '@xgis/compiler'
import { computeSliceKey } from '@xgis/data'
import type { ShowCommand } from './render/renderer-types'

/** Collect ALL feature-property field names a LabelDef reads at runtime.
 *
 *  Four sources (label-pass.ts:343-407):
 *    1. text (TextValue) — the text-field AST, one or more interp parts
 *    2. iconImageExpr — data-driven icon-image (OFM POI subclass/class match)
 *    3. shapes.size when data-driven — per-feature font-size expr
 *    4. shapes.color when data-driven — per-feature text-color expr
 *
 *  Uses collectFieldsStrict (NOT collectFields) for every AST so that any
 *  node kind we do not fully traverse (ConditionalExpr, MatchBlock arms,
 *  ArrayLiteral, ArrayAccess, …) returns null rather than silently dropping
 *  fields. A null from ANY of the four sources poisons the whole result →
 *  caller falls back to full props for that slice (safe; labels/icons never
 *  lose a field). Paint-safe: collectFields/walkExpr are NEVER called here. */
function collectLabelFields(label: LabelDef | undefined): Set<string> | null {
  if (!label) return new Set()
  const acc = new Set<string>()

  // ── 1. text (TextValue) ─────────────────────────────────────────────
  const text = label.text
  if (text.kind === 'expr') {
    const r = collectFieldsStrict(text.expr.ast)
    if (r === null) return null
    for (const f of r) acc.add(f)
  } else if (text.kind === 'template') {
    for (const part of text.parts) {
      if (part.kind === 'interp') {
        const r = collectFieldsStrict(part.expr.ast)
        if (r === null) return null
        for (const f of r) acc.add(f)
      }
    }
  } else {
    // Unknown TextValue shape — bail to full props.
    return null
  }

  // ── 2. iconImageExpr ────────────────────────────────────────────────
  // Cast matches label-pass.ts:353 which reads iconImageExpr the same way.
  const iconImageAst = (label as { iconImageExpr?: { ast?: unknown } }).iconImageExpr?.ast
  if (iconImageAst !== undefined) {
    const r = collectFieldsStrict(iconImageAst as import('@xgis/compiler').Expr)
    if (r === null) return null
    for (const f of r) acc.add(f)
  }

  // ── 3. shapes.size when data-driven ─────────────────────────────────
  const shapes = label.shapes
  if (shapes?.textLayout.size.kind === 'data-driven') {
    const r = collectFieldsStrict(shapes.textLayout.size.expr.ast)
    if (r === null) return null
    for (const f of r) acc.add(f)
  }

  // ── 4. shapes.color when data-driven ────────────────────────────────
  if (shapes?.textPaint.color?.kind === 'data-driven') {
    const r = collectFieldsStrict(shapes.textPaint.color.expr.ast)
    if (r === null) return null
    for (const f of r) acc.add(f)
  }

  return acc
}

export interface ShowSourceMaps {
  /** Per-source set of MVT layer names actually consumed by xgis
   *  layers — forwarded into the MVT decoder filter so unused slices
   *  (protomaps v4 'earth' / 'natural' / 'pois' …) never get compiled
   *  + uploaded. Empty / missing set means "all layers" (no filter). */
  usedSourceLayers: Map<string, Set<string>>

  /** Per-show extrude AST — only emitted for `extrude.kind === 'feature'`.
   *  Worker evaluates per feature to compute its 3D height. Constant
   *  extrude is handled at render time and isn't part of this map. */
  extrudeExprsBySource: Map<string, Record<string, unknown>>

  /** Companion to extrudeExprsBySource for Mapbox `fill-extrusion-base`. */
  extrudeBaseExprsBySource: Map<string, Record<string, unknown>>

  /** Per-show stroke-width override AST keyed by sliceKey. Synthesized
   *  by the compiler's mergeLayers pass for groups whose only stroke
   *  difference is the width (roads_minor / primary / highway). The
   *  worker bakes per-segment widths into the slice's line buffer so
   *  the line shader picks each feature's width without per-frame
   *  uniform churn. */
  strokeWidthExprsBySource: Map<string, Record<string, unknown>>

  /** Per-show stroke-colour override AST. Same plumbing as width —
   *  worker resolves per feature, packs RGBA8 into u32, writes into
   *  segment buffer. */
  strokeColorExprsBySource: Map<string, Record<string, unknown>>

  /** Per-source slice descriptors. With this set, the worker emits one
   *  pre-filtered slice per UNIQUE (sourceLayer, filterAst) combo
   *  instead of one slice per source layer — eliminating the redundant
   *  draws when N xgis layers share an MVT layer with different
   *  filters. `needsFeatureProps` / `needsExtrude` flags let the worker
   *  skip emitting heavy fields when no show on the slice consumes them. */
  showSlicesBySource: Map<string, Array<{
    sliceKey: string
    sourceLayer: string
    filterAst: unknown | null
    needsFeatureProps: boolean
    needsExtrude: boolean
    /** Minimal set of feature-property keys any consumer on this slice
     *  actually reads — the union of the data-driven variant's
     *  `featureFields` and the label text-field's referenced fields.
     *  Sorted for determinism. The MVT worker clones ONLY these keys
     *  per feature instead of the whole properties Record, cutting the
     *  worker→main structured-clone cost (309 ms/msg on Bright). An
     *  EMPTY array is the safe fallback (an un-introspectable label AST,
     *  or a literal-only label): the worker keeps the FULL props Record
     *  so no consumer can lose a field it references. */
    featurePropKeys: string[]
  }>>
}

/** Single pass over `commands.shows` building all five per-source maps
 *  the data-load loop hands to PMTilesBackend. Walks `shows` once each
 *  for usedSourceLayers / extrude / stroke-width / stroke-colour /
 *  showSlices — kept as separate loops for readability rather than
 *  fused into one mega-loop, since the per-show preprocessing on dense
 *  styles is < 1 ms total (≪ the await on tile fetch that follows). */
export function buildShowSourceMaps(shows: readonly ShowCommand[]): ShowSourceMaps {
  // Centralised fallback rule: inline GeoJSON shows have no explicit
  // `sourceLayer` (the source IS the layer). The tilingPool emits MVT
  // bytes whose `_layer` field equals the source name, so callers must
  // address those features via `targetName`. This helper is the single
  // source of truth so every map below addresses the same key the
  // worker emits — without it, extrude / strokeWidth / strokeColor /
  // labels silently dropped on inline GeoJSON shows (same class as
  // the filter_gdp emerald/yellow miss that fix(filter) addressed).
  const effectiveLayer = (show: ShowCommand): string => show.sourceLayer || show.targetName

  const usedSourceLayers = new Map<string, Set<string>>()
  for (const show of shows) {
    const layer = effectiveLayer(show)
    if (!layer) continue
    let set = usedSourceLayers.get(show.targetName)
    if (!set) { set = new Set(); usedSourceLayers.set(show.targetName, set) }
    set.add(layer)
  }

  const extrudeExprsBySource = new Map<string, Record<string, unknown>>()
  const extrudeBaseExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    const layer = effectiveLayer(show)
    if (!layer) continue
    const ex = show.extrude
    if (ex && ex.kind === 'feature') {
      let layerMap = extrudeExprsBySource.get(show.targetName)
      if (!layerMap) { layerMap = {}; extrudeExprsBySource.set(show.targetName, layerMap) }
      layerMap[layer] = ex.expr.ast
    }
    const exb = show.extrudeBase
    if (exb && exb.kind === 'feature') {
      let layerMap = extrudeBaseExprsBySource.get(show.targetName)
      if (!layerMap) { layerMap = {}; extrudeBaseExprsBySource.set(show.targetName, layerMap) }
      layerMap[layer] = exb.expr.ast
    }
  }

  const strokeWidthExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    if (!show.strokeWidthExpr) continue
    const layer = effectiveLayer(show)
    if (!layer) continue
    const sk = computeSliceKey(layer, show.filterExpr?.ast ?? null)
    let layerMap = strokeWidthExprsBySource.get(show.targetName)
    if (!layerMap) { layerMap = {}; strokeWidthExprsBySource.set(show.targetName, layerMap) }
    layerMap[sk] = show.strokeWidthExpr.ast
  }

  const strokeColorExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    if (!show.strokeColorExpr) continue
    const layer = effectiveLayer(show)
    if (!layer) continue
    const sk = computeSliceKey(layer, show.filterExpr?.ast ?? null)
    let layerMap = strokeColorExprsBySource.get(show.targetName)
    if (!layerMap) { layerMap = {}; strokeColorExprsBySource.set(show.targetName, layerMap) }
    layerMap[sk] = show.strokeColorExpr.ast
  }

  const showSlicesBySource = new Map<string, Array<{
    sliceKey: string
    sourceLayer: string
    filterAst: unknown | null
    needsFeatureProps: boolean
    needsExtrude: boolean
    featurePropKeys: string[]
  }>>()
  // Per-slice union of used feature-property field names, tracked as a
  // Set while merging shows that share a sliceKey. A null entry means
  // "fall back to full props" (a label AST we couldn't introspect) and
  // it's sticky — once any show on the slice forces full props, the
  // whole slice keeps them so no consumer loses a field.
  const fieldSetsBySlice = new Map<string, Set<string> | null>()
  for (const show of shows) {
    const layer = effectiveLayer(show)
    if (!layer) continue
    let list = showSlicesBySource.get(show.targetName)
    if (!list) { list = []; showSlicesBySource.set(show.targetName, list) }
    const filterAst = show.filterExpr?.ast ?? null
    const sliceKey = computeSliceKey(layer, filterAst)
    // Worker emits featureProps Map when ANY downstream consumer reads per-
    // feature attributes: SDF label pipeline (show.label), per-feature paint
    // expressions that the variant shader branches on (data-driven fill /
    // stroke via match(.field) etc. → `needsFeatureBuffer`). Without the
    // shaderVariant gate, merge-layers' compound fill (e.g. OFM Bright
    // landuse `class` match) ships a variant that indexes feat_data[fid]
    // but the buffer is empty because the worker dropped featureProps.
    // #722 S4: a data-driven point size (show.sizeExpr — the compiler emits it
    // iff the size shape is data-driven, emit-commands.ts:542) is resolved per
    // feature on the CPU (point-renderer flushTilePoints / VTR wantsFeatProps
    // both gate on `show.sizeExpr?.ast != null`). Mirror that gate here or the
    // point source ships no featureProps and every point collapses to the
    // constant `show.size` — the S4 data-layer gap the runtime half couldn't fix.
    const needsFeatureProps = show.label !== undefined
      || show.shaderVariant?.needsFeatureBuffer === true
      || show.sizeExpr?.ast != null
    const ex = (show as { extrude?: { kind?: string } }).extrude
    const needsExtrude = !!ex && ex.kind !== 'none' && ex.kind !== undefined
    // Compute the fields THIS show reads so the worker clones only those.
    // Two sources: the data-driven variant's featureFields (the match /
    // interpolate fields, only when it actually builds a feature buffer)
    // and the label text-field AST. A null label-field result (unknown
    // AST shape) poisons the slice to full props — labels never lose a
    // field they reference.
    const sliceFields = fieldSetsBySlice.get(sliceKey)
    if (sliceFields !== null) {
      const acc: Set<string> = sliceFields ?? new Set<string>()
      let poison = false
      if (show.shaderVariant?.needsFeatureBuffer === true) {
        for (const f of show.shaderVariant.featureFields) acc.add(f)
      }
      // #722 S4: data-driven point size fields — the CPU point path resolves
      // show.sizeExpr per feature, so the worker must clone its referenced
      // fields (e.g. gradient_points `size-[sqrt(.pop_max)/120]` → pop_max).
      // Same null-poisoning rule as the label text-size below: an un-
      // introspectable size AST falls back to full props so a field is never lost.
      if (show.sizeExpr?.ast != null) {
        const sizeFields = collectFieldsStrict(show.sizeExpr.ast as import('@xgis/compiler').Expr)
        if (sizeFields === null) poison = true
        else for (const f of sizeFields) acc.add(f)
      }
      if (!poison && show.label !== undefined) {
        const labelFields = collectLabelFields(show.label)
        if (labelFields === null) poison = true
        else for (const f of labelFields) acc.add(f)
      }
      fieldSetsBySlice.set(sliceKey, poison ? null : acc)
    }
    const existing = list.find(s => s.sliceKey === sliceKey)
    if (existing) {
      if (needsFeatureProps) existing.needsFeatureProps = true
      if (needsExtrude) existing.needsExtrude = true
    } else {
      list.push({ sliceKey, sourceLayer: layer, filterAst, needsFeatureProps, needsExtrude, featurePropKeys: [] })
    }
  }
  // Bake the accumulated field Sets into each slice's sorted
  // featurePropKeys. A null Set → empty array (the worker treats an
  // undefined/empty featurePropKeys as "no filtering — full props").
  for (const list of showSlicesBySource.values()) {
    for (const slice of list) {
      const fields = fieldSetsBySlice.get(slice.sliceKey)
      slice.featurePropKeys = fields ? [...fields].sort() : []
    }
  }

  return {
    usedSourceLayers,
    extrudeExprsBySource,
    extrudeBaseExprsBySource,
    strokeWidthExprsBySource,
    strokeColorExprsBySource,
    showSlicesBySource,
  }
}
