# Code duplication audit — 2026-09-05

Mechanical survey of copy-paste duplication across the monorepo, the tooling that now gates
it, and the ranked work queue. Policy and rationale: ADR-0013
(`docs/adr/0013-duplication-ratchet-and-consolidation.md`). Rules for agents: CLAUDE.md §14.

## How to reproduce

```
bun run dup                       # the gate (CI `lint` job + first precheck step)
bun run dup:report --top 40       # ranked clusters, source only
bun run dup:report --tests        # include *.test.ts / *.spec.ts
bun run dup:report --type-insensitive   # jscpd's TypeScript tokenizer lens (see caveat)
bun run dup:accept                # re-record .jscpd-baseline.json (shrink-only by default)
```

Detector: jscpd 5.1.2, `.jscpd.json` = 70 tokens / 5 lines / `mild` (comments and blank
lines skipped), `.ts .tsx .js .mjs` through the JavaScript tokenizer. Scan set:
`scripts/dup-ratchet.ts` `SCAN_ROOTS` (library `src/` trees, `playground/src`,
`playground/dev`, `playground/e2e/helpers`, `site/src`, `scripts`); generated files
(`*.generated.ts`, `__*__/`, `shader-dsl/examples/index.ts`, `*.d.ts`) excluded.

## Numbers

Measured at `67af14c` (main, 2026-09-05 09:00Z). The committed `.jscpd-baseline.json` tracks
the tree the PR merges into, so its fingerprint count can differ from these figures by the
clones `main` edited in the meantime (at the first merge: 278 fingerprints, +4 −6 against
the 280 below — all four re-fingerprinted pairs sit in files `main` changed).

Source only (898 files at or above the token floor, 232k lines):

| minTokens / minLines | clones | duplicated lines | duplicated tokens |
| -------------------- | ------ | ---------------- | ----------------- |
| 50 / 5               | 601    | 5678 (2.44%)     | 52734 (2.03%)     |
| **70 / 5 (gate)**    | 280    | 3423 (1.47%)     | 34077 (1.31%)     |
| 100 / 5              | 142    | 2177 (0.94%)     | 22228 (0.86%)     |

Tests included at 70 / 5: 2541 files, 528k lines, **1940 clones, 28123 duplicated lines
(5.33%)** — test code holds ~88% of the duplicated lines.

By class at 70 / 5, source only:

| class           | clones | duplicated lines | remedy                                                              |
| --------------- | ------ | ---------------- | ------------------------------------------------------------------- |
| intra-file      | 115    | 1460             | local helper; table-drive the repetition                            |
| intra-dir       | 131    | 1797             | sibling family → generic base or a table it is generated from       |
| intra-workspace | 22     | 280              | package-local module                                                |
| cross-workspace | 12     | 166              | lowest importable package (`shared/`, `geo/`, …) or a recorded twin |

Fragments per workspace (both sides of each pair counted): map 298 / 3969 lines, compiler
106 / 1287, shader-dsl 46 / 732, data 43 / 627, playground 38 / 388, geo 8 / 109, engine
8 / 101, site 6 / 72, blueprint 4 / 58, shared 2 / 41, rhi-webgl2 1 / 22.

Cross-workspace pairs: geo↔shared 2 clones / 41 lines; compiler↔map 3 / 33; engine↔map
3 / 33; data↔map 2 / 27; engine↔rhi-webgl2 1 / 22; compiler↔data 1 / 10.

For scale: 1.5% duplicated lines is LOW by industry norms (5–15% is common). The problem the
owner named is not the ratio — it is the SHAPE: the same sibling families copied per
primitive, which is where fitted code stops being generic. The queue below is ordered by
that shape (copies × lines), not by the ratio.

## The work queue — clusters at 70 / 5, by duplicated lines

Each row is one work item (file one issue per row, CLAUDE.md §9.5). "Remedy" names the
consolidation move and where the helper lives; the dependency-direction ratchet
(`engine/src/dependency-direction-ratchet.test.ts`) decides what may import what.

