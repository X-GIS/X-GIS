---
name: point-packer-arena-aliasing
description: PointRenderer's layer.featData aliases the packer's feat output via the shared frame arena — read style BEFORE writing position
triggers:
  - point-feature-packer
  - packPointInstances
  - layer.featData
  - _frameArena
  - feat_data slot 0
  - circle-radius-wiring
  - point renderer slot corruption
  - Mercator-y in radius slot
---

# Point packer: srcFeatData aliases feat through the frame arena

## The Insight

In `PointRenderer`, `layer.featData` is allocated from `this._frameArena`
(`point-renderer.ts` `addLayer`, ~:634), and `render()`/`uploadLayer` calls
`this._frameArena.beginFrame()` and re-allocates `expandedFeat` (the packer's
`out.feat`) from the SAME arena. So the layer's persistent `featData` and the
per-frame `feat` output **occupy overlapping memory** — for a one-point layer,
`layer.featData[0]` is the same word as `feat[22]` (the Mercator-y hi slot).

Therefore the packer's `srcFeatData` (== `layer.featData`) is an ALIAS of its
`feat` output, not an independent buffer. Any packer that writes POSITION slots
(11-18, 20-23) before COPYING the style slots (0-10, 19) from `srcFeatData`
corrupts the style source before it is read: slot 0 (radius) comes out as the
Mercator-y tail (~2.27e6 for lat 20). The rule: **copy the style/shape slots
BEFORE writing any position slot (read-before-write)**. The legacy interleaved
loop got this for free; a clean "position pass then style pass" split does not.

## Why This Matters

A "two-pass" refactor (all points' position, then all points' style) looks
correct and passes `tsc` + a naive DC=0, but silently corrupts inline point
rendering. The tile path is immune (its `src`/`featData` are DISTINCT arena
allocations), so it hides the bug for the demos you look at first.

## Recognition Pattern

- feat_data slot 0 (radius) reads a huge value (~1e6–1e7) instead of the
  authored px radius — that magnitude is a Mercator-metre coordinate.
- A GPU-free wiring test (`circle-radius-wiring.test.ts`) fails while real-GPU
  DC=0 passes.
- Only the INLINE point path (addLayer/render) is affected; the tile path
  (flushTilePoints) is fine.

## The Approach

When touching `map/src/render/point-feature-packer.ts` (or any code that fills
`feat` from `srcFeatData`): assume `srcFeatData` MAY alias `feat`. Structure the
writes as Pass 0 = copy style 0-10 + shape 19 from src, Pass 1 = position,
Pass 2 = verts/depth. Never read `srcFeatData` after writing position. Do not
"optimize" by merging the style copy into the position pass.

## Example

```ts
// WRONG (position first → corrupts aliased src[0]):
// Pass 1: feat[dstOff+22] = myH            // overwrites layer.featData[0]
// Pass 2: feat.set(src.subarray(0,11), 0)  // reads corrupted src
// RIGHT (style first, read-before-write):
// Pass 0: feat.set(src.subarray(srcOff, srcOff+11), dstOff); feat[dstOff+19]=src[srcOff+19]
// Pass 1: position slots 11-18, 20-23
```

The deeper fix would be to stop arena-backing `layer.featData` (it aliases +
persists across frames), but the read-before-write ordering restores correctness
minimally. See PR #731 commit 951c6990.
