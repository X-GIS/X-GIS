---
title: 'The 4-second timeout that lost to a 2-second GPU reset'
description: "Ticking 'include stress battery' on a conformance page froze an RTX 2080 desktop so hard the window's own close button stopped responding. The df64 stress shaders over-ran the 2 s Windows TDR, and a 4 s JS compile timeout couldn't help — you can't cancel a GPU op you already submitted."
date: 2026-07-11T15:00:00Z
tags: ['gpu', 'webgl2', 'angle', 'shader-dsl']
lang: en
draft: false
---

Tick one checkbox — _include stress battery_ — on a WebGPU/WebGL2 conformance
page, and around the 68th test an RTX 2080 desktop freezes. Not the tab: the
_desktop_. The mouse still moves, but nothing repaints, and the window's own
close button — drawn by the OS, not the page — stops responding to clicks. The
only way out is the power button.

That last detail is the whole diagnosis in one observation. A pegged JavaScript
thread freezes a tab; it does not freeze the Windows title bar. Whatever wedged
this machine was running somewhere below the browser, in a resource the desktop
compositor and the web page share. There is exactly one such resource: the GPU.

## The wrong first move

The page had already been hardened against freezes once, and the hardening was
textbook. Compiling a heavy shader synchronously blocks the calling thread, so
the code compiles asynchronously — `KHR_parallel_shader_compile`, then poll
`COMPLETION_STATUS_KHR` and yield a frame each spin instead of reading
`LINK_STATUS` (which forces the driver to finish _now_):

```ts
gl.linkProgram(p)
if (par) {
  const t0 = performance.now()
  while (!gl.getProgramParameter(p, par.COMPLETION_STATUS_KHR)) {
    if (aborted) throw new Error('aborted')
    if (performance.now() - t0 > COMPILE_TIMEOUT_MS) {
      aborted = true
      /* …abortNote… */ throw new Error('compile timeout')
    }
    await raf()
  }
}
```

A blocking `gl.readPixels` was replaced the same way — read into a pixel-pack
buffer, fence, poll `clientWaitSync` with a zero timeout, yield each frame — so
a heavy draw never stalls the main thread on readback either. And capping it
all, a wall-clock budget: `COMPILE_TIMEOUT_MS = 4000`. If a compile takes longer
than four seconds, treat it as pathological, flip `aborted`, and hand the driver
back.

Every one of those changes is correct, and every one fixed a real freeze — the
_tab_ freeze. The diff reads exactly like tightening: make the GPU work
non-blocking, put a timer on the slow part, bail if it runs away. It is the move
you would make, and it shipped, and the machine still wedged. Because none of it
touches the thing that actually wedges the machine — and the giveaway was there
all along in the frozen close button.

## What actually happened

The stress battery is not made of ordinary shaders. The default battery is 48
per-op known-answer tests — small kernels. The stress checkbox adds two families
the default run excludes: 24 seeded random df64 expression _trees_ at depth 5
(`rand00`–`rand23`), and an integer-EFT family. The 68th test in run order lands
about twenty trees into that random family — a deep one.

"Deep df64 tree" is the load-bearing phrase. df64 — a value carried as a pair of
f32s, roughly doubling f32's mantissa to a residual near 2⁻⁴⁶ — has no hardware
type. Every operation is emulated as a fixed expansion of f32 primitives through
error-free transforms: a single `sub` is a Knuth `twoSum`, a single `mul` a
Dekker `twoProduct`, each already several f32 ops [1]. Compose those into a
depth-5 tree and the
expansions nest; the integer flavor inlines its `twoSum` body on the order of
thirty times for one deep tree. Fully inlined — the emitted kernel has no
function calls — a single tree becomes one enormous straight-line expression
graph with a long serial dependency chain.

On Windows/Chrome, WebGL2 is not native GL. It goes through ANGLE, which
translates GLSL to HLSL and hands it to **FXC**, the legacy Direct3D shader
compiler. FXC's optimizer is superlinear in straight-line expression size on
exactly this shape — a deep, densely-dependent DAG — and the codebase already
carried the scar tissue in a comment next to the flavor selector: FXC "folds
deep synthetic df64 composition trees," and its "compile cost on the
fully-inlined integer bodies can TDR." In the probe the symptom was a
multi-second `linkProgram`. That alone is a compile-time denial of service — it
pins the GPU-process thread and janks the tab, which is what the async-compile
change was chasing.

But the reset comes from the _draw_. Once that giant shader is drawn — even over
the probe's 8×8, 64-pixel target — a single draw call runs long enough to trip
Windows' **Timeout Detection and Recovery**. TDR is a driver watchdog: if one
GPU operation doesn't return within `TdrDelay` — default **2 seconds** [2] —
Windows concludes the GPU has hung and _resets the whole adapter_. Not the
page's context. The adapter. And the desktop compositor, DWM, is a GPU client on
that same adapter: when it's reset, DWM loses its device and has to rebuild it,
and until it does, nothing on screen repaints — including the title bar with the
close button. That is the frozen desktop, explained. The web page's bug became
the compositor's bug because they were never isolated to begin with.

