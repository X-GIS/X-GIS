// ═══ The top-level `terrain` block — lowering leaf (#2095, T2 Phase 2) ═══
//
// Design record: docs/plans/2026-08-24-terrain-track.md §Phase 2. Split out of
// `ir/lower.ts` as its own sibling — same shape as `source-cluster.ts` — because
// `lower.ts` sits at its LOC ceiling with ZERO headroom (1514/1514; R4 in the design
// doc's rejected alternatives). It is also NOT called from `lower.ts`: `TerrainStatement`
// is a Program-level root (like `BackgroundStatement`), and `lower()`'s per-statement
// switch (compiler/src/ir/lower.ts:82) has no `default` case — a Statement kind it
// doesn't list is a silent no-op, exactly how BackgroundStatement already passes through
// today. This phase deliberately wires no consumer (renders nothing new — Phase 5 is
// the displacement work); `lowerTerrainBlock` exists so ONE authority already knows how
// to read a validated {source, exaggeration} out of a parsed block, ready for whoever
// consumes it next, without speculating on that consumer's shape now.
//
// SILENT BY DESIGN, mirroring lowerSourceCluster exactly: this module returns undefined
// for an unusable declaration and never pushes a diagnostic. "The author-facing
// diagnostic belongs to the converter, which still holds the Mapbox JSON that produced
// it" (source-cluster.ts) — here that's convert/terrain.ts. A hand-authored `.xgis`
// terrain block with a missing `source:` degrades to "nothing lowered", never a thrown
// error.

import type * as AST from '../parser/ast'

/** The two property names `terrain { … }` accepts — the one place they are spelled, so
 *  the parser's BlockProperty names, this module's read, and convert/terrain.ts's emit
 *  cannot drift apart (mirrors `source-cluster.ts`'s CLUSTER_KEY). */
export const TERRAIN_KEY = {
  source: 'source',
  exaggeration: 'exaggeration',
} as const

/** A validated terrain block: which raster-dem source it displaces (`source`, an xgis
 *  identifier — a source NAME, not a URL, matching how a layer's `source:` refers to a
 *  declared source), and the optional vertical exaggeration factor. `exaggeration`
 *  constant-only (day-one decision, #2095): matches the `hillshade-exaggeration`
 *  precedent (paint-hillshade.ts's addHillshadeScalar) — the non-constant zoom-
 *  expression form is a converter-level warn+drop, never reaches this shape. */
export interface TerrainBlock {
  source: string
  exaggeration?: number
}

/** Lower a parsed `terrain { … }` block's properties into a {@link TerrainBlock}, or
 *  `undefined` when no usable `source` was declared. Bare `NumberLiteral` /
 *  `Identifier` matches only — the same "what the grammar can round-trip" rule every
 *  other block-property reader in this package follows (mirrors lowerSourceCluster's
 *  NumberLiteral-only radius/maxZoom/minPoints). Property order is not significant;
 *  the last occurrence of a repeated key wins, matching lowerSource's own behaviour for
 *  duplicate source-block keys. */
export function lowerTerrainBlock(
  properties: readonly AST.BlockProperty[],
): TerrainBlock | undefined {
  let source: string | undefined
  let exaggeration: number | undefined
  for (const { name, value } of properties) {
    if (name === TERRAIN_KEY.source && value.kind === 'Identifier') {
      source = value.name
    } else if (name === TERRAIN_KEY.exaggeration && value.kind === 'NumberLiteral') {
      exaggeration = value.value
    }
  }
  if (source === undefined) return undefined
  return exaggeration === undefined ? { source } : { source, exaggeration }
}
