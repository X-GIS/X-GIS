---
title: 'Adding a shader-compiler pass without touching the compiler'
description: "The emit path of @xgis/shader-dsl grew a Vite/Webpack-style plugin seam so ship-time transforms compose without weighing on the core — and a build-only subpath so runtime-emit consumers bundle zero bytes of them. The test: dropping in a third transform (call-graph inlining) that touched no core line."
date: 2026-07-08
tags: ['shader-dsl', 'compiler', 'architecture', 'tooling']
lang: en
---

The [previous post](/blog/2026-07-08-minifying-and-mangling-shaders) added two
ship-time transforms to the shader emitter — minify and mangle. They worked, but
the way they were wired was wrong, and fixing that wiring is a small story about
where to put a seam.

## The wrong shape

The first cut hardcoded the transforms into the emit function:

```ts
function emitModule(m, be, opts) {
  const lowered = lowerForBackend(m, be)
  const code = assembleLowered(opts?.mangle ? mangleModule(lowered) : lowered, be)
  return opts?.minify ? minifyShaderText(code) : code
}
```

Two problems, both structural. First, the `opts` check lives *inside* `emitModule`,
so `mangleModule` and `minifyShaderText` are unconditional imports — every consumer
bundles them even with the options off, and nothing tree-shakes. That matters here
because this DSL emits shaders **at runtime** as well as at build time: the map
engine compiles shader variants in the browser. A runtime consumer should not carry
a build-time minifier it never calls. Second, the emit core now *knows about* mangle
and minify by name — and the next transform, and the one after, each accreting onto
the path the runtime pays for.

## The seam

Invert it. The core exposes a neutral seam — the Vite/Webpack shape, a
`{ plugins: [...] }` bag of named units — and knows nothing about what any plugin
does:

```ts
interface EmitPlugin {
  name: string
  transformIR?: (lowered: ModuleDecl) => ModuleDecl // before assembly
  transformText?: (code: string) => string          // on the emitted string
}

function emitModule(m, be, opts) {
  const lowered = applyIRPlugins(lowerForBackend(m, be), opts)
  return applyTextPlugins(assembleLowered(lowered, be), opts)
}
```

Hooks fire **staged across all plugins**, the way Vite runs every plugin's
`resolveId` before any `load` [1]: every `transformIR` runs (in array order) on the
lowered module, the backend assembles it to a string, then every `transformText`
runs. Two stages because the two natural places to transform a shader are *before*
it's text (rename a symbol, inline a function — you want the IR) and *after* (compact
the whitespace — you want the string).

The implementations move to a separate entry point, `@xgis/shader-dsl/emit-prod`, and
are Vite-style plugin factories:

```ts
import { mangle, minify, obfuscate } from '@xgis/shader-dsl/emit-prod'
const wgsl = emitModule(m, { plugins: [mangle({ renames }), minify()] })
```

A consumer that never imports the subpath bundles **zero bytes** of the transform
code — the same split the lint/measure tooling uses on `@xgis/shader-dsl/dev`. Build
toolchains import it; the runtime emit path does not.

## The test of a seam: does the next thing fit?

A seam you designed around two known transforms can still be the wrong seam. The way
to find out is to add a *different kind* of transform and see what breaks. So: `inline()`
— flatten the call graph by inlining every single-return helper into its call sites,
so the functions disappear from the shader. Structurally unlike minify (it rewrites
the IR, not the text) and unlike mangle (it removes declarations, not just renames
them).

Here is the entire plugin:

```ts
export function inline(): EmitPlugin {
  return { name: 'inline', transformIR: inlineAll }
}
```

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

The risk of a plugin pipeline is that `[inline, mangle, minify]` compiles and links
and still draws the wrong thing — a rewrite that broke *semantics*, not syntax. So the
CI gate renders the plain shader and the fully-transformed shader with identical inputs
and asserts the two framebuffers are **byte-identical**, on real Tint and ANGLE. It runs
the whole pipeline, including the df64 path, so any plugin — present or future — that
corrupts a pixel fails the gate regardless of how it composes. The seam made the
transforms pluggable; the pixel-diff makes the composition trustworthy.

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
