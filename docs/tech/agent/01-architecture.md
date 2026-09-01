# 01 — Architecture: packages, boundaries, and how they are kept

> Edition: **agent** (dense, citation-first; written to be mined by an AI agent designing a
> new engine). Human-narrative companion: [`../dev/01-architecture.md`](../dev/01-architecture.md).
> All `file:line` references are into this repository at the commit that added this document.

## 1. What the system is

X-GIS is a domain-specific language plus a WebGPU/WebGL2 rendering engine for GIS maps —
"HTML/CSS for maps." A `.xgis` source declares *what* data looks like (sources, layers,
Tailwind-style utility classes, presets, functions, symbols); the compiler decides *how* to
render it (WGSL/GLSL shaders, buffer layouts, render strategy). It renders vector/raster
tiles across eight shader-baked projections (mercator, equirectangular, natural_earth,
orthographic, azimuthal_equidistant, stereographic, oblique_mercator, true-3D globe);
switching projection is a GPU uniform change with **no re-tessellation**
(`geo/src/projections-table.ts`, `docs/architecture/OVERVIEW.md`).

Scale, at the time of writing (non-test source / test code):

| Package | src LOC | src files | test LOC | test files |
|---|---:|---:|---:|---:|
| map | 101,158 | 369 | 124,226 | 681 |
| compiler | 46,022 | 218 | 63,587 | 458 |
| shader-dsl | 27,054 | 104 | 22,854 | 135 |
| data | 17,827 | 71 | 15,850 | 98 |
| rhi-webgpu | 4,849 | 16 | 4,746 | 30 |
| blueprint | 2,667 | 11 | 789 | 9 |
| engine | 2,603 | 12 | 2,442 | 13 |
| rhi-webgl2 | 1,974 | 6 | 1,573 | 13 |
| shared | 1,547 | 11 | 1,557 | 11 |
| pipeline | 1,460 | 11 | 958 | 8 |
| geo | 1,384 | 5 | 2,228 | 14 |
| rhi | 1,108 | 6 | 274 | 2 |
| **library total** | **~209,653** | **840** | **~241,084** | **1,472** |

Test LOC exceeds source LOC (~1.15×) repo-wide. There are additionally 416 Playwright
e2e specs (72,936 LOC) under `playground/e2e/`, of which ~170 run in CI; the rest are
real-GPU/local gates and probes. This ratio is a design choice, not an accident — see
[`09-verification.md`](./09-verification.md).

## 2. The package DAG and the direction rule

The allowed dependency edges are a **literal table in a test**, not a document:
`ALLOWED: Record<string, readonly string[]>` in
`engine/src/dependency-direction-ratchet.test.ts:34-64`. The prose rendering
(`docs/architecture/MODULES.md`) is explicitly labelled as derived from it.

| Package | May import | Owns |
|---|---|---|
| `@xgis/shared` | — | WGS84/ECEF math, planetary `Body`/`EARTH` constants authority, quantization, logging, `safeFetch`, priority queue, dev-assert, mat4 |
| `@xgis/shader-dsl` | — | Content-free shader IR + WGSL/GLSL/CPU-f64 emit, layout source-of-truth (`sot.ts`), intrinsic registry, optimizer passes |
| `@xgis/rhi` | — | GPU interfaces only; never names a native GPU type. Neutral vertex-format + compute contract |
| `@xgis/geo` | shared | `projections-table.ts` (projType authority), projection math, globe/ECEF surface, world scale |
| `@xgis/compiler` | shader-dsl, shared, rhi | Lexer→Parser→`lower()`→IR→`optimize()`→`emitCommands()`; Mapbox style importer; the vector tiler. Emits **no** shader code and makes **no** GPU calls |
| `@xgis/blueprint` | compiler | Visual node editor; catalogue derived from `LANGUAGE_SCHEMA` |
| `@xgis/engine` | rhi, shader-dsl, shared | Content-blind GPU substrate: arenas, `UniformBlock`, `Material`/`executeItems`, `RenderContext`. Neutrality is **compiler-enforced** via `"types": []` in `engine/tsconfig.json` |
| `@xgis/rhi-webgpu` | rhi, shader-dsl | The only package that sees `@webgpu/types` |
| `@xgis/rhi-webgl2` | rhi, shader-dsl | WebGL2 backend, DOM lib types only |
| `@xgis/data` | shared, geo, compiler | Tile catalog/selection/sources, MVT decode, worker pools, polar caps, EPSG reprojection, HDF5 coverage |
| `@xgis/map` | every library layer | Composition root; renderers, camera, text/sprite stages, the shader graphs (`map/src/shaders/dsl/`), `XGISMap` facade. Curated public surface = `map/src/public.ts` |
| `@xgis/pipeline` | shared only | Host-side ETL (ingest→join→transform→encode); zero-dep leaf **beside** the render stack |
| playground, site | exempt | consumers |

