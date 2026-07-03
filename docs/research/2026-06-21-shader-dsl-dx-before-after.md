# `@xgis/shader-dsl` — developer experience: how the code actually looks (before → after)

Companion to `2026-06-21-shader-dsl-backend-agnostic-redesign.md`. This is the part that matters to
the person _using_ the DSL: what you type to author a shader, what you call to get a target, and how
it feels when something can't run on your backend. Every "before" snippet is real current code.

---

## A. Authoring a shared math function

### Before (today — real, `shaders/log-depth.ts`)

```ts
import { fn, f32, vec4, max, log2, f32T, vec4fT } from '../core/ir'
import { emitFunc } from '../core/backends/wgsl'            // ← reaches into the WGSL backend

const apply_log_depth = fn('apply_log_depth', { pos: vec4fT, fc: f32T }, vec4fT, (b, { pos, fc }) => {
  const z = b.let('z', log2(max(f32(1e-6), pos.w.add(1))).mul(fc).mul(pos.w))
  b.ret(vec4(pos.x, pos.y, z, pos.w))
})

// single target, hand-assembled, WGSL baked into the export NAME:
export const LOG_DEPTH_WGSL_FNS = `${[apply_log_depth, ...].map(emitFunc).join('\n\n')}\n`
```

**Pain:** the author imports `emitFunc` from the _WGSL backend_ and string-concats; the export is
literally named `*_WGSL_*`. There is no "give me GLSL" — you'd hand-write a parallel `*_GLSL_*`. And
the type parameters that flow through (`Node<'vec4<f32>'>` in `node.ts:141`) spell WGSL.

### After

```ts
import { fn, f32, vec4, max, log2 } from '@xgis/shader-dsl'
import { F32, Vec4f } from '@xgis/shader-dsl/types'         // ← neutral aliases, no '<f32>' spelling

const applyLogDepth = fn('apply_log_depth', { pos: Vec4f, fc: F32 }, Vec4f, (b, { pos, fc }) => {
  const z = b.let('z', log2(max(f32(1e-6), pos.w.add(1))).mul(fc).mul(pos.w))   // identical body
  b.ret(vec4(pos.x, pos.y, z, pos.w))
})

export const logDepth = module({ funcs: [applyLogDepth, ...] })   // a target-NEUTRAL artifact
```

The body is unchanged (the math layer was always fine). What changes: you export a **neutral
module**, not a WGSL string. Targets come from the consumer (§C). No backend import at author time.

---

## B. Authoring a render shader — entry points & bindings

This is where WGSL leaks most today: IO and resources are **raw WGSL attribute strings**.

### Before (today — the shape in `polygon.ts` / `point.ts`)

```ts
// IO carried as WGSL syntax strings; bindings hardcode @group/@binding:
{ name: 'pos', type: vec4fT, attr: '@builtin(position)' }
{ name: 'uv',  type: vec2fT, attr: '@location(0) @interpolate(flat)' }
bindingRef('feat_data', { space: 'storage', access: 'read', group: 0, binding: 3 })
```

### After

```ts
import { entry, Stage, builtin, location, flat } from '@xgis/shader-dsl'

const vsPolygon = entry(
  'vs_polygon',
  Stage.Vertex,
  {
    inputs: [location(0, 'q_xy', Vec4u)],
    outputs: [builtin('position', Vec4f), location(0, 'uv', Vec2f, { interp: flat })],
  },
  (b, io) => {
    /* … */
  },
)

// resources are LOGICAL — a string tag, the slot is assigned by the backend:
const featData = featureBuffer('feat_data', F32, { group: 'per-tile' })
const v = featData.at(i) // unchanged accessor — the lowering differs per backend
```

You describe _intent_ (`builtin('position')`, `location(0)`, `featureBuffer`), never WGSL syntax. The
WGSL backend renders `@builtin(position)` / `@group(0) @binding(3)`; the GLSL backend renders
`gl_Position` / a `std140` UBO or a data-texture — and you wrote it **once**.

---

## C. Consuming — one source, any target

### Before (today)

```ts
// runtime/src/engine/render/vector-tile-renderer.ts
const code = emitPolygonWgsl(variant, pickEnabled) // WGSL-only, name says so
device.createShaderModule({ code })
```

### After

