# S-100 GAP-1 — HDF5 Gridded-Coverage Data Path (S-102 / S-104 / S-111)

**Status:** design proposal (2026-07-16), architect pass, all X-GIS claims file:line-grounded, all S-100 claims tied to the feasibility report (`docs/research/2026-07-16-s100-rendering-feasibility.md` — hereafter **[FR]**) or explicitly marked _to-verify_.
**Scope:** GAP-1 of [FR] §6.2 — the HDF5 gridded-coverage ingest + render path. Explicitly **not** in scope: GAP-2 (Part 9/9a Lua portrayal engine), GAP-3 (ellipsoid datum — owned by epic #1152, `docs/architecture/design/ellipsoid-datum-unification.md` — hereafter **[ED]**), and vertical-datum _rendering_ (fields are reserved here).
**Companion docs:** `docs/architecture/source-loader-seam.md` (the custom-source seam), [ED] (datum), [FR] (S-100 facts).

---

## 0. Summary (decisions up front)

1. **Ingest = offline converter CLI first** (`s100-to-xgcov`), backed by an **in-house, zero-dep HDF5 subset reader** written as a pure `DataView` module so it is runtime-promotable later without a rewrite. No npm/WASM HDF5 at runtime, ever; no h5wasm even as the CLI's engine. This is the exact shape of the shipped `.odb` precedent (offline tool → tiny native binary → zero-dep runtime decode, `pipeline/src/odb/format.ts:1-28`).
2. **Data model = a new X-GIS-native coverage artifact (`.xgcov`)** — north-up, band-planar, multi-timeslice, deflate-compressed float/quantized grids with a JSON header that carries the S-100 metadata (grid geometry, vertical-datum code, positive-down flag, time metadata) — plus a new **built-in `coverage` source type** in `@xgis/map`, following the `raster` source's marker-and-arm pattern (`source-manager.ts:287`, `map.ts:3046-3054`). Product knowledge (S-102/104/111) lives **only** in the converter; `@xgis/map` learns a _generic_ gridded-coverage concept, keeping the engine content-blind and the map product-agnostic.
3. **Rendering = extend the raster pipeline with a coverage arm** (data texture + colour-ramp LUT), **not** the heatmap pipeline (which is a point-splat density accumulator, the wrong tool — `heatmap-renderer.ts:1-21`). S-111 arrows ride the existing retained `arrow` primitive whose bearing convention is _already_ S-111's native convention (degrees true, clockwise from north — `graphics-types.ts:72-75` ↔ [FR] §3.2). S-104 is the coverage ramp + a time axis. 3-D height fields/extrusion are deferred (no DEM machinery exists; hillshade is explicitly unimplemented, `compiler/src/convert/spec-coverage.ts:146`).
4. **Time = GPU-state-only swap** (`map.setCoverageTime(...)` re-uploads one resident texture / re-packs arrow attributes via `handle.update({triggers})`, `graphics-manager.ts:209-211`) — never re-attach, never re-tile, per the flicker-free lesson (flow-map v2).
5. **Increments:** INC-A (one real NOAA S-102 grid, colour-ramped, flat Mercator, full verification ladder) → INC-B (globe drape + datum metadata carried) → INC-C (S-111 arrows + time) → INC-D (S-104) → INC-E (deferred, demand-gated: pyramid tiling at scale, runtime HDF5 loader, particle-flow upgrade, DCF3/DCF9).

---

## 1. Requirements being designed for (from [FR], with confidence flags)

| Fact                                                                                                                                                                                                                                                                           | Source                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Part 10c dataset = a single HDF5 file (profile of HDF5 **1.8.8**); hierarchy Root → `Group_F` → feature container → feature instance `<Feature>.01` (`gridOrigin*`, `gridSpacing*`, `numPoints*`, `startSequence`) → `Group_001..NNN` each holding a compound `values` dataset | [FR] §2.4, §3.2                                      |
| DCF enum: **2 = regular grid** (the main one), 3 = ungeorectified (+ Positioning group), 9 = featureOrientedRegularGrid (S-102 QualityOfBathymetryCoverage)                                                                                                                    | [FR] §3.2                                            |
| S-102 Ed 3.0.0: DCF2, band1 **depth (positive-down)**, band2 uncertainty, **static**, WGS84, multi-resolution via multiple coverage instances, NOAA OCS tiling scheme, tracking-list overrides                                                                                 | [FR] §3.2, §5.2                                      |
| S-104 Ed 2.0.0: DCF2, band1 waterLevelHeight (chart datum), band2 waterLevelTrend enum (0=nodata,1=dec,2=inc,3=steady), **time-series**                                                                                                                                        | [FR] §3.2                                            |
| S-111 Ed 2.0.0: DCF2 (&3 — but GDAL reads DCF2 only), band1 speed (knots), band2 **direction (° true, CW)**, time-series, currents at 4.5 m depth                                                                                                                              | [FR] §3.2                                            |
| Native arrays are **south-row-first**; GDAL flips to north-up by default                                                                                                                                                                                                       | [FR] §3.2                                            |
| Time metadata: `numberOfTimes`, `timeRecordInterval`, `dateTimeOfFirst/LastRecord`, delivery interval (e.g. `PT6H`)                                                                                                                                                            | [FR] §3.2 (GDAL-sourced)                             |
| Vertical datums decoupled from geodetic CRS, plural, positive-down soundings, LAT = code 23; S-102 vertical-datum codes are **S-100 codes, not EPSG**                                                                                                                          | [FR] §5.2, §7.13                                     |
| Reference implementations to validate against: GDAL S102/S104/S111 drivers, NOAA s100py                                                                                                                                                                                        | [FR] §3.2                                            |
| ⚠️ HDF5 attribute casing (`gridOriginLongitude` vs snake_case) is **indicative only** — exact primary-spec spellings not verbatim-fetched                                                                                                                                      | [FR] §7.10 — _to-verify against real files in INC-A_ |
| ⚠️ S-104 DCF1/DCF3 support claims **unverified** (s100py implements DCF2 only)                                                                                                                                                                                                 | [FR] §7.8                                            |
| NOAA publishes S-102/S-104/S-111 sample data (S-104/S-111 PDS S3 buckets cited; the S-102 sample bucket URL is _to-verify_ at INC-A kickoff)                                                                                                                                   | [FR] §3.2 sources                                    |

---

## 2. Current-state evidence — what X-GIS has and what is genuinely missing

### 2.1 What exists (reusable as-is or nearly)

- **Source dispatch + custom-loader seam.** `SourceManager._attachOneSource` dispatches declared sources into raster / vector-tile / inline / geojson branches (`map/src/source-manager.ts:205-444`); a per-map custom-loader registry is consulted for non-built-in types (`source-manager.ts:247-276`), with `BUILTIN_SOURCE_TYPES` derived from the compiler's `SOURCE_TYPES` (`source-manager.ts:58-62`; enum at `compiler/src/schema/language.ts:59-101`). **Limitation:** the loader contract returns `'fc' | 'points'` only (`map/src/source-loader.ts:46-48`) — a gridded payload cannot ride it today, and tile-producing loaders are explicitly Phase-3-deferred (`source-loader-seam.md` §9).
- **Raster pipeline with globe drape.** `type: raster` stores a `{_tileUrl}` marker (`source-manager.ts:286-289`, marker union `map/src/map-types.ts:21-26`); a layer referencing it arms `RasterRenderer.setUrlTemplate` (`map/src/map.ts:3046-3054`). The renderer owns an LRU tile cache (`raster-renderer.ts:173-192`), streams XYZ tiles, and draws through `RasterDraper` on **both flat and globe** — including the ellipsoid ECEF camera anchor (`raster-renderer.ts:24-35`) and polar caps (`raster-renderer.ts:112-127`). **Limitation:** URL-template-only (`hasSource()` = `urlTemplate !== ''`, `raster-renderer.ts:321-323`); textures come exclusively from _image decode_ (`raster-renderer.ts:181,426-443`). No float-data-texture arm, no ramp sampling in the raster shader.
- **Colour-ramp machinery.** 256×1 RGBA LUT creation + linear-clamp sampler exist twice: named ramps (`map/src/color-ramp.ts:120-158`) and per-layer heatmap ramps baked from arbitrary stops (`heatmap-renderer.ts:47-53`, `buildRampTexture` `:230-266`). Generalising to "custom stops → LUT" is trivial reuse.
- **Vector-field primitives.** Retained `arrow` batches: geo anchor + **geographic bearing in degrees, 0 = north, clockwise**, GPU-projected so it stays correct under bearing/pitch/globe (`map/src/graphics/graphics-types.ts:67-82`, esp. `:72-75`) — _exactly_ S-111's direction convention, no conversion needed. Retained `particle-flow` batches with closed-form stateless drift on both backends (`graphics-types.ts:113-146`). Handles support in-place `update({triggers})` re-pack (`graphics-manager.ts:191-225`, `:209-211`), exposed as `map.graphics` (`map/src/map.ts:323-326`).
- **Flicker-free property updates.** `setPaintProperty` (`map/src/map.ts:3810-3860`) and the flow-map v2 discipline: animation = GPU-state-only changes; re-tiling/re-attach flickers.
- **The offline-converter precedent.** `.odb`: offline CLI (`pipeline/tools/csv-to-odb.ts`) aggregates 300 MB CSV → ~100 KB binary; encode+decode live together, zero-dep by construction (`pipeline/src/odb/format.ts:10-12`); a typed loader consumes it (`pipeline/src/loaders/index.ts:70-124`).
- **Float texture formats in the RHI.** `r16float`/`rgba16float` are RHI texture formats (`rhi/src/rhi.ts:67-68`). Caveats: WebGL2 float _render targets_ fail closed without `EXT_color_buffer_float` (`rhi-webgpu/src/rhi-renderpass-parity.test.ts:315`) — irrelevant here (we only _sample_); `r32float` **filterable** is an optional WebGPU adapter feature and already deferred elsewhere (`compiler/src/codegen/paint-routing.ts:106`, `compiler/src/ir/emit-commands.ts:384`) — so the coverage texture must be `r16float`, not `r32float`.

### 2.2 What is genuinely missing (the real GAP-1 inventory)

1. **Any HDF5 reading capability** — [FR] §6.2 GAP-1, confirmed: no `hdf5` module anywhere in the tree.
2. **A gridded-coverage source concept** — every source resolves to features (fc/points/vector-tiles) or image tiles; no path carries "a georeferenced value grid" to the GPU.
3. **A data-texture + ramp arm in the raster shader** (`map/src/shaders/dsl/raster.ts` today applies opacity/hue/brightness to sampled image texels — `raster-renderer.ts:48-85`).
4. **A time dimension on a source** — no source has per-timestamp state or a time-selection API.
5. **A vertical-datum metadata channel** — [ED] §"S-100 scope honesty": "decoupled plural VERTICAL-datum model … entirely unbuilt".
6. **Grid→glyph sampling glue** (decimate a value grid into arrow/particle instances by zoom).

---

## 3. Decision 1 — Ingest architecture: offline converter first, in-house zero-dep HDF5 subset reader

### 3.1 Options weighed

|                          | (a) Runtime in-house HDF5 subset reader                                                                                                                                                                                                             | (b) Offline converter CLI → native artifact                                                      | (c) WASM (h5wasm) at runtime                          |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Zero-runtime-deps policy | ✅ (if in-house)                                                                                                                                                                                                                                    | ✅                                                                                               | ❌ shipped ~MB WASM dep — hard violation              |
| Mobile cost              | ❌ full multi-MB `.h5` download + parse to show one viewport; no HTTP-range story without chunk-index walking                                                                                                                                       | ✅ artifact is pre-flipped, pre-mosaicked, compressed, eventually tiled                          | ❌ same as (a) plus WASM init                         |
| Operational reality      | ENC-grade data is exchange-set distributed and Part-15 encryptable ([FR] §1.3, §2.5); browsers can't participate in that machinery anyway — data is processed shore-side in practice (GDAL/s100py exist precisely as shore-side tooling, [FR] §3.2) | ✅ matches how the ecosystem actually moves this data                                            | same as (a)                                           |
| 5-year maintenance       | HDF5 parsing is a known trap surface (chunk b-trees, filter pipelines, datatype messages); but the Part-10c profile **pins HDF5 1.8.8** ([FR] §2.4), bounding it                                                                                    | Converter isolates all format risk offline, where failures are loud and fixable without shipping | Depends on a third-party WASM build chain for 5 years |
| Time-to-first-pixel      | Slowest (reader + renderer both blocking)                                                                                                                                                                                                           | Fastest (reader validated offline against GDAL; renderer developed against known-good artifacts) | Fast but poisoned                                     |

### 3.2 Verdict

**Converter-first (b), with the HDF5 reader implemented in-house as a pure, dependency-free TypeScript module** (`DataView` only, no `node:*` imports) that the CLI consumes today and a runtime loader _could_ consume later. This is deliberately **not** "(b) now, (a) never": the reader's purity is a hard constraint of this design, so promoting it to a runtime `s102` loader later (INC-E, demand-gated) is a thin wrapper, not a rewrite — the same both-ends trick `.odb` uses (`format.ts:10-12`).

**h5wasm is rejected even as the CLI's devDep engine** (devDeps are allowed by policy): it would strand the capability offline forever (WASM can never cross into runtime under zero-deps), and it removes the differential-testing pressure that makes the in-house reader trustworthy. GDAL and s100py remain the _oracles_ the in-house reader is validated against ([FR] §3.2) — used to generate committed golden fixtures, never linked.

### 3.3 HDF5 subset scope pin (the reader's contract)

Support exactly what the S-100 Part-10c profile and real S-102/104/111 files need, **fail loudly on everything else**:

- Superblock v0 **and** v2 (h5py/libhdf5-1.8-era files use v0; "latest-format" writers emit v2 — both appear in the wild; _to-verify against the INC-A corpus, then narrow if possible_).
- Object headers v1 and v2; symbol-table groups **and** link-message groups.
- Dataspace/datatype/layout/attribute/filter-pipeline messages.
- Layouts: contiguous + chunked (v1 b-tree chunk index only).
- Datatypes: fixed-point (u8/u16/u32), IEEE float32/float64, enum, string (fixed), **compound** (member offsets read from the datatype message — never assumed packed; [FR] §3.2 `values` is compound).
- Filters: **deflate** (`DecompressionStream('deflate')`/inflate — pure, built-in) and **shuffle** (a trivial byte transpose, implemented in-house). Any other filter id ⇒ hard error naming the filter.
- Attribute name matching is **case-tolerant with a logged warning** on non-canonical casing ([FR] §7.10).

Estimated size: ~2–3 k LOC + tests. The single largest new component and the top-risk item (§8.1); its gate is differential equality against GDAL/s100py dumps (§7).

### 3.4 Placement

- `pipeline/src/hdf5/` — the reader (pure, zero-dep, runtime-clean by construction).
- `pipeline/tools/s100-to-xgcov.ts` — the CLI (bun; `node:fs` allowed here, tools are offline — `csv-to-odb.ts` precedent). Auto-detects product from root metadata; flags: `--out`, `--quantize u16|f32`, `--time all|<index-range>`, `--merge <dir>` (NOAA tile-scheme mosaicking, INC-E).
- `data/src/coverage/format.ts` — the `.xgcov` codec, encode + decode in ONE file (odb "never drift" rule, `format.ts:71-73`). Decode is the runtime half used by the built-in `coverage` source; ~300 LOC of DataView + `DecompressionStream`.

---

## 4. Decision 2 — Data model: the `.xgcov` artifact + a built-in `coverage` source

### 4.1 Artifact (`.xgcov` v1 — single grid, multi-band, multi-timeslice)

```
magic      u32   "XCOV"
version    u16   = 1
headerLen  u32   → UTF-8 JSON header
header (JSON):
  product:        's102' | 's104' | 's111' | 'generic'   // provenance only — runtime is product-blind
  crs:            'EPSG:4326'                             // WGS84 lon/lat grid ([FR] §3.2)
  origin:         [lonDeg, latDeg]      // SW cell *centre*; registration explicit (§8.4)
  spacing:        [dLonDeg, dLatDeg]
  size:           [nLon, nLat]
  registration:   'point'                                  // pinned v1; 'area' reserved
  bands:          [{ name, unit, nodata, kind: 'f32'|'u16', scale?, offset?, enum?: {…} }]
  vertical:       { datumCode: number|null,               // S-100 code, e.g. 23 = LAT ([FR] §5.2)
                    datumName?: string,
                    sign: 'down'|'up' }                   // S-102 depth = 'down' — values stored VERBATIM (§8.3)
  time:           null | { count, firstIso, lastIso, intervalSeconds? }   // + reserved time.stamps?: string[]
  sourceMeta?:    { …verbatim carrier attributes… }        // uninterpreted, for pick reports later
blocks:    time-major, band-planar: for t in 0..T-1, for b in bands:
             u32 compressedLen + deflate(raw grid, row-major, NORTH-UP)
```

Design points:

- **North-up is normalised at convert time** (single flip, GDAL-parity — [FR] §3.2), asserted by an asymmetric-grid golden. The runtime never sees `startSequence`/scan-order concerns.
- **Values are stored verbatim** — S-102 depth stays positive-down with `vertical.sign='down'`; no silent sign flips (military-precision rule). Rendering expresses direction via the ramp; a future 3-D path inverts explicitly at the one documented seam.
- **Per-band `u16 + scale/offset` quantization option** for mobile weight. The runtime always decodes to `Float32Array` CPU-side.
- **Uncertainty (S-102 band2) and trend (S-104 band2, enum) are ordinary bands** — carried, not yet rendered.
- v1 is a **single artifact per coverage**. The pyramid/tiled evolution is a _manifest_ (`.xgcov.json`, TileJSON-shaped) pointing at per-tile `.xgcov` payloads on the Web-Mercator XYZ grid — deferred to INC-E, because the streaming/LRU machinery it slots into already exists (`raster-renderer.ts:173-192`).

### 4.2 Multi-resolution instances + NOAA tiling → the pyramid (INC-E semantics, decided now)

- Each S-102 coverage instance's `gridSpacing` maps to a native zoom `z ≈ log2(360 / (256·dLonDeg))`; finer instances override coarser where they overlap. Parent levels by aggregation — **decided: numeric MIN of positive-down depth (shoalest) for overview levels** — hazard-conservative for a navigation product, documented in the manifest.
- NOAA's per-tile `.h5` files are multiple converter inputs mosaicked before pyramid emission (`--merge`).

### 4.3 The runtime source: built-in `type: coverage`

- Add `'coverage'` to `SOURCE_TYPES` (`language.ts:59`) — `BUILTIN_SOURCE_TYPES` picks it up automatically (`source-manager.ts:62`). Making it _built-in_ (rather than a custom loader) is forced by the seam's fc/points-only contract (`source-loader.ts:46-48`) — extending that contract was considered and rejected (§9, T2).
- Dispatch branch in `_attachOneSource` (beside the raster branch): `safeFetch` the `.xgcov` (same SSRF/body-cap discipline as the geojson branch, `source-manager.ts:391-409`), decode, store a `{_coverage: CoverageHandle}` marker in `rawDatasets` (extending the marker union, `map-types.ts:21-26`).
- `CoverageHandle` (in `@xgis/data`): header + per-timeslice decoded `Float32Array`s (CPU-resident — the authority for exact value readout/picking) + the active time index. GPU state (the `r16float` texture) is owned by the renderer, not the handle (device-swap safety — the `syncDevice()` lesson).
- Layer arming mirrors raster exactly (`map.ts:3046-3054` pattern).

### 4.4 Time flow

- `map.setCoverageTime(sourceId, indexOrIsoString)` → selects the slice, re-uploads the **single resident texture** (`writeTexture`; queue-ordered, no torn frame), invalidates. No re-attach, no re-tiling. For S-111 arrows the same call re-packs the arrow batch via `handle.update({ triggers })` through the glue helper (§5.2).
- One resident texture per coverage (re-upload on scrub) rather than T resident textures; revisit only with profiling evidence (INC-E).

---

## 5. Decision 3 — Rendering mapping

### 5.1 S-102 (and the shared coverage ramp arm)

**Renderer: the raster pipeline, extended — not the heatmap pipeline.** The heatmap is a 3-pass Gaussian point-splat accumulator over per-point buffers (`heatmap-renderer.ts:1-21`) — the wrong tool for data that _is already a field_. What S-102 needs is what `RasterDraper` already does (flat + globe, ellipsoid-anchored, pole caps) with two texel-level differences:

1. **Data texture instead of an image texture:** `r16float`, single channel, nodata as NaN texel or a sentinel uniform (r16float is core-filterable on WebGPU and half-float filtering is WebGL2-core; `r32float` filterable is an optional adapter feature already avoided elsewhere). Exact CPU values stay in the `CoverageHandle`, so half precision only ever affects colour, never readout.
2. **A ramp arm in the fragment:** `value → normalize(min,max) → sample 256×1 LUT` + nodata discard/transparent. Authored in shader-dsl beside the existing raster shader (no raw WGSL in map — hard rule), as a **separate pipeline variant**, leaving the image-raster arm byte-identical. The LUT bake generalises the existing stop-interpolators — also the reserved seam for S-52 depth-token palettes later (GAP-2; day/night = LUT swap, [FR] §6.1-D).

Uniform additions: `[min, max, nodata, timeBlend?]` in a coverage-params vec4, packed via the typed `uniformBlock` discipline.

### 5.2 S-111 — arrows now, particles later

- Glue helper (~100 LOC): `coverageToArrows(handle, { strideCells | targetCount, minSpeed })` → decimated cell list `{position, bearing, speed}` → `map.graphics.add({ type:'arrow', … })`. The bearing convention is a **1:1 pass-through** ([FR] §3.2 ↔ `graphics-types.ts:72-75`).
- Knots stay knots in data; only `getSize`/`getColor` scale them (no unit laundering).
- Particle advection is a later polish: `ParticleFlowDrawSpec` exists but its drift model is per-cell-bearing, not field-following — upgrading it is real work, hence INC-E, not INC-C.
- Zoom-adaptive re-decimation: re-run the helper on `zoomend` and `update()`/`append()` the batch — no new renderer.

### 5.3 S-104 — the coverage ramp + time + a diverging palette

Same coverage arm as S-102 with: a **diverging ramp centred on 0 (chart datum)**; time scrub via `setCoverageTime`; `waterLevelTrend` carried but not rendered in INC-D. "Animated height field" in 3-D is explicitly deferred (no DEM/terrain machinery; hillshade unimplemented, `spec-coverage.ts:146`).

### 5.4 What is genuinely new, in total

| New piece                                              | Size          | Where                                                               |
| ------------------------------------------------------ | ------------- | ------------------------------------------------------------------- |
| HDF5 subset reader                                     | L (~2-3k LOC) | `pipeline/src/hdf5/`                                                |
| `s100-to-xgcov` CLI                                    | S             | `pipeline/tools/`                                                   |
| `.xgcov` codec (encode+decode)                         | S             | `data/src/coverage/format.ts`                                       |
| `coverage` source branch + `CoverageHandle` + marker   | S             | `source-manager.ts`, `map-types.ts`, `@xgis/data`                   |
| Raster coverage variant (shader + pipeline + uniforms) | M             | `map/src/shaders/dsl/`, `raster-renderer.ts` / `raster-material.ts` |
| `setCoverageTime` + invalidation                       | S             | `map.ts`                                                            |
| `coverageToArrows` glue                                | S             | pipeline/data                                                       |

Everything else (drape, pole caps, LRU streaming, arrows, ramps, update triggers, safeFetch, camera-fit) is reuse.

---

## 6. Decision 4 — API surface

```xgis
source bathy { type: coverage, url: "SEA_S102_2026.xgcov" }
layer depth  { source: bathy, ramp: "bathymetry", range: [0, 40], opacity: 0.85 }
```

```ts
// Host JS
const map = new XGISMap(canvas)
await map.run(style)
map.setCoverageTime('currents', '2026-07-16T06:00:00Z') // S-104/S-111 scrub
const d = map.getCoverage('bathy').valueAt(lon, lat) // exact CPU value (positive-down, as stored)
const meta = map.getCoverage('bathy').meta // vertical datum code/sign, time axis, bands

// S-111 arrows (host-side glue; declarative lane deferred)
const cells = coverageToArrows(map.getCoverage('currents'), { targetCount: 1500 })
const h = map.graphics.add({
  type: 'arrow',
  data: cells,
  getPosition: (c) => c.p,
  getBearing: (c) => c.dirDegTrue,
  getSize: (c) => 8 + 4 * c.speedKn,
})
```

- **No `type: 's102'` in `@xgis/map`.** The map learns _coverage_, a generic concept (product semantics live in the converter — the S-100 analogue of "engine content-blind").
- `layer … ramp/range` lowers through the existing show/paint plumbing the way raster opacity does; INC-A may carry ramp/range via source options first and graduate to paint properties in INC-D, where `setPaintProperty('depth','ramp',…)` becomes the palette-switch hook (day/dusk/night later).
- Converter UX: `bunx s100-to-xgcov chart.h5 --out chart.xgcov` → prints product, grid size, bands, time count, vertical datum.

---

## 7. Decision 5 — Increment plan with verification gates

Every increment lands behind the full merge gate (build + vitest + precheck + tsc; both LOC ratchets if map files grow — CLAUDE.md §11/§12). Render claims follow the §5 ladder.

**INC-A — one real S-102 grid, colour-ramped, flat Mercator (smallest verifiable).**
Scope: HDF5 reader (S-102 DCF2 path only) + CLI + `.xgcov` v1 (single band pair, no time) + `coverage` source + raster ramp variant + `valueAt`.
Gates:

1. _Reader differential gate (CPU, vitest):_ committed fixtures = (i) tiny synthetic `.h5` files generated offline by h5py/s100py covering superblock v0/v2, chunked+deflate+shuffle, compound member padding; (ii) a cropped real NOAA S-102 file (_to-verify availability/licence; fall back to an s100py-authored S-102-conformant file_). Assert exact f32 values, grid geometry, band names — equal to committed GDAL dumps. Fail-first: the south-row-first flip test uses an asymmetric grid that FAILS on the unflipped path.
2. _Codec gate:_ `.xgcov` encode→decode round-trip byte-exact; u16 quantization error ≤ scale/2.
3. _Render gate (headed real-GPU):_ synthetic coverage (linear N→S gradient + nodata hole + 4 known-value cells) — readback texels at computed pixel coords equal `ramp(value)` within LUT tolerance; nodata transparent; then the real S-102 render, 16-split reviewed, before/after DC ladder with measured same-code noise floor.
4. _Sign gate:_ `valueAt` returns positive-down values verbatim; `meta.vertical = { datumCode, sign:'down' }` asserted.

**INC-B — globe + datum note.**
Scope: enable the coverage variant on the globe drape path; surface `meta.vertical` as the reserved channel; [ED] cross-reference.
Gates: globe headed render (16-split); flat↔globe consistency at nadir/equator via DC ladder; metadata unit gate pinning the vertical fields' shape.

**INC-C — S-111 arrows + time.**
Scope: reader time-series path, `.xgcov` multi-timeslice, `setCoverageTime`, `coverageToArrows`, arrow wiring.
Gates: bearing correctness (synthetic 0/90/180/270° field → packed arrow geometry asserted in CPU pack tests); knots→px scaling pinned; time-scrub flicker gate (frame N vs N+1 hashes differ only inside the coverage region; no intermediate blank frame — canvas-native capture on `idle`); real NOAA S-111 PDS file end-to-end.

**INC-D — S-104.**
Scope: waterLevelHeight diverging ramp + trend enum band carried + time reuse; ramp/range as paint properties.
Gates: trend enum decode gate (0-3 mapping); ramp centring gate (value 0 → centre stop exactly); real NOAA S-104 PDS file end-to-end.

**INC-E — demand-gated follow-ups (explicitly out of committed scope):** XYZ `.xgcov` pyramid + manifest + streaming; runtime HDF5 loader; particle-flow field-following upgrade; DCF3 regridding; DCF9; S-102 tracking-list overrides; uncertainty rendering; contour extraction; 3-D bathymetry.

---

## 8. Decision 6 — Risks

1. **HDF5 complexity trap (top risk).** Chunk b-tree traversal, filter pipelines, compound alignment are where in-house readers silently corrupt data — navigation-adjacent data. Mitigations: §3.3 hard scope pin with loud failures; the differential golden corpus as the _only_ accepted proof (never "it rendered"); shuffle+deflate implemented and tested first; compound member offsets always read from the datatype message.
2. **South-row-first.** Normalised exactly once, in the converter, with a fail-first asymmetric golden. The runtime has no orientation concept — by construction it cannot regress.
3. **Positive-down.** Stored verbatim + `vertical.sign`; the ramp is the only place direction is expressed; any future 3-D consumer inverts at one documented seam. No hidden sign flips.
4. **Grid registration (cell-centre vs cell-corner).** `.xgcov` pins `registration:'point'` explicitly; the reader gate includes a half-cell-shift assertion against GDAL's geotransform. (_Exact Part-10c registration clause: to-verify during INC-A._)
5. **Attribute-casing uncertainty.** [FR] §7.10 — case-tolerant matching + warning; golden corpus pins observed spellings.
6. **Vertical-datum reservation.** Carried, never interpreted: `datumCode` is an S-100 code (not EPSG — [FR] §7.13), `sign`, optional name. Rendering vertical datums is a later epic gated with GAP-3.
7. **File sizes on mobile.** v1 single-artifact fine for harbour-scale products; u16 quantization halves it; INC-E pyramid is the real answer, semantics already decided (§4.2) so v1 artifacts don't need re-converting.
8. **Backend parity.** `r16float` sampling safe on both backends; the coverage variant must land with the WebGL2 twin from day one (the #775 lesson) — shader-dsl dual-emit covers this, mandatory anyway.
9. **Part-15 encryption.** Out of scope by design: the converter consumes decrypted files; documented loudly in the CLI.
10. **Time-axis regularity.** `timeRecordInterval` may be absent/irregular; the header reserves `time.stamps?: string[]`, and `setCoverageTime(iso)` nearest-matches.

---

## 9. Trade-offs (consolidated)

| #   | Decision                       | Chosen                                              | Rejected                                                     | What we give up                                                                                                                                           |
| --- | ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Ingest                         | Offline converter + in-house zero-dep reader        | Runtime reader first; h5wasm                                 | No drag-and-drop `.h5` in v1; ~2-3k LOC reader owned for 5 years (mitigated by the pinned profile + oracle corpus)                                        |
| T2  | Source integration             | New **built-in** `coverage` type                    | Extending the custom-loader seam with a coverage result kind | The seam stays fc/points-pure; cost: a small compiler enum + dispatch edit — but the seam route couldn't stream tiles later and would leak grid semantics |
| T3  | Artifact payload               | In-house binary (deflate f32/u16)                   | Terrain-RGB-style PNG tiles                                  | Forgo free image decode; gain exact values CPU-side (readout/picking/3-D later), no 24-bit-int shader decode, no bilinear-over-encoded-channels hazard    |
| T4  | S-102 renderer                 | Raster pipeline variant                             | Heatmap pipeline; new standalone renderer                    | One more raster variant to maintain; gain drape/pole-caps/streaming for free, zero new pass topology                                                      |
| T5  | GPU value format               | `r16float` texture + exact CPU array                | `r32float` (filterable-feature trap), CPU-side colour baking | Half precision in the _colour_ path only; readout stays exact                                                                                             |
| T6  | Time                           | Single resident texture, re-upload on scrub         | T resident textures                                          | Scrub costs one upload instead of zero; bounded memory wins until profiling says otherwise                                                                |
| T7  | S-111 v1                       | Arrows (existing primitive)                         | Particle advection first                                     | Less "wow" initially; arrows are the navigational display convention and land with zero renderer risk                                                     |
| T8  | Aggregation for overview zooms | Shoalest-value (numeric MIN of positive-down depth) | Mean                                                         | Overviews look "shallower" than mean — deliberately: hazard-conservative for navigation                                                                   |

---

## 10. References

**X-GIS (verified this session):** `map/src/source-loader.ts:46-48`; `map/src/source-manager.ts:58-62, 205-444 (247-276, 286-289, 391-409), 634-699`; `map/src/map-types.ts:21-26`; `map/src/map.ts:323-326, 3046-3054, 3810-3860`; `map/src/render/raster-renderer.ts:5, 24-35, 39-110, 112-127, 173-192, 181, 194, 264-266, 321-323, 426-443, 457`; `map/src/render/material/raster-material.ts:44-77, 169-187`; `map/src/render/heatmap-renderer.ts:1-21, 47-53, 230-266`; `map/src/color-ramp.ts:120-158, 168-188`; `map/src/graphics/graphics-types.ts:67-82, 113-146`; `map/src/graphics/graphics-manager.ts:191-225`; `data/src/sources/virtual-pmtiles-backend.ts:87-160`; `pipeline/src/odb/format.ts:1-28, 71-73`; `pipeline/tools/csv-to-odb.ts`; `pipeline/src/loaders/index.ts:38-124`; `compiler/src/schema/language.ts:59-104`; `compiler/src/convert/spec-coverage.ts:146`; `compiler/src/codegen/paint-routing.ts:106`; `compiler/src/ir/emit-commands.ts:384`; `rhi/src/rhi.ts:67-68`; `rhi-webgpu/src/rhi-renderpass-parity.test.ts:315`; `docs/architecture/source-loader-seam.md` §§3-4, 7, 9.

**S-100 grounding:** `docs/research/2026-07-16-s100-rendering-feasibility.md` §2.4, §3.2, §5.2, §6.1-6.2, §7.8/§7.10/§7.13; `docs/architecture/design/ellipsoid-datum-unification.md` §Target, §"S-100 scope honesty".

**Open to-verify items (tracked into INC-A):** exact Part-10c attribute spellings; grid registration clause; NOAA S-102 sample bucket/licence; real-file superblock/object-header versions.
