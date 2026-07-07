---
title: 'Porting the ShaderToy classics — and letting them review our shader DSL'
description: "We rebuilt ten classic ShaderToy effects in X-GIS's typed shader DSL. The renders were the easy part: authoring them surfaced eleven concrete DX issues, and every one was fixed the same day — with gates so they stay fixed."
date: 2026-07-07
tags: ['shader-dsl', 'examples', 'dx', 'testing']
lang: en
---

Every shader playground eventually ports the classics: the plasma, the tunnel,
the Mandelbrot zoom, the raymarched field. We just did it for
[`@xgis/shader-dsl`](/shader-dsl) — ten new examples, each authored **once** in
the typed DSL and emitting WGSL (WebGPU), GLSL ES 3.00 (WebGL2), and its
pipeline reflection from the same source. The
[gallery](/shader-dsl/examples) now runs twenty live shaders.

But the renders were never really the point. The point was to make the DSL
_carry a workload it wasn't designed around_ and write down every place it
pushed back. Ten shaders in, we had eleven concrete developer-experience
issues on file. All eleven were closed the same day — and the interesting part
is what "closed" means in this codebase.

## The ports (with one licensing footnote)

Tunnel, Mandelbrot, metaballs, an ocean horizon, a starfield, domain warping,
truchet tiles, a raymarched box field, a beating heart, a kaleidoscope. Each
exercises a different corner of the surface: `atan2` and the polar remap,
`Loop`/`Break` escape-time iteration, a `Loop` accumulator over a
uniform-driven count, perspective division, hash grids, `fbm(p + w·fbm(p +
fbm(p)))`, `fwidth` anti-aliasing, floor-mod domain repetition, an implicit
sextic curve, and a polar mirror fold.

One footnote worth stating plainly: these are **original implementations of
the well-known techniques**, not ports of shadertoy.com listings — ShaderToy's
default license is CC BY-NC-SA, which is incompatible with this repository's
MIT. The techniques themselves are shared folklore; the code is ours.

## What ten shaders taught the tool

Authoring is the harshest review a DSL ever gets. A few of the findings:

**Float `%` is a portability trap.** WGSL's `%` is trunc-mod; GLSL ES 3.00's
`%` doesn't even accept floats, and its `mod()` is floor-mod. Every domain
repetition and angle fold (negative operands!) had to hand-spell
`x − y·⌊x/y⌋`. The fix is a portable `mod(x, y)` intrinsic with floor-mod
semantics on **both** targets — the registry spells it `mod()` on GLSL and
inlines the floor form on WGSL, and the CPU oracle implements the same
semantics so all three backends agree.

**Mixed coordinate spaces pass every gate.** The ocean example computed its
sun-disc distance between an aspect-scaled x and a raw-uv y. Units differed
2×, the sun rendered as an ellipse — and the emit gate, the byte-pinned
goldens, and the "frame varies" render gate were all green. Only eyes caught
it. That became `screenCoords(uv, resolution)` — one isotropic centred space
where a circle stays a circle — plus a documented rule: _name the space you
are in; never cross axes between spaces in one distance._

**Errors should name your code, not the library's.** A `Loop` body that
references a loop index it never declared used to die with a stack trace into
the DSL's builder internals. Builder-boundary exceptions now re-throw wrapped
with the enclosing function: `while building fn 'fs': …` — we watched the new
wrapper point at the right file during this very session.

The rest of the list: `dpdx`/`dpdy` intrinsics (spelled `dFdx`/`dFdy` on
GLSL), a lint for reversed `smoothstep` edges (undefined in GLSL ES, and most
drivers hide it), documented mutability rules (`Var` / `Let` / CSE), a
`bake:goldens` script, and shared fullscreen-pass boilerplate that removed
~600 duplicated lines across the examples.

## Refactors you can prove

That last one deserves a sentence, because it shows what the golden suite is
for. Every example's emitted WGSL and GLSL is byte-pinned in committed golden
files. When we extracted the shared boilerplate — and later when eight
examples adopted `screenCoords` — the golden suite was run **without**
re-baking. It passed. That is the whole proof: hundreds of lines moved, zero
emitted bytes changed. "Pure refactor" stopped being a claim and became a
checkable property.

## Making the gallery interactive

The examples describe their inputs declaratively — a `controls` record maps
each uniform field to `time`, `resolution`, a slider, and now a **pointer**:

```ts
controls: {
  time: { kind: 'time' },
  resolution: { kind: 'resolution' },
  zoom: { kind: 'slider', label: 'Zoom', min: 0, max: 4, step: 0.1, value: 1.5 },
  mouse: { kind: 'mouse' }, // vec4 [x, y, down, used]
}
```

The host recovers each field's std140 byte offset from `reflect(module)` and
packs live values every frame — the same reflection-driven packing the unit
and e2e gates use. Two layers of interactivity landed on top:

- **Transport chrome** — play/pause, scrub, speed, reset, fullscreen — lives
  entirely in the site host. `time` was always host-filled, so all twenty
  examples got it with zero shader changes.
- **The pointer uniform** is opt-in. Its fourth component (`used`) stays 0
  until the pointer first enters, so every shader gates its interactive path
  on `m.w` — an untouched frame renders the canonical autopilot view. That one
  bit is what keeps thumbnails, render gates, and reduced-motion users on the
  exact frames we've always shipped. Four examples adopted it: Mandelbrot pans,
  Julia's `c` follows your cursor, a metaball chases the pointer, and the box
  field looks around as you move.

And because "it's interactive" is a claim like any other, it has a gate: a CI
spec renders every mouse-declaring example twice on real WebGL2 — untouched
vs. active pointer — and fails unless the frames visibly differ. A typo'd
control key or a dead `m.w` multiply now breaks the build, not the demo.

## Try it

The [gallery](/shader-dsl/examples) runs everything live — sliders, transport,
and the pointer where it matters. Every card shows the TypeScript source, the
emitted WGSL and GLSL, and the reflection JSON, because the entire pitch of
the DSL is that those four things are one artifact.
