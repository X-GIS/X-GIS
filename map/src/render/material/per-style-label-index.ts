// #2309 — the label index behind the fill draw path's dual-instance fallback.
//
// `recordFillDraw` (polygon-fill-material.ts) matches a draw pipeline to its
// Material twin: identity first (`perStyle.get(pipeline)`), then a LABEL
// fallback for the dual-instance Astro-island case, where the recovered
// registry holds the OTHER instance's pipeline objects so identity cannot
// match. That fallback used to walk the whole `perStyle` map.
//
// Measured on OpenFreeMap Bright at z14.7: identity missed on 48 of 52 draws,
// each miss then walked all 160 entries and matched NOTHING — a single-instance
// page has variant-distinct labels, so a miss on identity is a miss on label
// too. 698 iterations a frame that cannot succeed, and the map grows with style
// count (`registerFillMaterials` adds 4 entries per shader variant).

import type { Material, RhiPipelineHandle } from '@xgis/engine'

/** A per-style fill pipeline's Material twin plus the variant it draws. */
export interface PerStyleTwin {
  mat: Material
  variant: number
}

/** An entry of the label index, carrying the key that OWNS the label so the
 *  index reproduces the linear walk it replaces exactly. */
export interface PerStyleLabelOwner {
  key: RhiPipelineHandle
  entry: PerStyleTwin
}

/** Record `key` under its label, first registration wins.
 *
 *  This is the whole equivalence argument for replacing the walk. The walk was:
 *
 *      for (const [k, v] of perStyle) {
 *        if (pipeline === k || (!!pipeline.label && !!k && pipeline.label === k.label)) {
 *          ps = v
 *          break
 *        }
 *      }
 *
 *  run ONLY after `perStyle.get(pipeline)` had already missed — so the identity
 *  arm could never fire and the walk was purely "the first entry whose label
 *  matches". Keeping the FIRST registration per label reproduces that `break`;
 *  re-pointing when the writer IS the current owner reproduces a `.set` that
 *  overwrites an existing key (a live case — the no-pick pipelines ARE the
 *  pickable ones when picking is off, and pipeline-factory documents that
 *  `.set` as idempotent). An empty label is never indexed, matching the walk's
 *  `!!pipeline.label && !!a` guard, so distinct-label pipelines cannot collide.
 *
 *  WRITE-THROUGH at the mutation site, never derived-and-invalidated. The two
 *  per-style maps are written from 12 sites and `.set` on an EXISTING key is a
 *  live case, so `map.size` cannot detect staleness — that is #2165's
 *  cache-silently-retires-a-premise trap. `PipelineFactory.setPerStyle` /
 *  `setPerStyleExtrude` are the single write authority, held to it by
 *  per-style-label-index.test.ts. */
export function indexPerStyleByLabel(
  byLabel: Map<string, PerStyleLabelOwner>,
  key: RhiPipelineHandle,
  entry: PerStyleTwin,
): void {
  const label = key.label
  if (!label) return
  const owner = byLabel.get(label)
  if (!owner || owner.key === key) byLabel.set(label, { key, entry })
}
