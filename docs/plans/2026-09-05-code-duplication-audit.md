# Code duplication audit — 2026-09-05

Mechanical survey of copy-paste duplication across the monorepo, the tooling that now gates
it, and the ranked work queue. Policy and rationale: ADR-0013
(`docs/adr/0013-duplication-ratchet-and-consolidation.md`). Rules for agents: CLAUDE.md §14.

## How to reproduce

```
bun run dup                       # the gate: clones this branch adds over its merge base
bun run dup:report --top 40       # ranked clusters, source only — the debt number lives here
bun run dup:report --tests        # include *.test.ts / *.spec.ts
bun run dup:report --type-insensitive   # jscpd's TypeScript tokenizer lens (see caveat)
bun run dup:shape --top 25        # the Type-2 lens: identifiers erased (report only)
```

Detector: jscpd 5.1.2, `.jscpd.json` = 70 tokens / 5 lines / `mild` (comments and blank
lines skipped), `.ts .tsx .js .mjs` through the JavaScript tokenizer. Scan set:
`scripts/dup-ratchet.ts` `SCAN_ROOTS` (library `src/` trees, `playground/src`,
`playground/dev`, `playground/e2e/helpers`, `site/src`, `scripts`); generated files
(`*.generated.ts`, `__*__/`, `shader-dsl/examples/index.ts`, `*.d.ts`) excluded.

## Numbers

Measured at `67af14c` (main, 2026-09-05 09:00Z). Nothing in the repo pins these numbers —
the gate compares against the merge base and stores no count — so re-run `bun run dup:report`
for the current figure; main moves them by a few clones an hour (it moved from 280 to 278
within the day this was written, without any consolidation).

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
"the FOURTH copy of that gate"); `data/src/earth-surface-fill.ts:78-92` ↔
`map/src/render/under-occluder-renderer.ts:84-98`; `compiler/src/tiler/polygon-tiler.ts:73-153`
↔ `compiler/src/tiler/vector-tiler.ts:1155-1217` (byte-duplicated by an explicit comment that
says "fix both identically, do NOT refactor them together here (§3)" — the comment is the
work item).

One more is real but **invisible to the gate's lens**, so it is listed separately rather than
as a queue row a `bun run dup:report` would reproduce: `compiler/src/tiler/ecef-packing.ts:264-295`
↔ `data/src/sources/polar-cap-ecef-pack.ts:110-135` (the u16 quantize loop, two fragments,
124 tokens at the larger). The two copies differ only in type annotations, so the JavaScript
tokenizer the gate uses does not pair them; `bun run dup:report --type-insensitive` does. It
is the concrete example of what the caveat below costs.

## The shape lens — Type-2 duplication (`bun run dup:shape`, report only)

Everything above is what a TOKEN detector sees: fragments that match once whitespace and
comments are dropped. The sibling families in this repo differ in exactly the identifiers
that say which primitive they serve, so much of them is invisible to it. `dup:shape` mirrors
the tree with every identifier rewritten to `_`, every string to `"S"` and every number to
`0` (TypeScript's own scanner; comments blanked to spaces, so the line numbers below point at
the real files), runs the same `.jscpd.json` over the mirror, and subtracts the pairs the
token pass already covers.

At `6c2fdfd` the 802 raw shape pairs decompose — and the decomposition, not the raw number,
is the result (re-run the command for the current figure; nothing pins it):

| bucket                                                       | pairs   | lines    |
| ------------------------------------------------------------ | ------- | -------- |
| self-overlaps and uniform data tables (filtered — noise)     | 475     | —        |
| extends a pair the gate already flags (same finding, bigger) | 86      | —        |
| **SHAPE-ONLY — duplication the gate cannot see**             | **241** | **3831** |
| the token pass itself, summed the same way                   | 279     | 3673     |

**The gate sees about half the duplicated lines (49%).** Not gated, and it should not be: a
uniform data table, a switch over an enum and a bind-group entry list all shape alike without
being duplication a rewrite could remove (ADR-0013 alternative 9).

Two accounting traps produced wrong numbers here first, and both are recorded in ADR-0013
because both looked like findings: subtracting by equal START LINE instead of range overlap
(erasing identifiers re-anchors a match, so 54 pairs / 1276 lines came back as "invisible" on
file pairs the gate already flagged — inflating shape-only to 294 / 5100), and comparing
jscpd's de-duplicated line stat against a sum of pair lines (3380 vs 3824 → "40%", where one
unit on both sides says 49%). Any figure quoted from this lens should say which accounting it
uses; the mirror's own file/line totals are NOT comparable to the token pass's (`.ts/.tsx`
only, and `mild` skips lines a blanked comment made blank), so no percentage-of-tree is
quoted for it.

