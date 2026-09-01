// ═══ Mapbox GeoJSON source clustering → xgis source-block lines (#2050) ═══
//
// The emit half of the pair whose lowering half is `ir/source-cluster.ts`; the five key
// names come from that module's `CLUSTER_KEY` table so the converter and `lowerSource`
// cannot drift apart on a name. The `.xgis` spelling IS the Mapbox spelling — camelCase,
// like every other source-block key (`sourceLayer`, `tileSize`, `redFactor`) — so one
// table names both the field we read and the line we write, and a diagnostic quotes the
// exact string the style author typed. Split out of `sources.ts` (which has ~110 lines of
// headroom under the 800-line cap and is edited by four concurrent tracks) per the design
// doc's §6 LOC table.
//
// WHAT IS EMITTED — only what a consumer will read. `cluster: true` gates everything:
// MapLibre reads `clusterRadius` / `clusterMaxZoom` / `clusterMinPoints` /
// `clusterProperties` only when clustering is ON, so without the flag they are emitted
// nowhere and warned about instead — emitting a line nothing can ever read is the same
// silent gap this replaces, wearing a different hat (the `scheme: xyz` rule again).
//
// UNITS — `clusterRadius` is carried VERBATIM, in the 512-px tile pixels the style
// author wrote. See `ir/source-cluster.ts`'s UNITS note for why the ×16 into tiler
// extent units belongs at the tiler boundary (P2/P3) and not here.
//
// clusterProperties — MapLibre's expansion, verbatim (`geojson_worker_source.ts`, read
// 2026-08-24): an entry is `[operator, mapExpression]`; the per-point `map` is
// `mapExpression`, and the `reduce` is `operator` when it is already a full expression,
// or `[operator, ["accumulated"], ["get", key]]` when it is a bare string like `"+"` /
// `"max"`. Both forms convert through the ordinary expression path, which is what makes
// the two-element full form work at all — `["accumulated"]` is now a converted accessor
// (expr-lookup.ts `accumulatedHandler`).
//
// THE P1 RESIDUE — this phase lands the emit three phases before the runtime that reads
// it (the cluster index is P2, the worker wiring P3), so every clustered source still
// carries ONE warning saying so. Design §7: at no point between P1 and P4 does a
// clustered style convert with no diagnostic. P4 shrinks it to the real residue.

import { CLUSTER_KEY } from '../ir/source-cluster'
import { exprToXgis } from './expressions'

/** The Mapbox source-level clustering fields, as they arrive from style JSON. */
interface MapboxClusterFields {
  cluster?: unknown
  clusterRadius?: unknown
  clusterMaxZoom?: unknown
  clusterMinPoints?: unknown
  clusterProperties?: unknown
}

const declared = (v: unknown): boolean => v !== undefined && v !== null

/**
 * The `cluster*` lines for one GeoJSON source block, or `[]` when the source declares
 * no usable clustering. Pushes its own diagnostics onto `warnings`.
 */
export function convertSourceCluster(id: string, src: unknown, warnings: string[]): string[] {
  const cfg = src as MapboxClusterFields
  if (cfg.cluster !== true) {
    const tuning = (
      [
        [CLUSTER_KEY.radius, cfg.clusterRadius],
        [CLUSTER_KEY.maxZoom, cfg.clusterMaxZoom],
        [CLUSTER_KEY.minPoints, cfg.clusterMinPoints],
        [CLUSTER_KEY.properties, cfg.clusterProperties],
      ] as const
    )
      .filter(([, v]) => declared(v))
      .map(([k]) => k)
    if (tuning.length > 0) {
      warnings.push(
        `GeoJSON source "${id}" declares ${tuning.join(' / ')} without \`cluster: true\` — ` +
          `MapLibre reads those fields only while clustering is ON, so nothing is emitted and ` +
          `every point stays individual. Add "cluster": true to switch clustering on.`,
      )
    }
    return []
  }

  const lines = [`  ${CLUSTER_KEY.on}: true`]
  emitNumeric(id, CLUSTER_KEY.radius, cfg.clusterRadius, false, lines, warnings)
  // `clusterMaxZoom` is the ONE axis MapLibre rounds (geojson_source.ts:251-257);
  // `clusterMinPoints` it uses as-is inside `numPoints >= minPoints`, so a fractional
  // 2.4 means "3 or more" there and rounding it here would change that meaning.
  emitNumeric(id, CLUSTER_KEY.maxZoom, cfg.clusterMaxZoom, true, lines, warnings)
  emitNumeric(id, CLUSTER_KEY.minPoints, cfg.clusterMinPoints, false, lines, warnings)
  const entries = convertClusterProperties(id, cfg.clusterProperties, warnings)
  if (entries.length > 0) {
    lines.push(`  ${CLUSTER_KEY.properties}: { ${entries.join(', ')} }`)
  }
  warnings.push(
    `GeoJSON source "${id}" — the clustering options are now carried into the IR, but the ` +
      `tiling worker builds no cluster index yet (T3 P2/P3 of the clustering track), so the ` +
      `points are not aggregated and each feature still draws where the data puts it.`,
  )
  return lines
}

