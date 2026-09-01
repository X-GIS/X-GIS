# Memory that doesn't move: arenas, budgets, and honest uploads

> Edition: **dev**. Exhaustive version: [`../agent/06-memory-upload.md`](../agent/06-memory-upload.md).

A map engine's memory system fails in undramatic ways: a frame loop that allocates 665 KB
per frame at _idle_; a cache whose "256 entries" is 64 MB on one dataset and 4 GB on
another; a buffer destroyed while the GPU still references it; an upload that silently
reads another renderer's bytes. X-GIS's answers are worth studying because nearly every
one is attached to a measurement or an incident.

## One GPU interface, two backends, fail loud

All GPU access goes through an RHI: opaque handles, buffers declared by _semantic role_
(uniform/vertex/index/storage), and a capabilities record instead of backend identity
checks (a shrink-only ratchet counts the remaining `backend === 'webgl2'` comparisons; the
`engine` package can't even _name_ a native GPU type — its tsconfig has `types: []`, so
neutrality is compiler-enforced). WebGL2's gaps are bridged where honest — storage buffers
become 2D data textures with the element type on the _descriptor_ (an internal-format
mismatch doesn't error; `texelFetch` silently reads zero) — and **fail closed** where not
(no MRT to the default framebuffer, no native compute). The posture has an origin story: a
recursive no-op Proxy once let the WebGPU-typed engine "boot" on WebGL2 by swallowing
every native call, which converted every missing feature into silence. The replacement is
a fail-loud stub, and the fallback chain is _data_ — an ordered provider array that renews
the canvas when a context type is already claimed, because a canvas's context choice is
irreversible.

## Uniforms by write cadence

The uniform architecture is one idea applied all the way down: **partition by how often
data changes, and give each cadence one producer.** A frame block written once per frame;
a show (style-layer) block; and a tile block written once when a tile is established —
stored in a slot **arena** with a stable byte offset for the tile's whole life.

Why an arena? Measured twice. Per-tile buffers meant ~12,600 buffer creations at city
zoom. And after render bundles removed command-encoding cost, the _remaining_ per-layer
cost was the hit path re-staging a ~30-field uniform block per (layer × tile × world
copy) into a per-frame ring — bytes the replayed bundle only reads. Stable slots delete
that work, and a stable offset is also what lets a render bundle bake it once.

The lifecycle details are where the rigor shows: freeing rides the eviction hook the tile
store already fires (no new lifecycle seam to forget); double-free **throws** (absorbing
it would let the "live slots === live tiles" leak gate drift green); growth flushes dirty
bytes into the _old_ buffer first (already-recorded draws must not read stale data),
copies forward, and retires the old buffer into a queue drained a frame later.

And one trap that deserves its own paragraph: **pack-once caches retire "read live every
frame" assumptions.** A parity gate injected test flags after boot, on the premise that
flags were read at the uniform write site each frame. Once tile lanes moved behind the
pack-once arena, a post-boot flag could never reach a resident tile — so the gate's
witness measured "zero pixels moved" _on the shipping path_: a live assertion faithfully
certifying a dead mechanism. The fix re-packs when the witness value changes; the lesson
is to apply test witnesses at the single producer of the value they perturb, and to
re-read what your tests assumed whenever you move a value behind a cache.

## The frame arena and the offset-zero rule

Per-frame CPU scratch (projection buffers, glyph positions, draw arguments) comes from a
bump arena reset each frame — allocation becomes a watermark, and steady-state GC pressure
goes to ~zero. In dev builds, regions whose views are no longer legal to hold are
**poisoned with NaN bit patterns**, so a retained view reads loud garbage instead of
plausible last-frame data. (A throwing Proxy poison was evaluated and rejected for a
subtle reason: `ArrayBuffer.isView` on a proxied view is false, which breaks every native
consumer.)

The arena's contract radiates outward: everything downstream receives _windowed subarray
views_ — `byteOffset ≠ 0` by construction. Which sets up the project's best-known testing
parable: a refactor dropped a view window (`new Uint32Array(data.buffer)` — reading from
offset zero), five fresh unit tests stayed green because each passed a whole array (the
one input shape where the bug is invisible), and in production the WebGL2 upload read a
_different renderer's bytes_ out of the shared arena. No error anywhere; the draw simply
rendered nothing. Two rules came out: **feed at least one input shaped like real callers
shape it, and plant a decoy around it**; and when you refactor a shared path, run the
gates of that path's _consumers_, not just the tests of the thing you touched.

## Geometry residency: three buffer layers

Big immutable geometry (polygon vertices/indices) lives in a few large **GPU arenas** —
a linear allocator with free lists keyed by _exact_ size (bump allocation makes size-class
reuse an overrun), an O(1) exact "can I serve this" probe (summed free bytes lies under
fragmentation), dev-only double-free and size-mismatch detection, a
reset-only-when-empty reclaim, and compaction that ping-pongs into a _fresh_ buffer during
the one safe window (after submit) — never in place, never while referenced. Small churny
buffers go through a power-of-two **pool** with both an entry cap and a byte cap (the
entry cap alone bounds nothing much), trimming largest-bucket-first. Async uploads go
through tiered **staging rings**, capped per tier because GPU bytes exert no JS GC
pressure — an uncapped free list keeps its high-water mark for the session.

Upload orchestration is transactional (a paired vertex/index alloc frees the first half
if the second throws; a catch backstop frees on any failure between alloc and
cache-record), CPU-side geometry is dropped after upload (the GPU copy becomes the source
of truth — and the drop must also happen on cancel paths, or byte accounting drifts), and
the sync and async upload routes are **one function body** parameterized by a write sink,
after living as 85 %-identical siblings — the divergence shape this codebase fears most.
Eviction runs at frame start in the post-submit window, with per-tile GPU buffers retired
into next-frame queues (destroying a buffer the in-flight encoder references is a
validation error at submit).

## Budgets in bytes, with hysteresis

Every cache with data-controlled entry sizes is budgeted in **bytes**: CPU tiles
(200/100 MB desktop/mobile, with a dev-mode invariant that recomputes actual bytes and
throws on accounting drift — born from a "263 MB for 2 tiles" report), raster textures
(384/96 MB — a count cap is meaningless when the publisher picks the tile resolution;
mip charging is an explicit parameter because elevation tiles are deliberately un-mipped),
coverage regions (64 MB LRU where draw order is _decoupled_ from LRU order — recency is
not relevance), glyph ranges (evict only loaded entries; evicting an in-flight one frees
nothing and re-fetches). GPU tile eviction uses **hysteresis** (trigger at 75 % of the
high-water mark, drain to 60 %) and — subtle — reads _different quantities_ for the two
thresholds: the monotonic bump pointer to trigger (that's what the OOM throw checks), live
bytes to stop (they fall as you free). Looping on the wrong one thrashes. Visible tiles
are exempt, so the evictor may honestly return "still over budget" for a frame — freeing a
texture this frame samples is worse.

Two governance rules bind it together: one budget authority per resource class (a
duplicated constant is a drift bug waiting), and downstream systems **react to evictions
instead of predicting them** — a second predictive budget one layer up is a second
authority, and re-arming an evicted region under pressure just evicts a neighbor and
oscillates (observed as a four-cycle arm/evict/restore loop).

## Workers

Tile decode, tessellation and line-segment building run in a worker pool; geometry comes
back as transferable ArrayBuffers, and the expensive residue is the structured clone of
feature properties — measured at 309 ms per message until only the fields the style
actually reads were cloned. Failure isolation matters more than throughput: a dead
worker's round-robin slot otherwise silently swallows its share of all compiles forever
(mark indices dead, never splice), and an all-dead pool must reject immediately rather
than posting into the void ("still loading" forever). Completions are **paced** back onto
the main thread (N per rAF, racing a timer because hidden tabs throttle rAF) — an unpaced
five-tile completion burst once cascaded into a 200 ms hitch. Stateful workers (the
GeoJSON tiler) namespace their indexes by map instance; a process-singleton worker serving
two maps' same-named sources would cross-corrupt silently.

## What to steal

1. Semantic-role GPU handles + capability records; compiler-enforced neutrality; fail
   loud; fallback as data.
2. Uniforms partitioned by write cadence; pack-once arenas with stable offsets; lifecycle
   piggybacked on existing hooks; throw on double-free; witness values re-checked at the
   producer.
3. A poisoning bump arena for frame scratch; subarray views as the canonical test input.
4. Exact-size free lists, exact serviceability probes, post-submit compaction, retire
   queues.
5. Byte budgets with hysteresis reading the right quantity on each side; visible-set
   exemptions; one authority per budget; react to evictions, don't predict them.
6. Transfer geometry; clone minimally; pace completions; isolate worker deaths; namespace
   stateful workers.
