// ═══ Source-level point clustering — the one authority (#2050) ═══
//
// Mapbox `source.cluster` turns a GeoJSON point source into a supercluster hierarchy:
// at every zoom, nearby points collapse into one aggregate feature carrying
// `point_count` / `point_count_abbreviated` / `cluster` / `cluster_id` plus every
// declared `clusterProperties` key. Two stages need to agree about what a usable
// declaration is — the Mapbox converter (which decides what to emit and what to warn)
// and `lowerSource` (which decides what reaches `SourceDef`) — so the key SPELLINGS and
// the per-key value rules live here once and each stage renders its own message around
// them. Design record: docs/plans/2026-08-24-geojson-clustering.md (§2 semantics, §4.3
// the map/reduce pair, §5 P1 this phase).
//
// GRAMMAR — ZERO new productions, names and values alike. `parseBlockProperty` reads one
// identifier for the NAME, so the keys are spelled the way every other source-block key
// is and the way Mapbox's own source spec spells them: camelCase, `clusterRadius:`, not
// `cluster-radius:` (which does not parse at all — `Expected Colon, got Minus` — because
// hyphen-joined names belong to `parseStyleProperty`, the LAYER-paint form). The VALUES
// then parse as full expressions: `cluster: true` arrives as a `BoolLiteral`,
// `clusterRadius: 50` as a `NumberLiteral`, and the nested
// `{ k: { map: <expr>, reduce: <expr> } }` as an `ObjectLiteral` whose values
// `parsePrimary` parses with `parseExpr()` — the same nested-object shape inline `data:`
// GeoJSON already uses. So the `.xgis` key IS the Mapbox key, character for character,
// which is also what lets one diagnostic name the string the author actually typed.
//
// ASTs, NOT `astLiteralToJS` OUTPUT. Every other object-valued source property (inline
// `data:`) is folded to plain JS by `astLiteralToJS`, a literal-only walker that THROWS
// on a `FieldAccess`. A `clusterProperties` entry is a PAIR OF EXPRESSIONS evaluated per
// point (`map`) and per merge (`reduce`), so folding is not merely lossy — it is
// impossible. The pair stays as parsed `AST.Expr` nodes all the way to the worker, which
// runs them through `eval/evaluator.ts` with `accumulated` injected as a reserved key.
// This is the one place `data:`'s precedent does not apply.
//
// UNITS — `clusterRadius` is in 512-px TILE PIXELS, the Mapbox/MapLibre unit, carried
// verbatim from the style. It is deliberately NOT pre-multiplied into the tiler's extent
// units (`radius × EXTENT / tileSize`, i.e. ×16 at extent 8192): a hand-authored `.xgis`
// source reaches this same field without a converter in the loop, so a rescaled value
// would give the property two meanings depending on who wrote it, and would bake a TILER
// constant into the STYLE language. The ×16 belongs at the tiler boundary that already
// owns that convention (`geojsonvt/index.ts` DEFAULT_OPTIONS: `tolerance: 6`,
// `buffer: 2048`), i.e. in P2/P3 — see the design doc §2.
//
// AN UNUSABLE VALUE LOWERS TO UNDEFINED, silently — the same rule its `bounds` /
// `scheme` / `tileSize` siblings follow. The author-facing diagnostic belongs to the
// converter, which still holds the Mapbox JSON that produced it; a hand-authored
// mistake degrades to "no clustering", never to a blanked source.

import type * as AST from '../parser/ast'

/** One `clusterProperties` entry — MapLibre's map/reduce pair (design §2):
 *  `map` evaluates against ONE point's own properties, `reduce` against the running
 *  aggregate with `accumulated` bound to the value so far and `["get", key]` reading
 *  the incoming mapped bag. Both are parsed expressions, never folded values. */
export interface ClusterProperty {
  map: AST.Expr
  reduce: AST.Expr
}

/** The source-block clustering axes on `SourceDef`. Split into this sibling file (as
 *  `RasterDemSourceFields` already is) to keep `render-node.ts` under its LOC ceiling.
 *  Every field is undefined for a source that declares no clustering, so an
 *  unclustered source lowers byte-identically. */
