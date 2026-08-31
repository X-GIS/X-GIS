// ═══ Cluster feature properties — the map/reduce aggregation and the synthetic four ═══
//
// `clusterProperties` reaches here as parsed xgis expression PAIRS (`ir/source-cluster.ts`
// `ClusterProperty`), never as folded values — a `map` is evaluated per point and a
// `reduce` per merge, so there is nothing to fold. They run through the compiler's own
// `evaluate()` with `accumulated` injected as a reserved key, which is design §4.3's lane
// and the reason `ACCUMULATED_KEY` exists (`eval/reserved-keys.ts`).
//
// MapLibre's translation, read from `geojson_worker_source.ts` on 2026-08-24 and recorded
// in design §2, is exact and small, and the two halves are easy to swap by accident:
//
//   map    — evaluates `mapExpression` against ONE POINT'S OWN properties, producing the
//            per-key bag that gets merged.
//   reduce — evaluates with `accumulated` bound to the running value FOR THAT KEY and the
//            ordinary props bag set to the INCOMING MAPPED bag, so `.key` inside the
//            reduce reads what the incoming point contributed, not what the aggregate
//            holds. The two operands come from different places on purpose; reading both
//            from one bag silently turns `accumulated + .sum` into `x + x`.
//
// The accumulator is SEEDED from a clone of the origin record's own mapped bag and the
// origin is then NOT reduced in — mirroring the centroid, which seeds `wx` with the
// origin's weighted position rather than accumulating it twice.

import { evaluate } from '../../eval/evaluator'
import { makeEvalProps } from '../../eval/reserved-keys'
import type { ClusterProperty } from '../../ir/source-cluster'
import { CLUSTER_TAG } from './types'

/** Mapbox `point_count_abbreviated`.
 *
 *  The return type is the point: it is a STRING only in the two ≥1000 branches and the
 *  raw NUMBER below that (design §2 — measured, `index.js:448-462`). A `String(n)`
 *  everywhere would encode `999` as the string `"999"`, which MVT property encoding
 *  faithfully preserves and a `["==", ["get","point_count_abbreviated"], 999]` then
 *  silently fails on. */
export function abbreviatePointCount(count: number): number | string {
  if (count >= 10000) return `${Math.round(count / 1000)}k`
  if (count >= 1000) return `${Math.round(count / 100) / 10}k`
  return count
}

/** Evaluates one source's `clusterProperties` pairs. Constructed only when the source
 *  declares some — `PointCluster` holds `null` otherwise, which keeps the per-point `map`
 *  evaluation off the build path entirely for the overwhelmingly common case. */
export class ClusterPropertyAggregator {
  private readonly keys: string[]
  private readonly entries: Record<string, ClusterProperty>

  constructor(entries: Record<string, ClusterProperty>) {
    this.entries = entries
    this.keys = Object.keys(entries)
  }

  /** One point's own properties → its contribution bag. Always a fresh object, so the
   *  caller never has to guard against aliasing a feature's real property bag (upstream's
   *  `clone && result === original` dance exists only because its `map` is user-supplied). */
  map(props: Record<string, unknown> | null): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const key of this.keys) {
      out[key] = evaluate(this.entries[key].map, makeEvalProps({ props }))
    }
    return out
  }

  /** Merge `incoming` (a mapped bag) into `acc` (the running aggregate), in place. */
  reduce(acc: Record<string, unknown>, incoming: Record<string, unknown>): void {
    for (const key of this.keys) {
      acc[key] = evaluate(
        this.entries[key].reduce,
        makeEvalProps({ props: incoming, accumulated: acc[key] }),
      )
    }
  }
}

/** The tag bag one aggregate feature carries into `encodeMVT`.
 *
 *  Aggregated keys go in FIRST so the synthetic four win a name collision — upstream's
 *  order, and the safe one: a `clusterProperties` key called `point_count` must not be
 *  able to shadow the count every clustering style filters on. */
export function clusterFeatureTags(
  count: number,
  clusterId: number,
  aggregated: Record<string, unknown> | null,
): Record<string, unknown> {
  return {
    ...(aggregated ?? {}),
    [CLUSTER_TAG.isCluster]: true,
    [CLUSTER_TAG.id]: clusterId,
    [CLUSTER_TAG.count]: count,
    [CLUSTER_TAG.abbreviated]: abbreviatePointCount(count),
  }
}
