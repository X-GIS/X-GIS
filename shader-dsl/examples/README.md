# `@xgis/shader-dsl` examples

Self-contained shaders authored with the DSL. Each builds a `module`, and from that single
source emits **WGSL** (WebGPU) + **GLSL ES 3.00** (WebGL2) + the `reflect()` pipeline metadata —
with **no dependency on the X-GIS runtime**. They import only from the package's own source
(`../src/index.ts`), so they run straight from a checkout.

Every example is also exported (`module` + metadata) from [`index.ts`](./index.ts), so the same
sources power the interactive **/shader-dsl** site page (which renders the renderable ones live
on a WebGL2 canvas) and the CLI printer.

| File | Category | What it shows |
|---|---|---|
| `graticule.ts` | cartographic | A lon/lat graticule — anti-aliased grid lines (screen-constant width via `fwidth`), a gold equator, spinning over `time`. |
| `hillshade.ts` | cartographic | Shaded relief — a reusable `terrain()` DSL function (called 3× for height + a finite-difference normal), Lambert-lit by a movable sun, hypsometrically tinted. |
| `color-ramp.ts` | cartographic | A choropleth colour ramp — a reusable `ramp()` maps a value field through a 5-stop palette, with anti-aliased contour isolines. |
| `shadertoy-plasma.ts` | generic | The classic sum-of-sines plasma through an RGB palette — the "hello shader". |
| `voronoi.ts` | generic | Animated Voronoi (cellular noise) — a 3×3 neighbour scan shades each fragment by `distance` to its nearest animated feature point; nested `Loop`. |
| `julia.ts` | generic | Animated Julia set — escape-time fractal (`z ← z² + c`) coloured through a cosine palette; `Loop` + early `Break` + a mutable `var` accumulator. |
| `fbm-clouds.ts` | generic | fBm clouds — value noise summed over octaves (frequency doubling, amplitude halving), drifting over `time`; helper fns + a `Loop` octave accumulator. |
| `raymarch-sphere.ts` | generic | Raymarched sphere — an SDF sphere-traced from a camera ray then Blinn-Phong shaded; `normalize`/`length`/`dot`, a `Loop` march with early `Break`. |
| `gradient-pass.ts` | generic | A two-colour gradient with a biasable blend + the `If`/`elif` control-flow combinator. |
| `compute-reduction.ts` | compute | A `@workgroup_size` compute kernel folding a window of a storage buffer with `reduce()`. WebGPU-only (GLSL ES 3.00 has no compute), so it emits WGSL + reflection. |

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
