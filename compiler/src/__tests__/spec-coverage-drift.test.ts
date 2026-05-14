// Drift detector for `convert/spec-coverage.ts` against the actual
// converter source files. The goal is "the coverage table doesn't
// silently rot when someone teaches the converter a new Mapbox
// property" — every property name the converter source references in
// a recognisable shape MUST also have an entry in the coverage
// table, and vice versa.
//
// Recognised reference shapes (regex-grep, not AST):
//   - `case 'X':`              inside expression / filter switches
//   - `layout['X']`            inside symbol layer extraction
//   - `paint['X']`             inside paint-to-utilities extraction
//   - `=== 'X'` after `layer.type` / `placement` / `anchor`-shaped vars
//   - `SKIP_REASONS = { X: … }` — layer-type SKIP table
//
// The matcher walks the union of these strings; the table is the
// declared source of truth. New converter cases without a table entry
// fail the test loudly; new table entries without a converter
// reference (with an allowlist for "not-yet-implemented" entries)
// surface as warnings the developer can resolve.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { flattenCoverage, MAPBOX_COVERAGE } from '../convert/spec-coverage'

const HERE = dirname(fileURLToPath(import.meta.url))
const CONVERT_DIR = join(HERE, '..', 'convert')

function readConverterSource(): string {
  const files = ['expressions.ts', 'layers.ts', 'paint.ts', 'sources.ts', 'colors.ts', 'mapbox-to-xgis.ts']
  return files.map(f => readFileSync(join(CONVERT_DIR, f), 'utf8')).join('\n\n')
}

/** Extract Mapbox spec strings the converter source actually references.
 *  Conservative — drops anything that's not a recognisable spec
 *  identifier (lowercase, hyphen-separated, optionally with namespace
 *  like `text-halo-width`). */
