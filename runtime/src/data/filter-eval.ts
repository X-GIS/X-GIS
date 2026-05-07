// ═══ Filter expression evaluator + slice keying ═══
//
// xgis layers may set `filter: <expr>` to restrict their draws to
// matching features. For PMTiles tiles, multiple xgis layers often
// share the same MVT source layer with DIFFERENT filters (e.g. six
// `landuse_*` layers reading the single `landuse` source layer with
// kind-equals filters). Without per-filter pre-bucketing, every layer
// re-draws the FULL source-layer geometry → the GPU paints
// (layer-count) × redundant fragments before painter's order resolves
// to "last fill with a matching feature wins". OSM-style sees this as
// 11 redundant landuse/roads draws per tile per frame; at DPR=3 with
// 9× fragment cost, that overdraw became the dominant frame budget
// consumer.
//
// This module's role is to evaluate filter ASTs at MVT decode time so
// the worker can split a source-layer's features into per-filter
// sub-slices, each keyed by `computeSliceKey()`. Multiple shows that
// share an identical filter share the slice (deduped by stable hash
// of the AST + sourceLayer pair).

import { evaluate } from '@xgis/compiler'

export type FilterAst = unknown // structurally-typed AST node from the compiler

/** Evaluate a filter AST against a feature's property bag. Mirrors
 *  the truthiness rules `applyFilter` uses for GeoJSON sources
 *  (`map.ts`) so PMTiles and GeoJSON paths behave identically:
 *  booleans direct, non-zero numbers truthy, everything else `!!`. */
export function evalFilterExpr(ast: FilterAst, props: Record<string, unknown>): boolean {
  if (!ast || typeof ast !== 'object') return true
  const v = evaluate(ast as never, props)
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  return !!v
}

/** Stable string key for a (sourceLayer, filterAst) pair. Slices with
 *  equal keys can share storage — both at the worker output AND at
 *  the catalog cache layer. The hash uses `JSON.stringify` of the
 *  AST (parser output is acyclic POJO) folded through a 32-bit djb2
 *  so the result is short enough to be a Map key but stable across
 *  worker boundaries (different threads see the same string for
 *  the same AST input).
 *
 *  When `filterAst` is null/undefined the key collapses to plain
 *  `sourceLayer` — preserving back-compat for the prior "one slice
 *  per MVT layer" behaviour for legacy demos / unfiltered shows. */
export function computeSliceKey(sourceLayer: string, filterAst: FilterAst | null | undefined): string {
  if (!filterAst) return sourceLayer
  const json = JSON.stringify(filterAst)
  let h = 5381
  for (let i = 0; i < json.length; i++) {
    h = (h * 33) ^ json.charCodeAt(i)
    h |= 0
  }
  return `${sourceLayer}::${(h >>> 0).toString(36)}`
}

/** Per-show slice descriptor. Map.ts collects one entry per UNIQUE
 *  (sourceLayer, filter) combo across the loaded shows; multiple
 *  shows with identical sliceKey share the entry (and thus the
 *  worker-emitted slice). */
export interface ShowSlice {
  sliceKey: string
  sourceLayer: string
  filterAst: FilterAst | null
}
