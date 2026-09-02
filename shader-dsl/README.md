# `@xgis/shader-dsl`

A TypeScript shader DSL: you author typed value-expressions and imperative statements
in TypeScript, and a single IR emits **WGSL** for the GPU plus a **CPU f64 oracle** for
parity checks — from the same source. It is a TSL-style (three.js Shading Language) graph
with a real type checker, an optimizer, a lint pass, and now pipeline **reflection**.

`@xgis/shader-dsl` is a **content-free framework** — it ships the authoring + emit surface
under `core/`, not any application's shaders. (X-GIS's own shaders author _through_ this
package like any other consumer.)

> **Distribution: a git submodule, not npm** (#1681 C). This package is **not published to
> npm**. `git subtree split --prefix=shader-dsl` re-roots this directory as a standalone
> MIRROR repository, and the consuming project takes that mirror as a submodule
> (`.github/workflows/mirror-shader-dsl.yml` pushes it on every merge to `main` that touches
> this package). The
> monorepo stays authoritative; the mirror is **read-only** and fixes flow back through
> X-GIS. There is consequently no version policy, no tag convention and no release script —
> the `version` field is not a release.

## Capability taxonomy (honest)

| Capability                                                                                                                                                         | Standing                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Author** (typed IR, SoT layout declarators, control-flow + value combinators)                                                                                    | **STRONG**                                                                                                                                                                                                                                                                                                                  |
| **Type-check** (compile-time `Node<K>` keys; wrong-typed return / field is a TS error)                                                                             | **STRONG**                                                                                                                                                                                                                                                                                                                  |
| **Optimize** (CSE, DCE, LICM, const-fold, algebraic, auto-var/auto-let)                                                                                            | STRONG                                                                                                                                                                                                                                                                                                                      |
| **Validate / lint** (lint engine + capability gate; coded errors `SD####`, aggregated `validate`, unified `diagnose()`/`formatReport()` + opt-in source locations) | **STRONG**                                                                                                                                                                                                                                                                                                                  |
| **CPU-oracle parity** (compile the same module to an f64 CPU fn for cross-checking)                                                                                | **DISTINCTIVE**                                                                                                                                                                                                                                                                                                             |
| **Reflect** (`reflect(module)` → bind-groups + std140/std430 layouts + entry signatures)                                                                           | **mature** — 13 direct callers across four packages: the six `*-uniform-slots` modules and `point-renderer` in `map/`, `variantFamily` / `semanticDiff` / `emitModuleWithReflection` here, plus the playground thumbnail capture and the site example lib                                                                   |
| **WGSL backend**                                                                                                                                                   | real, byte-stable                                                                                                                                                                                                                                                                                                           |
| **GLSL backend**                                                                                                                                                   | **real for render pipelines** — vertex+fragment entry-IO + std140 UBO + MRT draw buffers, WebGL2 compile+render-verified (see `examples/`, #847); a read-only SSBO lowers to a data texture by default (writes + unsupported shapes fail closed), compute emulation is opt-in, MSAA-load fails closed                       |
| **fp64** (emulated double precision)                                                                                                                               | real, tiered — df64 hi/lo lowering for `+ - * /`, compare, `abs`, `min`, `max`, `sqrt`, `mix`, `floor`, `fract` and the vector reductions, with a per-device float/integer flavor probe. Transcendentals are NOT emulated: an unsupported op fails closed on `SD0041` rather than silently narrowing                        |
| **`semanticDiff`** (compare two modules' meaning)                                                                                                                  | real, and deliberately narrow — interface, resources, constants and the control-flow skeleton. A review aid for an emit change, **not** an equivalence proof: it does not compare expression trees                                                                                                                          |
| **`variantFamily`** (one module, N specialised emits)                                                                                                              | real, in external production use — shared prelude emitted once, per-variant bodies linked against it, with the family validated as a unit                                                                                                                                                                                   |
| **Portable compute tier**                                                                                                                                          | real, fail-closed — the gather-only shape (`out[gid.x] = f(reads)`: 1-D `gid`, one `u32` storage output written once at the invocation index) is the subset that lowers to BOTH WebGPU and the WebGL2 emulation; anything outside it is rejected at every emit (`SD0110` / `SD0111`) rather than emitted WGSL-only          |
| **Multi-target** (SPIR-V / MSL / HLSL)                                                                                                                             | **via naga / Tint**, not a third emitter — WGSL is the canonical output and every native host already reaches it through Dawn / wgpu. A hand-written third backend was ruled out deliberately: it triples every parity gate for zero rendering surface (see `docs/plans/2026-09-01-shader-dsl-improvement-direction.md` §5) |

## Install / build

Inside this monorepo:

```bash
bun install
bun run build          # tsc --build → dist/ + .d.ts, then a noEmit type-check of tests + examples
```

`dist/` is a build artifact, not a shipped one — it is gitignored, so neither a fresh clone nor
the mirror contains it. The monorepo resolves `@xgis/shader-dsl` through the `exports` map to
**source** (`./src/*.ts`):

```ts
import { fn, module, emitModule, reflect } from '@xgis/shader-dsl'
```

### Consuming it outside the monorepo

Take the mirror repository (see the note at the top) as a submodule; its root IS this
directory, so it compiles standing alone:

```bash
git submodule add <mirror-url> vendor/shader-dsl
tsc -p vendor/shader-dsl
```

MEASURED (#1681 C): a fresh clone of the mirror type-checks with `tsc -p .` to **exit 0**,
emitting 82 JS files, with **no `node_modules` anywhere up the tree**.

That is the whole point of the layout: every `extends` in this package terminates INSIDE the
package (#1681 B1), and nothing tracked under `shader-dsl/` names a path outside it — gated by
[`src/self-contained.test.ts`](./src/self-contained.test.ts).

Two things a consumer must know:

- **It ships TypeScript source.** `main`/`exports` name `./src/*.ts`, so the consuming build
  needs a toolchain that compiles TS (Vite, `tsc`, esbuild, …), and importing the package by
  its bare name under plain Node still resolves to a `.ts` file. What changed with #1686 is
  the BUILD: every relative specifier in the package now carries an explicit `.js`, so the
  `dist/` that `tsc -p .` produces `import()`s under Node's own ESM resolver and its `.d.ts`
  type-checks under `moduleResolution: nodenext`. Whether `exports` should point there is a
  separate decision (#1686 step 5). The monorepo gate for it is
  `scripts/shader-dsl-node-smoke.mjs` (outside this package, so the mirror does not carry it).
- **Nothing in the package needs `allowImportingTsExtensions`.** `src/` and `examples/` both
  write `./x.js` — the TypeScript ESM convention, where what you write is what tsc emits. The
  package compiles under `moduleResolution: nodenext`, which is what makes a missing extension
  a build error instead of a runtime one.

The mirror is **read-only**: fix things here, in X-GIS, and the next merge fast-forwards it.
`CHANGELOG.md` is generated from git history by the root `bun run changelog`.

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

The renderable ones run live on the **/shader-dsl** site page, which mounts either backend
behind a toggle — WebGL2 by default, WebGPU wherever an adapter is reachable (they are
exported from `examples/index.ts`, which the page imports). See [`examples/README.md`](./examples/README.md).

## Authoring guide

See [`AUTHORING.md`](./AUTHORING.md) for the full authoring surface (`fn` / `module`,
the SoT layout declarators, control flow, value combinators) and the reflection surface.