function extractReferencedNames(src: string): Set<string> {
  const names = new Set<string>()
  // `case 'X':` — expression / filter switches. Captures any string
  // content so non-alpha ops (==, !=, +, ^, !in, …) get picked up.
  for (const m of src.matchAll(/case\s+['"]([^'"]+)['"]/g)) {
    names.add(m[1]!)
  }
  // `op === 'X'` — handler-by-if pattern (e.g. `if (op === '!in')`
  // outside the main switch).
  for (const m of src.matchAll(/op\s*===\s*['"]([^'"]+)['"]/g)) {
    names.add(m[1]!)
  }
  // `.type === 'X'` — layer-type / source-type discriminator (catches
  // `layer.type === 'fill'`, `src.type === 'raster'`, etc.).
  for (const m of src.matchAll(/\.type\s*===\s*['"]([a-z][a-z0-9-]+)['"]/g)) {
    names.add(m[1]!)
  }
  // Bracket access to any variable using a HYPHENATED key —
  // overwhelmingly a Mapbox property name (`layout['text-field']`,
  // `p['fill-color']`, etc.).
  for (const m of src.matchAll(/\[['"]([a-z][a-z0-9]*-[a-z][a-z0-9-]*)['"]\]/g)) {
    names.add(m[1]!)
  }
  // Bracket access on the layout/paint namespace specifically with a
  // non-hyphenated key (e.g. `layout['visibility']`). The namespace
  // restriction keeps this from matching `obj['type']` noise.
  for (const m of src.matchAll(/(?:layout|paint)\[['"]([a-z][a-z0-9_]*)['"]\]/g)) {
    names.add(m[1]!)
  }
  // SKIP_REASONS table — `circle: '…'`, `heatmap: '…'`, `hillshade: '…'`.
  for (const m of src.matchAll(/SKIP_REASONS[\s\S]{0,400}\}/g)) {
    for (const k of m[0]!.matchAll(/(\w+):\s*['"]/g)) {
      names.add(k[1]!.toLowerCase())
    }
  }
  return names
}

const TABLE_NAMES = (() => {
  const out = new Set<string>()
  for (const e of flattenCoverage()) {
    // The display name can be a list ("== / != / < / <= / > / >=")
    // or a parenthesised disambiguator ("interpolate (linear)"). Pull
    // every distinct operator-shaped token out. Split on whitespace +
    // commas + parens only — NOT on `/`, since `/` is itself an op
    // we need to keep as a token.
    const tokens = e.name.split(/[\s,()]+/).filter(Boolean)
    for (const t of tokens) out.add(t.toLowerCase())
  }
  return out
})()

// Symbols / structural words that appear in the table's display
// labels but never as Mapbox property names. Excluded from the
// drift check. `glyphs` is supported END-TO-END but bypasses the
// converter on the way: the runtime style importer reads
// `style.glyphs` from the raw JSON and forwards to
// XGISMap.setGlyphsUrl(). The converter source has no reference to
// the field by design — runtime parts of the system shouldn't have
// to thread URL state through the xgis-source intermediate.
const TABLE_NOISE = new Set([
  'tilejson', 'pmtiles', 'inline', 'icon-only', 'text', 'and',
  'linear', 'exponential', 'cubic-bezier', 'form', 'boolean',
  'expression', 'legacy', 'url',
  // Same situation as 'glyphs' — supported end-to-end but the URL
  // flow bypasses the compiler converter (importer → runtime setter).
  'glyphs', 'sprite',
])

describe('mapbox spec-coverage drift detector', () => {
  it('every property the converter source references has a table entry', () => {
    const src = readConverterSource()
    const referenced = extractReferencedNames(src)
    const missing: string[] = []
    for (const name of referenced) {
      if (TABLE_NAMES.has(name)) continue
      // Skip Mapbox internal accessor names we know are NOT meant for the
      // public table — `linear`, `exponential` are interpolate CURVE
      // types (their coverage lives under the parent `interpolate`
      // entry). `zoom` is checked separately. Option-bag keys
      // (`min-fraction-digits` / `max-fraction-digits` for number-format)
      // live UNDER their parent expression entry and aren't standalone
      // properties.
      if ([
        'linear', 'exponential', 'cubic-bezier', 'zoom',
        'min-fraction-digits', 'max-fraction-digits',
        // JavaScript typeof results — picked up by the
        // `.type === 'X'` extractor regex when the source has
        // `typeof obj.type === 'string'` (sources.ts:134). Not
        // Mapbox layer / source / expression names.
        'string', 'number', 'boolean', 'object', 'undefined', 'function',
      ].includes(name)) continue
      missing.push(name)
    }
    expect(missing, `Converter source references these Mapbox properties without a coverage table entry — add them to convert/spec-coverage.ts: ${missing.join(', ')}`).toEqual([])
  })

  it('every "supported" table entry actually has a converter reference', () => {
    const src = readConverterSource()
    const referenced = extractReferencedNames(src)
    const orphans: string[] = []
    for (const e of flattenCoverage()) {
      if (e.status !== 'supported') continue
      // Pull the leading word as the canonical lookup key (handles
      // multi-arity entries like "== / != / < / <= / > / >=").
      const head = e.name.split(/[\s,()]+/)[0]!.toLowerCase()
      if (TABLE_NOISE.has(head)) continue
      if (referenced.has(head)) continue
      // Some entries' display label is a phrase ("vector (.pmtiles)" → head "vector").
      // Walk the alternative tokens too.
      const tokens = e.name.split(/[\s,()]+/).map(s => s.toLowerCase()).filter(Boolean)
      if (tokens.some(t => referenced.has(t))) continue
      orphans.push(e.name)
    }
    // Known orphans: properties whose support lives in the lower /
    // emit-commands / runtime path rather than the converter (e.g.
    // text-keep-upright is converted via paint stripping but the
    // table head doesn't match any case). Empty allowlist for now —
    // surfaces as a failing test if any creep in. This is intentional;
    // the table should track converter touchpoints.
    const allowlist = new Set<string>([
      // Top-level structural keys that don't appear as `case` strings:
      'name', 'sources', 'layers',
      // Source type entries are matched as `'vector'`, `'raster'`, etc. in the SCAN
      // but the table display names are parenthesised — accept either form.
      'vector (.pmtiles)', 'vector (TileJSON)', 'geojson (URL)', 'geojson (inline)',
      // Layer-type entries with parenthetical disambiguation.
      'symbol (text)',
      // Special-cased composite operator labels — the underlying ops
      // ('==', '!=', '<', '<=', '>', '>=') ARE all matched by name.
      // The "(legacy form)" variant is the same code path.
      '== / != / < / <= / > / >= (legacy form)',
      'in / !in (legacy + expression form)',
      // Aggregated table labels for arithmetic / math groups — the
      // individual operators ('+', '-', …, 'abs', 'sin', …) match via
      // their `case 'X':` arms.
      '+ / - / * / / / %',
      'min / max',
      '^ / abs / ceil / floor / round / sqrt',
      'sin / cos / tan / asin / acos / atan',
      'ln / log10 / log2',
      'pi / e / ln2',
      'upcase / downcase',
      'to-number / number',
      'to-string / to-boolean / to-color',
      'rgb / rgba',
      'let / var',
      'interpolate (linear)',
      // Curve-type label — Mapbox `["interpolate", ["exponential", N], …]`
      // is detected at paint.ts level by inspecting the curve descriptor
      // shape, not by a `case 'interpolate (exponential)':` arm. Same
      // rationale as the `(linear)` entry above.
      'interpolate (exponential)',
      'match (boolean form)',
      // Indirect handling — `text-variable-anchor` is processed via the
      // text-anchor array path (layers.ts:302) without an explicit
      // bracket access by that exact name.
      'text-variable-anchor',
      // `zoom` is the implicit input to interpolate-by-zoom / step-by-zoom;
      // checked via `input[0] !== 'zoom'` rather than `case 'zoom':`.
      'zoom',
      // TypeScript-typed properties on MapboxLayer — accessed as
      // `layer.type` / `layer.source` / `layer.minzoom` / etc. rather
      // than via string. Drift detection can't see these so we
      // allowlist them; their conversion is exercised by other tests
      // (openfreemap-convert, mapbox-convert).
      'id', 'type', 'source', 'minzoom', 'maxzoom', 'filter',
    ])
    const realOrphans = orphans.filter(o => !allowlist.has(o))
    expect(realOrphans, `Coverage table marks these as supported but the converter source has no matching reference — either the converter regressed or the table needs cleanup: ${realOrphans.join(', ')}`).toEqual([])
  })

  it('every entry has a unique name WITHIN its section (sanity)', () => {
    // Cross-section duplicates ARE expected — `raster` is both a
    // source type and a layer type; `zoom` is both a top-level
    // camera field and an expression accessor. Uniqueness only
    // matters per-section.
    for (const section of MAPBOX_COVERAGE) {
      const seen = new Set<string>()
      const dupes: string[] = []
      for (const e of section.entries) {
        if (seen.has(e.name)) dupes.push(`${section.id}: ${e.name}`)
        seen.add(e.name)
      }
      expect(dupes, `Duplicate names in section ${section.id}`).toEqual([])
    }
  })

  it('flattenCoverage returns at least the major buckets', () => {
    // Sanity that nothing got accidentally deleted from the table.
    const all = flattenCoverage()
    expect(all.length).toBeGreaterThanOrEqual(100)
  })
})
