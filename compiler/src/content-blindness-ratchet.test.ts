// ═══ Content-blindness ratchet — @xgis/compiler owns NO geo/tile CONTENT ═══
//
// The charter invariant (#1001): @xgis/compiler is the style→IR compiler. Its job
// is style/expression/color/number vocabulary — NOT cartographic CONTENT. Geo
// content (coordinate formatting, map-projection choice, tile decoding) belongs in
// the content layer: @xgis/geo (coordinate systems / formatting), @xgis/map or
// @xgis/data (tiles). The compiler should be BLIND to what the coordinates MEAN.
//
// Today that boundary is UN-gated, and a 2026-07-11 first-hand audit found it
// already breached, in three shapes:
//   • format/gis-formatter.ts — cartographic coordinate formatters (`formatDMS`,
//     `formatDM`, `formatBearing`, `formatMGRS`, `formatUTM`, the `Axis =
//     'lat' | 'lon'` hemisphere hint). Degrees-minutes-seconds / MGRS / UTM is
//     @xgis/geo's domain, not the style compiler's.
//   • binary/format.ts (+ ir/lower.ts, ir/utility-resolver.ts) — a hardcoded
//     `'mercator'` projection default. WHICH projection is a runtime/content
//     decision; the compiler baking one in is content-awareness. RELOCATED to the
//     runtime in #1001: the compiler now emits the empty-string "unset" sentinel
//     and the runtime supplies the Web Mercator default (map/src/render/
//     viewport-mode-controller.ts `projectionName = 'mercator'`, render-loop /
//     interpreter). The `'mercator'` marker below now guards at baseline 0 against
//     re-introduction. (binary/format.ts also bakes a WGS84/EPSG:4326 CRS
//     assumption — but that lives in a comment, documented-by-omission, so there
//     is no CODE token to count; with the projection default gone, format.ts
//     leaves the baseline entirely.)
//   • input/mvt-decoder.ts (+ input/index.ts) — an MVT/vector-tile decoder pulling
//     the RUNTIME dep `@mapbox/vector-tile`. Tile decoding is data-layer work, so
//     this RELOCATED to @xgis/data in #1001 (decoder + `@mapbox/vector-tile`); the
//     MVT markers below now guard at baseline 0 against re-introduction. (`pbf`
//     stays a compiler dep — the tiler's MVT *encoder* encode-mvt.ts writes PBF,
//     which is the compiler's job; DECODING an external tile is not.)
//
// Why tsc can't catch this: the compiler legitimately manipulates style strings,
// expression tokens, colors and numbers, so a `'mercator'` literal or a
// `formatDMS` function type-checks like any other identifier. Nothing mechanical
// stops MORE geo content from accreting — exactly the un-enforced-boundary gap the
// #991 map ratchets close for their axes (raw-webgpu-ratchet / backend-adapter-
// ratchet); this is the same shape for the compiler's content axis.
//
// JUDGMENT — CLOSED OUT. This once LOCKED a per-file baseline and forbade GROWTH
// while @xgis/compiler still carried cartographic content. Every audited leak has
// now relocated to the content layer: the mvt-decoder + its deps → @xgis/data
// [#1001], the `'mercator'` projection default → the runtime [#1001], and the
// value-APPLY formatters (formatValue + gis/number/date formatters) → @xgis/map
// [#1001, this commit — co-located with text-resolver.ts, the sole per-feature
// consumer]. The compiler keeps only the compile-time PARSE half (spec-parser /
// template-parser + the `FormatSpec` IR type), which carries no geo-content
// marker. The BASELINE is now {} and the gate ASSERTS 0: @xgis/compiler is
// content-BLIND, and any re-introduced geo/tile marker fails below. Closes #1001.
//
// SIGNAL (precise + low-false-positive, comment-stripped so contract PROSE — of
// which the tiler carries a great deal — never counts). We count, per file, only
// these geo/tile markers, each chosen to catch the audited leaks WITHOUT colliding
// with the compiler's legitimate style/color/number/expression vocabulary:
//   • `format(DMS|DM|Bearing|MGRS|UTM)` — the cartographic coordinate-formatter
//     identifiers (impl + every re-export/dispatch site = the full surface). The
//     `format` prefix keeps it off `formatNumber`/`formatString`/`formatDate`/
//     `formatValue` (legitimate compiler formatters) and off the bare `mgrs`/`utm`
//     spec-type strings.
//   • `'lat'` / `'lon'` — ONLY as quoted string literals (the `Axis` union + its
//     N/S·E/W comparisons). Quotes are load-bearing: they keep it off `template`,
//     `latest`, `relate`, `along`, `clone`, … where the bare substrings live.
//   • `'mercator'` — ONLY the quoted projection-name literal (the hardcoded
//     default). Quotes keep it off the tiler's `mercatorToleranceForZoom` line-
//     simplification helper, which is projection MATH, not a content default.
//   • `VectorTile` / `decodeMvtTile` / `MvtDecodeOptions` / `@mapbox/vector-tile`
//     — the MVT-DECODE surface + its runtime dep import. Word-bounded/exact, so
//     they lock the confirmed decoder (input/) and deliberately do NOT drag in the
//     tiler's own MVT *encoder* (geojsonvt/encode-mvt.ts `encodeMVT`) — encoding a
//     compiled tile is the compiler's job; DECODING an external tile is not.
// DELIBERATELY NOT counted: the tiler geometry engine (Mercator/WGS84/ECEF/geodesic
// math, the MVT encoder) and the ir/convert CRS-string plumbing (`EPSG:4326`,
// `WGS84` import). Those are a much larger, contested relocation (the #1001 boundary
// call), not this gate's scope; folding them in would over-match and turn a sharp
// content-leak tripwire into a blunt "geo appears anywhere" grep.
//
// STRICT-equal, BOTH directions, over the UNION of scanned + baseline files
// (mirrors the #991 ratchets and the #996 vacuity guard — a baseline pointing at a
// moved/deleted file must FAIL loudly, never pass green-while-dead):
//   • actual > baseline → NEW geo content in the compiler. Put it in the content
//     layer. Don't grow the baseline (unless a genuinely new, still-blocked site —
//     then add the row with a one-line rationale).
//   • actual < baseline → you relocated content. LOWER the baseline to lock it.
//   • missing file      → the entry is stale; delete/lower it in the same commit.
//
// GPU-free; rides the `test (compiler-blueprint)` CI leg (`vitest compiler/src`).
// Baseline measured 2026-07-11: 42 tokens / 8 files; LOWERED 2026-07-12 to 34 tokens
// / 6 files by the #1001 MVT-decoder relocation (input/mvt-decoder.ts + input/index.ts
// → @xgis/data); LOWERED to 29 tokens / 3 files by the #1001 projection-default
// relocation (binary/format.ts, ir/lower.ts, ir/utility-resolver.ts → the runtime,
// which already defaults to Web Mercator); LOWERED to {} (0 tokens / 0 files) 2026-07-12
// by the #1001 formatter relocation (format/gis-formatter.ts + the formatValue dispatch
// in format/index.ts + the format re-exports in index.ts → @xgis/map, co-located with
// text-resolver.ts). The compiler now owns ZERO geo/tile content — the gate asserts 0.
// Closes #1001.

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const COMPILER_SRC = join(ROOT, 'compiler/src')