Now the 4-second timeout. It is measuring the right thing and it is still
useless here, for two independent reasons:

- **It fires too late.** `COMPILE_TIMEOUT_MS` is 4000; `TdrDelay` is 2000. On a
  genuinely pathological shader the OS watchdog trips at ~2 s and resets the GPU
  a full two seconds before the JavaScript timer even looks up.
- **It has nothing to cancel.** WebGL has no `gl.cancel()`. The moment
  `linkProgram` or `drawArrays` returns, the work is the driver's, not the
  page's. The timeout can make JavaScript stop _waiting_ and stop _submitting
  more_ — real value against a cascade — but it cannot recall the one op already
  in flight. And it only takes one to reset the adapter.

Everything the hardening added lives on the JS thread. The failure lives one
process down, in a submitted GPU op the JS thread can no longer reach.

## The fix

If you cannot cancel the op and cannot beat the watchdog, the only lever left is
_upstream of submission_: don't hand this driver work it can't survive. The
probe already harvests the renderer string for the df64 flavor decision, so the
signal costs nothing — an ANGLE-D3D11 renderer reads like
`ANGLE (NVIDIA … Direct3D11 vs_5_0 ps_5_0, D3D11)`. Gate the stress rows on it:

```ts
const fxcUnsafe = /Direct3D11|\bD3D11\b/i.test(sigRenderer ?? '')
// …per test…
if (fxcUnsafe && isStress(t.name)) {
  glSkipNote = glSkipNote || 'WebGL2 stress battery not submitted: this driver is ANGLE-D3D11…'
  report('gl', t.name, null, 'SKIP')
  continue
}
```

This is the difference between a reactive guard and a proactive one. The
`webglcontextlost` abort that was already in the code is reactive — it fires
_after_ the reset, when the damage is done and there may be nothing left to save.
`fxcUnsafe` is checked before the pathological shader is ever compiled, at the
one point where the page still has control. On D3D11 those rows are never
submitted, so the FXC blowup and the TDR it caused simply cannot originate here.

Coverage isn't lost, only routed. The 48 per-op KATs still run on D3D11 — small
bodies, safe, and they still prove df64 held on this GPU. The deep trees are
still exercised, on the paths that don't go through FXC: WebGPU (Dawn → D3D12 →
DXC) and Apple/Metal, which is the decisive venue for the integer flavor anyway.
And this isn't the only layer — the checkbox is off by default, the two backends
run serialized so they can't fight over the GPU, and the reactive abort stays as
a backstop. But the load-bearing piece is the one that refuses to submit.

One honest gap: if the driver masks its renderer string, `sigRenderer` is null,
`fxcUnsafe` is false, and the stress rows go through. The default-off checkbox is
the backstop there — the wedge only reaches a masked D3D11 device if the user
both opts in and runs a renderer-stripped browser.

## How we know it holds

This one can't be closed with a screenshot, and it's worth saying why: the bug
only reproduces on a real Windows/D3D11 GPU under a real TDR, which is exactly
the hardware a CI runner or a headless container doesn't have. So the argument is
deductive, not photographic — the stress rows are never handed to the FXC driver,
therefore the FXC compile and the draw that over-ran the watchdog cannot occur on
this path. The build typechecks green, and the decision matches one already
codified elsewhere in the stack: the df64 flavor selector keeps D3D11 on the
float lowering "deliberately," off the integer bodies that FXC chokes on, driven
by the same renderer signal. The pre-fix workaround was the abort banner's own
advice — _re-run without the stress battery for a clean pass_ — and the fix is
just that advice made automatic on the one driver that needs it.

## What generalizes

A timeout is not a guard for work you've delegated to another processor. The
`try { risky() } catch(timeout)` reflex assumes the thing you're timing is
_yours_ to abandon — that when the timer fires, the work stops. GPU submission
breaks both halves of that assumption: the op keeps running after the call
returns because it was never on your thread, and the platform's own watchdog is
already timing it on a shorter fuse than yours — and when that watchdog fires it
reclaims a resource your process was only borrowing alongside the compositor. The
only guard that holds is the one that runs _before_ you hand the work over: know
which backend you're actually talking to, and don't give it what it can't
survive. Which is the same lesson as pinning the backend before you trust a
render test [3] — identity first — one layer further down, where the cost of
guessing wrong is the whole machine instead of a green checkmark.

## References

1. ["Emulating double precision in a shader DSL"](/blog/2026-07-07-emulated-double-precision-shader-dsl) — the twoSum/twoProduct expansion that turns one df64 op into several f32 ops, and a deep tree into a giant one.
2. Microsoft, ["Timeout Detection and Recovery (TDR)"](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/timeout-detection-and-recovery) — the GPU watchdog and the `TdrDelay` default of 2 seconds.
3. ["The pixel test that passed on the wrong GPU"](/blog/2026-07-11-green-on-the-wrong-gpu) — the same RTX 2080, the same renderer signal, the case for asserting backend identity instead of trusting an output.