Direction is strictly downward and acyclic. `map` is the only package allowed to import
everything; leaves (`shared`, `shader-dsl`, `rhi`, `pipeline`) import nothing. Note that
`map/package.json` lists all `@xgis/*` in **devDependencies** — they are bundled into
`map`'s dist, not runtime peers; `@xgis/map` is the one published-shaped package.

### How the direction rule is enforced (mechanics worth copying)

`engine/src/dependency-direction-ratchet.test.ts`:

- `scanGraph()` walks every workspace's `src`, extracting edges with a regex that
  deliberately also matches **dynamic** `import('@xgis/…')` — a hand audit once missed a
  dynamic-import edge and a package name containing a digit
  (`site/src/content/blog/2026-07-10-the-audit-grep-that-ate-a-digit.md`).
- Assertion (a): **scanner sanity** — two known edges (`engine→rhi`, `map→engine`) must be
  *seen*, otherwise the walker broke and the gate would be vacuously green.
- Assertion (b): no edge outside `ALLOWED ∪ BASELINE`.
- Assertion (c): `BASELINE` (grandfathered violations) may only shrink; a stale entry fails.
- The test lives in `engine/src` *deliberately*, so the CI leg that shards by directory
  actually runs it.

## 3. The boundary-enforcement machine (ratchets)

Governing convention, stated in the ratchet itself: *"a boundary survives only when
violating it is a mechanical CI failure, not a review comment"*
(`dependency-direction-ratchet.test.ts:7-9`). Three ratchet semantics are used, each chosen
deliberately per gate:

1. **Ceiling** (`actual > ceiling` fails) — low friction; permits silent re-growth below
   the ceiling.
2. **STRICT-equal in both directions** (`actual !== baseline` fails) — closing a leak
   forces lowering the baseline *in the same commit*, "locking the win". Used where a leak
   silently reopening between phases would otherwise pass CI
   (`map/src/raw-webgpu-ratchet.test.ts:23-32`).
3. **Assert-zero** — the invariant is achieved; the gate keeps it there.

Two meta-rules apply to every gate:

