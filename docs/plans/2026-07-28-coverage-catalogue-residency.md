# A coverage source names its CATALOGUE; the engine owns residency (#1453)

## What this is

`type: coverage` gains what `type: raster` has had since day one: a URL that names a **set** of
cells rather than one cell, and an engine that decides — from the viewport — which of them are
resident. The demo stops driving residency.

Concretely, `s111-live.xgis` goes from a url-less host-fed source plus 860 lines of demo-side
mosaic machinery to:

```
source currents {
  type: coverage
  url: "/noaa-s111/catalog.json"     // a STAC ItemCollection
}
```

and `s102-live.xgis` goes from one hard-coded cell key to the same shape, gaining
viewport residency it has never had.

## What is actually asymmetric today

`coverage` is the only source type where the **host** owns residency.

- The attach reads once and stops. `map/src/source-manager.ts:347-355` registers an empty region
  map and, only `if (load.url)`, kicks one background read; `loadDeclaredCoverage`
  (`map/src/coverage-source.ts:176`) fetches exactly one cell into `DEFAULT_REGION`. There is no
  `moveend` hook for coverage anywhere in `map/src` — verified by search, not assumed.
- Everything viewport-shaped therefore lives in the demo. `installS111Mosaic`
  (`playground/src/examples/s111-mosaic.ts`, 254 lines) does bbox overlap, relevance ordering,
  hysteresis, a byte budget, an LRU of downloaded cells, a concurrency cap, and push/evict via
  `setCoverageData` / `removeCoverageRegion`. Its support cast: `s111-models.ts` (107) plus 499
  lines of tests, and `setupCurrentsMosaic` + the loading badge in `demo-runner.ts:1345-1440`.
  `s111-models.ts` has no consumer other than the mosaic.
- S-102 never got that machinery, so it hard-codes one cell (`s102-live.xgis:31-34`). Pan off
  Chesapeake Bay and the bathymetry is simply gone. There is nothing to fix in the demo — the
  capability does not exist to be used.

The engine, meanwhile, already owns every part that is hard: keyed multi-region residency,
per-region epochs, `writeRegion` / `armRegion` / `dropCoverageRegion`
(`map/src/coverage-source.ts`), and a GPU byte budget with LRU eviction
(`map/src/render/coverage-renderer.ts:141,490-504`). What is missing is only the layer that
turns a viewport into a set of cell URLs — and that layer currently lives in a demo.

## Why a `{z}/{x}/{y}`-style placeholder is not the answer

The raster analogy is right about the goal and wrong about the mechanism.

`{z}/{x}/{y}` works because the tile key is **computable** from the viewport: a pure function,
no lookup. An S-100 cell key is not. `cbofs`, `102US004MD1AF262297` — these are opaque
identifiers, and nothing about a bounding box produces them. A placeholder can only be filled
from a table of `bbox → id`.

So the real question was never "should the link carry a schema" (it should) but **where the
table lives**. Three homes were considered:

1. **Inline in the `.xgis` source block** (`cells: [{key, bbox}, …]`). Rejected: twelve entries
   hand-authored per demo, a data catalogue living in a style file, new object-array grammar in
   the compiler, and no answer at all for S-102's hundreds of cells.
2. **Built into the engine** (move `S111_MODELS` into `@xgis/map`). Rejected: NOAA domain
   knowledge in a content-blind layer, and it generalises to nothing — S-102, S-104, GOES each
   need their own table.
3. **In the data, as a standard catalogue document.** Chosen. The engine reads a catalogue; the
   catalogue knows the cells. This is exactly TileJSON's relationship to a raster tile source.

## The standard is STAC

A document describing "a set of geospatial assets, each with a bbox, a datetime and an href" is
not a thing to invent — it is **STAC** (SpatioTemporal Asset Catalog). A STAC ItemCollection is
a GeoJSON FeatureCollection whose features carry `bbox`, `datetime` / `start_datetime` +
`end_datetime`, and an `assets` map of hrefs.

CLAUDE.md §12 and ADR-0010 both say the same thing in different words: read the standard the
data is already in, and never transcode it into a house container. A hand-rolled `catalog.json`
would be `.xgcov` again, one level up — a bespoke manifest that no other tool can produce or
consume, for zero gain over a JSON standard that already exists and already has writers.

