# Source-loader seam — a bounded registration point for custom `source { type }`

> Status: **DRAFT for review** (architect + api-ergonomics, independent lane). Author: engine work session
> 2026-07-04. Companion to [`data-to-viz-pipeline.md`](./data-to-viz-pipeline.md) — that doc is the DATA
> layer (join/encode); this doc is the SEAM that lets such a producer be declared in `.xgis`.

## 0. TL;DR

The renderer and the layer system are complete. A host **can** already get *fully custom data* onto the
map imperatively (stub-declare `source x { type: geojson, url: "" }` → `setSourceData(x, fc)`); what it
**cannot** do is introduce a custom *type* **declaratively** in `.xgis`, carrying the source's own fields.
This doc proposes the smallest primitive that closes THAT gap — a declarative front door, not new
capability: a **per-map source-loader registry** — `new XGISMap(canvas, { sources: { 'x-kr-admin':
loaderFn } })` — consulted by the existing source dispatch when a declared `type` is not a built-in. It
is a **bounded, single-purpose seam** (one function: `type → loader → features`), NOT the general
plugin framework that was correctly cut as YAGNI. Precedent: MapLibre `addProtocol`, deck.gl loaders.gl,
OpenLayers `source`/`format`. The `@xgis/pipeline` layer (gazetteer join + encode) becomes the **first
producer** that plugs into it; `.apply(sink, id)` remains the imperative path.

**Review-reflection notes (both reviews landed; findings folded in — see §3.3 / §4 / §9):**
1. This is deliberately ONE seam, not a plugin system. Lifecycle/ordering/teardown hooks or a layer-type
   registry are scope creep — deferred. The bar is: can a host load a custom source declaratively? Nothing more.
2. The seam must not leak into `@xgis/engine`. The registry lives in `@xgis/map`; the compiler options-bag
   change lives in `@xgis/compiler` (above engine). The engine stays content-blind — it renders whatever the
   source produces, exactly as today.
3. **Two first-draft claims were REFUTED by the code and are corrected here:** (a) the `type` enum is NOT a
   compile gate — free-form types already lower (§4); (b) a bare `rawDatasets.set` seed renders BLANK — the
   loader output must route through `_attachGeoJSONViaVirtualPMTiles` (§3.3). The design survived both and got
   *smaller* (no enum edit; single attach path).

---

## 1. The problem — evidence, not assertion

The host has a complete render + layer system but no way to introduce a source the built-ins don't cover.
Grounded in the current tree:

- **`.xgis` source types are closed by CONVENTION, not by a compile gate.** `SOURCE_TYPES =
  ['geojson','pmtiles','raster','tilejson','vector','raster-dem','binary']`
  (`compiler/src/schema/language.ts:59`) is declared a schema enum (`:101`), but that schema is consumed
  ONLY by blueprint tooling — `lowerSource` accepts any `type` identifier with no `SOURCE_TYPES` check
  (`compiler/src/ir/lower.ts:135-136`, verified). An 8th `type:` **lowers fine**; it just has no loader,
  falls into the geojson branch, and crashes on `.features`. The gap is a *missing loader*, not a barrier.
- **Programmatic add-source is an explicit stub.** `map.addSource(_id, _source)` calls
  `_warnUnsupported('addSource', 'Declare the source in your .xgis source / use attachPMTilesSource…')`
  (`map/src/map.ts:1321`) — underscore params, no body. There is no imperative way to introduce a source
  either.
- **A prior architecture audit already found this.** *"No plugin API … no registration surface in
  `runtime/src`"* (`docs/research/arch-reckoning-2026-06-08/A6-contracts-axes.md:173`).
- **The only open imperative seam UPDATES an already-declared source.** `setSourceData` /
  `setSourcePoints` fill the data of a source that was *declared first* (the inline-placeholder branch,
  `source-manager.ts` `load.url === ''` → empty FeatureCollection, "host pushes data later"). That is
  what `@xgis/pipeline`'s `.apply()` uses — it still requires a `source X { type: geojson }` stub in the
  `.xgis`. It cannot mint a *new* source, and cannot express *how* custom bytes decode.

