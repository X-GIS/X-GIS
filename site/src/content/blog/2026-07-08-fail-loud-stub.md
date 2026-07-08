---
title: 'The no-op that hid a hundred fences'
description: 'A recursive no-op Proxy let a WebGPU-typed engine boot on WebGL2 by making every native GPU call return a harmless dummy. It also silently swallowed every place a fence was missing. Replacing it with a fail-loud stub — and what the stub screamed about.'
date: 2026-07-08
tags: ['webgl2', 'architecture', 'debugging', 'rhi']
lang: en
series: { name: 'WebGL2 backend program', order: 2 }
---

X-GIS was authored WebGPU-first. When we added a WebGL2 fallback (`?forcegl2=1`),
the renderers still built pipelines, bind-group layouts, and buffers from
`ctx.device` at map-init time — _before any frame_. On the WebGL2 path there is
no `GPUDevice`. An `undefined` there crashes the boot. So the boot handed the
renderers a placeholder:

```ts
// The original forcegl2 device/context stub.
const noop = new Proxy(function () {}, {
  get: (_t, p) => (p === 'then' ? undefined : noop),
  apply: () => noop,
})
return { device: noop as GPUDevice, context: noop as GPUCanvasContext /* … */ }
```

A recursive no-op. Every property access returns itself; every call returns
itself. `device.createRenderPipeline({...})` returns the proxy. So does
`device.queue.writeBuffer(...)`. The `then` trap returns `undefined` so `await`
doesn't mistake it for a thenable and hang forever. The renderers built their
"pipelines" and "buffers" out of this proxy, stored them, and never touched them
again — because the forced-WebGL2 frame renders through the RHI (`ctx.rhi`, a
`WebGl2Device`) via an early return, and the WebGPU multi-pass that would consume
the dummies never runs.

It worked. It also lied.

## The problem with a stub that never complains

A no-op stub is a black hole for correctness signals. Consider the migration
we were doing: _retire the device_ — move every renderer's native GPU work
behind the RHI or fence it off the WebGL2 backend, so `ctx.device` can eventually
be `null`. To do that you have to find every site that still touches the device
on the WebGL2 path.

With a no-op proxy, there is no way to find them. A renderer constructor that
_should_ have been fenced but wasn't just… calls the proxy, gets a proxy back,
and carries on. The frame renders (through the RHI). Nothing errors. Nothing is
slow enough to notice. The missing fence is invisible. We had been fencing
things for six milestones and had no way to know how many we'd missed — the
proxy absorbed all of them.

This is the general hazard: **a permissive stub converts "you forgot to handle
this backend" from a loud crash into silent, correct-looking behaviour.** The
bug doesn't go away; it goes quiet. And quiet bugs compound — the next person
adds another device call on the hot path, the proxy eats it too, and the
"backend-neutral" boundary you thought you had is Swiss cheese you can't see
through.

## Fail loud instead

The fix is to make the stub throw on _any_ property access, with a message that
tells you exactly what to do:

```ts
const unavailable = (what: string): unknown =>
  new Proxy(Object.create(null), {
    get: (_t, p) => {
      if (typeof p === 'symbol' || p === 'then') return undefined
      throw new Error(
        `[X-GIS] ctx.${what}.${String(p)} accessed on the webgl2 backend — ` +
          `native WebGPU objects do not exist under ?forcegl2; route through ctx.rhi ` +
          `or fence the caller behind backend === 'webgpu'.`,
      )
    },
  })
return {
  device: unavailable('device') as GPUDevice,
  context: unavailable('context') as GPUCanvasContext /* … */,
}
```

Two escape hatches survive, and they matter:

- **`then` stays `undefined`.** `await ctx.device` (a real pattern where a
  value might or might not be a promise) must not throw or hang. Returning
  `undefined` for `then` makes the proxy a plain non-thenable value.
- **Symbol keys return `undefined`.** `console.log(ctx)`,
  `util.inspect`, `JSON.stringify` probe `Symbol.toStringTag`,
  `Symbol.for('nodejs.util.inspect.custom')`, etc. If those threw, you
  couldn't print the context object during diagnostics — the stub would
  detonate the moment you tried to look at it. Symbols pass through.

Storing the reference is still fine (`this.device = ctx.device` in a
constructor doesn't _access_ a property of the proxy). Only _using_ it throws.
That's the exact line we want: passing the handle around is legal; dereferencing
a native WebGPU object on a backend that has none is a bug, and now it says so.

This line is subtler than it reads, because storage and use are usually in
_different methods_. Most frame-path renderers store `ctx.device` in their
constructor and never touch it there — perfectly safe under the fail-loud stub.
The throw surfaces later and elsewhere: `PipelineFactory.build()` takes that
same stored device and calls `.createRenderPipeline` on it. So the stack trace
points at the dereferencing call site, not the innocuous constructor that
captured the handle — which is exactly the site you need to fence.

## What the stub screamed about

We flipped the stub and ran the WebGL2 gate suite. It didn't render — it threw,
with a stack trace, at every unfenced site. Counted up, the forced-WebGL2 boot
had been making north of forty native device calls per boot into a device that
does not exist — 22 in `PipelineFactory.build()` alone, another ~13 shader
emits for per-style variants, plus three renderers, the sprite atlas, and the
tile path. Every one of them had been silently succeeding against the proxy.
In order:

- `PipelineFactory.build()` — 22 `device.create*` calls (shader module, base
  layouts, every base pipeline, atlas stubs, OIT compose) that had been running
  against the proxy on every forced-WebGL2 boot. Fenced the whole build behind
  `backend === 'webgpu'`.
- The per-style variant pipeline builders — another `buildShader` WGSL emit +
  `createRenderPipeline` per data-driven layer (~13 on OFM Bright), all feeding
  the proxy. Returned a frozen sentinel on WebGL2 instead.
- `text-renderer`, `icon-renderer`, `point-renderer` — native bind-group
  layouts built in the constructor. Made lazy (`bgl()` created on first WebGPU
  use).
- `SpriteAtlasGPU` / `HostSpriteAtlasGPU` — `device.createSampler` in the
  constructor. Lazy getter.
- The tile upload path — a raw device-pool buffer for the legacy thin-line
  draw (which never runs on the RHI frame). Skipped on WebGL2.

None of these were _incorrect_ before — the proxy made them harmless-looking.
But harmless-looking is not free: each was real wasted work on every forced
boot — a WGSL emit plus a `createRenderPipeline` per data-driven layer, native
samplers, pool buffers — all allocated against a device that has no device, all
invisible. The fail-loud stub turned "invisible and wasteful" into "a stack
trace pointing at the exact line." Every one got a proper fence; the boot now
performs **zero** device calls on the WebGL2 path.

## The lesson

If a stub represents "this capability is absent here," make absence _loud_ —
throw, with a message that names the capability and the fix, keeping only the
escape hatches diagnostics need (`then`, symbols). A stub that fails loud is a
to-do list that writes itself: run the code, read the stack traces, fence what
they point at, repeat until silent. A stub that fails quiet is a debt you can't
even measure.
