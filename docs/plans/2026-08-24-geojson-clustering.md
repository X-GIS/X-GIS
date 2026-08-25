# GeoJSON source clustering (#2009) — design

Owner-approved direction (2026-08-24, "모든 스타일 지원"): drive the remaining
Mapbox/MapLibre style-spec gaps to support. This is the clustering half of #2009 —
`cluster` / `clusterRadius` / `clusterMaxZoom` / `clusterMinPoints` /
`clusterProperties`, the synthetic `point_count` / `point_count_abbreviated` /
`cluster` / `cluster_id` properties, and the `["accumulated"]` accessor. Phase D
of ADR-0012 (§3, §4): a feature-scale item that gets its own design doc and issue
before any code.

Verified state of the tree at design time (2026-08-24, `f0e89d8`): the converter
warns precisely and drops. `compiler/src/convert/sources.ts:496-506` emits
_"GeoJSON source "…" declares clustering …; X-GIS has no point-clustering pipeline
today, so all features render at their authored positions."_, and
`compiler/src/convert/expressions.ts:98-99` routes `["accumulated"]` to
_"Accumulated accessor — clusterProperties pipeline not implemented (clustering is
host-side today)."_ Nothing downstream of the converter knows the word `cluster`:
`compiler/src/tiler/geojsonvt/index.ts:14-16` records the drop as deliberate
("cluster / lineMetrics / debug counters / tileCoords array dropped — none of them
feed the X-GIS render path"), and `AGENTS.md` in that directory repeats it. This
doc supersedes that line for `cluster` only; `lineMetrics` stays ADR-0012 D8's.

## The one-sentence contract

A `type: geojson` source that declares clustering serves, at every zoom, MVT tiles
whose Point features are supercluster-equivalent aggregates carrying `cluster`,
`cluster_id`, `point_count`, `point_count_abbreviated` and every declared
`clusterProperties` key — produced **in the existing tiling worker**, encoded by
the **existing `encodeMVT`**, and consumed by the **existing** decode → property
table → circle/symbol path, with **no** renderer change and **no** new source type.

## 1. The pipeline as it actually is (read before proposing anything)

The default route for every GeoJSON source — URL, inline, custom-loader output —
has been `VirtualPMTilesBackend` since Phase 5f (`map/src/source-manager.ts:523-540`;
the legacy main-thread `GeoJSONRuntimeBackend` survives only behind
`isLegacyGeoJSONOptOut()`, `source-manager.ts:71-85`). The chain:

```
SourceManager._attachGeoJSONViaVirtualPMTiles      map/src/source-manager.ts:768
  → new VirtualPMTilesBackend({ … geojsonvtOptions })   data/src/sources/virtual-pmtiles-backend.ts:88
     → tilingPool.setSource(instanceId, name, geojson, options)   data/src/workers/geojson-tiling-pool.ts:151
        → worker `set-source`  ⇒  geojsonvt(data, options)        data/src/workers/geojson-tiling-worker.ts:120
     → tilingPool.getTile(instanceId, name, z, x, y, key)
        → worker `get-tile`    ⇒  idx.getTile(z,x,y) → encodeMVT(…) → PBF bytes
  → decodeMvtTile (data/src/mvt-decoder.ts) → slices → circle / symbol / fill draws
```

Three properties of that chain decide the whole design:

1. **The worker is already stateful and per-source.** It retains one `GeoJSONVT`
   per `${instanceId}::${sourceName}` and answers per-tile requests against it
   (`geojson-tiling-worker.ts:102-107`). A cluster hierarchy is the same kind of
   object with the same lifetime. Nothing new has to be invented to own it.
2. **`encodeMVT` already accepts exactly the shape supercluster's `getTile`
   produces.** `TransformedTileFeature` is `{ id?, geometry, type, tags }`
   (`compiler/src/tiler/geojsonvt/types.ts:62-67`); supercluster emits
   `{ type: 1, geometry: [[x, y]], tags, id? }`. A cluster index can hand
   `encodeMVT` a `TransformedTile` verbatim — the encoder is not touched.
3. **Cluster properties are just feature tags.** Once `point_count` is a tag it
   reaches expressions through the ordinary MVT property table, so
   `["get","point_count"]` in a `circle-radius` step and
   `["get","point_count_abbreviated"]` in a `text-field` work with no expression,
   binder, or renderer change. The synthetic properties are the whole integration.

There is a second, real consumer of expression evaluation on this side of the
wire: `data/src/eval/filter-eval.ts` already calls the compiler's `evaluate()`
(`compiler/src/eval/evaluator.ts:18`) per feature at MVT decode time. Globals reach
that evaluator through **reserved keys** injected into the property bag —
`CAMERA_ZOOM_KEY`, `CAMERA_PITCH_KEY`, `INPUT_KEY_PREFIX`
(`compiler/src/eval/reserved-keys.ts`, read at `evaluator.ts:28-49`). `accumulated`
is precisely a global of that kind, and this design uses that lane rather than
inventing one.

## 2. The reference semantics we are matching (measured, not remembered)

Read from `mapbox/supercluster@main/index.js` and
`maplibre-gl-js@main/src/source/geojson_worker_source.ts` on 2026-08-24. The parts
that are load-bearing, so a later session does not re-derive them:

- **Hierarchy build.** Index points at `maxZoom + 1`, then for `z = maxZoom … minZoom`
  cluster the previous level's output with radius `r = radius / (extent * 2^z)` in
  unit-square coords, writing a new KD-tree per zoom (`index.js:141-160`, `_cluster`
  at `:325-412`). A zoom whose output count equals its input reuses the parent tree.
- **Cluster admission.** A point becomes a cluster only if
  `numPoints > numPointsOrigin && numPoints >= minPoints` (`:353`). Otherwise it and
  its unprocessed neighbours pass through unclustered (`:395-408`) — note that the
  else-branch _also_ marks neighbours processed, so a below-`minPoints` neighbourhood
  is not re-examined at the same zoom.
- **Centroid.** Weighted by child point counts: `wx / numPoints` (`:354-355, :386-387`),
  not the arithmetic mean of positions.
- **`cluster_id`.** `((i / stride | 0) << 5) + (zoom + 1) + numPoints` (`:361`) — it
  encodes the origin zoom in the low 5 bits and is what `getClusterExpansionZoom` /
  `getChildren` / `getLeaves` decode (`:414-422`). Any id scheme we choose has to
  keep that decodability or those APIs cannot exist later.
- **`point_count_abbreviated`.** `≥10000 → round(n/1000)+"k"`; `≥1000 →
round(n/100)/10 + "k"`; else the **number** `n` (`:448-462`). It is a _string_ only
  in the two ≥1000 branches — a real type asymmetry that a naive `String(n)` gets
  wrong and that MVT property encoding will faithfully preserve.
- **Unclustered output is drift-free.** Single points are emitted from the retained
  `Float64Array` originals, not from the Int32-encoded tree (`:293-297`), because the
  tree stores `(c - 0.5) * 2^30` integers. Our port must keep that split or every
  unclustered point moves by up to ~2 cm at the equator — invisible, and exactly the
  kind of silent divergence CLAUDE.md §5 exists for.
- **Tile query.** `getTile` ranges the zoom's tree over the tile box expanded by
  `radius/extent` on every side, plus two antimeridian wrap arms at `x === 0` and
  `x === z2 - 1` (`:205-230`). It returns `null` for an empty tile.
- **`clusterProperties` → map/reduce.** MapLibre's translation is exact and small
  (`geojson_worker_source.ts:327-363`): for `{ key: [operator, mapExpression] }`,
  the per-point `map` evaluates `mapExpression` against the point's own properties;
  the `reduce` evaluates `operator` — expanded to `[operator, ["accumulated"],
["get", key]]` when `operator` is a bare string like `"+"` / `"max"` — with
  `accumulated` bound to the running value for `key` and `["get", key]` reading the
  _incoming mapped_ bag. Both forms must be supported; the two-element full form is
  what `["accumulated"]` exists for.
- **`clusterMaxZoom` is not `maxZoom`.** MapLibre passes supercluster
  `maxZoom = clusterMaxZoom ?? (source maxzoom - 1)` (`geojson_source.ts:226, :251-257`,
  non-integer input rounded with a warning); **above** it the tiles come from the
  ordinary geojson-vt index, not from the cluster index. Source `maxzoom` defaults
  to 18 (`:185`), and `minPoints` is `max(2, clusterMinPoints || 2)` (`:227`) — so a
  declared `clusterMinPoints: 1` is silently lifted to 2, not honoured.
- **`clusterRadius` is in 512-px tile pixels, not extent units.** MapLibre converts:
  `radius = clusterRadius * (EXTENT / tileSize)` (`geojson_source.ts:229, :243-245`),
  with `extent: EXTENT` passed alongside — so the default 50 becomes `50 × (8192/512)
= 800` against `extent = 8192`. Our tiler already bakes exactly this convention in
  `DEFAULT_OPTIONS` (`tolerance: 6 = 0.375 × 8192/512`, `buffer: 2048 = 128 × 16`,
  `geojsonvt/index.ts:34-43`), so the cluster module takes `radius` in **extent
  units** and the converter does the ×16 once. Passing the raw 50 through would
  cluster at 1/16th the intended radius — a plausible-looking map with far too many
  clusters, and the single easiest way to get this feature subtly wrong.
- **Non-Point geometry.** Supercluster's `load` reads `geometry.coordinates` for
  Point and expands MultiPoint (`index.js:65-84`); a LineString/Polygon feature in a
  clustered source is indexed with a garbage position rather than being rejected.
  MapLibre's practical contract is "clustering is for point sources". We will not
  reproduce a garbage position — see §4.6.

## 3. What we are NOT doing

- **No `getClusterExpansionZoom` / `getChildren` / `getLeaves` public API in this
  track.** They are interaction APIs (click-to-zoom, spiderfy), not style support,
  and #2009 is a style-spec gap. The `cluster_id` scheme is chosen so they remain
  addable later without a rebuild — that is the only concession made to them.
- **No clustering for PMTiles / vector sources.** MapLibre does not offer it either;
  the source-level knob does not exist there.
- **No `lineMetrics`, `buffer`, `tolerance`, `generateId`.** The other half of
  #2009's "untracked geojson knobs" list. `lineMetrics` is ADR-0012 D8's precondition
  and stays there; the rest are a separate, small item. Naming them here so nobody
  reads this doc's silence as a decision.
- **No `color-relief`.** #2009's other half rides the DEM track (ADR-0012 D5).
- **No change to the legacy `GeoJSONRuntimeBackend` path.** A `?legacy=1` page with a
  clustered source keeps today's behaviour and today's warning. Phase 5f's follow-up
  deletes that path; teaching it to cluster would be work with a scheduled demolition
  date. This is a **stated degradation**, and it is warning-backed (§5, P4).

## 4. Design decisions, with the alternatives and why they lost

### 4.1 Extend the in-repo tiler; do not vendor `supercluster`

**Chosen:** a new `compiler/src/tiler/cluster/` module — an X-GIS-original
implementation of the algorithm in §2, sitting beside `geojsonvt/` and reusing its
`TransformedTile` output type and `encodeMVT`.

- _Vendor `supercluster` + `kdbush` as npm deps_ — **rejected.** The tiler directory
  exists precisely because `geojson-vt`/`vt-pbf` were ported rather than depended on
  (`geojsonvt/AGENTS.md`: "bundled to avoid a runtime npm dependency"); adding
  supercluster would put half of one pipeline behind a dependency and half not, and
  the two halves must agree on tile addressing (Morton `tileKey`), extent (8192, not
  supercluster's 512 default) and the antimeridian convention. Two authorities on
  "where is this tile", which is the failure this repo has already paid for (#996).
- _Port supercluster 1:1 into `geojsonvt/` alongside the existing ports_ —
  **rejected.** `geojsonvt/` is contractually a 1:1 port of one upstream project
  ("preserve the upstream algorithm shape and variable naming; the ISC license
  header / LICENSE provenance must stay"). Mixing a second project's port into that
  directory makes the provenance claim false. A sibling directory keeps both honest.
- _Reuse geojson-vt's quad-split and cluster inside `createTile`_ — **rejected.**
  The hierarchy is built bottom-up across zooms with a per-zoom spatial index;
  geojson-vt's structure is top-down per-tile with no cross-tile neighbourhood. A
  point 3 px from a tile edge must cluster with its neighbour across that edge, which
  a per-tile pass cannot see. This is why supercluster is a separate index upstream
  too.

The dependency direction is therefore: `cluster/` may import `geojsonvt/types.ts`
(for `TransformedTile`) and `../vector-tiler` (for `tileKey`); `geojsonvt/` imports
nothing from `cluster/`, so the ports stay byte-stable.

### 4.2 Worker-side, in the existing tiling worker

**Chosen:** the cluster index lives in `data/src/workers/geojson-tiling-worker.ts`'s
`indexes` map, built in `set-source`, queried in `get-tile`.

- _Main thread_ — **rejected.** Building the hierarchy is O(n log n) per zoom over
  `maxZoom - minZoom + 1` zooms; on the main thread that is exactly the first-frame
  stall #1426 was fixed to remove, and the whole reason `set-source` is already off
  the main thread.
- _A new dedicated cluster worker_ — **rejected.** A second worker would need the
  same source data, the same lifetime rules, the same `instanceId` namespacing and
  the same drop-on-detach discipline as the tiling worker — all of which
  `geojson-tiling-pool.ts` already implements and has isolation tests for
  (`geojson-tiling-worker-isolation.test.ts`, `…-pool-respawn.test.ts`). Duplicating
  it buys nothing and doubles the teardown surface.

Consequence: when clustering is on, the worker holds **both** indexes for the
source — the cluster hierarchy for `z ≤ clusterMaxZoom` and the ordinary `GeoJSONVT`
for `z > clusterMaxZoom` (MapLibre's split, §2). Memory cost is one extra
`Int32Array` per zoom level plus the retained originals; it is bounded by the point
count, and the ordinary index is the one that already dominates for polygon-heavy
data. Recorded, not hand-waved: a P3 measurement pins it (§5).

### 4.3 `clusterProperties` travel as xgis expression ASTs, evaluated by `evaluate()`

**Chosen:** the converter lowers each `clusterProperties` entry to a **pair** of xgis
expressions (`map`, `reduce`) exactly as MapLibre expands them (§2); they ride the
`.xgis` source block as parsed expressions, reach the worker as POJO ASTs through
`postMessage`, and are evaluated with `compiler/src/eval/evaluator.ts`'s `evaluate()`,
with `accumulated` injected through a new reserved key alongside
`CAMERA_ZOOM_KEY` / `CAMERA_PITCH_KEY`.

- _Pass the raw Mapbox expression JSON through the `.xgis` source block_ —
  **rejected.** It would put Mapbox-spec JSON inside the xgis grammar, giving the
  runtime a second expression dialect to understand and making `.xgis` no longer a
  self-contained language. The converter's contract is Mapbox → xgis, once.
- _Compile the reduce to a shader/compute kernel_ — **rejected.** Aggregation runs
  once per cluster at index-build time in a worker, not per fragment per frame; there
  is no GPU on that side of the wire and no per-frame cost to amortise.
- _Restrict `clusterProperties` to a fixed operator whitelist (`+`, `max`, `min`,
  `any`, `all`)_ — **rejected as the primary path**, because the two-element full
  form is legal spec and appears in real styles. It survives as the **degradation**:
  a `map`/`reduce` expression whose conversion fails already produces a converter
  warning through the ordinary expression path, and the source then clusters with
  that key omitted rather than failing the style (§5, P4).

The spelling in `.xgis` needs to carry two expressions per key. Block properties
already parse a full expression (`parseBlockProperty`), and `astLiteralToJS`
(`compiler/src/ir/lower.ts:334`) is a _literal-only_ walker, so the source lowering
must keep these as `AST.Expr` rather than routing them through it — the one place
where `data:`'s precedent does **not** apply. Proposed spelling, decided in P1's
issue with a grammar test as the artifact:

```
source name: quakes
  type: geojson
  url: "…"
  cluster: true
  cluster-radius: 50
  cluster-max-zoom: 14
  cluster-min-points: 2
  cluster-properties: {
    mag_sum: { map: .mag, reduce: accumulated + .mag_sum }
  }
```

### 4.4 `cluster_id` keeps supercluster's encoding

**Chosen:** `((originIndex) << 5) + (zoom + 1) + numPoints`, decodable back to
(origin index, origin zoom).

- _A dense sequential id per source_ — **rejected.** It is smaller and simpler and it
  makes `getClusterExpansionZoom` / `getChildren` unimplementable without storing a
  side table, which is a design decision about §3's deferred APIs taken by accident.
  Keeping the upstream encoding costs nothing now and keeps that door open.
- _A hash of the centroid_ — **rejected.** Not stable across a re-cluster and not
  decodable; collisions are silent.

Note the arithmetic constraint this carries: with a 5-bit zoom field, `zoom + 1` must
fit in 31 bits alongside the shifted index, i.e. this scheme is safe while
`numPoints < 2^26` and `maxZoom ≤ 30`. Both hold; the bound goes in the code as an
assert, not a comment, per the "assertion carries information" lesson.

### 4.5 Re-cluster on `setSourceData`, do not patch incrementally

**Chosen:** a re-seed drops the cluster index and rebuilds it, riding the existing
`drop-source` + `set-source` path that `_attachGeoJSONViaVirtualPMTiles` already
performs on a data swap (`vtBackends` swap-in-place, `source-manager.ts:846`).

- _Incremental insert/remove into the hierarchy_ — **rejected.** Supercluster has no
  incremental API and the hierarchy is not incrementally maintainable in general: one
  inserted point can change a cluster's centroid at every zoom above it, which
  changes that cluster's neighbourhood, which cascades. An "incremental" version that
  is only correct for non-cascading inserts is a correctness trap wearing a
  performance costume.
- _Keep the old index live while the new one builds_ — **deferred, not rejected.**
  It is the right answer for a high-frequency `refresh:` source, but it is a
  worker-lifetime change orthogonal to clustering, and today's re-seed already has
  the same blank-window behaviour for the ordinary index. Recorded here so it is not
  re-discovered as a clustering bug.

### 4.6 Non-Point features in a clustered source are dropped, loudly

**Chosen:** the cluster index takes Point and MultiPoint (expanded per coordinate,
as upstream) and **skips** anything else, with a one-line count in the converter
warning and a `xlog.warn` at index build naming the source and the skipped count.

Upstream would index a LineString at whatever `coordinates[0]` destructures to — a
silent wrong position. Reproducing that to be "compatible" would mean shipping a bug
on purpose. The MapLibre-visible difference is confined to styles that are already
malformed, and it is warning-backed in both places.

## 5. Phases

Each phase is one issue, filed before its code (CLAUDE.md §9.5), one fail-before
witness corpus, one full local gate (`bun run build` then `bun run test`, sequential
per §7), one draft PR. Before **each** phase: `git fetch origin main` + merge — the
main campaign session is landing converter/source work concurrently.

**P0 — this design doc.** Draft PR, no code. Exit: the doc is on `main` (or on an
open draft PR) so P1's issue can cite section numbers instead of re-arguing them.

**P1 — grammar + IR + converter emit (converter/compiler only, no runtime).**
`source` block gains `cluster` / `cluster-radius` / `cluster-max-zoom` /
`cluster-min-points` / `cluster-properties`; `SourceDef` gains the matching fields
(`clusterProperties` as `Record<string, {map: AST.Expr; reduce: AST.Expr}>`);
`convert/sources.ts` emits them and stops emitting the drop-warning for the forms it
now carries. `["accumulated"]` leaves `KNOWN_UNSUPPORTED` and becomes a reserved-key
identifier in the evaluator.
_Fail-before:_ a converter test asserting the emitted `.xgis` for a clustered source
(red: today it emits the warning and no cluster lines); a lower test asserting
`SourceDef.clusterProperties` holds ASTs, not `astLiteralToJS` output; an evaluator
test asserting `accumulated + .x` reads the injected reserved key.
_Byte-identity:_ all four committed style fixtures (`maplibre-demotiles`,
`openfreemap-bright`, `openfreemap-liberty`, `openfreemap-positron`) author no
clustering, so `ir-snapshot`, `fixture-ir-snapshot` and `style-coverage-report`
snapshots must come out **unchanged**. That is the cheap, strong invariant for this
phase — a changed snapshot means the emit leaked into unclustered sources.

**P2 — the cluster index (`compiler/src/tiler/cluster/`), CPU-only.**
The §2 algorithm, emitting `TransformedTile`. No worker wiring, no runtime.
_Fail-before:_ a corpus that pins each measured behaviour separately — weighted
centroid vs arithmetic mean; the `minPoints` admission rule including the
neighbour-marking else-branch; `point_count_abbreviated`'s number/string asymmetry
at n = 999 / 1000 / 1049 / 9999 / 10000; unclustered-point coordinates equal to the
Float64 originals (not the Int32 round-trip); the two antimeridian arms; `null` for
an empty tile. Per the "cut the specific mechanism" lesson each test must fail
differently — a single "clusters look right" assertion would pass with the centroid
weighting removed.
_Also P2:_ the memory/time measurement §4.2 promises, recorded on the issue.

**P3 — worker + pool + backend wiring.**
`GeoJSONVTOptions`-adjacent cluster options through `tilingPool.setSource`; the
worker builds and holds the cluster index; `get-tile` routes `z ≤ clusterMaxZoom` to
it and above it to the ordinary index; `VirtualPMTilesBackend` passes the options
from `SourceDef`; `source-manager` reads them off the source.
_Fail-before:_ a worker-level test that a clustered `set-source` + `get-tile` returns
PBF bytes whose decoded features carry `point_count` (red before the routing exists);
a routing test at `clusterMaxZoom` and `clusterMaxZoom + 1` asserting the two tiles
come from **different** indexes (assert on a property only one path produces, not on
feature counts, which can coincide); an isolation test mirroring the existing
`geojson-tiling-worker-isolation` shape — two instances, one clustered.

**P4 — diagnostics, degradations, and the style-level round trip.**
The converter warning shrinks to the residue: legacy-path opt-out (§3), non-Point
features (§4.6), and any `clusterProperties` key whose expression did not convert
(§4.3). A converted real style (an inline fixture authoring `cluster: true` plus a
`point_count` step on `circle-radius` and a `point_count_abbreviated` `text-field`)
round-trips Mapbox → `.xgis` → IR, pinning that the synthetic properties reach a
paint expression.
_§5 render verification:_ this is the phase where pixels change, so it owes the
ADR-0004 real-GPU tier — a headless WebGL2 spec that loads the clustered fixture and
asserts, on the frame, that the cluster circles exist and that the count label
renders. Directional pixel-diff before/after with `compare-diff.py`, read as a 16-split
at full resolution. Not a `nonBg %` check: a pixel-count gate passes on a broken image.

**P5 — spec-coverage + gap matrix (this track's FINAL phase, shared files).**
Rows for the five source-level cluster knobs and the synthetic properties; correct
`accumulated`'s row, which today reads `{ name: 'accumulated', status: 'na', note:
'Heatmap-only.' }` (`compiler/src/convert/spec-coverage/expressions.ts:241`) — it is
the clusterProperties accessor, not a heatmap one, and that note is simply wrong.
Regenerate `scripts/gap-matrix.md` via `bun scripts/emit-gap-matrix.ts >
scripts/gap-matrix.md` (a STDOUT generator — exit 0 ≠ file written). Remember the
three-way sync: spec-coverage row + gap-matrix + `RUNTIME_CAPABILITIES`, or
`spec-coverage-runtime-drift.test.ts` breaches. Four tracks share this table; this
phase merges last, via a main-merge.

## 6. LOC-ceiling risk table

The ratchet is shrink-only (`map/src/loc-ceiling-ratchet.test.ts`): a baselined file
may only stay ≤ its ceiling; a non-baselined source file may not cross
`NEW_FILE_CAP = 800`. Measured at `f0e89d8` with `git show HEAD:<file> | wc -l`
(post-prettier, per the §12 lesson — not the working tree).

| File                                          |  LOC |        Ceiling | Headroom | Risk & mitigation                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---: | -------------: | -------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler/src/ir/lower.ts`                    | 1514 |           1514 |    **0** | **Blocking.** `lowerSource`'s prop chain is where the five cluster keys want to go. Mitigation: extract the whole `source`-block prop walk into `compiler/src/ir/lower-source.ts` (new file, ≤800) in P1 as its _first_ commit, so the cluster keys land in a file with headroom and `lower.ts` **drops** — the ratchet is lowered, never bumped.                                                         |
| `map/src/source-manager.ts`                   | 1068 |           1068 |    **0** | **Blocking.** P3 needs the cluster options read off `SourceDef` and passed to the backend. Mitigation: the read is a pure mapping — put it in a new `map/src/source-cluster-options.ts` and have the attach path call it, net-negative on `source-manager.ts` if the existing inline option assembly moves with it.                                                                                       |
| `compiler/src/convert/sources.ts`             |  679 |      800 (cap) |      121 | Tight. P1's emit + P4's residual warning must fit in ~120 lines, and the file is also being edited by the #1984 (source `bounds`) work. Mitigation: land the cluster emit as a helper in a new `convert/sources-cluster.ts` called from the geojson branch; the branch itself grows by a call site. **Do not edit this file until #1984's PR has merged** (checked 2026-08-24: no open PR references it). |
| `data/src/sources/virtual-pmtiles-backend.ts` |  408 |      800 (cap) |      392 | Low. Options plumbing only.                                                                                                                                                                                                                                                                                                                                                                               |
| `data/src/workers/geojson-tiling-pool.ts`     |  219 |      800 (cap) |      581 | Low.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `data/src/workers/geojson-tiling-worker.ts`   |  178 |      800 (cap) |      622 | Low; P3's dual-index routing is small.                                                                                                                                                                                                                                                                                                                                                                    |
| `compiler/src/eval/evaluator.ts`              |  311 |      800 (cap) |      489 | Low. One reserved-key arm.                                                                                                                                                                                                                                                                                                                                                                                |
| `compiler/src/tiler/cluster/*`                |  new | 800 (cap) each |        — | The index is ~350-450 lines; split index-build / tile-query / cluster-properties across files from the start rather than after a breach.                                                                                                                                                                                                                                                                  |

Two of the eight are at **zero** headroom. Both extractions are prerequisites, not
cleanups, and each ships in the phase that needs it — never as a speculative
refactor, and never by raising a number.

## 7. Socratic self-critique

**"Is the tiler really the right place — MapLibre clusters in the source, not the
tiler."** MapLibre's `GeoJSONWorkerSource` _is_ the tiler for GeoJSON; it holds
either a `GeoJSONVT` or a `Supercluster` and both answer `getTile`. Our
`geojson-tiling-worker` is the same object under a different name. The placement
matches; the naming differs.

**"Why not compute clusters at draw time from the point buffer — no tiler change at
all?"** Because the aggregation must be stable across tiles and frames. A view-time
clustering pass produces different clusters at different viewport sizes and
recomputes every frame, and `cluster_id` would not be stable, so no `clusterProperties`
value would be either. It also cannot serve the `point_count` a _style expression_
reads, because expressions bind at decode time, not draw time.

**"The dual-index memory cost is real. Is `clusterMaxZoom` worth honouring?"** Yes,
and this is the honest weak point. Serving cluster tiles above `clusterMaxZoom` would
let us drop the ordinary index, but MapLibre's contract is that a clustered source
shows _individual_ points when zoomed past the threshold — that is what the knob
means, and styles depend on it (the unclustered layer with `["!", ["has",
"point_count"]]` is the canonical clustering style). The cost is accepted; P2
measures it so the number is on the record.

**"Is `evaluate()` really sufficient for `clusterProperties`?"** It is sufficient for
the reduce/map _shape_ — a pure function of a property bag plus one global. What it
does not do is validate that the reduce is associative, and a non-associative reduce
gives zoom-dependent results. MapLibre has the same hole. We inherit it; the doc
records it rather than pretending otherwise.

**"P1 lands converter emit for a runtime that ignores it — is that a silent gap?"**
It would be, if the warning were removed in P1. It is not: P1 keeps a warning that
says the source is _carried but not yet clustered_, and P4 shrinks it to the real
residue. At no point between P1 and P4 does a clustered style convert with no
diagnostic. This is the ADR-0012 §1 rule ("silent drops are defects") applied to our
own intermediate states.

## 8. Risks

- **Concurrent edits to `sources.ts`.** Four tracks plus the main campaign touch the
  converter. Mitigation: fetch+merge before each phase; the cluster emit lives in its
  own file (§6); do not touch `spec-coverage/` or `gap-matrix.md` before P5.
- **The `f0e89d8` `AGENTS.md` claim that cluster is deliberately dropped.** A future
  session reading only that file will "fix" our addition back out. Mitigation: P2
  updates `compiler/src/tiler/geojsonvt/AGENTS.md`'s dropped-features line to point
  at `cluster/` and this doc — the same sentence stays true for `lineMetrics`.
- **Flakes.** The known full-suite 30 s-timeout load flakes are catalogued in #1991;
  adjudicate per its protocol (solo run + one confirming rerun). Never chase.
- **Snapshot churn.** If a P1 snapshot moves on a fixture that authors no clustering,
  that is a **bug in the emit**, not a snapshot to update with `-u`.

## 9. Verification posture

Per phase: fail-before witness proven red for the _right reason_ (each witness cutting
one mechanism, not the aggregate), then green; full local gate sequentially
(`bun run build` — the typecheck authority — then `bun run test`); byte-identity of the
four fixture snapshots for every phase that touches the converter; ADR-0004 real-GPU
tier in P4 where pixels change, with directional pixel-diff (DC > 0, D1 < D0) and the
diff image read as a 16-split at full resolution.

## Landed

_(nothing yet — P0 is this document)_