- **Vacuity guard (the #996 rule).** Any allowlist/baseline keyed on file paths must carry a
  companion assertion that every key still resolves to a real file — path-keyed gates die
  silently when files move (two gates once sat vacuously green for a whole refactor era).
- **Detector liveness.** A gate should prove its own detector sees a known positive and
  ignores a planted decoy (`map/src/architecture-invariants.test.ts:271-281, 413-432`).
  A gate that cannot fail is decoration
  (`site/src/content/blog/2026-07-11-a-gate-that-cannot-fail-is-decoration.md` — a new
  gate was trusted only after breaking the feature on purpose and watching it go red).

### Catalog of structural gates

| Gate | Invariant | Mechanism |
|---|---|---|
| `map/src/loc-ceiling-ratchet.test.ts` (2,300 L) | THE single LOC authority: baselined god-files ≤ per-file ceiling, all other files ≤ 800 | shrink-only high-water `CEILINGS` map; stale-key check; ~2,100 lines of the file are inline rationale per ceiling bump — the gate doubles as a change ledger |
| `engine/src/dependency-direction-ratchet.test.ts` | package DAG | §2 above |
| `map/src/architecture-invariants.test.ts` | six structural gates | see below |
| `compiler/src/content-blindness-ratchet.test.ts` | compiler owns no geo/tile content | comment-stripped marker census; baseline now `{}` — closed out and locked |
| `rhi-webgpu/src/content-blindness-ratchet.test.ts` | backends stay geo/style-blind | marker census over both backend packages; the webgl2 side is at zero so a *future* leak fails |
| `map/src/raw-webgpu-ratchet.test.ts` | map touches the GPU only through the RHI | STRICT-equal per-file count of native `GPU*` tokens; tsc cannot catch this because `@webgpu/types` is legitimately in scope |
| `data/src/raw-webgpu-ratchet.test.ts` | data is GPU-free | same signal, one grandfathered token |
| `map/src/backend-adapter-ratchet.test.ts` | map never reaches into a concrete backend except at the composition root | counts imported symbols from the two backend packages; complements the DAG gate, which *allows* the edge |
| `map/src/backend-identity-ratchet.test.ts` | `backend === 'webgl2'` identity switches shrink toward capability queries (`rhi.caps.*`) | counts `===`/`!==` sites, shrink-only |
| `map/src/projtype-confinement-ratchet.test.ts` | projType dispatch lives only in `geo/src/projections-table.ts` | STRICT-equal union scan of 7 packages; its header records folding a duplicate gate that had been counting *comments* |
| `map/src/forced-cast-ratchet.test.ts` | `as any` / `as unknown as` / `@ts-*` suppressions frozen per file | escape hatches counted on comment-stripped source; `@ts-*` counted at directive position on raw source |
| `map/src/raw-shader-string-ratchet.test.ts` | no hand-authored WGSL/GLSL template literal anywhere in map+engine | empty baseline lock; exists because a prior gate's directory list omitted the two packages that author the most shaders |
| `shader-codegen-srp-ratchet.test.ts` (map + compiler) | compiler never calls the DSL emitters | allowlist must EQUAL offenders — fixing a violation also fails until its entry is deleted |
| `shared/src/earth-literal-ratchet.test.ts` | `shared/src/body.ts` is the only authority for WGS84 constants | regex for the literals (6378137 …) on comment-stripped source; permanent vs migration-temporary allowlist entries distinguished |
| `scripts/paths-filter-semantics.test.ts` | what the CI paths filter *actually* matches | runs the filter library's own matcher against fixture diffs |
| `scripts/render-shard-coverage.test.ts` | a `--shard=k/N` family covers all N | a missing shard leg reports green otherwise |
| `scripts/post-merge-guard.test.ts` | something checks the state that actually landed on main | born from a merge that landed 3m54s before its CI reported failure |
| `playground/src/e2e-specs-load.test.ts` | every e2e spec *loads* | `playwright test --list` (5 s, no browser); first asserts the population is >300 — "a gate that does not prove its own population is the bug it guards against, one level up" |
| `map/src/render/passes/pass-order-parity.test.ts`, `target-role-partition.test.ts` | pass chain built constructively from one order authority | §6 below |

`map/src/architecture-invariants.test.ts` itself asserts, mechanically: (Gate 2) the render
loop imports the map facade as `import type` only, so the runtime cycle cannot re-form;
(Gate 6) `engine/src` has zero `@xgis/map` imports (the terminal invariant of the
core-extraction program); (Gate 7) `engine` has zero `@xgis/geo` imports *and* the old
`engine/src/projection/` directory does not exist; (Gate 8) every package glob in CI's
`code` paths-filter also appears in the `render` filter unless exempted with a written
reason — the gate parses `.github/workflows/test.yml` and asserts the set difference is
empty; (Gate 9) exactly one file may value-import the baked-shader registry, so 24 DSL
emitters stay out of the runtime bundle — with a liveness check that the detector sees a
known value-importer; (Gate 10) every `safeFetch` call site is a registered, classified
async resource with a matching site count (ties into the convergence authority, §5).
The file's header is itself a design record: it names two gates that went vacuously green
on dead paths and two retired as genuine duplicates — one was **dropped rather than faked**.

## 4. Single-authority catalog

The recurring X-GIS failure mode is two sibling paths that must agree drifting apart.
The systematic countermeasure: for each concept, exactly one authority artifact, with every
consumer *deriving* from it, and (where derivation can't be by construction) a gate.

| Concept | Authority | Consumers derive |
|---|---|---|
| projType → behavior | `geo/src/projections-table.ts` `PROJECTIONS` | shader ladder, CPU mirror, world-copy enumeration, tile routing (ADR-0003) |
| geodesy constants | `shared/src/body.ts` `EARTH` | everything; literal ratchet above |
| uniform/vertex layout | `shader-dsl` `sot.ts` + `reflect()` | CPU packers and pipelines read reflection, never hand-computed offsets |
| render pass order | `map/src/render/passes/pass-order.ts` `PASS_CHAIN_ORDER` | pass chain is `ORDER.map(label => PASSES[label])` — constructive |
| LOC budget | `loc-ceiling-ratchet.test.ts` | (a second LOC ratchet once existed; merging the two is the origin of the "second ratchet" lesson) |
| coverage overlap winner | `coverage-source.ts:133` `regionPriority` | readout, drape, arrow suppression all take it as a parameter (ADR-0011) |
| convergence ("is the map settled?") | `map/src/pending-work.ts` `PENDING_WORK_KINDS` | see `docs/architecture/convergence-authority.md` |
| line/polygon shared math | one DSL function per formula (`projections.ts`, `merc-cam-rel.ts`, `log-depth.ts`) | both shaders import the same node graph — see [`04-line-rendering.md`](./04-line-rendering.md) §10 |

The convergence authority document is the cleanest worked example of the philosophy: six
incidents shared one shape — *a new async resource class forgot to join the "is the map
idle" predicate*. The fix was not to collapse the five predicates into one (they compose),
but to make the resource classes an enumerated type: registration is a compile error to
forget where the type system can see it, and a ratchet (Gate 10) where it cannot. Stated
goal G2: an unbounded registration must be *unrepresentable* — bounded by construction.

## 5. ADR digest (decision · rejected · why)

The ADR doctrine (`docs/adr/README.md`): ~80 `AGENTS.md` files capture WHAT (regenerated,
decays slowly); `docs/COORDINATES.md` is the CONTRACT; ADRs capture WHY (decays fastest).
Append-only; supersede, never rewrite; "the strongest ADRs name the gate that fails on
regression."

- **0001 ECEF tile pipeline.** Tiles are packed once on CPU as WGS84-ellipsoid ECEF meters,
  quantized about a per-tile RTC anchor (split hi/lo), and every surface transforms with a
  single `u.mvp` whose projection specifics are baked by the camera. Rejected: dual
  `mvp`/`mvp_ecef` uniforms + a hand-pasted per-surface WGSL projection ladder (it drifted;
  it doubled the uniform write; globe couldn't share a vertex format with flat Mercator).
  Polygon stride went 256→192 B.
- **0002 Geoid split.** Vertices on the WGS84 ellipsoid (Cesium/3D-Tiles parity); camera
  anchor via a spherical helper — the ~21 km sphere/ellipsoid mismatch is **kept**.
  Rejected: unifying the camera onto the ellipsoid — *measured*: 0.67 % north-axis
  compression blew 19 of 24 cells past the ≤1.5 px parity gate. "The risk dominates the
  gain — the residual is already <1.5 px." Recorded gotcha: the globe 3D RTC arm MUST use
  the ellipsoid or the 21 km gap scales with zoom.
- **0003 Shader-DSL single emit + PROJECTIONS as source of truth.** All WGSL is *emitted*
  from one TS DSL sharing one projection graph, and the projections table is the single
  authority everything per-projType derives from. Rejected: the status quo, where the
  "table" was *pinned to* scattered literals rather than being their source — an authority
  inversion. Discriminating evidence: mutating a cull literal in the WGSL string left the
  whole suite green.
- **0004 Two-tier verification.** CI runs only what needs no rasterization (compute +
  compilation); pixel gates run locally on real GPUs. Forced, not preferred (runners have
  no GPU). Note: later *narrowed* by measurement — SwiftShader does run both backends
  headlessly for compile/link/validate/draw correctness; what stays local-only is timing
  and hardware-raster fidelity ([`09-verification.md`](./09-verification.md) §1).
- **0005 Background = synthetic earth-surface tile.** The style background color renders as
  a synthetic z=0 tile mesh through the standard opaque polygon pipeline; the standalone
  `BackgroundRenderer` was **deleted** — it had been a second projection path, a second
  geoid, a second world-copy story, and a second set of seams.
- **0006 Per-projType world-copy enumeration.** `getVisibleWorldCopies` branches on
  projType (Mercator: camera-derived range; periodic flat: static ±2 below zoom 4;
  azimuthal/globe: single world). Why: a world copy is not one decision — tile selection,
  GPU draw, and CPU label projection must enumerate the **same** set or copies desync.
- **0007 Defined-coverage background pass.** A bucket-0 background pass owns the
  whole-viewport clear; the requirement "every viewport pixel has a defined source"
  deliberately outranks MapLibre pixel-parity at letterbox/above-horizon pixels.
- **0008 External-renderer interop = documented contracts, not built.** The three seams an
  integrator cannot assume: fused RTC-relative MVP (no separable view/projection);
  logarithmic depth with per-pixel frag_depth ("do NOT switch off log-depth"); split-float
  ECEF-RTC on a sphere-camera/ellipsoid-vertex geoid, so "this is ECEF" is ambiguous.
- **0009 Frame-invariant uniform block, one producer.** A 272 B struct hand-packed by six
  writers had a field wired into 3 of 6 → far-side geometry leak. Decision: split uniforms
  by **cadence, not by renderer** — a frame-invariant block written once, per-draw data on
  a dynamic-offset ring; "writer-completeness drift becomes unrepresentable" and the guard
  test is deleted. Carried principles: an authority must be **total, not partial**; a
  default must not double as "unset"; verify by domain invariant, not pinned example.
- **0010 Read gridded standards in place.** HDF5/NetCDF/COG/PMTiles are read via HTTP
  range requests; the house container format (`.xgcov`) was **removed**. The transferable
  line: *a READER for a standard is legitimate; TRANSCODING a standard into a house blob is
  not* — a bespoke container loses the ecosystem and range-streamability. "If you're
  writing a magic number, stop." (Paid for twice: `.xgvt`, then `.xgcov`.)
- **0011 Coverage overlap decided by catalogue relevance.** Three consumers each answered
  "who owns this water" separately; the bug was *recency standing in for relevance*. One
  authority function, passed to all three, so they agree by construction; the eviction
  LRU is deliberately untouched (it wants the opposite order). Gate: one test reads all
  three through their real code paths at one probe point.
- **0012 Mapbox style-spec scope.** "Full support" = every spec row `supported`, or
  `partial` with a warning-backed degradation note; silent drops are defects. 15 `na` rows
  are *reaffirmed architecture decisions, not backlog* ("reversing any of these is a new
  ADR, not a task"). The ADR deliberately carries **no status column** — a second status
  authority would drift.

## 6. The render pass chain: a flat list with declared roles, not a DAG

Design stance (`docs/architecture/render-graph-pass-scheduler.md`,
`map/src/render/render-node.ts:3-6`): the pass order is a fixed linear chain, so a
scheduler graph buys nothing; a flat ordered list plus declared resource metadata is
sufficient *and far easier to gate for byte-identity*. The general-DAG option is explicitly
kept open in the doc, unexercised.

`PASS_CHAIN_ORDER` (`map/src/render/passes/pass-order.ts:18-45`) is pure data with zero
imports: `background → atmosphere → flow → opaque → oit → translucent → hillshade → points
→ scene-upscale → labels → heatmap → overdraw-compose → graphics`. Each insertion carries
its ordering reason inline (e.g. flow is a producer and must precede its consumer). The
scheduler is three lines (`map/src/render-loop.ts:501-503`):
`for (const node of this._nodes) if (node.shouldRun(scene)) node.execute(ctx, scene)` —
`shouldRun` must be pure; it runs for every node every frame.

Why order alone is not the contract — the couplings a flat array cannot encode, each
declared as metadata instead:

1. **Split clear ownership** — background owns the whole-viewport *color* clear; opaque's
   first sub-pass owns *depth+stencil+pick* clears.
2. **Feed-forward depth store** — an earlier pass's store-vs-discard depends on whether
   later passes exist (`persistDepth = !isLastOpaque || scene.hasPoints || scene.hasOit`).
3. **Content-conditional MSAA resolve** — `scene.resolveOwner` picks the resolver, but the
   points and label passes resolve unconditionally; "resolve if I am the last color pass"
   inferred from array position would be wrong.
4. **Two render-target domains** — some passes draw to the *resolved* screen view, not the
   MSAA color view, and must run after the resolve barrier; array position cannot express
   that, so it is declared: `OVERLAY_PASSES = ['labels','graphics']` (read `ctx.screen`,
   which the adaptive-DPR ladder may not shrink — "a sounding numeral is not decoration
   that degrades gracefully"), `SEAM_PASSES = ['scene-upscale']` (reads both), and
   `SCENE_PASSES` is **derived, never listed** — a new pass is a scene pass unless it
   declares otherwise, so the sets cannot all forget it (`pass-order.ts:49-77`, pinned by
   `target-role-partition.test.ts`).
5. **Whole-frame modes** — a debug-overdraw mode flips ~5 gates at once; gates are
   cross-cutting, not per-pass booleans.
6. **Transient resource edges** set up by the loop, not the passes.
7. **Per-pass diagnostic scope** — every pass runs inside `ctx.passScope(label, fn)`
   (GPU validation error scope + perf-mark pair), so the label is load-bearing.

The chain is built constructively — `buildRenderNodes(map) =
PASS_CHAIN_ORDER.map(label => adapt(PASSES[label], map))` — so it cannot drift from the
authority; `PASSES[l].label === l` is pinned by a parity test. `adapt()` captures the map,
inverting what used to be a `PassHost = Pick<XGISMap>` type back-edge, so the engine no
longer type-references the map facade ("the Gate-6 ratchet holds by construction — not as
a regex bolt-on"). History: the order was once maintained as **two** hand-copied lists
(native chain + a forced-WebGL2 twin), and that duplication was the actual cause of the
divergence bugs (vanishing labels, missing strokes, double-paint); the twin was deleted.
An OIT pass is registered at its historical slot but runtime-dead (`shouldRun` immutably
false) — a deferred delete, kept visible rather than half-removed.

## 7. The data-to-viz pipeline package: a placement decision worth studying

`@xgis/pipeline` exists because *"rendering is not the gap — data processing is"*: public
data arrives code-keyed, tabular, temporal, geometry-less, and the path is
unzip → parse → normalize → **join to geometry** → aggregate → shape → style; mainstream
libraries own only the last step. Stages: `fromCSV/fromRows` (I/O is host-injected — no
fs/fetch in the package), gazetteer join (centroids authored in WGS84 so the join never
reprojects), a right-sized transform subset (explicitly *not* a dataframe engine), encode
recipes emitting GeoJSON or a typed-array `PointPatch`, and one blessed apply seam into the
map's existing source setters.

The placement decision (recorded with its own refutation history): the first draft depended
on `@xgis/data`'s types and called that "light coupling"; the critique refuted it
(`@xgis/data` ships proj4/pmtiles/earcut and pulls the compiler across 21 files). Final:
`pipeline` depends on `shared` **only**, and nothing depends on it; the public GeoJSON
types moved *down* into `shared` so the claim is true by construction. Rejected: extending
`@xgis/data` (different SRP — but honestly recorded as "one emits into the other", not
"zero overlap", because two *forked* ingest layers would be the repo's #1 recurrence bug);
baking ETL into the compiler (couples two 5-year surfaces prematurely); a general plugin
framework ("infrastructure for a problem we do not have; the right-sized abstraction is a
data loader"). One honest caveat is recorded rather than glossed: the CRS delegation is
real only after a small additive change to the map facade, which punctures the draft's
"zero existing-package change" claim.

## 8. Transferable design rules

1. **Make every boundary a mechanical CI failure, not a review comment.** Docs describing a
   DAG drift; a test containing the DAG cannot.
2. **Pick ratchet semantics per gate**: ceiling for budgets, strict-equal for leaks you are
   burning down (locks wins in the same commit), assert-zero for achieved invariants.
3. **Every path-keyed allowlist needs a vacuity guard** (keys must still resolve), and every
   detector needs a liveness proof (sees a known positive, ignores a planted decoy).
   Break the feature once on purpose before trusting a new gate's green.
4. **One authority per concept; consumers derive.** Where derivation can't be by
   construction, add a single cross-consumer identity gate rather than N pairwise rules.
   Never let a second authority (an index file, a status column, a hand-copied twin list)
   come into existence — that is how divergence bugs are manufactured.
5. **Prefer making drift unrepresentable over guarding it**: split uniforms by write
   cadence with one producer, build the pass chain constructively from the order authority,
   enumerate async resource classes in a type. Then delete the guard test.
6. **Write ADRs for WHY, append-only, each naming the gate that fails on regression.**
   Record rejected alternatives *with the measurement that rejected them* (the geoid ADR
   rejects the "obvious fix" with a number, which is what stops it being re-proposed).
7. **Keep the compiler GPU-free and the substrate content-blind**, and enforce both with
   marker-census ratchets; keep exactly one package that may see native GPU types.
8. **A flat pass list + declared resource roles beats a render-graph scheduler** until you
   actually have dynamic pass topology. Derive the default set ("scene pass unless declared
   otherwise") so new passes can't be forgotten by any of the partitions.
9. **Choose boring, verifiable structure over generality**, but record where the general
   option lives so the upgrade path is planned, not re-litigated.

## 9. Code map

- Package DAG + rationale: `engine/src/dependency-direction-ratchet.test.ts`,
  `docs/architecture/MODULES.md`, `docs/architecture/package-responsibilities.md`
- Structural gates: `map/src/architecture-invariants.test.ts`,
  `map/src/loc-ceiling-ratchet.test.ts`, the `*-ratchet.test.ts` files per package
- ADRs: `docs/adr/0001..0012`, doctrine in `docs/adr/README.md`
- Pass chain: `map/src/render/passes/pass-order.ts`, `pass-chain.ts`,
  `map/src/render/render-node.ts`, `docs/architecture/render-graph-pass-scheduler.md`
- Convergence: `docs/architecture/convergence-authority.md`, `map/src/pending-work.ts`
- ETL: `pipeline/src/index.ts`, `docs/architecture/data-to-viz-pipeline.md`
- Failure archive: `site/src/content/blog/` (74 postmortems; frontmatter `description` is
  the abstract; deliberately no index file — the posts are the single authority)
