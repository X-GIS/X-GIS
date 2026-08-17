// ═══ GPU boot composition — the map's single backend-chain authority ═══
//
// `run()` and `runBinary()` both mount a device, and they MUST compose the chain
// identically: the same quality injection, the same WebGL2 device factory, and —
// since #1341 — the same fresh-canvas renewal. Two copies of that wiring is how a
// fallback ends up working on one entry point and dead on the other, so the
// composition lives here and map.ts holds only the inputs.
//
// ## Why a boot can need a DIFFERENT canvas
//
// A canvas element's context type is sticky and irreversible: once
// `getContext('webgpu')` hands out a context, `getContext('webgl2')` on that same
// element returns null for the rest of the page's life (verified in Chromium).
// The `'auto'` chain is `[webgpu, webgl2]`, so any boot that reaches the WebGL2
// provider on an element WebGPU already claimed cannot succeed — the map stays
// blank and the console blames a missing WebGPU browser. Two real paths get there:
//
//   1. A WebGPU `create()` that fails AFTER `getContext('webgpu')` succeeded.
//   2. A RE-BOOT on a canvas an earlier SUCCESSFUL WebGPU boot claimed — device-
//      lost recovery, or a host remounting the map — once WebGPU has become
//      unavailable (Chrome disables it for the page after repeated GPU crashes,
//      which is exactly what heavy scenes on weak hardware provoke).
//
// The only remedy the platform allows is a virgin element, so the chain asks for
// one via `renewSurface` and the map adopts it. This runs ONLY on a path that
// would otherwise fail — an unclaimed canvas, or a re-boot onto the same backend,
// is never renewed.

import { getSampleCount } from '@xgis/engine'
import type { BackendChoice } from '@xgis/engine'
import {
  initGPUViaProviders,
  backendProviderChain,
  type GPUContext,
  type WebGl2DeviceFactory,
} from '@xgis/rhi-webgpu'
import { reconcileOverdrawQualityClamp } from './debug-flags'
import { seedBakedShaders } from './shaders/baked/seed-hillshade'
import { installBakedShaders } from './shaders/baked/install'

/** What the map supplies to compose a boot. */
export interface GpuBootDeps {
  /** The element to render into — the host's canvas, or whatever replaced it. */
  canvas: HTMLCanvasElement
  /** `XGISMapOptions.backend`, construction-immutable (context type is sticky). */
  backend: BackendChoice
  /** `XGISMapOptions.preserveDrawingBuffer` — WebGL2-backend-only. */
  preserveDrawingBuffer: boolean
  /** Composition-root WebGL2 device factory (#834 M5). */
  makeWebGl2Device: WebGl2DeviceFactory
  /** Re-point every canvas-bound holder at the replacement the chain minted.
   *  Called BEFORE the backend boots on it, so the map is already consistent by
   *  the time a context exists. */
  adoptCanvas: (next: HTMLCanvasElement) => void
}

/** Mint a replacement for a canvas whose context type is already spoken for,
 *  and put it in the old element's place in the DOM.
 *
 *  Every attribute is copied, so id / class / inline style / `tabindex` / `role` /
 *  `aria-label` / `touch-action` all survive — a host's CSS selectors and the
 *  a11y surface keep working without the map re-deriving them. Backing-store size
 *  is copied too, so the first frame is not a resize away from correct.
 *
 *  Returns null when there is nothing to replace (no DOM, or a detached canvas —
 *  the unit-test mocks and SSR); the chain then fails loud with a precise cause
 *  rather than booting into an element the host cannot see. */
export function renewCanvasElement(prev: HTMLCanvasElement): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null
  const parent = (prev as Partial<HTMLCanvasElement>).parentNode
  if (!parent || typeof prev.getAttributeNames !== 'function') return null
  const next = document.createElement('canvas')
  for (const name of prev.getAttributeNames()) {
    const v = prev.getAttribute(name)
    if (v !== null) next.setAttribute(name, v)
  }
  next.width = prev.width
  next.height = prev.height
  parent.replaceChild(next, prev)
  return next
}