**Net:** the sole way to *introduce* a source is the `.xgis` declaration, and its type vocabulary is
closed. Custom / public data has no declarative on-ramp.

---

## 2. The exact seam — where a source type is dispatched today

The authoritative `.xgis → render` path for the new `source { } / layer { }` syntax is the **compiler**
pipeline (the legacy `interpret()` is a fallback for old syntax):

```
map.run(src)                                            map/src/map.ts:2199
  parse → AST
  hasNewSyntax = SourceStatement|LayerStatement present   map.ts:2314
  if (hasNewSyntax):                                       ← the target path
     scene    = lower(ast)                                 compiler/src/ir/lower.ts (lowerSource → SourceDef)
     commands = emitCommands(optimize(scene, ast), …)      → LoadCommand[]        map.ts:2325-2347
  else:
     commands = interpret(ast)                             legacy, map/src/interpreter.ts:106
  ⋯
  source-manager dispatches each LoadCommand by load.type: raster | vector-tile | inline | geojson
                                                          map/src/source-manager.ts:217
```

Two concrete anchors the seam hooks into:

- **Compile-time carrier** — `SourceDef { name; type: string; url; layers?; crs? }`
  (`compiler/src/ir/render-node.ts:64`), produced by `lowerSource` (`compiler/src/ir/lower.ts:113`),
  emitted as a `LoadCommand` (`compiler/src/ir/emit-commands.ts:19`).
- **Runtime dispatch** — `source-manager.ts:217`, `const declaredType = load.type` → branch:
  `looksLikeRaster` → tile-url dataset · `vectorTileFormat !== null` → `attachPMTilesSource` ·
  `load.url === ''` → inline placeholder · else → `safeFetch` GeoJSON. **The custom-loader branch inserts
  here**, keyed on `declaredType ∉ builtins`.

Neither carrier presently transports the *extra* fields a custom source needs (a `kr-admin` loader wants
`code`, `gaz`, …). `SourceDef` and the source schema (`language.ts:99-103`) know only
`name/type/url/layers`; `extractSource`/`lowerSource` drop everything else. **Carrying an opaque options
bag for custom types is the second half of the change.**

---

## 3. The design — a per-map source-loader registry

### 3.1 Registration surface (per-map option, not global)

```ts
new XGISMap(canvas, {
  sources: {
    // key = the .xgis `type:` VERBATIM, incl. the `x-` (§4). Blessed loaders take typed params, not the bag (§6).
    'x-kr-admin': krAdminLoader(seoulSigunguGazetteer({ vintage: '2026' }), { codeColumn: 'gu', valueColumn: 'out' }),
  },
})
```

`XGISMapOptions.sources?: Record<string, SourceLoader>` — a **per-map** registry, mirroring the
construction-immutable `backend?` option shipped in #795 (per-canvas, no global mutable state, isolation
between maps). A global `addProtocol`-style registry is the **alternative** (§10, Q1); per-map is
recommended for the same reasons #795 chose a construction option over the `?forcegl2` global.

### 3.2 The loader contract

```ts
/** A custom source loader: given the declared source options + host-injected I/O, produce a
 *  renderable payload. Runs once at source-attach time; the result is routed through the SAME
 *  `_attachGeoJSONViaVirtualPMTiles` path the built-in geojson branch uses (§3.3), so a custom
 *  source is indistinguishable from a built-in downstream. */
interface SourceLoader {
  (ctx: SourceLoadContext): Promise<SourceLoadResult>
}
interface SourceLoadContext {
  readonly id: string                               // the source name
  readonly url: string                              // resolved (base-joined) url, '' if none
  readonly options: Readonly<Record<string, string | number | readonly string[]>>  // the opaque bag (§5)
  readonly fetch: (url: string) => Promise<Response>  // host-injected, SSRF-guarded (safeFetch)
}
// Discriminant matches the pipeline's `EncodeResult.kind` EXACTLY ('fc' | 'points'), so a pipeline
// loader returns its `EncodeResult` almost verbatim (api-review F5). `FeatureCollectionLike` is
// @xgis/shared's STRUCTURAL FC type (not @xgis/data's) — keeps the pipeline a shared-only leaf
// (architect Finding E). `PointPatch` is likewise satisfied structurally (api-review F6). Both kinds
// attach via the SAME FC path today (points → `pointPatchToFeatureCollection`, map.ts:4047); NO separate
// fast path is claimed (architect Finding C — `setSourcePoints` already collapses to `setSourceData`).
type SourceLoadResult =
  | { kind: 'fc';     data: FeatureCollectionLike }
  | { kind: 'points'; data: PointPatch }
```

