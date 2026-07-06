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

| File                   | Category     | What it shows                                                                                                                                                        |
| ---------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `graticule.ts`         | cartographic | A lon/lat graticule — anti-aliased grid lines (screen-constant width via `fwidth`), a gold equator, spinning over `time`.                                            |
| `hillshade.ts`         | cartographic | Shaded relief — a reusable `terrain()` DSL function (called 3× for height + a finite-difference normal), Lambert-lit by a movable sun, hypsometrically tinted.       |
| `color-ramp.ts`        | cartographic | A choropleth colour ramp — a reusable `ramp()` maps a value field through a 5-stop palette, with anti-aliased contour isolines.                                      |
| `shadertoy-plasma.ts`  | generic      | The classic sum-of-sines plasma through an RGB palette — the "hello shader".                                                                                         |
| `voronoi.ts`           | generic      | Animated Voronoi (cellular noise) — a 3×3 neighbour scan shades each fragment by `distance` to its nearest animated feature point; nested `Loop`.                    |
| `julia.ts`             | generic      | Animated Julia set — escape-time fractal (`z ← z² + c`) coloured through a cosine palette; `Loop` + early `Break` + a mutable `var` accumulator.                     |
| `mandelbrot.ts`        | generic      | The Mandelbrot set with SMOOTH escape-time colouring (log₂ log₂ \|z\|² kills the banding), breathing in and out of the seahorse valley.                              |
| `fbm-clouds.ts`        | generic      | fBm clouds — value noise summed over octaves (frequency doubling, amplitude halving), drifting over `time`; helper fns + a `Loop` octave accumulator.                |
| `domain-warp.ts`       | generic      | Domain warping — `fbm(p + w·fbm(p + fbm(p)))` melts lattice noise into marbled flow; the intermediate warp vectors double as colour axes.                            |
| `raymarch-sphere.ts`   | generic      | Raymarched sphere — an SDF sphere-traced from a camera ray then Blinn-Phong shaded; `normalize`/`length`/`dot`, a `Loop` march with early `Break`.                   |
| `raymarch-boxes.ts`    | generic      | Domain repetition — one rounded-box SDF floor-modded into an infinite lattice, flown through forever; a reusable `scene()` fn serves the march AND the 6-tap normal. |
| `tunnel.ts`            | generic      | The demoscene tunnel — polar remap (angle around, 1/radius into the depth) makes a checker fly past forever; `atan2` + fog + a twist control.                        |
| `metaballs.ts`         | generic      | 2D metaballs — inverse-square fields summed per ball, iso-contoured into merging blobs; hue is field-weighted so colours blend where blobs touch.                    |
| `ocean.ts`             | generic      | An ocean horizon — rows below the horizon perspective-divided into a water plane waved by fBm, plus a sun disc and its glitter path.                                 |
| `starfield.ts`         | generic      | A textureless night sky — three hash-grid parallax layers decide per cell whether a star exists, where it sits, and how it twinkles.                                 |
| `truchet.ts`           | generic      | Truchet tiles — two quarter-circle arcs mirrored per cell by a hash bit weave an endless maze; `fwidth`-anti-aliased, energy pulsing along the arcs.                 |
| `kaleidoscope.ts`      | generic      | The kaleidoscope fold — the angle floor-modded into one sector and mirrored, so every sector repeats the same wedge of swirling fbm + rings.                         |
| `heart.ts`             | generic      | The sextic heart curve `(x²+y²−1)³ = x²y³`, sign-filled and `fwidth`-anti-aliased, thumping to a sharpened-sine heartbeat with a beat-synced glow.                   |
| `gradient-pass.ts`     | generic      | A two-colour gradient with a biasable blend + the `If`/`elif` control-flow combinator.                                                                               |
| `compute-reduction.ts` | compute      | A `@workgroup_size` compute kernel folding a window of a storage buffer with `reduce()`. WebGPU-only (GLSL ES 3.00 has no compute), so it emits WGSL + reflection.   |

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
