# Sub-pixel maps on 32-bit floats: the X-GIS precision playbook

> Edition: **dev**. Exhaustive version: [`../agent/02-coordinates-precision.md`](../agent/02-coordinates-precision.md).

A GPU computes in 32-bit floats. The Earth, in meters, does not fit: at Seoul's longitude
a Mercator X is about 1.41 × 10⁷ m, where one f32 ULP is **1.68 meters** — several
on-screen pixels once you're past z14. Every deep-zoom map engine is, underneath, a scheme
for never letting the GPU see a big number. This chapter is X-GIS's scheme, and the
mistakes that shaped it.

## Write the error budget before the shader

The core discipline is a closed-form bound you can compute in a unit test, no GPU:

```
boundPx(z) = dominantM · 2⁻²³ · pxPerM(z)
```

where `dominantM` is the largest magnitude the path ever stores in f32. Plug in frames:

- absolute Mercator meters → crosses 0.5 px at **z ≈ 14.5** (measured 56 px at z20.55);
- absolute ECEF meters → z ≈ 15.6;
- **tile-local coordinates → the zoom cancels algebraically**:
  `(2πR/2^z) · 2⁻²³ · (512·2^z/2πR) = 512·2⁻²³ ≈ 6×10⁻⁵ px`, at every zoom, forever.

That last line is the whole architecture. Choose a frame whose magnitude shrinks as fast
as your pixels do, and the linear math never needs doubles on the GPU. X-GIS keeps this
budget as an executable test file; the team's stated regret is not writing it *first* — it
would have rejected a wrong frame at design time and saved three wrong "fixes."

There is a second, separate budget: **jitter**. A stationary vertex shakes if the *camera
anchor* is a single f32 — one ULP at Mercator magnitudes is ~0.7 m, and panning walks the
rounding across the float grid frame by frame. The user-visible symptom is "the map
trembles when I pan at high zoom." The rule that falls out: the camera anchor ships as a
split hi/lo pair, everywhere — Mercator, the non-Mercator central longitude, and ECEF.

## Three subtractions, all in f64, all on the CPU

The pipeline never lets a large number reach f32:

1. **Tile-local**: at pack time, vertices become `ECEF − tileCenter` in f64, then get
   quantized to two u16s per axis over the tile's exact residual range (0.57 µm steps at a
   z14 tile — round-trip gated at ≤1 mm).
2. **Camera-relative**: per frame, `tileCenter − cameraCenter` is computed in f64 and
   split hi/lo into the tile's uniforms.
3. **On the GPU, only small numbers add**: dequantize, add the hi offset, add the lo
   offset, multiply by the MVP. The hi−hi subtraction is *Sterbenz-exact* when the camera
   is near the tile; the measured whole-domain recombination error is 2.3×10⁻⁴ px.