export interface SourceClusterFields {
  /** Mapbox `cluster` — clustering is ON only when this is `true`; every other field
   *  below is inert without it (MapLibre reads them only under that flag). */
  cluster?: boolean
  /** Mapbox `clusterRadius` — the cluster neighbourhood in 512-px tile pixels (default
   *  50 upstream). See the UNITS note above: NOT extent units. */
  clusterRadius?: number
  /** Mapbox `clusterMaxZoom` — the deepest zoom served from the cluster hierarchy;
   *  ABOVE it a clustered source serves individual points from the ordinary index.
   *  Distinct from source `maxzoom` (upstream default: source maxzoom − 1). */
  clusterMaxZoom?: number
  /** Mapbox `clusterMinPoints` — the smallest neighbourhood that becomes a cluster.
   *  Carried verbatim; upstream lifts anything below 2 to 2 at index-build time. */
  clusterMinPoints?: number
  /** Mapbox `clusterProperties` — per-key aggregation, as expression pairs. */
  clusterProperties?: Record<string, ClusterProperty>
}

/** The five key names — the ONE place they are written down. `lowerSource` claims the
 *  keys through this table and the Mapbox converter emits through it, so the two stages
 *  cannot drift apart on a name. The `.xgis` spelling and the Mapbox spelling are the
 *  SAME string (see GRAMMAR above), so this table serves both sides. */
export const CLUSTER_KEY = {
  on: 'cluster',
  radius: 'clusterRadius',
  maxZoom: 'clusterMaxZoom',
  minPoints: 'clusterMinPoints',
  properties: 'clusterProperties',
} as const

const CLUSTER_KEY_SET: ReadonlySet<string> = new Set(Object.values(CLUSTER_KEY))

/** True for a source-block property name this module owns. `lowerSource` tests it so
 *  the five keys are RESERVED — without that they fall into the custom-loader `options`
 *  bag, where a number nothing reads is the silent gap this closes. */
export function isSourceClusterProp(name: string): boolean {
  return CLUSTER_KEY_SET.has(name)
}

/** Lower every cluster property a source block declares. An unusable value leaves its
 *  field untouched (see the silent-ignore note above), so the result stays EMPTY — and
 *  its spread adds no key to `SourceDef` — for a source that declares nothing usable.
 *  That is what keeps an unclustered source's lowering byte-identical. */
export function lowerSourceCluster(properties: readonly AST.BlockProperty[]): SourceClusterFields {
  const out: SourceClusterFields = {}
  for (const { name, value: v } of properties) {
    if (name === CLUSTER_KEY.on) {
      if (v.kind === 'BoolLiteral') out.cluster = v.value
    } else if (name === CLUSTER_KEY.radius) {
      // Bare `NumberLiteral` only — a negative parses as a `UnaryExpr` and is not a
      // usable radius anyway, so the same match the `tileSize` / `maxzoom` siblings use.
      if (v.kind === 'NumberLiteral') out.clusterRadius = v.value
    } else if (name === CLUSTER_KEY.maxZoom) {
      if (v.kind === 'NumberLiteral') out.clusterMaxZoom = v.value
    } else if (name === CLUSTER_KEY.minPoints) {
      if (v.kind === 'NumberLiteral') out.clusterMinPoints = v.value
    } else if (name === CLUSTER_KEY.properties) {
      const props = lowerClusterProperties(v)
      if (props !== undefined) out.clusterProperties = props
    }
  }
  return out
}

/** `{ key: { map: <expr>, reduce: <expr> } }` → the entry table. An entry missing
 *  either half is skipped rather than half-carried: a reduce with no map (or the
 *  reverse) cannot aggregate anything, and a half-entry would fail at index-build time
 *  instead of at convert time. Undefined when nothing usable survives. */
function lowerClusterProperties(value: AST.Expr): Record<string, ClusterProperty> | undefined {
  if (value.kind !== 'ObjectLiteral') return undefined
  const out: Record<string, ClusterProperty> = {}
  for (const { key, value: entry } of value.properties) {
    if (entry.kind !== 'ObjectLiteral') continue
    let map: AST.Expr | undefined
    let reduce: AST.Expr | undefined
    for (const half of entry.properties) {
      if (half.key === 'map') map = half.value
      else if (half.key === 'reduce') reduce = half.value
    }
    if (map !== undefined && reduce !== undefined) out[key] = { map, reduce }
  }
  return Object.keys(out).length > 0 ? out : undefined
}