**Instrument check (CLAUDE.md §12 — validate against a known positive before believing a
number).** The pair this document already listed as invisible to the gate,
`compiler/src/tiler/ecef-packing.ts:173-215` ↔ `data/src/sources/polar-cap-ecef-pack.ts:38-68`
(43 lines), is found by the shape lens independently — six identical `FILL_*_FLOAT` constants
whose only difference is `field(…)` vs `vertexField(…)`. It survives the corrected
subtraction, and it is absent from `dup:report`. The lens was not tuned to find it.

### What only this lens sees — the shape-only clusters

| #   | cluster (lines · copies · files)                                                              | what is duplicated                                                                                                                                                                          | relation to the token queue                                       |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| S1  | `map/src/shaders/dsl/*` — 273 · 24 · 10                                                       | one DSL body shape across coverage-ramp, under-occluder, extrude-shell-compose, flow-advect, text, hillshade, line, raster, polygon, point                                                  | rows 3 and 5 are two corners of it; the family is 10 files, not 3 |
| S2  | retained DSL fragment tails — 114 · 8 · 5                                                     | arrow-advected, icon-retained, arrow-retained, particle-retained, point                                                                                                                     | rows 2 / 6 / 15, wider                                            |
| S3  | `map/src/render/material/*` — 83 · 10 · 6                                                     | arrow-retained-advected, arrow-retained, icon-retained, heatmap, coverage, point                                                                                                            | row 19, wider (see the note below on the whole-file copies)       |
| S4  | `heatmap-material.ts`, `icon-material.ts`, `text-material.ts` — 77 · 8 · 3                    | the non-retained material tail                                                                                                                                                              | new                                                               |
| S5  | retained DSL — 73 · 11 · 4                                                                    | arrow / particle / circle / icon-retained                                                                                                                                                   | rows 2 / 6 / 15                                                   |
| S6  | `compiler/src/ir/render-node-helpers.ts` — 67 · 11 · 1                                        | eleven copies of one shape inside a single file                                                                                                                                             | new — intra-file; a local table or helper                         |
| S7  | `flow-advect.ts`, `heatmap-blur.ts`, `heatmap-compose.ts` — 60 · 3 · 3                        | the compose-shader body                                                                                                                                                                     | row 3, wider                                                      |
| S8  | `map/src/controller.ts:442-498, 917-954` — 57 · 4 · 1                                         | the drag-anchor capture — dpr clamp, `getBoundingClientRect`, screen-space conversion, then the globe / promotes-to-globe / mercator branch — written at drag-start and again at pointer-up | new                                                               |
| S9  | `data/src/sources/*` ↔ `workers/mvt-worker.ts` — 54 · 3 · 3 and 47 · 2 · 2                    | more of the main-thread/worker twin and the backend boilerplate                                                                                                                             | rows 4 and 14, wider                                              |
| S10 | `circle-retained.ts:55-108` ↔ `particle-retained.ts:75-130` — 54 · 2 · 2, **470 tokens**      | the largest single shape-only fragment in the tree                                                                                                                                          | row 2's family, at its true size                                  |
| S11 | `retained-arrow-packer.ts:91-143` ↔ `retained-icon-packer.ts:94-125` — 53 · 2 · 2             | the per-feature packing loop                                                                                                                                                                | row 10                                                            |
| S12 | `compiler/src/ir/lower-bindings-{fill,line}.ts` — 52 · 4 · 2                                  | binding-lowering per primitive                                                                                                                                                              | new — a sibling family the token pass never linked                |
| S13 | `render/{line,point}-vertex-format.ts`, `sprite/icon-vertex-format.ts` — 50 · 4 · 3           | vertex-format declarations, one file per primitive                                                                                                                                          | new — a table-driven format module (the TableGen move, ADR-0003)  |
| S14 | `shader-dsl/src/core/passes/opt/{const-prop,copy-prop,member-fold}.ts` — 46 · 4 · 3           | the optimizer-pass skeleton                                                                                                                                                                 | rows 1 / 8 / 18 are the walker; this is the pass shape around it  |
| S15 | `compiler/src/tiler/ecef-packing.ts` ↔ `data/src/sources/polar-cap-ecef-pack.ts` — 43 · 2 · 2 | the `FILL_*_FLOAT` layout constants, cross-package                                                                                                                                          | invisible to the gate — the known-positive check above            |
| S16 | `compiler/src/tiler/ecef-packing.ts` ↔ `map/src/render/tile-camera-anchor.ts` — 20 · 4 · 2    | the WGS84 geodetic→ECEF kernel, hand-written                                                                                                                                                | small, cross-workspace — **and worth following, see below**       |

Cross-workspace under the shape lens: compiler↔data, compiler↔map, map↔rhi-webgl2,
map↔pipeline, engine↔map, geo↔map, compiler↔shader-dsl.

### What the gate UNDER-measures — the "extends" bucket, and why it is not counted above