```ts
import { compile, wgsl, glslES300 } from '@xgis/shader-dsl'

const out = compile(polygon, wgsl) // → { code: string, layout: LayoutPlan, caps }
device.createShaderModule({ code: out.code })
// LayoutPlan is the SINGLE source binding writeBuffer offsets ↔ the shader struct:
device.queue.writeBuffer(buf, out.layout.offsetOf('fill_color'), rgba)

// same authored graph, different target — no parallel shader to maintain:
const gl = compile(raster, glslES300) // → '#version 300 es …'
webgl2.shaderSource(fragShader, gl.code)
```

One module → WGSL **or** GLSL. The `LayoutPlan` kills the repo's #1 bug class (the 256-byte
`Uniforms` offsets and the `writeBuffer` calls now read from one object instead of two hand-synced
sites).

---

## D. The payoff, concretely — one source → two targets

Authoring (once):

```ts
const toLinear = fn('to_linear', { c: Vec3f }, Vec3f, (b, { c }) => b.ret(pow(c, vec3(f32(2.2)))))
```

`compile(mod, wgsl)`:

```wgsl
fn to_linear(c: vec3<f32>) -> vec3<f32> { return pow(c, vec3<f32>(2.2)); }
```

`compile(mod, glslES300)`:

```glsl
vec3 to_linear(vec3 c) { return pow(c, vec3(2.2)); }
```

Same graph; the writer owns `vec3<f32>`↔`vec3`. For an intrinsic that differs, the registry handles
it — author writes `cond.select(a, b)` once and gets WGSL `select(b, a, cond)` vs GLSL `(cond ? a : b)`.

---

## E. Error ergonomics — capability honesty (the thing that makes it trustworthy)

A user targeting WebGL2 with a shader that needs compute/storage must get a **clear, early** answer —
never a silently-wrong shader.

```ts
const out = compile(continentMatch, glslES300)
// throws, at compile time, before any GPU call:
//   UnsupportedFeatureError: shader 'continent_match' requires { compute, storageBuffer }
//     not supported by backend 'glsl-es300'.
//     • compute kernel  @ compute-match.ts          → needs WebGPU, or a transform-feedback rewrite
//     • storage read   `feat_data: array<f32>`      → needs WebGPU, or the data-texture path (R5)
//   Backends that support this shader: ['wgsl']
```

…and the capability is _queryable_ so a renderer can pick a path instead of crashing:

```ts
if (glslES300.caps.covers(polygon.requires)) useWebGL2(compile(polygon, glslES300))
else useWebGPU(compile(polygon, wgsl))
```

And the CPU oracle is reachable the same uniform way (for parity tests / headless math):

```ts
const f = evalCpu(projections) // f.project(lon, lat, …) → exact f64
```

---

## F. Why this is "good to use" (the scorecard)

| Dimension                        | Before                                                                                      | After                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Author a shader                  | typed graph, but spells `Node<'vec4<f32>'>`, imports the WGSL backend, hand-concats strings | typed graph, neutral aliases (`Vec4f`), exports a neutral `module`   |
| IO / bindings                    | raw WGSL attribute strings, hardcoded `@group/@binding`                                     | `builtin()/location()/featureBuffer()` intent; backend assigns slots |
| Get a target                     | `emitPolygonWgsl()` — WGSL only                                                             | `compile(mod, wgsl                                                   | glslES300)` — one source, any target |
| Buffer ↔ shader sync             | offsets split across VTR constants + struct order (drift = bugs)                            | one `LayoutPlan` SoT                                                 |
| WebGL2 honesty                   | n/a (no GLSL)                                                                               | typed `UnsupportedFeatureError` + queryable `caps.covers()`          |
| Math correctness                 | CPU oracle exists                                                                           | unchanged — same oracle, now reachable via `evalCpu()`               |
| Adding a 3rd target (SPIR-V/MSL) | rewrite a parallel emitter                                                                  | implement one `Backend`                                              |

**Net:** the author writes plainer, target-free TypeScript; the consumer makes one `compile()` call
and either gets valid code for their backend or a precise reason why not. That is the difference
between "a WGSL generator" and "a shader IR you'd put your name on."

---

## G. Honest caveats (so the UX promise is real)

- The nice `compile(mod, glslES300)` returns valid code **only for what WebGL2 can do** (T0/T1
  shaders today; T2 after the R5 data-texture work). For T3 (compute/MSAA) it raises §E — by design.
- `Vec4f`-style aliases + neutral `KeyOf` is the one change that touches the compile-time safety gate
  (R1) — it must land atomically. Everything else (registry, structured IO, `compile()`) is additive.
- The emitted WGSL is **byte-identical** to today through R1–R3, so existing renders never move while
  the API gets nicer.
