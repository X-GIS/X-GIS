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

import { computeSliceKey } from '../data/eval/filter-eval'
import type { ShowCommand } from './render/renderer'

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
  }>>
}

/** Single pass over `commands.shows` building all five per-source maps
 *  the data-load loop hands to PMTilesBackend. Walks `shows` once each
 *  for usedSourceLayers / extrude / stroke-width / stroke-colour /
 *  showSlices — kept as separate loops for readability rather than
 *  fused into one mega-loop, since the per-show preprocessing on dense
 *  styles is < 1 ms total (≪ the await on tile fetch that follows). */
export function buildShowSourceMaps(shows: readonly ShowCommand[]): ShowSourceMaps {
  const usedSourceLayers = new Map<string, Set<string>>()
  for (const show of shows) {
    if (!show.sourceLayer) continue
    let set = usedSourceLayers.get(show.targetName)
    if (!set) { set = new Set(); usedSourceLayers.set(show.targetName, set) }
    set.add(show.sourceLayer)
  }

  const extrudeExprsBySource = new Map<string, Record<string, unknown>>()
  const extrudeBaseExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    const ex = show.extrude
    if (ex && ex.kind === 'feature' && show.sourceLayer) {
      let layerMap = extrudeExprsBySource.get(show.targetName)
      if (!layerMap) { layerMap = {}; extrudeExprsBySource.set(show.targetName, layerMap) }
      layerMap[show.sourceLayer] = ex.expr.ast
    }
    const exb = show.extrudeBase
    if (exb && exb.kind === 'feature' && show.sourceLayer) {
      let layerMap = extrudeBaseExprsBySource.get(show.targetName)
      if (!layerMap) { layerMap = {}; extrudeBaseExprsBySource.set(show.targetName, layerMap) }
      layerMap[show.sourceLayer] = exb.expr.ast
    }
  }

  const strokeWidthExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    if (!show.strokeWidthExpr || !show.sourceLayer) continue
    const sk = computeSliceKey(show.sourceLayer, show.filterExpr?.ast ?? null)
    let layerMap = strokeWidthExprsBySource.get(show.targetName)
    if (!layerMap) { layerMap = {}; strokeWidthExprsBySource.set(show.targetName, layerMap) }
    layerMap[sk] = show.strokeWidthExpr.ast
  }

  const strokeColorExprsBySource = new Map<string, Record<string, unknown>>()
  for (const show of shows) {
    if (!show.strokeColorExpr || !show.sourceLayer) continue
    const sk = computeSliceKey(show.sourceLayer, show.filterExpr?.ast ?? null)
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
  }>>()
  for (const show of shows) {
    if (!show.sourceLayer) continue
    let list = showSlicesBySource.get(show.targetName)
    if (!list) { list = []; showSlicesBySource.set(show.targetName, list) }
    const filterAst = show.filterExpr?.ast ?? null
    const sliceKey = computeSliceKey(show.sourceLayer, filterAst)
    // Worker emits featureProps Map when ANY downstream consumer reads per-
    // feature attributes: SDF label pipeline (show.label), per-feature paint
    // expressions that the variant shader branches on (data-driven fill /
    // stroke via match(.field) etc. → `needsFeatureBuffer`). Without the
    // shaderVariant gate, merge-layers' compound fill (e.g. OFM Bright
    // landuse `class` match) ships a variant that indexes feat_data[fid]
    // but the buffer is empty because the worker dropped featureProps.
    const needsFeatureProps = show.label !== undefined
      || show.shaderVariant?.needsFeatureBuffer === true
    const ex = (show as { extrude?: { kind?: string } }).extrude
    const needsExtrude = !!ex && ex.kind !== 'none' && ex.kind !== undefined
    const existing = list.find(s => s.sliceKey === sliceKey)
    if (existing) {
      if (needsFeatureProps) existing.needsFeatureProps = true
      if (needsExtrude) existing.needsExtrude = true
    } else {
      list.push({ sliceKey, sourceLayer: show.sourceLayer, filterAst, needsFeatureProps, needsExtrude })
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
