// ═══ Synthetic earth-surface show wiring (Phase 2 PR 2c.3) ═══
//
// Replaces BackgroundRenderer by injecting one synthetic ShowCommand at
// the head of the opaque pass. The show targets the synthetic source
// name registered with the SyntheticEarthSurfaceBackend; the catalog +
// VectorTileRenderer pair owned by this source carry the z=0 ECEF
// earth-surface mesh through the standard polygon ECEF pipeline.
//
// A synthetic show is structurally identical to any compiler-emitted
// ShowCommand: layerName/targetName/fill/paintShapes/extrude/etc. The
// per-frame bucket scheduler resolves opacity + colour via the same
// resolveShow path as every other layer, so debug-overdraw and the
// per-layer log-depth bias work without special-casing.

import type { PropertyShape } from '@xgis/compiler'
import { defaultRasterShapes } from '@xgis/compiler'
import type { ShowCommand } from './render/renderer-types'
import { SYNTHETIC_EARTH_SURFACE_SOURCE } from '@xgis/data'

export { SYNTHETIC_EARTH_SURFACE_SOURCE }
export const SYNTHETIC_EARTH_SURFACE_LAYER = '__synthetic_earth_surface__'

/** Construct the synthetic earth-surface ShowCommand from the parsed
 *  style background colour. RGBA in straight-alpha unit floats. Callers
 *  later mutate the returned object's `fill` / `resolvedFillRgba` on
 *  setBackgroundFill so the resolveShow cache invalidates by reference.
 *
 *  WS-1 — `fillShape` carries a zoom-interpolated `background-color`
 *  (Mapbox `["interpolate", …, ["zoom"], …]`). When provided it becomes
 *  the show's `paintShapes.fill`, which resolveShow/resolveColorShape
 *  already resolves per frame — so the sphere/globe earth-surface fill
 *  follows the zoom curve with no further wiring. `rgba` stays the
 *  static fallback hex (used before the first per-frame resolve and by
 *  the legacy static-hex consumers). When null the fill is the constant
 *  `rgba` as before.
 *
 *  #777 I-E — `pattern` carries the style's `background-pattern` sprite
 *  name. The synthetic show IS the pattern's carrier: it rides the
 *  STANDARD fill-pattern path (render-loop `_resolveFillPatterns` fills
 *  fillPatternUV + fillPatternRepeatM; VTR routes the show to
 *  fillPipelinePatternGround), giving world-anchored (Mercator-metre)
 *  tiling — MapLibre background-pattern semantics — on flat AND globe.
 *  `resolvedFillRgba` stays pre-set, so Stage 1 (sprite centre-pixel
 *  colour) never overwrites the authored background colour under the
 *  pattern. Omitted/null = no pattern field (byte-identical show). */
export function buildSyntheticEarthSurfaceShow(
  rgba: [number, number, number, number],
  fillShape?: PropertyShape<readonly [number, number, number, number]> | null,
  pattern?: string | null,
): ShowCommand {
  return {
    targetName: SYNTHETIC_EARTH_SURFACE_SOURCE,
    sourceLayer: '',
    layerName: SYNTHETIC_EARTH_SURFACE_LAYER,
    fill: rgbaToHex(rgba),
    stroke: null,
    strokeWidth: 0,
    projection: 'mercator',
    visible: true,
    opacity: 1,
    extrude: { kind: 'none' },
    extrudeBase: { kind: 'none' },
    resolvedFillRgba: rgba,
    ...(pattern ? { fillPattern: pattern } : {}),
    paintShapes: {
      fill: { fill: fillShape ?? { kind: 'constant', value: rgba } },
      line: {
        stroke: null,
        strokeWidth: { kind: 'constant', value: 0 },
      },
      circle: { size: null },
      common: { opacity: { kind: 'constant', value: 1 } },
      raster: defaultRasterShapes(),
    },
  }
}

/** #777 I-E — pick the synthetic earth-surface show's carrier colour.
 *  A background with a fill uses it; a PATTERN-ONLY background (Mapbox
 *  `background-pattern` with no `background-color`) still needs the
 *  synthetic show injected as the pattern's carrier, so it falls back to
 *  the Mapbox default background colour (opaque black). No background at
 *  all → null (no synthetic show; the canvas clearValue dominates). */
export function syntheticEarthSurfaceCarrier(
  bg: [number, number, number, number] | null,
  pattern: string | null,
): [number, number, number, number] | null {
  if (bg) return bg
  if (pattern) return [0, 0, 0, 1]
  return null
}

/** Mutate the synthetic show in-place to point at a new fill colour.
 *  Bumps both the legacy `fill` hex (consumed by ResolvedShow's static-
 *  hex fallback) and the typed PropertyShape (read by every shape-aware
 *  consumer). Returns the show for caller-side cache invalidation. */
export function updateSyntheticEarthSurfaceShowFill(
  show: ShowCommand,
  rgba: [number, number, number, number],
): void {
  show.fill = rgbaToHex(rgba)
  show.resolvedFillRgba = rgba
  // Replace the typed shape rather than mutating in place so reference-
  // identity-based resolveShow caches invalidate cleanly.
  show.paintShapes = {
    ...show.paintShapes,
    fill: { fill: { kind: 'constant', value: rgba } },
  }
}

function rgbaToHex(rgba: [number, number, number, number]): string {
  const r = clamp01ToByte(rgba[0])
  const g = clamp01ToByte(rgba[1])
  const b = clamp01ToByte(rgba[2])
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
}

function clamp01ToByte(c: number): number {
  if (!Number.isFinite(c)) return 0
  return Math.max(0, Math.min(255, Math.round(c * 255)))
}
