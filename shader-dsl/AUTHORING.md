# Authoring shaders with `@xgis/shader-dsl`

This is the developer guide for **writing** a shader in `@xgis/shader-dsl`. The DSL is a
TSL-style (three.js Shading Language) graph: you author typed value expressions and
imperative statements in TypeScript, and one IR emits both **WGSL** (GPU) and a **CPU
oracle** (parity checks) from the same source.

The goal of the recent work was to remove ceremony. You no longer hand-write WGSL var
names, return-type tokens, `callFn('name', …)` strings, `.field('name', type)` accessors,
or `f32()` wrappers around literals. This guide documents the surface that landed.

> **Import paths.** Shader modules live in `shader-dsl/src/shaders/*.ts` and author from
> two internal entry points:
> ```ts
> import { fn, module, vec4, If, Switch, condExpr, … } from '../core/ir'
> import { ioStruct, uniformStruct, structDecl, builtin, location, storageBuffer, resource } from '../core/sot'
> ```
> The package's public barrel (`src/index.ts`) re-exports only the finished shader graphs;
> the authoring layer is internal. Always import the IR via the `core/ir` barrel, never a
> deep file.

---

## 1. The authoring surface

### `fn` — every function (and every entry point)

`fn` authors **all** functions: plain helpers and `@vertex` / `@fragment` / `@compute`
entry points. There is no separate `entryFn` / `computeFn`.

```ts
fn(name?, params, ret?, body, opts?)
```

- **`name`** — optional. Omit it for an auto `_fn{n}` name. Keep an explicit name for any
  fn referenced by a *string* (an `externFn`, a placeholder-swap lookup) or compared in a
  byte-identical snapshot.
- **`params`** — a record `{ paramName: ShaderType }`. Entry points use `builtin(...)` /
  `location(...)` specs in the same record (see below).
- **`ret`** — optional. **Omit it and the return type is inferred** from the value the body
  returns. Pass an explicit `ShaderType` only when you want to pin it.
- **`body`** — `(p, b?) => Node | void`. The body receives the typed **param Nodes first**
  (`p.lon`, `p.uv`, …), and an optional `Builder` `b` second (rarely needed — the ambient
  `If` / `Let` / `Var` / `Return` surface covers most bodies).
- **`opts`** — `{ stage, workgroupSize?, retAttr?, allowEarlyReturn?, lintDisable? }`.

The body's native `return value` is type-checked against the return type, so a wrong-typed
return is a compile error.

```ts
// Helper: return type inferred as f32 from `return select(...)`.
export const dist_to_segment = fn('dist_to_segment',
  { p: vec2fT, a: vec2fT, b: vec2fT },
  ({ p, a, b }) => {
    const ab = b.sub(a)
    const len2 = dot(ab, ab)
    const t = clamp(dot(p.sub(a), ab).div(max(len2, 1e-10)), 0, 1)
    const segDist = length(p.sub(a).sub(ab.mul(t)))
    return select(len2.lt(1e-10), length(p.sub(a)), segDist)
  })
```

A function authored with `fn()` is an **`FnHandle`**: it is both the **callable** and the
function declaration. Call it directly — `dist_to_segment(uv, p0, p1)` — and list it in a
module's `funcs:` array. There is no `callFn('dist_to_segment', …)`.

#### Entry points — `opts.stage` + `builtin()` / `location()` params

An entry point is just a `fn` with `opts.stage`. Stage-attributed params (`@builtin(...)`,
`@location(...)`) go in the same param record using the **same** `builtin()` / `location()`
helpers the IO structs use:

```ts
const vs = fn('vs_tile', { vid: builtin('vertex_index', u32T) }, (p) => {
  // …compute clip position…
  return VsOut.construct({ pos: …, uv: …, vis: f32(1), view_w: clip.w })
}, { stage: 'vertex' })

const cs = fn('cs_match', { gid: builtin('global_invocation_id', vec3uT) }, (p) => {
  // …
}, { stage: 'compute', workgroupSize: 64 })
```

- `stage: 'compute'` emits `@compute @workgroup_size(N)` (`workgroupSize` defaults to 64).
- `retAttr` attaches an attribute to a bare (non-struct) stage return, e.g.
  `-> @location(0) vec4<f32>`. A struct return carries its attributes in the struct.

### `module` — assemble the WGSL module

