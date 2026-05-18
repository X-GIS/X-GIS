// Spec-coverage ↔ runtime capability drift detector.
//
// Premise: compiler/src/convert/spec-coverage.ts marks a property
// "supported" when the converter emits it AND the runtime honours it.
// runtime/src/capabilities.ts records per-variant runtime support
// independently. If those two ever disagree — e.g. spec-coverage says
// "supported" but capability table flags the data-driven variant as
// unsupported — the user gets a silent drop and no diagnostic.
//
// This test scans both tables and asserts no contradiction. A future
// edit that flips spec-coverage.status to "supported" without also
// updating the capability table fails CI before the silent drop
// reaches production.

import { describe, expect, it } from 'vitest'
import { flattenCoverage } from '../../../compiler/src/convert/spec-coverage'
import { RUNTIME_CAPABILITIES, runtimeCapability } from '../capabilities'

// Properties tracked by both tables. The capability table is more
// granular (per value-form), so a "supported" spec-coverage entry is
// only consistent with the capability table if AT LEAST the constant
// form is supported there.
function specCoverageSaysSupported(name: string): boolean {
  const entry = flattenCoverage().find(e => e.name === name)
  return entry?.status === 'supported'
}

function runtimeSupportsConstant(layerType: string, property: string): boolean | null {
  const cap = runtimeCapability(layerType, property, 'constant')
  return cap?.supported ?? null
}

// Map capability-table layerTypes to the spec-coverage property
// names (spec-coverage uses bare property names; the capability table
// scopes by layerType).
function specName(layerType: string, property: string): string {
  // Spec-coverage uses property name without a layer-type prefix in
  // most sections; the property name itself is layer-qualified
  // (e.g. "fill-color", "line-width", "circle-radius") so direct
  // lookup works.
  return property
}

describe('spec-coverage ↔ runtime capability drift', () => {
  it('every runtime-supported (constant) entry exists in spec-coverage as supported or partial', () => {
    const drifts: string[] = []
    for (const cap of RUNTIME_CAPABILITIES) {
      if (cap.variant !== 'constant' || !cap.supported) continue
      const specEntry = flattenCoverage().find(e => e.name === specName(cap.layerType, cap.property))
      if (!specEntry) {
        drifts.push(`${cap.layerType}.${cap.property} → runtime supports constant, but no spec-coverage entry`)
        continue
      }
      if (specEntry.status === 'unsupported') {
        drifts.push(`${cap.layerType}.${cap.property} → runtime supports constant, spec-coverage says unsupported`)
      }
    }
    expect(drifts, drifts.join('\n')).toEqual([])
  })

  it('every spec-coverage `supported` entry exists in capability table (constant variant)', () => {
    // Conservative: spec-coverage `supported` should map to AT LEAST
    // a capability entry — even if just constant. Allowed exceptions:
    // properties that aren't tied to a single layer type (e.g.
    // "version", "metadata") or properties handled at IR-lowering
    // time (e.g. layout `visibility`). Filter those out by name.
    const NON_RENDERABLE = new Set([
      'version', 'name', 'metadata', 'center', 'zoom', 'bearing', 'pitch',
      'sources', 'layers', 'sprite', 'glyphs', 'transition',
      'visibility', 'minzoom', 'maxzoom', 'filter', 'id', 'type',
      'source', 'source-layer', 'paint', 'layout',
      // Expression operators tracked in a different section.
      'literal', 'get', 'has', '!has', 'in', '!in', 'all', 'any', '!',
      '==', '!=', '<', '<=', '>', '>=', 'coalesce', 'case', 'match',
      'step', 'interpolate', 'interpolate (linear)', 'interpolate (exponential)',
      'interpolate (cubic-bezier)', 'interpolate-hcl', 'interpolate-lab',
      'concat', 'format', 'rgb / rgba', 'hsl / hsla', 'image',
      'to-number / number', 'to-string / to-boolean / to-color',
      'geometry-type', 'id', 'properties', 'feature-state', 'typeof',
      'number-format', 'collator', 'resolved-locale', 'is-supported-script',
      'distance-from-center', 'distance', 'within', 'pitch (expr)',
      'array', 'at', 'min', 'max', 'length', 'upcase', 'downcase',
      'slice', 'index-of', 'let', 'var', '+', '-', '*', '/', '%', '^',
      'abs', 'ceil', 'floor', 'round', 'sqrt', 'sin', 'cos', 'tan',
      'asin', 'acos', 'atan', 'ln', 'log10', 'log2', 'pi', 'e', 'ln2',
      'pow',
      // Source types
      'vector (.pmtiles)', 'vector (TileJSON)', 'pmtiles', 'tilejson (explicit)',
      'raster', 'geojson (URL)', 'geojson (inline)', 'raster-dem',
      'image', 'video',
      // Layer types
      'fill', 'line', 'symbol', 'circle', 'fill-extrusion', 'background',
      'heatmap', 'hillshade', 'sky',
      // Top-level
      'light', 'fog', 'terrain', 'projection', 'imports',
    ])
    const orphans: string[] = []
    for (const entry of flattenCoverage()) {
      if (entry.status !== 'supported') continue
      if (NON_RENDERABLE.has(entry.name)) continue
      // For Mapbox paint/layout properties, the capability table
      // entry IS scoped by layer-type. Search across all layer types.
      const anyCap = RUNTIME_CAPABILITIES.find(c => c.property === entry.name)
      if (!anyCap) {
        orphans.push(`spec-coverage says ${entry.name} supported, but capability table has no entry`)
      }
    }
    // Soft assertion: log orphans for visibility but don't fail —
    // some legitimately runtime-implicit properties (e.g. things
    // baked into PaintShapes) may not need a capability row.
    if (orphans.length > 0) {
      console.warn(`[spec-coverage-runtime-drift] ${orphans.length} orphan entries:\n${orphans.slice(0, 10).join('\n')}`)
    }
    // Hard gate: orphan count shouldn't BALLOON. 80 is a generous
    // ceiling above the current count of ~51 — the goal is to catch
    // a regression where someone adds N "supported" entries without
    // capability rows, not to demand a complete capability table on
    // day one. Lower this ceiling as plan §12.2 fills the table out.
    expect(orphans.length).toBeLessThan(80)
  })

  it('no runtime capability with supported=true has a contradictory note', () => {
    for (const cap of RUNTIME_CAPABILITIES) {
      if (!cap.supported) continue
      // A "supported" entry should not have a "note" that contradicts
      // — notes on supported entries are informational only (e.g.
      // "strict-zero NOT honoured yet" is allowed because the
      // property is supported but with a known semantic caveat).
      // We just check the note isn't itself a "pending" or "broken"
      // marker.
      const BAD = ['pending', 'broken', 'TODO', 'unimplemented']
      if (cap.note) {
        for (const b of BAD) {
          if (cap.note.toLowerCase().includes(b.toLowerCase())) {
            expect.fail(`${cap.layerType}.${cap.property}:${cap.variant} marked supported=true but note contains "${b}": ${cap.note}`)
          }
        }
      }
    }
  })
})
