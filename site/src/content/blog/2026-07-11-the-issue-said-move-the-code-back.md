---
title: 'The issue said to move the code back'
description: 'An issue prescribed relocating a context type to kill an adapter-to-adapter dependency edge. By pickup, that mechanism meant reverting a merged refactor. We cut the edge with composition-root injection instead, and locked it with a shrink-only ratchet.'
date: 2026-07-11T14:00:00Z
tags: ['architecture', 'dependencies', 'refactoring']
lang: en
draft: false
---

Forty-three hours. That is how long a milestone plan's prescribed mechanism
survived before the codebase moved underneath it. The bullet, filed July 6,
scheduled the death of a dependency edge between two sibling GPU backend
adapters and said how to kill it: "moving each provider to its backend package
with a neutral context type in `@xgis/rhi`." On July 8, a refactor merged that
moved the context family _out_ of `@xgis/rhi` and into the engine package —
deliberately, with its own argument in the PR body. When the bullet was picked
up on July 10, implementing it as written would have meant reverting a
two-day-old, reasoned refactor.

The edge itself was real and pinned. The WebGPU adapter package owned the boot
provider chain, including the WebGL2 fallback provider — which dynamic-imported
its sibling adapter to construct the concrete device:

```ts
export const webGl2BackendProvider: RhiBackendProvider<GPUContext> = {
  id: 'webgl2',
  probe: async () =>
    typeof document === 'undefined' || !!document.createElement('canvas').getContext('webgl2'),
  create: async (canvas) => {
    const { WebGl2Device } = await import('@xgis/rhi-webgl2')
    return initGPUForcedWebGL2(canvas, (gl) => new WebGl2Device(gl))
  },
}
```

One adapter importing the other is exactly the coupling the dependency-direction
gate exists to kill, so the edge sat in that gate's baseline of known
violations, with a comment echoing the issue's plan: a "documented transitional
home" until the context type neutralizes, "then each provider moves to its
backend package … and this edge burns down."

## The wrong first move: reading the mechanism as the spec

The tempting path was to do what the ticket said — doubly tempting because the
plan was written down twice, once in the issue and once in the ratchet
baseline's comment, and both said _relocate_. Two sources agreeing feels like
confirmation; it isn't when both came out of the same planning pass, before
the code moved. Relocation failed on two separate grounds, both checked before
writing any code.

First, the "neutral context type in `@xgis/rhi`" half. The July 8 refactor had
moved the render-context family out of `@xgis/rhi` into the engine package,
renaming `RhiContext` to `RenderContext`, on this argument: the RHI is a
render _hardware_ interface — it must describe GPU resources and "be
justifiable without naming a host canvas, a per-frame render-loop state, or
any consumer." Putting a context type back into the hardware interface because
a ticket said so would have re-created the exact conceptual inversion that
refactor existed to remove.

Second, the "move each provider to its backend package" half doesn't kill the
edge today — it flips it. The WebGL2 provider returns the WebGPU-typed
`GPUContext` and calls `initGPUForcedWebGL2`, both owned by the WebGPU adapter.
Relocate the provider into the WebGL2 package and you mint a brand-new
`rhi-webgl2 → rhi-webgpu` edge pointing the other way. The genuine precondition
is neutralizing `GPUContext` itself, which the same issue prices at "~1074 raw
sites, incremental" — a multi-PR campaign. Killing one edge was never supposed
to wait behind that. The issue text was not wrong; it was _dated_ — and the
goal sentence buried under its mechanism was still exactly right.

## Cut the edge without moving anything

If the goal is "the WebGPU adapter names the WebGL2 adapter nowhere," the
provider doesn't have to move. It has to stop constructing its sibling's
device. That is a textbook injection seam. The provider const became a factory
taking the concrete device constructor as a parameter — its `create` collapses
to `(canvas) => initGPUForcedWebGL2(canvas, makeDevice)`, and the parameter's
type,

```ts
export type WebGl2DeviceFactory = (gl: WebGL2RenderingContext) => RhiDevice | Promise<RhiDevice>
```

returns the _neutral_ `RhiDevice`, so the seam itself names no backend. The
composition root — the one package that legitimately depends on both backends —
supplies the concrete wiring, still lazily so the WebGL2 chunk loads only on an
actual WebGL2 boot:

```ts
private readonly _makeWebGl2Device = (gl: WebGL2RenderingContext) =>
  import('@xgis/rhi-webgl2').then((m) => new m.WebGl2Device(gl))
```