```ts
module({ consts, structs, bindings, funcs })
```

Each field is an array; any omitted field defaults to `[]`. Order in `funcs:` is the WGSL
emit order, so **callees come before callers** (WGSL requires forward declaration order):

```ts
export const buildRasterModule = (pickEnabled: boolean): ModuleDecl => module({
  consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
  structs: [U.struct, Tile.struct, VsOut.decl, rasterFragmentOutput(pickEnabled).decl],
  bindings: [U.binding, tex.binding, texSampler.binding, Tile.binding],
  funcs: [
    ...getGpuProjectionFuncs(), ...ECEF_FUNCS, ...RASTER_COLOR_FUNCS,
    apply_log_depth, compute_log_frag_depth,
    vs, buildFs(pickEnabled),
  ],
})
```

---

## 2. Values and mutation

### Plain `const` — let the emit decide `let` / `var` / inline

Author every intermediate as a plain JS `const`. You do **not** wrap it in `Let(...)` or
`Var(...)`:

```ts
const ab = b.sub(a)
const len2 = dot(ab, ab)
```

The emit pass decides whether each becomes an inlined expression, a shared WGSL `let`
(common-subexpression cache), or a `var`. If you later **mutate** a `const` (see `.assign`
below), the **auto-var pass** materialises it as a WGSL `var` automatically — no marker
needed:

```ts
const min_dist = f32(1e10)     // plain const…
// …later, inside a loop…
min_dist.assign(min(min_dist, d))   // …auto-materialises as `var`
```

`Let(...)` / `Var(...)` still exist for the rare case where you need to *force* a named
binding (a derivative like `fwidth` that WGSL requires in uniform control flow, or a
mutable accumulator you want to name), but the default is a plain `const`.

### `.assign(v)` — the one mutation method

JS cannot overload `=`, so mutation is a method on the lvalue Node (mirrors three.js TSL's
`.assign`):

```ts
x.assign(value)            // x = value;
winding.assign(winding.add(1))   // compound = the pure op + assign; there is no addAssign
o.pos.assign(vec4(pos, 0, 1))    // member targets work too
```

There is **no** free `assign(x, v)` function in the authoring surface — `.assign` is a
method on the target Node. There is **no** compound `addAssign` either: `add` is the pure
expression, so `x += v` is `x.assign(x.add(v))`.

### Method ops + contextual literal lift

Arithmetic, comparison, bitwise, swizzle, and index are **methods** on a Node:

| category | methods |
|---|---|
| arithmetic | `.add .sub .mul .div .mod .neg` |
| comparison | `.lt .gt .le .ge .eq .ne` |
| logical | `.and .or` |
| bitwise | `.bitAnd .bitOr .bitXor .shl .shr` |
| components | `.x .y .z .w` · `.r .g .b .a` · `.rgb .xy .xyz …` · `.swizzle<R>('zxy')` |
| index | `.at(i, elemType)` |
| ternary | `cond.select(a, b)` (WGSL `select`) |

**A bare number literal lifts to the operand's type from context** — drop the `f32()` /
`u32()` / `i32()` wrapper:

```ts
x.add(1)            // f32 x → `x + 1.0`
flags.bitAnd(1)     // u32 flags → `flags & 1u`   (typed from the LHS)
mode.eq(2)          // u32 → `mode == 2u`
vec4(pos, 0, 1)     // numeric components lift to the vec's element (f32)
vec2u(0, 1)         // → u32 components
```

The same lift applies inside vector/struct constructors (`vec2/vec3/vec4/vec2u/vec2i`,
`construct`) and inside `min/max/clamp/mix/pow/smoothstep`. You only keep an explicit
`f32(0.5)` / `u32(16)` when there is **no** context to infer from (a standalone constant or
the type-anchor first arg of a math built-in).

### `radians()` / `degrees()`

Use the WGSL built-ins for degree↔radian conversion, not a multiply by a rounded constant:

```ts
const lonRad = radians(lon)     // was: lon.mul(DEG2RAD)
const latDeg = degrees(latRad)  // was: latRad.div(DEG2RAD)
```

(`DEG2RAD` survives only as the `(DEG2RAD·EARTH_R)` divisor in the abs-Mercator → degree
reverse paths, where folding it out would shift precision.)

---

## 3. Control flow

