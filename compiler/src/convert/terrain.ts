// ═══ Mapbox top-level `terrain` → xgis `terrain { … }` block (#2095, T2 Phase 2) ═══
//
// Design record: docs/plans/2026-08-24-terrain-track.md §Phase 2. Mapbox v3 and
// MapLibre spell the root block identically — `{ source: <sourceId>, exaggeration?:
// <number> }` (the design doc's Socratic self-critique: "Mapbox v3 and MapLibre spell
// the root block the same way") — so there is exactly one shape to accept, no v3-vs-
// MapLibre branching. The grammar + the leaf validator live in `ir/terrain-block.ts`
// (TERRAIN_KEY + lowerTerrainBlock); this module owns the Mapbox JSON read, the xgis
// text emit, and every author-facing diagnostic — the same split sources-cluster.ts /
// source-cluster.ts already use.
//
// EXAGGERATION IS CONSTANT-ONLY (day-one decision, #2095 issue, recorded with its
// evidence in the PR/report — not re-litigated here): matches the `hillshade-
// exaggeration` precedent (paint-hillshade.ts's addHillshadeScalar) exactly — a
// non-constant (zoom-expression) form warns and drops, keeping the spec default (1)
// rather than half-authoring a shape nothing evaluates per-frame yet (Phase 2 wires no
// consumer at all).
//
// THIS PHASE RENDERS NOTHING NEW. The block is parsed, validated, and emitted so the
// `.xgis` text round-trips through the real grammar — but no renderer displaces
// geometry. Every successful emit therefore also carries the interim diagnostic naming
// that gap, precisely per ADR-0012 §1 (property + reason + alternative) — see
// docs/plans/2026-08-24-terrain-track.md Phase 5 for what closes it.

import { sanitizeId } from './utils'
import { TERRAIN_KEY } from '../ir/terrain-block'

/** Mapbox/MapLibre spec default for `terrain.exaggeration` — suppressed on emit,
 *  mirroring every other spec-default-is-silent property in this converter
 *  (addHillshadeScalar's `def`, the `xyz` scheme default, …): an un-authored or
 *  explicitly-default exaggeration must convert byte-identically. */
const EXAGGERATION_DEFAULT = 1

/** Convert a Mapbox/MapLibre top-level `terrain` block into an xgis `terrain { … }`
 *  block, or `null` when the field is absent or too malformed to express (the caller
 *  emits nothing in that case — same contract as `convertSourceCluster` returning `[]`).
 *  Pushes every diagnostic onto `warnings`, the shared channel every other top-level
 *  converter arm in mapbox-to-xgis.ts already uses. */
export function convertTerrain(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    warnings.push(
      `Style "terrain" must be an object with a "source" field (got ${Array.isArray(raw) ? 'array' : typeof raw}); ignored.`,
    )
    return null
  }
  const t = raw as { source?: unknown; exaggeration?: unknown }
  if (typeof t.source !== 'string' || t.source.length === 0) {
    warnings.push(
      `Style "terrain" is missing a valid "source" (must be the id of a declared raster-dem source, as a non-empty string); the terrain block was not emitted.`,
    )
    return null
  }
  const source = sanitizeId(t.source)
  const lines = ['terrain {', `  ${TERRAIN_KEY.source}: ${source}`]

  if (t.exaggeration !== undefined && t.exaggeration !== null) {
    if (typeof t.exaggeration === 'number' && Number.isFinite(t.exaggeration)) {
      if (t.exaggeration !== EXAGGERATION_DEFAULT) {
        lines.push(`  ${TERRAIN_KEY.exaggeration}: ${t.exaggeration}`)
      }
    } else {
      // Constant-only (day-one decision, matches hillshade-exaggeration): a zoom-
      // expression / array form warns and drops rather than half-authoring a shape
      // nothing evaluates per-frame yet.
      warnings.push(
        `Style "terrain.exaggeration" is a non-constant (zoom-expression) form — not yet supported; dropped, so the runtime default (${EXAGGERATION_DEFAULT}) applies. Author a constant number instead (e.g. "exaggeration": 1.5).`,
      )
    }
  }
  lines.push('}')

  // The interim gap warning (ADR-0012 §1: property + reason + alternative). Every
  // successful emit carries this — Phase 5 (out of scope here) is what removes it.
  warnings.push(
    `Style declares a "terrain" block (source: "${t.source}") — parsed and emitted, but ` +
      `the runtime does not yet displace draped-layer geometry: every layer still ` +
      `renders flat. Add a "hillshade" layer over the same raster-dem source for a ` +
      `shaded-relief approximation until 3D terrain displacement lands.`,
  )
  return lines.join('\n')
}
