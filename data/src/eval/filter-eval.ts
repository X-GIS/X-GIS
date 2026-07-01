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
  // Per-feature throw isolation — mirror of applyFilter (566ab36).
  // Inside MVT worker decoding / PMTiles tile compile the filter is
  // run thousands of times per tile; one pathological feature must
  // not nuke the rest of the tile's slice. Treat throw as 'reject'.
  let v: unknown
  try {
    v = evaluate(ast as never, props)
  } catch {
    return false
  }
  if (typeof v === 'boolean') return v
  // For numeric filter results, treat 0 and NaN as false (`Boolean(NaN)
  // === false` matches JS coercion; Mapbox spec doesn't define NaN
  // explicitly but matches "neither truthy nor zero"). Pre-fix
  // `v !== 0` accepted NaN as true and a filter returning NaN (e.g.
  // from a corrupted feature property divided by zero) would let
  // every feature through.
  if (typeof v === 'number') return v !== 0 && Number.isFinite(v)
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
 *  per MVT layer" behaviour for legacy demos / unfiltered shows.
 *
 *  Memo: filterAst is a compile-time-frozen POJO (parser output,
 *  never mutated after IR build). VTR.render + show-source-maps call
 *  this ~80×/frame on Bright; the JSON.stringify of even moderate
 *  filter ASTs was 19.5 ms/frame on the pan-hitch CPU profile.
 *  Memoising by AST object identity drops the steady-state cost to
 *  one Map.get per call. */
const _sliceKeyCache = new WeakMap<object, Map<string, string>>()

/** Iterative AST hash. iter-299 replaces the previous
 *  `JSON.stringify` path that blew the stack on 5000-node deep
 *  filters (and threw on circular ASTs). Walks the AST via an
 *  explicit work-list and accumulates a djb2-style hash node-by-
 *  node — same hash family as before so the key space is unchanged
 *  for shallow inputs.
 *
 *  Visit-set bounds recursion through circular references: each
 *  object is hashed at most once. Distinct objects with identical
 *  content still hash to the same value (structural equality —
 *  matches the old JSON.stringify contract).
 *
 *  Key ordering invariant: object properties are walked in sorted
 *  key order so two structurally-identical objects with different
 *  property-insertion order hash identically. (V8 generally
 *  preserves insertion order, but a sort is the cheap path to
 *  insulation against future engine changes.) */
function hashAstIterative(root: unknown): number {
  let h = 5381
  // Inline djb2 step. Numbers fold via 8 bytes of bit-pattern; the
  // exact mantissa interpretation doesn't matter for stability —
  // only that equal values produce equal hashes.
  const f64 = new Float64Array(1)
  const u32 = new Uint32Array(f64.buffer)
  const stepStr = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = (h * 33) ^ s.charCodeAt(i)
      h |= 0
    }
  }
  const stepNum = (n: number) => {
    f64[0] = n
    h = (h * 33) ^ u32[0]!; h |= 0
    h = (h * 33) ^ u32[1]!; h |= 0
  }
  // Markers (single-byte) separate value categories so e.g. the
  // number 1 and the string '1' don't collide; same for null,
  // boolean, object-open, array-open, end-of-children.
  const M_OBJ = 0x7b      // '{'
  const M_ARR = 0x5b      // '['
  const M_END = 0x7d      // '}'
  const M_STR = 0x73      // 's'
  const M_NUM = 0x6e      // 'n'
  const M_BOOL = 0x62     // 'b'
  const M_NULL = 0x6f     // 'o'
  const stack: unknown[] = [root]
  const visited = new WeakSet<object>()
  while (stack.length > 0) {
    const v = stack.pop()
    if (v === null || v === undefined) {
      h = (h * 33) ^ M_NULL; h |= 0
      continue
    }
    const t = typeof v
    if (t === 'string') {
      h = (h * 33) ^ M_STR; h |= 0
      stepStr(v as string)
      continue
    }
    if (t === 'number') {
      h = (h * 33) ^ M_NUM; h |= 0
      stepNum(v as number)
      continue
    }
    if (t === 'boolean') {
      h = (h * 33) ^ M_BOOL; h |= 0
      h = (h * 33) ^ ((v as boolean) ? 1 : 0); h |= 0
      continue
    }
    if (t === 'object') {
      const obj = v as object
      if (visited.has(obj)) {
        // Cyclic reference — emit a stable marker so two distinct
        // cyclic ASTs with different cycle structures still hash
        // distinctly via the prior walk before re-encountering.
        h = (h * 33) ^ M_END; h |= 0
        continue
      }
      visited.add(obj)
      if (Array.isArray(v)) {
        h = (h * 33) ^ M_ARR; h |= 0
        // Push end-marker first so it's popped LAST after children.
        stack.push({ kind: 'EndMarker' } as unknown)
        // Push children in reverse order so they pop in original order.
        for (let i = (v as unknown[]).length - 1; i >= 0; i--) {
          stack.push((v as unknown[])[i])
        }
        continue
      }
      // Plain object (frozen AST POJO).
      const o = v as Record<string, unknown>
      // Detect end-marker placeholder (pushed by array/object open).
      if (o.kind === 'EndMarker') {
        h = (h * 33) ^ M_END; h |= 0
        continue
      }
      h = (h * 33) ^ M_OBJ; h |= 0
      const keys = Object.keys(o).sort()
      stack.push({ kind: 'EndMarker' } as unknown)
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i]!
        stack.push(o[k])
        // Key string mixed in BEFORE value via a fake string push.
        stack.push(k)
      }
      continue
    }
    // function / symbol / bigint — unreachable for AST POJOs but
    // included for defensive completeness.
    h = (h * 33) ^ M_NULL; h |= 0
  }
  return h >>> 0
}

export function computeSliceKey(sourceLayer: string, filterAst: FilterAst | null | undefined): string {
  if (!filterAst) return sourceLayer
  let inner = _sliceKeyCache.get(filterAst as object)
  if (inner) {
    const hit = inner.get(sourceLayer)
    if (hit !== undefined) return hit
  } else {
    inner = new Map()
    _sliceKeyCache.set(filterAst as object, inner)
  }
  // iter-299 — Iterative AST walk. Replaces iter-298's
  // JSON.stringify + try/catch path that hit a 5000-node stack
  // overflow and propagated the throw. Walks the tree via an
  // explicit work-list with a visited WeakSet to bound recursion
  // on circular ASTs.
  const h = hashAstIterative(filterAst)
  const key = `${sourceLayer}::${h.toString(36)}`
  inner.set(sourceLayer, key)
  return key
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
