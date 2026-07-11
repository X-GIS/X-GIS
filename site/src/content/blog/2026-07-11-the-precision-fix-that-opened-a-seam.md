---
title: 'The precision fix that opened a seam'
description: "Making the line outline's projection precise, but not its polygon fill, turned a shared invisible jitter into a ~3px fill≠outline seam at deep zoom. The fix isn't more f64 — it's the same camera-relative reframe, which the linear term needs no emulation for."
date: 2026-07-11T04:00:00Z
tags: ['precision', 'rendering', 'shader-dsl', 'numerical']
lang: en
series: { name: 'Emulating f64 in shaders', order: 9 }
draft: false
---

A commit that made the map _more_ correct made it visibly _worse_. It sharpened
the longitude projection of the line outline — deleting an f32 cancellation that
shook road edges by tens of pixels at z22 — and left the polygon fill's identical
projection untouched. Before, fill and outline were wrong _together_: they shared
the same sub-metre jitter, so the fill edge and the stroke drawn on top of it moved
as one and nobody saw a gap. After, the outline snapped to the truth and the fill
stayed behind. At a Seoul-longitude tile (127°, Mercator X ≈ 1.41 × 10⁷ m) the two
now part company by ~0.4 m — about 3 px at z20 — a fill-that-shows-through-its-own-outline
seam that did not exist the day before the fix.

This is the recurring shape of a bug in a renderer with two sibling paths for one
edge: the danger is not that a path is imprecise, it's that two paths that must
coincide use _different_ arithmetic. A precision fix is a change to arithmetic. Land
it on one sibling only and you have manufactured a divergence out of a fix.

## The wrong first move

The work order framed it backwards, and the framing was seductive. It said, in
effect: the outline jitters at high zoom on non-Mercator projections — make it
precise _like the fill path_. Copy the good sibling onto the bad one. That is the
normal direction of a parity fix, and it reads as obviously safe.

It was inverted. Reading the two emitted shaders showed the fill was **not** the
precise one on this branch. The earlier commit (`e251b66`) had already rewritten the
line's `finalize_corner` to project a camera-relative delta; the outline was now the
_more_ precise sibling, and the fill still fed its projection the lossy absolute
longitude. "Make the outline like the fill" would have re-derived the bug we'd just
fixed. The move was the opposite: make the fill like the outline.

You cannot tell which sibling is correct from the bug report. You can only tell by
reading what each one actually emits.

## What actually happened

The fill's vertex shader is generated, so the evidence is in the emitted WGSL, not
the TypeScript. Slicing the quantized fill entry out of `emitPolygonWgsl` and reading
the projection call is the whole diagnosis:

```wgsl
// pre-fix fill (vs_main_ecef): the absolute degree, reconstructed by ADDING
// the ~1.4e7 m tile origin back on before dividing to degrees.
let _cse4 = (abs_lon + u.tile_origin_merc.x);
let _cse2 = flat_rel((_cse4 / _cse5), true_lat, u.proj_params,
                     ((u.tile_origin_merc.x + (0.5 * u.tile_extent_m)) / _cse5));
```

`abs_lon + u.tile_origin_merc.x` is the smoking gun. It rebuilds the vertex's
_absolute_ Mercator X — a number near 1.4 × 10⁷ — in f32, whose spacing there is
about a metre, and only then divides down to a degree the projection can consume. The
projection itself then computes `radians(abs_lon) − radians(clon)`: a subtraction of
two large, nearly-equal angles, i.e. catastrophic cancellation. The ~0.4 m residual
is what survives. The line, meanwhile, had stopped reconstructing the absolute value
at all.

## The fix

The reframe is the interesting part, and it is why this belongs in a series about
_emulating_ f64: here we don't emulate anything. The projection depends on longitude
only through `lon − clon`. So subtract the camera longitude _first_, in the
tile-local frame where the 1.4 × 10⁷ m tile origin cancels **before** it ever reaches
f32, and recentre the projection onto `clon = 0`:

