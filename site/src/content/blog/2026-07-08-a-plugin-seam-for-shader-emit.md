---
title: 'Adding a shader-compiler pass without touching the compiler'
description: "The emit path of @xgis/shader-dsl grew a Vite/Webpack-style plugin seam so ship-time transforms compose without weighing on the core — and a build-only subpath so runtime-emit consumers bundle zero bytes of them. The test: dropping in a third transform (call-graph inlining) that touched no core line."
date: 2026-07-08
tags: ['shader-dsl', 'compiler', 'architecture', 'tooling']
lang: en
---

The [previous post](/blog/2026-07-08-minifying-and-mangling-shaders) added two
ship-time transforms to the shader emitter — minify and mangle. They worked, and
they *shipped* — with the wiring wrong. This post is what the wiring was, why it
was wrong, and the inversion that fixed it. (A [prior migration in this
codebase](/blog/2026-07-08-your-pipeline-is-a-string) taught the same lesson from
the other direction; putting a seam in the wrong place is the recurring mistake.)

## The wrong shape (as shipped)

The first version to land took the transforms as boolean options on the emit
call and branched on them *inside* the core:

```ts
// as shipped: emit core hardcodes mangle + minify
function emitModule(m, be, opts) {
  const lowered = opts?.mangle ? mangleModule(lowerForBackend(m, be)) : lowerForBackend(m, be)
  return opts?.minify ? minifyShaderText(assembleLowered(lowered, be)) : assembleLowered(lowered, be)
}
```

Two problems, both structural. First, the `opts` check lives *inside* `emitModule`,
so `mangleModule` and `minifyShaderText` are unconditional imports — every consumer
bundles them even with the options off, and nothing tree-shakes. That matters here
because this DSL emits shaders **at runtime** as well as at build time: the map
engine compiles shader variants in the browser. So the shipped shape forced a
browser that only ever wants a plain shader to download the whole build-time
toolchain anyway — the ~210-line identifier mangler and the minifier — dead weight
it can never call. Second, the emit core now *knows about* mangle and minify by
name — and the next transform, and the one after, each accreting onto the path the
runtime pays for. The tell that a transform is pretending not to be pluggable is
that adding the *second* one edits the same core function; here the second one
already had.

## The seam

Invert it. The core stops naming any transform and just folds a `{ plugins: [...] }`
bag of named units — the Vite/Webpack shape [1] — knowing nothing about what any
of them does:

```ts
function emitModule(m, be, opts) {
  const lowered = applyIRPlugins(lowerForBackend(m, be), opts)   // every transformIR
  return applyTextPlugins(assembleLowered(lowered, be), opts)    // then every transformText
}
```

The [previous post](/blog/2026-07-08-minifying-and-mangling-shaders) covers the
rest of the shape and why it takes those forms: the `EmitPlugin` interface (two
optional staged hooks, `transformIR` before assembly and `transformText` after);
the Vite-style staging that runs *every* plugin's `transformIR` before any text
hook; the `@xgis/shader-dsl/emit-prod` subpath that keeps a runtime consumer at
**zero bundled bytes** of transform code. What that inversion *bought* — beyond
deleting the two `if (opts.x)` branches — is everything below: the core never has
to change again.

## The test of a seam: does the next thing fit?

A seam you designed around two known transforms can still be the wrong seam. The way
to find out is to add a *different kind* of transform and see what breaks. So: `inline()`
— flatten the call graph by inlining helpers into their call sites (single-return ones
by substitution, and linear multi-statement ones — a `let` prelude then a `return`,
sound to lift because shader code is pure — by splicing their statements into the
caller), so the functions disappear from the shader. Structurally unlike minify (it
rewrites the IR, not the text) and unlike mangle (it removes declarations, not just
renames them).

Here is the entire plugin:

```ts
export function inline(): EmitPlugin {
  return { name: 'inline', transformIR: inlineAll }
}
```