### `If / elif / else` — statements

```ts
If(pin.vis.lt(0), () => { Discard() })

If(p.idx.eq(1), () => { pos.assign(vec2(3, -1)) })
  .elif(p.idx.eq(2), () => { pos.assign(vec2(-1, 3)) })
  .else(() => { /* … */ })
```

`If` / `elif` / `else` bodies are zero-arg closures `() => …` that author into the
**innermost** active scope (no `Builder` is threaded). They are **statements** — a body
should not "return" a value as a fall-through; for early exits use `Return()` / `ReturnIf()`.

### `Switch` — statement dispatch

A chainable builder mirroring the `If` chain. For value dispatch, forward-declare a `Var`
and assign it in the case arms (the familiar imperative form):

```ts
const radiusPx = Var(rawRadius)
Switch(sizeMode)
  .case(1, () => radiusPx.assign(rawRadius.div(viewport.z)))
  .case(2, () => radiusPx.assign(…))
  .default(() => {})        // default is optional but terminates the chain
```

```ts
Switch(seg.kind)
  .case(0, () => {
    min_dist.assign(min(min_dist, dist_to_segment(uv, seg.p0, seg.p1)))
    winding.assign(winding.add(winding_line(uv, seg.p0, seg.p1)))
  })
  .case(1, () => { … })
  .default(() => {})
```

### Value combinators — `ifExpr` / `condExpr` / `reduce`

When you want a branch-**initialised value** instead of a mutation, use the value
combinators. They take **only values** — no var name, no type token (the type is inferred
from the arms):

```ts
// 2-arm if-expression
const dir = ifExpr(segLen.lt(1e-6), () => vec2(1, 0), () => segVec.div(segLen))

// N-arm: array of [condition, () => value] arms, then the else value
const clip = condExpr([
  [projParams.x.lt(0.5), () => transformMat4(mvp, vec4(rel2d, 0, 1))],
  [projParams.x.lt(6.5), () => transformMat4(mvp, vec4(relG, 0, 1))],
], () => transformMat4(mvp, vec4(ecefRtc, 1)))

// loop fold — body RETURNS the next accumulator (no Var + assign at the call site)
const best = reduce(f32(1e10), u32(0), (i) => i.le(STEPS), (acc, i) => {
  const q = bezierPoint(i)
  return min(acc, length(p.sub(q)))
}, u32(1))
```

`condExpr`/`ifExpr`/`reduce` materialise the var + control flow internally and return the
result Node, so the emit is identical to the hand-written `var v; if (…) v = …` form. Use
`condExpr` for genuine **condition/range** dispatch (no single scrutinee); use `Switch` for
integer **scrutinee** dispatch.

### Early returns — `Return` / `ReturnIf`

A control-flow body never captures a native `return value` as an early exit (that would
read as a silent fall-through). Make early returns explicit:

```ts
Return(value)                  // return value;
ReturnIf(winding.ne(0), f32(1).sub(min_dist))   // if (winding != 0) { return …; }
```

A `fn` body's **final** `return value` is native TS (the body's terminal `return`) — that
one is fine and is type-checked. `Return()` / `ReturnIf()` are for early exits inside
`If` / `Loop` / `Switch`. (`fn` with an early `Return` needs `opts.allowEarlyReturn`.)

`Loop(init, cond, body, step?)` is the C-style for loop; `Continue()` / `Break()` /
`Discard()` are the loop/fragment terminators.

---

## 4. SoT helpers — declare a layout once

A vertex/uniform layout used to be hand-written in up to four places (struct decl, binding
decl, binding ref node, every field access) that had to agree by hand — the source of the
polygon slot-drift bug family. The SoT (single-source-of-truth) helpers declare a layout
**once** and derive the rest, with the type checker covering field names and types.

### IO structs — `ioStruct`

```ts
const VsOut = ioStruct('VsOut', {
  pos: builtin('position', vec4fT),
  uv: location(0, vec2fT),
  vis: location(1, f32T),
  view_w: location(2, f32T),
})
```

- **`builtin(name, type)`** → a `@builtin(<name>)` field.
- **`location(n, type, interpolate?)`** → a `@location(n)` field, optionally
  `@interpolate(flat)`.
- **`VsOut.type`** — the struct's `ShaderType` (use it as a param type, e.g.
  `{ input: VsOut.type }`).
