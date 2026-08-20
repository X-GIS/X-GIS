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

Full signature: [`fn`](https://x-gis.github.io/X-GIS/api/index/functions/fn).

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

### `rawStmt` — the verbatim escape hatch, paired per target (#1671)

When a statement must be hand-written — a pre-built string from another generator, a construct the
IR does not model — splice it with `rawStmt`. It carries **one payload per target**: the same
statement, spelled for each backend.

```ts
// the FACTORY form — when you assemble a `Stmt[]` body array by hand
const PAIRED = rawStmt({
  wgsl: 'return vec4<f32>(1.0, 0.0, 0.0, 1.0);',
  glsl: 'return vec4(1.0, 0.0, 0.0, 1.0);',
})
const fs: FuncDecl = {
  name: 'fs_main',
  attrs: ['@fragment'],
  stage: 'fragment',
  params: [],
  ret: vec4fT,
  retAttr: '@location(0)',
  body: [PAIRED],
}
```

Inside a fluent `fn()` body use **`b.raw(payload)`** instead — a bare `rawStmt(...)` call there is a
silently discarded expression (the returned `Stmt` is never pushed, so nothing is emitted).

The MEANING is fixed ("splice these bytes here"); only the SPELLING is per-target — the same
per-target-spelling pattern the intrinsic registry uses (`INTRINSICS`' `Spelling` record). Unlike
`Spelling`, which requires BOTH sides, one side may be omitted here (see below) — but **at least one
is required at the type level**: `rawStmt({})` does not compile. Each backend emits its own side
verbatim at the enclosing body indent.

**Fail-closed, symmetrically.** A backend handed a raw with no payload for ITS target throws
`UnsupportedFeatureError` (SD0030) — a wgsl-only raw is a hard build error on GLSL, and a glsl-only
raw is a hard build error on WGSL. Omitting a side is a decision that "this module does not build
for that target", never a silent mis-emit. So supply every spelling the module must build for; the
error names the missing one and quotes the side you did give.

**Only the FIRST line gets the indent.** The emitter prepends the body indent to the payload as a
whole, so line 2+ of a multi-line payload lands at column 0. Indent continuation lines yourself if
the output shape matters.

**Identifiers inside raw text are yours to keep valid.** The DSL does not read into a raw payload,
so nothing rewrites it: `mangle()`/`obfuscate()` rename what they can see, and a textual reference is
not something they can see. (A module containing any raw makes the mangle a no-op module-wide for
this reason; see §8.) The concrete GLSL-side mine: the GLSL backend actively **renames** params and
locals that collide with GLSL reserved words (`glsl-sanitize.ts` — `in`, `sample`, `filter`,
`texture`, …), so raw `glsl` text naming the OLD identifier will reference a variable that no longer
exists. The WGSL side has no such renamer, so the risk is asymmetric even though the contract (the
author keeps the raw text valid) is identical in both directions.

**A raw anywhere in the module disables GLSL stage scoping.** Raw text is opaque to the IR's
reference walk, so the GLSL backend's per-stage reachability filter (`glsl.ts`'s `stageScope`) bails
to `null` for the whole module. HELPERS: every helper fn is then emitted into **every** stage —
a helper the entry never calls still reaches the writer, so a wgsl-only raw inside it still throws
the whole GLSL emit. ENTRIES: an entry of a DIFFERENT stage is still dropped before the body walk,
so enforcement is per-stage — a one-sided raw does not build for any stage whose emitted fn set
contains that raw, not "for that target" globally. Pair the payloads on every raw in a module that
must build for both targets, reachable or not.

⚠ Because scoping is off, **fragment-only machinery in ANY helper of a raw-carrying module is
emitted into the vertex stage too** — `dpdx`/`dpdy`/`fwidth` via intrinsics, `discard` — and fails to
compile there. Keep such modules helper-clean, or split the raw out into its own module.

(Whole-module dead-function elimination does not save an uncalled helper either — but not for this
reason: `deadFnElim` (`passes/opt/dce-fns.ts`) is an available-but-unwired pass, deliberately absent
from `DEFAULT_PASSES`, so tree-shaking simply never runs. It also bails on any raw, for any caller
that does wire it.)

The CPU oracle has no evaluation for raw text at all and throws on any target — raw is GPU-only.

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

**GLSL target: a discarding struct-ctor argument auto-hoists, no marker needed** (#1840).
ANGLE's D3D11 backend miscompiles a GLSL ES 3.00 fragment shader whose struct-constructor
argument contains a call to a function that (transitively) executes `discard` —
COMPILE_STATUS and LINK_STATUS both report success, and the draw silently drops geometry at
the first submit. A GLSL-only legalize pass (`glsl-legalize.ts`) detects that shape and binds
the argument to a fresh `_dhN` local immediately before the constructor call, on every GLSL
emit. You keep authoring a plain `const` (or an inline call) as usual — there is nothing to
wrap in `Var()`/`Let()` for this; the hoist is automatic and GLSL-only, so WGSL emit is
byte-untouched.

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

[`Loop`](https://x-gis.github.io/X-GIS/api/index/functions/Loop) (optional leading name
string names the WGSL counter; `step` defaults to `+1`). **Both** callbacks receive the
counter — a body written `() => {}`
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

[`Loop`](https://x-gis.github.io/X-GIS/api/index/functions/Loop) is the C-style for loop;
`Continue()` / `Break()` / `Discard()` are the loop/fragment terminators.

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
- [**`location`**](https://x-gis.github.io/X-GIS/api/index/functions/location) → a
  `@location(n)` field, optionally `@interpolate(<mode>)` with
  `mode ∈ 'flat' | 'linear' | 'perspective'` — `'flat'` is
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

`textureSample` uses an **implicit LOD** from screen-space derivatives, so it is
**fragment-only** (a vertex/compute use is an SD0109 lint error). Read an explicit level
instead with `textureSampleLevel(tex, smp, uv, level)` — legal in every stage. The
derivative builtins `fwidth` / `dpdx` / `dpdy` are fragment-only the same way (SD0109,
#1654) — no vertex/compute form exists, so precompute the quantity and pass it in.

#### 2D array textures — `texture2dArrayfT`

An atlas of N layers behind **one** binding, with the layer chosen per **sample**:

```ts
const atlas = resource('atlas', texture2dArrayfT, { group: 0, binding: 1 })
const atlasSampler = resource('atlas_sampler', samplerT, { group: 0, binding: 2 })

textureSample(atlas.node, atlasSampler.node, uv, layer) // implicit LOD (fragment-only)
textureSampleLevel(atlas.node, atlasSampler.node, uv, layer, level) // explicit LOD, any stage
textureLoad(atlas.node, coord, layer, level) // unfiltered texel fetch
textureNumLayers(atlas.node) // → Node<'u32'> — how many layers the atlas has
```

Same three function names — the **first argument's key** picks the array form, and the
`layer` argument is then required (a missing one is a tsc error, not a runtime surprise).
A `number` layer lifts to an **i32** literal. WGSL spells the layer as its own argument
(`textureSample(t, s, uv, layer)` on a `texture_2d_array<f32>`); GLSL ES 3.00 folds it into
the coordinate (`texture(sampler2DArray, vec3(uv, float(layer)))`) — both CORE, so no
capability is required on either target. `reflect()` reports the dim on the bind entry
(`textureDim: '2d-array'`) so a host can create the matching view.

`textureDimensions(atlas.node)` returns the **width/height only** (`vec2<u32>`) — for an
array texture too. The layer **count** is the separate `textureNumLayers(atlas.node)`
(`u32`, #1658); wrap it in `toF32` for float math. It is array-key only (a plain 2d
texture is a tsc error), and the targets spell it differently — WGSL has the dedicated
`textureNumLayers(t)`, GLSL ES 3.00 has none and reads `uint(textureSize(t, 0).z)` (the
lod argument is required there; the layer count is lod-invariant, so `0` is always right).

#### Integer textures — `texture2duT` / `texture2diT` (+ the array twins)

A texture whose texels are **exact 32-bit integers** rather than filtered floats — an id
map, a packed-colour table, a bitfield lookup:

```ts
const ids = resource('ids', texture2duT, { group: 0, binding: 1 })

textureLoad(ids.node, coord, 0) // → Node<'vec4<u32>'>
textureDimensions(ids.node) // → Node<'vec2<u32>'>, same as any other texture
```

Four constants: `texture2duT` / `texture2diT` and `texture2dArrayuT` /
`texture2dArrayiT`. The **load result follows the texture's element** — `vec4<u32>` off an
unsigned one, `vec4<i32>` off a signed one — so assigning it to the wrong key is a tsc
error rather than a silent reinterpretation. Both are CORE in both targets (WGSL
`texture_2d<u32>`, GLSL ES 3.00 `usampler2D`), so neither needs a capability.

**`textureSample` and `textureSampleLevel` reject these keys at tsc, by design.** Filtering
is a weighted average and interpolating integer texels is undefined, so WGSL has no
`textureSample` for `texture_2d<u32>` at all. GLSL's `texture(usampler2D, …)` _would_ work
(NEAREST), and allowing it is exactly the trap this DSL exists to avoid: it would mint a
construct that compiles on WebGL2 and cannot be expressed on WebGPU. The honest
intersection of the two targets is **`textureLoad` + `textureDimensions` +
`textureNumLayers`**, and that is the whole surface.

A multisampled integer texture is **unrepresentable** — `{ dim: '2d-ms', elem: 'u32' }`
does not typecheck, rather than throwing at emit.

`reflect()` reports the element alongside the dim (`textureElem: 'u32'`), which a host
needs to build the binding: WebGPU's `sampleType` must be `'uint'` / `'sint'`, and WebGL2
must back it with an integer internal format. Getting that wrong does **not** raise — a
texture whose format disagrees with its sampler type is merely INCOMPLETE, and
`texelFetch` on an incomplete texture silently returns 0.

##### `array<u32>` / `array<i32>` storage on WebGL2

These are what let a top-level integer storage array work on the GLSL backend. WebGL2 has
no SSBO, so a `var<storage, read>` array lowers to a data texture — and an integer one now
lowers to a **typed** texture (`usampler2D` over R32UI, `isampler2D` over R32I) instead of
failing closed:

```ts
const featIds = storageBuffer('feat_ids', u32T, { group: 0, binding: 0, access: 'read' })
featIds.at(i) // → Node<'u32'>; on GLSL this is a texelFetch, on WGSL a real SSBO read
```

Whoever allocates that data texture must give it the **matching internal format** —
`R32UI` for the `usampler2D` an `array<u32>` lowers to, `R32I` for `isampler2D`, `R32F` for
the float case. Nothing enforces the pairing at runtime: a texture whose format disagrees
with its sampler type is merely INCOMPLETE, and `texelFetch` on it silently returns 0. Read
the element off `reflect()` rather than tracking it separately.

Not the alternative you might reach for first — carrying the integers through the existing
**R32F** texture and recovering them with `floatBitsToUint`. GLSL ES 3.00 §2.1.1 permits an
implementation to flush **any** denormal to zero, and small integers are denormal f32 bit
patterns (`1u` is 1.4e-45), so that route can legally lose values. It survives on every
driver measured so far, which is precisely why it is not a foundation to build on.

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

### `diagnose` — the one "what's wrong with this?" entry

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
// …and `parens: 'minimal'` is the third axis — the smallest shipped shader:
const fs = emitGlslModule(m, 'fragment', { parens: 'minimal', plugins: obfuscate() })
```

- **`parens: 'minimal'`** — an `EmitOptions` field, not a plugin, because
  parenthesis is an emit DECISION (the IR knows the precedence exactly), not a
  rewrite of emitted text. Default `'full'` keeps today's bytes, so every
  committed golden and baked artifact is untouched unless you ask. `'minimal'`
  omits a paren only where WGSL and GLSL ES 3.00 define the SAME precedence —
  `* / %` over `+ -` over unary `-`. The relational, logical, bitwise and shift
  operators stay wrapped on purpose: WGSL does not give them a chaining
  precedence at all (mixing them unparenthesised is a compile error there), so
  ranking them would invent a rule one target lacks. Never reassociates —
  `a + (b + c)` keeps its parens, because in floating point that is a different
  number from `a + b + c`.

- **`mangle({ renames? })`** — an `EmitPlugin` (a Vite-style factory). Renames
  helper fn names, plain struct names, module consts (including the injected
  `df64_*` library), **helper-fn params, and every local** to base-52 short
  names — `a`, `b`, … `aa`. Function-scoped names restart from the same pool in
  every function, so the short end of the alphabet is reused instead of counting
  upward; that reuse is where the bytes are (the optimizer's own `_cse0`/`_v0`
  machine names were the single heaviest identifier cost in the shipped text).
  Deterministic per module — the two GLSL stage emits (separate calls) always
  agree on shared names, so programs still link. Pass a `Map` as `renames` to
  receive authored → emitted names: the shader "source map" for decoding
  production driver logs and GPU captures; a function-scoped entry is keyed
  `authoredFn.authoredName`. Keep it out of the shipped bundle.
- **`minify({ numbers? })`** — an `EmitPlugin` that compacts the emitted string.
  It LEXES the text and re-emits the token stream, writing a separator only
  where maximal munch would otherwise merge the boundary (`a- -b` keeps its
  space, `)->f32` and `a=b*c` lose theirs) — the same rule the real compilers
  use, so it needs no conservative carve-outs. Comments (`//` and `/* */`) go;
  `#` directives keep their own line. Numeric literals are canonicalised
  LOSSLESSLY — `0.500` → `.5`, `1.0` → `1.`, `1.0e-07` → `1e-7`, and the
  EXPONENT spelling wherever the fixed form pays for zeros (`.0001` → `1e-4`,
  `1000000.` → `1e6`), which is exact because only the decimal point moves;
  never a
  significand digit dropped, and a float with no exponent always keeps its `.`
  (`1.0` → `1.`, never `1`, which is an integer in WGSL). `{ numbers: 'f32' }`
  goes further and re-spells each float as the shortest decimal that rounds to
  the SAME f32 — `0.800000011920929` is nothing but the f64 printout of
  `fround(0.8)`, and `.8` loads identical bits. That is exact rather than lossy
  BECAUSE a decimal float literal in an f32 context is rounded to f32 by the
  compiler, and this emitter's `lit()` spells only bool / i32 / u32 / f32 — but
  it is a claim about the CONTEXT, so the mode stands down to the lossless
  canonicalisation for any shader mentioning `f16`. `obfuscate()` uses it. Pass
  `{ numbers: false }` to leave literals as emitted when diffing against a
  hand-checked baseline.
  [`minifyShaderText`](https://x-gis.github.io/X-GIS/api/emit-prod/functions/minifyShaderText)
  is the raw function it wraps, for a string you already hold.
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
- **`prune()`** — an `EmitPlugin` that drops redundant GLSL forward prototypes.
  The GLSL backend emits one for EVERY helper because it cannot promise the
  function section is in dependency order; this drops the ones whose DEFINITION
  already declares the function at each of its uses, and keeps every other —
  no definition in this text (an extern body), a call before the definition, a
  declarator shape it does not recognise. No-op on WGSL, which resolves
  module-scope declarations out of order and has no prototype syntax. Worth its
  own pass on real payloads: 22_268 chars / 487 lines, **3.0%**, of the
  production-transformed map shader corpus — where a module drags in the df64
  library and the projection graph. The example corpus barely shows it, which is
  why it was found only by measuring the real one.
- **`aliasTypes()`** — an `EmitPlugin` that gives each heavily-used TYPE a
  one-character name and declares it once: WGSL `alias A=vec2<f32>;`, GLSL
  `#define A vec2`. Both targets accept the short name everywhere the type was
  spelled, CONSTRUCTOR position included (`A(1.,2.)`) — verified on real Tint
  and real ANGLE. This is the one heavy vocabulary `mangle()` may not touch,
  because both languages reserve type names; after mangling it is the largest
  remaining category in the shipped text. Each spelling must pay for its own
  declaration or it is skipped, so a one-use `mat4x3<f32>` is left alone, and
  alias names are drawn only from spellings that occur NOWHERE else (a GLSL
  `#define` is textual and module-wide — it must not capture a live identifier).
  A type carrying a precision qualifier (`precision highp float;`) is never
  rewritten. The pass splices by token offset, so it composes in either order
  with `minify()` and leaves the rest of the formatting untouched. It reports
  `type → alias` into the same `renames` map `mangle()` fills, so ONE map
  decodes both.
- **`decodeShaderLog(log, renames)`** — the half that USES that map. The emitted
  text is unreadable on purpose, so a shipped driver error reads
  `no matching overload in 'b' for arg of type 'l'`; this turns it back into
  `terrain_shade` and `vec2<f32>`. Substitution is TOKEN-wise, so the driver's
  own prose, line numbers and source excerpts are untouched. A name that inverts
  uniquely (module-scope names, type aliases — what a driver actually names) is
  replaced; a function-scoped name is deliberately reused across functions, so
  one that inverts to several is ANNOTATED with its candidates
  (`f⟨coordinate (in noise) | tint (in shade)⟩`) rather than guessed at.
  `invertRenames(renames)` exposes the same table as data. Keep `renames` — and
  this decoder — out of the shipped bundle; both live on `/emit-prod`.
- **`obfuscate({ renames? })`** — the standard preset, `[mangle(opts), prune(),
aliasTypes(opts), minify({ numbers: 'f32' })]`. Spread it into `{ plugins }`, and
  pair it with `parens: 'minimal'` for the smallest shipped shader: over the
  example corpus the four axes together take plain emit from 186_527 chars to
  100_296 (**−46.2%**).

Plugins fire STAGED like Vite: every plugin's `transformIR` (IR stage) runs in
array order before the module is assembled, then every plugin's `transformText`
(string stage) runs in array order — so `inline()` and `mangle()` (both IR)
compose in the order you list them, ahead of `aliasTypes()` and `minify()` (both
text), which compose in array order with each other.

**Asserting "prod is dev, optimized"** — hand the SAME plugin array to
`semanticDiff` as `transforms` and the differences your declared pipeline provably
causes are classified out of the four buckets into `explained`, each entry naming
the plugin, the bucket, and the fact line (#1806):

```ts
const d = semanticDiff(devModule, prodModule, { transforms: [inline(), ...obfuscate()] })
isSemanticallyEqual(d) // true ⇔ prod differs from dev ONLY as the declared pipeline dictates
d.explained // [{ transform: 'inline', bucket: 'controlFlow', line: '…' }, …]
```

Classification is by construction, not by resemblance: a line moves to `explained`
only when applying the declared plugin's own `transformIR` to the dev side actually
removes it from the diff. A regression that merely LOOKS like an optimizer rewrite
stays in its bucket, so a dev↔prod parity gate budgets only the unexplained residue.
Text-stage plugins explain nothing (the comparator never sees emitted text), which is
why declaring the full production array — text plugins included — is safe.

**The ABI boundary — never renamed:** entry-point names (WebGPU `entryPoint`),
**entry-point PARAM names**, binding names including the `_fp64` guard (hosts
resolve by name), binding-struct names (the GLSL UBO block tag), and struct
FIELD names (std140 packing + GLSL varyings link vertex↔fragment by name).
`reflect()`-driven hosts bind unchanged. A fn containing a `raw` stmt makes the
mangle a no-op for the whole module (textual references are invisible to the
rename).

Entry params are on that list because a non-struct one **is** the GLSL varying
name — the fragment side spells it `inName(p.name)` while the vertex side spells
the same varying from its RETURN STRUCT's field name, in a separate emit call.
Renaming one side links to nothing. Helper-fn params have no such reader, so
they are renamed.

Every renderable example is compiled AND pixel-compared through `obfuscate()`
on real Tint + ANGLE by `playground/e2e/_emit-obfuscate-gate.spec.ts`, and
`examples/minify-safety.test.ts` asserts the minifier's own property over the
whole example corpus: the lexed TOKEN STREAM and every literal's VALUE are
unchanged across minification, and the pass is idempotent.

## 9. GLSL float precision — `floatPrecision` (#1673)

The GLSL ES 3.00 backend emits `precision highp float;`. Mobile GPUs pay real
bandwidth and power for highp where mediump suffices, so `emitGlslModule` /
`emitGlslStages` take a **build-time** knob:

```ts
const fs = emitGlslModule(m, 'fragment', { floatPrecision: 'mediump' })
```

`'highp'` is the default and is **byte-neutral** — omit the option and you get
the exact bytes the backend has always emitted.

**Caveats — read before reaching for it.**

- **It is a whole-stage default, so it covers positions and coordinates too.**
  mediump is ~fp16: roughly 3 decimal digits over a ±65504 range. A projected
  map coordinate does not survive that; f32 already collapses at deep zoom,
  which is the entire reason the df64 emulation exists (§7 above, and
  `examples/fp64-deep-zoom.ts` for the picture). Use this **only for
  fragment-colour-class shaders** whose output is a bounded, low-dynamic-range
  colour — never for a stage computing a position, a tile/world coordinate, or
  a df64 lane.
- **It touches the float line only.** `precision highp int;` stays highp — the
  storage→data-texture emulation's index math and the bitcast lanes need the
  full int range — and so does the `precision highp sampler2DArray;` line
  (§4.5.4, a separate requirement).
- **Build-time, not a runtime device probe.** Emitted GLSL is cached under a
  `shaderRequestKey` with no precision component, so a runtime-varying
  precision would hand a mediump program to a highp request.
- **CI cannot judge the numeric effect, and does not pretend to.** The census
  in `playground/e2e/_glsl-compile-gate.spec.ts` measured the CI rasterizer
  (ANGLE/SwiftShader, Vulkan 1.3): `getShaderPrecisionFormat` **advertises**
  MEDIUM_FLOAT as `{rangeMin: 15, rangeMax: 15, precision: 10}` against
  HIGH_FLOAT's `{127, 127, 23}` — i.e. it claims fp16 — yet a shader compiled
  under `precision mediump float;` there **behaves as f32**: the probe
  `((1.0 + 2⁻¹²) − 1.0) × 4096.0` reads 255 (survived) on the mediump arm,
  identical to the highp control. (Either the stack computes mediump at ≥f32,
  or its compiler reassociates the `(1+ε)−1` form — GLSL ES 3.00 has no
  `precise` qualifier to forbid that — and the two are indistinguishable from
  outside, which layer of ANGLE/SwiftShader is responsible included.) A
  precision format is a declared _minimum_, not a promise. Either way, no CI
  pixel gate can distinguish a highp emit from a
  mediump one; the gates here cover **header shape** (unit) and **compile +
  link validity** (Playwright), and real-device mediump behavior — the actual
  bandwidth win, the banding it can cause, the range clipping — is an
  **explicit skip**, verifiable only on real mobile hardware.

## 10. Capabilities & extensions — `enables` (#1670)

A module declares the GPU features its emit needs, by **neutral id** — never a raw
`EXT_*` / `OVR_*` string (#1650):

```ts
module({ enables: ['floatRenderTarget'], funcs: [vs, fs] })
```

Each id folds into the capability gate, so a backend that cannot spell it **fails
closed** (`UnsupportedFeatureError` / `SD0030`, message naming the cap) instead of
emitting source the driver rejects. Resource caps (`storageBuffer`, `compute`,
`msaaTextureLoad`) are DERIVED from the module's shape and are never declared here —
`enables` is typed `readonly DeclarableCapability[]` (`Capability` minus those three), so
naming one is a **compile error**, not a silent no-op.

Each backend owns ONE `capProfile` table — neutral id → `{ directive?, hostFeature? }` —
and that table is the single authority: coverage is built from its keys, the directive
header from its rows' `directive`s, and the host-activation list from their
`hostFeature`s.

| `enables` id        | WebGL2 / GLSL ES 3.00                                                           | WebGPU / WGSL                                         |
| ------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `floatRenderTarget` | host: `EXT_color_buffer_float`                                                  | core (nothing to request)                             |
| `float32Blend`      | host: `EXT_float_blend`                                                         | host: `float32-blendable`                             |
| `float32Filterable` | host: `OES_texture_float_linear`                                                | host: `float32-filterable`                            |
| `multiview`         | source: `#extension GL_OVR_multiview2 : require` **and** host: `OVR_multiview2` | **unsupported** (no OVR equivalent) — fails closed    |
| `f16`               | **unsupported** (no GLSL ES 3.00 counterpart)                                   | source: `enable f16;` **and** host: `shader-f16`      |
| `subgroups`         | **unsupported** (no GLSL ES 3.00 counterpart)                                   | source: `enable subgroups;` **and** host: `subgroups` |

A cap may need **either or both** halves, so a cell lists every half that target needs.
**host:** the HOST must activate it before pipeline creation. **source:** the backend
emits the directive itself (`#extension` right after `#version 300 es`, `enable` ahead of
the declarations), deduped + sorted. A cap with a `host` half and no `source` half is
byte-neutral: declaring it moves not one emitted byte. The `32` in `float32Blend` /
`float32Filterable` is not decoration — both underlying features are 32F-only, while
`EXT_color_buffer_float` covers 16F **and** 32F, which is why `floatRenderTarget` carries
no bitwidth.

A cap can also IMPLY another: `float32Blend` pulls in `floatRenderTarget`, because
blending into a float target needs that target to be color-renderable first (with only
`EXT_float_blend` the FBO comes back INCOMPLETE). `reflect().requiredFeatures` reports the
closure, so a module declaring one gets both.

**`multiview` caveat:** the cap buys the **directive only**. The DSL cannot yet spell
`layout(num_views = N) in;` or read `gl_ViewID_OVR`, so a module declaring `multiview`
emits the `#extension` line and still renders **single-view**. It exists to prove the
`#extension` mechanism end to end (#1670); real multiview authoring is a follow-up.

### Activation authority — verify at boot, never at pipeline time

Declaring a cap does **not** activate anything. On this repo's runtimes the device
decides, at device-creation time, and it is already done by the time a module is emitted:

- **WebGL2** — the device constructor (`rhi-webgl2/src/rhi-webgl2.ts`) already
  `getExtension`s the float pair (`EXT_color_buffer_float` + `EXT_float_blend`) when both
  are present.
- **WebGPU** — `requiredFeatures` are **fixed at `requestDevice`** (`rhi-webgpu/src/gpu.ts`).
  A feature not requested there can never be added later; asking at pipeline-creation time
  is too late.

So a module author's job is to **verify**, not to request: check that the booted device
covers what the module needs, and fail loud if it does not.

The requirement list is **`reflect().requiredFeatures`** — always present, empty when the
module needs nothing, covering the derived caps and the implied ones too. The ids are
neutral because reflection is target-neutral, so translate through the target's profile
with `hostFeaturesFor`, THE host-activation lookup (it skips caps with no host half, so
there are no `undefined` holes to hand a driver):

```ts
import { hostFeaturesFor, reflect, glslEs300Backend, wgslBackend } from '@xgis/shader-dsl'

// WebGL2 — verify the already-booted context has each extension.
for (const ext of hostFeaturesFor(glslEs300Backend, reflect(m).requiredFeatures)) {
  if (!gl.getExtension(ext)) throw new Error(`WebGL2 lacks ${ext}`)
}

// WebGPU — feed the SAME lookup into requestDevice, at boot.
const device = await adapter.requestDevice({
  requiredFeatures: hostFeaturesFor(wgslBackend, reflect(m).requiredFeatures),
})
```

### Compute on WebGL2 — the portable kernel tier (#1812)

A `stage: 'compute'` entry declared `portable: true` is guaranteed to emit on **both**
backends: natively as `@compute` on WGSL (zero byte change — `portable` is not a WGSL
attribute), and on GLSL ES 3.00 through the compute→fragment-GPGPU lowering
(`lowerComputeToFragment`) run with **no emit option**. In exchange the kernel must stay
inside the **gather-only tier**:

```ts
const kernel = fn(
  'eval_field',
  { gid: builtin('global_invocation_id', vec3uT) },
  ({ gid }) => {
    const fid = gid.x
    // … reads only, one write …
    outColor.at(fid).assign(pack4x8unorm(color))
  },
  { stage: 'compute', workgroupSize: 64, portable: true },
)
```

- `global_invocation_id` used only as `.x` (1-D linear index).
- Exactly one `read_write` storage binding, element `array<u32>`, written **exactly once**,
  at index `gid.x` — any scatter write, a second write, or zero writes fails.
- A first `uniform` binding of type `vec4<u32>` — the **dispatch uniform**:

  | field | meaning                   |
  | ----- | ------------------------- |
  | `.x`  | invocation count          |
  | `.y`  | output-grid width (W_out) |
  | `.z`  | unused (reserved)         |
  | `.w`  | unused (reserved)         |

- No `raw` statements anywhere the entry's call graph can reach (a per-target escape hatch
  contradicts the portability claim).

Anything outside that shape fails validation at **every** emit, on both writers, with
`SD0111` and a per-violation remedy — declaring `portable` without `stage: 'compute'` fails
at build time with `SD0110`. `analyzePortableKernel` (`core/passes/portable-kernel.ts`) is
the single authority for the shape; the lint rule `portable-kernel` runs it at every
`validate()`.

**Host contract:** the WebGL2 lowering changes how the kernel is _dispatched_, not just how
it is _emitted_ — the host must submit a fullscreen **draw** into an R32UI target instead of
a compute dispatch. `rhi-webgl2/src/compute-webgl2.ts` already absorbs this difference, so a
kernel author does not choose it per call site; declaring `portable` is what lets the
WebGL2 RHI recognize the kernel as eligible for that path.

**Outside the tier:** barriers, workgroup memory, atomics, scatter writes, and multi-output
kernels are not in v1 — none of those are authorable in the DSL today except via the shapes
`SD0111` already rejects. A kernel that needs one of them stays WebGPU-only (omit
`portable`), or is restructured into multiple gather-only passes.

**`emulateCompute` is deprecated** in favor of this tier: pass `portable: true` at the
authoring site instead of `emulateCompute: true` at the emit call site. The flag still works,
unchanged, as the synonym for undeclared kernels — nothing that passes it today has to
change.

## 11. Conditional programs — build-time specialisation, not `#define`

A shader that must differ by feature — elevation present or absent, 3D or flat, an
extension available or not — is the case a GLSL codebase reaches for `#define` and an
`#ifdef` ladder. **This DSL has no preprocessor, and does not need one.** A module is an
ordinary JavaScript value returned by an ordinary function, so the thing that varies is a
**function parameter**, and a plain `if` decides what goes into the IR. Nothing is
stripped later; the arm that loses is never built.

Three different questions hide under "the program changes", and they have three different
answers. Picking the wrong one is where the pain comes from.

### The program's SHAPE differs → specialise at build time

Take the real case in `map/src/shaders/dsl/hillshade.ts`. Five hillshade methods, and a
layer draws one of them:

```ts
const buildFs = (pickEnabled: boolean, methodFlag: number) => {
  // Each method is a named builder, NOT inlined into the dispatch chain — which is what
  // makes it possible to emit one alone.
  const METHOD_BODY: ReadonlyArray<() => ReadonlyNode<'vec4<f32>'>> = [/* …five… */]

  const outColor =
    methodFlag >= 0
      ? METHOD_BODY[Math.min(4, methodFlag)]!() // ONE arm, no dispatch at all
      : when(
          // methodFlag < 0 → runtime 5-way
          [
            [method.lt(0.5), METHOD_BODY[0]!],
            [method.lt(1.5), METHOD_BODY[1]!],
            [method.lt(2.5), METHOD_BODY[2]!],
            [method.lt(3.5), METHOD_BODY[3]!],
          ],
          METHOD_BODY[4]!,
        )
  // …
}
```

One source, two shapes. `methodFlag >= 0` emits **that method's math alone** — no branch,
no other arm's temporaries, no register pressure from code that never runs. `< 0` keeps
the runtime chain, for a caller that genuinely cannot decide until draw time.

The elevation question is the same shape. Write the builder to take the fact:

```ts
const buildTerrain = (hasElevation: boolean) => {
  const bindings = hasElevation ? [demTexture.binding, demSampler.binding] : []
  const height = hasElevation ? sampleDem(uv) : f32(0)
  return module({ bindings, funcs: [vs(height), fs] })
}
```

This is strictly better than `#ifdef ELEVATION`, and not only for taste: when
`hasElevation` is false the DEM binding **is not declared**, so it is absent from
`reflect()`, absent from the bind-group layout, and the host never creates a resource for
it. With a preprocessor the declaration survives in the source and the layout has to be
kept in sync by hand — the classic way a "disabled" feature still costs a binding slot.

### A VALUE differs, but the shape does not → `override`, not a rebuild

If every variant would emit the _same_ program with a different constant, do not
specialise — that multiplies pipelines for nothing. Use specialization constants:
WGSL emits `override` and the host pins them via `createRenderPipeline({ constants })`;
GLSL ES 3.00 has no driver-side equivalent, so the backend re-emits with a hard
`#define NAME <value>` after the `#version` preamble — never prepended, which GLSL
rejects, since `#version` must lead the source. The knob is `overrideValues` on
[`GlslEmitOptions`](/api/index/interfaces/GlslEmitOptions), whose own TSDoc is the
authority for its shape; the values come from `reflect().overrides`. That `#define` is the
ONLY one in the system, it is generated, and it carries a value — never a branch.

The rule of thumb: **if the two variants would compile to the same instruction sequence
with one literal changed, it is an override. If they compile to different code, it is a
build-time parameter.**

### A CAPABILITY may be missing → declare it, and it fails closed

`enables` (§10) is not a fallback mechanism — it is the opposite. A module that declares
`f16` on a backend that cannot spell it throws `UnsupportedFeatureError` / `SD0030` naming
the cap, rather than emitting source the driver will reject. That is what you want for a
hard requirement.

A genuine **fallback** is two modules, chosen by the host, because the choice belongs at
boot where the device is already known (§10's activation-authority rule — WebGPU's
`requiredFeatures` are fixed at `requestDevice` and can never be added later):

```ts
const caps = reflect(fancy).requiredFeatures
const ok = hostFeaturesFor(glslEs300Backend, caps).every((e) => gl.getExtension(e))
const m = ok ? fancy : plain // two modules, one decision, made once
```

### Whatever you specialise on becomes part of the shader's identity

This is the part that bites, and it is not obvious. A specialised program is a _different
program_, so every axis you specialise on has to appear in every key that names it:

- the **pipeline cache** — `map/src/render/material/hillshade-material.ts` keeps one
  `Material` per `` `${methodFlag}:${pick}` ``, because the fragment carries only that
  method's math and a shared pipeline would be the wrong program;
- the **baked-shader id**, if the family is baked (#1679). The bake serves bytes by id
  _without running the builder_, so an id that does not mention `methodFlag` hands one
  method's compiled shader to another method's draw. It compiles, it links, it renders,
  and it is wrong — the failure has no error, only wrong pixels.

If you add an axis to a builder, add it to the key in the same commit. A key that does
not describe what the builder would emit is the sharpest footgun in this codebase.

## 12. Migrating a GLSL shader — what to reach for (#1717)

`§1`–`§11` are organised for someone authoring greenfield. This section answers the
question a MIGRATING consumer actually asks: **my GLSL does X — what is the DSL spelling,
and does it survive on WGSL?**

It exists because that lookup failed in practice. A real migration re-solved several
problems the DSL already solved, purely because the feature was filed under a name nobody
knew to search for. Every row below is a thing that was rebuilt by hand at least once.

| GLSL construct                                     | DSL spelling                               | WGSL result                             | Notes                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | ------------------------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uniform Block { … }` (ours)                       | `uniformStruct` (§4)                       | `@group/@binding var<uniform>`          | std140 layout comes from `reflect()`; never hand-count offsets                                                                                                                                                                                        |
| `uniform float u_x;` (host prelude declares it)    | `externVar`                                | the same reference, spelled per target  | emits NOTHING; lands in `reflect().requires`                                                                                                                                                                                                          |
| `uniform float u_x;` (we declare it, host owns it) | `hostUniform`                              | `@group/@binding var<uniform>`          | GLSL emits a LOOSE default-block uniform, not a block; `reflect()` marks `owner: 'host'`                                                                                                                                                              |
| a whole BLOCK the host owns                        | `hostBlock`                                | one `@group/@binding var<uniform>`      | `glsl: 'loose'` flattens it to one uniform per member and rewrites `blk.field` → `field` ON THE IR; `'std140-block'` (default) keeps the block. WGSL keeps the block either way — a host bind group is one unit                                       |
| a host-provided FUNCTION                           | `externFn`                                 | same call, per-target spelling          | typed at the call site; no declaration emitted                                                                                                                                                                                                        |
| `#ifdef FEATURE` — **we** decide                   | a builder parameter and a plain `if` (§11) | no preprocessor                         | preferred: the losing arm is never built, so its bindings are never declared                                                                                                                                                                          |
| `#ifdef FEATURE` — the **host** decides            | `variantFamily`                            | one module per point in the matrix      | `emitGuarded` generates the `#if` ladder for a GLSL host that owns the define; every arm is byte-identical to the standalone variant. For a ladder that goes inside an `#include`, use `emitGuardedFragment` — same ladder, preamble returned as data |
| a variant that changes only a VALUE                | `overrideConst` + `overrideValues` (§11)   | `override` + pipeline constants         | do NOT specialise: that multiplies pipelines for nothing                                                                                                                                                                                              |
| `#include "helper.glsl"`                           | `emitGlslFragment` / `emitFragment`        | a module fragment the host concatenates | returns `preamble` as DATA; never strip a header with a regex                                                                                                                                                                                         |
| a statement-level variant slot inside one module   | `composeModule` + `placeholder` (§1)       | same                                    | statement slots only — it contributes no consts/structs/bindings, so it is not an `#include` substitute                                                                                                                                               |
| `precision highp …` on one declaration             | the `precision` option on `hostUniform`    | n/a (WGSL has no precision qualifiers)  | the stage preamble is the default; this is for a fragment composed into a host program                                                                                                                                                                |
| `usampler2D` / `isampler2D`                        | `texture2duT` / `texture2diT` (§4)         | `texture_2d<u32>` / `texture_2d<i32>`   | the sampler precision line is emitted for you                                                                                                                                                                                                         |
| `#extension … : require`                           | `enables` (§10)                            | `enable …;`                             | fails closed (`SD0030`) on a backend whose `capProfile` has no row                                                                                                                                                                                    |
| comparing two emits after an optimizer pass        | `semanticDiff`                             | same                                    | compares IR + reflection, so folding and renaming do not drown the diff; declare your prod plugins as `transforms` and their rewrites classify into `explained` instead of the fail-able buckets (§8)                                                 |

### The builtin-value vocabulary — `gl_*` name → WGSL id

`builtin(name, type)`'s vocabulary is WGSL's, typed as `WgslBuiltinName` — a `gl_*`
spelling or a typo is a `tsc` error naming the union. This lookup exists because the
reverse direction failed in practice: a GLSL-minded author reached for `frag_coord`
(accepted by the GLSL writer at the time), and the module died only when the WGSL
writer ran.

**Upgrading from a build where `frag_coord` emitted fine?** It did — on GLSL only. That
alias was retired (#1805) precisely because of the asymmetry: a module authored against it
compiled on WebGL2 and failed on WGSL, so the trap only sprang on the target you were less
likely to be testing. Both writers now reject it with the same remedy — spell it
`builtin('position', vec4fT)` on the fragment input. The rename is spelling-only: GLSL
still reads `gl_FragCoord` and the emitted bytes do not move.

| GLSL global                      | DSL spelling                                       | Notes                                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gl_Position`                    | `builtin('position', vec4fT)` on the VERTEX output | writes `gl_Position` on GLSL                                                                                                                                                                                  |
| `gl_FragCoord`                   | `builtin('position', vec4fT)` on a FRAGMENT input  | reads `gl_FragCoord` on GLSL. Mind the y-origin: GL window space is bottom-left, WGSL framebuffer space top-left — flip per target (or derive y-symmetric) before consuming `.y`                              |
| `gl_VertexID`                    | `builtin('vertex_index', u32T)`                    | GLSL wraps the read as `uint(gl_VertexID)` (the DSL types it u32, GLSL's is int)                                                                                                                              |
| `gl_InstanceID`                  | `builtin('instance_index', u32T)`                  | same uint() wrap                                                                                                                                                                                              |
| `gl_FrontFacing`                 | `builtin('front_facing', boolT)`                   |                                                                                                                                                                                                               |
| `gl_FragDepth`                   | `builtin('frag_depth', f32T)` as the return attr   |                                                                                                                                                                                                               |
| `gl_PointSize` / `gl_PointCoord` | — unsupported on BOTH writers                      | not a WGSL gap being imposed on GLSL: point sprites have per-vendor size caps, and the map dropped them for instanced quad expansion (`map/src/shaders/dsl/point.ts`) — the emit error's remedy says the same |
| float `mod(x, y)`                | the free fn `mod()` (floor-mod)                    | `.mod()`/`%` is TRUNC-mod (WGSL semantics) and now spells portably on GLSL too — pick by the semantics you mean on negatives                                                                                  |

**Targeting WebGL2 only?** Nothing above narrows what the GLSL writer can express — the
neutral names are spellings, not capabilities, and several of this vocabulary's rules
exist to make WebGL2 output MORE defined (`round` emits `roundEven`; float `%` emits a
trunc-mod GLSL ES 3.00 actually compiles). For GLSL-only constructs the neutral surface
does not model, `rawStmt` (§1) accepts a `{ glsl }`-only payload: the GLSL writer splices
it verbatim, and if the WGSL writer ever runs on that module it fails CLOSED (SD0030)
naming every site to port — the deliberate shape for a consumer who excludes WebGPU
today but may not forever.

### Does it survive on WGSL?

`capabilityMatrix([wgslBackend, glslEs300Backend])` answers that per capability, derived
from the backends' own `capProfile`s rather than transcribed — so it cannot go stale
against them. §10 explains the three support classes it reports; `SD0030`'s hint points
back here when an emit fails closed.

Two honesty notes a reader needs before trusting a row:

- **Support is not reachability.** `f16`, `subgroups` and `multiview` have profile rows and
  emit their directives, and NONE of them can be authored today — there is no f16 scalar,
  no subgroup intrinsic, and neither `num_views` nor `gl_ViewID_OVR`. The matrix reports
  what the profile says; `capability-reachability.test.ts` is where the allowlist of
  known-unreachable caps lives, with a reason each.
- **A missing row is a hard stop, by design.** It is not a hint to work around: emit throws
  rather than writing source the driver would reject.

## Quick reference

| Need                           | Write                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------- |
| A function                     | [`fn`](https://x-gis.github.io/X-GIS/api/index/functions/fn) — return type inferred                       |
| An entry point                 | `fn(name, { vid: builtin('vertex_index', u32T) }, body, { stage: 'vertex' })`                             |
| A module                       | `module({ consts, structs, bindings, funcs })`                                                            |
| An intermediate value          | plain `const x = expr`                                                                                    |
| Mutate it                      | `x.assign(v)` (auto-materialises a `var`)                                                                 |
| A literal in an op             | bare number — `x.add(1)`, `vec4(p, 0, 1)`                                                                 |
| deg↔rad                        | `radians(x)` / `degrees(x)`                                                                               |
| Branch (statement)             | `If(c, …).elif(c, …).else(…)`                                                                             |
| Branch (value)                 | `when(c, ()=>a, ()=>b)` / `when([[c,()=>a]], ()=>b)` (was `ifExpr`/`condExpr`)                            |
| Exhaustive integer dispatch    | `enumU32({A:0,B:1})` + `matchEnum(s, E, { A:()=>…, B:()=>… })` (missing arm = compile error)              |
| Integer dispatch               | `Switch(s).case(n, …).default(…)`                                                                         |
| Loop fold (value)              | `reduce(init, i0, cond, (acc,i)=>…, step)`                                                                |
| Early return                   | `Return(v)` / `ReturnIf(c, v)`                                                                            |
| IO struct                      | `ioStruct(name, { f: builtin(...)/location(...) })` → `.of(n).f`, `.construct({…})`, `.type`, `.decl`     |
| Uniform                        | `uniformStruct(name, at, fields)` → `.field.f`, `.struct`, `.binding`                                     |
| Storage element struct         | `structDecl(name, fields)` → `.of(n).f`, `.type`, `.decl`                                                 |
| Storage buffer                 | `storageBuffer(name, Element, at)` → `buf.at(i).f`                                                        |
| Texture / sampler              | `resource(name, type, at)` → `.node`, `.binding`                                                          |
| A shared const                 | import the handle (`PI`, `EARTH_R`) — not `constRef('NAME')`                                              |
| A hand-written (raw) statement | `rawStmt({ wgsl, glsl })` / `b.raw(…)` — verbatim per target; a missing side fails closed on that backend |
| Double precision               | declare values as `f64T` — same operators; `toF64`/`toF32` to convert; write 1.0 to the auto `_fp64`      |
| A non-scalar const             | `constExpr(name, type, valueNode)` — `vec4` / `arrayLit` / struct literal                                 |
| Call a function                | import the `FnHandle`, call directly — not `callFn('name')`                                               |
| Diagnose a module              | `diagnose(m, { backend })` → `formatReport(report)` (lint + caps, no throw)                               |
| Need a GPU extension/feature   | `module({ enables: ['floatRenderTarget'] })` — host activates from `reflect().requiredFeatures`           |
| Source locations in errors     | `setSourceTracing(true)` (dev-only, off by default, never on emit)                                        |
