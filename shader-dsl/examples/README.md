# `@xgis/shader-dsl` examples

Self-contained shaders authored with the DSL. Each builds a `module`, and from that single
source emits **WGSL** (WebGPU) + **GLSL ES 3.00** (WebGL2) + the `reflect()` pipeline metadata —
with **no dependency on the X-GIS runtime**. They import only from the package's own source
(`../src/index.ts`), so they run straight from a checkout.

Every example is also exported (`module` + metadata) from [`index.ts`](./index.ts), so the same
sources power the interactive **/shader-dsl** site page (which renders the renderable ones live
on a WebGL2 canvas) and the CLI printer.

The fullscreen boilerplate — the `{time, resolution, …}` uniform head, the `VsOut` ioStruct,
and the fullscreen-triangle vertex stage — is shared from [`_fullscreen.ts`](./_fullscreen.ts)
(`fullscreenUniforms(extra)` / `VsOut` / `vs`), so a fullscreen example declares only its
fragment stage and extra uniform fields.

Interactivity: the site host fills a `{ kind: 'mouse' }` control with pointer state
(`vec4 [x, y, down, used]` — the contract lives in [`_shared.ts`](./_shared.ts)). Shaders
gate the interactive path on `m.w`, so an untouched frame renders the canonical autopilot
view — what thumbnails, the render gates, and reduced-motion users see. The e2e gate
`_shader-dsl-mouse-interaction.spec.ts` asserts every mouse example visibly responds to the
pointer. Transport controls (play/pause, scrub, speed, reset, fullscreen) are host chrome
on the site detail page and need nothing from the example.

## Coordinate spaces