- **`VsOut.decl`** — the `StructDecl` for the module's `structs:` array.
- **`VsOut.of(node).uv`** — typed field **read** off a value of the struct.
- **`VsOut.construct({ pos, uv, vis, view_w })`** — build the struct value in **one
  expression** (args taken in declared order; a missing/extra field is a TS error). This
  replaces the imperative `var out; out.uv = …; return out`.

```ts
const pin = VsOut.of(p.input)   // pin.uv, pin.vis, … are typed reads
If(pin.vis.lt(0), () => { Discard() })
return RasterFragmentOutput.construct({ color: …, depth: … })
```

### Uniforms — `uniformStruct`

Declares the struct + its binding together:

```ts
const U = uniformStruct('Uniforms', { group: 0, binding: 0, as: 'u' }, {
  mvp: mat4x4fT,
  proj_params: vec4fT,
  raster_params: vec4fT,
})
// usage — `.field` for field access, `.x` chains straight off it:
const opacity = U.field.raster_params.x
const m = U.field.mvp
```

- **`U.struct`** / **`U.binding`** — for the module's `structs:` / `bindings:` arrays.
- **`U.field.<name>`** — typed field access node (chain `.x`, `.mul`, … directly).
- **`U.node`** — the binding access node (rarely needed directly).

### Plain & storage-element structs — `structDecl`

For a storage-buffer element type or a nested struct:

```ts
export const ShapeSegment = structDecl('ShapeSegment', {
  kind: u32T, color_idx: u32T, flags: u32T, _pad: u32T,
  p0: vec2fT, p1: vec2fT, p2: vec2fT, p3: vec2fT,
})
```

`.decl` / `.type` for the module and as a type token; `.of(node).p0` or `.get(node, 'p0')`
for typed field reads.

### Storage buffers — `storageBuffer(name, element, …)` → `.at(i).field`

A bound `array<Element>` declared from its **element** (a `structDecl` / `ioStruct` handle,
or a scalar type). `.at(i)` returns the element's **typed field proxy** directly — no
`.of()`, no element-type argument:

```ts
const segmentsB = storageBuffer('segments', ShapeSegment, { group: 0, binding: 9, access: 'read' })

const seg = segmentsB.at(i)   // typed
seg.p0                        // → Node<'vec2<f32>'>
seg.kind                      // → Node<'u32'>
```

For a **scalar** element, `.at(i)` returns the element Node directly. `.binding` / `.node`
are available for the module wiring.

### Textures / samplers — `resource`

```ts
const tex = resource('tex', texture2dfT, { group: 0, binding: 1 })
const texSampler = resource('tex_sampler', samplerT, { group: 0, binding: 2 })
// usage:
const c = textureSample(tex.node, texSampler.node, pin.uv)
```

`r.node` keeps the **specific** key (`Node<'texture_2d<f32>'>`, `Node<'sampler'>`), so the
texture/sampler ops are type-checked. `r.binding` goes in the `bindings:` array.

### Typed const handles + fn handles

Module-level WGSL consts are imported as **typed handles** from `shaders/consts.ts` instead
of bare `constRef('NAME')` strings (a typo in a string compiles, then fails at WGSL link
time):

```ts
import { PI, EARTH_R } from './consts'
const latRad = f32(2).mul(atan(exp(mercYAbs))).sub(PI.div(2))
```

Functions are **handles** too — import them and call directly, no `callFn('name')`:

```ts
import { lonlatToEcef } from './ecef'
import { project, flat_rel } from './projections'
const ecef = lonlatToEcef(lonRad, latRad, f32(0))
```

A handle accepts either **positional** args `foo(a, b)` (loose `NodeLike`) or a **typed
object** `foo({ lon, lat })` — the object form checks arg names, types, and completeness,
and autocompletes the params.

> **`externFn`** is the call-only counterpart for a function whose body is linked in later
> (the projection fns, built after `configureProjections()`). You call an `externFn` the
> same way (`f({a, b})` or `f(a, b)`); only the body-linking differs. Authors of ordinary
> shaders import the real fn handle.

---

## 5. Before / after — the ceremony that was removed

**Declaring an output struct and field access**