function walkTs(absDir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(absDir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.vite') continue
    const p = join(absDir, name)
    if (statSync(p).isDirectory()) out.push(...walkTs(p))
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.d.ts'))
      out.push(p)
  }
  return out
}
const rel = (abs: string): string => relative(ROOT, abs).split('\\').join('/')

// Strip block + line comments so the ratchet tracks CODE, not contract prose.
const stripComments = (s: string): string =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')

// Geo/tile CONTENT markers — precise, non-overlapping, low-false-positive. Each
// targets an audited leak class without matching the compiler's legitimate
// style/color/number/expression vocabulary (see the header for the rationale).
const GEO_MARKERS: RegExp[] = [
  /\bformat(?:DMS|DM|Bearing|MGRS|UTM)\b/g, // cartographic coordinate formatters
  /'lat'|'lon'/g, // lat/lon axis literals (Axis = 'lat' | 'lon')
  /'mercator'/g, // hardcoded map-projection default (quoted literal only)
  /\bVectorTile\b/g, // @mapbox/vector-tile MVT decoder class
  /\bdecodeMvtTile\b/g, // MVT tile-decode entry point
  /\bMvtDecodeOptions\b/g, // MVT decode options type
  /@mapbox\/vector-tile/g, // runtime MVT-decode dependency import
]

function geoContentCount(abs: string): number {
  const code = stripComments(readFileSync(abs, 'utf8'))
  let n = 0
  for (const re of GEO_MARKERS) n += (code.match(re) || []).length
  return n
}

// Per-file geo-content token count. SHRINK-ONLY: a #1001 relocation that moves
// content out of the compiler lowers its number (0 = delete the entry) in the same
// commit. Measured 2026-07-11. Ordered by path.
const BASELINE: Record<string, number> = {}

describe('content-blindness ratchet: compiler/src owns no geo/tile content (#1001)', () => {
  it('per-file geo-content token count equals the shrink-only baseline', () => {
    const actual = new Map<string, number>()
    for (const abs of walkTs(COMPILER_SRC)) {
      const n = geoContentCount(abs)
      if (n > 0) actual.set(rel(abs), n)
    }

    const files = [...new Set([...actual.keys(), ...Object.keys(BASELINE)])].sort()
    const violations: string[] = []
    for (const f of files) {
      const a = actual.get(f) ?? 0
      const b = BASELINE[f] ?? 0
      if (a === b) continue
      if (b === 0)
        violations.push(
          `${f}: ${a} geo-content token(s), not in baseline — geo/tile content belongs in ` +
            `@xgis/geo|map|data, not the style compiler; if genuinely a new still-blocked site, ` +
            `add '${f}': ${a} with a one-line rationale`,
        )
      else if (a === 0)
        violations.push(
          `${f}: baseline ${b} but 0 now — DELETE this baseline entry (content relocated; lock the win)`,
        )
      else if (a > b)
        violations.push(
          `${f}: ${a} > baseline ${b} — NEW geo content in the compiler; relocate to @xgis/geo|map|data, don't grow the baseline`,
        )
      else
        violations.push(
          `${f}: ${a} < baseline ${b} — content relocated; LOWER this baseline to ${a} in the same commit`,
        )
    }

    expect(
      violations,
      `Geo-content footprint of compiler/src drifted from the #1001 ratchet baseline:\n${violations.join('\n')}`,
    ).toEqual([])
  })
})