/** Boot the GPU context for one run. Throws `WebGPUUnavailableError` when every
 *  backend in the chain is exhausted — the caller's graceful-degrade path.
 *
 *  #1678 — this is also where the committed shader bake is consumed. It belongs here
 *  for the same reason the rest of the chain does: `run()` and `runBinary()` both mount
 *  a device, and a seam wired into only one of them is how a fallback ends up working
 *  on one entry point and dead on the other. Seeding is PER DEVICE (the artifact is
 *  chosen from `ctx.rhi`'s shader language), so two maps on one page each get their
 *  own, and it can neither throw nor reject — an unusable bake costs a slower first
 *  hillshade frame, never a boot.
 *
 *  #1679 increment 4 — and the same again for the baked-source STORE, which is the half
 *  the keyed emit seam (`render/material/wgsl-for.ts`) reads. Both awaits sit at the very
 *  END of this function, immediately before the context is handed back: the caller's next
 *  act is to build drapers and draw, and a draper that runs BEFORE the store is filled
 *  emits at runtime — correct pixels, and the whole point of the bake silently lost. That
 *  ordering is asserted structurally (nothing may slip between the install and the return)
 *  AND behaviourally (a boot-group lookup hits after a boot) in
 *  `shaders/baked/boot-install-order.test.ts`. */
export async function bootGpuContext(deps: GpuBootDeps): Promise<GPUContext> {
  const ctx = await initGPUViaProviders(
    deps.canvas,
    // Quality policy → adapter is an INJECTION at this composition root (#929 B):
    // the boot values are data the providers close over.
    backendProviderChain(deps.backend, { sampleCount: getSampleCount() }, deps.makeWebGl2Device, {
      preserveDrawingBuffer: deps.preserveDrawingBuffer,
    }),
    {
      renewSurface: (claimed, backend) => {
        const next = renewCanvasElement(claimed)
        if (!next) return null
        console.warn(
          `[X-GIS] the canvas was already claimed by another GPU context, so the ` +
            `${backend} backend was given a fresh canvas element — re-read it via ` +
            `map.getCanvas() if you hold a reference to the original`,
        )
        deps.adoptCanvas(next)
        return next
      },
    },
  )
  // #1615 — the earliest moment the `?debug=overdraw` quality clamp can meet a device, and
  // the only one both entry points share (`run()` and `runBinary()` each mount through here).
  //
  // WHY HERE AND NOT IN map.ts. This is the sole non-user-invoked `updateQuality()` in the
  // codebase, and `map.setQuality()` (map.ts:2067-2078) answers an msaa/picking change with
  // `renderTargets.invalidate()` plus six `rebuildForQuality()` calls. Correcting from the
  // boot path AHEAD of publication makes that fan-out unreachable by construction rather
  // than by argument: no renderer for this ctx exists yet — `buildSceneRenderers` runs
  // ~25 lines after `this.ctx = ctx` in both callers — so the corrected value is simply what
  // every pipeline is FIRST built with, and nothing is built twice. (`updateQuality` itself
  // only notifies `onQualityChange` listeners, and the repo registers none; `setQuality`
  // performs its rebuilds inline. So even a later call site could not have triggered the
  // fan-out — but "no renderers exist" survives someone wiring a listener up, and the
  // listener audit does not.)
  //
  // It corrects `picking` ONLY. `getSampleCount()` was handed to the provider chain above,
  // so the swapchain is already configured for that count — an `msaa` "correction" here
  // would leave the device and the policy disagreeing from the first frame.
  reconcileOverdrawQualityClamp(ctx.rhi.caps)
  // CONCURRENT, not sequential. These are two independent dynamic imports — the hillshade
  // artifact into the emit pool, the boot-group artifact into the store — touching different
  // state and each error-safe on its own, so awaiting them in series would bill the boot for
  // both round trips when it need only pay the slower one. Measured (#1679 increment 4,
  // gzip): hillshade 7.0 KB + boot 58.6 KB on GLSL, 8.8 + 39.1 on WGSL.
  await Promise.all([seedBakedShaders(ctx.rhi), installBakedShaders(ctx.rhi)])
  return ctx
}
