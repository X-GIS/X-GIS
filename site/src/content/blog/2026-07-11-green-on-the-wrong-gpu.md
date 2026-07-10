---
title: 'The pixel test that passed on the wrong GPU'
description: 'The same render test passed twice: once at 38.5% painted pixels on real WebGPU, once at 93.6% on a silent WebGL2 fallback the assertion never noticed. Why a designed-in fallback chain turns every green output test ambiguous — until the test also pins which backend produced the frame.'
date: 2026-07-11T12:00:00Z
tags: ['testing', 'webgpu', 'playwright', 'e2e']
lang: en
draft: false
---

The same Playwright spec — load a map, read the canvas back, assert that more
than 10% of pixels are non-background — passed twice on the same Windows
machine. Headed, it passed with 38.5% of pixels painted. Headless, it passed
with 93.6%. Both runs green, no warnings, exit code 0.

Only one of them was testing the engine we thought we were testing. In the
headless run, WebGPU did not exist.

## The wrong first move

The session's plan needed a yes/no answer up front: _can this machine run
real-GPU render verification headlessly?_ The obvious probe is to run the
lightest raster spec headless and read the verdict off the exit code. If the
pixel assertion passes, rendering works.

That probe was actually run, and it returned green — 93.6% non-background
pixels, comfortably over the 10% threshold. Taken at face value, the answer was
"yes, headless WebGPU rendering works," and the rest of the session would have
verified five render bug-fixes on top of it.

The assumption looked safe because the capability check most people write had
already passed: `navigator.gpu` was present in the headless browser. The API
surface existed. What the surface didn't say is that on this platform,
headless Chromium enumerates no GPU adapter at all: `navigator.gpu` is there,
and `navigator.gpu.requestAdapter()` resolves to `null`.

## What actually happened

The engine under test, like most production render stacks, has a designed-in
fallback chain: if WebGPU can't produce an adapter, boot the WebGL2 backend
instead. That chain did its job perfectly. The frame was real, the map was
real, the pixels were real — they just came out of a different renderer than
the one the probe claimed to be verifying.

The unmasking observation was one global variable. The engine exposes its
resolved backend for exactly this purpose, and a standalone probe page asked
two identity questions instead of one output question:

- headless: `requestAdapter()` → `null`, `window.__xgisActiveBackend === 'webgl2'`
- headed: adapter `vendor=nvidia`, `architecture=turing`, 21 features
  including `shader-f16` and `subgroups` — `__xgisActiveBackend === 'webgpu'`

So the 93.6% green run was a WebGL2 frame wearing a WebGPU test's name. The
pixel assertion is an _output_ assertion; it accepts any renderer that paints
enough of the screen. Nothing in the test pinned _provenance_ — which system
produced the frame — so the fallback chain, a feature everywhere else, quietly
converted the test into a liar.

We did not chase why the fallback frame painted more pixels than the real one
(93.6% vs 38.5%; the headed run used dpr=3 and 4× MSAA); the point is
narrower and worse: the assertion was satisfied by both.

## The fix

Two separate fixes, because there are two separate problems.

For CI, where no hardware GPU exists, the harness forces a _software_ Vulkan
adapter instead of letting the fallback decide — SwiftShader, wired through
Chromium flags in the Playwright config:

```ts
args:
  process.env.XGIS_SOFTWARE_GPU === '1'
    ? [
        '--enable-unsafe-webgpu',
        '--enable-unsafe-swiftshader',
        '--use-angle=swiftshader',
        '--use-vulkan=swiftshader',
        '--enable-features=Vulkan',
      ]
    : ['--enable-unsafe-webgpu', '--enable-features=Vulkan'],
```

Under that mode a WebGL2 readback gate passed headlessly in 12.1s, asserting
via `gl.readPixels` that country fills cover more than 8% of the frame — the
exact configuration CI runs. Full-raster specs stay off this path on purpose;
the config carries a comment saying the full pipeline does not render
correctly under SwiftShader, and only the gate subset is trusted there.

For verification claims, the rule that came out of the incident: a render
test that names a backend must _assert_ the backend. Pin the identity
observable (`__xgisActiveBackend`, or adapter vendor non-null) next to the
pixel assertion. The headed re-run under that rule is what the session
actually trusted: 38.5% painted on a proven `nvidia/turing` adapter, and a
second spec pulling live vector tiles counted 3,191 blue water pixels against
a threshold of 50.

## The same lie, one config key over

The identical failure shape sat in the harness config waiting to fire a second
way — this one never fired, because it was caught by reading the config before
launching six parallel working copies of the repo:

```ts
webServer: {
  command: 'bun run dev',
  url: 'https://localhost:3000/demo.html?id=minimal',
  reuseExistingServer: true,
  ...
}
```

Fixed port, `reuseExistingServer: true`. Six agents in six git worktrees, each
starting "its" dev server on 3000: the first one wins, and every later test
run silently attaches to the _first worktree's_ server — green pixel
assertions, produced by someone else's build. Same disease as the backend
fallback: the output assertion holds, the provenance is wrong.

The prevention was a per-worktree, uncommitted config override giving each
copy its own port, with `--strictPort` so a taken port fails loudly instead of
falling back:

```ts
import base from './playwright.config'
const PORT = 3103 // unique per worktree
export default {
  ...base,
  use: { ...base.use, baseURL: 'https://localhost:' + PORT },
  webServer: {
    ...base.webServer,
    command: 'bun run dev -- --port ' + PORT + ' --strictPort',
    url: 'https://localhost:' + PORT + '/demo.html?id=minimal',
  },
}
```

## What generalizes

Fallback chains and reuse shortcuts are features precisely because they are
silent — production users should never see the seam. But a test inherits that
silence: a passing output assertion is evidence about the output, not about
the system that produced it. In any stack with designed-in fallbacks, a green
test is ambiguous by default, and the ambiguity always resolves toward false
confidence, never toward false alarm — the fallback exists to make things
work. The counterweight costs one line: expose an identity observable at every
seam where the stack can silently substitute one implementation for another,
and make the test assert it alongside the output.

## References

1. ["What a software GPU can verify"](/blog/2026-07-07-what-a-software-gpu-can-verify) — why the SwiftShader CI lane trusts compile/readback gates but not the full raster pipeline.
2. ["Pixels don't lie"](/blog/2026-07-07-pixels-dont-lie) — the case for readback-based render assertions; this post is the corollary about what those assertions still don't prove.
3. Chromium, [`--use-vulkan=swiftshader`](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md) — the mechanism that gives a headless, GPU-less environment a real (software) Vulkan adapter instead of a silent fallback.