| #   | cluster (copies · files · lines)                                                                                                                                                                                              | what is duplicated                                                                                                  | remedy                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `shader-dsl/src/core/ir/builder.ts:998-1035` ↔ `shader-dsl/src/core/passes/fp64-lower.ts:840-1020` (8 · 2 · 121)                                                                                                              | the `switch (s.s)` statement walker (`let`/`var`/`assign`/`if`/`for`/`switch`) re-implemented per pass              | ONE `forEachStmt` / `mapStmt` visitor in `shader-dsl/src/core/ir` (LLVM `InstVisitor`); builder, fp64-lower, glsl-sanitize, mangle (row 8) all call it                                                   |
| 2   | `map/src/shaders/dsl/arrow-retained.ts:72-116`, `circle-retained.ts:59-101`, `particle-retained.ts:81-125` (4 · 3 · 88) + rows 6, 15                                                                                          | `project_geo` (RTC + split-float projection) and the per-primitive vertex prologue, one copy per retained primitive | one `retainedProjectGeo()` DSL function + a table-driven retained-primitive module; emitted WGSL/GLSL stays byte-identical (goldens + `_emit-obfuscate-gate`)                                            |
| 3   | `map/src/shaders/dsl/flow-advect.ts`, `heatmap-blur.ts`, `heatmap-compose.ts` (10 · 3 · 81) + row 16 (`engine/src/shaders/dsl/overdraw-compose.ts`, `map/src/shaders/dsl/oit-compose.ts`, `rhi-webgl2/src/compute-webgl2.ts`) | the oversized fullscreen-triangle `vs_full` and the uv y-flip, five DSL modules and one WebGL2 compute shim         | `fullscreenTriangleVs()` in `engine/src/shaders/dsl` (engine → map is a legal edge; rhi-webgl2 cannot import engine — keep its copy as a reasoned `jscpd:ignore` twin, or move the helper to shader-dsl) |
| 4   | `data/src/sources/pmtiles-backend-helpers.ts:42-104` ↔ `data/src/workers/mvt-worker.ts:137-203` (10 · 2 · 79) + row 18                                                                                                        | feature filter / colour / height extraction — the main-thread and worker halves of MVT decode                       | one module imported by both (workers import ES modules); the worker keeps only its message loop. The polygon-tiler ↔ vector-tiler comment already names this class "a known single-authority smell"      |
| 5   | `map/src/shaders/dsl/{arrow-advected,arrow-retained,circle-retained,icon-retained,particle-retained,point,icon,text}.ts` (11 · 8 · 77)                                                                                        | the same fragment-stage tail across eight DSL modules                                                               | one shared DSL helper in `map/src/shaders/dsl/` (the primitives are one family)                                                                                                                          |
| 6   | `arrow-retained.ts:174-204`, `circle-retained.ts:113-134`, `particle-retained.ts:134-165` (9 · 3 · 72)                                                                                                                        | second per-primitive block of the retained family                                                                   | folds into row 2                                                                                                                                                                                         |
| 7   | `playground/src/demos/*.ts:1-9` (10 · 9 · 67)                                                                                                                                                                                 | identical import prologues                                                                                          | a `demos/_shared.ts` re-export; low value — fold when touching the demos                                                                                                                                 |
| 8   | `shader-dsl/src/core/backends/glsl-sanitize.ts:142-205` ↔ `backends/glsl.ts:1302-1560` (12 · 2 · 113 across two clusters)                                                                                                     | the IR rewrite (`rE`/`rS`) traversal, twice inside the GLSL backend                                                 | same visitor as row 1                                                                                                                                                                                    |
| 9   | `map/src/map.ts:4070-4085` ↔ `map/src/source-manager.ts:495-882` (10 · 2 · 61) + `map.ts:1156-3890` intra (4 · 1 · 46)                                                                                                        | source add / refresh bookkeeping duplicated between the façade and the manager                                      | map.ts delegates; the manager is the single authority (it is the extraction that #991 already started)                                                                                                   |
| 10  | `map/src/graphics/retained-{arrow,particle,icon,circle,text}-packer.ts` (18 · 5 · 112 across two clusters)                                                                                                                    | the per-feature packing loop (`packGeoPoint`, size/dpr, bearing tip)                                                | `packRetainedFeatures<D>(spec, layout, extra)` — one generic packer parameterised by the feat-layout table; feat-layouts (`*-retained-feat-layout.ts`) become one `geoPointSlots(base)` table            |
| 11  | `compiler/src/ir/fn-inline.ts:88-139` ↔ `compiler/src/ir/resolve-inputs.ts:137-188` (2 · 2 · 52); `ir/passes/cse.ts:121-156` ↔ `ir/passes/expr-analyze.ts:187-222` (2 · 2 · 36)                                               | expression-tree walkers in the style compiler                                                                       | one `walkExpr` in `compiler/src/ir` (the compiler's own row-1)                                                                                                                                           |
| 12  | `map/src/render/renderer.ts:394-730` intra (10 · 1 · 79 across two clusters)                                                                                                                                                  | bind-group entry lists repeated per pipeline variant                                                                | a `featureBindGroupEntries(...)` builder in `bind-group-registry.ts` (which already owns half of them)                                                                                                   |
| 13  | `map/src/render/vector-tile-renderer.ts` intra (10 · 1 · 76 across two clusters)                                                                                                                                              | per-pass tile iteration prologue inside the 4.7k-line god-file                                                      | extract as #991 decomposes VTR (the LOC ceiling ratchet already tracks the file)                                                                                                                         |
| 14  | `data/src/sources/{geojson-runtime-backend,pmtiles-backend,virtual-catalog-adapter}.ts` + `workers/mvt-worker.ts` (6 · 4 · 43)                                                                                                | source-backend boilerplate (tile-key parse, abort plumbing)                                                         | a backend base in `data/src/sources/` — the family already shares an interface                                                                                                                           |
| 15  | `arrow-retained.ts:44-55`, `circle-retained.ts:25-50`, `particle-retained.ts:41-66` (4 · 3 · 38); `circle-retained.ts:137-169` ↔ `particle-retained.ts:192-224` (2 · 2 · 33)                                                  | more of the retained family                                                                                         | folds into row 2                                                                                                                                                                                         |
| 16  | `geo/src/projection.ts:225-312` intra (6 · 1 · 34); `map/src/shaders/dsl/projections.ts:251-316` intra (4 · 1 · 32)                                                                                                           | per-projection forward/inverse branches                                                                             | table-driven off `projections-table.ts` (already the SoT per ADR-0003) — the TableGen move                                                                                                               |
| 17  | `geo/src/globe.ts:365-395` ↔ `shared/src/mat4.ts:114-146` (2 · 2 · 31)                                                                                                                                                        | `invert4x4`, twice                                                                                                  | geo imports shared (legal edge); delete the geo copy                                                                                                                                                     |
| 18  | `shader-dsl/src/core/backends/glsl-legalize.ts:195-210`, `passes/opt/{gvn,cse-local,expr-utils}.ts` (6 · 4 · 33)                                                                                                              | structural expression hashing / equality across optimizer passes                                                    | one `exprKey()` in `passes/opt/expr-utils.ts` (which already has a copy)                                                                                                                                 |
| 19  | `map/src/render/material/{arrow,particle,circle}-retained-material.ts` (6 · 3 · 31) + icon                                                                                                                                    | `makeBatchBindGroup` / `draw()` per retained draper                                                                 | a `RetainedDraperBase` or free functions in `render/material/`; the five drapers become thin                                                                                                             |
| 20  | `map/src/render/pipeline-factory.ts:829-1575` intra (4 · 1 · 29); `map/src/shaders/dsl/polygon.ts:595-840` intra (4 · 1 · 30)                                                                                                 | pipeline-descriptor and polygon-variant repetition                                                                  | local helpers; polygon variants are composer-driven already — extend the composer                                                                                                                        |

Cross-workspace items not in the top 20 by lines but each a two-authorities defect:
`compiler/src/ir/render-node-helpers.ts` ↔ `map/src/render/renderer-helpers.ts` ↔
`map/src/feature-helpers.ts` (hex colour parsing — the `parseColor` comment itself calls it
"the FOURTH copy of that gate"); `compiler/src/tiler/ecef-packing.ts` ↔
`data/src/sources/polar-cap-ecef-pack.ts` (the u16 quantize loop); `data/src/earth-surface-fill.ts`
↔ `map/src/render/under-occluder-renderer.ts`; `compiler/src/tiler/polygon-tiler.ts:87-167` ↔
`compiler/src/tiler/vector-tiler.ts:1162-1221` (byte-duplicated by an explicit comment that
says "fix both identically, do NOT refactor them together here (§3)" — the comment is the
work item).

## Test-side duplication (reported, not gated)

At 70 / 5 with tests: 783 clusters, 231 with ≥3 copies. The two largest clusters in the
entire tree are test `arrange` blocks:

- **2084 duplicated lines · 148 copies · 58 files** — the `map/src/render/*-wiring.test.ts`,
  `map/src/sprite/*-wiring.test.ts`, `map/src/text/*-wiring.test.ts` renderer-stub setup
  (`circle-color-wiring.test.ts:23-61` is the archetype).
- **1865 · 99 · 26** — the text pipeline suites (`map/src/text/*.test.ts`) building the same
  glyph/collision fixture.

Remedy class: one fixture builder per family (`map/src/render/__test-support__/` already
exists for one of them), then delete the copies. Different work from the source queue; not
gated (ADR-0013 §3).

## The detector caveat (read before trusting a zero)

jscpd 5's TypeScript tokenizer has a deterministic false-negative mode: a whole, valid
function (`map/src/render/renderer-helpers.ts:35-75`, `parseColor`, 586 tokens) copied
verbatim into a sibling file is NOT reported against the full file, while it IS against the
same file truncated at line 210 or 240–290, and it IS reported by the JavaScript tokenizer
and by jscpd 4. Whole-tree: 29 file-pairs the JavaScript tokenizer finds at 70 tokens that
the TypeScript one misses even at 40. The gate therefore routes `.ts/.tsx` through the
JavaScript tokenizer; recall probe (30 whole exported functions copied into sibling files,
full gate) flagged every copy above the token floor. The TypeScript lens
(`--type-insensitive`) finds 21 additional pairs that differ only in type annotations — use
it for triage, never as the gate. Repro for upstream:

```
mkdir -p /tmp/r/src && cp map/src/render/renderer-helpers.ts /tmp/r/src/a.ts
sed -n 35,75p map/src/render/renderer-helpers.ts > /tmp/r/src/b.ts
cd /tmp/r && jscpd -k 70 -l 5 --format typescript src          # 1 clone (intra-file only)
cd /tmp/r && jscpd -k 70 -l 5 --format javascript --formats-exts javascript:ts src   # 2 clones
```

Known by design: identifier renames and statement reordering are invisible to any
token-level detector; a copied block below 70 tokens is below the floor (measured: a 66- and
a 42-token function among the probes).

## Order of work

1. Rows 1 + 8 + 11 (IR walkers) and row 18 (expression keys) — pure-TS refactors with
   byte-identical emit as the oracle; highest leverage per line, no GPU.
2. Rows 2, 5, 6, 15 (retained DSL family), then 10 and 19 (packers, drapers) — one
   table-driven primitive module; verify with the emit goldens and the retained render
   gates.
3. Row 4 (main-thread/worker MVT twin) and row 14 (source backends).
4. Rows 3, 17 and the cross-workspace list — small, each removes a second authority.
5. Rows 9, 12, 13, 20 ride the existing god-file decomposition (#991); rows 7 and 16 when
   touching those files.

Every step: `bun run dup:accept` shows only removals; a guard (ratchet test or ESLint
restriction naming the new helper) lands with the helper.
