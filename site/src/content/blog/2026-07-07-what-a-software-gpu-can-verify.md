---
title: 'What a software GPU can and cannot verify'
description: "Our CI runs real shaders on SwiftShader — but only some render claims survive a CPU rasterizer. The dividing line we use (compute parity and shader compilation: yes; full-pipeline pixel parity: no), and the red-baseline incident that taught us to blame the software GPU last."
date: 2026-07-07
tags: ['testing', 'ci', 'webgpu', 'gpu-drivers']
lang: en
---

A unit suite can execute every line of TypeScript in a renderer and still
never execute a single shader. Our vitest matrix proves the CPU side; the
WGSL that actually runs on the GPU was, for a while, verified only by
eyeballs. CI runners have no GPU — so the render gate runs Chromium on
[SwiftShader](https://github.com/google/swiftshader), a CPU implementation of
Vulkan that Chromium uses to exercise GPU code paths on GPU-less machines
[1][2]. WebGPU compute, WGSL compilation, and WebGL2 all work.

What took calibration was learning **which claims a software GPU can gate** —
a lesson that first arrived disguised as a GPU precision bug and turned out to
be a test-side *stale stride*, a 24→28-byte layout change the synthetic buffers
never picked up (the incident below).

## The dividing line

**CI-gated (SwiftShader-safe).** Anything that is *pure compute*, *shader
compilation*, or a *simple raster* whose assertion is per-pixel logic we
wrote ourselves:

| Gate | What it proves |
|---|---|
| `_shader-math-parity` | the WGSL `project()` in a compute pass matches the TS mirror |
| `_vs-clip-parity`, `_dequant-parity` | vertex clip math and u16→f32 dequant, GPU vs CPU f32 mirror, via `mapAsync` readback |
| `_polygon-fill-flat-parity` | the tile-local-Mercator fill arm coincides with the f64 outline (guards a bug that recurred three times) |
| `_optimizer-gpu-parity` | the IR optimizer preserves results through emit → real GPU execution |
| `_wgsl-compile-gate`, `_glsl-compile-gate` | every emitted shader variant compiles/links on Tint and ANGLE |
| examples render / MRT / pointer gates, fp64 known answers | fullscreen-triangle shaders draw the expected pass/fail pixels |

**Local-only (headed, hardware GPU).** Anything whose assertion depends on a
*correctly rasterized full-engine frame*:

- **Full-engine init gates** (`_projection-coverage` and its kin) — need the
  entire render pipeline to boot, which times out under SwiftShader before the
  first frame lands;
- **Full-frame parity diffs** — pixel-diff X-GIS against MapLibre or a d3-geo
  Canvas2D reference (`_style-parity-diff`, the visual-regression matrix).
  SwiftShader cannot raster the full map pipeline correctly, so every cell
  false-positives.

The useful distinction is not "compute vs raster" — SwiftShader rasters our
fullscreen-triangle gates fine. It is **whose semantics the assertion
trusts**: a compute readback or a pass/fail pixel we computed is checked
against *our own* reference; a full-frame parity diff trusts the software
rasterizer to agree with hardware, and it does not.

So a green render gate means the projection/clip/dequant *math* and shader
*compilability* did not regress. It does **not** mean the rendered output was
visually verified — that stays on a hardware-GPU run before shipping render
changes. Writing that sentence into the workflow file, next to the job,
stopped a recurring misunderstanding.

## The red baseline that wasn't SwiftShader's fault

For a stretch, `_vs-clip-parity` and `_dequant-parity` were red on every main
run with a GPU-vs-CPU delta around $1.23 \times 10^4$. Every instinct said
software-GPU precision drift, or a threshold set too tight.

It was neither. The move that cracked it was to stop staring at the scalar
delta and dump *both* buffers — the GPU readback and the CPU mirror — as raw
axis columns, side by side. Lined up, the error was not a noise cloud: every
`GPU.y` sat exactly on the neighbouring `CPU.x`. A clean one-axis *shift* is a
layout bug, not precision. The cause: both specs packed their synthetic vertex
buffer at a hardcoded 12 u16 per vertex, while the CPU mirror strides by the
format constant — which had grown from 24 to 28 bytes (12 → 14 u16) when a
tail slot was added. The two-u16 misread walked every read one slot off its
axis. Deriving the synthetic stride from the single-source format constant made
the gates bit-exact: worst delta **0.0** across 96,000 axes.

Two lessons we kept:

- **Blame the software renderer last.** A precision explanation absorbs any
  delta; a structural explanation (a clean axis shift, a stable factor)
  points at layout. Look at the *shape* of the error before reaching for
  tolerances.
- **Synthetic test data must derive from the same constants as production.**
  Hardcoded strides are a stale copy waiting to happen.

## Skip-when-irrelevant, protection-safe

The render gate is expensive (browser install, build, nine Playwright
specs), so a paths filter skips it when no render-affecting code changed.
The pattern matters for anyone using required checks: the *job* always runs
and posts green — each expensive *step* carries the `if:`. A job that never
ran posts no check, and a required check that never arrives strands the PR
on "Expected". Steps skip; jobs report.

## References

1. google/swiftshader, [CPU-based implementation of the Vulkan graphics
   API](https://github.com/google/swiftshader).
2. Chromium GPU docs, [Using Chromium with
   SwiftShader](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).
3. W3C, [WebGPU Shading Language — Reassociation and
   fusion](https://www.w3.org/TR/WGSL/#reassociation) — why numeric gates
   need explicit software-GPU tolerances rather than exact equality.