The two classic failures both came from breaking this order. One shader **rebuilt an
absolute longitude in f32 degrees** and then subtracted the camera — catastrophic
cancellation; strokes visibly shook. ("A value that is born relative gets promoted to
absolute, travels one stage, and is demoted back by subtracting the same large anchor.")
And the fix for it initially landed on *one* of two sibling paths — outline but not fill —
converting a shared invisible jitter into a visible 3 px seam between a polygon and its
own border. The lesson is sharp: **a precision fix is a change to arithmetic; land it on
one sibling only and you have manufactured a divergence out of a fix.**

## Emulated doubles are a compiler fight, not a math problem

Where genuine double precision is unavoidable, X-GIS uses double-float ("df64")
arithmetic: a number is an unevaluated `(hi, lo)` pair of f32s (~48 significand bits),
with the classic error-free transformations (Knuth two-sum, Dekker split, two-product).
The math is fifty years old. The hard part is that every one of those algorithms contains
lines like `e = b − (s − a)` that are *algebraically zero* — and shader compilers are
allowed to notice. WGSL permits reassociation; Metal defaults to fast-math; there is no
`precise` qualifier in either target. The defense stack, every layer paid for by a real
device:

- An opaque `1.0` multiplied through every intermediate — fetched from a **1×1 texture**,
  never a uniform, because drivers *specialize pipelines on observed uniform values* and
  hot-swap re-optimized variants mid-session (a demo was caught alternating between
  correct and f32-collapsed rendering with byte-identical inputs).
- Re-normalize after **each** cross term of the multiply, not once at the end — otherwise
  the compiler factors `a` out of `a·b_hi + a·b_lo` and the cross term rounds away.
  On Apple hardware, addition survived while multiplication returned exactly zero.
- A low word that was **loaded** (from a uniform/attribute) is treated as discardable by
  reassociating backends right before a cancellation, while a low word the compiler just
  *computed* is kept. So every operand feeding a subtraction or division gets laundered
  through `+ df64_zero` — and that zero is built out of bitcasts so the project's *own*
  optimizer can't fold it either. When it briefly could, the `x + 0 → x` identity deleted
  the renormalization — and a pixel gate stayed green, because the guard texture read
  survived. What caught it was an **operation-count ratchet**, not pixels.
- On Metal, the durable answer is different arithmetic altogether: the same two-sum /
  two-product contracts rebuilt in **u32 integer operations**, which fast-math cannot
  touch. Same API, no guard needed, selected per device.

If you're building a new engine: prefer restructuring (RTC frames) so the high-precision
multiply never happens — that's also why deck.gl deprecated its fp64 mode — and treat any
df64 you do keep as an adversarial-compiler problem with structural verification
(op counts, cut tests), not a visual one.

## The geoid split, and why "it looked fine" was misleading

Web Mercator is spherical *by definition* (EPSG:3857); 3D positions live on the WGS84
ellipsoid. X-GIS originally also had the **camera** on a sphere while vertices sat on the
ellipsoid — a frame mismatch of up to ~21 km at mid-latitudes. Mostly invisible! Because
within one camera-relative subtraction both endpoints carry the same bias and it cancels.
The test that was supposed to guard the datum ("force a sphere, expect a 10 km shift")
measured **0.7 m** — differences forgive shared bias; only a *mixed*-frame probe sees the
truth. The bug that did surface was exactly a mixed frame: tile center on one geoid,
camera on the other, and the 21 km landed in the offset — fine at z1.5 (0.8 px), a blank
tile by z14 (4,400 px). The datum is unified now; the residual is the honest ellipsoid
anisotropy (≤ ~2 px across the parity matrix), and the witness test is a split-brain
probe: point-vs-polygon anchors went from 5,697 px apart to under half a pixel.

## Depth, briefly

Forward-Z with **logarithmic depth**, written per fragment (interpolating a non-linear
function across a triangle drifts). The far plane is horizon-bounded. One elegant hack:
the globe's "orthographic" look keeps a *perspective* matrix with a 96× telephoto,
because a true parallel projection has `w ≡ 1` — which flattens w-driven log depth into a
constant and lets the far hemisphere render through the near one.

## Parity has a blind spot

CPU and GPU projection math come from **one IR** (the CPU side is a generated f64 lowering
of the same graph the WGSL is emitted from), so drift between them is structural rather
than disciplinary. But the reference oracle's own header says the important part out loud:
it validates *algebra*, not f32 behavior — "a CPU↔CPU pass here is NOT evidence of GPU
precision parity." And a parity test between two copies of the same bug passes. The
counters are: run the real emitted WGSL in a compute pass against the f64 lowering (with
tolerances that know whether you're on real hardware or a software rasterizer), and add
**metamorphic** checks — e.g. the seam must be continuous across ±180° — which don't need
a correct reference at all.

## What to steal

1. An executable error budget, written before the shader.
2. Magnitude-shrinking frames (tile-local + camera-relative), subtractions in f64 on the
   CPU, split hi/lo camera anchors — jitter is a budget of its own.
3. Never promote a relative value to absolute mid-pipeline; never fix precision on one
   sibling path.
4. df64 only where restructuring can't reach, defended structurally, with an integer
   fallback for fast-math platforms.
5. One geodesy authority; test datum guards with symmetry-*breaking* probes.
6. Log depth per fragment; telephoto instead of true ortho.
7. Parity tests + metamorphic invariants, never parity alone.
