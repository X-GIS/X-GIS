---
title: "The cull we didn't dare add was already safe"
description: 'Two engines rendered the same style differently because one honoured a metadata field the other deliberately skipped. The comment defending the skip described a danger an existing clamp had already neutralized — and the "working" half of the cull turned out to be silently keyed past its own lookup.'
date: 2026-07-11T01:30:00Z
tags: ['metadata', 'parity', 'rendering']
lang: en
draft: false
---

Zoom into Australia on the MapLibre demotiles style and, at z5, MapLibre drops
the Tropic of Capricorn — the dashed reference line and its label vanish. Our
engine kept drawing both forever. Nobody's projection math differed; the
divergence was one TileJSON field. The style's `geolines` source-layer
declares `vector_layers` maxzoom 4 while the _source_ maxzoom is 6, so the
native z5/z6 tiles simply omit that layer. MapLibre renders the empty native
slice — lines gone. We ignored per-layer maxzoom and over-zoomed the z4 data
indefinitely — lines forever.

Parity bugs between two consumers of the same data are usually not two
algorithms disagreeing; they are one metadata field honoured asymmetrically.

## The wrong first move

The skip wasn't an oversight. The code defended it, at length:

```ts
// `maxzoom` is intentionally NOT used as a cull bound — it's
// a SOFT bound on raw archive data, but sub-tile generation
// continues to upscale the maxzoom data for over-zoom views.
// Culling on maxzoom would freeze rendering past z=15 on
// protomaps v4 (every layer reports maxzoom=15), defeating the
// whole over-zoom pipeline.
```

The fear was legitimate: on a basemap where every layer reports maxzoom 15,
a naive `currentZ > layer.maxzoom` cull would blank the entire map past z15.
So the field stayed half-honoured — minzoom culled, maxzoom "intentionally
NOT" — and the comment sat there as the reason no one touched it.

But the danger had an unstated precondition, and the precondition no longer
held. `currentZ` — the resolved native tile level — is _already clamped to
the source maxLevel_ before this code runs. On protomaps, currentZ can never
exceed 15, so `currentZ > 15` can never fire; over-zoom is untouched. The
comparison fires only when a layer's data-max is _strictly below_ the source
max — demotiles' 4 < 6 — which is precisely the case where the native tile
exists and omits the layer, i.e. precisely what MapLibre renders. The
comment's scenario was unreachable, and had been since the clamp existed.

## What actually happened

The cull became a symmetric band check, with the safety argument stated as a
reachability condition rather than a warning:

```ts
export function sliceOutsideDataZoomRange(
  range: { minzoom: number; maxzoom: number } | null | undefined,
  nativeZ: number,
): boolean {
  if (!range) return false
  return nativeZ < range.minzoom || nativeZ > range.maxzoom
}
```

Wiring it exposed a second, quieter bug in the half that everyone believed
worked. Layers with a style filter get a slice key of the form
`sourceLayer::<hash>` — but the metadata lookup keys on the bare source-layer
name. The demotiles geolines layers all carry a filter, so the _existing
minzoom cull had been a silent no-op on them the whole time_: a lookup that
returns `undefined` and a guard that treats `undefined` as "always present."
The suffix is now stripped before the lookup, which means the minzoom cull is
enforced on filtered layers for the first time — a latent behaviour change we
flagged for the visual pass rather than assumed harmless.

## How we know it holds

Three regression points, one per stakeholder in that old comment. The
demotiles case: at z5 the geolines slice must produce no selection —
reverting only the cull fails with a nine-tile `Selection` where `null` was
expected, the exact pre-fix behaviour. The boundary: z4 (at the layer's
declared max) still renders — the band is inclusive, matching MapLibre. The
feared case: protomaps roads at z18 are _not_ culled, pinning that the clamp
makes the over-zoom scenario unreachable. The converter side is pinned too —
the style's own maxzoom (24) passes through untouched, so the cull decision
stays owned by the tile metadata, not the style. On-screen confirmation
against MapLibre remains on the checklist for a GPU machine; the decision
function and both call sites are what these tests prove.

## What generalizes

"Intentionally NOT" comments have an expiry condition that nobody re-checks,
because the comment reads as a conclusion rather than a claim. This one was
protecting against a case an existing clamp had made unreachable — the reason
not to fix had expired while the comment kept guarding it. When you find one,
extract its precondition and test it; if the precondition holds structurally,
encode it in the code path (or a pinned regression) and retire the prose. And
distrust the half of a guard that "already works": the working minzoom cull
here had been no-oping on every filtered layer, failing in the only direction
nobody screenshots — rendering _more_ than it should.
