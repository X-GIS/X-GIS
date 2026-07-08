---
title: 'Where a type is imported from is not where the dependency lives'
description: 'A post-mortem on a refactor that went the wrong way. To strip @webgpu/types from @xgis/map we re-exported the WebGPU types through a barrel — and made the coupling worse, not better. The revert, and the rule that would have caught it up front.'
date: 2026-07-08
tags: ['architecture', 'refactoring', 'dependencies', 'rhi']
lang: en
series: { name: 'WebGL2 backend program', order: 3 }
---

The task was crisp: `@xgis/map` should depend on `@xgis/engine` alone. Map had
~700 references to ambient `@webgpu/types` globals (`GPUDevice`, `GPUBuffer`,
`GPUTextureView`, …) and a `"types": ["@webgpu/types"]` in its tsconfig that
pulled the whole WebGPU ambient namespace into scope. The engine already lives
without it (`"types": []`). We wanted map to do the same, so that the backend —
WebGPU or WebGL2 — is chosen _inside_ the engine and map never names a
backend-specific symbol.

My first move looked reasonable and was wrong.

## The move: re-export the types through a barrel

If map can't have `@webgpu/types` ambient, I reasoned, then map should import the
`GPU*` names it uses from a package it _is_ allowed to depend on. So I added a
barrel:

```ts
// rhi-webgpu/src/webgpu-types.ts  — the wrong idea
export type { GPUDevice, GPUBuffer, GPUTextureView, GPUTexture /* …60 more… */ }
```

and rewrote map's annotations to pull from it:

```ts
// map/src/render/some-renderer.ts
import type { GPUDevice, GPUBuffer } from '@xgis/rhi-webgpu'
```

`tsc` went green. Ambient `@webgpu/types` gone from map's tsconfig. The ~700
references — clustered in about forty files that actually annotate `GPU*`
shapes — now had an explicit import source. It _looked_ like progress: the diff
was all "add explicit import," the kind of change that reads as tightening, and
a green typecheck plus a cleaner tsconfig is exactly the signal that says _ship
it_. I was one `git commit` away from doing so — the compiler had no way to tell
me the arrow now pointed the wrong way, because to `tsc` a satisfied import is a
satisfied import.

The owner stopped it in one sentence: _map must depend on the engine only, and
the backend is selected in the engine._ Re-exporting WebGPU types **from
`@xgis/rhi-webgpu`** and importing them into map does the opposite of the goal.
It takes a dependency that was _ambient and diffuse_ and makes it _explicit and
structural_ — map now has a hard, named, compile-time edge to the concrete
WebGPU backend package. That is precisely the edge the whole milestone exists to
cut.

## The distinction that matters

Here is the trap, stated plainly:

> **Removing an ambient global is not the same as removing a dependency.
> Giving a dependency an explicit import path can _strengthen_ it.**

Before: map used `GPUDevice` as a free-floating ambient name. Ugly, but it named
a _structural type_, not a package. There was no import edge from map to
`rhi-webgpu` for these — TypeScript resolved them from the global `@webgpu/types`
declaration.

After the wrong move: map had `import type { GPUDevice } from '@xgis/rhi-webgpu'`
in forty files. Now there _was_ an edge — a real, greppable,
dependency-graph-visible edge from the map package to the concrete backend
package. I had converted "map happens to use a WebGPU-shaped type" into "map
imports from the WebGPU backend," which is a worse architecture even though the
tsconfig looked cleaner.

The consequence is concrete, not aesthetic. The whole milestone exists so a
build can ship _one_ backend — the canary CI job already proves the engine
compiles against `@xgis/rhi` alone. Picture a WebGL2-only bundle that pulls in
`@xgis/rhi-webgl2` and drops `@xgis/rhi-webgpu` entirely. With the barrel,
map's forty files still `import type … from '@xgis/rhi-webgpu'` — a package no
longer in the build — and map fails to resolve its own type imports. The
ambient-global version, ugly as it was, would have compiled fine: `@webgpu/types`
is just a shape declaration, coupled to no package I need to ship. The barrel
took a dependency that survived dropping the WebGPU backend and made it one that
doesn't.

The direction of a dependency is not decided by whether an import statement
exists. It's decided by **which package owns the symbol and which package must
change when it changes.** A neutral type that both map and the backend agree on
must live _upstream of both_ — in `@xgis/rhi` (the interface package, zero deps)
or `@xgis/engine` (which depends only on `@xgis/rhi`). Sourcing it from
`@xgis/rhi-webgpu` points the arrow at the leaf backend, the one package that
should have _no_ inbound edges from map at all.

## The right move

<figure>
  <img src="/diagrams/rhi-deps.svg" alt="Dependency arrows: map to engine to the rhi interface; rhi-webgpu and rhi-webgl2 hang off rhi as leaves the engine selects at runtime." />
  <figcaption>The arrow points one way: map → engine → rhi. The concrete backends are leaves the engine selects at runtime — map has no inbound edge from either.</figcaption>
</figure>

The correct migration doesn't re-home the WebGPU types — it _replaces_ them with
neutral types that already belong upstream:

- Values that are only ever routing keys become `RhiPipelineHandle { label:
string }` in `@xgis/rhi`. (Most of map's `GPURenderPipeline` refs were this —
  covered in a separate post.)
- Context handles become `RhiContext`, `RhiDevice`, `RhiTextureView` — the RHI
  interface, injected into the engine, re-exported by the engine.
- `GPUDeviceLostInfo` on map's public error callback becomes
  `RhiDeviceLostInfo`, defined in `@xgis/rhi`.

Every one of these lives in a package _upstream_ of both map and the backends.
Map imports them from `@xgis/engine` (which re-exports the RHI surface). The
arrow points the right way: map → engine → rhi. The concrete `rhi-webgpu`
package sits off to the side as a leaf that the engine selects at runtime, with
**zero** inbound edges from map.

The barrel got stashed and reverted in full — and the fullness is the point.
The tempting salvage was "keep the barrel for just the handful of files where
defining an upstream type is more work, revert the rest." But a partial keep
leaves a partial `map → rhi-webgpu` edge, and a partial version of the exact
edge the milestone exists to delete is not a smaller problem — it's the same
problem in fewer files, still enough to break the WebGL2-only build above. The
revert was cheap precisely because the right move reuses none of it: replacing a
type with a neutral one defined upstream shares no lines with re-exporting the
concrete one downstream. When the premise is wrong, there's nothing to salvage,
because every line encodes the wrong premise.

## The rule

When you're removing a dependency, don't measure success by "did the ugly import
/ ambient global go away." Measure it by **which way the arrows point in the
package graph afterward.** Draw the edge you're about to create and ask: does the
new import point _upstream_ (toward interfaces and shared contracts) or
_downstream_ (toward a concrete leaf implementation)? An explicit import to a
leaf backend is a tighter coupling than an ambient global that named only a
shape.

The tell that should have stopped me before the owner did: I was adding
`from '@xgis/rhi-webgpu'` to map. The moment a _consumer_ package names a
_concrete backend_ package in an import, the arrow is pointing the wrong way — no
matter how clean the tsconfig looks afterward. Neutral contracts live upstream;
if the type you need isn't there yet, the work is to _define it upstream_, not to
re-export the concrete one downstream.