The tension going in was real. `inline()` doesn't tweak nodes the way mangle does
(rename in place) or minify does (compact text) — it *deletes* declarations and
rewrites who-calls-what, and it only stays correct if it runs **before** mangle,
so mangle renames the survivors and not the functions that are about to vanish.
I half-expected to need a hook the seam didn't have: a dedicated post-mangle
"structural" stage, or a priority/ordering field on the plugin, or a whole-variant
call-graph view that a single `ModuleDecl → ModuleDecl` couldn't express. It
needed none of them. `transformIR` already hands each plugin the whole lowered
module, and the stage already runs plugins in **array order** — so "inline before
mangle" is just `[inline(), mangle(), minify()]`, ordering expressed as position,
not as a new hook.

It reuses an inliner that already existed for an unrelated reason (composing the
polygon shader variants). Adding it to the production toolkit touched **no line of
the emit core** — it is one more `transformIR` in the array:

```ts
emitModule(m, { plugins: [inline(), mangle(), minify()] })
```

That is the seam validating itself: a transform the core was never designed for
drops in as data. The plugin *composition* — inline flattens, then mangle renames the
survivors, then minify compacts — is expressed at the call site, not baked into the
emitter.

## What the plugin contract has to carry

Two things the seam can't check but a plugin author must honor, so they live on the
type's doc and in the pass, not in the core:

- **Determinism.** GLSL compiles the two pipeline stages as separate strings that
  link by matching varying *names* [2]. A `transformIR` that renames or reorders must
  produce the identical result for the vertex and fragment emits, or the program
  fails to link. Every emit-prod plugin is deterministic per module by construction.
- **Opacity.** The [df64 emulation](/blog/2026-07-07-emulated-double-precision-shader-dsl)
  is a set of functions whose bodies are error-free transformations the optimizer
  could legally cancel if it saw through them. `inline()` must *not* inline those —
  so `inlineAll` carries the same `df64_`-prefix exclusion the optimizer's own passes
  do. The invariant lives in the pass, which is where it can't be forgotten, not in
  each caller.

## One gate covers every composition

The [byte-identical framebuffer gate](/blog/2026-07-08-minifying-and-mangling-shaders)
— render the plain and the transformed shader with identical inputs, assert the
pixels match on real Tint and ANGLE — was built for mangle + minify, but the
pluggable seam changes what it *guarantees*. Because the gate runs the full
`[inline, mangle, minify]` pipeline (including the df64 path), any plugin — present
or future — that corrupts a pixel in any composition fails it, without the gate
knowing the plugin exists. The seam made the transforms pluggable; the one
pixel-diff makes every composition of them trustworthy.

## Takeaways

- **Put the seam where transforms want to compose, not where the first one landed.**
  An `if (opts.x)` inside the core is a transform pretending not to be pluggable; the
  tell is that adding the second one edits the same function.
- **Build-only tooling belongs on a subpath.** If some consumers run your compiler at
  runtime, the transforms they don't use must be a separate import they don't pay for.
- **A plugin's contract is documentation the type can't enforce** — determinism,
  opacity, ordering. Write it on the seam and encode it in the pass, because the core,
  by design, won't.
- **Validate a seam by adding the transform you didn't design for.** If it fits as
  data, the seam is right; if it needs a core edit, it isn't.

## References

1. Vite, [Plugin API — hooks and ordering](https://vite.dev/guide/api-plugin) — the
   staged, named-plugin model this emit seam mirrors.
2. Khronos, [OpenGL ES Shading Language 3.00 — separate shader stages link
   inter-stage varyings by name](https://registry.khronos.org/OpenGL/specs/es/3.0/GLSL_ES_Specification_3.00.pdf).
3. LLVM, [Writing an LLVM Pass](https://llvm.org/docs/WritingAnLLVMNewPMPass.html) —
   the pass-pipeline ancestor of "transforms as composable units over an IR."
