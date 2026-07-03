// ═══ Source-side validation pre-walks for convertMapboxStyle ═══
//
// Pure functions lifted out of mapbox-to-xgis.ts so the orchestrator
// stays a single page. Each pushes its diagnostics into the shared
// `warnings` array in the SAME order the inlined code did — the
// converter-warning-coverage + conversion-notes tests pin that order.

import { sanitizeId } from './utils'

/** Pre-walk: source minzoom > maxzoom inversion + out-of-range bounds.
 *  Mirror of the per-layer zoom checks. A source declaring
 *  `{ minzoom: 10, maxzoom: 4 }` has an empty servable-zoom range;
 *  every tile request to it produces a 404 / empty payload and the
 *  dependent layers stay blank. Common typo when copying source
 *  definitions between styles. */
export function validateSourceZoom(sourcesObj: Record<string, unknown>, warnings: string[]): void {
  for (const [sid, src] of Object.entries(sourcesObj)) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) continue
    const mn = (src as { minzoom?: unknown }).minzoom
    const mx = (src as { maxzoom?: unknown }).maxzoom
    if (typeof mn === 'number' && typeof mx === 'number' && mn > mx) {
      warnings.push(
        `Source "${sid.slice(0, 60)}" has minzoom=${mn} > maxzoom=${mx} — empty servable-zoom range; every dependent layer will render blank.`,
      )
    }
    // Out-of-range source zoom mirrors the per-layer check below. A
    // typo'd `maxzoom: 30` here would make the tile selector clamp
    // silently; surface so the author sees the gap.
    if (typeof mn === 'number' && (mn < 0 || mn > 24)) {
      warnings.push(
        `Source "${sid.slice(0, 60)}" minzoom=${mn} is outside Mapbox spec range [0, 24]; tile selector clamps so the source serves as if minzoom=${Math.max(0, Math.min(24, mn))}.`,
      )
    }
    if (typeof mx === 'number' && (mx < 0 || mx > 24)) {
      warnings.push(
        `Source "${sid.slice(0, 60)}" maxzoom=${mx} is outside Mapbox spec range [0, 24]; tile selector clamps so the source serves as if maxzoom=${Math.max(0, Math.min(24, mx))}.`,
      )
    }
  }
}

/** Pre-walk for source-id sanitization collisions. Raw-id duplicates
 *  are impossible (Object.entries dedups by key), but `sanitizeId`
 *  can collapse distinct raw ids (`world-tiles` / `world_tiles` both
 *  become `world_tiles`); the emitted xgis carries two `source
 *  world_tiles { … }` blocks and runtime registers only the last —
 *  every layer referencing the FIRST raw id falls back to the
 *  overriding second source's tiles silently. Mirror of the layer-id
 *  collision pre-walk. */
export function validateSourceIdCollisions(
  sourcesObj: Record<string, unknown>,
  warnings: string[],
): void {
  const seenSourceSanitized = new Map<string, string>()
  for (const id of Object.keys(sourcesObj)) {
    const sanitized = sanitizeId(id)
    const collidedWith = seenSourceSanitized.get(sanitized)
    if (collidedWith !== undefined && collidedWith !== id) {
      warnings.push(
        `Source id "${id.slice(0, 60)}" sanitizes to "${sanitized}" — collides with another source "${collidedWith.slice(0, 60)}"; emitted blocks will share an identifier and later wins.`,
      )
    } else {
      seenSourceSanitized.set(sanitized, id)
    }
  }
}