Tile-producing custom loaders (a custom vector-tile archive → the `attachPMTilesSource` path) are
explicitly out of Phase 1 (§9).

### 3.4 Threading the registry (Finding F)

`SourceManager` keeps no `this.deps` bag — its constructor destructures deps into private fields
(`source-manager.ts:119-136`). So the registry is a new `SourceManagerDeps.sourceLoaders?` member + a
retained field, threaded from `new SourceManager({ … })` (`map/src/map.ts:934`), with
`XGISMapOptions.sources` stored on `XGISMap` at construction (mirrors the `backend?` field, `map-types.ts:104`).

### 3.3 Runtime wiring (route through the geojson attach path, not a bare seed)

Hoisted to **immediately after** `const declaredType = load.type` (`source-manager.ts:217`) — *before* the
raster / vector-tile / inline heuristics (`:224`/`:225`/`:319`), because the registry is the authority and a
custom type whose URL happens to look like a tile template (`{z}/{x}/{y}`) or end in `.pmtiles` must not be
hijacked into the raster / `attachPMTilesSource` branch (**architect Finding D**):

```ts
const custom = this.sourceLoaders?.[declaredType]          // per-map registry — a threaded dep (§3.4)
if (custom) {
  const result = await custom({ id: load.name, url, options: load.options ?? {}, fetch: safeFetch })
  const fc = result.kind === 'points'
    ? pointPatchToFeatureCollection(result.data)           // points = sugar (@xgis/data helper, used at map.ts:4047)
    : result.data
  await this._attachGeoJSONViaVirtualPMTiles(load.name, fc, maps, cameraFitState)   // the geojson branch's ACTUAL store
  return
}
```

The output routes through **`_attachGeoJSONViaVirtualPMTiles`** (`source-manager.ts:457`) — the *exact* path
the GeoJSON-URL branch uses (`:377`): it tiles via `VirtualPMTilesBackend`, reprojects, runs
cap-pole/heatmap/camera-fit, and registers in `vtSources`/`rawDatasets`. That is what makes "renders
identically" TRUE **and** earns the §7 no-teardown cut *by reuse* — a source attached this way is
indistinguishable from a built-in, so `setSourceData`/`updateFeature`/`teardownSource`/pick all work for
free. ⚠️ **A bare `rawDatasets.set(id, fc)` seed renders a BLANK frame** (real-GPU-verified,
`source-manager.ts:193-196`); an earlier draft's wiring was refuted on exactly this and on a non-existent
`_setSourcePointsInternal`. `safeFetch` (the SSRF guard) is injected so loaders never touch `fetch`.

---

## 4. Custom `type` — the runtime registry is the authority (there is no compile gate to open)

⚠️ **Correcting the first draft (architect Finding A, CONFIRMED against the code).** The `SOURCE_TYPES`
enum (`language.ts:101`) is **not enforced on the `map.run()` path**: `lowerSource` sets `type =
prop.value.name` for *any* identifier with no check (`compiler/src/ir/lower.ts:135-136`), and the enum's
only non-test consumer is the blueprint node-palette (`blueprint/src/types.ts:12`) — nothing in
parse / lower / emit / runtime. So **`type: kr-admin` already lowers today** to `SourceDef.type='kr-admin'`;
there is no compile gate to "open." The compiler change therefore **shrinks to the options bag alone**
(§5) — no enum edit.

```
source flows {
  type: "x-kr-admin"        # QUOTED string (below) — also the registry key, verbatim
  url:  "living-mobility-2026.csv"
  code: "gu"                # optional; read by a dynamic loader via ctx.options (§5) — a typed loader bakes it in (§6)
}
```

