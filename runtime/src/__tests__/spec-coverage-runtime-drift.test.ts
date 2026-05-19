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
      // Grouped operator-set entries in spec-coverage (single coverage
      // row covers multiple closely-related operators).
      'let / var',
      '== / != / < / <= / > / >=',
      '== / != / < / <= / > / >= (legacy form)',
      '+ / - / * / / / %',
      '^ / abs / ceil / floor / round / sqrt',
      'sin / cos / tan / asin / acos / atan',
      'ln / log10 / log2',
      'pi / e / ln2',
      'upcase / downcase',
      'min / max',
      'has / !has',
      'in / !in (legacy + expression form)',
      'all / any / !',
      'match (boolean form)',
      // Layer-type rows that aggregate over all properties of a type
      'symbol (text)',
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
    // Hard gate: orphan count shouldn't BALLOON. Iter 59 lowered
    // ceiling 80 → 10 after capability-table expansion drained the
    // ~51 baseline to 0; iter 72 tightens further to 3 after
    // stable green runs across iter 60-71 confirmed no new orphans
    // accumulate. Future "supported" entries either need a capability
    // row OR an explicit NON_RENDERABLE entry above before the gate
    // passes.
    expect(orphans.length).toBeLessThan(3)
  })

  it('no spec-coverage="supported" entry contradicts a capability row marked unsupported', () => {
    // Strict direction: if spec-coverage claims a property is fully
    // supported but the capability table flags ANY value-form as
    // unsupported, downgrade the spec-coverage to "partial" or
    // expand the capability table to mark it supported. Either way,
    // contradiction = silent drop the user can't easily diagnose.
    //
    // ALLOWED partial-capability for spec-coverage="supported":
    //   - constant variant: MUST be supported (we don't ship a
    //     "supported" claim on a property the runtime drops at
    //     constant time)
    //   - zoom-interp / data-driven: MAY be unsupported (caller
    //     surfaces a per-shape warning); the partial state is
    //     reflected in spec-coverage notes.
    const contradictions: string[] = []
    for (const e of flattenCoverage()) {
      if (e.status !== 'supported') continue
      const cap = RUNTIME_CAPABILITIES.find(c => c.property === e.name && c.variant === 'constant')
      if (!cap) continue // no capability row for this property (e.g. expression operator) — orphan test handles
      if (!cap.supported) {
        contradictions.push(
          `${e.name}: spec-coverage="supported" but capability(constant).supported=false (${cap.layerType}). Demote to "partial" with explanation.`,
        )
      }
    }
    expect(contradictions, contradictions.join('\n')).toEqual([])
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
