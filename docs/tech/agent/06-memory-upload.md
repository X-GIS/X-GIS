# 06 — Memory stability & the upload architecture

> Edition: **agent**. Companion: [`../dev/06-memory-upload.md`](../dev/06-memory-upload.md).
> Packages: `rhi/` (interface), `rhi-webgpu/` + `rhi-webgl2/` (backends), `engine/`
> (backend-neutral arenas/rings/materials), `map/` (renderers), `data/` (caches, workers).

## 1. The RHI: one interface, two backends, no leaks upward

`rhi/src/rhi.ts` (~745 lines) is the whole GPU surface: opaque phantom-branded handles
(callers never see `GPUBuffer`/`WebGLBuffer`), buffers with **semantic roles** (`'uniform'
|'vertex'|'index'|'storage'`) instead of usage bitflags, textures/samplers/bind-layouts/
pipelines/passes/compute/encoder, and an `RhiCaps` record of 12 capability fields —
each documenting its consumer seam.

Capability divergences (WebGPU / WebGL2): `maxSampleCount` 4/1, `presentablePassMrt`
true/false, `pickReadback` 'async'/'sync', `compute` 'native'/'fragment-emulated',
`executionModel` 'deferred'/'immediate' (the flush-policy cap), `renderBundles` true/false,
`shaderLanguage`. The three deep divergences:

1. **Storage buffers → data textures.** GLSL ES 3.00 has no SSBO; `usage:'storage'` on
   WebGL2 allocates a 2D-tiled R32F/R32UI/R32I texture (element _i_ at texel
   `(i%W, i/W)`). The internal format must match the sampler the emitted GLSL declares — a
   mismatch makes the texture INCOMPLETE and `texelFetch` silently returns 0, which is why
   the element type rides on the buffer **descriptor**, not inferred per write.
2. **Uniform blocks**: dynamic offsets → `bindBufferRange`; layout entries carry the shader
   block _name_ so multi-resource groups bind order-independently, and a multi-same-kind
   group with an unnamed entry fails loudly at layout creation.
3. **No pipeline/bind-group/view objects in GL**: a "pipeline" is a linked program +
   recorded state; a "bind group" is a recorded resource list replayed onto GL slots.