- **Custom types are QUOTED strings, not bare identifiers.** The `.xgis` identifier grammar is
  `[a-zA-Z_][a-zA-Z0-9_]*` (no hyphen — `compiler/src/convert/expr-lookup.ts:44`), so a bare
  `type: x-kr-admin` tokenises as the expression `x - kr - admin` and silently falls back to `geojson`
  (a real bug the real-GPU gate caught). Writing `type: "x-kr-admin"` (a string, like `url:`) sidesteps
  the grammar and reads as exactly the registry key. `lowerSource` accepts a string OR an identifier for
  `type`; built-ins stay bare (`type: geojson`).
- **The registry is the sole authority.** At dispatch (§3.3), `sourceLoaders[declaredType]` present → the
  custom loader runs; absent → a **loud runtime error that lists the registered keys**:
  `no loader for source type 'x-kr-admin'; registered: [ … ] — pass it in XGISMapOptions.sources`
  (**api-review F3** — the message MUST name the keys, and the same error covers the `sources`-omitted
  case). This is the real typo-guard; without it an unknown type falls into the geojson branch and crashes
  on `.features` (the hazard `emit-commands.ts:19-25` already warns about).
- **Registry key = the `.xgis` `type:` string, VERBATIM.** The dispatch looks up
  `sourceLoaders[load.type]`, so the option key must equal the declared type *including the `x-`*
  (`{ 'x-kr-admin': … }`, **not** `{ 'kr-admin': … }` — corrects the first draft's §3.1 mismatch,
  **api-review B2**). This three-way string contract (`.xgis` `type:` ↔ option key ↔ dispatch) is invisible
  to the type system (**api-review F3**); the loud registered-keys error is its only guard.
- **`x-*` is a convention that earns its keep in tooling only.** Adding `x-*` to the *blueprint* schema
  gives the node palette a custom-source lane + a typo hint *there* — it is NOT a `map.run()` gate (there is
  none). Recommended for author honesty; optional to Phase 1. The open-enum-plus-warn alternative (§10 Q2)
  is moot: the enum already imposes no `map.run()` barrier.

---

## 5. The options bag — carrying custom fields through compile → runtime

A custom source may declare fields the built-ins don't (`code`, `value`, `weight`, …). This is the one
compiler change that REMAINS (the enum does not — §4). The minimal plumbing:

- **Schema** — for a custom (`x-*`) type, permit arbitrary scalar/string-array properties instead of the
  fixed `name/url/layers` set (`language.ts:99-103`). A property whose name collides with a **reserved**
  key (`name/type/url/data/layers/crs`) is a **compiler error**, not a silent shadow (**api-review F7** —
  else a user field named `url` is swallowed by the built-in lowering).
- **Lower** — `lowerSource` collects the non-reserved props into `SourceDef.options?: Record<string,
  string|number|readonly string[]>`. A pure additive IR field; built-ins leave it undefined (byte-identical
  lowering — the §9 gate, achievable exactly as the existing additive `crs?`/`inlineData?` fields are,
  `render-node.ts:73-82`).
- **Emit** — `LoadCommand` carries `options?` through verbatim (additive field).
- **Runtime** — the dispatch passes `load.options` into the loader `ctx.options`.

**The bag is an ESCAPE HATCH, not the blessed path (api-review F4).** A blessed loader takes *typed*
constructor params (`krAdminLoader(gaz, { codeColumn, valueColumn })`, §6) so a missing/mistyped column
fails at construction, not deep inside `join` with the wrong blame. `ctx.options` is for fully-dynamic
loaders that read fields from `.xgis` at attach time; those own their validation. `gaz` is never a live
object in `.xgis` text — the bag is scalars only; a loader closes over the gazetteer it was built with.

---

## 6. How `@xgis/pipeline` plugs in — the first producer

The pipeline's join+encode **is** a loader body. A thin adapter turns the composable verbs into a
`SourceLoader`:

