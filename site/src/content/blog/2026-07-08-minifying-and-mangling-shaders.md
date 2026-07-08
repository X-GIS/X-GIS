---
title: 'Your bundler minifies everything except your shaders'
description: "Emitted WGSL/GLSL ships to gl.shaderSource with its authored vocabulary intact — no JS minifier reaches it. A Vite/Webpack-style emit-plugin pass (mangle + minify) that compacts and obfuscates the shader text, the ABI boundary it must never cross, and why compile-and-link is not enough to trust it."
date: 2026-07-08
tags: ['shader-dsl', 'compiler', 'tooling', 'webgpu']
lang: en
---

Run your production bundle through devtools and look at a shader. The
TypeScript that built it is minified to `_a`, `_b`, `t0` — but the string it
handed to `createShaderModule` / `gl.shaderSource` still reads
`float terrain_height(vec2 p)`, `struct DF64Vec2`, `df64_twoSum`. Every
authored name in the shader survives, because it is *data* the bundler never
parses — a string literal it copies byte-for-byte into the output.

`@xgis/shader-dsl` emits WGSL and GLSL ES 3.00 from a
[typed IR](/blog/2026-07-07-the-xgis-compiler-pipeline). This post is the
ship-time pass that does to that emitted text what the bundler does to the JS
around it — and the parts that turned out to be load-bearing.

## What "obfuscate" can and cannot mean

The shader text reaches the GPU driver as source; WebGL and WebGPU compile it
there. So there is no hiding it — a determined reader with a frame capture
sees the tokens. The honest bar is exactly the JS one: **raise the cost of
reading, shrink the bytes.** Rename the authored vocabulary to nothing
meaningful, delete the whitespace. That is minification + identifier mangling,
not encryption. Naming it correctly keeps the feature from over-promising.

## Plugins, composed like a bundler

The transforms are the kind of thing you want to turn on selectively, reorder,
and extend — so the shape is the one Vite and Webpack settled on: a
`{ plugins: [...] }` bag of named units [1][2]. Each plugin is two optional
staged hooks:

```ts
interface EmitPlugin {
  name: string
  transformIR?: (lowered: ModuleDecl) => ModuleDecl // before assembly
  transformText?: (code: string) => string          // on the emitted string
}
```

Hooks fire *staged across all plugins*, the way Vite runs every plugin's
`resolveId` before any `load`: every `transformIR` runs (in array order) on the
lowered module, the backend assembles it to a string, then every
`transformText` runs. Composing is an array:

```ts
import { mangle, minify, obfuscate } from '@xgis/shader-dsl/emit-prod'

const renames = new Map<string, string>()
const wgsl = emitModule(m, { plugins: [mangle({ renames }), minify()] })
const fs = emitGlslModule(m, 'fragment', { plugins: obfuscate() }) // the [mangle, minify] preset
```

The **core emit knows nothing about mangle or minify** — it only folds the
plugin arrays. The implementations live on a separate entry point,
`@xgis/shader-dsl/emit-prod`, so a consumer that emits shaders *at runtime*
(the map engine itself does) and never imports the subpath bundles zero bytes
of the transform code. That matters because the weight is real: the mangle pass
is ~210 lines of identifier-walking and the minifier another ~60, none of which
a browser shipping the runtime emitter should ever download. A build-time
toolchain imports the subpath; the runtime path does not pay for it. Same split
the lint/measure tooling uses (`/dev`).

## mangle: rename everything except the contract

