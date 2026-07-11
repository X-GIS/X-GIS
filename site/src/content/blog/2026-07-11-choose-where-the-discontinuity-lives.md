---
title: 'You cannot delete an intrinsic discontinuity — only choose where it lives'
description: "Adjacent map tiles projected the same vertex 40,075 km apart — one full world circumference. A rotated projection's unavoidable branch cut, resolved per tile, scattered the seam across every tile join; the fix relocates it to the one edge geometry expects."
date: '2026-07-11T13:30:00Z'
tags: ['projections', 'rendering', 'geometry']
lang: en
draft: false
---

The new regression test, run against the code it was written to condemn,
failed with this:

```
worst tile-join seam gap: z=2 edgeLon=-90 lat=-54 (Δ=1.000 world-copies):
expected 40075016.68557849 to be less than 0.001
```

40,075,016.685 meters is $2\pi R$ for the Web-Mercator Earth radius
$R = 6{,}378{,}137$ m — one full trip around the planet. Two adjacent tiles had
projected the _same geographic vertex_ exactly one world copy apart. On screen
— an oblique (rotated) Mercator at zoom 1.40, camera at lat 50.54646, lon
−88.35140 — that showed as full-width horizontal smear bands of water polygons
torn across Russia, Canada, the US, Brazil, and South America.

The interesting part: the discontinuity it exposed is not a bug. A Mercator
projection unrolls a cylinder into a plane, and unrolling requires a cut;
ordinary Mercator cuts at ±180°. Rotate the projection — put its "equator"
along an arbitrary great circle to keep distortion low near the camera — and
the cut rotates too: an _oblique antimeridian_, the curve where the rotated
longitude's `atan2` jumps from +π to −π. No formula removes that jump. The
only design freedom is where it surfaces.

## Two suspects, one signature

The issue arrived with two standing suspects: rotated-antimeridian handling
interacting with Mercator's latitude clamp — plausible, because clamping
latitude (classically at ±85.05°) is exactly the kind of flat-map special case
a rotated frame could misapply — and insufficient tile subdivision, since a
rotated projection bends straight tile edges into curves that too-coarse
subdivision renders as visible chords.

A numeric probe at the repro camera discriminated in one shot, because the two
suspects predict different error _shapes_. Faceting produces chord errors that
vary with position and grow toward the projection's diverging pole; it cannot
produce a gap of one exact world circumference. A branch disagreement shifts
the unwrapped longitude by exactly 2π, so wherever a shared edge tears at all
it tears by exactly $2\pi R$ — never a fraction. The measured Δ = 1.000 world
copies was a branch choice, not an approximation error. The clamp theory died
by code reading: the oblique arm never touches the ±85.05° clamp — it clamps
at $90 - 10^{-4}$ degrees, a hair below the pole. Faceting is real but
different: a within-tile artifact near the diverging rotated pole, still
present after this fix, and never the seam gap.

## The cut was parked on every tile join

Tile geometry is projected per-vertex by a GPU function authored in a
TypeScript shader DSL. The heart of the oblique arm, before the fix:

```ts
const r = oblique_rot({ lon_deg: lon_primary, lat_deg, clon, clat })
const ref_r = oblique_rot({ lon_deg: ref_primary, lat_deg: clat, clon, clat })
const lam_u = unwrap_rad_near({ value: r.x, ref_v: ref_r.x })
```

The load-bearing line is the last one. `r.x` is the vertex's rotated
longitude, fresh out of `atan2`, confined to (−π, π]. `unwrap_rad_near` shifts
it by ±2π onto the branch nearest a reference — and the reference, `ref_r.x`,
is computed from `ref_lon`, a **per-tile** input. Every tile unwrapped its
vertices toward itself.

The intent was defensible, and it was even guarded by a test named "a tile
straddling the rotated antimeridian stays contiguous," which asserted
`expect(Math.abs(gE - gW)).toBeLessThan(2e6)` for a tile spanning the cut —
per its own comment, "a few-degree tile, not a near-whole-world span."
Unwrapping toward the tile's own reference means no tile ever spans the branch
cut internally: a 4°-wide tile stays 4° wide. Each tile, considered alone, is
continuous.

The flaw is the phrase _considered alone_. This projection's center tracks the
camera, so the rotated antimeridian sweeps the far side of the world and cuts
_diagonally_ across the axis-aligned tile grid — it does not follow tile
seams. Wherever it crosses a seam, the two adjacent tiles' references sit on
opposite sides of the cut, and `unwrap_rad_near` picks opposite branches for
their **shared** edge: the same vertex, projected with two different `ref_lon`
values, lands $2\pi R$ apart. Per-tile local continuity had been purchased by
scattering the one global discontinuity across every tile join the cut
crossed.

## One address for the cut

The fix deletes the per-tile reference:

```ts
const r = oblique_rot({ lon_deg, lat_deg, clon, clat })
const lam_u = unwrap_rad_near({ value: r.x, ref_v: f32(0) })
```