```ts
// @xgis/pipeline/loaders — a source loader backed by the gazetteer join + bubble encoder.
// TYPED params (not the ctx.options bag) → a missing/mistyped column fails HERE, not deep in join (F4).
function krAdminLoader(gaz: Gazetteer, cols: { codeColumn: string; valueColumn: string }): SourceLoader {
  return async ({ url, fetch }) => {
    const text = await (await fetch(url)).text()
    const t    = fromCSV(text, { vintage: gaz.vintage, types: { [cols.codeColumn]: 'string' } })
    const j    = join(t, { code: cols.codeColumn, gaz, as: 'o' })
    const enc  = bubble(j, { lon: 'o.lon', lat: 'o.lat', value: cols.valueColumn })
    return { kind: 'fc', data: enc.toFeatureCollection() }   // SHIPPED EncodeResult API — NO toPointPatch (B1)
  }
}
```

- **Declarative** (this seam): `source flows { type: "x-kr-admin", url: "…" }` +
  `sources: { 'x-kr-admin': krAdminLoader(gaz, { codeColumn: 'gu', valueColumn: 'out' }) }`. Columns are baked
  into the typed loader, so the source block is just `type` + `url`; the city loads from one line.
- **Imperative** (unchanged): `load({ from, join, transform, show }).apply(map, 'flows')` — still the path
  for dynamic / animated data (the hourly-pulse demo), which a static source declaration can't express.

The two are complementary lanes over the **same** encode output. The seam does not replace the pipeline;
it gives the pipeline a declarative front door.

---

## 7. Boundaries (the 5-year bar)

- **Engine untouched / content-blind.** The registry, the loader contract, and the dispatch branch live in
  `@xgis/map`; the additive `options?` bag lives in `@xgis/compiler` (above engine). `@xgis/engine` renders
  the produced meshes/points exactly as today — zero new engine concept, zero `engine → map` edge. (The
  seam touches **map + compiler**, not map only — corrects the first-draft implication.)
- **Host-injected I/O.** Loaders never import `fetch`/`fs`; they receive the SSRF-guarded `safeFetch` —
  same rule as the compiler `module` resolver and the pipeline's ingest.
- **No new deps.** The seam is types + one dispatch branch + one options field. `@xgis/pipeline` stays a
  zero-runtime-dep leaf; its loader adapter uses only its own verbs + `@xgis/shared` FC types.
- **One seam, bounded.** `type → loader → { fc | points }` (both attach via the one geojson path, §3.3). No
  lifecycle, no ordering, no teardown hooks, no layer-type registry — a separate, later decision.

---

## 8. What this is NOT

- **Not a plugin framework.** One registration point with a fixed contract. (The general plugin idea was
  cut as YAGNI in `data-to-viz-pipeline.md §2b`; that judgment stands.)
- **Not a custom-renderer / custom-layer seam.** Custom sources produce the *existing* payloads; they do
  not introduce new draw paths. A custom *renderer* is out of scope, forever unless separately justified.
- **Not a compile-time-knows-runtime coupling.** The compiler never learns the registered names; it only
  admits the `x-*` lane. The runtime registry is the sole authority on resolution.

---

## 9. Scope & phasing

- **Phase 1 (the seam, minimal):** `XGISMapOptions.sources` per-map registry (threaded via
  `SourceManagerDeps`, §3.4) · the `SourceLoader` / `SourceLoadContext` / `SourceLoadResult` contract ·
  `SourceDef`/`LoadCommand` `options?` bag with reserved-field guard (additive, built-in lowering
  byte-identical) · the one **hoisted** dispatch branch routing through `_attachGeoJSONViaVirtualPMTiles` ·
  **one worked loader** (`krAdminLoader`) rendering the Seoul sample from a declared `source { type:
  x-kr-admin }`, proven real-GPU headed. **No enum edit** (there is no gate — §4). Nothing else.
- **Phase 2:** more pipeline-backed loaders (choropleth / odFlow) · a `crs` pass-through so a custom
  loader can emit projected coordinates into the existing `_reprojectIngest` path · the `x-*` blueprint
  schema lane + a loader-`kind`×layer-type mismatch diagnostic (**api-review F8**) · error-surface polish.
- **Phase 3 (only if demanded):** tile-producing custom loaders (custom vector-tile archive → the
  `attachPMTilesSource` path) · a global `addProtocol`-style registry if a cross-map use-case appears ·
  a `.xgis`-native `transform`/`join` surface atop the programmatic core.

