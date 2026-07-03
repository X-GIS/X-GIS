// ═══ Layer-side validation pre-walks for convertMapboxStyle ═══
//
// Pure functions lifted out of mapbox-to-xgis.ts so the orchestrator
// stays a single page. Each pushes its diagnostics into the shared
// `warnings` array in the SAME order the inlined code did — the
// converter-warning-coverage + conversion-notes tests pin that order.

import { sanitizeId } from './utils'

/** Pre-walk: detect minzoom > maxzoom inversions + out-of-range bounds.
 *  Mapbox spec doesn't explicitly forbid `minzoom > maxzoom` but the
 *  runtime tile-selector treats the range as `[min, max]` so an
 *  inverted range produces an empty visible-zoom set — the layer
 *  NEVER renders. Common typo source (swapped min/max, off-by-one when
 *  copying between zoom-band-segmented styles). */
export function validateLayerZoom(layersArr: unknown[], warnings: string[]): void {
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const mn = (l as { minzoom?: unknown }).minzoom
    const mx = (l as { maxzoom?: unknown }).maxzoom
    const lid = (l as { id?: unknown }).id ?? '<unknown>'
    if (typeof mn === 'number' && typeof mx === 'number' && mn > mx) {
      warnings.push(
        `Layer "${String(lid).slice(0, 60)}" has minzoom=${mn} > maxzoom=${mx} — the layer never renders. Swap the values or remove one.`,
      )
    }
    // Mapbox spec: zoom values ∈ [0, 24]. Out-of-range usually
    // indicates a typo. The tile selector silently clamps, so the
    // layer renders the same as if the bound were the nearest valid
    // value — no visual difference but the authored intent is lost.
    if (typeof mn === 'number' && (mn < 0 || mn > 24)) {
      warnings.push(
        `Layer "${String(lid).slice(0, 60)}" minzoom=${mn} is outside Mapbox spec range [0, 24]; tile selector clamps so the layer renders as if minzoom=${Math.max(0, Math.min(24, mn))}.`,
      )
    }
    if (typeof mx === 'number' && (mx < 0 || mx > 24)) {
      warnings.push(
        `Layer "${String(lid).slice(0, 60)}" maxzoom=${mx} is outside Mapbox spec range [0, 24]; tile selector clamps so the layer renders as if maxzoom=${Math.max(0, Math.min(24, mx))}.`,
      )
    }
  }
}

/** Pre-walk: vector-source layers require source-layer.
 *  Mapbox spec: every layer reading from a vector source (vector /
 *  pmtiles / tilejson backends) MUST declare `source-layer`. Without
 *  it the runtime tile decoder has no MVT layer to read from and emits
 *  zero features → blank layer with no diagnostic. */
export function validateLayerSourceLayer(
  layersArr: unknown[],
  sourcesObj: Record<string, unknown>,
  warnings: string[],
): void {
  // Background / raster / raster-dem / image / video / geojson don't
  // need source-layer (the source itself is the data).
  const vectorSourceIds = new Set<string>()
  for (const [sid, src] of Object.entries(sourcesObj)) {
    if (src === null || typeof src !== 'object' || Array.isArray(src)) continue
    const t = (src as { type?: unknown }).type
    if (t === 'vector' || t === 'pmtiles' || t === 'tilejson') {
      vectorSourceIds.add(sid)
    }
  }
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const ltype = (l as { type?: unknown }).type
    if (ltype === 'background' || ltype === 'raster' || ltype === 'hillshade') continue
    const lsrc = (l as { source?: unknown }).source
    if (typeof lsrc !== 'string' || lsrc.length === 0) continue
    if (!vectorSourceIds.has(lsrc)) continue
    const slayer = (l as { 'source-layer'?: unknown })['source-layer']
    if (typeof slayer !== 'string' || slayer.length === 0) {
      const lid = (l as { id?: unknown }).id ?? '<unknown>'
      warnings.push(
        `Layer "${String(lid).slice(0, 60)}" reads from vector source "${lsrc.slice(0, 60)}" but has no source-layer; the runtime decoder will return zero features and the layer renders blank.`,
      )
    }
  }
}

/** Pre-walk: detect layers referencing undeclared sources.
 *  Mapbox spec: every non-background layer's `source` field MUST
 *  reference a declared source in `style.sources`. Real-world failure
 *  mode: a layer copied between styles drags a `source: "osm"`
 *  reference but the destination style has no `osm` source; the
 *  runtime falls back to an empty source / no tiles and the layer
 *  renders blank with no diagnostic. */
export function validateLayerSourceRefs(
  layersArr: unknown[],
  sourcesObj: Record<string, unknown>,
  warnings: string[],
): void {
  const declaredSourceIds = new Set(Object.keys(sourcesObj))
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    const layerType = (l as { type?: unknown }).type
    if (layerType === 'background') continue
    const layerSource = (l as { source?: unknown }).source
    if (typeof layerSource !== 'string' || layerSource.length === 0) continue
    if (!declaredSourceIds.has(layerSource)) {
      const lid = (l as { id?: unknown }).id ?? '<unknown>'
      warnings.push(
        `Layer "${String(lid).slice(0, 60)}" references undeclared source "${layerSource.slice(0, 60)}"; runtime will see no tiles and the layer renders blank.`,
      )
    }
  }
}

/** Pre-walk: detect id collisions.
 *  Two failure modes Mapbox styles trip on in the wild:
 *    1. Duplicate raw id — Mapbox spec requires unique layer ids but
 *       partial / hand-edited JSON breaks this. The second layer's
 *       emitted block silently overrides the first in the runtime's
 *       id-keyed registry.
 *    2. Sanitization collision — distinct raw ids that collapse to the
 *       same sanitized identifier (`a-b` and `a_b` both become `a_b`;
 *       `1km` and `_1km` collide once digit-leading prefix runs). The
 *       emitted xgis has two identical `layer foo { … }` blocks;
 *       downstream lower / IR keys by sanitized id so the later block
 *       wins silently. */
export function validateLayerIdCollisions(layersArr: unknown[], warnings: string[]): void {
  const seenRaw = new Set<unknown>()
  const seenSanitized = new Map<string, unknown>()
  for (const l of layersArr) {
    if (l === null || typeof l !== 'object' || Array.isArray(l)) continue
    if ((l as { type?: unknown }).type === 'background') continue
    const rawId = (l as { id?: unknown }).id
    if (rawId === undefined || rawId === null) continue
    if (seenRaw.has(rawId)) {
      warnings.push(
        `Duplicate layer id "${String(rawId).slice(0, 60)}" — Mapbox spec requires unique layer ids; later block overrides earlier in the runtime registry.`,
      )
    } else {
      seenRaw.add(rawId)
      const sanitized = sanitizeId(typeof rawId === 'string' ? rawId : String(rawId))
      const collidedWith = seenSanitized.get(sanitized)
      if (collidedWith !== undefined && collidedWith !== rawId) {
        warnings.push(
          `Layer id "${String(rawId).slice(0, 60)}" sanitizes to "${sanitized}" — collides with another layer "${String(collidedWith).slice(0, 60)}"; emitted blocks will share an identifier and later wins.`,
        )
      } else {
        seenSanitized.set(sanitized, rawId)
      }
    }
  }
}
