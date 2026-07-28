// ═══ TileCatalog — Pure Helpers ═══
// Top-level pure free functions extracted verbatim from tile-catalog.ts
// (no `this`, no module-mutable state, no side effects). Behaviour-
// preserving structural split only; no logic or symbol renames.

import { TILE_LAYOUT_VERSION, TILE_LAYOUT_VERSION_BASE } from './tile-source'

/** Does a backend's declared tile layout differ from the running runtime's?
 *  Backends shipped before the field existed surface as `undefined`, which
 *  means `TILE_LAYOUT_VERSION_BASE`. Used by checkLayoutVersion, which owns
 *  the eviction + one-shot warn this predicate gates. */
export function layoutVersionMismatch(v: number | undefined): boolean {
  return v === undefined
    ? TILE_LAYOUT_VERSION > TILE_LAYOUT_VERSION_BASE
    : v !== TILE_LAYOUT_VERSION
}

/** Bounding union of two lon/lat rectangles. Used by mergeBackendMeta
 *  when multiple backends contribute coverage. */
export function unionBounds(
  a: [number, number, number, number],
  b: [number, number, number, number],
): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]
}