Unwrap toward the fixed rotated-frame origin — zero is the projection center's
own rotated longitude, a constant of the projection rather than a property of
any tile. The unwrap becomes a pure function of (lon, lat, clon, clat): no
per-tile input can influence the branch, so any two tiles project a
shared-edge vertex to the same position _by construction_. There is nothing to
keep consistent because there is no longer a choice to make. (The one
tile-dependent term left, a world-copy offset `wo·2πR`, is a whole multiple of
the world width — identical for both tiles sharing an edge within one world
copy. The camera center
maps to rotated longitude 0, so near-camera tiles land on the same branch as
before; only far-side tiles move.) The jump goes to the only honest place: the
true rotated antimeridian, rotated longitude ±π.

## The seam did not disappear — it moved

That relocation is the actual content of the fix. Ordinary Mercator has _the
same_ discontinuity and nobody files bugs about it, because at ±180° the tile
grid itself has an edge — the cut coincides with tile boundaries, and upstream
data pipelines already split geometry there. The rotated cut gets no such
alignment for free; the best available move is one curve instead of N
incidental seams. The honest residue: a tile that literally _straddles_ the
rotated antimeridian still spans about a world copy there. Splitting
straddling geometry at the cut — the way flat maps split at ±180° — is a
known, deferred follow-up. At the repro camera the residual cut falls on
far-side ocean; where it crosses land it could still show as a localized
smear.

The old straddling-tile test could not survive the fix, because it _pinned the
buggy design_. It was rewritten — disclosed as such — into the corrected
invariant (adjacent tiles join continuously), plus a deliberately preserved
tripwire that requires the genuine seam to still exist, so the future geometry
split updates the expectation deliberately instead of a green suite silently
absorbing the change:

```ts
const seamW = projObliqueMercatorWgsl(179, 40, 0, 40)[0]
const seamE = projObliqueMercatorWgsl(181, 40, 0, 40)[0]
expect(Math.abs(seamE - seamW), 'raw ±π jump at the true rotated antimeridian').toBeGreaterThan(1e7)
```

## How we know it holds

The regression gate is a pure-f64 unit test: for every east-west adjacent tile
pair at z = 1..3, project the shared meridian edge across the latitude band
twice — once with each tile's reference — and require the worst gap under
$10^{-3}$ m. On the restored pre-fix baseline it failed exactly as designed (2
failed | 1 passed), including a second, independent failure pinning the render
path against the standalone projection authority — `x @ lon=-175 lat=-80:
expected 40075016.68557848 to be less than 1`, the same world copy caught by
value comparison. After the fix: `Tests 3 passed`.

Two honest limits on that verification. First, the CI gate is _only_ the f64
test: no software-GPU raster path exists for this projection in CI, so the
pixel-level evidence is a headed run on one real GPU, at one camera. That run
was read at full resolution in a 16-way split with ×5 crops, and the
before/after diff covered 7.65% of the frame — all of it the removed tear
streaks. Second, no reference renderer exists for this projection in the
parity harness, so the visual check is directional (before vs. after), not
parity against an independent implementation.

The neutrality claim — regular Mercator and globe untouched — rests on
construction (the eight regenerated shader snapshots differ in exactly the two
oblique-arm lines plus a baseline-hash header) plus before/after captures of
both: diff coverage 0.000%, max channel delta 1, the anti-aliasing noise
floor. That danger never fired.

One dead end from the verification itself is worth keeping:

:::warning
The fail-before probe initially "proved" the fix inert: with the baseline and
fixed projection modules loaded into one process, **both** reported the
identical 2πR gap — the shader DSL keeps ambient state on `globalThis` and
shares a compiled-artifact cache, so the second module instance silently
reused the first one's output. Split into two processes, the baseline failed
and the fix passed. A before/after probe that imports both versions into one
runtime reports whichever loaded first — for both.
:::

## What generalizes

The counter-intuitive part is that the buggy code was the more careful-looking
of the two: it did extra per-tile work precisely to stay continuous, and that
extra work is what tore the map apart. When a formula has an intrinsic
discontinuity — a branch cut, a wraparound, a modulo seam — the discontinuity
is conserved: no amount of local handling deletes it. Code that resolves the
ambiguity locally (per tile, per chunk, per worker) turns every boundary
between local decisions into a place where the global answer can flip. Resolve
it once, globally, and you choose the single place the seam surfaces — put it
where your domain already expects an edge, because that is where the machinery
for handling one already lives.

## References

1. ["What a software GPU can verify"](/blog/2026-07-07-what-a-software-gpu-can-verify)
   — why the CI software-GPU lane cannot raster-gate everything; the reason
   this fix's CI gate is pure f64 rather than pixels.
2. John P. Snyder,
   ["Map Projections: A Working Manual"](https://pubs.usgs.gov/pp/1395/report.pdf)
   (USGS PP 1395) — the standard reference for the oblique Mercator
   construction.