How the renderer codebase stays backend-agnostic (all mechanically enforced — see
[`01-architecture.md`](./01-architecture.md) §3): capability queries not identity checks
(a shrink-only ratchet counts `backend === '…'` comparisons, each grandfathered site
annotated with why it can't be a cap yet); a strict-equality ratchet on native `GPU*`
tokens in `map/src`; `engine/` neutrality enforced by the **compiler** (`types: []` — any
`GPU*` identifier is a compile error); optional capabilities narrowed by typed helpers
instead of `!`; and boot fallback as **data** (an ordered provider array), including a
sticky-canvas registry — a canvas's context type is irreversible, so the fallback chain
renews the surface rather than dead-ending. The origin story of the fail-closed posture:
a recursive no-op Proxy once let a WebGPU-typed engine "boot" on WebGL2 by silently
swallowing every native call (`fail-loud-stub` postmortem) — the backends now fail closed
on unsupported features rather than no-op.

## 2. Uniform memory: arenas by write cadence

The uniform story is the ADR-0009 principle (split by **cadence, not by renderer**)
carried to its conclusion. Draws bind three ranges: a **tile block** (written once at tile
establishment, freed with the tile), a **show block** (per style-layer), and a **frame
block** (one 512 B buffer written once per frame). Ascending binding numbers keep WebGPU's
dynamic-offset ordering rule trivial.

**`TileUniformArena`** (map) over the generic **`UniformSlotArena`** (engine):

- Why an arena (measured): with render bundles ON, the residual 0.19 ms/layer of encode
  cost was the bundle-HIT path **re-staging a ~30-field uniform block per
  (show × tile × worldCopy) into the per-frame ring** — bytes the replayed bundle only
  reads. And per-tile _buffers_ were rejected long before: ~12,600 per-tile `createBuffer`s
  at z14 and ~300 vertex-binding swaps per frame. A stable byte offset in one shared buffer
  is also what lets a RenderBundle bake the offset once.
- Slot key = (sourceLayer, numeric tileKey, worldCopy lane) via nested Maps — no composite
  string keys on the hot path; the hit path is two Map.gets + an array index, zero
  allocation.
- Pack once: a full-struct typed write (compile-time completeness — the ADR-0009 net),
  then `stage(slot, bytes)`; upload is **one writeBuffer per flush over the coalesced dirty
  range** (a subarray of the staging buffer).
- Free on eviction is **piggybacked on the release hook the tile store already fires** on
  every eviction/drop/supersede path — zero new lifecycle seams. `free` on a non-live slot
  **throws** (a double-free is an upstream lifecycle bug; absorbing it would let the leak
  gate — `live slots === live tiles` — drift green).
- Growth: double capacity; flush the dirty range **into the old buffer first** (draws
  already recorded against it must not read stale bytes); copy-forward with a whole-range
  dirty mark (persistent slots must survive the move); retire the old buffer into a queue
  drained in the next frame's post-submit safe window; fire `onGrow` so bind groups and
  recorded bundles invalidate.

**The pack-once trap (#2165)** — the most transferable caching lesson in the repo. A parity
gate injected test flags post-boot on the premise "flags are read live per frame at the
uniform write site." Once the tile lanes moved behind the pack-once arena, a flag set
after boot could never reach an already-resident tile — the gate's witness measured zero
moved pixels _on the shipping path_, i.e. a live assertion certifying a dead mechanism.
Fix: the arena compares the packed witness value on every slot establishment and drops all
resident packs when it changes. Generalized: **apply a test witness at the single producer
of the value it perturbs, and when you move a value behind a pack-once cache, re-read what
the tests assumed about how often it is read.**

Show slots are keyed by (layer, pickId **& 0xffff**) — never pickId alone: a CPU-lowered
data-driven paint fans one style layer into per-bucket sub-shows sharing a pickId
(symptom: every country painted the first bucket's color).

## 3. Frame arenas (CPU) and the offset-zero contract

`engine/src/render/frame-arena.ts`: one ArrayBuffer, watermark pointer, reset per
`beginFrame()`. Motivation measured: ~665 KB/frame of steady-state allocation at idle;
after hoisting scratch Maps and moving per-frame typed arrays into the arena, steady-state
allocation → ~0 (the buffer grows monotonically to the session peak). Details that matter:

- Typed helpers return **windowed views into the shared buffer** — `byteOffset ≠ 0 by
construction`. An `allocF64` exists because polyline math accumulates Mercator meters
  (±2e7) that overflow f32 at meter precision.
- Growth 1.5× at frame start when peak ≥ 90 % of capacity, plus mid-frame auto-grow with
  copy (earlier it threw on the first frame exceeding initial capacity). Documented caveat:
  views handed out before a mid-frame grow stay readable but writes no longer reach the new
  buffer.
- **DEV stale-view poison**: regions whose views become illegal to retain are filled with
  the f32-NaN bit pattern, so a retained view reads loud NaN garbage instead of plausible
  previous-frame data. A throwing Proxy poison was evaluated and **rejected** —
  `ArrayBuffer.isView(Proxy(view))` is false, which breaks every native BufferSource
  consumer.

**The offset-zero lesson** (`every-test-passed-offset-zero` postmortem — also CLAUDE.md
§12): a refactor generalizing a typed-array read dropped the view window
(`new Uint32Array(data.buffer)` instead of `(data.buffer, data.byteOffset, len)`). Five
new unit tests were green because each passed a **whole** array — `byteOffset 0`, the one
input shape where the bug is invisible. Production passes frame-arena subarrays, so the
WebGL2 storage-texture upload read a _different renderer's bytes_ from offset 0 — no error
anywhere, the draw simply rendered nothing. Rules extracted: **feed at least one input
shaped the way real callers shape it, and plant a decoy around it**; and a change to a
shared path owes the gates of that path's **consumers** (the tests of the thing you were
refactoring were green; the point/icon/line gates using the rewritten upload were never
run). The upload sites now document the window contract verbatim, and each backend's
subarray handling is explicit (WebGPU `writeBuffer` honors views; the WebGL2 data-texture
path derives `(buffer, byteOffset, length)` from the view; the async staging path rebuilds
the window explicitly before memcpy into the mapped range).

## 4. Geometry residency: three buffer layers

1. **`GPUArena`** (engine) — a linear allocator over one large GPU buffer for polygon
   vertex/index data (128 MB / 64 MB initial, auto-grow to 512 MB after measuring a
   z15.2 pitch-45 NYC frame needing ~104 MB and dropping ~19 building tiles per frame at
   the old 64 MB cap). Free-list keyed by **exact aligned size** (bump allocation makes
   size-class reuse an overrun risk; LIFO stacks preserve GPU-cache locality). DEV-only
   live-offset map catches double-free _and size-mismatched free_ (previously a silent
   fragmentation leak). `canServe()` is an O(1) exact probe (summed freeBytes is a false
   positive under fragmentation). `reclaimIfDrained()` resets the bump pointer only at
   zero live bytes — the only provably-correct mid-session reclaim without defrag.
   `compact(relocations, encoder, targetCapacity?)` ping-pongs ranges into a **fresh**
   buffer (never in-place; overlapping copies are undefined) and serves both defrag and
   auto-grow; callers run it in the post-submit safe window and destroy the old buffer
   after the next submit.
2. **`GpuBufferPool`** — a power-of-two bucket recycler (2 KB–4 MB) for standalone
   per-tile buffers (line/outline), with **two caps**: 16 entries per bucket _and_ a 16 MB
   byte cap (the count cap alone bounds ~134 MB per usage combination), trimming
   largest-bucket-first (most bytes per driver call; small buckets are where reuse pays).
3. **`StagingBufferPool`** (rhi-webgpu) — tiered MAP_WRITE rings (4 KB…16 MB, per-tier
   caps) for async tile upload; `queue.writeBuffer` is synchronous-cheap but pays a driver
   staging copy per call, and an LOD jump used to issue 150-210 of them. GPU bytes exert
   **no JS GC pressure**, so an uncapped free-list high-water persists all session. Two
   hardening paths: a SwiftShader `mappedAtCreation` failure falls back to plain
   writeBuffer; a `release` after renderer destroy destroys instead of pooling into a dead
   free-list.

**Upload coordination** (`upload-coordinator.ts`): paired arena allocs are
transactional (vertex claimed, index alloc throws → vertex freed — a failed pair never
leaks); a catch backstop frees slots if anything throws between alloc and cache-record;
CPU-side prebuilt geometry is **released after upload** (GPU buffers become the source of
truth) — and the release must also run on cancel paths, because the byte-accounting cache
assumes those fields absent for cached tiles. The sync (mid-render fallback) and async
upload routes were ~85 % identical siblings; they are now **one `_dispatch` body**
parameterized by a write-sink, with the sync sink reaching zero awaits (a mid-render upload
must complete before the next render command).

Eviction ordering (`GpuTileStore._releaseTileResources`, fixed order): arena ranges back to
free-lists (never `destroy` on the shared buffer) → pooled buffers back to the pool →
**per-tile GPU buffers retired into queues drained one frame later** (destroying a buffer
still referenced by the in-flight encoder raised "used in submit while destroyed") →
release hooks (feature-data handle, tile uniform slot) → cache delete.

## 5. Budgets and eviction (every cache, one table)

| Cache                       | Budget                                                                                                              | Policy notes                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GPU vector tiles            | 256 desktop / 64 mobile **unique tile keys** + arena byte hysteresis (trigger at 75 % of high-water, drain to 60 %) | count is on unique keys, not (key × layer) entries — a sliced source yields ~4 entries/tile; the trigger reads the monotonic bump pointer (what the OOM throw checks) while the drain loop reads live bytes (falls on free) — looping on the bump pointer would thrash                                                                                                        |
| CPU tile data               | **200 MB / 100 MB bytes** (count 256 as a drift net)                                                                | byte-exact accounting with a DEV invariant that recomputes and throws on drift (born from a "263 MB for 2 tiles" report); protection channels: a permanently pinned low-zoom skeleton (Cesium `_doNotDestroySubtree` analogue, so ancestor fallback always terminates), and a 2 s just-prefetched shield (cut from 5 s after a real device showed 62 shielded keys at 296 MB) |
| Raster/hillshade textures   | 384 MB / 96 MB **bytes**                                                                                            | a count cap cannot work: texture size is publisher-controlled (256 entries = 64 MB at 256² or 4 GB at 2048²); mip-charging is an explicit required parameter (DEM tiles are deliberately un-mipped — averaging elevation fabricates slopes); **visible tiles are exempt**, so the evictor may legitimately return still-over-budget for a frame                               |
| Coverage regions            | 64 MB, LRU                                                                                                          | one region always stays resident even if it alone exceeds budget (the budget bounds accumulation, not region size); **draw order is decoupled from LRU order** (stable sort by relevance priority — ADR-0011)                                                                                                                                                                 |
| Glyph PBF ranges            | 32 MB LRU                                                                                                           | evict only 'loaded' ranges (evicting loading/failed frees nothing and turns a resolved miss into a re-fetch)                                                                                                                                                                                                                                                                  |
| Buffer pool / staging pools | 16 MB / ~35 MB per pool                                                                                             | above                                                                                                                                                                                                                                                                                                                                                                         |

Eviction runs in the **post-submit safe window** (`runFrameMaintenance` at frame start),
not inside `render()` (racing the multi-render-per-frame bucket scheduler); the OOM lane
(`forceEvictBytes`) runs mid-render with an exact `canServe` probe and a per-arena
per-frame **futility latch** so an all-protected set doesn't re-run O(residents) sorts per
tile. Deferred remedies (same-size compaction vs auto-grow) share one encoder/submit and
one bundle invalidation, with an alternating charge cursor bounding any backlog at two
passes.

Two budget-authority rules: one authority function for a budget with two consumers (the
raster budget module exists because "a duplicated constant is the drift shape this repo has
paid for repeatedly"); and eviction feedback flows **from** the enforcing cache — the
coverage catalogue driver reacts to renderer evictions rather than keeping a second
predictive budget ("a second byte budget one layer up would be a second authority";
re-arming an evicted region under pressure just evicts a neighbour and bounces — observed
as a 4-cycle arm/evict/restore loop).

## 6. Allocation discipline (frame loop ≈ 0 alloc)

Patterns, all instance-level and mechanical: frame arenas for per-frame typed arrays;
scratch Sets/Maps cleared per use; nested maps instead of composite string keys on hot
paths (one such key was ~1.6 k allocations/frame; a glyph-atlas string key was 10-15 % of
frame); integer-packed cache keys (`fontId<<28 | codepoint<<7 | radius`); preallocated
matrices returned by reference (documented as a contract); a WeakMap view cache keyed by
ArrayBuffer identity; frame-invariant RHI wrapper objects over per-frame native
views/encoders; cold-path-only allocations annotated as such.

Enforcement is **instrumentation, not lint**: an opt-in per-call-site allocation profiler
(`__xgisAllocProfile`), perf marks, byte telemetry in the stats surface, and a DEV
byte-accounting invariant. The 2026-08 audit's honest self-assessment is preserved: _"the
runtime engineering is strong; the gates protecting it are absent"_ — no memory soak in
CI, ~26 of 40 perf specs assert nothing. (For a new library: budget the gates with the
features.)

## 7. Workers

Three data pools + one shader-emit pool; no SharedArrayBuffer anywhere.

- **MVT compile pool**: full decode → per-layer decompose → clip/simplify/earcut/pack →
  line-segment build off-thread; geometry returns as **Transferable ArrayBuffers**
  (zero-copy); the structured-clone residue is the dominant cost (a naive `featureProps`
  clone measured **309 ms/message**; now only the union of fields the style actually
  reads is cloned). Round-robin with per-worker failure isolation (a dead worker's
  round-robin turn otherwise silently swallows 1/N of all compiles — indices are marked
  dead, never spliced, so recorded job→worker mappings stay valid); all-dead ⇒ reject
  immediately (silently posting into dead workers reads as "still loading" forever).
- **Result re-entry is paced**: completions land in a queue drained on rAF (with a 250 ms
  timer race — hidden tabs throttle rAF to ~0 Hz) at N-per-frame (higher during cold-start
  burst, read at fire time), because a 5-tile burst resolving in one microtask cascaded
  into a 138-200 ms hitch.
- **GeoJSON tiling worker is stateful** (one geojson-vt index per source), with the
  documented protocol; index keys are namespaced by map instance (a process-singleton
  worker serving two maps' same-named sources would silently cross-corrupt), and
  `drop-source` exists so indexes don't pin process-lifetime memory.
- **Shader-emit pool**: DSL emission (~768 ms of a WebGL2 session) off-thread, with a
  peek/request split (a draw loop cannot await) and a no-worker fallback that runs the
  SAME emit function through one dispatch path so the two cannot diverge. Constants ride
  on **each request** — a worker primed for one planet would answer the next map wrongly.

## 8. Atlases

Glyph SDF atlas: pure-logic LRU slot state (Map-insertion-order LRU; evictions name the
evicted key so vertex data referencing it invalidates; a generation counter makes
post-eviction reads clean misses) over a single 4096² R8 page **by contract** — the
one-page invariant is asserted rather than plumbing multi-page. Sprite/icon atlases:
fixed pages, shelf allocation for host images (an image that doesn't fit is skipped with a
warning; a replaced image re-uploads via source-identity versioning). Fetch caps on
sprite payloads (32 MB PNG / 16 MB JSON).

## 9. Transferable design rules

1. **Abstract the GPU behind semantic-role handles + a capability record**; enforce the
   abstraction with compiler-level neutrality where possible and ratchets where not; make
   the fallback chain data; fail loud, never no-op.
2. **Partition uniforms by write cadence** (frame / show / tile), give persistent slots a
   pack-once arena with stable offsets (bundles depend on it), and piggyback slot lifetime
   on the resource lifecycle hooks that already exist. Throw on double-free.
3. **A bump frame-arena turns per-frame allocation into a watermark**; poison stale
   regions in DEV; treat `byteOffset ≠ 0` as the canonical input shape in every upload
   test.
4. **Exact-size free lists + O(1) exact serviceability probes + post-submit-window
   compaction** make one big GPU buffer safe; never destroy or self-copy a buffer the
   in-flight frame references — retire into next-frame queues.
5. **Budget in bytes, not counts**, wherever entry size is data-controlled; use hysteresis
   between trigger and drain thresholds; read the right quantity for each (monotonic
   high-water to trigger, live bytes to stop); exempt currently-visible resources and
   accept being over budget for a frame.
6. **One budget authority per resource class**; downstream systems react to evictions
   rather than predicting them.
7. **Transfer geometry, pace re-entry, isolate worker failures, and namespace stateful
   worker keys by client instance.**
8. **Instrument allocation and byte accounting from day one** — and unlike X-GIS at the
   time of its audit, put a soak test and asserting perf gates in CI.

## 10. Code map

- RHI: `rhi/src/rhi.ts`, `rhi/src/rhi-provider.ts`; backends `rhi-webgpu/src/`
  (`staging-buffer-pool.ts`, `bundle-cache.ts`, `reflection-to-webgpu.ts`),
  `rhi-webgl2/src/` (`storage-data-texture.ts`)
- Engine: `engine/src/render/{frame-arena,uniform-slot-arena,uniform-ring,uniform-block}.ts`,
  `engine/src/gpu/gpu-arena.ts`
- Map: `map/src/render/{tile-uniform-arena,uniform-split-bind,gpu-tile-store,
gpu-buffer-pool,upload-coordinator,raster-cache-budget,arena-compaction-budget}.ts`
- Data: `data/src/{tile-data-cache,tile-eviction-policy,tile-compile-budget}.ts`,
  `data/src/workers/`
- Postmortems: `every-test-passed-offset-zero`, `draped-at-the-wrong-tile`,
  `the-map-fossilized-half-loaded`, `fail-loud-stub`, `swapping-the-encoder-mid-frame`,
  `slicing-a-700-reference-coupling`