Three spaces appear in these shaders — name the one you are in (#842):

1. **uv** — `vo.uv`, `[0,1]²`, origin bottom-left. What the vertex stage hands you.
2. **centred isotropic** — `screenCoords(vo.uv, res)` (from `_fullscreen.ts`): y spans ±1
   over the height, x spans ±aspect over the width, so **one unit covers the same number of
   pixels on both axes**. Compute distances / angles / shapes here — a circle stays a circle.
3. **pattern space** — whatever a shader scales/warps those into (tiles, polar, fractal plane).

Never mix units across spaces in one measurement: the ocean example once measured the
sun-disc distance between an aspect-scaled x and a raw uv y — units differed 2× and the sun
rendered as an ellipse. Every gate passed; only visual review caught it.

| File                     | Category     | What it shows                                                                                                                                                        |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graticule.ts`           | cartographic | A lon/lat graticule — anti-aliased grid lines (screen-constant width via `fwidth`), a gold equator, spinning over `time`.                                            |
| `fp64-deep-zoom.ts`      | cartographic | The fp64 hello-world: fract() stripes at a world coordinate near 1e8 — plain f32 (left) collapses flat, the emulated-double f64 type (right) keeps them.             |
| `fp64-checker-plane.ts`  | cartographic | A 1-unit checkerboard 10⁸ units from the origin (one f32 ulp = 8 cells) — floor/fract on the f64 type recover parity + anti-aliased borders; the f32 half is flat.   |
| `fp64-loran.ts`          | cartographic | LORAN hyperbolic navigation: bands of d₁−d₂ to two stations 10⁷ units out — cancellation + fract via the vec64 `distance` reduction; the f32 half is band garbage.   |
| `fp64-mercator-tiles.ts` | cartographic | The tile-engine formula (Web-Mercator × 2^z, floor/fract) at z 12–23 — 2^z built by exact doubling; f32 smears tiles into ulp-blocks from z ≈ 18.                    |
| `fp64-rtc.ts`            | cartographic | Relative-to-center rendering: subtract in df64 FIRST, then narrow the small delta — the f32 half narrows first and its reticle quantizes to the 8-unit ulp grid.     |
| `hillshade.ts`           | cartographic | Shaded relief — a reusable `terrain()` DSL function (called 3× for height + a finite-difference normal), Lambert-lit by a movable sun, hypsometrically tinted.       |
| `color-ramp.ts`          | cartographic | A choropleth colour ramp — a reusable `ramp()` maps a value field through a 5-stop palette, with anti-aliased contour isolines.                                      |
| `shadertoy-plasma.ts`    | generic      | The classic sum-of-sines plasma through an RGB palette — the "hello shader".                                                                                         |
| `voronoi.ts`             | generic      | Animated Voronoi (cellular noise) — a 3×3 neighbour scan shades each fragment by `distance` to its nearest animated feature point; nested `Loop`.                    |
| `julia.ts`               | generic      | Animated Julia set — escape-time fractal (`z ← z² + c`) coloured through a cosine palette; `Loop` + early `Break` + a mutable `var` accumulator.                     |
| `mandelbrot.ts`          | generic      | The Mandelbrot set with SMOOTH escape-time colouring (log₂ log₂ \|z\|² kills the banding), breathing in and out of the seahorse valley.                              |
| `fbm-clouds.ts`          | generic      | fBm clouds — value noise summed over octaves (frequency doubling, amplitude halving), drifting over `time`; helper fns + a `Loop` octave accumulator.                |
| `domain-warp.ts`         | generic      | Domain warping — `fbm(p + w·fbm(p + fbm(p)))` melts lattice noise into marbled flow; the intermediate warp vectors double as colour axes.                            |
| `raymarch-sphere.ts`     | generic      | Raymarched sphere — an SDF sphere-traced from a camera ray then Blinn-Phong shaded; `normalize`/`length`/`dot`, a `Loop` march with early `Break`.                   |
| `raymarch-boxes.ts`      | generic      | Domain repetition — one rounded-box SDF floor-modded into an infinite lattice, flown through forever; a reusable `scene()` fn serves the march AND the 6-tap normal. |
| `tunnel.ts`              | generic      | The demoscene tunnel — polar remap (angle around, 1/radius into the depth) makes a checker fly past forever; `atan2` + fog + a twist control.                        |
| `metaballs.ts`           | generic      | 2D metaballs — inverse-square fields summed per ball, iso-contoured into merging blobs; hue is field-weighted so colours blend where blobs touch.                    |
| `ocean.ts`               | generic      | An ocean horizon — rows below the horizon perspective-divided into a water plane waved by fBm, plus a sun disc and its glitter path.                                 |
| `starfield.ts`           | generic      | A textureless night sky — three hash-grid parallax layers decide per cell whether a star exists, where it sits, and how it twinkles.                                 |
| `truchet.ts`             | generic      | Truchet tiles — two quarter-circle arcs mirrored per cell by a hash bit weave an endless maze; `fwidth`-anti-aliased, energy pulsing along the arcs.                 |
| `kaleidoscope.ts`        | generic      | The kaleidoscope fold — the angle floor-modded into one sector and mirrored, so every sector repeats the same wedge of swirling fbm + rings.                         |
| `heart.ts`               | generic      | The sextic heart curve `(x²+y²−1)³ = x²y³`, sign-filled and `fwidth`-anti-aliased, thumping to a sharpened-sine heartbeat with a beat-synced glow.                   |
| `fp64-mandelbrot.ts`     | generic      | The classic double-float demo: a needle-spike filament at a ~1e-7 span — the f32 half collapses flat, the f64 half keeps the filament; drag/wheel deep-zoom camera.  |
| `fp64-julia.ts`          | generic      | The Julia twin: seed fixed, the PIXEL becomes z₀ — camera parked on a repelling fixed point (on the set at every scale), so the spiral survives any depth in f64.    |
| `fp64-burning-ship.ts`   | generic      | The Burning Ship — the \|Re\|,\|Im\| fold runs as df64 `abs` INSIDE the extended-precision iteration; ember-palette escape bands to the df64 floor.                  |
| `fp64-newton.ts`         | generic      | Newton fractal for z³ = 1 — a full complex DIVISION per step through `df64_div`; Wada basins keep all three root colours interleaved at any zoom.                    |
| `fp64-mandelbrot-de.ts`  | generic      | Distance-estimate Mandelbrot with precision split mid-formula: orbit z in f64, derivative dz in f32 — glowing boundary filaments, depth-invariant shading.           |
| `fp64-clock.ts`          | generic      | The long-uptime bug: fract(epoch + time) at epoch ≈ 1e8 s — the f32 dial freezes (ulp = 8 s), the f64 dial sweeps; epoch as an f64 literal, split at build time.     |
| `fp64-cancellation.ts`   | generic      | The numerics-textbook plot: (x−1)⁷ EXPANDED near x = 1 — f32 returns 7000× noise, df64 hugs the curve, and the factored-form reference shows the real fix.           |
| `gradient-pass.ts`       | generic      | A two-colour gradient with a biasable blend + the `If`/`elif` control-flow combinator.                                                                               |
| `compute-reduction.ts`   | compute      | A `@workgroup_size` compute kernel folding a window of a storage buffer with `reduce()`. WebGPU-only (GLSL ES 3.00 has no compute), so it emits WGSL + reflection.   |

> Licensing note: the generic set covers the classic ShaderToy-era effects (plasma, tunnel,
> Mandelbrot/Julia, metaballs, seascape, starfield, domain warping, truchet, raymarching,
> kaleidoscope) as ORIGINAL DSL implementations of the well-known techniques — no code is
> ported from shadertoy.com listings, whose default license (CC BY-NC-SA) is incompatible
> with this repository's MIT license.

## Run

```bash
npx tsx examples/print.ts            # every example
npx tsx examples/print.ts hillshade  # just one, by id
```

(or `bunx tsx …`). Each prints the emitted WGSL, the GLSL ES 3.00 vertex + fragment (for the
WebGL2-renderable ones), and the JSON `Reflection` (bind groups, std140/std430 struct layouts,
entry-point signatures).

## Verified

- **Emit gate** — `examples.test.ts` (run with `bunx vitest`) asserts every renderable example
  emits WebGL2-valid GLSL ES 3.00 (no `f32()` cast leak, no `in` reserved-word identifier, the
  `uint(gl_VertexID)` cast) and that the compute example stays WGSL-only.
- **Render gate** — `playground/e2e/_shader-dsl-examples-render.spec.ts` compiles + links + draws
  each renderable example on a real WebGL2 context (packing the UBO from `reflect()`) and reads
  back a non-blank, varying frame.
