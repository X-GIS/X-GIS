---
title: 'Draped at the wrong tile: a deferred write turned a shared uniform pool into a data race'
description: "A draped landcover polygon rendered hundreds of kilometres offshore — but only on WebGPU. Every vector slice of one source shares one Material uniform pool, and each slice resets the pool cursor to 0, so a later slice's tile i overwrote an earlier slice's tile-i buffer. WebGPU's queue.writeBuffer defers to submit (last-writer-wins), so every draw read the final bytes; WebGL2's immediate bufferSubData never showed it — and the differential test was structurally blind, because both frames aliased identically."
date: 2026-07-15T18:00:00Z
tags: ['rendering', 'webgpu', 'debugging', 'globe', 'verification']
lang: en
draft: false
---

Pan the globe to low zoom over the OpenFreeMap planet and one landcover
polygon drapes cleanly over open ocean, a few hundred kilometres off its own
coastline. Switch the camera and it jumps to a _different_ wrong place. Force
the WebGL2 backend and every fill sits exactly where it belongs. The defect is
WebGPU-only, it moves when the camera moves, and it always lands a draped tile
on top of some _other_ tile's ground position.

That last detail is the tell. A projection bug bends a shape; a culling bug
drops one; but a tile rendered whole and sharp _at another tile's anchor_ is
neither — it is the right geometry reading the wrong per-tile uniform. Something
is handing tile A the position packed for tile B.

## The wrong first move

We reached for the two things that usually settle a globe render fast: the
minimal fixture and the differential diff. Both came back clean, and both were
blind by construction.

The minimal drape fixture renders one vector slice. One slice issues exactly one
batch of draw items, so the per-item uniform pool is filled once, front to back,
and never reused. There is no second writer, so there is nothing to race — the
minimal repro was _minimal in the one dimension the bug needs_.

The differential harness was worse, because it looked authoritative. Diff two
renders of the same drape and you get zero changed pixels, so the gate reads
green. But the aliasing is deterministic given a fixed slice order: both frames
alias _identically_, and a diff only reports where two frames disagree. A
differential test cannot see a bug that both sides share. We were staring at a
green diff over a frame that was visibly wrong.

## What actually happened

We stopped diffing whole frames and asked a per-tile question instead: does each
_draped_ tile sample the anchor packed for _itself_? On the multi-slice
OpenFreeMap style — landcover, water, boundaries, each a separate slice — the
answer was no. Tile `i` of an earlier slice was being drawn at the sphere anchor
belonging to tile `i` of a later slice.

The ownership chain explains why. A source keeps exactly one drape renderer,
built once at `vector-tile-renderer.ts:3154` and reused across every slice:

```ts
this._drape ??= new VectorDrapeRenderer(this.rhi, this.format, getSampleCount())
```

That renderer owns one `RasterDraper` (`vector-drape-renderer.ts:87`), which
owns one generic `Material` with one per-item uniform pool —
`pool: { group: 1, slotSize: rasterTileBytes() }` (`raster-material.ts:72`).
Every slice on the globe route calls `renderGlobeFills` → `RasterDraper.draw` →
the shared `executeItems`, and `executeItems` (`engine/src/render/material.ts:210`)
resets its pool cursor to zero on every call:

```ts
export function executeItems(material, pass, items): number {
  let poolIdx = 0
  for (const it of items) {
    // ...
    if (it.poolBytes !== undefined && material.hasPool) {
      const slot = material.poolSlot(poolIdx++)   // material.ts:217–220
      slot.write(it.poolBytes)
      pass.setBindGroup(material.poolGroup, slot.bg)
    }
```

And `poolSlot(idx)` (`material.ts:196–197`) hands back a _shared,
index-addressed_ buffer — slot `i` is always the same GPU buffer, grown once and
reused forever:

```ts
const buf = this.poolBufs[idx]
return { write: (b) => this.rhi.writeBuffer(buf, 0, b), bg: this.poolBGs[idx] }
```

So slice 0 writes `poolBufs[0..n]` with its tile anchors and records draws that
bind `poolBGs[0..n]`; then slice 1 resets `poolIdx` to 0 and writes
`poolBufs[0..m]` with _its_ anchors, over the same buffers the slice-0 draws
still point at. The last slice to reach slot `i` wins that slot; every earlier
slice's tile-`i` draw reads the winner's bytes.

Whether "wins" corrupts anything comes down to one line in each backend. On
WebGPU (`rhi-webgpu/src/rhi-webgpu.ts:410–411`), `writeBuffer` is
`queue.writeBuffer`, which the spec _defers_ to the next `queue.submit()`:

```ts
writeBuffer(buffer, byteOffset, data): void {
  this.device.queue.writeBuffer(u<GPUBuffer>(buffer), byteOffset, data)
}
```

