---
name: shader-dsl-ret-inference-string-collapse
description: shader-dsl fn() return-type inference collapses to bare `string` for void-Return bodies and propagates — fix the deepest root's final Return→native return
triggers:
  - 'fn return type inference'
  - 'Node<string> not assignable to Node'
  - 'R extends string'
  - 'inferReturnType'
  - 'fn ret token'
  - 'shader-dsl fn()'
---

# shader-dsl fn() ret-inference — the `R extends string` collapse

## The Insight

`@xgis/shader-dsl`'s `fn()` infers its WGSL return type from the body (`inferReturnType(result, stmts)` in
core/ir/builder.ts). TS cannot REVERSE the `KeyOf<R>` mapped type (key→ShaderType), so the FnHandle is keyed
by the return-KEY string `R extends string`, and the call returns `Node<R>`. The trap: when a body returns
its value via ambient `Return(value)` **statements** (no native trailing `return value`), the body's TS
result is `void`, so TS infers `R = string` (bare) — and `Node<string>` is NOT assignable where a precise
`Node<'vec4<f32>'>` is expected. Worse, the bare `string` **propagates**: any fn that returns the value of
another now-`string` fn also collapses to `string`.

## Why This Matters

Dropping the explicit ret token from a fn whose body ends in `Return(x)` (not `return x`) silently widens
every downstream typed consumer to `Node<string>`, producing a cascade of `TS2345 number/Node<string> not
assignable` errors that look unrelated to the fn you changed.

## Recognition Pattern

- You removed the explicit ret token from `fn('name', params, RET, body)` → `fn('name', params, body)`.
- tsc errors `Node<string> is not assignable to parameter of type Node<'…'>` appear at the fn's CALL sites
  (and at callers of those callers), not at the fn itself.
- The offending fns use `Return(x)` / `ReturnIf(c, x)` as their final return, or end in an if/else guard.

## The Approach

1. Find the DEEPEST root fn (the one whose own body returns a concrete value) and convert its FINAL
   `Return(x)` → native `return x`. This lowers to the IDENTICAL `{s:'return', expr}` Stmt, so the emit is
   byte-identical — only the TS inference changes (now `Node<KeyOf<x>>`, not void→string).
2. Re-run tsc; the `string` infection recedes one layer. Iterate root-first until clean.
3. If a body genuinely CAN'T end in a native return (a `project`-style void helper, or a pure if/else
   guard-return like `sdf_shape`), KEEP its explicit ret token — the explicit-ret overload still exists.
   (In this codebase exactly 2 fns kept it: `project` vec2fT, point `sdf_shape` f32T.)

Roots that needed the native-return fix here: apply_log_depth, compute_log_frag_depth, needs_backface_cull,
rim_alpha, project_geom.