/** One numeric cluster option. `key` names both the Mapbox field read and the `.xgis`
 *  line written — they are the same string (see the header), so a diagnostic quotes what
 *  the author typed. A value the `.xgis` grammar cannot round-trip — anything that is not
 *  a finite number ≥ 0, since a negative parses as a `UnaryExpr` that `lowerSource`'s
 *  `NumberLiteral` match drops — is warned about, never emitted. Under `integer` a
 *  fractional input is ROUNDED here and said out loud, matching what MapLibre does to it,
 *  rather than emitting a value the index would silently reinterpret. */
function emitNumeric(
  id: string,
  key: string,
  raw: unknown,
  integer: boolean,
  lines: string[],
  warnings: string[],
): void {
  if (!declared(raw)) return
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) {
    warnings.push(
      `GeoJSON source "${id}" ${key} must be a finite number ≥ 0 (got ` +
        `${JSON.stringify(raw)?.slice(0, 40) ?? typeof raw}); dropped — the cluster index ` +
        `will use its own default for that axis.`,
    )
    return
  }
  const value = integer ? Math.round(raw) : raw
  if (value !== raw) {
    warnings.push(
      `GeoJSON source "${id}" ${key} ${raw} is not an integer; emitted as ${value} ` +
        `(MapLibre rounds it the same way). Declare a whole number to be explicit.`,
    )
  }
  lines.push(`  ${key}: ${value}`)
}

/** `{ key: [operator, mapExpr] }` → the `{ "key": { map: …, reduce: … } }` fragments, in
 *  declaration order. A key whose pair is malformed — or whose map/reduce expression the
 *  converter cannot express in xgis — is DROPPED with its own clause naming it, rather
 *  than failing the style: the source then clusters with that key absent, which is the
 *  degradation the design (§4.3) chose over rejecting a legal-but-unconvertible style. */
function convertClusterProperties(id: string, raw: unknown, warnings: string[]): string[] {
  if (!declared(raw)) return []
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `GeoJSON source "${id}" clusterProperties must be an object of ` +
        `{ key: [operator, mapExpression] } entries (got ${typeof raw}); all cluster ` +
        `aggregation dropped.`,
    )
    return []
  }
  const out: string[] = []
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      warnings.push(
        `GeoJSON source "${id}" clusterProperties key "${key}" is not an ` +
          `[operator, mapExpression] pair; dropped — that key will be absent from every ` +
          `cluster feature.`,
      )
      continue
    }
    const [operator, mapExpression] = entry as [unknown, unknown]
    const map = exprToXgis(mapExpression, warnings)
    // MapLibre's own expansion: a bare operator string becomes the three-element reduce
    // over the running aggregate; anything else is already the full reduce expression.
    const reduce = exprToXgis(
      typeof operator === 'string' ? [operator, ['accumulated'], ['get', key]] : operator,
      warnings,
    )
    if (map === null || reduce === null) {
      warnings.push(
        `GeoJSON source "${id}" clusterProperties key "${key}" dropped — its ` +
          `${map === null ? 'map' : 'reduce'} expression did not convert to xgis (see the ` +
          `expression warning above); that key will be absent from every cluster feature.`,
      )
      continue
    }
    out.push(`${JSON.stringify(key)}: { map: ${map}, reduce: ${reduce} }`)
  }
  return out
}