All of a frame's writes to `poolBufs[i]` collapse to the last one before submit,
and every draw that names `poolBufs[i]` — across all slices — reads those final
bytes. On WebGL2 (`rhi-webgl2/src/rhi-webgl2.ts:948–949`) the same call is an
_immediate_ `bufferSubData`:

```ts
gl.bindBuffer(b.target, b.buf)
gl.bufferSubData(b.target, byteOffset, data as ArrayBufferView)
```

Immediate mode consumes the buffer at each draw's own call site, so the same
pool reuse is harmless: slice 0's draws see slice 0's bytes because they ran
before slice 1 overwrote them. (On the globe the drape is WebGPU-gated anyway —
`this.rhi.backend !== 'webgl2'` at `vector-tile-renderer.ts:3137` — so forcing
WebGL2 doesn't merely make it safe, it takes a different path entirely. Either
way, WebGL2 is where the bug isn't.)

One more observation closed the loop and explained why steady-state fixtures
were clean. When every slice needs the _same_ tile set, slot `i` receives the
same anchor from every slice, and last-writer-wins is a no-op — the bytes are
identical no matter who writes last. The corruption is proportional to how much
the slices _disagree_ about their tile `i`, and that disagreement is largest,
and shifts frame to frame, while tile residency is still settling right after a
camera switch. The bug lived in the transient post-switch frames and evaporated
at rest — exactly the window a static fixture skips.

## The fix

Give each slice its own window of the pool within a frame, so no two slices ever
share a slot. A frame-monotonic base — reset once per frame and advanced by each
slice's item count — threads through `RasterDraper.draw` into `executeItems`,
which seeds its cursor from the base instead of the constant zero:

```
per frame (beginFrame):   poolBase ← 0
per slice (renderGlobeFills):
    draw(pass, global, tiles, …, poolBase)   // claims slots [poolBase, poolBase + tiles.length)
    poolBase ← poolBase + tiles.length
executeItems:             let poolIdx = poolBase   // was: = 0
```

Now slice 0 owns `[0, n)`, slice 1 owns `[n, n+m)`, and the deferred write has
nothing to clobber — every draw's slot is written exactly once per frame. Slots
are still reused _across_ frames (the base resets each frame), so resident
uniform memory is bounded by one frame's total tile count, not by history. The
raster and flat paths pass a base of `0` and stay byte-for-byte identical; only
the multi-slice drape, the one caller that issues many batches into a single
submit, sees a different number.

## How we know it holds

The pixel witness is the per-tile check that first exposed it: on the
multi-slice scene, across the transient post-switch frames, each draped tile now
samples its own anchor rather than a later slice's. But the durable guarantee is
structural, not photographic. Disjoint per-slice slot windows make "last writer
wins" vacuous — there is only ever one writer per slot per frame — so the
property holds for _any_ slice order, tile count, or backend write timing, not
just the one scene we captured. That is the right altitude for this class of
bug: a differential pixel diff could not see it, so the proof that it is gone
cannot be a pixel diff either.

## What generalizes

A deferred write turns pooled-slot reuse into a data race that a same-frame
immediate backend never shows. The two backends are not interchangeable under
aliasing: the immediate one silently launders the race, so a hard corruption on
one is invisible on the other, and "it's fine on WebGL2" is not evidence the
code is correct — only evidence that WebGL2's write timing hid it. Any resource
pooled by index and written through a queue-deferred API carries this hazard the
moment two producers reuse the same index before one submit.

And a differential test cannot see a bug both sides share — the rendering face
of a rule this blog has already met in arithmetic, where [a subtraction
cancels the bias its two terms carry in common](/blog/2026-07-14-differences-forgive-shared-bias).
A minimal fixture can be minimal in precisely the dimension the defect needs;
a same-input diff of a deterministic pipeline reports zero for a frame that is
deterministically wrong. When the symptom is "the right thing in the wrong
place," suspect a shared, index-addressed resource before the geometry, and
reach for a per-item ownership check, not a whole-frame diff.

## References

1. ["20.7 km and 0.7 m: a difference forgives the bias its terms share"](/blog/2026-07-14-differences-forgive-shared-bias)
   — the same blindness in numerical form: a difference cancels the bias its
   terms hold in common, so a diff-based guard sees nothing. Our differential
   frame diff cancelled a bias both renders shared.
2. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu)
   — the WebGPU/WebGL2 seam from the testing side: a green output that never
   pinned which backend produced it. Here the green diff never pinned that both
   frames shared the defect.
3. ["Two renderers, one truth"](/blog/2026-07-13-two-renderers-one-truth) — the
   mirror-image case: four bugs that lived only in the WebGL2 twin. This one
   lives only in WebGPU, for the same underlying reason — two backends with
   different write timing are two different machines.