```ts
if (localMerc) {
  const clon = projParamsV.y
  const relMercX = localMerc.x.sub(U.field.cam_h.x).sub(U.field.cam_l.x)
  const dLon = relMercX.div(deg2rad.mul(earthR))
  const projParamsRel = vec4(projParamsV.x, f32(0), projParamsV.z, projParamsV.w)
  const tileRefLonRel = U.field.tile_origin_merc.x
    .add(f32(0.5).mul(U.field.tile_extent_m))
    .div(deg2rad.mul(earthR))
    .sub(clon)
  const relG = flat_rel(dLon, discLat ?? absLat, projParamsRel, tileRefLonRel)
  clip.assign(transformMat4(mvp, vec4(relG.x, relG.y, zG, 1)))
  return
}
```

`localMerc.x` is the vertex's tile-local Mercator X — the vertex minus the tile
origin, carried in the fill's f32 tail in the _same_ frame as `cam_h + cam_l`. The
large magnitude is gone before the division. This is exactly the arithmetic the
outline's `finalize_corner` already emits, so the two are byte-identical by
construction. The subtraction `lon − clon` is exact in real arithmetic; recentring
just moves the cancellation to where it costs nothing. No emulated double, no Taylor
series — the _linear_ term never needed one.

One guard: the disc arm is shared by three vertex entries, and only the quantized
fill carries `localMerc`. The extruded and non-quantized entries fall back to the old
`abs_lon` path — where fill and outline share it identically, so there is no seam to
open.

## How we know it holds

Latitude is deliberately left alone, and that is the tell that this fix is honest.
Latitude reaches the projection through `inv_merc_lat`'s `atan(exp(...))` — nonlinear,
no `lat − clat` cancellation to exploit — and both fill and outline round-trip it
through the same f32 degree. It is a real ~0.4 m residual, but it is _shared_, so it
causes no divergence; making it precise means threading emulated f64 through the
projection trig, which is a different, GPU-wide change. The linear half has a
closed-form reframe; the nonlinear half does not. Knowing which half you're holding
is the entire triage.

The gate is two tests, no GPU. An analytic one emulates, in f64 on the CPU, the exact
longitude each sibling feeds the projection and measures the seam between them: the
pre-fix fill lands **> 0.2 m** from the outline across projTypes 1–5 at z16/18/20,
the post-fix fill **< 0.01 m**. A structural one asserts the emitted fill shader now
contains the camera-relative, `clon`-recentred `flat_rel(...)` call and no longer the
`flat_rel(abs_lon, ...)` disc arm — it fails on the unmodified shader against the
literal pre-fix string. What a unit test cannot vouch for is the final absence of the
3 px seam on a real over-zoomed non-Mercator frame; that is recorded as pending a
GPU pixel-diff, not claimed.

## What generalizes

The instinct on finding a jittering path is to make _it_ precise. The instinct is
incomplete: precision is a property of arithmetic, and a rendered edge is usually two
paths of arithmetic that have to agree. Sharpen one and you can move a shared,
invisible error into a visible seam — the fix and the regression are the same commit.
Before you land a precision change, find every sibling that has to coincide with the
value you're changing, and change them together or not at all.

And the quieter lesson, the one this series keeps circling: reach for emulated f64
last, not first. A large coordinate minus a nearby camera is a subtraction that is
exact the moment you do it in the right frame. The expensive machinery is for the
term that has no such frame — here, the latitude — and spending it on the term that
does is how you end up maintaining a Taylor series where a change of origin would have
done.

## References

1. Earlier in this series: [Part 5 — the low word a load throws away](/blog/2026-07-09-the-low-word-a-load-throws-away), [Part 7 — the multiply you cannot guard](/blog/2026-07-09-the-multiply-you-cannot-guard), and [Part 8 — a GPU extended-precision field guide](/blog/2026-07-09-gpu-extended-precision-field-guide).
2. [The migration regressed one renderer at a time](/blog/2026-07-11-the-migration-regressed-one-renderer-at-a-time) — the same fill-vs-sibling divergence archetype, that time from a coordinate-frame migration rather than a precision fix.
