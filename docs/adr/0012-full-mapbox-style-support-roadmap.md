# ADR-0012: Full Mapbox style-spec support — scope, phasing, and process invariants

- **Status**: Accepted
- **Date**: 2026-08-24
- **Related**: `compiler/src/convert/spec-coverage.ts` (+ `spec-coverage/` sections),
  `scripts/emit-gap-matrix.ts` → `scripts/gap-matrix.md`, `map/src/capabilities.ts`,
  ADR-0004 (verification tiers), issues #1976/#1977/#1978, #1489, #777

## Context

X-GIS converts Mapbox/MapLibre style JSON to xgis (`convertMapboxStyle`). The
2026-08-24 audit ran 9 real styles (OpenFreeMap bright/positron/liberty, MapLibre
demotiles, Carto Dark Matter, VersaTiles Colorful, + e2e fixtures — 943 layers)
through the converter and cross-checked the 243-row spec-coverage table:
195 supported / 17 partial / 16 unsupported / 15 na, with 10 empirically-hit gap
patterns plus 2 silent code-level gaps (non-constant icon-offset, `mapbox://`
scheme pass-through). The owner has directed that the remaining gaps be driven to
support ("모든 스타일 지원", 2026-08-24). That needs a durable definition of DONE,
an ordering, and process rules — not a session-memory plan.

## Decision

### 1. Definition of "full support"

Every spec-coverage row reaches `supported`, or `partial` with a **precise,
warning-backed degradation note**, except the rows excluded below. Silent drops
are defects: every unconverted form must warn with the property name and the
reason. The live status authority is the spec-coverage table + regenerated
`gap-matrix.md` + linked issues — this ADR deliberately carries **no status
column** (a second status authority would drift; see the second-ratchet lesson,
CLAUDE.md §12).

### 2. Excluded by architecture (na stays na)

Reaffirmed as deliberate decisions, not backlog: `fill-sort-key` /
`line-sort-key` / `circle-sort-key` (single-merged-mesh/buffer draw model),
`symbol-avoid-edges` (frame-global cross-tile collision makes it moot),
`feature-state`, `icon-halo-*` (until an SDF sprite source is an actual target),
`distance-from-center` (expression model has no per-frame camera hook — revisit
only if such a hook is ever designed), `metadata` / `version` / `ref`, and
heatmap-only accessors outside heatmap context. Reversing any of these is a new
ADR, not a task.

### 3. Phases

Ordered by user-visible impact per unit of risk; a phase may start before the
previous is 100% closed, but each ITEM ships alone (issue → fail-before corpus →
fix → full gate → gauntlet merge).

**Phase A — converter completeness & diagnostics** (converter-only, small)

- A1 Legacy `{stops}` zoom-function lift + single-stop fold — #1976 (landed via
  PR #1982).
- A2 Silent-gap diagnostics: non-constant `icon-offset` warn+drop; `mapbox://`
  source/sprite/glyphs precise warning — #1977.
- A3 spec-coverage corrections + source-level rows + stale `sources.ts` warning
  texts — #1978.
- A4 `["step", ["zoom"], …]` dasharray: lower to the stepped dash shape the
  runtime already implements (dasharray is STEP-semantic per WS-1).
- A5 `fill-antialias` zoom-expression form: decide in-issue between compile-time
  fold and precise warn (runtime flag is a per-layer uniform lane).

Exit: zero silent drops across the 9-style harvest; every remaining warning
names property + reason + supported alternative.

**Phase B — source-level completeness** (finishes #1489)

- B1 Converter emits `tileSize` / `minzoom` / `maxzoom` into the xgis source
  block (grammar `compiler/src/ir/lower.ts:201-214` and runtime
  `map/src/render/raster-renderer.ts:93-97` already exist; only the emit in
  `sources.ts:337-367` is missing).
- B2 Declared-path wiring: source-manager marker omits maxzoom/minzoom
  (`map/src/source-manager.ts:391-407`); hillshade setParams merge drops maxzoom
  (`hillshade-renderer.ts:418-436` vs `:237`).
- B3 `bounds`: xgis grammar + raster request clip (vector already clips via
  PMTiles/TileJSON metadata).
- B4 `scheme: "tms"`: Y-flip at the selector (`y = 2^z − 1 − y`) + `{-y}`
  template substitution.

Exit: OFM liberty `ne2_shaded` no longer 404s past z6; source properties
round-trip Mapbox → xgis → runtime.

**Phase C — expression/data-driven plumbing** (converter + runtime, medium)

- C1 `symbol-sort-key` expression form → per-feature CollisionItem.sortKey.
- C2 Data-driven/zoom residuals: `fill-opacity` DD, `text-opacity` DD,
  `circle-blur` non-constant, `raster-fade-duration` non-constant,
  `icon-translate` tuple component-interpolation.
- C3 Pattern expression forms (`fill-pattern` / `line-pattern` /
  `fill-extrusion-pattern` per-feature sprite name).
- C4 `distance` / `within` on MVT/PMTiles (`$geometry` injection in the worker
  filter) + LineString/Polygon test geometry.
- C5 `format` per-span typography (font-scale / text-color / text-font /
  vertical-align).

**Phase D — renderer features** (large; each item gets its own design doc under
`docs/plans/` + issue before work starts)

- D1 `text-pitch-alignment` ground projection — the highest-frequency gap (42
  warnings across 9/9 audited styles; every line-placed label resolves to
  `map`). Consumer of `LabelDef.pitchAlignment`.
- D2 `text-optional` / split text-icon collision arbitration (pair contract in
  `text-stage.ts` droppedPairKeys → `icon-stage.ts`).
- D3 Icon layout tail (`icon-text-fit` / `icon-padding` / `icon-keep-upright` /
  `icon-pitch-alignment`) + halos (#777 remainder).
- D4 `circle-pitch-alignment: map`, `circle-translate-anchor: map`.
- D5 `terrain` (raster-dem) — existing roadmap Batch 4.
- D6 `sky` layer + `fog` (post-process pass).
- D7 `text-writing-mode` (CJK vertical; per-glyph rotation pipeline).
- D8 `line-gradient` — precondition: geojson-vt lineMetrics clip-fraction
  tracking (the tiler change is the bulk; PMTiles sources stay out by design).
- D9 `fill-extrusion` ambient occlusion.
- D10 `image` / `video` sources; style `imports` (v3).

### 4. Process invariants (every item, every phase)

1. **Issue before work** (CLAUDE.md §9.5): symptom, root cause at file:line,
   witnesses, exit criteria — cold-resumable.
2. **Fail-before corpus**: each witness reproduced red, then green
   (`legacy-zoom-stops-lift.test.ts` is the pattern).
3. **Byte-identity invariant**: converter output for every audited style that
   does NOT author the touched form must stay byte-identical (snapshot harness);
   §5-gated styles thereby keep the hash-equality rung without a GPU run.
4. **Full gate before commit** (build + full vitest incl. consumers' suites +
   lint), ratchets respected by extraction, never by bump-by-default.
5. **Gauntlet merge** per §11 standing authorization; one item in flight at a
   time.
6. Runtime-touching items (Phases C/D) additionally owe the ADR-0004 real-GPU
   tier where pixels change.

## Consequences

- The spec-coverage table gains rows/notes as items land (A3 first), keeping a
  single live status authority; this ADR stays stable.
- Phase D items are multi-day each and enter one at a time with their own design
  docs; nothing in Phases A-C blocks on them.
- The audit snapshot harness (9 styles) becomes a standing regression fixture
  for every converter change.
