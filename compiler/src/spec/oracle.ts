// Mapbox / MapLibre style-spec ORACLE.
//
// Purpose: single source of truth for "what does the Mapbox style spec
// say about property X?" Lower.ts / convert/layers.ts / runtime no
// longer hand-code defaults like `?? [0, 0, 0, 1]` — they consult this
// module and get the canonical value MapLibre's own renderer would use.
//
// History: pre-oracle, 11 silent-failure PRs (#94–#105) all had the
// same shape — Mapbox spec was clear about a default / interpolation
// rule, our pipeline ignored or mis-applied it, and the only person
// who noticed was the user staring at iPhone Safari. Conformance
// testing against this oracle closes the loop at build time.
//
// Dependency footprint: @maplibre/maplibre-gl-style-spec is a
// devDependency of the compiler workspace ONLY. It is pure JS,
// ~50 KB on disk, no DOM / native binding. Nothing from this module
// is reachable from the runtime (browser) bundle.

import { latest, createExpression } from '@maplibre/maplibre-gl-style-spec'
import { resolveColor } from '../tokens/colors'
import { hexToRgba } from '../ir/render-node'

/** Mapbox style layer type, narrowed to the ones the spec actually
 *  carries `paint_X` / `layout_X` blocks for. */
export type SpecLayerType =
  | 'fill' | 'line' | 'symbol' | 'circle' | 'fill-extrusion'
  | 'background' | 'heatmap' | 'hillshade' | 'raster'

export type SpecCategory = 'paint' | 'layout'

interface SpecPropertyDef {
  type: 'number' | 'string' | 'boolean' | 'color' | 'array' | 'enum' | 'formatted' | 'resolvedImage' | 'padding' | 'numberArray' | 'colorArray' | 'projectionDefinition' | 'variableAnchorOffsetCollection'
  default?: unknown
  minimum?: number
  maximum?: number
  units?: string
  values?: Record<string, unknown>
  expression?: { interpolated?: boolean; parameters?: string[] }
  'property-type'?: 'constant' | 'data-driven' | 'data-constant' | 'cross-faded' | 'cross-faded-data-driven' | 'color-ramp'
}

/** Lookup the raw spec definition for a single property. Returns
 *  `undefined` if the spec block doesn't exist (e.g.
 *  `layout_background` has no properties) or the property name is
 *  unknown — callers should treat that as "not specced". */
export function specProperty(
  layerType: SpecLayerType,
  category: SpecCategory,
  propertyName: string,
): SpecPropertyDef | undefined {
  const blockKey = `${category}_${layerType}`
  const block = (latest as unknown as Record<string, Record<string, SpecPropertyDef>>)[blockKey]
  return block?.[propertyName]
}

/** The RAW default from the spec — could be a number, string, array,
 *  or undefined. Color defaults arrive as CSS strings (e.g.
 *  `"rgba(0, 0, 0, 0)"`). Use {@link specDefaultColorRgba} when you
 *  want the parsed RGBA tuple. */
export function specDefault(
  layerType: SpecLayerType,
  category: SpecCategory,
  propertyName: string,
): unknown {
  return specProperty(layerType, category, propertyName)?.default
}

/** Parse the spec's color default to an RGBA tuple in [0, 1]. Returns
 *  `null` if the property has no color default or the string is
 *  unparseable. Mirrors the converter's own colour pipeline
 *  (resolveColor → hexToRgba) so test-time comparisons hit the same
 *  numeric values that lower.ts produces. */
export function specDefaultColorRgba(
  layerType: SpecLayerType,
  propertyName: string,
): [number, number, number, number] | null {
  const def = specDefault(layerType, 'paint', propertyName)
  if (typeof def !== 'string') return null
  const hex = resolveColor(def)
  if (!hex) return null
  return hexToRgba(hex)
}

/** Mapbox / MapLibre's reference expression evaluator. Used by the
 *  conformance test suite to run differential checks against our
 *  own `evaluate()` — if the two disagree at any (zoom, feature
 *  props) point, that's a spec-drift bug.
 *
 *  Returns a strongly-typed wrapper from style-spec; callers should
 *  guard on `result === 'success'`. Pass the propertySpec from
 *  {@link specProperty} so the evaluator knows the property's
 *  interpolation / data-driven constraints. */
export { createExpression }

/** Convenience: build a Mapbox expression evaluator for a given
 *  (layerType, category, propertyName) tuple. Throws if the property
 *  isn't in the spec — callers should only invoke this for known
 *  property names. */
export function createSpecExpression(
  layerType: SpecLayerType,
  category: SpecCategory,
  propertyName: string,
  mapboxExpression: unknown,
): ReturnType<typeof createExpression> {
  const propSpec = specProperty(layerType, category, propertyName)
  if (!propSpec) {
    throw new Error(
      `[oracle] unknown spec property: ${category}_${layerType}.${propertyName}`,
    )
  }
  return createExpression(mapboxExpression, propSpec as never)
}

/** Re-export the raw spec object for tests that need to walk every
 *  property of a layer type (e.g. "for every paint_line property,
 *  assert our pipeline handles its default correctly"). */
export { latest as spec }