Mangling renames the authored vocabulary — helper functions, plain structs,
module constants (including the injected
[df64 emulation library](/blog/2026-07-07-emulated-double-precision-shader-dsl):
a software 64-bit float built from a *pair* of 32-bit floats, the trick that
stops globe coordinates from jittering at the earth's radius) — to
`_f0` / `_S0` / `_k0`, in declaration order. Local variables were already
machine-named by the optimizer; what leaks identity is the top-level names.

The interesting half is what mangling must **never** touch. These names are an
ABI — a contract with code outside the shader — and renaming one silently
breaks a program that still compiles:

| Never renamed | Who reads the name |
|---|---|
| entry-point functions | WebGPU `createRenderPipeline({ entryPoint })` names them |
| binding variables (incl. the `_fp64` guard) | the host's `getUniformLocation` / bind-group wiring |
| binding-struct tags | the GLSL UBO block name (`getUniformBlockIndex`) |
| struct **field** names | std140 host packing; GLSL varyings link vertex↔fragment **by name** |

That last one has teeth on WebGL2. GLSL compiles the two stages as *separate*
strings and links them by matching `out`/`in` varying names — so the vertex
and fragment emits, which are two independent `emitGlslModule` calls, must
rename every shared helper to the *same* symbol or the program fails to link.
The mangler is therefore deterministic per module (assignment follows
declaration order), and that determinism is a correctness requirement, not a
nicety. Reflection is derived from the same IR the mangler leaves untouched at
the boundary, so hosts bind exactly as before.

An optional `Map` collects the authored→emitted renames — a source map for the
shader, so a production driver log naming `_f2` can be read back to
`terrain_height`.

## minify: whitespace, proven safe

WGSL and GLSL have no string literals. That single fact makes text
minification safe by construction: a `//` is always a comment, whitespace is
never significant inside a token, and the only lines that must survive intact
are GLSL's `#` preprocessor directives (`#version`, `#extension`), which get
their own line. Spaces are dropped only where they touch structural
punctuation (`(){}[];,:?`) — characters that can't begin or end a
multi-character operator, so no `a - -b` collapses into `a--b`. The kaleidoscope
fragment shader, authored at 1,687 bytes, ships at 1,468 (−13%) with mangle +
minify; the win scales with how much the authored names and formatting weighed.

## Compile-and-link is not enough to trust it

The trap: a mangled, minified shader that **compiles and links** can still be
*wrong*. And the two ways it goes wrong aren't hypothetical hand-waving — they
are exactly the two mechanisms the sections above had to engineer around. A
whitespace rule one character too greedy merges `a - -b` into the decrement
`a--b`: still valid syntax, different arithmetic. A mangler that assigned names
in a non-deterministic order desyncs the vertex and fragment stages, which link
by matching varying names: the program links to *something* and samples the
wrong varying. Both produce a string the driver happily accepts and then draws
incorrectly, and compilation — which validates syntax, not semantics — waves
both through. That is the specific failure the gate is built to catch, which is
why it cannot stop at compilation.

So the CI gate does not stop at compilation. It emits every example
`{ minify, mangle }`, and for representative modules — including the df64 +
`_fp64`-guard path — **renders both the plain and the obfuscated shader with
identical inputs and asserts the two framebuffers are byte-identical**, on the
real Tint (WebGPU) and ANGLE (WebGL2) compilers under
[SwiftShader](/blog/2026-07-07-what-a-software-gpu-can-verify). Byte-identical
pixels are the only evidence that the transform preserved meaning; the frame is
also checked to be non-flat so a blank draw can't pass vacuously. The UBO and
sampler bindings in that harness are addressed by *index*, not name — so the
check itself can't accidentally depend on a name the mangler changed.

## Takeaways

- **Your shader strings are a blind spot in the bundle.** The minifier that
  processes every other byte skips them; they need their own pass.
- **Name it minification, not protection.** The text reaches the driver as
  source. The realistic goal is the JS one — smaller, harder to read — and
  saying so keeps the feature honest.
- **Obfuscation has an ABI.** Every name some *other* system resolves — entry
  points, bindings, UBO tags, varying fields — is untouchable; the rest is free
  to rename. Enumerate that boundary explicitly or a renamed shader will
  compile and mislink.
- **Semantics-preserving transforms need a semantic gate.** Compile-and-link
  proves syntax. Only rendering the before and after and diffing the pixels
  proves the meaning survived.

## References

1. Vite, [Plugin API](https://vite.dev/guide/api-plugin) — the named-plugin,
   staged-hook model this emit pass mirrors.
2. webpack, [Plugins](https://webpack.js.org/concepts/plugins/) — the
   `plugins: [...]` composition convention.
3. S. Guillitte / Ctrl-Alt-Test, [Shader
   Minifier](https://github.com/laurentlb/shader-minifier) — prior art on
   whitespace + identifier compaction of GLSL for size-constrained delivery.
4. W3C, [WebGPU](https://www.w3.org/TR/webgpu/#dom-gpudevice-createrenderpipeline)
   — `entryPoint` names the shader function by string, one of the ABI names
   mangling must preserve.
