# Authoring shaders with `@xgis/shader-dsl`

This is the developer guide for **writing** a shader in `@xgis/shader-dsl`. The DSL is a
TSL-style (three.js Shading Language) graph: you author typed value expressions and
imperative statements in TypeScript, and one IR emits both **WGSL** (GPU) and a **CPU
oracle** (parity checks) from the same source.

The goal of the recent work was to remove ceremony. You no longer hand-write WGSL var
names, return-type tokens, `callFn('name', …)` strings, `.field('name', type)` accessors,
or `f32()` wrappers around literals. This guide documents the surface that landed.

> **Import paths.** Author from the package's public barrel — it re-exports the whole
> `core/**` authoring + emit surface (the IR, the SoT layout declarators, the WGSL/GLSL
> backends, the lint passes, the CPU oracle, and `reflect()`):
>
> ```ts
> import { fn, module, vec4, If, Switch, when, emitModule, reflect, … } from '@xgis/shader-dsl'
> import { ioStruct, uniformStruct, structDecl, builtin, location, storageBuffer, resource } from '@xgis/shader-dsl'
> ```
>
> The X-GIS-specific shader graphs that used to live in `shader-dsl/src/shaders/*.ts`
> moved to the map package (`map/src/shaders/dsl/` — #763 A3); they author through this same
> barrel like any other consumer. Inside the package, the barrel re-exports the IR via the
> `core/ir` barrel and the layout helpers via `core/sot` — never import a deep file directly.
>
> **Reflection.** `reflect(module)` recovers the pipeline metadata (bind groups, std140/std430
> struct byte layouts, vertex attributes, entry signatures) as a target-neutral object; the
> std140/std430 offset engine is also exposed standalone as `wgslLayout(struct, kind)`. Both
> are read-only over the IR and never run on the emit path. See `core/reflect.ts`.

---

## 1. The authoring surface

### `fn` — every function (and every entry point)

`fn` authors **all** functions: plain helpers and `@vertex` / `@fragment` / `@compute`
entry points. There is no separate `entryFn` / `computeFn`.

```ts
fn(name?, params, ret?, body, opts?)
```

- **`name`** — optional. Omit it for an auto `_fn{n}` name. Keep an explicit name for any
  fn referenced by a _string_ (an `externFn`, a placeholder-swap lookup) or compared in a
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
export const dist_to_segment = fn(
  'dist_to_segment',
  { p: vec2fT, a: vec2fT, b: vec2fT },
  ({ p, a, b }) => {
    const ab = b.sub(a)
    const len2 = dot(ab, ab)
    const t = clamp(dot(p.sub(a), ab).div(max(len2, 1e-10)), 0, 1)
    const segDist = length(p.sub(a).sub(ab.mul(t)))
    return select(len2.lt(1e-10), length(p.sub(a)), segDist)
  },
)
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

> **Reserved-word params (#763 H7).** A param may be NAMED `in` (or another GLSL/WGSL
> reserved word) — the IR carries it and the GLSL backend renames at emit — but JS
> destructuring cannot BIND that name: write `({ in: inp }) => …`.

### `module` — assemble the WGSL module

```ts
module({ consts, structs, bindings, funcs })
```

Each field is an array; any omitted field defaults to `[]`. Order in `funcs:` is the emit
order — keep **callees before callers**. Not for WGSL's sake (final-spec WGSL resolves
module-scope declarations out of order; it has no prototype syntax at all), but because
(a) GLSL ES 3.00 requires declare-before-use — the GLSL backend emits forward prototypes
as a safety net, and dependency order keeps working even without them — and (b) a stable
order keeps snapshot/golden bytes deterministic:

```ts
export const buildRasterModule = (pickEnabled: boolean): ModuleDecl =>
  module({
    consts: [...PROJECTION_CONSTS, ...ECEF_CONSTS],
    structs: [U.struct, Tile.struct, VsOut.decl, rasterFragmentOutput(pickEnabled).decl],
    bindings: [U.binding, tex.binding, texSampler.binding, Tile.binding],
    funcs: [
      ...getGpuProjectionFuncs(),
      ...ECEF_FUNCS,
      ...RASTER_COLOR_FUNCS,
      apply_log_depth,
      compute_log_frag_depth,
      vs,
      buildFs(pickEnabled),
    ],
  })
```

#### `funcs:` as a key-record — name once (#740 R1)