Minimum subset the engine reads, and nothing more:

| STAC field                       | Engine use                                     |
| -------------------------------- | ---------------------------------------------- |
| `features[].id`                  | the region key (`region` in the existing API)  |
| `features[].bbox`                | viewport intersection + relevance ordering     |
| `features[].assets.data.href`    | the cell URL passed to `fetchCoverageHandle`   |
| `features[].properties.datetime` | (later) cycle identity for a rolling catalogue |

Unknown fields are ignored. A catalogue that happens to be a full STAC API response still reads.

## Residency has THREE authorities today — and they can disagree

This is the concrete cost of the current shape, and it is the strongest argument for moving the
layer down.

1. `installS111Mosaic`'s `resident[]` + `maxResidentBytes` (64 MB of **file** bytes,
   `s111-mosaic.ts:102`), counted with a 10 MB nominal guess per uncached cell.
2. `rawDatasets._coverage` — the CPU-side region map in `coverage-source.ts`.
3. `CoverageRenderer.states` + `budgetBytes` (64 MB of **GPU** bytes,
   `coverage-renderer.ts:141`), where a vector coverage costs roughly twice a scalar one.

Two different budgets over two different units, plus a third map that neither one prunes.
`evictOverBudget` (`coverage-renderer.ts:490-504`) calls `clearRegion`, which fires
`onRegionDropped` — and that callback is wired, at `map.ts:3109` and `map.ts:4151`, to exactly
one thing: `clearCompiledArrows(region)`. Nothing removes the entry from `rawDatasets`, and
nothing tells the mosaic.

**Hypothesis (static trace, NOT yet reproduced — the first thing to verify):** a region evicted
by the GPU budget while still inside the viewport never comes back. `onMoveEnd` skips it
(`s111-mosaic.ts:152`, `if (resident.includes(key) …) continue`), because the mosaic still
believes it is resident; only panning far enough to remove it from `wanted` and then panning
back re-pushes it. A secondary symptom: `map.getCoverage()` keeps answering with a handle for a
region that has no GPU state. Repro sketch: pan a wide coastal view so ≥5 domains are wanted at
once on a device where the GPU accounting evicts before the file accounting does, then pan back
by a small amount.

Two budgets that must agree but are computed from different units is the "second ratchet"
pattern from CLAUDE.md §12. The fix is not to sync them — it is to have one.

## The design

**One authority: the renderer's GPU byte budget.** The catalogue driver does not predict
eviction. It arms in relevance order and _listens_.

- **Detect.** Sniff the fetched bytes, not the URL: HDF5 begins with the signature
  `89 48 44 46 0D 0A 1A 0A`. Signature present → a single cell, exactly today's path, unchanged.
  Absent → parse as JSON and read it as a STAC ItemCollection. Reading a standard's magic number
  is a verified-by-construction discriminator, not a guess — and it means a catalogue URL needs
  no extension, no new `type:`, and no DSL change at all. (§12 forbids _writing_ a magic number
  into a house format; reading one the standard defines is the opposite.)
- **Resolve.** On `moveend`, intersect the viewport with each item's `bbox`; order by overlap
  area, ties toward the smaller bbox (the more local, higher-resolution cell). This is
  `modelsForBounds`' rule, kept verbatim — it is correct and it is already tested; only its home
  changes, and it becomes content-blind (item bboxes, not NOAA models).
- **Arm.** Fetch + arm the wanted set in relevance order, concurrency-capped, through the
  existing `fetchCoverageHandle` → `writeRegion` → `armRegion` path, with the region key set to
  the STAC item `id`. Per-region epochs already make out-of-order arrival safe.
- **Let the budget speak by evicting.** Extend the `onRegionDropped` wiring so a drop also
  removes the `rawDatasets` entry, keeping the CPU and GPU views of residency identical by
  construction. When a drop names a region the driver still wants, the driver stops arming
  further regions this cycle: the budget is full, and the next item down is the least relevant
  one anyway. That single rule replaces the mosaic's whole predictive byte budget, and it cannot
  drift from the renderer, because it _is_ the renderer talking.
- **Hysteresis stays, and moves to the primary only.** The resident _set_ no longer churns on a
  boundary-adjacent zoom (both neighbours are simply loaded), so the damping is only about
  keeping `current()`'s label steady. Whether the engine needs to expose a "primary" at all is
  an open question below.
