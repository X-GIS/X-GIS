# TypeShade

[![ci](https://github.com/typeshade/typeshade/actions/workflows/ci.yml/badge.svg)](https://github.com/typeshade/typeshade/actions/workflows/ci.yml)

A TypeScript shader DSL: you author typed value-expressions and imperative statements in
TypeScript, and a single IR emits **WGSL** for WebGPU, **GLSL ES 3.00** for WebGL2, and a
**CPU f64 oracle** that executes the same source in double precision — all from one source.
It is a TSL-style (three.js Shading Language) graph with a real type checker, an optimizer,
a lint pass, and pipeline **reflection**. Zero runtime dependencies. MIT.

TypeShade is a **content-free framework** — it ships the authoring + emit surface under
`core/`, not any application's shaders.

> **Status: pre-release.** `0.1.0` is not published; the npm name **`typeshade`** is reserved
> for it. The manifest and the imports are still named `@xgis/shader-dsl` and are renamed to
> `typeshade` at that tag (`@xgis/shader-dsl` stays as an alias for one major).

## Capability taxonomy (honest)

| Capability                                                                                                                                                         | Standing                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Author** (typed IR, SoT layout declarators, control-flow + value combinators)                                                                                    | **STRONG**                                                                                                                                                                                                                                                                                                          |
| **Type-check** (compile-time `Node<K>` keys; wrong-typed return / field is a TS error)                                                                             | **STRONG**                                                                                                                                                                                                                                                                                                          |
| **Optimize** (CSE, DCE, LICM, const-fold, algebraic, auto-var/auto-let)                                                                                            | STRONG                                                                                                                                                                                                                                                                                                              |
| **Validate / lint** (lint engine + capability gate; coded errors `SD####`, aggregated `validate`, unified `diagnose()`/`formatReport()` + opt-in source locations) | **STRONG**                                                                                                                                                                                                                                                                                                          |
| **CPU-oracle parity** (compile the same module to an f64 CPU fn for cross-checking)                                                                                | **DISTINCTIVE**                                                                                                                                                                                                                                                                                                     |
| **Reflect** (`reflect(module)` → bind-groups + std140/std430 layouts + entry signatures)                                                                           | **mature** — additive and read-only over the IR, so it never runs on the emit path and cannot change an emitted byte. The same reflection that documents a pipeline is what drives a consumer's uniform packing                                                                                                     |
| **WGSL backend**                                                                                                                                                   | real, byte-stable                                                                                                                                                                                                                                                                                                   |
| **GLSL backend**                                                                                                                                                   | **real for render pipelines** — vertex+fragment entry-IO + std140 UBO + MRT draw buffers, compile + render-verified on a real WebGL2 context (see `examples/`); a read-only SSBO lowers to a data texture by default (writes + unsupported shapes fail closed), compute emulation is opt-in, MSAA-load fails closed |
| **fp64** (emulated double precision)                                                                                                                               | real, tiered — df64 hi/lo lowering for `+ - * /`, compare, `abs`, `min`, `max`, `sqrt`, `mix`, `floor`, `fract` and the vector reductions, with a per-device float/integer flavor probe. Transcendentals are NOT emulated: an unsupported op fails closed on `SD0041` rather than silently narrowing                |
| **`semanticDiff`** (compare two modules' meaning)                                                                                                                  | real, and deliberately narrow — interface, resources, constants and the control-flow skeleton. A review aid for an emit change, **not** an equivalence proof: it does not compare expression trees                                                                                                                  |
| **`variantFamily`** (one module, N specialised emits)                                                                                                              | real, in external production use — shared prelude emitted once, per-variant bodies linked against it, with the family validated as a unit                                                                                                                                                                           |
| **Portable compute tier**                                                                                                                                          | real, fail-closed — the gather-only shape (`out[gid.x] = f(reads)`: 1-D `gid`, one `u32` storage output written once at the invocation index) is the subset that lowers to BOTH WebGPU and the WebGL2 emulation; anything outside it is rejected at every emit (`SD0110` / `SD0111`) rather than emitted WGSL-only  |
| **Multi-target** (SPIR-V / MSL / HLSL)                                                                                                                             | **via naga / Tint**, not a third emitter — WGSL is the canonical output and every native host already reaches it through Dawn / wgpu. A hand-written third backend was ruled out deliberately: it triples every parity gate for zero rendering surface                                                              |

## Consume it

The repository root IS the package, so it compiles standing alone as a submodule:

```bash
git submodule add https://github.com/typeshade/typeshade vendor/typeshade
tsc -p vendor/typeshade
```

MEASURED: a fresh clone type-checks with `tsc -p .` to **exit 0**, with **no `node_modules`
anywhere up the tree**. That is the whole point of the layout: every `extends` in this package
terminates INSIDE the package, and nothing tracked here names a path outside it — gated by
[`src/self-contained.test.ts`](./src/self-contained.test.ts).

Two things a consumer must know:

- **It ships TypeScript source.** `main`/`exports` name `./src/*.ts`, so the consuming build
  needs a toolchain that compiles TS (Vite, `tsc`, esbuild, …), and importing the package by
  its bare name under plain Node still resolves to a `.ts` file. Every relative specifier in
  the package carries an explicit `.js`, so the `dist/` that `tsc -p .` produces `import()`s
  under Node's own ESM resolver and its `.d.ts` type-checks under `moduleResolution: nodenext`.
- **Nothing in the package needs `allowImportingTsExtensions`.** `src/` and `examples/` both
  write `./x.js` — the TypeScript ESM convention, where what you write is what tsc emits. The
  package compiles under `moduleResolution: nodenext`, which is what makes a missing extension
  a build error instead of a runtime one.

## Develop

```bash
bun install
bun run build          # tsc --build → dist/ + .d.ts, then a noEmit type-check of tests, examples and scripts
bun run test           # vitest — 146 test files
bun run gate:compile   # every registered example, emitted and compiled by the real compilers
```

`dist/` is a build artifact, not a shipped one — it is gitignored, so a fresh clone does not
contain it.

The compile gate hands every emit to the compiler that would receive it in production: the
**WGSL** to Tint, inside Chromium's headless WebGPU, and both **GLSL ES 3.00** stages to a real
WebGL2 context. It needs playwright's chromium-headless-shell:

```bash
./node_modules/.bin/playwright install --only-shell chromium
```

[`.github/workflows/ci.yml`](./.github/workflows/ci.yml) runs all three on every push and pull
request.

## Usage — author, emit WGSL, and reflect

A ~20-line fullscreen gradient pass that emits WGSL **and** prints its `Reflection`:

```ts
import {
  fn,
  module,
  vec2,
  vec4,
  f32,
  mix,
  f32T,
  u32T,
  vec2fT,
  vec4fT,
  If,
  reflect,
  emitModule,
  ioStruct,
  builtin,
  location,
  uniformStruct,
} from '@xgis/shader-dsl'

const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  { top: vec4fT, bottom: vec4fT, mix_bias: f32T },
)
const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn(
  'vs_full',
  { idx: builtin('vertex_index', u32T) },
  (p) => {
    const pos = vec2(-1, -1)
    If(p.idx.eq(1), () => {
      pos.assign(vec2(3, -1))
    }).elif(p.idx.eq(2), () => {
      pos.assign(vec2(-1, 3))
    })
    return VsOut.construct({
      pos: vec4(pos, 0, 1),
      uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)),
    })
  },
  { stage: 'vertex' },
)

const fs = fn(
  'fs_gradient',
  { in: VsOut.type },
  (p) => {
    const pin = VsOut.of(p.in)
    const rgb = mix(U.field.bottom.rgb, U.field.top.rgb, pin.uv.y.add(U.field.mix_bias))
    return vec4(rgb, f32(1))
  },
  { stage: 'fragment', retAttr: '@location(0)' },
)

const m = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

console.log(emitModule(m)) // WGSL string
console.log(reflect(m)) // pipeline metadata
```

The emitted WGSL:

```wgsl
struct Uniforms {
  top: vec4<f32>,
  bottom: vec4<f32>,
  mix_bias: f32,
}
struct VsOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex
fn vs_full(@builtin(vertex_index) idx: u32) -> VsOut { … }
@fragment
fn fs_gradient(in: VsOut) -> @location(0) vec4<f32> { … }
```

And `reflect(m)` recovers the pipeline metadata the host would otherwise hand-derive —
bind-group entries, the std140 uniform byte layout, and entry-point signatures:

```jsonc
{
  "bindGroups": [
    {
      "group": 0,
      "entries": [
        {
          "group": 0,
          "binding": 0,
          "name": "u",
          "space": "uniform",
          "resourceKind": "uniform-buffer",
          "structName": "Uniforms",
        },
      ],
    },
  ],
  "uniforms": [
    {
      "name": "Uniforms",
      "size": 48,
      "align": 16,
      "fields": [
        { "name": "top", "type": "vec4<f32>", "offset": 0, "align": 16, "size": 16 },
        { "name": "bottom", "type": "vec4<f32>", "offset": 16, "align": 16, "size": 16 },
        { "name": "mix_bias", "type": "f32", "offset": 32, "align": 4, "size": 4 },
      ],
    },
  ],
  "storage": [],
  "entries": [
    { "name": "vs_full", "stage": "vertex", "inputs": ["u32"], "output": "struct:VsOut" },
    {
      "name": "fs_gradient",
      "stage": "fragment",
      "inputs": ["struct:VsOut"],
      "output": "vec4<f32>",
    },
  ],
}
```

`reflect()` is **additive and read-only** over the IR — it never runs on the emit path, so it
cannot change an emitted byte. The std140/std430 offset engine is also exposed standalone as
`wgslLayout(struct, 'std140' | 'std430')`.

## Examples

Runnable, runtime-free shaders live in [`examples/`](./examples) — 36 of them: three
cartographic (graticule, hillshade, choropleth ramp), nineteen generic covering the classic
ShaderToy-era effects (plasma, voronoi, julia, mandelbrot, fBm clouds, domain warping,
raymarched sphere, raymarched box field, tunnel, metaballs, ocean, starfield, truchet,
kaleidoscope, beating heart, gradient, discard cutout, override quality, texture-array LOD),
thirteen exercising the df64 emulated-double tier (deep zoom, RTC, Loran, Mercator tiles,
the fractal set at f64, cancellation and a sine sweep), and one compute kernel. Each emits
WGSL + GLSL ES 3.00 + reflection from one source:

```bash
npx tsx examples/print.ts            # print WGSL / GLSL / reflection for every example
npx tsx examples/print.ts hillshade  # just one, by id
```

The renderable ones are exported from `examples/index.ts`, so a host page can mount them on
either backend — WebGL2 by default, WebGPU wherever an adapter is reachable. See
[`examples/README.md`](./examples/README.md).

## Authoring guide

See [`AUTHORING.md`](./AUTHORING.md) for the full authoring surface (`fn` / `module`,
the SoT layout declarators, control flow, value combinators) and the reflection surface.

## Contributing

Issues are welcome here. Until the move of development into this repository completes, changes
still land [upstream](https://github.com/X-GIS/X-GIS/tree/main/shader-dsl) and this tree is
fast-forwarded from there; a pull request opened here cannot be merged yet.

## License

MIT — see [`LICENSE`](./LICENSE).