`funcs:` also accepts a RECORD; each key becomes the fn's emitted name (a rename of
whatever the handle carried, including anonymous `fn(params, body)` handles), and key
order is the emit order (JS preserves string-key insertion order):

```ts
module({ funcs: { proj_mercator, wrap_lon_delta, vs_main } })
```

Record keys are **deterministic names** — the `fnAutoId` collision counter behind
anonymous handles never reaches emitted WGSL through this form (#763 H9) — so it is
safe for snapshot-gated and string-referenced shaders too. Keep the ARRAY form when
the decl list is spread across sources or post-processed as data (e.g. a blanket
`allowEarlyReturn` map).

---

### `composeModule` — variant composition via placeholders

When a base module has variation seams, mark them with `b.placeholder('tag')` and fill them per
variant with `composeModule`, instead of hand-rolling a clone-and-swap walk:

```ts
const base = module({ funcs: [/* … fs_fill ends with */ (_p, b) => b.placeholder('fill-return')] })
const composed = composeModule(base, { 'fill-return': variantFillReturnStmts })
```

It descends into `if`/`for`/`switch` bodies, and is **strict by default**: an un-swapped placeholder
or a swap key that matches no placeholder **throws** (the silent-on-GPU / throws-on-CPU footgun
becomes a loud compose-time error). Pass `{ allowUnswapped: true }` for deliberate bare survival.

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
const min_dist = f32(1e10) // plain const…
// …later, inside a loop…
min_dist.assign(min(min_dist, d)) // …auto-materialises as `var`
```

`Let(...)` / `Var(...)` still exist for the rare case where you need to _force_ a named
binding (a derivative like `fwidth` that WGSL requires in uniform control flow, or a
mutable accumulator you want to name), but the default is a plain `const`.

**When a `Let` is load-bearing, not stylistic** (#838): CSE cannot hoist a subexpression
that reads a **mutated** `var` — the value differs per read site — so a shared
subexpression inside a mutation loop **re-emits at every use** unless you materialise it:

```ts
Loop(
  u32(0),
  (i) => i.lt(u32(72)),
  () => {
    const p = ro.add(rd.mul(t)) // t is mutated below → CSE can't cache anything reading it
    const d = Let(length(p).sub(1)) // materialise ONCE; without Let the SDF re-emits per read
    If(d.lt(0.001), () => Break())
    t.assign(t.add(d))
  },
)
```

Rule of thumb: inside a loop that mutates a `var`, `Let` any value derived from that `var`
that you read more than once.

### `.assign(v)` — the one mutation method

JS cannot overload `=`, so mutation is a method on the lvalue Node (mirrors three.js TSL's
`.assign`):

```ts
x.assign(value) // x = value;
winding.assign(winding.add(1)) // compound = the pure op + assign; there is no addAssign
o.pos.assign(vec4(pos, 0, 1)) // member targets work too
```

There is **no** free `assign(x, v)` function in the authoring surface — `.assign` is a
method on the target Node. There is **no** compound `addAssign` either: `add` is the pure
expression, so `x += v` is `x.assign(x.add(v))`.

**Mutating an immutable binding is a compile error.** `.assign` lives only on the **mutable**
node type (`Node`) returned by `Var()` and by every produced value (literals, ctors, arithmetic,
accessors — so the plain-`const` auto-var pattern works). `Let()`, a function param, and a module
const return the read-only supertype `ReadonlyNode`, which has no `.assign` — so `someLet.assign(…)`
or `param.assign(…)` is rejected by `tsc`, not just at `device.createShaderModule`. Read APIs
(`length`, `dot`, `mix`, `.of`, an `fn` return, …) accept `ReadonlyNode`, so an immutable binding
still flows everywhere a value is read. (This is a type-only distinction — emitted WGSL is
unchanged; it mirrors RxJS `Observable` vs `Subject`.) To mutate, declare with `Var()`.

### Method ops + contextual literal lift

Arithmetic, comparison, bitwise, swizzle, and index are **methods** on a Node:

| category   | methods                                                                  |
| ---------- | ------------------------------------------------------------------------ |
| arithmetic | `.add .sub .mul .div .mod .neg`                                          |
| comparison | `.lt .gt .le .ge .eq .ne`                                                |
| logical    | `.and .or`                                                               |
| bitwise    | `.bitAnd .bitOr .bitXor .shl .shr`                                       |
| components | `.x .y .z .w` · `.r .g .b .a` · `.rgb .xy .xyz …` · `.swizzle<R>('zxy')` |
| index      | `.at(i, elemType)`                                                       |
| ternary    | `cond.select(a, b)` (WGSL `select`)                                      |

> **The `.mod` METHOD is `%` — trunc-mod on WGSL floats and INVALID on GLSL
> ES 3.00 floats (integer-only there).** For float modulo use the free function
> **`mod(x, y)`** (#839): FLOOR-mod with identical semantics on both targets
> (WGSL spells it inline as `x − y·⌊x/y⌋`, GLSL as native `mod()`), so negative
> operands wrap into `[0, y)` — what domain repetition and angle folds need.
> Named after GLSL/TSL `mod` — deliberately not `fmod`, which in C/HLSL is
> trunc-mod. Component-wise; `y` may be a scalar broadcast over a vector `x`.

**A bare number literal lifts to the operand's type from context** — drop the `f32()` /
`u32()` / `i32()` wrapper:

```ts
x.add(1) // f32 x → `x + 1.0`
flags.bitAnd(1) // u32 flags → `flags & 1u`   (typed from the LHS)
mode.eq(2) // u32 → `mode == 2u`
vec4(pos, 0, 1) // numeric components lift to the vec's element (f32)
vec2u(0, 1) // → u32 components
```

The same lift applies inside vector/struct constructors (`vec2/vec3/vec4/vec2u/vec2i`,
`construct`) and inside `min/max/clamp/mix/pow/smoothstep`. You only keep an explicit
`f32(0.5)` / `u32(16)` when there is **no** context to infer from (a standalone constant or
the type-anchor first arg of a math built-in).

**Negative literals lift too** (#845) — `x.mul(-6)`, `.add(-0.25)`, `vec3(-1, 0, 1)` all
emit the signed literal directly (`x * -6.0`) on both targets. There is no need for the
defensive `.neg()` / `.sub()` spellings some older examples used; write the sign in the
number.

### `radians()` / `degrees()`

Use the WGSL built-ins for degree↔radian conversion, not a multiply by a rounded constant:

```ts
const lonRad = radians(lon) // was: lon.mul(DEG2RAD)
const latDeg = degrees(latRad) // was: latRad.div(DEG2RAD)
```

(`DEG2RAD` survives only as the `(DEG2RAD·EARTH_R)` divisor in the abs-Mercator → degree
reverse paths, where folding it out would shift precision.)

---

## 3. Control flow

### `If / elif / else` — statements

```ts
If(pin.vis.lt(0), () => {
  Discard()
})

If(p.idx.eq(1), () => {
  pos.assign(vec2(3, -1))
})
  .elif(p.idx.eq(2), () => {
    pos.assign(vec2(-1, 3))
  })
  .else(() => {
    /* … */
  })
```

`If` / `elif` / `else` bodies are zero-arg closures `() => …` that author into the
**innermost** active scope (no `Builder` is threaded). They are **statements** — a body
should not "return" a value as a fall-through; for early exits use `Return()` / `ReturnIf()`.

### `Loop` — the C-style for

```ts
Loop(
  u32(0),
  (i) => i.lt(u32(64)), // cond receives the counter…
  (i) => {
    // …and so does the BODY — declare `(i)` here too (#837)
    acc.assign(acc.add(toF32(i)))
  },
)
```

`Loop(init, cond, body, step?)` (optional leading name string names the WGSL counter;
`step` defaults to `+1`). **Both** callbacks receive the counter — a body written `() => {}`
that references `i` compiles as JS closure syntax but `i` is not in scope: `tsc` flags it
(`Cannot find name 'i'`), and a transpile-only runner (vitest) surfaces it at build time as
`while building fn '…': in Loop body: i is not defined` (#843). `Continue()` / `Break()`
are the loop terminators; the counter is a mutable `Node` (loop-var reassignment is legal
WGSL).

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

### Value combinators — `when` / `reduce`

When you want a branch-**initialised value** instead of a mutation, use the value
combinators. They take **only values** — no var name, no type token (the type is inferred
from the arms). `when` is the **one** condition-dispatch combinator (2-arm and N-arm), the
condition-side sibling of `Switch`/`matchExpr` (scrutinee) and `select` (eager 2-way):

```ts
// 2-arm
const dir = when(
  segLen.lt(1e-6),
  () => vec2(1, 0),
  () => segVec.div(segLen),
)

// N-arm: array of [condition, () => value] arms, then the else value (first true wins)
const clip = when(
  [
    [projParams.x.lt(0.5), () => transformMat4(mvp, vec4(rel2d, 0, 1))],
    [projParams.x.lt(6.5), () => transformMat4(mvp, vec4(relG, 0, 1))],
  ],
  () => transformMat4(mvp, vec4(ecefRtc, 1)),
)

// loop fold — body RETURNS the next accumulator (no Var + assign at the call site)
const best = reduce(
  f32(1e10),
  u32(0),
  (i) => i.le(STEPS),
  (acc, i) => {
    const q = bezierPoint(i)
    return min(acc, length(p.sub(q)))
  },
  u32(1),
)
```

`when`/`reduce` materialise the var + control flow internally and return the result Node, so
the emit is identical to the hand-written `var v; if (…) v = …` form. Use `when` for genuine
**condition/range** dispatch (no single scrutinee); use `Switch`/`matchExpr` for integer
**scrutinee** dispatch. (`ifExpr`/`condExpr` are **deprecated** aliases of `when`.)

### `enumU32` / `matchEnum` — EXHAUSTIVE integer dispatch

For dispatch over a fixed set of integer cases, declare an `enumU32` and use `matchEnum`. The
arms object must cover **every** member — omit one (or add an unknown key) and it is a `tsc`
compile error, so adding a member surfaces every un-handled site. It lowers to the same
`matchExpr` (switch) the hand-written form emits (byte-identical):

```ts
const Kind = enumU32({ Line: 0, Fill: 1, Stroke: 2 })

const color = matchEnum(seg.kind, Kind, {
  Line: () => lineColor,
  Fill: () => fillColor,
  Stroke: () => strokeColor, // drop an arm → compile error
})
// Kind.members.Fill is a Node<'u32'> literal; Kind.struct/values feed the case labels.
```

Use `matchEnum` over a bare `Switch`/`matchExpr` whenever the case set is closed — it turns a
"forgot a case" runtime/visual bug into a compile error (the dispatch analogue of the
`.assign`-on-`Let` footgun being a type error).

### Early returns — `Return` / `ReturnIf`

A control-flow body never captures a native `return value` as an early exit (that would
read as a silent fall-through). Make early returns explicit:

```ts
Return(value) // return value;
ReturnIf(winding.ne(0), f32(1).sub(min_dist)) // if (winding != 0) { return …; }
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

- **`builtin(name, type)`** → a `@builtin(<name>)` field. `name` is the WGSL builtin id
  (`'position'`, `'vertex_index'`, `'instance_index'`, `'front_facing'`, `'frag_depth'`,
  `'global_invocation_id'`, …), passed through verbatim — typed as `string` today
  (#763 H7), so a typo surfaces at pipeline creation, not at tsc.
- **`location(n, type, interpolate?)`** → a `@location(n)` field, optionally
  `@interpolate(<mode>)` with `mode ∈ 'flat' | 'linear' | 'perspective'` — `'flat'` is
  the mode the GLSL backend also honors (emits the `flat` qualifier on both sides).
- **`VsOut.type`** — the struct's `ShaderType` (use it as a param type, e.g.
  `{ input: VsOut.type }`).
- **`VsOut.decl`** — the `StructDecl` for the module's `structs:` array.
- **`VsOut.of(node).uv`** — typed field **read** off a value of the struct.
- **`VsOut.var('out')`** — declare a `var` of the struct and get typed, ASSIGNABLE
  fields: `o.pos.assign(…)`, then `return o` — the proxy duck-types as the raw node in
  value positions (#763 X14). **`o.$`** is the raw struct-value node for explicit passes.
- **`VsOut.construct({ pos, uv, vis, view_w })`** — build the struct value in **one
  expression** (field-keyed; a missing/extra field is a TS error). This
  replaces the imperative `var out; out.uv = …; return out` when no mutation is needed.

```ts
const pin = VsOut.of(p.input)   // pin.uv, pin.vis, … are typed reads
If(pin.vis.lt(0), () => { Discard() })
return RasterFragmentOutput.construct({ color: …, depth: … })
```

### Uniforms — `uniformStruct`

Declares the struct + its binding together:

```ts
const U = uniformStruct(
  'Uniforms',
  { group: 0, binding: 0, as: 'u' },
  {
    mvp: mat4x4fT,
    proj_params: vec4fT,
    raster_params: vec4fT,
  },
)
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
  kind: u32T,
  color_idx: u32T,
  flags: u32T,
  _pad: u32T,
  p0: vec2fT,
  p1: vec2fT,
  p2: vec2fT,
  p3: vec2fT,
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

const seg = segmentsB.at(i) // typed
seg.p0 // → Node<'vec2<f32>'>
seg.kind // → Node<'u32'>
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
const latRad = f32(2)
  .mul(atan(exp(mercYAbs)))
  .sub(PI.div(2))
```

To **declare** a module constant, a scalar that needs the truncated-vs-full-precision split
(`PI`) is authored as the `{ wgslValue, cpuValue }` `ConstDecl` directly. For a **non-scalar**
constant — a `vec4<f32>` colour, an `array<vec4<f32>, N>` palette, a struct — use `constExpr`,
which takes a constant-foldable literal Node and emits `const <name>: <type> = <value>;` on
both WGSL + GLSL and evaluates it on the CPU oracle:

```ts
const SKY = constExpr('SKY', vec4fT, vec4(0.4, 0.6, 0.9, 1))
const PALETTE = constExpr('PALETTE', arrayT(vec4fT, 3), arrayLit(vec4fT, c0, c1, c2))
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
const v = condExpr(
  f32T,
  'v',
  [
    [mode.eq(0), e0],
    [mode.eq(1), e1],
  ],
  elseVal,
)

// AFTER — familiar Switch with Var + assign, OR condExpr taking only values
const v = Var(elseVal)
Switch(mode)
  .case(0, () => v.assign(e0))
  .case(1, () => v.assign(e1))
  .default(() => {})
// or, for condition/range dispatch:
const clip = condExpr(
  [
    [c0, () => e0],
    [c1, () => e1],
  ],
  () => elseVal,
)
```

---

## 6. Diagnostics — coded errors, aggregated reports, source locations

Authoring mistakes surface as **coded** errors (`shader-dsl [SD####]: …`) carrying a one-line
`hint`, not opaque strings. A type mismatch, a swizzle on a non-vector, a `select` over
mismatched branches — each throws a `ShaderDslError` with a stable `.code` you can branch on:

```ts
try {
  emitModule(m)
} catch (e) {
  if (e instanceof ShaderDslError && e.code === 'SD0002') {
    /* mismatched vectors */
  }
}
```

### `validate()` reports every error, not just the first

`emitModule` runs `validate()` first; on a structurally invalid module it throws ONE
`ValidationError` listing **all** failures (with each diagnostic's code, rule, fn, and — when
source tracing is on — `file:line:col`). The diagnostics are also on `err.diagnostics`.

### `diagnose(module, opts?)` — the one "what's wrong with this?" entry

Run the lint ruleset and (optionally) a backend capability check together, **without throwing**,
and render a human report:

```ts
import { diagnose, formatReport, wgslBackend } from '@xgis/shader-dsl'

const report = diagnose(m, { rules: 'all', backend: wgslBackend })
console.log(formatReport(report))
// error[SD0107] no-assign-to-let  (fn rim_alpha)
//   --> map/src/shaders/dsl/line.ts:721:9
//   assignment to immutable 'let' binding 'x' …
//   hint: declare the binding with Var() instead of Let() to mutate it
// 1 error, 0 warnings
```

`diagnose` is read-only over the IR and never on the emit path — it surfaces lint + capability
problems in one pass. The classic `.assign()`-on-a-`Let` footgun (`Let(x); x.assign(…)` → invalid
WGSL) shows up here as the `SD0107` / `no-assign-to-let` error.

### Source locations — `setSourceTracing` (dev-only, opt-in, off by default)

Source-location capture maps each authored statement / function back to the TypeScript line
that produced it, so diagnostics can print `file:line:col`. It is **off by default** and
**genuinely zero-cost when off** (no stack is ever allocated); turn it on in a dev/test run:

```ts
import { setSourceTracing } from '@xgis/shader-dsl'
setSourceTracing(true) // or set XGIS_SHADER_DSL_TRACE=1
```

Locations live in a private side-table keyed by node identity — they are **never** read on the
emit path and **never** appear in emitted WGSL/GLSL (emit is byte-identical whether tracing is on
or off). They resolve only on the **authored** module (before the optimizer/lowering rebuild
nodes), which is exactly where `validate()` / `lintModule()` / `diagnose()` run.

## 7. fp64 — emulated double precision (`f64`)

GPUs have no `f64`; the DSL emulates it as an unevaluated **two-f32 pair** (hi + lo,
"double-float"/df64 — DSFUN90 → NVIDIA CUDA `dsadd`/`dsmul` → Thall lineage), giving
**~48 significand bits** at f32 exponent range. The authoring surface is IDENTICAL to
f32 — only the declared type differs:

```ts
import { f64T, f64, toF64, toF32, splitF64 } from '@xgis/shader-dsl'

const U = uniformStruct(
  'U',
  { group: 0, binding: 0, as: 'u' },
  {
    origin: f64T, // one vec2<f32> slot — host packs splitF64(value)
  },
)

const k = fn(
  'k',
  { x: f64T, s: f32T },
  (p) => toF32(sqrt(p.x.add(U.field.origin).mul(p.s))), // .add/.mul/sqrt — unchanged syntax
)
const m = module({ funcs: [k], uses: [U] }) // nothing fp64-specific to declare
```

The pre-emit `fp64Lower` pass rewrites every `f64` into `vec2<f32>` + injected
`df64_*` emulation calls (WGSL, GLSL, and — natively, as JS numbers — the CPU oracle
all agree). What to know:

- **Conversions.** `f32 → f64` widens implicitly in arithmetic (exact) or explicitly
  via `toF64(x)` / a bare number literal (split losslessly at build time — JS numbers
  ARE f64). Narrowing is ONLY explicit: `toF32(x)` (= hi + lo, precision-losing).
  Mixing f64 with ints/bools is an author-time `SD0004`.
- **Supported ops.** `+ − × ÷`, all comparisons (lexicographic), `neg`, `abs`, `min`,
  `max`, `sqrt`, `mix` (f32 interpolant), `floor`, `fract`, `sin`, `cos`. Anything else
  on an f64 operand fails loud at emit (`SD0041`) — narrow explicitly first. `%` and
  bitwise are rejected at author time.
- **Transcendentals (`sin` / `cos`).** A luma.gl port: 3-stage argument reduction
  (mod 2π → quadrant → π/16 index) + tabled angle-addition + a short Taylor on the tiny
  residual. Two things to know. **(1) Accuracy** is lower than the arithmetic: the Taylor
  truncation floors relative error at **~2⁻³⁶** for the transcendental itself, and it
  degrades with argument magnitude through the reduction (the inherent large-argument
  precision loss — still far past f32, whose sine of a ≳2²⁴ argument is pure noise: the
  f32 argument has already lost the sub-ulp phase). **(2) The df64_mul caveat applies.**
  sin/cos are built on the df64 multiply, and on **Apple/Metal** that multiply collapses
  under default fast-math in a way that is **not robustly guardable in-shader** (see the
  `df64_mul` note in `core/fp64/df64-lib.ts` and the fp64 blog Part 7/8). So sin/cos are
  correct on backends where the multiply survives (verified on Blackwell and on a
  Windows/D3D12 Turing path) but inherit the same fragility on Apple/Metal — the on-device
  gate asserts this device-conditionally, it does not claim universal correctness. Also
  on `vecN<f64>` (per-lane).
- **The guard texture (auto-injected).** Every f64-arithmetic module gets a
  `texture_2d<f32>` binding named `_fp64` injected automatically (deterministically
  at group 0, first free binding). The host must bind a **1×1 texture whose texel
  reads exactly 1.0** (RGBA8 white / R32F 1.0) — WGSL §15.7.5 permits reassociation
  and Metal defaults to fast-math, and without a runtime-opaque `one` threaded
  through the error-compensation terms a downstream compiler can legally fold df64
  back to f32 precision (the luma.gl CODE_ELIMINATION_WORKAROUND lineage). It is a
  TEXTURE rather than a uniform because some drivers specialize pipelines on
  observed uniform values and hot-swap re-optimized variants that fold the terms
  anyway (seen in the field on Windows/NVIDIA); no compiler treats texel values as
  constants. To pin the slot to an engine's fixed bind-group layout, declare
  `fp64Guard({ group, binding })` in `uses:`; a conflicting `_fp64` declaration is
  `SD0042`.
- **Layout & packing.** An f64 uniform field / vertex attribute occupies a plain
  `vec2<f32>` slot (size 8, align 8); pack it with `splitF64(x)` (hi, lo). An f64
  VARYING is rejected (`SD0044`) — interpolating hi/lo pairs is numerically wrong.
- **Names.** The `df64_` fn prefix and `DF64VecN` struct names are reserved for the
  injected emulation (`SD0043`).
- **Cost.** Each op is several-to-10× an f32 op — opt in per VALUE, not per shader.

### Vectors — `vec2f64T` / `vec3f64T` / `vec4f64T`

`vecNf64(x, y, …)` builds an emulated-double vector; components (`v.x`), swizzles
(`v.zyx`), componentwise `+ − ×` (with `f64`/`f32`/number broadcast), `÷`, `neg`,
the componentwise builtins `abs`/`min`/`max`/`mix` (scalar f32 interpolant)/`floor`/
`fract`/`sin`/`cos`/`normalize`, and the reductions `dot`/`length`/`distance` (→ `f64`)
all use the unchanged surface. A vec64 lowers to
`struct DF64VecN { hi: vecN<f32>, lo: vecN<f32> }` — componentwise arithmetic runs
the same EFTs on whole hi/lo planes (one twoSum for all lanes); the builtins with
per-lane branching (`abs`, `min`, …) and `normalize` compose the verified SCALAR
df64 fns lane by lane inside one `df64_vN_*` helper body, and
`dot`/`length`/`distance` accumulate through the SCALAR df64 chain
(extended-precision accumulation is the point); `sin`/`cos` compose the scalar
df64_sin/df64_cos per lane. Everything else on a vec64 (`exp`, `clamp`, …) is
`SD0041` — narrow per lane (`toF32(v.x)`) first.
A vec64 uniform field occupies its struct layout (n=2: 16 B, n=3/4: 32 B under
std140); a vec64 vertex ATTRIBUTE is rejected (`SD0041`) — pass hi/lo as two
`vecN<f32>` `@location`s (the existing DSFUN lane convention) and rebuild lanes with
`f64FromParts`.

See `examples/fp64-deep-zoom.ts` for the full picture (f32 collapse vs f64 stripes).

## 8. Production emit — `@xgis/shader-dsl/emit-prod`

Your bundler minifies the JS and never touches the shader text it hands to
`gl.shaderSource` / `createShaderModule`. The ship-time transforms compose the
Vite/Webpack way — a `{ plugins: [...] }` bag of named plugins — and live on
their OWN subpath (like `/dev` for the lint/measure tooling): the core emit
carries only the neutral plugin seam (`EmitPlugin` / `EmitOptions`), so a
runtime-emit consumer that never imports the subpath bundles **zero bytes** of
them, and the plain emit stays byte-identical.

```ts
import { mangle, minify, obfuscate } from '@xgis/shader-dsl/emit-prod'

const renames = new Map<string, string>()
const wgsl = emitModule(m, { plugins: [mangle({ renames }), minify()] })
// obfuscate() is the standard [mangle, minify] preset:
const vs = emitGlslModule(m, 'vertex', { plugins: obfuscate() })
const fs = emitGlslModule(m, 'fragment', { plugins: obfuscate() })
```

- **`mangle({ renames? })`** — an `EmitPlugin` (a Vite-style factory). Renames
  helper fn names, plain struct names, and module consts (including the
  injected `df64_*` library) to `_f0`/`_S0`/`_k0`. Deterministic per module —
  the two GLSL stage emits (separate calls) always agree on shared names, so
  programs still link. Pass a `Map` as `renames` to receive authored → emitted
  names: the shader "source map" for decoding production driver logs and GPU
  captures. Keep it out of the shipped bundle.
- **`minify()`** — an `EmitPlugin` that compacts the emitted string. Token-safe
  by construction (neither language has string literals; `#` directives keep
  their own line). `minifyShaderText(code)` is the raw function it wraps, for a
  string you already hold.
- **`inline()`** — an `EmitPlugin` that flattens the call graph (obfuscation):
  every safely-inlinable helper is inlined at all its call sites, so those
  functions vanish. Single-return helpers inline by expression substitution;
  LINEAR multi-statement helpers (a `let`/`var` prelude then one trailing
  `return`, e.g. a value-noise fn) inline by lifting their statements into the
  caller — sound because shader code is pure, so hoisting a computation earlier
  in its block changes no result. Leaves the `df64_*` library, entry points,
  recursive fns, and control-flow / for-header-called helpers intact. NOT a size
  win — a multi-call helper is duplicated per site (the following `minify()`
  recovers the whitespace); the point is removing structure a reader could
  follow. Opt-in, and NOT part of `obfuscate()`, so no existing output changes.
  Place it before `mangle()`: `{ plugins: [inline(), ...obfuscate()] }`.
- **`obfuscate({ renames? })`** — the standard preset, `[mangle(opts),
minify()]`. Spread it into `{ plugins }`.

Plugins fire STAGED like Vite: every plugin's `transformIR` (IR stage) runs in
array order before the module is assembled, then every plugin's `transformText`
(string stage) runs in array order — so `inline()` and `mangle()` (both IR)
compose in the order you list them, ahead of `minify()` (text).

**The ABI boundary — never renamed:** entry-point names (WebGPU `entryPoint`),
binding names including the `_fp64` guard (hosts resolve by name),
binding-struct names (the GLSL UBO block tag), and struct FIELD names (std140
packing + GLSL varyings link vertex↔fragment by name). `reflect()`-driven
hosts bind unchanged. A fn containing a `raw` stmt makes the mangle a no-op
for the whole module (textual references are invisible to the rename).

Every renderable example is compiled AND pixel-compared through `obfuscate()`
on real Tint + ANGLE by `playground/e2e/_emit-obfuscate-gate.spec.ts`.

## Quick reference

| Need                        | Write                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| A function                  | `fn(name?, params, body)` — return type inferred                                                      |
| An entry point              | `fn(name, { vid: builtin('vertex_index', u32T) }, body, { stage: 'vertex' })`                         |
| A module                    | `module({ consts, structs, bindings, funcs })`                                                        |
| An intermediate value       | plain `const x = expr`                                                                                |
| Mutate it                   | `x.assign(v)` (auto-materialises a `var`)                                                             |
| A literal in an op          | bare number — `x.add(1)`, `vec4(p, 0, 1)`                                                             |
| deg↔rad                     | `radians(x)` / `degrees(x)`                                                                           |
| Branch (statement)          | `If(c, …).elif(c, …).else(…)`                                                                         |
| Branch (value)              | `when(c, ()=>a, ()=>b)` / `when([[c,()=>a]], ()=>b)` (was `ifExpr`/`condExpr`)                        |
| Exhaustive integer dispatch | `enumU32({A:0,B:1})` + `matchEnum(s, E, { A:()=>…, B:()=>… })` (missing arm = compile error)          |
| Integer dispatch            | `Switch(s).case(n, …).default(…)`                                                                     |
| Loop fold (value)           | `reduce(init, i0, cond, (acc,i)=>…, step)`                                                            |
| Early return                | `Return(v)` / `ReturnIf(c, v)`                                                                        |
| IO struct                   | `ioStruct(name, { f: builtin(...)/location(...) })` → `.of(n).f`, `.construct({…})`, `.type`, `.decl` |
| Uniform                     | `uniformStruct(name, at, fields)` → `.field.f`, `.struct`, `.binding`                                 |
| Storage element struct      | `structDecl(name, fields)` → `.of(n).f`, `.type`, `.decl`                                             |
| Storage buffer              | `storageBuffer(name, Element, at)` → `buf.at(i).f`                                                    |
| Texture / sampler           | `resource(name, type, at)` → `.node`, `.binding`                                                      |
| A shared const              | import the handle (`PI`, `EARTH_R`) — not `constRef('NAME')`                                          |
| Double precision            | declare values as `f64T` — same operators; `toF64`/`toF32` to convert; write 1.0 to the auto `_fp64`  |
| A non-scalar const          | `constExpr(name, type, valueNode)` — `vec4` / `arrayLit` / struct literal                             |
| Call a function             | import the `FnHandle`, call directly — not `callFn('name')`                                           |
| Diagnose a module           | `diagnose(m, { backend })` → `formatReport(report)` (lint + caps, no throw)                           |
| Source locations in errors  | `setSourceTracing(true)` (dev-only, off by default, never on emit)                                    |