```ts
// BEFORE — hand-synced struct string + manual field access + imperative build
const VsOut: StructDecl = { name: 'VsOut', fields: [ … ] }
const uv = node.field('uv', vec2fT)
const out = b.var('out', structT('VsOut'))
b.assign(out.field('uv', vec2fT), someUv)
b.ret(out)

// AFTER — one declaration; typed read; one-expression build
const VsOut = ioStruct('VsOut', { pos: builtin('position', vec4fT), uv: location(0, vec2fT), … })
const uv = VsOut.of(node).uv
return VsOut.construct({ pos, uv: someUv, … })
```

**Calling another function**

```ts
// BEFORE — string name + explicit return type, no name checking
const ecef = callFn('lonlat_to_ecef', vec3fT, lonRad, latRad, f32(0))

// AFTER — import the handle, call directly (object form checks names/types)
const ecef = lonlatToEcef(lonRad, latRad, f32(0))
```

**A bound array element**

```ts
// BEFORE — arrayT element + manual element type + per-field accessor
const seg = segments.at(i, structT('ShapeSegment'))
const p0 = seg.field('p0', vec2fT)

// AFTER — element handle; typed field proxy
const segmentsB = storageBuffer('segments', ShapeSegment, { group: 0, binding: 9, access: 'read' })
const p0 = segmentsB.at(i).p0
```

**A mutable accumulator**

```ts
// BEFORE — explicit Var with name + type, free assign function
const min_dist = b.var('min_dist', f32T, f32(1e10))
b.assign(min_dist, min(min_dist, d))

// AFTER — plain const (auto-materialises as var), method assign
const min_dist = f32(1e10)
min_dist.assign(min(min_dist, d))
```

**Literals and degree conversion**

```ts
// BEFORE — f32()/u32() wrappers, multiply by a rounded constant
mode.eq(u32(2))
x.add(f32(1))
vec4(pos, f32(0), f32(1))
const lonRad = lon.mul(DEG2RAD)

// AFTER — contextual literal lift + radians()
mode.eq(2)
x.add(1)
vec4(pos, 0, 1)
const lonRad = radians(lon)
```

**Value dispatch**

```ts
// BEFORE — named, typed, tuple-array switch / equality condExpr
const v = condExpr(f32T, 'v', [[mode.eq(0), e0], [mode.eq(1), e1]], elseVal)

// AFTER — familiar Switch with Var + assign, OR condExpr taking only values
const v = Var(elseVal)
Switch(mode).case(0, () => v.assign(e0)).case(1, () => v.assign(e1)).default(() => {})
// or, for condition/range dispatch:
const clip = condExpr([[c0, () => e0], [c1, () => e1]], () => elseVal)
```

---

## Quick reference

| Need | Write |
|---|---|
| A function | `fn(name?, params, body)` — return type inferred |
| An entry point | `fn(name, { vid: builtin('vertex_index', u32T) }, body, { stage: 'vertex' })` |
| A module | `module({ consts, structs, bindings, funcs })` |
| An intermediate value | plain `const x = expr` |
| Mutate it | `x.assign(v)` (auto-materialises a `var`) |
| A literal in an op | bare number — `x.add(1)`, `vec4(p, 0, 1)` |
| deg↔rad | `radians(x)` / `degrees(x)` |
| Branch (statement) | `If(c, …).elif(c, …).else(…)` |
| Branch (value) | `ifExpr(c, ()=>a, ()=>b)` / `condExpr([[c,()=>a]], ()=>b)` |
| Integer dispatch | `Switch(s).case(n, …).default(…)` |
| Loop fold (value) | `reduce(init, i0, cond, (acc,i)=>…, step)` |
| Early return | `Return(v)` / `ReturnIf(c, v)` |
| IO struct | `ioStruct(name, { f: builtin(...)/location(...) })` → `.of(n).f`, `.construct({…})`, `.type`, `.decl` |
| Uniform | `uniformStruct(name, at, fields)` → `.field.f`, `.struct`, `.binding` |
| Storage element struct | `structDecl(name, fields)` → `.of(n).f`, `.type`, `.decl` |
| Storage buffer | `storageBuffer(name, Element, at)` → `buf.at(i).f` |
| Texture / sampler | `resource(name, type, at)` → `.node`, `.binding` |
| A shared const | import the handle (`PI`, `EARTH_R`) — not `constRef('NAME')` |
| Call a function | import the `FnHandle`, call directly — not `callFn('name')` |
