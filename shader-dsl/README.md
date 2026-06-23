# `@xgis/shader-dsl`

A TypeScript shader DSL: you author typed value-expressions and imperative statements
in TypeScript, and a single IR emits **WGSL** for the GPU plus a **CPU f64 oracle** for
parity checks — from the same source. It is a TSL-style (three.js Shading Language) graph
with a real type checker, an optimizer, a lint pass, and now pipeline **reflection**.

`@xgis/shader-dsl` is a **content-free framework** — it ships the authoring + emit surface
under `core/`, not any application's shaders. (X-GIS's own shaders author *through* this
package like any other consumer.)

> `private: true` — build-to-tarball only; this package is **not** published to npm.

## Capability taxonomy (honest)

| Capability | Standing |
|---|---|
| **Author** (typed IR, SoT layout declarators, control-flow + value combinators) | **STRONG** |
| **Type-check** (compile-time `Node<K>` keys; wrong-typed return / field is a TS error) | **STRONG** |
| **Optimize** (CSE, DCE, LICM, const-fold, algebraic, auto-var/auto-let) | STRONG |
| **Validate / lint** (20-rule lint engine + capability gate) | **STRONG** |
| **CPU-oracle parity** (compile the same module to an f64 CPU fn for cross-checking) | **DISTINCTIVE** |
| **Reflect** (`reflect(module)` → bind-groups + std140/std430 layouts + entry signatures) | **NEW** |
| **WGSL backend** | real, byte-stable |
| **GLSL backend** | **real for render pipelines** — vertex+fragment entry-IO + std140 UBO, WebGL2 compile+render-verified (see `examples/`); compute/SSBO/MSAA-load fail closed |
| **Multi-target** (SPIR-V / MSL / HLSL) | **aspirational** — mono-target (WGSL) but credible for v1 |

## Install / build

This is a workspace package (build-to-tarball, not published):

```bash
bun install
bun run build          # tsc --build → dist/ + .d.ts
npm pack               # → xgis-shader-dsl-0.0.1.tgz (ships dist/ only)
```

Consume it from the built artifact:

```ts
import { fn, module, emitModule, reflect } from '@xgis/shader-dsl'
```

## Usage — author, emit WGSL, and reflect

A ~20-line fullscreen gradient pass that emits WGSL **and** prints its `Reflection`:

```ts
import {
  fn, module, vec2, vec4, f32, mix,
  f32T, u32T, vec2fT, vec4fT,
  If, reflect, emitModule,
  ioStruct, builtin, location, uniformStruct,
} from '@xgis/shader-dsl'

const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' },
  { top: vec4fT, bottom: vec4fT, mix_bias: f32T })
const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT) })

const vs = fn('vs_full', { idx: builtin('vertex_index', u32T) }, (p) => {
  const pos = vec2(-1, -1)
  If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
    .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
  return VsOut.construct({ pos: vec4(pos, 0, 1), uv: vec2(pos.x.add(1).mul(0.5), pos.y.add(1).mul(0.5)) })
}, { stage: 'vertex' })

const fs = fn('fs_gradient', { in: VsOut.type }, (p) => {
  const pin = VsOut.of(p.in)
  const rgb = mix(U.field.bottom.swizzle<'vec3<f32>'>('rgb'), U.field.top.swizzle<'vec3<f32>'>('rgb'),
    pin.uv.y.add(U.field.mix_bias))
  return vec4(rgb, f32(1))
}, { stage: 'fragment', retAttr: '@location(0)' })

const m = module({ structs: [U.struct, VsOut.decl], bindings: [U.binding], funcs: [vs, fs] })

console.log(emitModule(m))                       // WGSL string
console.log(reflect(m))                           // pipeline metadata
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
    { "group": 0, "entries": [
      { "group": 0, "binding": 0, "name": "u", "space": "uniform",
        "resourceKind": "uniform-buffer", "structName": "Uniforms" }
    ]}
  ],
  "uniforms": [
    { "name": "Uniforms", "size": 48, "align": 16, "fields": [
      { "name": "top",      "type": "vec4<f32>", "offset": 0,  "align": 16, "size": 16 },
      { "name": "bottom",   "type": "vec4<f32>", "offset": 16, "align": 16, "size": 16 },
      { "name": "mix_bias", "type": "f32",       "offset": 32, "align": 4,  "size": 4  }
    ]}
  ],
  "storage": [],
  "entries": [
    { "name": "vs_full",     "stage": "vertex",   "inputs": ["u32"],       "output": "struct:VsOut" },
    { "name": "fs_gradient", "stage": "fragment", "inputs": ["struct:VsOut"], "output": "vec4<f32>" }
  ]
}
```

`reflect()` is **additive and read-only** over the IR — it never runs on the emit path, so it
cannot change an emitted byte. The std140/std430 offset engine is also exposed standalone as
`wgslLayout(struct, 'std140' | 'std430')`.

## Examples

Runnable, runtime-free shaders live in [`examples/`](./examples) — three cartographic
(graticule, hillshade, choropleth ramp), two generic (plasma, gradient), and one compute
kernel. Each emits WGSL + GLSL ES 3.00 + reflection from one source:

```bash
npx tsx examples/print.ts            # print WGSL / GLSL / reflection for every example
npx tsx examples/print.ts hillshade  # just one, by id
```

The renderable ones run live on a WebGL2 canvas on the **/shader-dsl** site page (they are
exported from `examples/index.ts`, which the page imports). See [`examples/README.md`](./examples/README.md).

## Authoring guide

See [`AUTHORING.md`](./AUTHORING.md) for the full authoring surface (`fn` / `module`,
the SoT layout declarators, control flow, value combinators) and the reflection surface.