86 shape pairs re-find a pair the gate already flags, larger. The clearest is the retained
draper family: `map/src/render/material/circle-retained-material.ts:12-82` and
`particle-retained-material.ts:14-87` are each a structural copy of
`arrow-retained-material.ts:13-89` covering the whole file below its header — three ~85-line
drapers, one shape, each copy saying "Mirrors RetainedArrowDraper" in its own comment. Queue
row 19 sees 31 scattered lines of that; the shape lens re-finds 77 in one fragment.

Those lines are deliberately NOT in the 3831 above — the gate is not blind to that pair, it
under-measures it, and conflating the two overstates the blind spot. The practical
consequence is the same either way and it is the reason to read this lens before
consolidating: **scope a consolidation from the cluster, not from the corner the gate shows
you.**

### S16 followed up — the small row that named a drifted invariant

S16 is 20 lines and was worth following anyway. `shared/src/ecef.ts` already exports
`lonLatToECEF` and its header states the invariant: "this module is the single cross-package
source of truth for ECEF / WGS84 math … the 'mirrors ecef.ts' hand-copies the tiler used to
carry **are real imports now**." Grepping the kernel the shape lens paired
(`Math.sqrt(1 - E2 * …)`) finds it hand-written in four source files, not two:

| site                                    | binds `a` / `e²` from                                                                                                        |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `map/src/render/raster-grid-trig.ts:50` | `activeBody()` — both                                                                                                        |
| `data/src/line-segment-build.ts`        | `WGS84` (documented choice — its header says mixing frames would compute the anchor on one body and the geometry on another) |
| `compiler/src/tiler/ecef-packing.ts`    | `WGS84` + `EARTH.sphereR` for the separate DSFUN Mercator radius (documented)                                                |
| `map/src/render/tile-camera-anchor.ts`  | `activeBody().sphereR` at :116 but `EARTH.e2` at :137                                                                        |

The arithmetic agrees everywhere; what diverges is which body's constants each one binds — so
this is not "delete three copies and call the helper". `lonLatToECEF` returns a fresh array
and a per-vertex packing loop is a legitimate reason to inline it, and two of the four
document their frame choice. The finding is narrower, and it is **#2564**: the header's stated
invariant is no longer true, and `tile-camera-anchor.ts:116/137` takes its radius from the
active body and its eccentricity from Earth in the same expression — four lines below a
comment stating that the term "must equal `lonLatToECEF(cam)`". It does, on Earth and only on
Earth; on `MOON` the two disagree by 2.1 km horizontally and 6.2 km in z at 45° latitude. No
gate here can see it, because every gate runs on the default body.

### What NO lens here sees — Type-4

A helper re-invented under another name with a different shape is not detected by anything in
this repo, deliberately (ADR-0013 alternative 10 / decision 5: an instrument that cannot be
validated reports zero, and a zero reads as clean). The substitute signal is co-change — files
edited together across history with no import edge between them. Measured over 4224 commits
(the container's clone was shallow at 71 commits and reported ZERO coupled pairs until
`git fetch --unshallow`; that zero was the blind instrument, not a finding): 42 coupled pairs,
22 of them without an import edge. The archetype:

- `shader-dsl/src/core/backends/glsl.ts` ↔ `wgsl.ts` — changed together in 67% of the commits
  touching either, 16 commits, no import edge. One specification emitted twice.
- `rhi-webgl2/src/*` ↔ `rhi-webgpu/src/*` — the same pattern across the backend pair.

Neither is a clone in any detector's sense; both are subsystem-owner decisions (a shared
emitter skeleton, or a recorded deliberate twin). They are tracked on #2561, not as queue rows
— a `jscpd:ignore` marker does not apply to code no detector flags.

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

Every step: EVERY copy in the cluster goes in the same PR — the gate only sees what a
branch adds, so a half-done consolidation is green; the proof is `bun run dup:report`
showing the cluster gone. A guard (ratchet test or an ESLint restriction naming the new
helper) lands with the helper.

**Scope each step from `bun run dup:shape`, not from the row.** The rows above are token
clusters, and for every family in this queue the token pass names a corner of it: row 19 is 3
files and 31 scattered lines of a retained-draper family the shape lens re-finds as whole-file
copies; rows 3 and 5 are two corners of S1's 10 files. Consolidating to the row's extent
leaves survivors, which the gate cannot tell you about — exactly the half-done consolidation
ADR-0013 decision 4 step 3 forbids. Concretely: step 2 starts at the retained drapers scoped
from S3 + the extends bucket (two ~85-line whole-file copies, self-documented as copies — the
cheapest real win in the tree), and these become new independent items — **S6**
(render-node-helpers, intra-file), **S12** (`lower-bindings-*`), **S13** (vertex formats),
**S14** (optimizer-pass skeleton) — with **S15** joining row 17 as cross-workspace work.