**Verification (mandatory, per CLAUDE.md §5) — DONE.** The headed real-GPU gate
(`playground/e2e/_host-source-loader-verify.spec.ts`) asserts the custom branch RAN
(`__xgisCustomLoaderRan === 'x-kr-admin'`) AND its bubbles rasterised (0.498% orange coverage — NOT a
bare-seed blank frame, the §5-parity trap this gate closes). Built-in lowering is unaffected (compiler
vitest 3473/3473, map source 81/81 — the byte-identical gate). ⚠️ The gate caught the identifier-grammar
bug (bare `type: x-kr-admin` silently fell back to `geojson`); custom types are QUOTED strings (§4).

---

## 10. Open questions for the ratifier

1. **Registration surface** — per-map `XGISMapOptions.sources` (recommended, #795-consistent) vs a global
   `XGISMap.registerSource(type, fn)` (MapLibre `addProtocol` shape). Per-map unless a cross-map sharing
   need is real.
2. **`x-*` convention** — adopt `x-*` naming (blueprint-palette honesty + a greppable custom lane) or leave
   `type` fully free-form? Recommended: adopt as convention only — NOT a compile gate (there is none, §4);
   the runtime registered-keys error is the sole real guard either way.
3. **Loader adapter home** — `@xgis/pipeline/loaders` (against a *structural* `SourceLoader` type, so the
   leaf never imports `@xgis/map` — same trick as `PipelineSink`) vs a tiny `@xgis/map`-side adapter.
   Leaning: pipeline owns it, structurally (Finding E satisfied — the single-FC result carries only
   `@xgis/shared` types).
4. **Result union** — keep `{ fc | points }` (mirrors `EncodeResult.kind`, ergonomic for producers) vs
   collapse to a single `fc` (both attach identically today, `map.ts:4047`). Leaning: keep the two-kind
   union — two lines, maps 1:1 to the pipeline's two encoders, no phantom fast-path claimed.

---

## 11. ADR summary (for `docs/adr/0011-*` on ratification)

- **Context.** X-GIS renders and lays out completely. A host can already get custom data onto the map
  *imperatively* (stub-declare + `setSourceData`), but there is no **declarative** on-ramp for a custom
  source *type* in `.xgis`: the `type` vocabulary is closed by convention (the `SOURCE_TYPES` enum is
  consumed only by blueprint tooling — `lowerSource` accepts any identifier, verified), `addSource` is an
  explicit no-op, and no registration surface exists (audit-confirmed). The gap is ergonomic-declarative,
  and it is the biggest for the "load any data" goal.
- **Decision.** Add a **bounded, per-map source-loader registry** (`XGISMapOptions.sources`) consulted by
  the existing `source-manager` dispatch — hoisted **before** the URL-shape heuristics so the registry is
  authoritative — when a declared `type` is not a built-in. A loader receives the declared options +
  host-injected `safeFetch` and returns `{ fc | points }`; the output is routed through the SAME
  `_attachGeoJSONViaVirtualPMTiles` path the geojson branch uses (a bare `rawDatasets.set` renders blank —
  verified), so there is no new render path. The **only** compiler change is an additive `options?` bag on
  `SourceDef`/`LoadCommand` (built-in lowering stays byte-identical) — **no enum edit**, because the enum is
  not a `map.run()` gate; the runtime registered-keys error is the authority. `@xgis/pipeline` supplies the
  first loader (typed constructor params, not the opaque bag); `.apply()` remains the imperative path.
- **Consequences.** (+) The declarative language becomes extensible without a plugin framework; engine
  content-blind; one seam, fixed contract; the pipeline gets a declarative front door by *reusing* the
  attach path (teardown/update/pick fall out free). (−) A compiler + map change (additive) and a public
  contract to keep stable for 5 years — mitigated by scalars-only options, a reserved-field compiler guard,
  and a byte-identical-lowering gate. (Δ) A purely-imperative alternative exists (implement the dead
  `addSource` stub to call `_attachGeoJSONViaVirtualPMTiles` — zero compiler change); it is smaller but
  loses the declarative `.xgis` custom-type the user explicitly wants. Opens a future custom-tile /
  global-registry question, deferred.