- **The time axis is untouched.** S-111 forecast hours live _inside_ one cell as HDF5 groups;
  `setCoverageTime` / `stepCoverageRegions` / `CoverageTimePlayer` keep working exactly as they
  do. The catalogue selects _which cell_, never _which hour_. Nobody should redesign the time
  player as part of this.
- **A rolling catalogue re-reads through the existing refresh machinery.** `coverage-refresh.ts`
  already owns HEAD-probe validators and the poll loop keyed per source; the catalogue document
  is one more thing to revalidate with it. Not in the first increment.

### Rejected, with reasons (so they do not come back)

- **The mosaic's in-memory `ArrayBuffer` LRU** (`s111-mosaic.ts:104`). It existed so `setTime`
  could re-decode a different forecast hour with no network. The engine's step path already
  range-reads one group (`stepOneRegion` → `readCoverageRange`), and the HTTP cache covers a
  pan-back. Holding three ~10 MB buffers in JS heap to duplicate the browser's cache is not
  worth an engine-level cache API.
- **A `maxResidentBytes` option on the source.** That is authority #2 returning. If the GPU
  budget needs to be tunable, tune the renderer's — there is exactly one.
- **A new `type: coverage-catalog` source type.** The content sniff makes it unnecessary, and a
  second type would split every downstream `declaredType === 'coverage'` check.

### Open questions

- **Where does the S-102 catalogue's bbox come from?** S-111 is trivial: twelve items, static
  domain envelopes, `href` pointing at the existing `/noaa-s111/latest/<model>.h5` route that
  already resolves the newest cycle — so the catalogue never rots and no new resolver is needed.
  S-102 has stable keys but no published bbox table that we have confirmed. Either NOAA publishes
  a catalogue we have not looked for, or the worker derives each cell's bbox from its own S-100
  metadata once, server-side. **Check for a published catalogue before generating one.**
- **Does `S111MosaicHandle.current()` need an engine equivalent?** The forecast scrubber reads
  one axis. `primaryCoverageTime` (`coverage-source.ts:106`) already returns the first-armed
  region's axis; if the driver keeps the region map in relevance order, that may already be the
  answer and no new API is needed.
- **Should a catalogue source without `moveend` (headless, no camera) load anything?** Proposal:
  no — resolve on the first camera settle, same as any viewport-driven source.

## Verification

Per CLAUDE.md §5 this is not "it compiles". In order:

1. **Fail-first on the divergence hypothesis.** A unit test that evicts a still-wanted region
   through the renderer's budget and asserts `rawDatasets` no longer lists it. It must fail on
   `main` first, for the stated reason, or the hypothesis was wrong and the issue gets corrected
   rather than the code.
2. **Unit:** the HDF5-signature discriminator (both arms), STAC parsing incl. a missing/extra
   field, viewport→items ordering (port the existing `s111-models.test.ts` witnesses so the
   ordering rule provably does not change), and the stop-on-eviction rule.
3. **Render gate:** `playground/e2e/_s111-multiregion-gate.spec.ts` must stay green — it already
   proves two domains draw simultaneously under headless WebGL2/SwiftShader, and it is the exact
   regression this change could reintroduce. Add a declarative variant that drives the catalogue
   path rather than `setCoverageData`, asserting `backend === 'webgl2'` so a silent fallback
   cannot green it.
4. **Directional pixel-diff** before/after on both live demos, read as a 16-split at full
   resolution — the arrows and the bathymetry ramp must be unchanged when the same cells are
   resident.

## Increments

1. **Engine reads a catalogue.** Discriminator + STAC reader + viewport resolver + arm loop,
   single-authority eviction. Fail-first test (1) lands here. No demo change yet: driven by unit
   tests and a synthetic catalogue fixture.
2. **S-111 Live goes declarative.** Serve the catalogue from the dev proxy and the prod worker;
   `s111-live.xgis` gets a `url:`; delete `s111-mosaic.ts`, `s111-models.ts`, both test files and
   the `demo-runner` mosaic wiring; keep the loading badge if it can hang off an engine event.
   Render gate + pixel-diff here.
3. **S-102 Live gets the same.** Only after the S-102 catalogue question above is answered.

Increment 1 is worth landing alone: it is the capability, and it is provable without a demo.