The factory parameter is optional, so the ~40 existing boot tests that only
exercise the WebGPU-stub path kept passing with no edits — the chain's shape is
unchanged when it's omitted. But actually reaching a WebGL2 boot without a
factory is a composition-root wiring bug, so it fails loud with an error naming
the fix ("no makeWebGl2Device factory was injected — pass one to
backendProviderChain()/initGPU() at the composition root") instead of returning
a mystery null.

After the change, the WebGPU adapter's `src` imports the WebGL2 package in zero
non-test files. The edge is dead — without relocating the provider, without
touching the context type, and without waiting for the 1074-site campaign.

## The ratchet only locks the win if it forces you to record it

Deleting the import is half the job. The dependency gate is a ratchet: an
allowed package graph plus a baseline of pinned violations being burned down,
and the baseline is _shrink-only_ by test:

```ts
it('baseline only shrinks (stale entries must be deleted)', () => {
  const stale = BASELINE.filter(([p, d]) => !edges.has(`${p} -> ${d}`))
  expect(
    stale.map(([p, d]) => `${p} -> @xgis/${d}`),
    'Baseline edge no longer exists in src — burn-down achieved. Delete ' +
      'its BASELINE entry in this same commit so the ratchet locks the win.',
  ).toEqual([])
})
```

That test produced the fail-before proof for this change. With the import cut
but the baseline entry still present, the suite failed:

```
FAIL  engine/src/dependency-direction-ratchet.test.ts > dependency-direction
ratchet (#929) > baseline only shrinks (stale entries must be deleted)
AssertionError: Baseline edge no longer exists in src — burn-down achieved.
Delete its BASELINE entry in this same commit ...:
  expected [ 'rhi-webgpu -> @xgis/rhi-webgl2' ] to deeply equal []
```

Deleting the `['rhi-webgpu', 'rhi-webgl2']` entry in the same commit turned the
ratchet green (3/3). A baseline that only shrinks is what separates a ratchet
from a permission list: without the stale-entry test, every burned-down edge
would leave behind a standing license to re-introduce it.

Two honest boundaries of that enforcement, recorded at review: the ratchet
deliberately skips test files (the adapter's tests now import `WebGl2Device`
directly, playing composition root), and it reads the import graph, not the npm
manifest — the WebGL2 package stays declared in the WebGPU adapter's
`package.json` for those tests. Neither fired as a problem; both are places the
"mutually blind" claim is narrower than it sounds.

## The failure only the bundler could see

One danger did fire, and the unit suite was structurally unable to catch it.
The composition root's new `import('@xgis/rhi-webgl2')` is lazy — it executes
only on an actual WebGL2 boot, and the runtime boot tests all exercise the
WebGPU-stub path, so no unit test ever evaluates that import. The full build
has to resolve it whether it runs or not, and could not:

```
Failed to resolve import @xgis/rhi-webgl2 from map/src/map.ts
```

`bun run build` exited 1 in the site's rollup step, because the map package
dynamic-imported a dependency it never declared. The fix was one manifest line
(`"@xgis/rhi-webgl2": "workspace:*"`), but the lesson is the gate, not the fix:
a bundler that treats the manifest as authority is load-bearing verification
for dependency changes. Had the pre-push gate been "tests pass," an undeclared
runtime dependency would have shipped.

## How we know it holds

The ratchet ran fail-before → pass-after as above, and it runs in CI. The
adapter and boot suites came back green — 12 files / 91 tests — and
`bun run build` exited 0 after the manifest fix. The end-to-end proof that the
new seam actually boots was the forced-WebGL2 render gate under a software GPU:
1 passed in 11.4s, booting through the injected async factory and asserting via
`gl.readPixels` that country fills cover more than 8% of the frame, with the
page-readable backend marker reading `webgl2` and zero GL or validation errors.

One thing was explicitly not re-verified: a headed real-GPU WebGPU raster run.
The diff touches no renderer and leaves the WebGPU boot body byte-unchanged —
that path only lost a dynamic-import edge it never executed — so the build and
the adapter unit suite were accepted as coverage there, a judgment call
disclosed in the PR rather than papered over.

## What generalizes

An issue's prescribed mechanism is a snapshot of the codebase at filing time,
and the more precisely it is written, the faster it expires — here the
mechanism half of one sentence became a revert in forty-three hours, while the
goal half ("these two packages must not know each other") stayed correct
indefinitely. Treat the stated goal as the spec and re-derive the mechanism
against the code as it exists at pickup, especially when the ticket and a code
comment agree — two artifacts of the same stale planning pass are not two
sources. And once the goal is met, make it mechanical: an architecture decision
only holds if violating it is a CI failure, and a ratchet only ratchets if
deleting the baseline entry is forced in the same commit as the win.

## References

1. ["Where a type is imported from is not where the dependency
   lives"](/blog/2026-07-08-import-source-is-not-dependency) — an earlier move
   in the same dependency campaign that went the wrong way: re-exporting types
   through a barrel made the coupling worse, and was reverted.
2. ["The no-op that hid a hundred
   fences"](/blog/2026-07-08-fail-loud-stub) — why this codebase's placeholder
   for "you forgot to inject it" throws an actionable error instead of
   returning a harmless dummy.
