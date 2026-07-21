# X-GIS Data-to-Viz Pipeline — Design & Responsibility Charter (`@xgis/pipeline`)

> **Status: PROPOSAL (design-first), REVISED per independent architecture critique (2026-07-03).**
> This document architects a new user-facing layer that turns raw, un-geometried public data into
> insight-oriented X-GIS visualizations. Structure-first decision record for a 5-year capability;
> no code lands until §10 is ratified.
>
> **⚠️ Critique reflection — the load-bearing correction.** The first draft designed as if the
> render stack had **no** data-ingest/reproject surface. It does: `@xgis/data` + `setSourceData`
> already own EPSG→WGS84 reprojection (`data/src/sources/reproject-fc.ts:88`, `epsg-defs.ts:34-43`
> bundling Korean EPSG:5179/5186), the GeoJSON FC model (`data/src/geojson-types.ts` — pure types,
> runtime-0), the typed-array point fast path (`map.setSourcePoints` / `pointPatchToFeatureCollection`),
> and an ingest DoS ceiling (`assertIngestBudget`, `source-manager.ts:614`); and `setSourceData`
> **already reprojects declared-CRS host data to WGS84** (`source-manager.ts:618-622`, verified).
> ∴ this pipeline is a **CONSUMER of those existing seams, not a re-implementation** — the real risk
> is not gazetteer maintenance but the repo's #1 recurrence archetype: a **silently-diverging parallel
> path** built next to a seam the renderer already trusts. Six changes below (§0, §3–§6, §11) reshape
> the design to consume, not fork; the separate package + the gazetteer moat survive.
>
> **⚠️ API-ergonomics reflection (second pass, verified).** A DX review then hardened the _public
> API shape_ (§5). Its critical catch: the reprojection-delegation TARGET **does not exist yet** —
> `setSourceData`/`setSourcePoints` take no CRS argument and `PointPatch`/`FeatureCollection` carry no
> `crs` (verified: `map.ts:4028,4046`, `id-resolver.ts:49-54`), so a projected file with a forgotten
> `crs` is a **silent wrong-dot that type-checks green**. Fixes folded into §3/§5: (1) a small additive
> **runtime CRS channel on the map sinks** + `EncodeResult.apply(map, id)` so CRS is type-carried and
> never dropped; (2) **auto-detect out-of-geographic-range coordinates → throw**; (3) **named `join`
> output handles** (`as:'origin'`) retiring the `_o_lon` string contract; (4) **named-object args**
> (repo convention #804/#811); (5) **data `vintage` required + compared**, gazetteer branded by code
> system; (6) drop the unconsumed `ChannelSuggestion`; `slice`→`where`. Net: the blessed path becomes
> shorter than the footgun path; three cross-stage contracts move from prose/strings into the types.

---

## 0. TL;DR

Rendering is not the gap — **data processing is.** Public data (especially Korean public
data) arrives as **code-keyed tabular files with no geometry**, temporal, multi-dimensional.
Turning it into a map is 90% ETL — parse → join-to-geometry → aggregate → shape — and every
mainstream viz library (deck.gl, Mapbox GL, Leaflet, MapLibre) punts that 90% onto the user.

X-GIS already owns a strong render engine (globe · lines · points · heatmap · retained icons)
and a `.xgis` style compiler. The missing, differentiating layer is **INGEST + JOIN +
TRANSFORM + ENCODE** — a pure, GPU-free, render-agnostic toolkit that emits `FeatureCollection`s
the existing `map.setSourceData` path already consumes. It is **purely additive**: zero engine
change, zero new coupling into the render DAG.

The proposed home is a new **leaf** package **`@xgis/pipeline`** (name is an open decision, §10),
depending **only on `@xgis/shared`** (WGS84/great-circle math + the GeoJSON types, which move here
from `@xgis/data` — they are pure, runtime-0). It imports **no render package** and reuses the
render side's existing ingest seams by _emitting into them_ (WGS84 GeoJSON / declared-CRS / PointPatch)
— never by re-deriving reprojection or the FC model. Its moat is a **bundled, versioned Korean
administrative gazetteer** (시도/시군구/행정동 code → geometry) — the single highest-friction step no
viz library ships.

---

## 1. The problem — the 90% every viz library skips

A visualization library's implicit contract is "give me GeoJSON, I'll draw it." But real
open data is almost never GeoJSON:

- It is **tabular** (CSV/TSV/XLSX/JSON), not geometric.
- Its location is a **code**, not a coordinate: 행정동코드 `11680640`, 법정동코드, PNU,
  시군구코드 — never `[lon, lat]`.
- It is **aggregate and temporal**: rows per (place × hour × purpose × age), needing group-by
  and time-slicing before anything can be drawn.
- Its **join key is ambiguous**: 행정동코드 ≠ 법정동코드, boundaries change vintage-to-vintage,
  names collide, some rows are 시군구-level and some 행정동-level.

So the path from "downloaded file" to "map" is: **unzip → parse → normalize schema →
join to geometry → aggregate → slice → shape into renderable features → style.** Libraries
own only the last step. The user writes the other six by hand, every time, per dataset. That
is the friction this layer removes — and the reason "examples" and "data-processing capability"
are, as observed, the rarest things in the geo-viz space.

---

## 2. The driving worked example — 수도권 생활이동 (Capital-region living-migration)

Two Seoul Open Data datasets (`OA-22300`, `OA-22299`, KT × Seoul mobile-derived) exemplify the
whole problem:

| aspect      | reality                                                                                |
| ----------- | -------------------------------------------------------------------------------------- |
| shape       | **Origin→Destination flow** — rows of `(origin_dong, dest_dong, hour, purpose, count)` |
| geometry    | **none** — origin/dest are 행정동 **codes**                                            |
| size        | ~26–60 MB ZIP **per day** (`seoul_purpose_admdong3_YYYYMMDD.zip`)                      |
| access      | **file download only** — no REST API                                                   |
| dimensions  | 7 purposes × 24 hours × (age, in OA-22299) × domestic/foreign                          |
| the essence | the **daily pulse** — AM inflow to job centres, PM outflow to residences               |

To draw ONE frame ("8 AM commute flows") the user must: unzip → parse the CSV → **join both
`origin_dong` and `dest_dong` codes to 행정동 centroids** → group-by `(origin,dest)` and
`sum(count)` for `hour=8, purpose=commute` → **build an arc LineString per OD pair** weighted
by the summed count → push to the map. Six ETL steps before a single pixel. This document's
layer makes that a five-line pipeline; §9 walks it end-to-end.

---

## 2b. The abstraction — a DATA LOADER, not a plugin framework

The essence is small and concrete: **which data → how it loads → how it shows.** That triple IS
this package (ingest = which + how-loaded, join = how-resolved-to-geometry, encode = how-shown). A
general **plugin _framework_** (a registry + lifecycle + extension surface for arbitrary future
capabilities) would be building infrastructure for a problem we do not have yet — YAGNI, and against
§2 simplicity. The right-sized abstraction is a **data loader**, integrated with the map by a _light_
touch — the `EncodeResult.apply(sink, id)` capability (the map satisfies the structural sink). **No
`map.load(...)` alias**: `map.load(url)` already exists (`map.ts:3460`, the SSRF-guarded `.xgb`/`.xgis`
URL loader), so that name is taken and would collide; `.apply(sink, id)` is the sole blessed seam.
**No plugin system.** If a true plugin ecosystem is ever needed,
it is a separate, later decision; the data loader does not require it and must not wait for it.

Two authoring levels, one essence:

```ts
// Composable (power users) — the four stages, explicit:
bubble(
  groupBy(where(join(fromCSV(text, { vintage: '2026' }), { code: 'gu', gaz }), { hour: 8 }), {
    by: ['o.lon', 'o.lat'],
    agg: { out: 'sum' },
  }),
  { lon: 'o.lon', lat: 'o.lat', value: 'out' },
).apply(map, 'flows')

// Declarative (the essence, one call) — which / how-loaded / how-shown.
// Every field REUSES a shipped verb; load() internally calls join()/where()/groupBy()/bubble().
// One mental model (the four stages), ONE spelling — no parallel dialect (API-review F2).
load({
  from: fromCSV(text, { vintage: '2026' }), // WHICH — a Table value (shipped fromCSV)
  join: { code: 'gu', gaz, as: 'o' }, // HOW loaded → geometry (join()'s 2nd arg VERBATIM; `as` mints o.lon/o.lat — F1)
  transform: [
    (t) => where(t, { hour: 8 }), // (t)=>Table thunks over the shipped verbs (F3)
    (t) => groupBy(t, { by: ['o.lon', 'o.lat', 'gu'], agg: { out: 'sum' } }),
  ],
  show: (t) => bubble(t, { lon: 'o.lon', lat: 'o.lat', value: 'out' }), // HOW shown (shipped bubble)
}).apply(map, 'flows')
```

`load()` is a **strict re-composition** of the same pure stages — it calls `join`/`where`/`groupBy`/
`bubble` internally, coins no new vocabulary, and `JoinSpec` is pinned to `join`'s own parameter so
the `as` contract cannot drift (§5). The composable form stays the substrate; `load()` is the surface
that reads as the essence — and it needs **no map extension mechanism** beyond the existing sink seams.

---

## 3. Scope — OWNS / DOES NOT OWN

### `@xgis/pipeline` OWNS

- **Ingest** — normalize CSV/TSV/JSON/GeoJSON/typed-array input into one in-memory `Table`
  (columnar for scale), **and declare the input CRS** — WGS84 by default, or an EPSG code for a
  projected coordinate column (EPSG:5179 UTM-K etc.). **I/O is host-injected** (no `fs`/`fetch`/`unzip`
  inside the package — mirrors the compiler `module` resolver's injection rule, §3a of the charter).
- **Join** — resolve an admin **(vintage, code) → geometry** through a `Gazetteer`. Bundles a
  **versioned Korean administrative snapshot**; pluggable for other regions / vintages. Centroids
  are authored in **WGS84**, so the join path never reprojects.
- **Transform** — the right-sized geo-viz subset of dataframe ops: `filter`, `groupBy`,
  `aggregate` (sum/avg/count/min/max), `slice` (temporal/categorical), `derive`.
- **Encode** — turn a joined+transformed table into a renderable payload via insight-oriented
  **recipes**. Line/polygon recipes (`odFlow`, `choropleth`) emit a **GeoJSON `FeatureCollection`**;
  point recipes (`bubble`, `points`) emit a **`PointPatch`** (typed-array columnar — the existing
  `map.setSourcePoints` fast path, `map.ts:4046`) to avoid per-point object bloat at scale.

### `@xgis/pipeline` DOES NOT OWN — it CONSUMES the render side's existing seams

- **Reprojection** — projected-coordinate input is emitted **verbatim with a declared `crs`**;
  the render side reprojects to WGS84 via its existing `_reprojectIngest` (`source-manager.ts:153-168`
  → `@xgis/data`'s `reproject-fc` + `epsg-defs`). The pipeline stays **proj4-free**; single authority
  = the renderer's. ⚠️ **BUT (API-review finding, verified): the runtime channel does not exist yet.**
  `_reprojectIngest` reads CRS from the `sourceCRS` registry keyed by source id, populated ONLY from
  the `.xgis` `crs:` declaration (`map.ts:330`); `setSourceData(id, data)` (`map.ts:4028`) and
  `setSourcePoints(id, patch)` (`map.ts:4046`) take **no CRS argument**, and neither `PointPatch` nor
  `GeoJSONFeatureCollection` has a `crs` member. So delegation is real only after a **small additive
  map.ts change** — a runtime CRS channel (a `{ crs }` option on the sinks OR a
  `map.setSourceCRS(id, epsg)` setter that populates the existing registry). `EncodeResult.apply(map,
id)` uses that channel, so the caller never hand-writes or drops the CRS. (This punctures the
  first-draft "zero existing-package change" claim — see §0/§12.)
- **The FC model / ingest ceiling** — the GeoJSON types are `@xgis/shared`'s (moved there, §4);
  the DoS/size ceiling is `assertIngestBudget`'s (`source-manager.ts:614`), which the pipeline
  output must respect, not re-invent.
- **Rendering / GPU / tiling** — it never imports a renderer, a `GPUDevice`, `@xgis/engine`, or
  `@xgis/data`. `map` + `@xgis/data` take the emitted payload from `setSourceData`/`setSourcePoints`.
- **Style semantics** — encoders emit _data_ (features/points + numeric channel props); the `.xgis`
  layer / compiler owns paint. An encoder suggests defaults; it does not author `.xgis`.
- **The authoritative geometry source** — it bundles a _snapshot_ with provenance; it is NOT the
  SGIS/통계청/행안부 boundary authority and never fetches live.
- **General ETL / a dataframe engine / a database** — deliberately narrowed to geo-viz shapes.

---

## 4. Placement in the dependency DAG — the load-bearing decision

The internal DAG is strictly acyclic; the render stack is content-blind at the bottom
(`@xgis/engine`) and geo-aware higher up (`@xgis/map`). The new package sits **beside** the
render stack, not inside it:

```
   host app ──uses──▶ @xgis/pipeline ──emits WGS84 GeoJSON / declared-CRS / PointPatch──▶ map.setSourceData
       │                    │  (depends on: @xgis/shared ONLY — a zero-dep leaf)          / map.setSourcePoints
       └──uses──▶ @xgis/map ┘                                                                     │
                     │                                                          @xgis/data reproject + tiling
           @xgis/engine (content-blind) · @xgis/data (render-data) · @xgis/compiler   (the renderer's, single authority)
```

- **`@xgis/pipeline` depends on `@xgis/shared` ONLY.** The public GeoJSON types
  (`data/src/geojson-types.ts` — pure `interface`/`type`, runtime-0, zero imports) **move to
  `@xgis/shared`** (a zero-dependency leaf, symmetric with `@xgis/shader-dsl`), so the pipeline gets
  the type contract + WGS84 math from ONE leaf. It imports **no runtime value** from `@xgis/data`
  (which ships proj4/pmtiles/earcut as real `dependencies` and pulls `@xgis/compiler` across 21 files)
  — so the "zero-coupling / light" claim is **true by construction**, not aspirational. _(First draft
  depended on `@xgis/data`'s types and called that light; the critique refuted it — `@xgis/data` is a
  heavy render-data package. Moving the pure types to `shared` is the fix.)_
- **Nothing depends on `@xgis/pipeline`** — the render engine is oblivious; the host wires
  `pipeline → setSourceData/setSourcePoints`. Coupling is **zero both ways**; the acyclic DAG holds;
  **no existing package changes** except the mechanical types→`shared` move.

### Why NOT extend `@xgis/data` (SRP holds — but honestly: the pipeline CONSUMES its seams)

`@xgis/data` is the **render-data-layer** — tile catalog/cache/eviction, source backends, EPSG
reprojection, mesh building, worker pools (`data/src/index.ts`). Its SRP is "get data **into the
render pipeline**." A user-facing ETL toolkit that turns _raw public files_ into features is a
**different responsibility** (data-prep ≠ render-data); folding it in drags workers/tile-types into a
concern that needs none. **BUT** the honest framing (critique fix) is not "zero overlap" — `@xgis/data`
already owns reproject (`reproject-fc`), the FC model, and point-patch ingest, and the pipeline
**consumes** those via the `setSourceData` seam rather than re-implementing them. Two ingest layers
that _forked_ would be this repo's #1 recurrence bug (diverging sibling paths); one that _emits into_
the other is single-authority. `@xgis/data` stays the LCA of tile/mesh data; `@xgis/pipeline` is the
LCA of ingest/join/encode and a **client** of the render-side ingest seam.

> **Charter caveat.** `package-responsibilities.md`'s DAG (§1) is **stale** — it predates the
> `@xgis/data`/`@xgis/engine`/`@xgis/map`/`@xgis/blueprint` extraction and lists only
> runtime/compiler/shared/shader-dsl. Ratifying this proposal must **refresh that charter** to add the
> extracted packages + `@xgis/pipeline`, so placement is judged against the real DAG, not a 2026-06 snapshot.

### Why NOT the compiler / a `.xgis` DSL block (for v1)

The compiler is the **GPU-free style front-end** (`.xgis`/Mapbox → neutral render artifacts).
Data **ingest/join/aggregate is not style** — it is a pre-style data concern. A future `.xgis`
`transform { … }` / `join { … }` DSL surface _atop_ the programmatic pipeline is plausible
(§11 Phase 3), but v1 keeps the pipeline a **programmatic library** (testable, host-driven, no
grammar churn). Baking ETL into the compiler now would couple two 5-year surfaces prematurely.

---

## 5. The four contracts

Sketches (illustrative, not final signatures — the point is the _seam shape_):

```ts
// ── 1. INGEST ─────────────────────────────────────────────────────────────
// Host-injected I/O (no fs/fetch in-package). Columnar Table for scale. A `vintage`
// is stamped so the join can COMPARE it to the gazetteer (finding #5). CRS is NOT a
// Table scalar — a joined table mixes projected xy with WGS84 join-centroids, so CRS
// is declared per coordinate column at ENCODE time (finding #2).
interface Table {
  readonly columns: readonly string[]
  readonly length: number
  readonly vintage?: string // data vintage — compared to gaz.vintage at join
  col(name: string): ArrayLike<number | string>
}
function fromCSV(
  text: string,
  opts?: { delimiter?: string; types?: Record<string, 'number' | 'string'>; vintage?: string },
): Table
function fromRows(rows: ReadonlyArray<Record<string, unknown>>, opts?: { vintage?: string }): Table

// ── 2. JOIN ───────────────────────────────────────────────────────────────
// Named-object args (repo convention, #804/#811). `as` NAMES the produced geometry
// handle → no `_o_lon` string-guessing between join and encoder (finding #3). `vintage`
// REQUIRED + compared to gaz.vintage (mismatch = loud throw — the reassigned-code guard,
// finding #5). Gazetteer BRANDED by code system so a wrong-system column is a type nudge.
// Centroids are WGS84 → the join path never reprojects. Missing code = warn-once + drop.
interface Gazetteer<S extends 'admdong' | 'beopdong' | 'sigungu' | 'sido' = 'admdong'> {
  readonly system: S
  readonly vintage: string
  centroid(code: string): readonly [number, number] | null // WGS84
  boundary?(code: string): GeoJSON.Polygon | GeoJSON.MultiPolygon | null
  name(code: string): string | null
}
// join reads the data vintage from `t.vintage` (stamped at ingest) and COMPARES it to
// `o.gaz.vintage` — mismatch or missing vintage = loud throw (the reassigned-code guard).
function join(t: Table, o: { code: string; gaz: Gazetteer; as: string }): Table // writes `${as}.lon`/`${as}.lat`

// ── 3. TRANSFORM ──────────────────────────────────────────────────────────
// `where` = equality-select (NOT `slice` — that means index-range in JS, finding #7).
// `filter` = predicate form. Named-object `groupBy`.
function where(t: Table, eq: Record<string, string | number>): Table
function filter(t: Table, pred: (row: Record<string, unknown>) => boolean): Table
function groupBy(
  t: Table,
  o: { by: string[]; agg: Record<string, 'sum' | 'avg' | 'count' | 'min' | 'max'> },
): Table

// ── 4. ENCODE ─────────────────────────────────────────────────────────────
// Coordinate columns carry their `crs` HERE, per-column. Out-of-geographic-range values
// with an undeclared crs → THROW at the call site ("column 'x' outside geographic range;
// declare crs, e.g. 'EPSG:5179'") — turns the silent wrong-dot into a loud error (finding #2).
// The result is a CAPABILITY object (mirrors DrawHandle): `.apply(map, id)` picks the sink
// (setSourceData vs setSourcePoints) AND forwards crs — the caller never picks the wrong
// sink or drops crs (finding #4). Output must fit `assertIngestBudget`.
interface EncodeResult {
  apply(sink: PipelineSink, sourceId: string): void // picks sink; XGISMap satisfies PipelineSink structurally (leaf-safe — no render import)
  readonly kind: 'fc' | 'points'
  toFeatureCollection(): GeoJSON.FeatureCollection // escape hatch
}
function odFlow(
  t: Table,
  o: { origin: string; dest: string; weight: string; lift?: number },
): EncodeResult // origin/dest = join `as` handles
function choropleth(
  t: Table,
  o: { code: string; value: string; gaz: Gazetteer; ramp?: string },
): EncodeResult
function bubble(
  t: Table,
  o: { lon: string; lat: string; value: string; crs?: string },
): EncodeResult // → setSourcePoints
function points(t: Table, o: { lon: string; lat: string; id?: string; crs?: string }): EncodeResult

// ── 5. LOAD (declarative orchestrator) ────────────────────────────────────
// A STRICT re-composition of the verbs above — no new vocabulary (F2). `JoinSpec` is pinned to
// join()'s own 2nd parameter so the join contract — incl. the `as` handle that MINTS o.lon/o.lat —
// cannot drift (F1). `transform` elements are data-first `(t)=>Table` thunks over the shipped verbs
// (F3). `join` accepts an ARRAY for the odFlow origin+dest double-join (F4).
type JoinSpec = Parameters<typeof join>[1] // { code; gaz; as } — cannot drift from join()
interface LoadSpec {
  from: Table // e.g. fromCSV(text, { vintage })
  join?: JoinSpec | readonly JoinSpec[] // single OR left-to-right (odFlow needs origin+dest)
  transform?: ReadonlyArray<(t: Table) => Table> // authored: t => where(t, {...})
  show: (t: Table) => EncodeResult // authored: t => bubble(t, {...})
}
function load(spec: LoadSpec): EncodeResult // → .apply(sink, id)
```

Each stage is a **pure function** `input → output` (deterministic, GPU-free) → trivially
unit-testable over the whole domain, no device required. This is the same testability posture
the compiler/tiler enjoy.

---

## 6. The gazetteer — the moat AND the 5-year risk

The join step is where the value and the danger both live.

**The moat.** Korean public data is overwhelmingly code-keyed. A bundled gazetteer that resolves
`행정동코드 → centroid/boundary/name` out of the box removes the single biggest friction. No
mainstream viz library ships this. It is the concrete "데이터 가공능력" differentiator.

**The 5-year risks — and the design responses:**

1. **Admin boundaries change every year** (dongs merge/split; codes get **reassigned**). → The
   gazetteer is keyed by **`(vintage, code)`**, and the join **requires an explicit dataset
   `vintage`** (NOT an inferred one — inference is the fragile step). ⚠️ **The subtle killer:**
   `warn-once + drop` only catches a **missing** code — a **reassigned** code resolves to a
   _successful but WRONG_ centroid (silent wrong-dot, the class this repo fears most). Mitigation:
   the vintage MUST match the data's vintage (mismatch = loud failure, not a silent lookup), and the
   gazetteer records reassignment/merge events so a cross-vintage code is flagged, not silently placed.
2. **Multiple code systems** — 행정동코드 vs 법정동코드 vs PNU vs 시군구코드 are NOT
   interchangeable. → `Gazetteer` is **typed by `level` + code system**; join validates the code
   shape and fails loudly on a mismatch (wrong-system code = a greppable error, not a wrong dot).
3. **Geometry weight** — full 행정동 boundaries (~3,500 polygons) are megabytes. → **Tiered
   geometry**: centroid-only (tiny, enough for flows/bubbles) bundled; boundaries (for
   choropleth) **lazy-loaded** on demand. Flows never pay for polygons they don't draw.
4. **Provenance + license (a HARD gate, not a footnote)** — bundling third-party geodata
   (SGIS/통계청/행안부) into an MIT npm package requires the source license to **permit
   redistribution**. This must be **verified before any geometry is committed**; if redistribution
   is not permitted, the package ships a **fetch-and-cache generator** (host fetches the official
   source once, caches locally) instead of bundling. Either way the snapshot cites source + vintage +
   license and stays **pluggable** (user-supplied / foreign gazetteers). The package is a convenience
   snapshot with a paper trail, never the boundary authority.

---

## 7. Insight orientation — the second differentiator

Encoders don't merely render; they **encode structure so the insight reads**:

- `odFlow` encodes **direction + volume** → the daily-pulse animation makes urban rhythm visible
  (the _essence_ of 생활이동), which a scatter of dots never could.
- `choropleth` encodes a **spatial gradient**; `bubble` a **magnitude field**.
- Temporal `slice` + re-encode per frame → **change over time** becomes an animation.

A future **shape detector** (§11) can inspect a table (`has origin+dest+weight → odFlow`;
`has code+value → choropleth`) and _recommend_ an encoder + defaults — turning "load a public
file" into "get a sensible insight map" with near-zero config. v1 keeps encoder choice explicit;
the detector is a Phase-2 nicety, not a v1 dependency.

---

## 8. Worked example — the full pipeline for 수도권 생활이동

```ts
import { fromCSV, join, groupBy, where, odFlow } from '@xgis/pipeline'
import { seoulDongGazetteer } from '@xgis/pipeline/gazetteer/kr'

// host unzips + reads (I/O injected); stamp the DATA vintage at ingest:
const raw = fromCSV(await host.readSeoulODCsv('seoul_purpose_admdong3_20260531.csv'), {
  vintage: '2026',
})
const gaz = seoulDongGazetteer({ vintage: '2026' }) // Gazetteer<'admdong'>; join asserts vintages match

const j = join(
  join(raw, { code: 'origin_dong', gaz, as: 'origin' }), // → origin.lon / origin.lat
  { code: 'dest_dong', gaz, as: 'dest' },
) // → dest.lon / dest.lat   (named handles)
const am = where(j, { hour: 8, purpose: 'commute' })
const od = groupBy(am, { by: ['origin_dong', 'dest_dong'], agg: { count: 'sum' } })

odFlow(od, { origin: 'origin', dest: 'dest', weight: 'count', lift: 0.25 }) // references the handles, not `_o_lon`
  .apply(map, 'flows') // picks setSourceData, forwards crs (WGS84 here) — caller can't drop it
```

The 24-hour pulse is the same pipeline re-`where`d per `hour` and re-applied — the per-hour ETL is
a `where` + `groupBy` of the already-joined table, so it is cheap. The `@xgis/map` side is an
ordinary `.xgis` line style (volume-tiered layers or data-driven width).

---

## 9. Verification & the 5-year bar

- **Pure & GPU-free** → every stage is unit-testable over its whole input domain (table→table,
  code→centroid, OD→arc geometry) with **no device** — the strongest testability tier.
- **Single-authority** — the gazetteer is the ONE code→geometry source; the encoders are the
  ONE table→FeatureCollection path. No parallel converters.
- **The render proof** is the Seoul demo, verified real-GPU (headed capture, §5 render-parity
  discipline) — the pipeline's output rendering the daily pulse is the end-to-end gate.
- **Determinism** — same file + same gazetteer vintage → a **golden-file gate**. Byte-identical for
  the discrete parts (feature count, properties, code→centroid); for **reprojected coordinates** use a
  **numeric-tolerance golden** (a proj4 version bump can wiggle the f64 LSBs — `epsg-defs.ts:14-20`
  validates ≤3.7 nm vs pyproj), not bit-equality — mirroring how the render gates tolerate AA-edge px.

---

## 10. Decisions

### Resolved by the critique (fold into ratification)

- ✔ **Dependency = `@xgis/shared` only.** Move the pure GeoJSON types there; import no `@xgis/data`
  runtime value → the zero-coupling claim is true, not aspirational. (§4)
- ✔ **Reprojection is delegated, not owned.** Pipeline emits projected coords + declared `crs`;
  `setSourceData._reprojectIngest` does the EPSG→WGS84. Pipeline is proj4-free; one authority. (§3, §5)
- ✔ **Output split by geometry.** Line/polygon → GeoJSON FC (`setSourceData`); point → `PointPatch`
  (`setSourcePoints` fast path). Both respect `assertIngestBudget`. (§3, §5)
- ✔ **Gazetteer keyed `(vintage, code)`, explicit vintage required**; reassigned-code guard beyond
  warn-drop; **redistribution-license verified before bundling** (else fetch-and-cache generator). (§6)
- ✔ **First encoder = `bubble`/`points`** (minimal proof); `odFlow` = the showcase after. (§11)
- ✔ **Determinism gate = numeric-tolerance golden for coordinates** (proj4 LSB drift). (§9)
- ✔ **Refresh `package-responsibilities.md`** (stale) as part of ratification. (§4)

### Resolved by the API-ergonomics pass (fold into the API + the map.ts change)

- ✔ **A runtime CRS channel on the `map` sinks is REQUIRED** (a `{ crs }` option on
  `setSourceData`/`setSourcePoints` or a `setSourceCRS(id, epsg)` setter) — without it the delegated
  reprojection is unreachable at push time. Small additive `map.ts` change. (§0, §3, §12)
- ✔ **`EncodeResult.apply(map, id)`** capability (mirrors `DrawHandle`) picks the sink + forwards CRS
  — the caller never picks the wrong sink or drops CRS. (§5)
- ✔ **Encoders throw on out-of-geographic-range coordinates without a declared `crs`** (loud, not
  silent wrong-dot); CRS is per-coordinate-column, not a Table scalar. (§5)
- ✔ **Named `join` output handles** (`as:'origin'`) + **options-object args** everywhere (repo
  convention #804/#811) + **`where`** (not `slice`). (§5)
- ✔ **Data `vintage` stamped at ingest + compared at join**; `Gazetteer` branded by code system. (§5, §6)
- ✔ **Cut `ChannelSuggestion` from v1** result types (insight/detector stays Phase-2); commit the
  loud column-not-found / out-of-range / wrong-system diagnostics + per-function docs. (§5, §9)

### Resolved by the architect + declarative-`load` pass (fold into the build)

- ✔ **`load({ from, join, transform, show })`** ships as a STRICT re-composition of the verbs — every
  field reuses a shipped symbol (`JoinSpec = Parameters<typeof join>[1]`; `transform` = data-first
  `(t)=>Table` thunks; `join` accepts an array for the double-join). No parallel dialect, no curried
  twins. (§2b, §5)
- ✔ **No `map.load(...)` alias** — `map.load(url)` already exists (`map.ts:3460`), so the name is
  taken; `.apply(sink, id)` is the sole seam. (§2b)
- ✔ **`apply(sink: PipelineSink, id)`**, not `apply(map: XGISMap, …)` — the built signature is
  render-package-free (upholds the §4 leaf claim); `XGISMap` satisfies `PipelineSink` structurally. (§5)
- ✔ **CRS channel is Phase 2, decoupled from the Phase-1 ship.** Phase 1 is WGS84-only — projected
  input THROWS at the encoder (built + tested, `encode.test.ts`). The loader ships on the path that
  already works end-to-end; the map-sink CRS channel is deferred, not a Phase-1 gate. (§3, §11, §12)
- ✔ **`PointPatch` drift guard** — the pipeline's structural `PointPatch` is pinned by a compile-time
  `satisfies` conformance check in the **map** package against `@xgis/data`'s authority. (§5)

### Still open (for the ratifier)

1. **Package name** — `@xgis/pipeline` (mechanism) vs `@xgis/insight` (the differentiator) vs
   `@xgis/data-kit`. Leaning `@xgis/pipeline`, "insight" framing in docs.
2. **Gazetteer bundling scope + source** — start 시군구 (25 Seoul / 250 national) centroids, then
   행정동 + boundary tier. Which official source (SGIS vs 행안부) + which vintage to pin first.
3. **I/O injection surface** — the exact host-provided `readFile`/`fetch`/`unzip` shape (package
   stays fs/fetch/zip-free, per the compiler-`module` rule).
4. **`.xgis` DSL surface** — deferred to §11 Phase 3; confirm v1 is programmatic-only.

---

## 11. Phasing

- **Phase 1 (thin slice — the MINIMAL proof of the layer):** `fromCSV`/`fromRows` ingest (+ input-CRS
  declaration) · 시군구 **centroid** gazetteer · `join` · `groupBy`/`slice` · the **`bubble`/`points`
  encoder → `PointPatch`** · a small real Seoul dataset rendered via `setSourcePoints`.
  ⚠️ **`bubble` first, not `odFlow`** (critique fix): `odFlow` exercises the three _riskiest_ things at
  once — a double join, arc geometry, and the largest output (100k+ arcs against `assertIngestBudget`) —
  on the _most_ drift-prone code system (행정동). `bubble` on 시군구 centroids proves the whole
  ingest→join→transform→encode→inject seam with the _smallest_ surface. It is the honest thin slice.
  ⚠️ **Phase 1 is WGS84-only.** Projected input is a loud THROW at the encoder (built + tested —
  `encode.test.ts`: EPSG:5179 eastings throw `outside … geographic range`). The delegated-reprojection
  **CRS channel on the map sinks is Phase 2**, not a Phase-1 gate — decoupled so the loader ships on
  the path that already works end-to-end, with **zero map.ts change**.
- **Phase 1.5 (the SHOWCASE):** the `odFlow` encoder + the **수도권 생활이동 flow-map demo** (the
  daily-pulse animation) as the real-GPU showcase — once the seam is proven by Phase 1.
- **Phase 2:** 행정동 gazetteer (+ boundary tier) · `choropleth` encoder · the shape detector ·
  a temporal-animation helper.
- **Phase 3:** streaming big-file ingest · more code systems (법정동/PNU) · foreign gazetteers ·
  (maybe) a `.xgis` `transform`/`join` DSL surface atop the programmatic core.

---

## 12. ADR summary (for `docs/adr/0010-*` on ratification)

- **Context.** X-GIS renders well but, like all viz libraries, requires the user to hand-write the
  ETL that turns code-keyed tabular public data into geometry. That ETL is 90% of real-world
  geo-viz work and the field's biggest unmet need — nowhere more than Korean public data, which is
  code-keyed and un-geometried.
- **Decision.** Add a new, render-agnostic **leaf** package `@xgis/pipeline` (ingest → join →
  transform → encode) that **emits into the render side's existing ingest seams** —
  `setSourceData` (GeoJSON FC, reprojected there) / `setSourcePoints` (PointPatch) — as a **consumer,
  not a re-implementation**. It depends **only on `@xgis/shared`** (the pure GeoJSON types move there;
  WGS84 math already lives there) and is depended on by nothing. Its differentiator is a bundled,
  versioned, license-cleared Korean administrative gazetteer keyed `(vintage, code)`. Its public API
  is options-object based with a capability result (`EncodeResult.apply(sink, id)` — `XGISMap` satisfies
  the structural sink), moving the join-column / vintage contracts into the type system, plus a
  declarative `load({ from, join, transform, show })` re-composition of the same verbs. Additive:
  **Phase 1 is WGS84-only with ZERO existing-package change** (projected input throws at the encoder;
  the `PointPatch` is a structural copy pinned by a `satisfies` guard in the map package). The two
  delegation edits — the mechanical GeoJSON-types→`@xgis/shared` move and a **runtime CRS channel on
  the `map` sinks** (a `{ crs }` option or a `setSourceCRS(id, epsg)` setter populating the existing
  `sourceCRS` registry) — are **Phase 2**, when projected-coordinate delegation is actually wired.
- **Consequences.** (+) A genuine, testable, **single-authority** data-processing capability (it
  reuses the renderer's one reprojection/ingest path rather than forking a second) + a worked example;
  the render engine is untouched. (−) A new package to maintain and a **gazetteer-vintage + license
  maintenance burden** (admin boundaries drift yearly; redistribution rights must stay valid) —
  mitigated by `(vintage,code)` keying, explicit-vintage-required, reassignment guards, tiered/lazy
  geometry, license-verify-before-bundle (or fetch-and-cache), and pluggability. (Δ) Requires
  refreshing the stale package charter; opens a future `.xgis` ETL-DSL question, explicitly deferred.
