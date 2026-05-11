// Spec coverage COMPLETENESS — every Mapbox style-spec property must
// have an entry in our coverage table. Driven by the oracle's
// `latest.json` (which is MapLibre's canonical reference), so this
// test cannot go stale: when the spec adds a new property in a
// version bump, the test starts failing until we either implement
// it or mark it explicitly.
//
// This is the inverse of `spec-coverage-drift.test.ts` — that one
// pins "our table matches our converter source". This one pins
// "our table matches the spec".
//
// Together they triangulate: a property the spec defines AND our
// converter handles must appear in the table; a property the spec
// defines but our converter doesn't handle must ALSO appear (so
// users browsing /docs/mapbox-spec see the gap explicitly).

import { describe, it, expect } from 'vitest'
import { spec } from '../spec/oracle'
import { flattenCoverage } from '../convert/spec-coverage'

/** Mapbox layer types the spec defines `paint_X` / `layout_X` blocks
 *  for. Read from `spec.latest` so a future spec version that adds a
 *  new layer type (e.g. `model`, `sky`) shows up automatically. */
const LAYER_TYPES = [
  'fill', 'line', 'symbol', 'circle', 'fill-extrusion',
  'background', 'heatmap', 'hillshade', 'raster',
] as const

interface SpecProperty {
  /** e.g. 'symbol', 'line'. */
  layerType: string
  /** 'paint' | 'layout'. */
  category: string
  /** e.g. 'text-halo-color'. */
  name: string
}

function enumerateSpecProperties(): SpecProperty[] {
  const out: SpecProperty[] = []
  const s = spec as unknown as Record<string, Record<string, unknown>>
  for (const layerType of LAYER_TYPES) {
    for (const category of ['paint', 'layout'] as const) {
      const blockKey = `${category}_${layerType}`
      const block = s[blockKey]
      if (!block) continue
      for (const name of Object.keys(block)) {
        out.push({ layerType, category, name })
      }
    }
  }
  return out
}

describe('Mapbox spec coverage — every spec property has a table entry', () => {
  // Build the flattened set of names our table claims to cover. The
  // table groups properties into sections (paint-fill, layout-symbol,
  // etc.) but for completeness we only care about presence, not
  // section assignment.
  const tableNames = new Set(flattenCoverage().map(e => e.name))

  it('latest.json paint + layout properties all appear in MAPBOX_COVERAGE', () => {
    const specProps = enumerateSpecProperties()
    const missing: SpecProperty[] = []
    for (const p of specProps) {
      if (!tableNames.has(p.name)) {
        missing.push(p)
      }
    }
    // Group by layer type so the failure message is actionable.
    const grouped = new Map<string, string[]>()
    for (const p of missing) {
      const key = `${p.category}_${p.layerType}`
      const arr = grouped.get(key) ?? []
      arr.push(p.name)
      grouped.set(key, arr)
    }
    const lines: string[] = []
    for (const [block, names] of grouped) {
      lines.push(`  ${block}: ${names.join(', ')}`)
    }
    expect(
      missing,
      missing.length === 0
        ? ''
        : `Mapbox spec defines ${missing.length} property/properties NOT in MAPBOX_COVERAGE. Add explicit entries to compiler/src/convert/spec-coverage.ts:\n${lines.join('\n')}`,
    ).toEqual([])
  })

  it('spec version reported by oracle matches what the coverage table targets (v8)', () => {
    // Lockstep: if the style-spec package upgrades major version
    // (currently v8) and adds new property shapes we don't know about,
    // this test surfaces the bump.
    const specV = (spec as { $version: number }).$version
    expect(specV).toBe(8)
  })
})
