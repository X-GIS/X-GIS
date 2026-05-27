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

import type { ShowCommand } from './render/renderer-types'
import { SYNTHETIC_EARTH_SURFACE_SOURCE } from '../data/sources/synthetic-earth-surface-backend'

export { SYNTHETIC_EARTH_SURFACE_SOURCE }
export const SYNTHETIC_EARTH_SURFACE_LAYER = '__synthetic_earth_surface__'

/** Construct the synthetic earth-surface ShowCommand from the parsed
 *  style background colour. RGBA in straight-alpha unit floats. Callers
 *  later mutate the returned object's `fill` / `resolvedFillRgba` on
 *  setBackgroundFill so the resolveShow cache invalidates by reference. */
export function buildSyntheticEarthSurfaceShow(
  rgba: [number, number, number, number],
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
    paintShapes: {
      fill: { kind: 'constant', value: rgba },
      stroke: null,
      opacity: { kind: 'constant', value: 1 },
      strokeWidth: { kind: 'constant', value: 0 },
      size: null,
    },
  }
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
    fill: { kind: 'constant', value: rgba },
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
